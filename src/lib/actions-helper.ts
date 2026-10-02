// 无副作用的业务基础件：审计日志、异常工单创建、员工站内通知。
// 独立成模块以避免 actions.ts ↔ visits.ts 循环依赖。
import { q, run } from "./db";
import type { SessionUser } from "./auth";

export function audit(stayId: number | null, user: SessionUser | null, action: string, detail: string) {
  run("INSERT INTO audit_logs(stay_id,actor_id,actor_name,action,detail) VALUES(?,?,?,?,?)",
    stayId, user ? user.id : null, user ? user.name : "系统", action, detail);
}

// 异常类型 → 默认责任角色 / 是否同步护士长
export const EX_ROUTE: Record<string, { role: string; sync: boolean }> = {
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
  visit_gate_block: { role: "frontdesk", sync: true },
  visit_revoke_entered: { role: "head_nurse", sync: true },
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

// 站内消息通知指定角色/全员（前台、护士长据此协同）
export function notifyStaff(stayId: number, audience: string, from: SessionUser | null, content: string) {
  run("INSERT INTO messages(stay_id,from_user_id,from_name,from_role,audience,content) VALUES(?,?,?,?,?,?)",
    stayId, from ? from.id : null, from ? from.name : "系统", from ? from.role : "system", audience, content);
}

export function staffName(userId: number | null): string {
  if (!userId) return "系统";
  const u = q("SELECT name FROM users WHERE id=?", userId)[0];
  return u ? String(u.name) : "系统";
}
