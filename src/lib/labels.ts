// 展示用字典与通用工具
export const ROLE_LABELS: Record<string, string> = {
  admin: "中心管理者",
  head_nurse: "护士长",
  nurse: "护理师",
  pediatrician: "儿科医生",
  nutritionist: "营养师",
  therapist: "产康师",
  matron: "月嫂",
  frontdesk: "前台",
  finance: "财务",
  family: "家属",
};

export const ROLE_HOME: Record<string, string> = {
  admin: "/admin",
  head_nurse: "/headnurse",
  nurse: "/nurse",
  pediatrician: "/doctor",
  nutritionist: "/nutritionist",
  therapist: "/therapist",
  matron: "/nurse",
  frontdesk: "/frontdesk",
  finance: "/finance",
  family: "/family",
};

export const PLAN_TYPES: Record<string, string> = {
  rounds: "护理查房",
  wound: "伤口观察",
  breast: "乳房护理",
  recovery: "产康课程",
  meal: "月子餐",
  baby_bath: "宝宝洗澡抚触",
  night_care: "夜间照护",
};

export const EX_TYPES: Record<string, string> = {
  jaundice: "宝宝黄疸升高",
  breast_blockage: "产妇乳腺堵塞",
  extra_visit: "家属临时增加探访",
  matron_leave: "月嫂请假",
  meal_taboo: "餐食不符合忌口",
  project_delay: "产康项目延期",
  package_upgrade: "套餐升级",
  room_upgrade: "房间升级",
  early_checkout: "提前退所",
  record_dispute: "家属质疑护理记录",
  checkout_dispute: "退所争议",
  visit_gate_block: "探访门禁协同受阻",
  visit_revoke_entered: "撤回授权时访客已在场",
};

export const FEE_TYPES: Record<string, string> = {
  package: "套餐费用",
  upgrade: "升级差价",
  extra: "增项消费",
  deposit: "押金",
  discount: "减免",
  refund: "退款",
};

export const EX_STATUS: Record<string, string> = {
  open: "待处理",
  processing: "处理中",
  resolved: "已解决",
  closed: "已关闭",
};

export const SEVERITY: Record<string, string> = {
  low: "低",
  medium: "中",
  high: "高",
  critical: "紧急",
};

export const TASK_STATUS: Record<string, string> = {
  pending: "待执行",
  done: "已完成",
  delayed: "已延期",
  missed: "已遗漏",
};

export const VISIT_STATUS: Record<string, string> = {
  pending: "待排期",
  proposed: "已出方案",
  scheduled: "已排期/已发门禁",
  approved: "已批准",
  rejected: "已拒绝",
  completed: "已完成",
  cancelled: "已取消",
  no_show: "爽约",
};

export const VISIT_HEALTH: Record<string, string> = {
  unknown: "未核验",
  ok: "健康正常",
  abnormal: "健康异常",
};

export const SOLUTION_KIND: Record<string, string> = {
  normal: "无冲突",
  queue: "排队放行",
  split: "拆分时段",
  reschedule: "改约",
};

export const SOLUTION_STATUS: Record<string, string> = {
  proposed: "待前台确认",
  confirmed: "已确认生效",
  superseded: "已被新方案替代",
};

export const PASS_STATUS: Record<string, string> = {
  active: "门禁有效",
  inside: "在房内",
  used: "已出场",
  revoked: "已失效(撤回)",
  expired: "已过期",
};

export const AUTH_STATUS: Record<string, string> = {
  pending: "待产妇确认",
  active: "生效中",
  revoked: "已撤回",
  revoking: "在场·待护士长协调",
};

export const AVOID_STATUS: Record<string, string> = {
  planned: "待避让确认",
  done: "避让已确认",
};

export function money(n: unknown): string {
  const v = Number(n || 0);
  return "¥" + v.toLocaleString("zh-CN", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

export function dt(s: unknown): string {
  if (!s) return "-";
  return String(s).slice(0, 16);
}

export function badgeClass(status: string): string {
  switch (status) {
    case "open": case "pending": case "issue": case "new": case "no_show": case "revoking": return "badge red";
    case "processing": case "planned": case "proposed": case "scheduled": case "following": case "draft": return "badge amber";
    case "resolved": case "done": case "confirmed": case "approved": case "delivered": case "responded": case "converted": case "active": return "badge green";
    case "closed": case "cancelled": case "void": case "rejected": case "lost": case "revoked": case "expired": return "badge gray";
    case "completed": case "in_stay": case "inside": return "badge blue";
    case "checked_out": return "badge gray";
    default: return "badge gray";
  }
}

export function severityClass(sev: string): string {
  switch (sev) {
    case "critical": return "badge red";
    case "high": return "badge red";
    case "medium": return "badge amber";
    default: return "badge gray";
  }
}
