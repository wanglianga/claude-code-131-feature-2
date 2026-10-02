// 业务动作层：所有角色共用的业务逻辑。每个动作做角色校验、写库、写审计日志。
import { q, q1, run, now, today, addDays, hashPassword, getDb } from "./db";
import crypto from "node:crypto";
import type { SessionUser } from "./auth";

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

export function audit(stayId: number | null, user: SessionUser | null, action: string, detail: string) {
  run("INSERT INTO audit_logs(stay_id,actor_id,actor_name,action,detail) VALUES(?,?,?,?,?)",
    stayId, user ? user.id : null, user ? user.name : "系统", action, detail);
}

// 异常类型 → 默认责任角色 / 是否同步护士长
const EX_ROUTE: Record<string, { role: string; sync: boolean }> = {
  jaundice: { role: "pediatrician", sync: true },
  breast_blockage: { role: "head_nurse", sync: true },
  extra_visit: { role: "frontdesk", sync: false },
  matron_leave: { role: "head_nurse", sync: true },
  meal_taboo: { role: "nutritionist", sync: true },
  project_delay: { role: "therapist", sync: false },
  package_upgrade: { role: "finance", sync: false },
  room_upgrade: { role: "frontdesk", sync: false },
  early_checkout: { role: "finance", sync: true },
  record_dispute: { role: "head_nurse", sync: true },
  checkout_dispute: { role: "head_nurse", sync: true },
  visit_authz_revoke: { role: "head_nurse", sync: true },
};

export function createException(
  stayId: number, type: string, title: string, description: string,
  severity: string, user: SessionUser | null
): number {
  const route = EX_ROUTE[type] || { role: "head_nurse", sync: true };
  const id = run(
    `INSERT INTO exceptions(stay_id,type,title,description,severity,status,raised_by,raised_by_name,assigned_role,synced_head_nurse)
     VALUES(?,?,?,?,?,'open',?,?,?,?)`,
    stayId, type, title, description, severity,
    user ? user.id : null, user ? user.name : "系统", route.role, route.sync ? 1 : 0
  );
  run("INSERT INTO exception_events(exception_id,user_id,user_name,action,note) VALUES(?,?,?,?,?)",
    id, user ? user.id : null, user ? user.name : "系统", "created", description || title);
  audit(stayId, user, "异常上报", `【${title}】${description}`);
  return id;
}

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

// ---------------------------------------------------------------- 探访协同引擎
type Interval = { start: string; end: string; label?: string };

const tparse = (s: string) => new Date(String(s).replace(" ", "T")).getTime();
const tfmt = (t: number) => {
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};
const addMin = (s: string, m: number) => tfmt(tparse(s) + m * 60000);
const overlap = (a: Interval, b: Interval) => tparse(a.start) < tparse(b.end) && tparse(b.start) < tparse(a.end);

// 探视开放时段 09:00–21:00
const dayBounds = (date: string): Interval => ({ start: `${date} 09:00`, end: `${date} 21:00` });

// 同时在房间内的最大探访人数（含候选区间）
function maxConcurrent(intervals: Interval[]): number {
  const ev: { t: number; d: number }[] = [];
  for (const i of intervals) { ev.push({ t: tparse(i.start), d: 1 }); ev.push({ t: tparse(i.end), d: -1 }); }
  ev.sort((a, b) => a.t - b.t || a.d - b.d);
  let cur = 0, max = 0;
  for (const e of ev) { cur += e.d; max = Math.max(max, cur); }
  return max;
}

// 固定护理/婴儿护理窗口（探访不可占用）：护理避让表中非 visit 的固定窗口 + 待执行宝宝洗澡
function fixedWindows(stayId: number, date: string): Interval[] {
  const wins: Interval[] = [];
  for (const a of q(`SELECT window_start, window_end, note FROM nursing_avoidances
                     WHERE stay_id=? AND status IN ('planned','done') AND reason!='visit'
                       AND substr(window_start,1,10)=?`, stayId, date)) {
    wins.push({ start: String(a.window_start), end: String(a.window_end), label: String(a.note || "护理安排") });
  }
  for (const t of q(`SELECT scheduled_at, title FROM care_tasks
                     WHERE stay_id=? AND type='baby_bath' AND status!='done' AND scheduled_at LIKE ?`, stayId, `${date}%`)) {
    wins.push({ start: String(t.scheduled_at), end: addMin(String(t.scheduled_at), 40), label: `婴儿护理·${String(t.title)}` });
  }
  return wins;
}

// 确认方案时需要改期避让的待执行护理任务（宝宝洗澡为固定窗口，不在此列）
const MOVABLE_DURATION: Record<string, number> = { rounds: 30, wound: 20, breast: 30, meal: 30, recovery: 60 };

function movableTasks(stayId: number, windows: Interval[]): Row[] {
  return q("SELECT * FROM care_tasks WHERE stay_id=? AND status='pending'", stayId).filter((t) => {
    if (!MOVABLE_DURATION[String(t.type)]) return false;
    const iv = { start: String(t.scheduled_at), end: addMin(String(t.scheduled_at), MOVABLE_DURATION[String(t.type)]) };
    return windows.some((w) => overlap(iv, w));
  });
}

// 为护理任务寻找避让改期时间：从原时间向两侧搜索（10分钟步进，当日08:00–21:00），
// 避开固定护理窗口与全部探访窗口；找不到则放到当日最后一个探访窗口之后
function rescheduleCareTime(stayId: number, date: string, original: string, durMin: number, avoidWins: Interval[]): string {
  const blocked = [...fixedWindows(stayId, date), ...avoidWins];
  const lo = tparse(`${date} 08:00`);
  const hi = tparse(`${date} 21:00`) - durMin * 60000;
  const origin = Math.max(lo, Math.min(hi, tparse(original)));
  for (let gap = 0; gap <= 13 * 60; gap += 10) {
    for (const off of gap === 0 ? [0] : [gap * 60000, -gap * 60000]) {
      const s = origin + off;
      if (s < lo || s > hi) continue;
      const cand = { start: tfmt(s), end: tfmt(s + durMin * 60000) };
      if (!blocked.some((b) => overlap(cand, b))) return cand.start;
    }
  }
  const last = avoidWins.map((w) => tparse(w.end)).reduce((m, x) => Math.max(m, x), tparse(`${date} 08:00`));
  return tfmt(last + 30 * 60000);
}

