// 探访协同引擎：冲突检测（授权/容量/护理避让/婴儿护理）→ 方案生成（排队/拆分/改约）
// → 前台确认事务（门禁有效期 + 访客名单 + 护理避让原子更新）
import crypto from "node:crypto";
import { q, q1, run, now, addTime, getDb } from "./db";
import type { SessionUser } from "./auth";
import { audit, createException, notifyStaff } from "./actions-helper";

type Row = Record<string, unknown>;

// 探访允许时段 09:00–20:00；30 分钟为排期步长
const DAY_START_H = 9;
const DAY_END_H = 20;
const STEP_MIN = 30;

export type Block = { code: string; label: string };

export function activeAuth(stayId: number, visitorName: string): Row | undefined {
  return q1(
    `SELECT * FROM visit_authorizations
     WHERE stay_id=? AND visitor_name=? AND status='active'
     ORDER BY (auth_type='temporary') DESC, id DESC LIMIT 1`,
    stayId, visitorName
  );
}

// 该探访申请能否直接发放门禁：临时授权未确认 / 健康异常 / 消毒未完成 / 无授权 均为阻断项
export function visitBlockers(v: Row): Block[] {
  const blocks: Block[] = [];
  if (!Number(v.authorized)) blocks.push({ code: "auth", label: "无有效产妇授权" });
  if (Number(v.is_temp) && String(v.temp_auth_status) !== "active") {
    blocks.push({ code: "temp_auth", label: "临时授权未经产妇确认" });
  }
  if (String(v.health_status) !== "ok") {
    blocks.push({ code: "health", label: String(v.health_status) === "abnormal" ? "探访人健康异常" : "探访人健康未核验" });
  }
  if (!Number(v.disinfected)) blocks.push({ code: "disinfection", label: "入所消毒未完成" });
  return blocks;
}

type Interval = { start: string; end: string };

function toMin(dt: string): number {
  const d = new Date(dt.replace(" ", "T") + (dt.length === 16 ? ":00" : ""));
  return Math.round(d.getTime() / 60000);
}
function overlap(a: Interval, b: Interval): boolean {
  return toMin(a.start) < toMin(b.end) && toMin(b.start) < toMin(a.end);
}

// 一组区间内的最大同时重叠数（同一时刻在房人数峰值）
function peakConcurrent(intervals: Interval[]): number {
  const pts: { t: number; d: number }[] = [];
  for (const iv of intervals) {
    pts.push({ t: toMin(iv.start), d: 1 });
    pts.push({ t: toMin(iv.end), d: -1 });
  }
  pts.sort((a, b) => (a.t - b.t) || (a.d - b.d)); // 同时刻先离场后入场
  let cur = 0, peak = 0;
  for (const p of pts) { cur += p.d; if (cur > peak) peak = cur; }
  return peak;
}

type CareSlot = Interval & { label: string; kind: string; taskId: number | null; soft: boolean };

// 护理避让时段来源：护理任务（查房/伤口/乳房/宝宝洗澡/产康）、产康排班、宝宝托管/洗澡
export function careSlots(stayId: number, date: string): CareSlot[] {
  const slots: CareSlot[] = [];
  const tasks = q(
    `SELECT id,type,title,scheduled_at FROM care_tasks
     WHERE stay_id=? AND substr(scheduled_at,1,10)=? AND status!='cancelled'`, stayId, date);
  for (const t of tasks) {
    const start = String(t.scheduled_at);
    if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(start)) continue;
    slots.push({
      start, end: addTime(start, 1), taskId: Number(t.id), kind: String(t.type),
      label: `护理任务：${String(t.title)}`,
      soft: false,
    });
  }
  const schedules = q(
    `SELECT id,project,scheduled_at FROM therapist_schedules
     WHERE stay_id=? AND substr(scheduled_at,1,10)=? AND status='scheduled'`, stayId, date);
  for (const s of schedules) {
    const start = String(s.scheduled_at);
    slots.push({ start, end: addTime(start, 1), taskId: null, kind: "therapist", label: `产康：${String(s.project)}`, soft: false });
  }
  const hostings = q(
    `SELECT id,type,start_time,end_time FROM hosting_logs
     WHERE stay_id=? AND substr(start_time,1,10)=?`, stayId, date);
  for (const h of hostings) {
    const start = String(h.start_time);
    const end = h.end_time ? String(h.end_time) : addTime(start, 1);
    slots.push({ start, end, taskId: null, kind: "hosting", label: `婴儿护理安排：${String(h.type)}`, soft: true });
  }
  return slots;
}

function dayBounds(date: string): { open: string; close: string } {
  return { open: `${date} ${String(DAY_START_H).padStart(2, "0")}:00`, close: `${date} ${String(DAY_END_H).padStart(2, "0")}:00` };
}

