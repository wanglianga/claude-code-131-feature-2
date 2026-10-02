// 业务动作层：所有角色共用的业务逻辑。每个动作做角色校验、写库、写审计日志。
import { q, q1, run, now, today, addDays, hashPassword } from "./db";
import crypto from "node:crypto";
import type { SessionUser } from "./auth";
import { audit, createException, notifyStaff } from "./actions-helper";
import { planVisits, confirmPlan, activeAuth, visitBlockers } from "./visits";

type Payload = Record<string, unknown>;
type Row = Record<string, unknown>;

function str(p: Payload, k: string, def = ""): string {
  const v = p[k];
  return v === undefined || v === null ? def : String(v).trim();
}
function num(p: Payload, k: string, def = 0): number {
  const v = Number(p[k]);
  return Number.isFinite(v) ? v : def;
}
function req(p: Payload, k: string, label: string): string {
  const v = str(p, k);
  if (!v) throw new Error(`请填写${label}`);
  return v;
}

export { audit, createException } from "./actions-helper";

// 忌口关键词（含常见同义词）
const TABOO_SYNONYMS: Record<string, string[]> = {
  "海鲜": ["海鲜", "虾", "蟹", "贝", "蛤", "海参", "鱿鱼", "带鱼", "鲅鱼"],
  "辛辣": ["辛辣", "辣", "椒", "麻辣", "咖喱"],
  "生冷": ["生冷", "生", "冰", "冷食", "沙拉", "刺身"],
};
export function checkTaboos(menu: string, taboos: string): string[] {
  const keys = taboos.split(/[、,，;；\s]+/).map((s) => s.replace(/^忌/, "").trim()).filter(Boolean);
  const hits = new Set<string>();
  for (const k of keys) {
    const words = TABOO_SYNONYMS[k] || [k];
    for (const w of words) {
      if (menu.includes(w)) { hits.add(k); break; }
    }
  }
  return [...hits];
}

function mustStay(stayId: number): Row {
  const s = q1("SELECT * FROM stays WHERE id=?", stayId);
  if (!s) throw new Error("订单不存在");
  return s;
}

function familyStayIds(userId: number): number[] {
  return q("SELECT stay_id FROM family_links WHERE user_id=?", userId).map((r) => Number(r.stay_id));
}

function assertFamilyStay(user: SessionUser, stayId: number) {
  if (user.role !== "family") return;
  if (!familyStayIds(user.id).includes(stayId)) throw new Error("无权访问该房间");
}

// ---------------------------------------------------------------- actions
type Handler = (user: SessionUser, p: Payload) => unknown;