function relationScore(relation: string): number {
  if (/丈夫|配偶|妻|夫/.test(relation)) return 50;
  if (/婆婆|公公|父|母|岳父|岳母|奶奶|爷爷|外婆|外公/.test(relation)) return 40;
  if (/儿子|女儿|子女|孩子/.test(relation)) return 30;
  if (/兄|弟|姐|妹/.test(relation)) return 20;
  return 10;
}

// 优先级 = 授权关系权重 − 未被覆盖的爽约记录（每次 −30）
function priorityScore(stayId: number, v: Row, authz: Row | null): number {
  let score = 0;
  if (authz && String(authz.status) === "active") {
    score += String(authz.kind) === "routine" ? 100 : 60;
    score += relationScore(String(v.relation || authz.relation || ""));
  }
  const r = q1(`SELECT COUNT(*) AS c FROM visits WHERE stay_id=? AND visitor_name=? AND no_show=1 AND no_show_overridden=0`,
    stayId, String(v.visitor_name));
  score -= Number(r?.c || 0) * 30;
  return score;
}

// 前置阻断项：临时授权未经产妇确认 / 无有效授权 / 健康异常或未核验 / 消毒未完成 → 一律不得下发门禁
function visitBlockers(v: Row, authz: Row | null): string[] {
  const b: string[] = [];
  if (!authz) {
    b.push(Number(v.is_temp) === 1 ? "临时授权未登记" : "无有效产妇授权");
  } else if (String(authz.status) !== "active") {
    b.push(String(authz.kind) === "temp" ? "临时授权未经产妇书面确认" : "产妇授权未生效");
  }
  if (Number(v.health_ok) !== 1) {
    b.push(String(v.health_note || "") ? `探访人健康异常：${String(v.health_note)}` : "探访人健康状况未核验");
  }
  if (Number(v.disinfected) !== 1) b.push("入所消毒未完成");
  return b;
}

type Placement = {
  visitId: number; score: number; decision: "direct" | "split" | "reschedule" | "queue" | "blocked";
  requested: Interval; assigned: Interval | null; reason: string; blockers: string[];
};

// 从区间中扣除固定窗口，得到剩余可用段
function subtractFixed(iv: Interval, fixed: Interval[]): Interval[] {
  let segs = [iv];
  for (const f of fixed) {
    const next: Interval[] = [];
    for (const s of segs) {
      if (!overlap(s, f)) { next.push(s); continue; }
      if (tparse(f.start) > tparse(s.start)) next.push({ start: s.start, end: f.start });
      if (tparse(f.end) < tparse(s.end)) next.push({ start: f.end, end: s.end });
    }
    segs = next.filter((s) => tparse(s.end) > tparse(s.start));
  }
  return segs;
}

function fits(cand: Interval, placed: Interval[], fixed: Interval[], cap: number): boolean {
  const bounds = dayBounds(cand.start.slice(0, 10));
  if (tparse(cand.start) < tparse(bounds.start) || tparse(cand.end) > tparse(bounds.end)) return false;
  if (fixed.some((f) => overlap(cand, f))) return false;
  return maxConcurrent([cand, ...placed]) <= cap;
}

// 冲突求解：按授权优先级排序，依次 原时段 → 拆分 → 改约 → 排队；阻断项转人工
function solveConflicts(stayId: number, date: string, visits: Row[]): {
  placements: Placement[]; fixed: Interval[]; movedTasksHint: Row[];
} {
  const cap = Math.max(1, Number(q1("SELECT visitor_capacity AS c FROM rooms r JOIN stays s ON s.room_id=r.id WHERE s.id=?", stayId)?.c || 2));
  const fixed = fixedWindows(stayId, date);
  const placed: Interval[] = [];
  const enriched = visits.map((v) => {
    const authz = v.authz_id ? q1("SELECT * FROM visit_authorizations WHERE id=?", Number(v.authz_id)) : null;
    return { v, authz: authz || null, score: priorityScore(stayId, v, authz || null) };
  });
  enriched.sort((a, b) => b.score - a.score || Number(a.v.id) - Number(b.v.id));

  const placements: Placement[] = [];
  for (const { v, authz, score } of enriched) {
    const req: Interval = { start: String(v.visit_time), end: addMin(String(v.visit_time), Number(v.hours) * 60) };
    const blockers = visitBlockers(v, authz);
    const base = { visitId: Number(v.id), score, requested: req, blockers };
    if (blockers.length) {
      placements.push({ ...base, decision: "blocked", assigned: null, reason: "存在前置阻断项，保留原预约并转人工处理，不下发门禁" });
      continue;
    }
    // 1) 原时段可直接安排
    if (fits(req, placed, fixed, cap)) {
      placed.push(req);
      placements.push({ ...base, decision: "direct", assigned: req, reason: "授权优先级内，原时段安排" });
      continue;
    }
    // 2) 拆分时段：在申请时段内扣除固定护理窗口后的最长可用段（≥30分钟）
    const segs = subtractFixed(req, fixed)
      .filter((s) => tparse(s.end) - tparse(s.start) >= 30 * 60000 && maxConcurrent([s, ...placed]) <= cap)
      .sort((a, b) => (tparse(b.end) - tparse(b.start)) - (tparse(a.end) - tparse(a.start)));
    if (segs.length) {
      const s = segs[0];
      placed.push(s);
      placements.push({ ...base, decision: "split", assigned: s,
        reason: `申请时段与护理安排冲突，拆分为 ${s.start.slice(11)}-${s.end.slice(11)} 分段探访` });
      continue;
    }
    // 3) 改约：30分钟网格在当日探视时段内寻找最近的完整空档
    const bounds = dayBounds(date);
    const dur = Number(v.hours) * 60;
    let found: Interval | null = null;
    for (let delta = 0; delta <= 24 * 60 && !found; delta += 30) {
      for (const off of delta === 0 ? [0] : [delta, -delta]) {
        const cand = { start: addMin(req.start, off), end: addMin(req.start, off + dur) };
        if (cand.start.slice(0, 10) !== date) continue;
        if (fits(cand, placed, fixed, cap)) { found = cand; break; }
      }
    }
    if (found) {
      placed.push(found);
      placements.push({ ...base, decision: "reschedule", assigned: found,
        reason: `房间容量/护理时段冲突，改约至 ${found.start.slice(11)}-${found.end.slice(11)}` });
      continue;
    }
    // 4) 排队：当日无可行空档
    placements.push({ ...base, decision: "queue", assigned: null, reason: "当日容量与护理时段均无空档，进入排队等候人工改约其他日期" });
  }

  // 提示：确认方案时将被原子改期的护理任务
  const assignedWins = placements.filter((p) => p.assigned).map((p) => p.assigned!) as Interval[];
  return { placements, fixed, movedTasksHint: movableTasks(stayId, assignedWins) };
}