function addDaysStr(date: string, n: number): string {
  const d = new Date(date + "T00:00:00");
  d.setDate(d.getDate() + n);
  const p = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// 在指定日期内枚举可行窗口（30 分钟步长），满足容量并尽量避开护理避让时段
function findSlot(
  stayId: number, date: string, hours: number,
  occupied: Interval[], capacity: number, slots: CareSlot[],
  preferStart: string
): { start: string; end: string; careConflicts: CareSlot[] } | null {
  const { open, close } = dayBounds(date);
  const endMax = toMin(close);
  const durMin = hours * 60;
  let cursor = new Date(open.replace(" ", "T") + ":00");
  const candidates: { start: string; end: string; careConflicts: CareSlot[]; score: number }[] = [];
  while (toMin(fmt(cursor)) + durMin <= endMax) {
    const start = fmt(cursor);
    const end = addTime(start, hours);
    const candidate = { start, end };
    if (peakConcurrent([...occupied, candidate]) <= capacity) {
      const conflicts = slots.filter((s) => !s.soft ? overlap(s, candidate) : false);
      const softConflicts = slots.filter((s) => s.soft && overlap(s, candidate)).length;
      // 探访需求优先（护士查房为其避让）：以贴近申请时间为主，仅在等距时用护理冲突做次级裁决
      candidates.push({
        start, end, careConflicts: conflicts,
        score: Math.abs(toMin(start) - toMin(preferStart)) / 60
          + conflicts.length * 0.01 + softConflicts * 0.005,
      });
    }
    cursor = new Date(cursor.getTime() + STEP_MIN * 60000);
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => a.score - b.score);
  return candidates[0];
}

function fmt(d: Date): string {
  const p = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

type PlannedItem = {
  visitId: number; visitor: string; start: string; end: string; kind: string;
  queueNo: number; priority: number; blockers: Block[]; careConflicts: string[];
};

// 生成（或重建）某房间某日的探访协同方案，持久化为 proposed，等待前台确认
export function planVisits(stayId: number, date: string, user: SessionUser): {
  solutionId: number; kind: string; reason: string; items: PlannedItem[];
} {
  const stay = q1(`SELECT s.*, r.number, r.capacity FROM stays s JOIN rooms r ON r.id=s.room_id WHERE s.id=?`, stayId);
  if (!stay) throw new Error("订单不存在");
  const capacity = Math.max(1, Number(stay.capacity) || 2);

  // 已有待确认方案作废（未确认不产生门禁，可安全重排）
  const old = q("SELECT id FROM visit_solutions WHERE stay_id=? AND visit_date=? AND status='proposed'", stayId, date);
  for (const o of old) {
    run("UPDATE visits SET plan_id=NULL, status='pending' WHERE plan_id=? AND status='scheduled'", Number(o.id));
    run("DELETE FROM visit_solution_items WHERE solution_id=?", Number(o.id));
    run("UPDATE visit_solutions SET status='superseded' WHERE id=?", Number(o.id));
  }

  // 候选 = 待审核 / 旧版已批准 / 挂在待确认方案上的排期；固定 = 已确认方案占用容量的探访
  const candidates = q(
    `SELECT * FROM visits WHERE stay_id=? AND visit_date=?
       AND (status IN ('pending','approved')
            OR (status='scheduled' AND plan_id IN (SELECT id FROM visit_solutions WHERE status='proposed')))
     ORDER BY id`, stayId, date);
  const fixed = q(
    `SELECT id,visitor_name,visit_time AS start,end_time AS end FROM visits
     WHERE stay_id=? AND visit_date=? AND status='scheduled'
       AND (plan_id IS NULL OR plan_id IN (SELECT id FROM visit_solutions WHERE status='confirmed'))`, stayId, date);

  if (!candidates.length) throw new Error("该日期暂无可排期的探访申请");

  const occupied: Interval[] = fixed.map((f) => ({ start: String(f.start), end: String(f.end || addTime(String(f.start), 2)) }));
  const slots = careSlots(stayId, date);
  const slotsNext = careSlots(stayId, addDaysStr(date, 1));

  const ranked = [...candidates].sort((a, b) => {
    if (Number(a.priority) !== Number(b.priority)) return Number(a.priority) - Number(b.priority);
    if (Number(b.authorized) !== Number(a.authorized)) return Number(b.authorized) - Number(a.authorized);
    if (Number(a.is_temp) !== Number(b.is_temp)) return Number(a.is_temp) - Number(b.is_temp);
    return Number(a.id) - Number(b.id);
  });

  const items: PlannedItem[] = [];
  let anySplit = false, anyReschedule = false;
  for (const v of ranked) {
    const hours = Math.max(1, Number(v.hours) || 2);
    const reqStart = String(v.visit_time);
    let slot = findSlot(stayId, date, hours, occupied, capacity, slots, reqStart);
    let kind = "queue";
    if (!slot) {
      // 当日容量/避让无法满足 → 改约次日
      const next = addDaysStr(date, 1);
      slot = findSlot(stayId, next, hours, [], capacity, slotsNext, `${next} 09:00`);
      if (!slot) throw new Error(`次日仍无容量接待 ${String(v.visitor_name)}，请人工改约`);
      kind = "reschedule";
      anyReschedule = true;
    } else if (slot.start !== reqStart.slice(0, 16)) {
      kind = "split";
      anySplit = true;
    }
    occupied.push({ start: slot.start, end: slot.end });
    items.push({
      visitId: Number(v.id), visitor: String(v.visitor_name),
      start: slot.start, end: slot.end, kind, queueNo: 0, priority: Number(v.priority) || 5,
      blockers: visitBlockers(v),
      careConflicts: slot.careConflicts.map((c) => c.label),
    });
  }

  // 排队序号：按最终窗口并发分组
  const byStart = new Map<string, number>();
  for (const it of items) {
    const n = (byStart.get(it.start) || 0) + 1;
    byStart.set(it.start, n);
    it.queueNo = n;
  }

  const overallKind = anyReschedule ? "reschedule" : anySplit ? "split" : items.length > 1 ? "queue" : "normal";
  const winStart = items.map((i) => i.start).sort()[0];
  const winEnd = items.map((i) => i.end).sort().reverse()[0];
  const reasonMap: Record<string, string> = {
    queue: "同时段人数受房间容量限制，按产妇授权关系、优先级排队放行",
    split: "受房间容量与护理避让时段限制，拆分至不同时段",
    reschedule: "当日容量/护理安排无法满足，部分家属改约次日",
    normal: "无冲突，按原申请时段安排",
  };

  const solutionId = run(
    `INSERT INTO visit_solutions(stay_id,room_id,visit_date,window_start,window_end,kind,status,reason,created_by,created_by_name)
     VALUES(?,?,?,?,?,?, 'proposed', ?,?,?)`,
    stayId, Number(stay.room_id), date, winStart, winEnd, overallKind,
    reasonMap[overallKind], user.id, user.name
  );
  items.forEach((it, seq) => {
    run(`INSERT INTO visit_solution_items(solution_id,visit_id,seq,assigned_start,assigned_end,queue_no,note)
         VALUES(?,?,?,?,?,?,?)`,
      solutionId, it.visitId, seq + 1, it.start, it.end, it.queueNo,
      [it.kind === "split" ? "拆分段" : it.kind === "reschedule" ? "改约段" : "排队段",
      `护理避让${it.careConflicts.length}项`].join("，"));
  });
  audit(stayId, user, "探访方案生成",
    `${date} 方案#${solutionId}（${reasonMap[overallKind]}）：${items.map((i) => i.visitor).join("、")}`);
  return { solutionId, kind: overallKind, reason: reasonMap[overallKind], items };
}

// 前台确认：门禁有效期 + 访客名单 + 护理避让 原子提交；任一阻断则整体回滚、保留原预约
export function confirmPlan(solutionId: number, user: SessionUser): {
  passCount: number; avoidCount: number; txnToken: string;
  passes: { visitor: string; code: string; visitId: number; from: string; to: string }[];
  avoidanceIds: number[];
} {
  const sol = q1("SELECT * FROM visit_solutions WHERE id=?", solutionId);
  if (!sol) throw new Error("方案不存在");
  if (String(sol.status) !== "proposed") throw new Error("该方案已确认或已作废，请勿重复操作");
  const stayId = Number(sol.stay_id);
  const items = q("SELECT * FROM visit_solution_items WHERE solution_id=? ORDER BY seq", solutionId);
  const stay = q1(`SELECT s.*, r.number, r.capacity FROM stays s JOIN rooms r ON r.id=s.room_id WHERE s.id=?`, stayId)!;
  const capacity = Math.max(1, Number(stay.capacity) || 2);

  // ---- 提交前校验（全部通过才开事务，保证原预约不被破坏）----
  const planned: { item: Row; v: Row }[] = [];
  for (const it of items) {
    const v = q1("SELECT * FROM visits WHERE id=?", Number(it.visit_id));
    if (!v) throw new Error(`探访申请 #${it.visit_id} 不存在，方案需重新生成`);
    if (!["pending", "approved", "scheduled"].includes(String(v.status))) {
      throw new Error(`${String(v.visitor_name)} 的申请状态为「${String(v.status)}」，请重新生成方案`);
    }
    const blocks = visitBlockers(v);
    if (blocks.length) {
      throw new Error(`暂不能为「${String(v.visitor_name)}」分配门禁：${blocks.map((b) => b.label).join("、")}。请先处理后再确认（原预约已保留）`);
    }
    planned.push({ item: it, v });
  }
  // 容量复核（精确事件扫描）：既有已确认探访 + 本次全部排期，全天同时在房峰值不得超过房间容量
  const fixed: Interval[] = q(
    `SELECT visit_time AS start,end_time AS end FROM visits
     WHERE stay_id=? AND status='scheduled'
       AND id NOT IN (${items.map(() => "?").join(",") || "SELECT 0"})
       AND substr(visit_time,1,10)=?`, stayId,
    ...items.map((i) => Number(i.visit_id)), String(sol.visit_date))
    .map((f) => ({ start: String(f.start), end: String(f.end) }));
  const plannedIntervals: Interval[] = planned.map(({ item }) => ({
    start: String(item.assigned_start), end: String(item.assigned_end),
  }));
  const peak = peakConcurrent([...fixed, ...plannedIntervals]);
  if (peak > capacity) {
    throw new Error(`容量复核失败：同时在房峰值 ${peak} 人超过房间容量 ${capacity}，请重新生成方案（原预约已保留）`);
  }

  const db = getDb();
  const token = crypto.randomBytes(8).toString("hex");
  const passes: { visitor: string; code: string; visitId: number; from: string; to: string }[] = [];
  const avoidanceIds: number[] = [];
  db.exec("BEGIN");
  try {
    const roomNo = String(stay.number);
    let seq = q1("SELECT COUNT(*) AS c FROM access_passes WHERE substr(valid_from,1,10)=?", String(sol.visit_date))?.c || 0;
    const avoidKeys = new Set<string>();
    for (const { item, v } of planned) {
      const start = String(item.assigned_start);
      const end = String(item.assigned_end);
      run("UPDATE visits SET visit_time=?, end_time=?, visit_date=?, status='scheduled', plan_id=?, solution_kind=?, queue_no=?, approved_by=?, priority=COALESCE(priority,5) WHERE id=?",
        start, end, start.slice(0, 10), solutionId, String(sol.kind), Number(item.queue_no), user.id, Number(v.id));
      seq = Number(seq) + 1;
      const code = `P${roomNo}-${start.slice(5, 10).replace("-", "")}-${String(seq).padStart(2, "0")}${crypto.randomBytes(2).toString("hex").toUpperCase()}`;
      run(`INSERT INTO access_passes(stay_id,visit_id,visitor_name,pass_code,status,valid_from,valid_to,issued_by,issued_by_name,solution_id)
           VALUES(?,?,?,?, 'active', ?,?,?,?,?)`,
        stayId, Number(v.id), String(v.visitor_name), code, start, end, user.id, user.name, solutionId);
      passes.push({ visitor: String(v.visitor_name), code, visitId: Number(v.id), from: start, to: end });
      // 护理避让：窗口内非紧急护理任务 / 产康 / 婴儿护理安排
      for (const s of careSlots(stayId, start.slice(0, 10))) {
        if (!overlap(s, { start, end })) continue;
        const key = `${s.kind}:${s.taskId || s.label}:${s.start}`;
        if (avoidKeys.has(key)) continue;
        avoidKeys.add(key);
        const avoidId = run(`INSERT INTO care_avoidances(stay_id,solution_id,visit_id,title,reason_type,window_start,window_end,status,care_task_id)
             VALUES(?,?,?,?,?,?,?, 'planned',?)`,
          stayId, solutionId, Number(v.id),
          `探访避让：${s.label}（${start.slice(11, 16)}-${end.slice(11, 16)} 暂缓入房，紧急护理除外）`,
          s.kind, start, end, s.taskId);
        avoidanceIds.push(avoidId);
      }
    }
    run("UPDATE visit_solutions SET status='confirmed', confirmed_by=?, confirmed_at=?, txn_token=? WHERE id=?",
      user.id, now(), token, solutionId);
    audit(stayId, user, "探访方案确认",
      `方案#${solutionId} 原子生效：门禁${planned.length}张、护理避让${avoidKeys.size}项，事务号 ${token}`);
    db.exec("COMMIT");
    return { passCount: planned.length, avoidCount: avoidKeys.size, passes, avoidanceIds, txnToken: token };
  } catch (e) {
    db.exec("ROLLBACK");
    const msg = e instanceof Error ? e.message : "未知错误";
    // 回滚后保留原预约，转人工处理
    createException(stayId, "visit_gate_block", "探访方案确认失败，已转人工",
      `方案#${solutionId} 确认过程中环节失败：${msg}。门禁/名单/护理避让均未变更，原预约保留。`, "high", user);
    throw new Error(`确认失败，已整体回滚并保留原预约，提示人工处理：${msg}`);
  }
}