const ACTIONS: Record<string, { roles: string[]; run: Handler }> = {
  // ---- 入住登记（前台/管理者）----
  "stays.create": {
    roles: ["frontdesk", "admin"],
    run(user, p) {
      const roomId = num(p, "roomId");
      const room = q1("SELECT * FROM rooms WHERE id=?", roomId);
      if (!room) throw new Error("房间不存在");
      if (room.status !== "vacant") throw new Error("该房间不是空房状态");
      const pkg = q1("SELECT * FROM packages WHERE id=?", num(p, "packageId"));
      if (!pkg) throw new Error("套餐不存在");
      const mother = req(p, "motherName", "产妇姓名");
      const checkIn = req(p, "checkInDate", "入住日期");
      const days = Number(pkg.days);
      const expected = addDays(checkIn, days);
      let code = `M${checkIn.replaceAll("-", "")}-${room.number}`;
      if (q1("SELECT id FROM stays WHERE code=?", code)) {
        code = `${code}-${(q1("SELECT COUNT(*) AS c FROM stays")?.c ?? 0)}`;
      }
      const permissions = JSON.stringify({
        careSummary: true, fees: true, visits: true,
        visitors: str(p, "visitors").split(/[、,，]/).map((s) => s.trim()).filter(Boolean),
      });
      const stayId = run(
        `INSERT INTO stays(code,room_id,package_id,mother_name,mother_phone,delivery_method,postpartum_days,
          allergy_history,feeding_method,meal_taboos,doctor_advice,visit_permissions,
          baby_name,baby_weight,jaundice_level,jaundice_note,status,check_in_date,expected_checkout,created_by)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'in_stay',?,?,?)`,
        code, roomId, Number(pkg.id), mother, str(p, "motherPhone"),
        str(p, "deliveryMethod"), num(p, "postpartumDays"),
        str(p, "allergyHistory"), str(p, "feedingMethod"), str(p, "mealTaboos"),
        str(p, "doctorAdvice"), permissions,
        str(p, "babyName"), num(p, "babyWeight"), num(p, "jaundiceLevel"), str(p, "jaundiceNote"),
        checkIn, expected, user.id
      );
      run("UPDATE rooms SET status='occupied' WHERE id=?", roomId);
      // 默认护理计划
      const defaults: [string, string, string][] = [
        ["rounds", "护理查房", "每日2次"],
        ["wound", "伤口观察", "每日1次"],
        ["breast", "乳房护理", "每日1次"],
        ["recovery", "产康课程", "每周3次"],
        ["meal", "月子餐", "每日三餐三点"],
        ["baby_bath", "宝宝洗澡抚触", "每日1次"],
        ["night_care", "夜间照护", "每日 20:00-08:00"],
      ];
      for (const [type, title, freq] of defaults) {
        run("INSERT INTO care_plans(stay_id,type,title,frequency,note) VALUES(?,?,?,?,?)",
          stayId, type, title, freq, str(p, "mealTaboos") ? `忌口：${str(p, "mealTaboos")}` : "");
      }
      // 套餐赠品
      const gifts = JSON.parse(String(pkg.gifts || "[]")) as string[];
      for (const gname of gifts) {
        run("INSERT INTO gifts(stay_id,name,source) VALUES(?,?,'package')", stayId, gname);
      }
      // 费用：套餐 + 押金
      run("INSERT INTO fees(stay_id,type,direction,amount,description,created_by) VALUES(?,?,?,?,?,?)",
        stayId, "package", "charge", Number(pkg.price), `${pkg.name}费用`, user.id);
      const deposit = num(p, "deposit", 0);
      if (deposit > 0) {
        run("INSERT INTO fees(stay_id,type,direction,amount,description,created_by) VALUES(?,?,?,?,?,?)",
          stayId, "deposit", "charge", deposit, "入住押金", user.id);
      }
      // 家属账号
      const famUser = str(p, "familyUsername");
      const famName = str(p, "familyName");
      if (famUser && famName) {
        const exists = q1("SELECT id FROM users WHERE username=?", famUser);
        let uid: number;
        if (exists) {
          uid = Number(exists.id);
        } else {
          const salt = crypto.randomBytes(8).toString("hex");
          uid = run("INSERT INTO users(username,password_hash,salt,name,role,phone) VALUES(?,?,?,?,?,?)",
            famUser, hashPassword(str(p, "familyPassword", "family123"), salt),
            salt, famName, "family", str(p, "familyPhone"));
        }
        run("INSERT INTO family_links(stay_id,user_id,name,relation) VALUES(?,?,?,?)",
          stayId, uid, famName, str(p, "familyRelation", "家属"));
      }
      audit(stayId, user, "入住登记", `${mother}入住${room.number}（${pkg.name}），预产期出所${expected}`);
      return { id: stayId, message: `入住登记成功，订单号 ${code}` };
    },
  },

  // ---- 房间状态流转（清扫完成→空房等）----
  "rooms.update": {
    roles: ["frontdesk", "admin"],
    run(user, p) {
      const room = q1("SELECT * FROM rooms WHERE id=?", num(p, "id"));
      if (!room) throw new Error("房间不存在");
      const status = req(p, "status", "状态");
      if (!["vacant", "occupied", "cleaning"].includes(status)) throw new Error("非法房间状态");
      run("UPDATE rooms SET status=? WHERE id=?", status, Number(room.id));
      audit(null, user, "房间状态", `房间${room.number} → ${status}`);
      return { message: `房间${room.number}已更新` };
    },
  },

  // ---- 出所（含提前退所）----
  "stays.checkout": {
    roles: ["frontdesk", "finance", "admin"],
    run(user, p) {
      const stayId = num(p, "stayId");
      const stay = mustStay(stayId);
      if (stay.status !== "in_stay") throw new Error("该订单已出所");
      const todayStr = today();
      const early = todayStr < String(stay.expected_checkout);
      const reason = str(p, "reason");
      // 提前退所：按未住天数 50% 折算退款
      if (early) {
        const pkg = q1("SELECT * FROM packages WHERE id=?", Number(stay.package_id))!;
        const remain = Math.max(0, Math.round((new Date(String(stay.expected_checkout)).getTime() - new Date(todayStr).getTime()) / 86400000));
        const refund = Math.round((Number(pkg.price) / Number(pkg.days)) * remain * 0.5);
        if (refund > 0) {
          run("INSERT INTO fees(stay_id,type,direction,amount,description,created_by) VALUES(?,?,?,?,?,?)",
            stayId, "refund", "refund", refund, `提前退所折算退款（剩余${remain}天×50%）`, user.id);
        }
        createException(stayId, "early_checkout", "产妇提前退所",
          `应出所${stay.expected_checkout}，实际${todayStr}退所。原因：${reason || "未填写"}。折算退款${refund}元。`,
          "high", user);
      }
      // 结算单
      const fees = q("SELECT * FROM fees WHERE stay_id=? AND status='confirmed'", stayId);
      const charge = fees.filter((f) => f.direction === "charge").reduce((s, f) => s + Number(f.amount), 0);
      const refundSum = fees.filter((f) => f.direction === "refund").reduce((s, f) => s + Number(f.amount), 0);
      run(`INSERT INTO settlements(stay_id,total_charge,total_refund,paid,balance,detail,status)
           VALUES(?,?,?,?,?,?,'draft')
           ON CONFLICT(stay_id) DO UPDATE SET total_charge=excluded.total_charge,total_refund=excluded.total_refund,balance=excluded.balance`,
        stayId, charge, refundSum, 0, charge - refundSum,
        early ? `提前退所结算（${reason || "无理由填写"}）` : "正常出所结算");
      run("UPDATE stays SET status='checked_out', actual_checkout=? WHERE id=?", todayStr, stayId);
      run("UPDATE rooms SET status='cleaning' WHERE id=?", Number(stay.room_id));
      // 出所后随访计划
      run("INSERT INTO follow_ups(stay_id,type,scheduled_at,content,created_by) VALUES(?,?,?,?,?)",
        stayId, "回访", addDays(todayStr, 3) + " 10:00", "出所后3天电话回访（恢复情况、满意度）", user.id);
      run("INSERT INTO follow_ups(stay_id,type,scheduled_at,content,created_by) VALUES(?,?,?,?,?)",
        stayId, "母婴随访", addDays(todayStr, 30) + " 10:00", "出所后1个月母婴随访（儿保+产康复查提醒）", user.id);
      audit(stayId, user, early ? "提前退所" : "出所登记", `结算：应收${charge}，已退${refundSum}，待确认`);
      return { message: early ? "已办理提前退所，已生成退款与异常工单" : "已办理出所，结算单待财务确认" };
    },
  },

  // ---- 套餐/房间升级 ----
  "stays.upgrade": {
    roles: ["frontdesk", "admin"],
    run(user, p) {
      const stayId = num(p, "stayId");
      const stay = mustStay(stayId);
      if (stay.status !== "in_stay") throw new Error("已出所订单不能升级");
      const newPkg = q1("SELECT * FROM packages WHERE id=?", num(p, "newPackageId"));
      if (!newPkg) throw new Error("目标套餐不存在");
      const oldPkg = q1("SELECT * FROM packages WHERE id=?", Number(stay.package_id))!;
      if (Number(newPkg.id) === Number(oldPkg.id)) throw new Error("已是该套餐");
      const diff = Number(newPkg.price) - Number(oldPkg.price);
      const total = Number(oldPkg.days);
      const used = Math.max(0, Math.round((new Date(today()).getTime() - new Date(String(stay.check_in_date)).getTime()) / 86400000));
      const remainRatio = Math.max(0, (total - used) / total);
      const upgradeFee = Math.max(0, Math.round(diff * remainRatio));
      if (upgradeFee > 0) {
        run("INSERT INTO fees(stay_id,type,direction,amount,description,created_by) VALUES(?,?,?,?,?,?)",
          stayId, "upgrade", "charge", upgradeFee,
          `套餐升级差价（${oldPkg.name}→${newPkg.name}，按剩余${total - used}天折算）`, user.id);
      }
      // 房型变化则换房
      let roomNote = "";
      if (newPkg.room_type !== oldPkg.room_type) {
        const newRoom = q1("SELECT * FROM rooms WHERE type=? AND status='vacant' ORDER BY number LIMIT 1", String(newPkg.room_type));
        if (newRoom) {
          run("UPDATE rooms SET status='cleaning' WHERE id=?", Number(stay.room_id));
          run("UPDATE rooms SET status='occupied' WHERE id=?", Number(newRoom.id));
          run("UPDATE stays SET room_id=? WHERE id=?", Number(newRoom.id), stayId);
          roomNote = `，房间由${(q1("SELECT number FROM rooms WHERE id=?", Number(stay.room_id)) || {}).number || ""}调整至${newRoom.number}`;
        } else {
          roomNote = `，暂无${newPkg.room_type}空房，暂留原房间`;
        }
      }
      // 新套餐赠品补齐
      const newGifts = JSON.parse(String(newPkg.gifts || "[]")) as string[];
      const existing = q("SELECT name FROM gifts WHERE stay_id=?", stayId).map((g) => String(g.name));
      for (const gname of newGifts) {
        if (!existing.includes(gname)) run("INSERT INTO gifts(stay_id,name,source) VALUES(?,?,'package')", stayId, gname);
      }
      run("UPDATE stays SET package_id=?, expected_checkout=? WHERE id=?",
        Number(newPkg.id), addDays(String(stay.check_in_date), Number(newPkg.days)), stayId);
      createException(stayId, "package_upgrade", `套餐升级：${oldPkg.name}→${newPkg.name}`,
        `补差价${upgradeFee}元${roomNote}`, "low", user);
      audit(stayId, user, "套餐升级", `${oldPkg.name}→${newPkg.name}，补差价${upgradeFee}元${roomNote}`);
      return { message: `升级成功，补差价 ${upgradeFee} 元${roomNote}` };
    },
  },

  // ---- 护理计划 ----
  "plans.create": {
    roles: ["head_nurse", "admin"],
    run(user, p) {
      const stayId = num(p, "stayId");
      mustStay(stayId);
      const id = run("INSERT INTO care_plans(stay_id,type,title,frequency,assignee_id,note) VALUES(?,?,?,?,?,?)",
        stayId, req(p, "type", "计划类型"), req(p, "title", "计划名称"),
        str(p, "frequency"), num(p, "assigneeId") || null, str(p, "note"));
      audit(stayId, user, "护理计划", `新增计划：${str(p, "title")}（${str(p, "frequency")}）`);
      return { id };
    },
  },

  // ---- 护理任务 ----
  "tasks.create": {
    roles: ["head_nurse", "nurse", "admin"],
    run(user, p) {
      const stayId = num(p, "stayId");
      mustStay(stayId);
      const id = run("INSERT INTO care_tasks(stay_id,plan_id,type,title,scheduled_at,assignee_id,visible_to_family) VALUES(?,?,?,?,?,?,?)",
        stayId, num(p, "planId") || null, req(p, "type", "任务类型"), req(p, "title", "任务名称"),
        req(p, "scheduledAt", "计划时间"), num(p, "assigneeId") || null, p.visibleToFamily === false ? 0 : 1);
      audit(stayId, user, "任务安排", `新增任务：${str(p, "title")} @ ${str(p, "scheduledAt")}`);
      return { id };
    },
  },

  // 从计划生成某日任务
  "tasks.generate": {
    roles: ["head_nurse", "nurse", "admin"],
    run(user, p) {
      const stayId = num(p, "stayId");
      mustStay(stayId);
      const date = str(p, "date", today());
      const plans = q("SELECT * FROM care_plans WHERE stay_id=? AND status='active'", stayId);
      let created = 0;
      for (const pl of plans) {
        const exists = q1("SELECT id FROM care_tasks WHERE stay_id=? AND plan_id=? AND scheduled_at LIKE ?",
          stayId, Number(pl.id), `${date}%`);
        if (exists) continue;
        const time = pl.type === "night_care" ? `${date} 20:00` : pl.type === "rounds" ? `${date} 08:30` : `${date} 10:00`;
        run("INSERT INTO care_tasks(stay_id,plan_id,type,title,scheduled_at,assignee_id) VALUES(?,?,?,?,?,?)",
          stayId, Number(pl.id), String(pl.type), String(pl.title), time,
          pl.assignee_id === null ? null : Number(pl.assignee_id));
        created++;
      }
      audit(stayId, user, "任务生成", `生成${date}护理任务${created}项`);
      return { message: `已生成 ${created} 项任务` };
    },
  },

  "tasks.update": {
    roles: ["nurse", "matron", "head_nurse", "admin", "nutritionist", "therapist"],
    run(user, p) {
      const id = num(p, "id");
      const t = q1("SELECT * FROM care_tasks WHERE id=?", id);
      if (!t) throw new Error("任务不存在");
      const status = req(p, "status", "状态");
      const record = str(p, "record");
      run("UPDATE care_tasks SET status=?, done_at=CASE WHEN ?='done' THEN ? ELSE done_at END, done_by=CASE WHEN ?='done' THEN ? ELSE done_by END, record=?, visible_to_family=? WHERE id=?",
        status, status, now(), status, user.id, record || String(t.record || ""),
        p.visibleToFamily === undefined ? Number(t.visible_to_family) : (p.visibleToFamily ? 1 : 0), id);
      if (status === "done" && record) {
        run("INSERT INTO care_records(stay_id,task_id,type,content,created_by,created_by_name,visible_to_family) VALUES(?,?,?,?,?,?,?)",
          Number(t.stay_id), id, String(t.type), record, user.id, user.name, Number(t.visible_to_family));
      }
      audit(Number(t.stay_id), user, "护理执行", `任务「${t.title}」→ ${status}${record ? "：" + record : ""}`);
      return { message: "已更新" };
    },
  },

  // ---- 护理记录 ----
  "records.create": {
    roles: ["nurse", "matron", "head_nurse", "admin", "pediatrician"],
    run(user, p) {
      const stayId = num(p, "stayId");
      mustStay(stayId);
      const id = run("INSERT INTO care_records(stay_id,task_id,type,content,created_by,created_by_name,visible_to_family) VALUES(?,?,?,?,?,?,?)",
        stayId, num(p, "taskId") || null, str(p, "type", "general"), req(p, "content", "记录内容"),
        user.id, user.name, p.visibleToFamily === false ? 0 : 1);
      audit(stayId, user, "护理记录", str(p, "content").slice(0, 60));
      return { id };
    },
  },

  // 家属质疑护理记录
  "records.dispute": {
    roles: ["family"],
    run(user, p) {
      const id = num(p, "id");
      const rec = q1("SELECT * FROM care_records WHERE id=?", id);
      if (!rec) throw new Error("记录不存在");
      assertFamilyStay(user, Number(rec.stay_id));
      run("UPDATE care_records SET disputed=1 WHERE id=?", id);
      createException(Number(rec.stay_id), "record_dispute", "家属质疑护理记录",
        `记录#${id}「${String(rec.content).slice(0, 50)}」被质疑：${str(p, "reason") || "未填写原因"}`, "high", user);
      return { message: "已提交质疑，护士长将介入核查" };
    },
  },

  // ---- 月子餐 ----
  "meals.create": {
    roles: ["nutritionist", "admin"],
    run(user, p) {
      const stayId = num(p, "stayId");
      const stay = mustStay(stayId);
      const menu = req(p, "menu", "菜单");
      const hits = checkTaboos(menu, String(stay.meal_taboos || ""));
      const status = hits.length ? "issue" : "planned";
      const id = run("INSERT INTO meals(stay_id,meal_date,meal_type,menu,taboo_hits,status,created_by) VALUES(?,?,?,?,?,?,?)",
        stayId, req(p, "mealDate", "日期"), req(p, "mealType", "餐次"), menu, hits.join("、"), status, user.id);
      if (hits.length) {
        createException(stayId, "meal_taboo", `月子餐命中忌口：${hits.join("、")}`,
          `${str(p, "mealDate")} ${str(p, "mealType")}「${menu}」含忌口食材（${hits.join("、")}），请营养师立即调整。`, "high", user);
      }
      audit(stayId, user, "配餐登记", `${str(p, "mealDate")} ${str(p, "mealType")}${hits.length ? "（命中忌口：" + hits.join("、") + "）" : ""}`);
      return { id, tabooHits: hits, message: hits.length ? `警告：命中忌口 ${hits.join("、")}` : "已登记" };
    },
  },

  "meals.update": {
    roles: ["nutritionist", "admin"],
    run(user, p) {
      const id = num(p, "id");
      const m = q1("SELECT * FROM meals WHERE id=?", id);
      if (!m) throw new Error("餐食记录不存在");
      run("UPDATE meals SET status=?, note=? WHERE id=?", req(p, "status", "状态"), str(p, "note"), id);
      audit(Number(m.stay_id), user, "餐食处理", `${m.meal_date} ${m.meal_type} → ${str(p, "status")}${str(p, "note") ? "：" + str(p, "note") : ""}`);
      return { message: "已更新" };
    },
  },

  // ---- 探访申请（写入日期/时长/授权与健康初态，供方案引擎排队）----
  "visits.create": {
    roles: ["family", "frontdesk", "admin"],
    run(user, p) {
      const stayId = num(p, "stayId");
      assertFamilyStay(user, stayId);
      const stay = mustStay(stayId);
      if (stay.status !== "in_stay") throw new Error("已出所，无法预约探访");
      const isTemp = p.isTemp === true || p.isTemp === "true" || num(p, "isTemp") === 1 ? 1 : 0;
      const visitTime = req(p, "visitTime", "探访时间");
      const hours = Math.max(1, num(p, "hours", 2));
      const visitor = req(p, "visitorName", "探访人");
      // 既有有效授权决定申请的授权初态；爽约记录影响后续排队优先级（可被前台覆盖）
      const auth = activeAuth(stayId, visitor);
      let authorized = 0;
      let tempAuthStatus = "";
      if (auth) {
        authorized = 1;
        tempAuthStatus = String(auth.auth_type) === "temporary" ? "active" : "";
      } else if (isTemp) {
        tempAuthStatus = "pending"; // 临时授权尚待产妇确认
      }
      const penalty = q(
        "SELECT COUNT(*) AS c FROM visits WHERE stay_id=? AND visitor_name=? AND no_show=1 AND (override_reason IS NULL OR override_reason='')",
        stayId, visitor);
      const priority = 5 + 2 * Number(penalty[0]?.c || 0);
      const id = run(
        `INSERT INTO visits(stay_id,visitor_name,relation,visit_time,visit_date,end_time,hours,is_temp,
           status,health_status,authorized,temp_auth_status,priority,created_by)
         VALUES(?,?,?,?,?,?,?,?,'pending','unknown',?,?,?,?)`,
        stayId, visitor, str(p, "relation"), visitTime, visitTime.slice(0, 10),
        (() => { const d = new Date(visitTime.replace(" ", "T")); d.setHours(d.getHours() + hours); const x = (n: number) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${x(d.getMonth() + 1)}-${x(d.getDate())} ${x(d.getHours())}:${x(d.getMinutes())}`; })(),
        hours, isTemp, authorized, tempAuthStatus, priority, user.id);
      if (isTemp) {
        createException(stayId, "extra_visit", "家属临时增加探访",
          `${visitor}（${str(p, "relation")}）申请临时探访：${visitTime}${auth ? "" : "，临时授权待产妇确认"}`, "medium", user);
      }
      audit(stayId, user, "探访预约", `${visitor} 预约 ${visitTime}${isTemp ? "（临时）" : ""}，授权${authorized ? "有效" : "待确认"}`);
      return { id, authorized, message: authorized ? "探访预约已提交，待前台核验健康与消毒后排期" : "探访预约已提交；临时授权需产妇确认后方可排期" };
    },
  },

  // 兼容旧入口：批准/拒绝/取消（不直接发门禁，门禁一律经方案确认原子发放）
  "visits.update": {
    roles: ["frontdesk", "head_nurse", "admin"],
    run(user, p) {
      const id = num(p, "id");
      const v = q1("SELECT * FROM visits WHERE id=?", id);
      if (!v) throw new Error("探访记录不存在");
      const action = req(p, "op", "操作");
      if (action === "reject") {
        run("UPDATE visits SET status='rejected', approved_by=? WHERE id=?", user.id, id);
      } else if (action === "cancel") {
        run("UPDATE visits SET status='cancelled' WHERE id=?", id);
        run("UPDATE access_passes SET status='revoked', revoked_at=?, revoke_reason='探访取消' WHERE visit_id=? AND entered_at IS NULL", now(), id);
      } else {
        throw new Error("请使用「生成协同方案」进行排期与门禁发放");
      }
      audit(Number(v.stay_id), user, "探访管理", `${v.visitor_name}（${v.visit_time}）：${action}`);
      return { message: "已处理" };
    },
  },

  // 前台登记探访人健康核验（异常即阻断门禁）
  "visits.health": {
    roles: ["frontdesk", "head_nurse", "admin"],
    run(user, p) {
      const v = q1("SELECT * FROM visits WHERE id=?", num(p, "id"));
      if (!v) throw new Error("探访记录不存在");
      const result = req(p, "result", "健康核验结果");
      if (!["ok", "abnormal"].includes(result)) throw new Error("健康结果只能为正常/异常");
      run("UPDATE visits SET health_status=?, health_note=? WHERE id=?", result, str(p, "note"), Number(v.id));
      if (result === "abnormal") {
        createException(Number(v.stay_id), "visit_gate_block", `探访人健康异常：${String(v.visitor_name)}`,
          `前台核验${String(v.visit_time)}探访人${String(v.visitor_name)}健康异常：${str(p, "note") || "测温/症状异常"}。门禁不予发放，请人工安排改约。`, "high", user);
      }
      audit(Number(v.stay_id), user, "探访健康核验", `${String(v.visitor_name)}：${result === "ok" ? "正常" : "异常"}${str(p, "note") ? "：" + str(p, "note") : ""}`);
      return { message: result === "ok" ? "健康核验通过" : "已登记健康异常并阻断门禁、转人工处理" };
    },
  },

  // 前台登记入所消毒
  "visits.disinfect": {
    roles: ["frontdesk", "head_nurse", "admin"],
    run(user, p) {
      const v = q1("SELECT * FROM visits WHERE id=?", num(p, "id"));
      if (!v) throw new Error("探访记录不存在");
      run("UPDATE visits SET disinfected=1, disinfection_note=? WHERE id=?", str(p, "note", "入所前消毒+测温完成"), Number(v.id));
      audit(Number(v.stay_id), user, "探访消毒登记", `${String(v.visitor_name)}：${str(p, "note", "入所前消毒+测温完成")}`);
      return { message: "消毒已登记" };
    },
  },

  // 生成协同方案（排队 / 拆分时段 / 改约）
  "visits.plan": {
    roles: ["frontdesk", "head_nurse", "admin"],
    run(user, p) {
      const stayId = num(p, "stayId");
      const date = req(p, "date", "日期");
      const r = planVisits(stayId, date, user);
      const blocked = r.items.filter((i) => i.blockers.length).length;
      const kindText = r.kind === "queue" ? "排队" : r.kind === "split" ? "拆分时段" : r.kind === "reschedule" ? "改约" : "原样安排";
      return {
        solutionId: r.solutionId, kind: r.kind,
        items: r.items.map((i) => ({
          visitId: i.visitId, visitor: i.visitor, start: i.start, end: i.end,
          kind: i.kind, queueNo: i.queueNo, priority: i.priority,
          blockers: i.blockers.map((b) => b.code), blockerLabels: i.blockers.map((b) => b.label),
          careConflicts: i.careConflicts,
        })),
        message: `已生成${kindText}方案（方案#${r.solutionId}）${blocked ? `；其中 ${blocked} 人存在授权/健康/消毒前置项，确认时将被拦截` : "；前置项齐备，可由前台确认后发放门禁"}`,
      };
    },
  },

  // 前台确认方案：门禁有效期+访客名单+护理避让 原子更新
  "visits.plan.confirm": {
    roles: ["frontdesk", "admin"],
    run(user, p) {
      const r = confirmPlan(num(p, "solutionId"), user);
      return {
        passCount: r.passCount, avoidCount: r.avoidCount,
        passes: r.passes, avoidanceIds: r.avoidanceIds, txnToken: r.txnToken,
        message: `方案已原子生效：发放门禁 ${r.passCount} 张（${r.passes.map((x) => x.code).join("、")}）、联动护理避让 ${r.avoidCount} 项（门禁/名单/避让同成同败）`,
      };
    },
  },

  // 产妇（家属账号代行）授予临时授权 —— 需再点一次「确认」才生效，生效前不发门禁
  "auths.grant": {
    roles: ["family", "frontdesk", "admin"],
    run(user, p) {
      const stayId = num(p, "stayId");
      assertFamilyStay(user, stayId);
      mustStay(stayId);
      const visitor = req(p, "visitorName", "被授权探访人");
      if (activeAuth(stayId, visitor)) throw new Error("该探访人已有有效授权");
      const existPending = q1("SELECT id FROM visit_authorizations WHERE stay_id=? AND visitor_name=? AND status='pending' ORDER BY id DESC LIMIT 1",
        stayId, visitor);
      if (existPending) {
        return { id: Number(existPending.id), message: "该探访人已有待确认的授权申请，请直接确认" };
      }
      const authType = str(p, "authType", "temporary") === "routine" ? "routine" : "temporary";
      const id = run(
        `INSERT INTO visit_authorizations(stay_id,visitor_name,relation,auth_type,status,granted_by,granted_by_name,valid_from,valid_to)
         VALUES(?,?,?,?, 'pending', ?,?,?,?)`,
        stayId, visitor, str(p, "relation"), authType, user.id, user.name,
        str(p, "validFrom"), str(p, "validTo"));
      audit(stayId, user, "探访授权申请", `${visitor}（${authType === "routine" ? "常规" : "临时"}）授权待产妇确认`);
      return { id, message: "授权申请已提交，需产妇确认后生效" };
    },
  },

  // 产妇确认临时/常规授权（前台无权代确认）
  "auths.confirm": {
    roles: ["family"],
    run(user, p) {
      const a = q1("SELECT * FROM visit_authorizations WHERE id=?", num(p, "id"));
      if (!a) throw new Error("授权不存在");
      assertFamilyStay(user, Number(a.stay_id));
      if (String(a.status) !== "pending") throw new Error("该授权已处理，请勿重复确认");
      run("UPDATE visit_authorizations SET status='active', confirmed_by=?, confirmed_at=? WHERE id=?", user.id, now(), Number(a.id));
      // 同步激活该探访人待处理申请的授权位
      run("UPDATE visits SET authorized=1, temp_auth_status=CASE WHEN is_temp=1 THEN 'active' ELSE temp_auth_status END WHERE stay_id=? AND visitor_name=? AND status='pending'",
        Number(a.stay_id), String(a.visitor_name));
      audit(Number(a.stay_id), user, "探访授权确认", `${String(a.visitor_name)} 授权生效（${String(a.auth_type) === "temporary" ? "临时" : "常规"}）`);
      return { message: "授权已生效，前台可继续健康/消毒核验并排期" };
    },
  },

  // 产妇撤回授权：未入场立即失效门禁并通知前台；已入场升级护士长协调
  "auths.revoke": {
    roles: ["family"],
    run(user, p) {
      const a = q1("SELECT * FROM visit_authorizations WHERE id=?", num(p, "id"));
      if (!a) throw new Error("授权不存在");
      assertFamilyStay(user, Number(a.stay_id));
      if (!["active", "revoking"].includes(String(a.status))) throw new Error("该授权非生效状态，无法撤回");
      const stayId = Number(a.stay_id);
      const reason = str(p, "reason", "产妇撤回授权");
      // 已升级护士长协调（在场）：幂等返回，避免重复建工单
      if (String(a.status) === "revoking") {
        return { escalated: true, message: "该撤回已升级护士长现场协调，等待陪同离场处理" };
      }
      // 该探访人名下、尚未入场的有效门禁
      const openPasses = q(
        `SELECT ap.* FROM access_passes ap WHERE ap.stay_id=? AND ap.visitor_name=?
           AND ap.status IN ('active') AND ap.entered_at IS NULL`, stayId, String(a.visitor_name));
      const insidePasses = q(
        `SELECT ap.* FROM access_passes ap WHERE ap.stay_id=? AND ap.visitor_name=?
           AND ap.status='inside'`, stayId, String(a.visitor_name));
      if (insidePasses.length) {
        // 已入场：不直接关门，升级护士长现场协调
        run("UPDATE visit_authorizations SET status='revoking', escalated=1, entered_at_revoke=?, revoked_by=?, revoked_by_name=?, revoke_reason=? WHERE id=?",
          now(), user.id, user.name, reason, Number(a.id));
        const exId = createException(stayId, "visit_revoke_entered", `产妇撤回授权但探访人已在场：${String(a.visitor_name)}`,
          `产妇于${now()}撤回对${String(a.visitor_name)}的探访授权，但其已进入房间，门禁保持待协调，需护士长现场劝离/陪同离场后回收门禁。原因：${reason}`, "critical", user);
        notifyStaff(stayId, "staff", user, `【紧急】产妇撤回${String(a.visitor_name)}授权且人已在房，请护士长立即到场协调（工单#${exId}）`);
        audit(stayId, user, "探访授权撤回(在场)", `${String(a.visitor_name)} 已入场，升级护士长协调（工单#${exId}）`);
        return { escalated: true, message: "探访人已入场，已升级护士长现场协调，未自动关闭门禁" };
      }
      // 未入场：立即失效门禁 + 取消未入场探访 + 通知前台
      run("UPDATE visit_authorizations SET status='revoked', revoked_at=?, revoked_by=?, revoked_by_name=?, revoke_reason=? WHERE id=?",
        now(), user.id, user.name, reason, Number(a.id));
      for (const pass of openPasses) {
        run("UPDATE access_passes SET status='revoked', revoked_at=?, revoke_reason=? WHERE id=?", now(), reason, Number(pass.id));
        run("INSERT INTO access_events(pass_id,stay_id,visit_id,visitor_name,direction,gate_time,gate) VALUES(?,?,?,?, 'revoke', ?, ?)",
          Number(pass.id), stayId, pass.visit_id ? Number(pass.visit_id) : null, String(pass.visitor_name), now(), "授权撤回系统失效");
      }
      run("UPDATE visits SET status='cancelled', revoked_at=? WHERE stay_id=? AND visitor_name=? AND status IN ('scheduled','approved','pending') AND entered_at IS NULL",
        now(), stayId, String(a.visitor_name));
      notifyStaff(stayId, "staff", user, `产妇已撤回对${String(a.visitor_name)}的探访授权，未入场门禁已立即失效，请前台知悉并更新访客名单。`);
      audit(stayId, user, "探访授权撤回", `${String(a.visitor_name)} 未入场，${openPasses.length}张门禁立即失效，已通知前台`);
      return { revokedPasses: openPasses.length, message: `授权已撤回，未入场门禁 ${openPasses.length} 张立即失效，前台已收到通知` };
    },
  },

  // 护士长协调在场撤回：陪同离场后回收门禁并结案
  "auths.escalation.resolve": {
    roles: ["head_nurse", "admin"],
    run(user, p) {
      const a = q1("SELECT * FROM visit_authorizations WHERE id=?", num(p, "id"));
      if (!a) throw new Error("授权不存在");
      if (String(a.status) !== "revoking") throw new Error("该授权不在待协调状态");
      const stayId = Number(a.stay_id);
      const inside = q("SELECT * FROM access_passes WHERE stay_id=? AND visitor_name=? AND status='inside'", stayId, String(a.visitor_name));
      for (const pass of inside) {
        run("UPDATE access_passes SET status='used', exited_at=? WHERE id=?", now(), Number(pass.id));
        run("INSERT INTO access_events(pass_id,stay_id,visit_id,visitor_name,direction,gate_time,gate) VALUES(?,?,?,?, 'out', ?, ?)",
          Number(pass.id), stayId, pass.visit_id ? Number(pass.visit_id) : null, String(pass.visitor_name), now(), "护士长陪同离场");
        if (pass.visit_id) run("UPDATE visits SET status='completed' WHERE id=?", Number(pass.visit_id));
      }
      run("UPDATE visit_authorizations SET status='revoked', escalated=0, revoked_at=COALESCE(revoked_at,?) WHERE id=?", now(), Number(a.id));
      const ex = q1("SELECT id FROM exceptions WHERE stay_id=? AND type='visit_revoke_entered' AND status!='closed' ORDER BY id DESC LIMIT 1", stayId);
      if (ex) {
        run("UPDATE exceptions SET status='resolved', resolution=?, resolved_at=?, updated_at=? WHERE id=?",
          `护士长已协调${String(a.visitor_name)}离场并回收门禁：${str(p, "note", "现场劝离")}`, now(), now(), Number(ex.id));
        run("INSERT INTO exception_events(exception_id,user_id,user_name,action,note) VALUES(?,?,?, 'resolved',?)",
          Number(ex.id), user.id, user.name, str(p, "note", "陪同离场，门禁回收"));
      }
      audit(stayId, user, "在场撤回协调结案", `${String(a.visitor_name)} 已陪同离场，门禁回收，授权撤销`);
      return { message: "已协调探访人离场、回收门禁并结案" };
    },
  },

  // 门禁进出（前台/闸机）：校验有效期并留痕
  "gates.swipe": {
    roles: ["frontdesk", "head_nurse", "admin"],
    run(user, p) {
      const code = req(p, "passCode", "门禁码").trim().toUpperCase();
      const dir = req(p, "direction", "方向") === "out" ? "out" : "in";
      const pass = q1("SELECT * FROM access_passes WHERE pass_code=?", code);
      if (!pass) throw new Error("门禁码无效");
      const t = now();
      if (dir === "in") {
        if (String(pass.status) !== "active") throw new Error(`门禁当前状态不可入场（${String(pass.status)}）`);
        // 允许窗口开始前 30 分钟内提前入场（前台常见接待），窗口结束后不得入场
        const fromD = new Date(String(pass.valid_from).replace(" ", "T") + ":00");
        fromD.setMinutes(fromD.getMinutes() - 30);
        const p2 = (n: number) => String(n).padStart(2, "0");
        const earliest = `${fromD.getFullYear()}-${p2(fromD.getMonth() + 1)}-${p2(fromD.getDate())} ${p2(fromD.getHours())}:${p2(fromD.getMinutes())}`;
        if (t < earliest || t > String(pass.valid_to).slice(0, 16)) {
          throw new Error(`不在门禁有效期内（${String(pass.valid_from).slice(11, 16)}-${String(pass.valid_to).slice(11, 16)}），请联系前台`);
        }
        run("UPDATE access_passes SET status='inside', entered_at=? WHERE id=?", t, Number(pass.id));
        if (pass.visit_id) run("UPDATE visits SET entered_at=?, actual_count=MAX(actual_count,1) WHERE id=?", t, Number(pass.visit_id));
      } else {
        if (String(pass.status) !== "inside") throw new Error("该门禁未处于在房状态，无法出场");
        run("UPDATE access_passes SET status='used', exited_at=? WHERE id=?", t, Number(pass.id));
      }
      run("INSERT INTO access_events(pass_id,stay_id,visit_id,visitor_name,direction,gate_time,gate) VALUES(?,?,?,?,?,?,?)",
        Number(pass.id), Number(pass.stay_id), pass.visit_id ? Number(pass.visit_id) : null, String(pass.visitor_name), dir, t, str(p, "gate", "楼层门禁"));
      audit(Number(pass.stay_id), user, "门禁刷卡", `${String(pass.visitor_name)} ${dir === "in" ? "入场" : "出场"} ${code}`);
      return { message: `${String(pass.visitor_name)} ${dir === "in" ? "入场成功" : "出场成功"}`, visitor: String(pass.visitor_name), direction: dir };
    },
  },

  // 爽约登记：未按约到场 → 记录并影响后续优先级
  "visits.noshow": {
    roles: ["frontdesk", "head_nurse", "admin"],
    run(user, p) {
      const v = q1("SELECT * FROM visits WHERE id=?", num(p, "id"));
      if (!v) throw new Error("探访记录不存在");
      if (v.entered_at) throw new Error("探访人已入场，不能记爽约");
      run("UPDATE visits SET no_show=1, status='no_show' WHERE id=?", Number(v.id));
      run("UPDATE access_passes SET status='expired' WHERE visit_id=? AND entered_at IS NULL AND status='active'", Number(v.id));
      audit(Number(v.stay_id), user, "探访爽约", `${String(v.visitor_name)} 未按约到场（${String(v.visit_time)}），后续同名人排队优先级下调`);
      return { message: "已登记爽约，该探访人后续预约优先级下调" };
    },
  },

  // 前台基于紧急照护 / 产妇书面确认覆盖爽约限制，并留理由
  "visits.override": {
    roles: ["frontdesk", "head_nurse", "admin"],
    run(user, p) {
      const v = q1("SELECT * FROM visits WHERE id=?", num(p, "id"));
      if (!v) throw new Error("探访记录不存在");
      const basis = req(p, "basis", "覆盖依据");
      if (!["urgent_care", "mother_written"].includes(basis)) throw new Error("覆盖依据只能是紧急照护或产妇书面确认");
      const reason = req(p, "reason", "覆盖理由");
      run("UPDATE visits SET override_reason=?, override_by=?, no_show=CASE WHEN ?=1 THEN 0 ELSE no_show END WHERE id=?",
        `[${basis === "urgent_care" ? "紧急照护" : "产妇书面确认"}] ${reason}`, user.id, p.clearNoShow === true ? 1 : 0, Number(v.id));
      audit(Number(v.stay_id), user, "爽约限制覆盖", `${String(v.visitor_name)}：${basis === "urgent_care" ? "紧急照护" : "产妇书面确认"}｜${reason}`);
      return { message: "已覆盖爽约优先级限制并留存理由" };
    },
  },

  // 护理师/护士长确认探访避让结果
  "avoidances.handle": {
    roles: ["nurse", "matron", "head_nurse", "admin"],
    run(user, p) {
      const a = q1("SELECT * FROM care_avoidances WHERE id=?", num(p, "id"));
      if (!a) throw new Error("避让安排不存在");
      run("UPDATE care_avoidances SET status='done', result=?, handled_at=? WHERE id=?",
        req(p, "result", "避让结果"), now(), Number(a.id));
      audit(Number(a.stay_id), user, "护理避让确认", `${String(a.title).slice(0, 40)}：${str(p, "result")}`);
      return { message: "避让结果已记录" };
    },
  },

  // 活动结束闭环：门禁进出 + 实际探访人数 + 护理避让结果 共同决定
  "visits.closeout": {
    roles: ["frontdesk", "head_nurse", "admin"],
    run(user, p) {
      const v = q1("SELECT * FROM visits WHERE id=?", num(p, "id"));
      if (!v) throw new Error("探访记录不存在");
      const stayId = Number(v.stay_id);
      const events = q("SELECT direction FROM access_events WHERE visit_id=? ORDER BY gate_time", Number(v.id));
      const entered = events.some((e) => String(e.direction) === "in");
      const exited = events.some((e) => String(e.direction) === "out");
      const inside = q1("SELECT COUNT(*) AS c FROM access_passes WHERE visit_id=? AND status='inside'", Number(v.id));
      const pendAvoid = q(
        `SELECT COUNT(*) AS c FROM care_avoidances WHERE visit_id=? AND status!='done'`, Number(v.id));
      const solutionAvoid = v.plan_id ? q(
        `SELECT COUNT(*) AS c FROM care_avoidances WHERE solution_id=? AND status!='done'`, Number(v.plan_id)) : [{ c: 0 }];
      const avoidPending = Number(pendAvoid[0]?.c || 0) + Number(solutionAvoid[0]?.c || 0);
      if (Number(inside?.c || 0) > 0 || (entered && !exited)) throw new Error("访客尚未离场（门禁无出场记录），暂不能闭环");
      if (!entered) throw new Error("门禁无入场记录：如确属未到场请先登记爽约，否则不能闭环");
      if (avoidPending > 0) throw new Error(`尚有 ${avoidPending} 项护理避让结果未确认，护理计划未闭环，暂不能关闭预约`);
      const actual = entered ? 1 : 0;
      run("UPDATE visits SET status='completed', actual_count=?, closed_result='closed', closed_at=? WHERE id=?", actual, now(), Number(v.id));
      audit(stayId, user, "探访闭环", `${String(v.visitor_name)}：进出记录齐全、实到${actual}人、避让全部确认，预约闭环`);
      return { message: `探访闭环完成：实到 ${actual} 人，进出与护理避让均已核对` };
    },
  },

  // ---- 费用 ----
  "fees.create": {
    roles: ["finance", "admin"],
    run(user, p) {
      const stayId = num(p, "stayId");
      mustStay(stayId);
      const amount = num(p, "amount");
      if (amount <= 0) throw new Error("金额必须大于0");
      const id = run("INSERT INTO fees(stay_id,type,direction,amount,description,created_by) VALUES(?,?,?,?,?,?)",
        stayId, req(p, "type", "费用类型"), str(p, "direction", "charge"), amount, str(p, "description"), user.id);
      audit(stayId, user, "费用登记", `${str(p, "description") || str(p, "type")} ${amount}元`);
      return { id };
    },
  },

  "fees.void": {
    roles: ["finance", "admin"],
    run(user, p) {
      const f = q1("SELECT * FROM fees WHERE id=?", num(p, "id"));
      if (!f) throw new Error("费用不存在");
      run("UPDATE fees SET status='void' WHERE id=?", Number(f.id));
      audit(Number(f.stay_id), user, "费用作废", `${f.description} ${f.amount}元`);
      return { message: "已作废" };
    },
  },

  // ---- 赠品 ----
  "gifts.create": {
    roles: ["frontdesk", "admin"],
    run(user, p) {
      const stayId = num(p, "stayId");
      mustStay(stayId);
      const id = run("INSERT INTO gifts(stay_id,name,source) VALUES(?,?,'added')", stayId, req(p, "name", "赠品名称"));
      audit(stayId, user, "赠品登记", str(p, "name"));
      return { id };
    },
  },

  "gifts.deliver": {
    roles: ["frontdesk", "admin"],
    run(user, p) {
      const g = q1("SELECT * FROM gifts WHERE id=?", num(p, "id"));
      if (!g) throw new Error("赠品不存在");
      run("UPDATE gifts SET status='delivered', delivered_at=?, delivered_by=? WHERE id=?", now(), user.id, Number(g.id));
      audit(Number(g.stay_id), user, "赠品发放", String(g.name));
      return { message: "已发放" };
    },
  },

  // ---- 产康排班 ----
  "schedules.create": {
    roles: ["therapist", "head_nurse", "admin"],
    run(user, p) {
      const stayId = num(p, "stayId");
      mustStay(stayId);
      const id = run("INSERT INTO therapist_schedules(stay_id,therapist_id,project,scheduled_at) VALUES(?,?,?,?)",
        stayId, num(p, "therapistId") || user.id, req(p, "project", "项目"), req(p, "scheduledAt", "时间"));
      audit(stayId, user, "产康排班", `${str(p, "project")} @ ${str(p, "scheduledAt")}`);
      return { id };
    },
  },

  "schedules.update": {
    roles: ["therapist", "head_nurse", "admin"],
    run(user, p) {
      const s = q1("SELECT * FROM therapist_schedules WHERE id=?", num(p, "id"));
      if (!s) throw new Error("排班不存在");
      const action = req(p, "op", "操作");
      if (action === "done") {
        run("UPDATE therapist_schedules SET status='done', done_at=? WHERE id=?", now(), Number(s.id));
      } else if (action === "delay") {
        const reason = req(p, "reason", "延期原因");
        run("UPDATE therapist_schedules SET status='delayed', delay_reason=?, scheduled_at=? WHERE id=?",
          reason, str(p, "newTime", String(s.scheduled_at)), Number(s.id));
        createException(Number(s.stay_id), "project_delay", `产康项目延期：${s.project}`,
          `原时间${s.scheduled_at}，原因：${reason}`, "low", user);
      } else if (action === "cancel") {
        run("UPDATE therapist_schedules SET status='cancelled' WHERE id=?", Number(s.id));
      } else {
        throw new Error("未知操作");
      }
      audit(Number(s.stay_id), user, "产康排班", `${s.project} → ${action}`);
      return { message: "已更新" };
    },
  },

  // ---- 宝宝托管日志 ----
  "hosting.create": {
    roles: ["nurse", "matron", "head_nurse", "admin"],
    run(user, p) {
      const stayId = num(p, "stayId");
      const stay = mustStay(stayId);
      const id = run("INSERT INTO hosting_logs(stay_id,baby_name,type,start_time,end_time,caregiver_id,caregiver_name,notes) VALUES(?,?,?,?,?,?,?,?)",
        stayId, String(stay.baby_name || "宝宝"), str(p, "type", "托管"),
        req(p, "startTime", "开始时间"), str(p, "endTime") || null, user.id, user.name, str(p, "notes"));
      audit(stayId, user, "托管日志", `${str(p, "type", "托管")} ${str(p, "startTime")}`);
      return { id };
    },
  },

  // ---- 医生巡诊 ----
  "rounds.create": {
    roles: ["pediatrician", "admin"],
    run(user, p) {
      const stayId = num(p, "stayId");
      mustStay(stayId);
      const id = run("INSERT INTO doctor_rounds(stay_id,doctor_id,doctor_name,round_date,findings,advice) VALUES(?,?,?,?,?,?)",
        stayId, user.id, user.name, str(p, "roundDate", today()), str(p, "findings"), str(p, "advice"));
      // 黄疸复测值更新
      const jl = num(p, "jaundiceLevel", -1);
      if (jl >= 0) {
        run("UPDATE stays SET jaundice_level=?, jaundice_note=? WHERE id=?", jl, str(p, "jaundiceNote", String(mustStay(stayId).jaundice_note || "")), stayId);
      }
      audit(stayId, user, "医生巡诊", str(p, "findings").slice(0, 60));
      return { id };
    },
  },

  // ---- 异常工单 ----
  "exceptions.create": {
    roles: ["admin", "head_nurse", "nurse", "matron", "pediatrician", "nutritionist", "therapist", "frontdesk", "finance", "family"],
    run(user, p) {
      const stayId = num(p, "stayId");
      assertFamilyStay(user, stayId);
      mustStay(stayId);
      const id = createException(stayId, req(p, "type", "异常类型"), req(p, "title", "标题"),
        str(p, "description"), str(p, "severity", "medium"), user);
      return { id, message: "异常工单已创建" };
    },
  },

  "exceptions.update": {
    roles: ["admin", "head_nurse", "nurse", "pediatrician", "nutritionist", "therapist", "frontdesk", "finance"],
    run(user, p) {
      const ex = q1("SELECT * FROM exceptions WHERE id=?", num(p, "id"));
      if (!ex) throw new Error("工单不存在");
      const action = req(p, "op", "操作");
      const note = str(p, "note");
      let status = String(ex.status);
      if (action === "accept") status = "processing";
      else if (action === "resolve") { status = "resolved"; }
      else if (action === "close") status = "closed";
      else if (action === "note") { /* 仅追加处理记录 */ }
      else throw new Error("未知操作");
      run("UPDATE exceptions SET status=?, resolution=CASE WHEN ?='resolve' THEN ? ELSE resolution END, resolved_at=CASE WHEN ?='resolve' THEN ? ELSE resolved_at END, updated_at=? WHERE id=?",
        status, action, note, action, now(), now(), Number(ex.id));
      run("INSERT INTO exception_events(exception_id,user_id,user_name,action,note) VALUES(?,?,?,?,?)",
        Number(ex.id), user.id, user.name, action === "note" ? "note" : action, note);
      audit(Number(ex.stay_id), user, "异常处置", `【${ex.title}】${action}${note ? "：" + note : ""}`);
      return { message: "已更新工单" };
    },
  },

  // ---- 月嫂请假 ----
  "matron.leave": {
    roles: ["matron", "head_nurse", "admin"],
    run(user, p) {
      const stayId = num(p, "stayId");
      const stay = mustStay(stayId);
      const from = req(p, "fromDate", "请假开始");
      const to = req(p, "toDate", "请假结束");
      const reason = str(p, "reason");
      const reassignTo = num(p, "reassignTo");
      createException(stayId, "matron_leave", `月嫂请假（${from} 至 ${to}）`,
        `申请人：${user.name}。原因：${reason || "事假"}`, "medium", user);
      let note = "";
      if (reassignTo) {
        const target = q1("SELECT * FROM users WHERE id=?", reassignTo);
        if (target) {
          const r = getAffectedTasks(stayId, from, to);
          for (const t of r) run("UPDATE care_tasks SET assignee_id=? WHERE id=?", reassignTo, Number(t.id));
          note = `，${r.length}项夜间照护任务已改派${target.name}`;
        }
      }
      audit(stayId, user, "月嫂请假", `${from}至${to}：${reason}${note}`);
      return { message: `请假已登记${note}` };
    },
  },

  // ---- 家属反馈 ----
  "feedbacks.create": {
    roles: ["family"],
    run(user, p) {
      const stayId = num(p, "stayId");
      assertFamilyStay(user, stayId);
      const rating = Math.min(5, Math.max(1, num(p, "rating", 5)));
      const id = run("INSERT INTO feedbacks(stay_id,user_id,user_name,rating,content) VALUES(?,?,?,?,?)",
        stayId, user.id, user.name, rating, req(p, "content", "反馈内容"));
      audit(stayId, user, "家属反馈", `评分${rating}：${str(p, "content").slice(0, 50)}`);
      return { id, message: "反馈已提交，感谢评价" };
    },
  },

  "feedbacks.respond": {
    roles: ["head_nurse", "admin"],
    run(user, p) {
      const f = q1("SELECT * FROM feedbacks WHERE id=?", num(p, "id"));
      if (!f) throw new Error("反馈不存在");
      const affect = p.affectScheduling === true || num(p, "affectScheduling") === 1 ? 1 : 0;
      run("UPDATE feedbacks SET status='responded', response=?, affect_scheduling=?, handled_by=? WHERE id=?",
        req(p, "response", "回复内容"), affect, user.id, Number(f.id));
      audit(Number(f.stay_id), user, "反馈回复", `回复评分${f.rating}的反馈${affect ? "（已标记影响排班）" : ""}`);
      return { message: "已回复" };
    },
  },

  // ---- 随访 ----
  "followups.create": {
    roles: ["head_nurse", "admin", "frontdesk"],
    run(user, p) {
      const stayId = num(p, "stayId");
      mustStay(stayId);
      const id = run("INSERT INTO follow_ups(stay_id,type,scheduled_at,content,created_by) VALUES(?,?,?,?,?)",
        stayId, str(p, "type", "回访"), req(p, "scheduledAt", "随访时间"), str(p, "content"), user.id);
      audit(stayId, user, "随访安排", `${str(p, "type", "回访")} @ ${str(p, "scheduledAt")}`);
      return { id };
    },
  },

  "followups.done": {
    roles: ["head_nurse", "admin", "frontdesk"],
    run(user, p) {
      const f = q1("SELECT * FROM follow_ups WHERE id=?", num(p, "id"));
      if (!f) throw new Error("随访不存在");
      run("UPDATE follow_ups SET status='done', result=?, done_at=? WHERE id=?", str(p, "result"), now(), Number(f.id));
      audit(Number(f.stay_id), user, "随访完成", str(p, "result").slice(0, 60));
      return { message: "已记录随访结果" };
    },
  },

  // ---- 复购/转介绍 ----
  "referrals.create": {
    roles: ["frontdesk", "admin", "head_nurse"],
    run(user, p) {
      const stayId = num(p, "stayId");
      mustStay(stayId);
      const id = run("INSERT INTO referrals(stay_id,kind,lead_name,lead_phone,note) VALUES(?,?,?,?,?)",
        stayId, str(p, "kind", "referral"), req(p, "leadName", "线索姓名"), str(p, "leadPhone"), str(p, "note"));
      audit(stayId, user, "线索登记", `${str(p, "kind") === "repurchase" ? "复购" : "转介绍"}：${str(p, "leadName")}`);
      return { id };
    },
  },

  "referrals.update": {
    roles: ["frontdesk", "admin", "head_nurse"],
    run(user, p) {
      const r = q1("SELECT * FROM referrals WHERE id=?", num(p, "id"));
      if (!r) throw new Error("线索不存在");
      run("UPDATE referrals SET status=? WHERE id=?", req(p, "status", "状态"), Number(r.id));
      audit(Number(r.stay_id), user, "线索跟进", `${r.lead_name} → ${str(p, "status")}`);
      return { message: "已更新" };
    },
  },

  // ---- 家属沟通 ----
  "messages.create": {
    roles: ["admin", "head_nurse", "nurse", "matron", "pediatrician", "nutritionist", "therapist", "frontdesk", "finance", "family"],
    run(user, p) {
      const stayId = num(p, "stayId");
      assertFamilyStay(user, stayId);
      const audience = user.role === "family" ? "staff" : str(p, "audience", "all");
      const id = run("INSERT INTO messages(stay_id,from_user_id,from_name,from_role,audience,content) VALUES(?,?,?,?,?,?)",
        stayId, user.id, user.name, user.role, audience, req(p, "content", "内容"));
      audit(stayId, user, "家属沟通", str(p, "content").slice(0, 60));
      return { id };
    },
  },

  // ---- 结算确认 ----
  "settlements.confirm": {
    roles: ["finance", "admin"],
    run(user, p) {
      const stayId = num(p, "stayId");
      const s = q1("SELECT * FROM settlements WHERE stay_id=?", stayId);
      if (!s) throw new Error("结算单不存在，请先办理出所");
      const paid = num(p, "paid", Number(s.total_charge) - Number(s.total_refund));
      const balance = Number(s.total_charge) - Number(s.total_refund) - paid;
      run("UPDATE settlements SET paid=?, balance=?, status='confirmed', confirmed_by=?, confirmed_at=? WHERE stay_id=?",
        paid, balance, user.id, now(), stayId);
      audit(stayId, user, "结算确认", `实收${paid}，余额${balance}`);
      return { message: `结算已确认，余额 ${balance} 元` };
    },
  },
};

function getAffectedTasks(stayId: number, from: string, to: string): Row[] {
  return q(`SELECT * FROM care_tasks WHERE stay_id=? AND type='night_care' AND status='pending'
            AND substr(scheduled_at,1,10)>=? AND substr(scheduled_at,1,10)<=?`, stayId, from, to);
}

export function runAction(user: SessionUser, action: string, payload: Payload): unknown {
  const def = ACTIONS[action];
  if (!def) throw new Error(`未知操作：${action}`);
  if (!def.roles.includes(user.role)) throw new Error("当前角色无权执行该操作");
  return def.run(user, payload || {});
}

export function listActions(): string[] {
  return Object.keys(ACTIONS);
}