function sysMessage(stayId: number, audience: string, content: string) {
  run("INSERT INTO messages(stay_id,from_user_id,from_name,from_role,audience,content) VALUES(?,NULL,?,?,?,?)",
    stayId, "门禁协同系统", "system", audience, content);
}

function doorToken(roomNumber: string): string {
  return `MC-${String(roomNumber)}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
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

  // ---- 探访 ----
  "visits.create": {
    roles: ["family", "frontdesk", "admin"],
    run(user, p) {
      const stayId = num(p, "stayId");
      assertFamilyStay(user, stayId);
      const stay = mustStay(stayId);
      if (stay.status !== "in_stay") throw new Error("已出所，无法预约探访");
      const visitorName = req(p, "visitorName", "探访人");
      const isTemp = p.isTemp === true || p.isTemp === "true" || num(p, "isTemp") === 1 ? 1 : 0;
      // 自动关联有效授权单（允许显式传入 authzId）
      let authzId = num(p, "authzId");
      if (!authzId) {
        const az = q1("SELECT id FROM visit_authorizations WHERE stay_id=? AND visitor_name=? AND status='active' ORDER BY id DESC LIMIT 1",
          stayId, visitorName);
        if (az) authzId = Number(az.id);
      }
      const id = run("INSERT INTO visits(stay_id,visitor_name,relation,visit_time,hours,is_temp,authz_id,created_by) VALUES(?,?,?,?,?,?,?,?)",
        stayId, visitorName, str(p, "relation"), req(p, "visitTime", "探访时间"),
        num(p, "hours", 2), isTemp, authzId || null, user.id);
      if (isTemp) {
        createException(stayId, "extra_visit", "家属临时增加探访",
          `${visitorName}（${str(p, "relation")}）申请临时探访：${str(p, "visitTime")}`, "medium", user);
      }
      audit(stayId, user, "探访预约", `${visitorName} 预约 ${str(p, "visitTime")}${isTemp ? "（临时）" : ""}${authzId ? "，已关联产妇授权" : "，待核验授权"}`);
      return { id, message: isTemp && !authzId
        ? "探访预约已提交；临时授权尚待产妇确认，前台暂不能下发门禁"
        : "探访预约已提交，待前台生成协同方案" };
    },
  },

  // ---- 产妇授权管理 ----
  // 登记授权（家属代登记/前台登记），必须经产妇书面/线上确认后生效
  "authz.create": {
    roles: ["family", "frontdesk", "admin"],
    run(user, p) {
      const stayId = num(p, "stayId");
      assertFamilyStay(user, stayId);
      mustStay(stayId);
      const name = req(p, "visitorName", "探访人");
      const kind = str(p, "kind", "routine") === "temp" ? "temp" : "routine";
      const motherText = str(p, "motherConfirmText");
      const id = run(`INSERT INTO visit_authorizations(stay_id,visitor_name,relation,kind,status,mother_confirmed,mother_confirmed_text,confirmed_at,created_by)
        VALUES(?,?,?,?,?,?,?,?,?)`,
        stayId, name, str(p, "relation"), kind, "pending", 0, "", null, user.id);
      audit(stayId, user, "探访授权登记", `${name}（${kind === "temp" ? "临时" : "常规"}）授权待产妇确认`);
      return { id, message: "授权已登记，待产妇书面/线上确认后生效" };
    },
  },

  // 产妇确认授权（家属持产妇书面确认语确认；前台/管理员同样可执行）
  "authz.confirm": {
    roles: ["family", "frontdesk", "admin"],
    run(user, p) {
      const a = q1("SELECT * FROM visit_authorizations WHERE id=?", num(p, "id"));
      if (!a) throw new Error("授权单不存在");
      assertFamilyStay(user, Number(a.stay_id));
      if (String(a.status) !== "pending") throw new Error("该授权单不是待确认状态");
      const text = req(p, "motherConfirmText", "产妇确认方式/书面确认内容");
      run("UPDATE visit_authorizations SET status='active',mother_confirmed=1,mother_confirmed_text=?,confirmed_at=? WHERE id=?",
        text, now(), Number(a.id));
      audit(Number(a.stay_id), user, "探访授权确认", `${a.visitor_name} 授权经产妇确认生效（${text}）`);
      return { message: `${a.visitor_name} 的探访授权已生效` };
    },
  },

  // 产妇撤回授权：未入场→立即失效门禁并通知前台；已入场→升级护士长协调
  "authz.revoke": {
    roles: ["family", "frontdesk", "head_nurse", "admin"],
    run(user, p) {
      const a = q1("SELECT * FROM visit_authorizations WHERE id=?", num(p, "id"));
      if (!a) throw new Error("授权单不存在");
      assertFamilyStay(user, Number(a.stay_id));
      if (String(a.status) !== "active") throw new Error("该授权不在生效状态，无法撤回");
      const reason = str(p, "reason", "产妇撤回授权");
      // 该授权下、当前在房间内的探访（已入场未离场）
      const inside = q(`SELECT v.id, v.visitor_name, da.id AS access_id FROM visits v
                        JOIN door_access da ON da.visit_id=v.id
                        WHERE v.authz_id=? AND da.status='entered'`, Number(a.id));
      const entered = inside.length > 0;
      run("UPDATE visit_authorizations SET status='revoked',revoked_at=?,revoke_reason=?,entered_on_revoke=? WHERE id=?",
        now(), reason, entered ? 1 : 0, Number(a.id));

      const stayId = Number(a.stay_id);
      if (entered) {
        // 已入场：不得远程失效门禁直接驱离，升级护士长现场协调
        run("UPDATE visit_authorizations SET escalated_head_nurse=1,escalated_note=? WHERE id=?",
          `撤回时${inside.map((x) => String(x.visitor_name)).join("、")}仍在房间内，已升级护士长现场协调`, Number(a.id));
        createException(stayId, "visit_authz_revoke", "产妇撤回授权时探访人仍在场，需护士长协调",
          `产妇撤回对${String(a.visitor_name)}的探访授权（原因：${reason}），但该探访人已入场，门禁未远程失效，请护士长现场协调离场。`,
          "high", user);
        sysMessage(stayId, "staff", `【需护士长协调】产妇已撤回对 ${String(a.visitor_name)} 的授权，探访人仍在 ${String(q1("SELECT r.number AS n FROM stays s JOIN rooms r ON r.id=s.room_id WHERE s.id=?", stayId)?.n || "")} 房内，请现场协调。`);
        audit(stayId, user, "授权撤回-升级", `${a.visitor_name}：撤回时仍在场，升级护士长协调（门禁未失效）`);
        return { escalated: true, message: "探访人已入场，已升级护士长现场协调，未远程失效门禁" };
      }

      // 未入场：立即失效所有未使用门禁，并取消该授权下尚未生效的探访申请
      const pendingVisits = q(`SELECT v.id, v.visitor_name FROM visits v
        WHERE v.authz_id=? AND v.status IN ('pending','approved','scheduled') AND v.closed=0
          AND v.entered_at IS NULL`, Number(a.id));
      let killed = 0;
      for (const v of pendingVisits) {
        const acc = q1("SELECT id FROM door_access WHERE visit_id=? AND status='active'", Number(v.id));
        if (acc) {
          run("UPDATE door_access SET status='revoked',revoked_reason=? WHERE id=?", `产妇撤回授权：${reason}`, Number(acc.id));
          killed++;
        }
        run("UPDATE visits SET status='cancelled', access_granted=0, plan_decision='',plan_detail='' WHERE id=?", Number(v.id));
      }
      sysMessage(stayId, "staff", `【前台通知】产妇已撤回对 ${String(a.visitor_name)} 的探访授权，${killed} 张未使用门禁已立即失效。`);
      audit(stayId, user, "授权撤回", `${a.visitor_name}：未入场，${killed}张门禁立即失效并通知前台`);
      return { escalated: false, killed, message: `授权已撤回，${killed} 张未使用门禁立即失效，已通知前台` };
    },
  },

  // 护士长处理已入场撤回：现场协调离场并失效门禁
  "authz.resolveEscalation": {
    roles: ["head_nurse", "admin"],
    run(user, p) {
      const a = q1("SELECT * FROM visit_authorizations WHERE id=?", num(p, "id"));
      if (!a) throw new Error("授权单不存在");
      const note = req(p, "note", "现场协调结果");
      const t = now();
      const inside = q(`SELECT da.* FROM door_access da
        WHERE da.status='entered' AND da.visit_id IN (SELECT id FROM visits WHERE authz_id=?)`, Number(a.id));
      for (const x of inside) {
        run("UPDATE door_access SET status='revoked',revoked_reason=? WHERE id=?", `护士长现场协调离场：${note}`, Number(x.id));
        run("UPDATE visits SET left_at=? WHERE id=?", t, Number(x.visit_id));
        run("INSERT INTO door_events(access_id,stay_id,visit_id,visitor_name,direction,event_at,operator_name) VALUES(?,?,?,?,'exit',?,?)",
          Number(x.id), Number(a.stay_id), Number(x.visit_id), String(x.visitor_name), t, user.name);
      }
      run("UPDATE visit_authorizations SET escalated_note=? WHERE id=?", note, Number(a.id));
      audit(Number(a.stay_id), user, "授权撤回-协调完成", `${a.visitor_name}：现场协调离场，失效门禁${inside.length}张。${note}`);
      return { message: `已记录现场协调结果，${inside.length} 人离场记录已补全并失效门禁` };
    },
  },

  // ---- 探访人健康核验（异常者不得下发门禁）----
  "visits.healthCheck": {
    roles: ["frontdesk", "nurse", "head_nurse", "admin"],
    run(user, p) {
      const v = q1("SELECT * FROM visits WHERE id=?", num(p, "id"));
      if (!v) throw new Error("探访记录不存在");
      const ok = p.healthOk === true || p.healthOk === "true" || num(p, "healthOk") === 1 ? 1 : 0;
      const note = str(p, "healthNote");
      if (!ok && !note) throw new Error("健康异常时必须填写异常情况");
      run("UPDATE visits SET health_ok=?,health_note=?,health_checked_at=? WHERE id=?", ok, note, now(), Number(v.id));
      audit(Number(v.stay_id), user, "探访健康核验", `${v.visitor_name}：${ok ? "通过" : "异常"}${note ? "（" + note + "）" : ""}`);
      return { message: ok ? "健康核验通过" : "已登记健康异常，该申请不可下发门禁" };
    },
  },

  // ---- 冲突求解：生成排队/拆分/改约方案（不落库任何权限，只生成方案单）----
  "visits.generatePlan": {
    roles: ["frontdesk", "head_nurse", "admin"],
    run(user, p) {
      const stayId = num(p, "stayId");
      mustStay(stayId);
      const date = req(p, "date", "探访日期");
      const visits = q(`SELECT * FROM visits WHERE stay_id=? AND substr(visit_time,1,10)=?
                        AND status IN ('pending','approved') AND closed=0 ORDER BY id`, stayId, date);
      if (!visits.length) throw new Error(`${date} 暂无可编排的探访申请`);
      const { placements, fixed, movedTasksHint } = solveConflicts(stayId, date, visits);

      // 写优先级
      for (const pl of placements) {
        const vv = visits.find((x) => Number(x.id) === pl.visitId)!;
        const authz = vv.authz_id ? q1("SELECT * FROM visit_authorizations WHERE id=?", Number(vv.authz_id)) : null;
        run("UPDATE visits SET priority_score=? WHERE id=?", priorityScore(stayId, vv, authz || null), pl.visitId);
      }

      const blockers = [...new Set(placements.filter((x) => x.blockers.length).flatMap((x) => x.blockers))];
      const countOf = (d: string) => placements.filter((x) => x.decision === d).length;
      const lines = placements.map((pl) => {
        const vv = visits.find((x) => Number(x.id) === pl.visitId)!;
        const when = pl.assigned ? `${pl.assigned.start.slice(11)}-${pl.assigned.end.slice(11)}` : "—";
        return `${String(vv.visitor_name)}（优先级${pl.score}）：${({ direct: "原时段安排", split: "拆分时段", reschedule: "改约", queue: "排队", blocked: "转人工" } as Record<string, string>)[pl.decision]} ${when} —— ${pl.reason}${pl.blockers.length ? "【阻断】" + pl.blockers.join("、") : ""}`;
      });
      fixed.forEach((f) => lines.push(`固定避让：${f.start.slice(11)}-${f.end.slice(11)} ${f.label || ""}`));
      if (movedTasksHint.length) lines.push(`确认后将原子改期护理任务 ${movedTasksHint.length} 项（护士查房避让）`);
      const summary = lines.join("\n");

      const planId = run(`INSERT INTO visit_plans(stay_id,visit_date,status,summary,blockers,created_by)
        VALUES(?,?, 'proposed',?, ?,?)`, stayId, date, summary, JSON.stringify(blockers), user.id);
      for (const pl of placements) {
        run("UPDATE visits SET plan_decision=?,plan_detail=?,plan_generated_at=?,plan_generated_by=? WHERE id=?",
          pl.decision, JSON.stringify({ assigned: pl.assigned, reason: pl.reason, blockers: pl.blockers, planId }),
          now(), user.id, pl.visitId);
      }
      audit(stayId, user, "探访方案生成",
        `${date}：原时段${countOf("direct")} / 拆分${countOf("split")} / 改约${countOf("reschedule")} / 排队${countOf("queue")} / 阻断${countOf("blocked")}`);
      return {
        planId,
        placements: placements.map((pl) => {
          const vv = visits.find((x) => Number(x.id) === pl.visitId)!;
          return { visitId: pl.visitId, visitorName: String(vv.visitor_name), decision: pl.decision, score: pl.score, assigned: pl.assigned, blockers: pl.blockers };
        }),
        counts: { direct: countOf("direct"), split: countOf("split"), reschedule: countOf("reschedule"), queue: countOf("queue"), blocked: countOf("blocked") },
        blockers,
        movableTaskIds: movedTasksHint.map((t) => Number(t.id)),
        message: blockers.length
          ? `方案已生成，但存在 ${blockers.length} 类阻断项，相关申请保留原预约，需人工处理`
          : "方案已生成，可由前台确认后原子下发",
      };
    },
  },

  // ---- 前台确认方案：门禁有效期+访客名单+护士查房避让 原子更新 ----
  "visits.confirmPlan": {
    roles: ["frontdesk", "head_nurse", "admin"],
    run(user, p) {
      const planId = num(p, "planId");
      const plan = q1("SELECT * FROM visit_plans WHERE id=?", planId);
      if (!plan) throw new Error("方案不存在");
      if (String(plan.status) !== "proposed") throw new Error("该方案已处理，不能重复确认");
      const stayId = Number(plan.stay_id);
      const stay = mustStay(stayId);
      const room = q1("SELECT number FROM rooms WHERE id=?", Number(stay.room_id))!;
      const visits = q(`SELECT * FROM visits WHERE stay_id=? AND substr(visit_time,1,10)=?
                        AND status IN ('pending','approved') AND closed=0 AND plan_generated_by IS NOT NULL`,
        stayId, String(plan.visit_date));
      const details = new Map<number, { assigned: Interval | null; reason: string; blockers: string[]; decision: string; planId?: number }>();
      for (const v of visits) {
        try {
          const d = { decision: String(v.plan_decision), ...JSON.parse(String(v.plan_detail || "{}")) };
          if (Number(d.planId) === planId) details.set(Number(v.id), d);
        } catch { /* ignore */ }
      }
      const scoped = visits.filter((v) => details.has(Number(v.id)));
      const confirmed = scoped.filter((v) => {
        const d = details.get(Number(v.id));
        return d && d.assigned && !d.blockers?.length && ["direct", "split", "reschedule"].includes(d.decision);
      });
      const blocked = scoped.filter((v) => {
        const d = details.get(Number(v.id));
        return !d || !d.assigned || d.blockers?.length || ["queue", "blocked"].includes(d.decision);
      });
      if (!confirmed.length) throw new Error("方案中没有可下发的安排（全部被阻断或排队），已保留原预约，请人工处理");

      // 再次校验阻断项（防止方案生成后状态变化，如授权被撤回/健康转异常）
      const freshBlockers: string[] = [];
      for (const v of confirmed) {
        const authz = v.authz_id ? (q1("SELECT * FROM visit_authorizations WHERE id=?", Number(v.authz_id)) || null) : null;
        const bs = visitBlockers(v, authz);
        if (bs.length) freshBlockers.push(`${String(v.visitor_name)}：${bs.join("、")}`);
      }
      if (freshBlockers.length) {
        run("UPDATE visit_plans SET tx_status='fail' WHERE id=?", planId);
        audit(stayId, user, "方案确认失败", `门禁/护理未做任何变更：${freshBlockers.join("；")}`);
        throw new Error(`状态已变化，原子确认中止，原预约全部保留：${freshBlockers.join("；")}`);
      }

      const assignedWins: Interval[] = confirmed.map((v) => details.get(Number(v.id))!.assigned!);
      const moved = movableTasks(stayId, assignedWins);
      const db = getDb();
      const tx = db.exec.bind(db);
      let failed: string | null = null;
      try {
        tx("BEGIN IMMEDIATE");
        // (1) 门禁有效期 + 访客名单
        for (const v of confirmed) {
          const d = details.get(Number(v.id))!;
          const a = d.assigned!;
          const token = doorToken(String(room.number));
          const validFrom = addMin(a.start, -15);
          const validTo = addMin(a.end, 15);
          run("UPDATE visits SET status='approved', visit_time=?, hours=?, access_granted=1,access_granted_at=?,access_token=?,approved_by=? WHERE id=?",
            a.start, Math.max(1, Math.round((tparse(a.end) - tparse(a.start)) / 3600000)), now(), token, user.id, Number(v.id));
          run(`INSERT INTO door_access(stay_id,visit_id,visitor_name,room_number,valid_from,valid_to,status,token)
            VALUES(?,?,?,?,?,?,'active',?)`, stayId, Number(v.id), String(v.visitor_name), String(room.number), validFrom, validTo, token);
          run("INSERT INTO nursing_avoidances(stay_id,visit_id,plan_id,reason,window_start,window_end,note,status) VALUES(?,?,?, 'visit',?,?,?, 'planned')",
            stayId, Number(v.id), planId, a.start, a.end, `${String(v.visitor_name)}探访时段，查房/治疗避让（方案#${planId}）`);
        }
        // 排队/阻断：保留原预约
        for (const v of blocked) {
          const d = details.get(Number(v.id));
          run("UPDATE visits SET status='pending', plan_detail=? WHERE id=?",
            JSON.stringify({ ...(d || {}), kept: true }), Number(v.id));
        }
        // (2) 护士查房避让：冲突的待执行护理任务原子改期（避开固定窗口与全部探访窗口）
        for (const t of moved) {
          const dur = MOVABLE_DURATION[String(t.type)] || 30;
          const tStart = String(t.scheduled_at);
          const newTime = rescheduleCareTime(stayId, String(plan.visit_date), tStart, dur, assignedWins);
          run("UPDATE care_tasks SET scheduled_at=? WHERE id=? AND status='pending'", newTime, Number(t.id));
          run("INSERT INTO nursing_avoidances(stay_id,visit_id,plan_id,reason,window_start,window_end,note,status) VALUES(?,?,?, 'rounds_shift',?,?,?, 'planned')",
            stayId, null, planId, tStart, addMin(tStart, dur),
            `护理任务「${String(t.title)}」由${tStart.slice(11)}改期至${newTime.slice(11)}避让探访`);
        }
        // (3) 方案落地
        run("UPDATE visit_plans SET status='confirmed',confirmed_at=?,confirmed_by=?,tx_status=? WHERE id=?",
          now(), user.id, `access:${confirmed.length}|avoidance:${moved.length}`, planId);
        tx("COMMIT");
      } catch (e) {
        try { tx("ROLLBACK"); } catch { /* already rolled back */ }
        failed = e instanceof Error ? e.message : "事务失败";
      }
      if (failed) throw new Error(`原子更新失败，已全部回滚（原预约保留）：${failed}`);

      const names = confirmed.map((v) => String(v.visitor_name)).join("、");
      const visitAvoidances = q(`SELECT visit_id, id FROM nursing_avoidances WHERE plan_id=? AND reason='visit'`, planId)
        .map((r) => ({ visitId: Number(r.visit_id), avoidanceId: Number(r.id) }));
      sysMessage(stayId, "all", `探访方案#${planId}已确认：${names} 的门禁有效期与访客名单已下发，${moved.length} 项护理任务已改期避让。`);
      if (blocked.length) {
        sysMessage(stayId, "staff", `以下探访申请保留原预约待人工处理：${blocked.map((v) => String(v.visitor_name)).join("、")}`);
      }
      audit(stayId, user, "探访方案确认（原子）",
        `门禁${confirmed.length}张/护理改期${moved.length}项/访客名单：${names}${blocked.length ? `；保留待人工${blocked.length}份` : ""}`);
      return { message: `原子更新完成：门禁 ${confirmed.length} 张、护理避让改期 ${moved.length} 项`, confirmed: confirmed.length, moved: moved.length, blocked: blocked.length, visitAvoidances };
    },
  },

  // 驳回方案 → 保留全部原预约，提示人工处理
  "visits.rejectPlan": {
    roles: ["frontdesk", "head_nurse", "admin"],
    run(user, p) {
      const planId = num(p, "planId");
      const plan = q1("SELECT * FROM visit_plans WHERE id=?", planId);
      if (!plan) throw new Error("方案不存在");
      if (String(plan.status) !== "proposed") throw new Error("该方案已处理");
      run("UPDATE visit_plans SET status='rejected' WHERE id=?", planId);
      const visits = q("SELECT id,plan_detail FROM visits WHERE stay_id=? AND plan_generated_at IS NOT NULL", Number(plan.stay_id));
      for (const v of visits) {
        let pid = -1;
        try { pid = Number(JSON.parse(String(v.plan_detail || "{}")).planId); } catch { /* ignore */ }
        if (pid === planId) {
          run("UPDATE visits SET plan_decision='',plan_detail='',plan_generated_at=NULL,plan_generated_by=NULL,status='pending' WHERE id=?", Number(v.id));
        }
      }
      audit(Number(plan.stay_id), user, "探访方案驳回", `方案#${planId}驳回，原预约全部保留，转人工处理`);
      return { message: "方案已驳回，原预约保留，请人工协调" };
    },
  },

  // ---- 门禁进出（eventTime 可由前台补录，默认当前时间）----
  "door.enter": {
    roles: ["frontdesk", "nurse", "head_nurse", "admin"],
    run(user, p) {
      const visitId = num(p, "visitId");
      const v = q1("SELECT * FROM visits WHERE id=?", visitId);
      if (!v) throw new Error("探访记录不存在");
      if (Number(v.access_granted) !== 1) throw new Error("该探访未获门禁权限，禁止入场");
      const acc = q1("SELECT * FROM door_access WHERE visit_id=? AND status IN ('active') ORDER BY id DESC LIMIT 1", visitId);
      if (!acc) throw new Error("无有效门禁授权（可能已被撤回或失效）");
      const t = str(p, "eventTime") || now();
      if (tparse(t) < tparse(String(acc.valid_from)) - 5 * 60000 || tparse(t) > tparse(String(acc.valid_to))) {
        throw new Error("刷卡时间不在门禁有效期内");
      }
      run("UPDATE door_access SET status='entered' WHERE id=?", Number(acc.id));
      run("UPDATE visits SET entered_at=COALESCE(entered_at,?) WHERE id=?", t, visitId);
      run("INSERT INTO door_events(access_id,stay_id,visit_id,visitor_name,direction,event_at,operator_name) VALUES(?,?,?,?,'enter',?,?)",
        Number(acc.id), Number(v.stay_id), visitId, String(v.visitor_name), t, user.name);
      audit(Number(v.stay_id), user, "门禁入场", `${v.visitor_name} 刷卡进入 ${acc.room_number} 房`);
      return { message: `${v.visitor_name} 已入场` };
    },
  },

  "door.exit": {
    roles: ["frontdesk", "nurse", "head_nurse", "admin"],
    run(user, p) {
      const visitId = num(p, "visitId");
      const v = q1("SELECT * FROM visits WHERE id=?", visitId);
      if (!v) throw new Error("探访记录不存在");
      const acc = q1("SELECT * FROM door_access WHERE visit_id=? AND status='entered' ORDER BY id DESC LIMIT 1", visitId);
      if (!acc) throw new Error("该探访当前不在场");
      const t = str(p, "eventTime") || now();
      run("UPDATE door_access SET status='used' WHERE id=?", Number(acc.id));
      run("UPDATE visits SET left_at=? WHERE id=?", t, visitId);
      run("INSERT INTO door_events(access_id,stay_id,visit_id,visitor_name,direction,event_at,operator_name) VALUES(?,?,?,?,'exit',?,?)",
        Number(acc.id), Number(v.stay_id), visitId, String(v.visitor_name), t, user.name);
      audit(Number(v.stay_id), user, "门禁离场", `${v.visitor_name} 离开 ${acc.room_number} 房`);
      return { message: `${v.visitor_name} 已离场` };
    },
  },

  // ---- 爽约：未按约到场记录爽约；门禁未入场即失效 ----
  "visits.markNoShow": {
    roles: ["frontdesk", "head_nurse", "admin"],
    run(user, p) {
      const v = q1("SELECT * FROM visits WHERE id=?", num(p, "id"));
      if (!v) throw new Error("探访记录不存在");
      if (v.entered_at) throw new Error("探访人已入场，不能记爽约");
      const reason = req(p, "reason", "爽约情况说明");
      run("UPDATE visits SET no_show=1,no_show_reason=?,status='no_show' WHERE id=?", reason, Number(v.id));
      run("UPDATE door_access SET status='expired',revoked_reason=? WHERE visit_id=? AND status IN ('active','entered')",
        "爽约未入场，门禁失效", Number(v.id));
      audit(Number(v.stay_id), user, "探访爽约", `${v.visitor_name} 未按约到场：${reason}（影响后续排队优先级）`);
      return { message: "已记录爽约，该探访人后续申请排队优先级下调" };
    },
  },

  // 前台基于紧急照护或产妇书面确认覆盖爽约限制，必须留理由
  "visits.overrideNoShow": {
    roles: ["frontdesk", "head_nurse", "admin"],
    run(user, p) {
      const v = q1("SELECT * FROM visits WHERE id=?", num(p, "id"));
      if (!v) throw new Error("探访记录不存在");
      if (Number(v.no_show) !== 1) throw new Error("该记录无爽约标记");
      const basis = str(p, "basis", "emergency");
      if (!["emergency", "mother_written"].includes(basis)) throw new Error("覆盖依据非法");
      const reason = req(p, "reason", "覆盖理由");
      run(`UPDATE visits SET no_show_overridden=1,no_show_override_reason=?,no_show_override_by=?,no_show_override_at=? WHERE id=?`,
        `${basis === "emergency" ? "紧急照护" : "产妇书面确认"}：${reason}`, user.id, now(), Number(v.id));
      audit(Number(v.stay_id), user, "爽约限制覆盖", `${v.visitor_name}：${basis === "emergency" ? "紧急照护" : "产妇书面确认"}｜${reason}`);
      return { message: "已覆盖爽约优先级限制，理由已留档" };
    },
  },

  // ---- 护理避让结果回填（护理端）----
  "avoidances.update": {
    roles: ["nurse", "matron", "head_nurse", "admin"],
    run(user, p) {
      const a = q1("SELECT * FROM nursing_avoidances WHERE id=?", num(p, "id"));
      if (!a) throw new Error("避让安排不存在");
      const status = req(p, "status", "结果");
      if (!["done", "missed"].includes(status)) throw new Error("结果非法");
      run("UPDATE nursing_avoidances SET status=?,result=?,handled_by=?,handled_at=? WHERE id=?",
        status, str(p, "result", status === "done" ? "已按方案避让" : "未能避让"), user.id, now(), Number(a.id));
      audit(Number(a.stay_id), user, "护理避让回填", `${String(a.window_start).slice(5, 16)} ${status === "done" ? "已避让" : "未避让"}：${str(p, "result")}`);
      return { message: status === "done" ? "避让完成已记录" : "已记录未避让，将影响预约闭环判定" };
    },
  },

  // ---- 预约闭环：门禁进出 + 实际探访人数 + 护理避让结果 共同判定 ----
  "visits.closeLoop": {
    roles: ["frontdesk", "head_nurse", "admin", "nurse"],
    run(user, p) {
      const id = num(p, "id");
      const v = q1("SELECT * FROM visits WHERE id=?", id);
      if (!v) throw new Error("探访记录不存在");
      if (Number(v.closed) === 1) throw new Error("该预约已闭环");
      const events = q("SELECT * FROM door_events WHERE visit_id=? ORDER BY event_at", id);
      const enters = events.filter((e) => String(e.direction) === "enter");
      const exits = events.filter((e) => String(e.direction) === "exit");
      const avoids = q("SELECT * FROM nursing_avoidances WHERE visit_id=? AND reason='visit'", id);
      const avoidMissed = avoids.some((a) => String(a.status) === "missed");
      const avoidDone = avoids.length > 0 && avoids.every((a) => String(a.status) === "done");

      if (!enters.length) throw new Error("无门禁入场记录，不能闭环（如确未到场请登记爽约）");
      const result: string[] = [];
      let ok = true;
      result.push(`门禁：入场${enters.length}次/离场${exits.length}次${enters.length === exits.length ? "，进出配对完整" : "，进出记录不配对"}`);
      if (enters.length !== exits.length) ok = false;
      result.push(`实际探访人数：${enters.length}人`);
      if (!avoids.length) {
        result.push("护理避让：无避让安排");
      } else if (avoidDone) {
        result.push("护理避让：已按方案完成");
      } else if (avoidMissed) {
        result.push("护理避让：存在未避让项");
        ok = false;
      } else {
        // 门禁进出+人数已齐，但护理避让结果尚未回填 → 不构成健康闭环
        result.push("护理避让：结果未回填");
        ok = false;
      }

      run("UPDATE visits SET closed=1,closed_result=?,closed_at=?,closed_by=?,status=CASE WHEN entered_at IS NOT NULL AND left_at IS NOT NULL THEN 'completed' ELSE status END WHERE id=?",
        result.join("；"), now(), user.id, id);
      // 门禁收尾：仍 active 的权限置为 expired
      run("UPDATE door_access SET status='expired',revoked_reason=COALESCE(NULLIF(revoked_reason,''),'活动结束权限收尾') WHERE visit_id=? AND status IN ('active','entered')", id);
      audit(Number(v.stay_id), user, "探访闭环判定", `${v.visitor_name}：${result.join("；")}${ok ? "（闭环正常）" : "（闭环异常待核查）"}`);
      return { closed: true, healthy: ok, message: ok ? "预约闭环正常" : "已闭环但存在异常项（进出不配对/护理未避让），请核查" };
    },
  },

  // 护士长对闭环异常进行人工核销
  "visits.forceClose": {
    roles: ["head_nurse", "admin"],
    run(user, p) {
      const v = q1("SELECT * FROM visits WHERE id=?", num(p, "id"));
      if (!v) throw new Error("探访记录不存在");
      const note = req(p, "note", "人工核销说明");
      run("UPDATE visits SET closed=1,closed_result=?,closed_at=?,closed_by=? WHERE id=?",
        `${String(v.closed_result || "")}；护士长人工核销：${note}`, now(), user.id, Number(v.id));
      run("UPDATE door_access SET status='expired' WHERE visit_id=? AND status IN ('active','entered')", Number(v.id));
      audit(Number(v.stay_id), user, "探访闭环-人工核销", `${v.visitor_name}：${note}`);
      return { message: "已人工核销闭环" };
    },
  },

  // 旧版探访操作（保留：用于未走协同方案的简单批准/消毒/完成/取消）
  "visits.update": {
    roles: ["frontdesk", "head_nurse", "admin"],
    run(user, p) {
      const id = num(p, "id");
      const v = q1("SELECT * FROM visits WHERE id=?", id);
      if (!v) throw new Error("探访记录不存在");
      const action = req(p, "action", "操作");
      if (action === "approve" || action === "reject") {
        run("UPDATE visits SET status=?, approved_by=? WHERE id=?", action === "approve" ? "approved" : "rejected", user.id, id);
      } else if (action === "disinfect") {
        run("UPDATE visits SET disinfected=1, disinfection_note=? WHERE id=?", str(p, "note", "入所前消毒+测温完成"), id);
      } else if (action === "complete") {
        run("UPDATE visits SET status='completed' WHERE id=?", id);
      } else if (action === "cancel") {
        run("UPDATE visits SET status='cancelled' WHERE id=?", id);
      } else {
        throw new Error("未知操作");
      }
      audit(Number(v.stay_id), user, "探访管理", `${v.visitor_name}（${v.visit_time}）：${action}`);
      return { message: "已处理" };
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
      const action = req(p, "action", "操作");
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
      const action = req(p, "action", "操作");
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
