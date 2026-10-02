// 冒烟测试：登录各角色 → 访问工作台 → 执行关键业务动作
// 用法：先启动服务（npm start 或 npm run dev），再执行 npm run smoke
const BASE = process.env.SMOKE_BASE || "http://localhost:3000";

let passed = 0, failed = 0;
function check(name, cond, extra = "") {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name} ${extra}`); }
}

async function login(username, password) {
  const res = await fetch(`${BASE}/api/auth`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "login", username, password }),
  });
  const body = await res.json();
  const cookie = (res.headers.get("set-cookie") || "").split(";")[0];
  return { ok: body.ok, cookie, user: body.user };
}

async function get(path, cookie) {
  const res = await fetch(`${BASE}${path}`, { headers: { Cookie: cookie }, redirect: "manual" });
  const text = await res.text();
  return { status: res.status, text, location: res.headers.get("location") || "" };
}

async function doAction(cookie, payload) {
  const res = await fetch(`${BASE}/api/do`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify(payload),
  });
  return res.json();
}

console.log(`smoke against ${BASE}`);

// 1. 登录页可访问
{
  const r = await get("/login", "");
  check("登录页可访问", r.status === 200 && r.text.includes("悦安月子中心"));
}

// 2. 错误密码被拒绝
{
  const r = await login("admin", "wrong-password");
  check("错误密码拒绝登录", r.ok === false);
}

// 3. 各角色登录并进入工作台
const roles = [
  ["admin", "admin123", "/admin", "房间实时看板"],
  ["headnurse", "head123", "/headnurse", "异常工单中心"],
  ["nurse1", "nurse123", "/nurse", "护理任务"],
  ["doctor", "doc123", "/doctor", "黄疸预警"],
  ["nutrition", "nut123", "/nutritionist", "忌口"],
  ["therapist", "the123", "/therapist", "产康排班"],
  ["matron", "mat123", "/nurse", "月嫂工作台"],
  ["front", "front123", "/frontdesk", "入住登记"],
  ["finance", "fin123", "/finance", "结算单"],
  ["family1", "family123", "/family", "护理摘要"],
];
const cookies = {};
for (const [u, p, home, marker] of roles) {
  const r = await login(u, p);
  check(`${u} 登录`, r.ok === true);
  if (!r.ok) continue;
  cookies[u] = r.cookie;
  const page = await get(home, r.cookie);
  check(`${u} 工作台 ${home} 含「${marker}」`, page.status === 200 && page.text.includes(marker));
}

// 4. 未登录访问受保护页 → 重定向登录
{
  const r = await get("/admin", "");
  check("未登录访问 /admin 重定向", r.status === 307 && r.location.includes("/login"));
}

// 5. 越权访问：家属访问管理看板 → 重定向家属端
{
  const r = await get("/admin", cookies["family1"]);
  check("家属访问 /admin 被重定向", r.status === 307 && r.location.includes("/family"));
}

// 6. 房间360视图（管理员）
{
  const r = await get("/stays/1", cookies["admin"]);
  check("房间360视图含产妇档案与异常工单", r.status === 200 && r.text.includes("产妇与宝宝档案") && r.text.includes("异常工单"));
}

// 7. 护理师完成一项任务
{
  const list = await get("/nurse", cookies["nurse1"]);
  const m = list.text.match(/宝宝洗澡抚触/);
  check("护理师任务列表含待执行任务", !!m);
  // 找一个 pending 任务 id：直接创建再完成
  const c = await doAction(cookies["nurse1"], { action: "tasks.create", stayId: 1, type: "rounds", title: "冒烟测试任务", scheduledAt: "2026-09-25 21:00" });
  check("护理师创建任务", c.ok === true);
  const done = await doAction(cookies["nurse1"], { action: "tasks.update", id: c.id, status: "done", record: "冒烟测试执行记录" });
  check("护理师完成任务并留记录", done.ok === true);
}

// 8. 营养师配餐命中忌口 → 自动建异常
{
  const r = await doAction(cookies["nutrition"], { action: "meals.create", stayId: 1, mealDate: "2026-09-26", mealType: "午餐", menu: "麻辣香锅、虾仁炒饭" });
  check("配餐命中忌口返回警告", r.ok === true && Array.isArray(r.tabooHits) && r.tabooHits.length > 0, JSON.stringify(r));
}

// 9. 家属预约临时探访 → 产生临时探访异常
{
  const r = await doAction(cookies["family1"], { action: "visits.create", stayId: 1, visitorName: "张强", relation: "丈夫", visitTime: "2026-09-26 18:00", hours: 2, isTemp: true });
  check("家属临时探访预约", r.ok === true);
  const admin = await get("/stays/1", cookies["admin"]);
  check("房间360出现临时探访异常", admin.text.includes("家属临时增加探访"));
}

// 10. 家属质疑护理记录
{
  const rec = await doAction(cookies["family1"], { action: "records.dispute", id: 1, reason: "冒烟测试：质疑记录" });
  check("家属质疑护理记录", rec.ok === true);
}

// 11. 家属越权访问他人房间
{
  const r = await doAction(cookies["family1"], { action: "visits.create", stayId: 2, visitorName: "越权测试", visitTime: "2026-09-26 20:00" });
  check("家属访问他人房间被拒绝", r.ok === false);
}

// 12. 前台登记新入住（含家属账号）——动态选取空房，可重复运行
let smokeStayId = null;
let smokeRoomId = null;
{
  const roomsRes = await fetch(`${BASE}/api/rooms`, { headers: { Cookie: cookies["front"] } });
  const roomsBody = await roomsRes.json();
  const vacant = (roomsBody.rooms || []).find((r) => r.status === "vacant");
  check("获取空房列表", !!vacant);
  if (vacant) {
    smokeRoomId = vacant.id;
    const r = await doAction(cookies["front"], {
      action: "stays.create", roomId: vacant.id, packageId: 1, motherName: "冒烟测试产妇", motherPhone: "13900000000",
      checkInDate: "2026-09-25", deliveryMethod: "顺产", postpartumDays: 3, feedingMethod: "母乳喂养",
      mealTaboos: "忌辛辣", babyName: "测测", babyWeight: 3.2, deposit: 5000,
      familyUsername: "smokefam", familyPassword: "smoke123", familyName: "冒烟家属", familyRelation: "丈夫",
    });
    check("前台入住登记", r.ok === true, JSON.stringify(r));
    if (r.ok) {
      smokeStayId = r.id;
      const fam = await login("smokefam", "smoke123");
      check("新家属账号可登录", fam.ok === true);
      const page = await get("/family", fam.cookie);
      check("新家属端显示入住信息", page.status === 200 && page.text.includes("冒烟测试产妇"));
    }
  }
}

// 13. 财务登记费用并走完整出所结算流程
if (smokeStayId) {
  const stays = await get("/finance", cookies["finance"]);
  check("财务工作台可访问", stays.status === 200);
  const fee = await doAction(cookies["finance"], { action: "fees.create", stayId: smokeStayId, type: "extra", direction: "charge", amount: 100, description: "冒烟测试增项" });
  check("财务登记增项费用", fee.ok === true);
  const co = await doAction(cookies["finance"], { action: "stays.checkout", stayId: smokeStayId, reason: "冒烟测试提前退所" });
  check("办理提前退所", co.ok === true, JSON.stringify(co));
  const st = await doAction(cookies["finance"], { action: "settlements.confirm", stayId: smokeStayId });
  check("确认结算", st.ok === true, JSON.stringify(st));
  // 清理：房间恢复空房，保证冒烟可重复运行
  await doAction(cookies["front"], { action: "rooms.update", id: smokeRoomId, status: "vacant" });
}

// 14. 家属反馈 → 护士长回复并标记影响排班
{
  const fb = await doAction(cookies["family1"], { action: "feedbacks.create", stayId: 1, rating: 3, content: "冒烟测试反馈" });
  check("家属提交反馈", fb.ok === true);
  const rp = await doAction(cookies["headnurse"], { action: "feedbacks.respond", id: fb.id, response: "冒烟测试回复", affectScheduling: true });
  check("护士长回复反馈并标记影响排班", rp.ok === true);
}

// 15. 管理员看板能看到费用变化与异常
{
  const r = await get("/admin", cookies["admin"]);
  check("管理看板含高敏感客诉区", r.status === 200 && r.text.includes("高敏感客诉"));
}

// 15b. 子操作字段 op 不再与信封 action 冲突（修复历史隐患：受理/延期等曾被覆盖）
{
  const r = await doAction(cookies["headnurse"], { action: "exceptions.update", id: 3, op: "accept", note: "护士长受理核查（冒烟）" });
  check("护士长凭 op 受理异常工单", r.ok === true && /已更新/.test(r.message || ""), JSON.stringify(r));
}

// ============================================================================
// 16. 探访冲突 / 授权 / 门禁 / 护理避让 协同（本需求新增，全部在自建订单上，可重复运行）
// ============================================================================
const todayStr = new Date().toISOString().slice(0, 10);
const runTag = Date.now().toString(36);
const usedRoomIds = new Set();
const releaseList = [];
// 下一个半点（入场可落在 30 分钟提前宽限内），不晚于 19:00
function nextSlot() {
  const d = new Date();
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() < 30 ? 30 : 0);
  if (d.getTime() <= Date.now()) d.setHours(d.getHours() + 1);
  if (d.getHours() >= 19) d.setHours(18, 30, 0, 0);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
async function bookStay(tag) {
  const roomsBody = await (await fetch(`${BASE}/api/rooms`, { headers: { Cookie: cookies["front"] } })).json();
  const vacant = (roomsBody.rooms || []).find((r) => r.status === "vacant" && !usedRoomIds.has(r.id));
  if (!vacant) return null;
  usedRoomIds.add(vacant.id);
  const username = `v${runTag}${tag}`;
  const ci = await doAction(cookies["front"], {
    action: "stays.create", roomId: vacant.id, packageId: 1, motherName: `协同测试${tag}`, motherPhone: `139${String(10000000 + usedRoomIds.size * 111)}`,
    checkInDate: todayStr, deliveryMethod: "顺产", postpartumDays: 2, feedingMethod: "母乳喂养", babyName: "测宝",
    familyUsername: username, familyPassword: "visit123", familyName: "协同家属", familyRelation: "丈夫",
  });
  const lf = await login(username, "visit123");
  cookies[username] = lf.cookie;
  const ctx = { stayId: ci.id, roomId: vacant.id, fam: lf.cookie, username };
  releaseList.push(ctx);
  return ctx;
}
// 一次性备好一场探访：授权→预约→健康→消毒（可控开关），返回 { id, authId }
async function provision(ctx, name, time, opts = {}) {
  const { hours = 1, isTemp = false, grantAuth = true, confirmAuth = true, health = "ok", disinfect = true, relation = "亲属" } = opts;
  let authId = null;
  if (grantAuth) {
    const g = await doAction(ctx.fam, { action: "auths.grant", stayId: ctx.stayId, visitorName: name, relation, authType: "temporary" });
    authId = g.id || null;
    if (authId && confirmAuth) await doAction(ctx.fam, { action: "auths.confirm", id: authId });
  }
  const v = await doAction(ctx.fam, { action: "visits.create", stayId: ctx.stayId, visitorName: name, relation, visitTime: time, hours, isTemp });
  const id = v.id;
  if (health) await doAction(cookies["front"], { action: "visits.health", id, result: health, note: health === "abnormal" ? "发热37.9℃" : "测温正常" });
  if (disinfect) await doAction(cookies["front"], { action: "visits.disinfect", id });
  return { id, authId };
}

// 16. 阻断项 + 原子确认 + 容量拆分 + 未入场撤回
{
  const ctx = await bookStay("A");
  check("协同测试A取到独立房间", !!ctx);
  if (ctx) {
    const slot = nextSlot();
    await doAction(cookies["nurse1"], { action: "tasks.create", stayId: ctx.stayId, type: "baby_bath", title: "宝宝洗澡（避让测试）", scheduledAt: slot });
    const a1 = await provision(ctx, "周已", slot, { isTemp: false });
    const a2 = await provision(ctx, "吴待", slot, { isTemp: true, grantAuth: false, health: null, disinfect: false });

    const plan = await doAction(cookies["front"], { action: "visits.plan", stayId: ctx.stayId, date: todayStr });
    check("前台生成探访协同方案", plan.ok === true && Number(plan.solutionId) > 0, JSON.stringify(plan));
    const item2 = (plan.items || []).find((i) => i.visitId === a2.id);
    check("方案条目返回授权/临时/健康/消毒阻断项",
      !!item2 && ["auth", "temp_auth", "health", "disinfection"].every((b) => item2.blockers.includes(b)), JSON.stringify(item2));

    const blocked = await doAction(cookies["front"], { action: "visits.plan.confirm", solutionId: plan.solutionId });
    check("前置项不齐时确认被原子拦截并保留原预约", blocked.ok === false && /暂不能为/.test(blocked.error || ""), JSON.stringify(blocked));
    const frontConfirmAuth = await doAction(cookies["front"], { action: "auths.confirm", id: a2.authId || 999999 });
    check("前台不能代产妇确认授权", frontConfirmAuth.ok === false);

    // 补齐吴待：授予+确认授权（同步激活其 pending 申请）、健康、消毒
    const g2 = await doAction(ctx.fam, { action: "auths.grant", stayId: ctx.stayId, visitorName: "吴待", relation: "亲属", authType: "temporary" });
    await doAction(ctx.fam, { action: "auths.confirm", id: g2.id });
    await doAction(cookies["front"], { action: "visits.health", id: a2.id, result: "ok", note: "测温正常" });
    await doAction(cookies["front"], { action: "visits.disinfect", id: a2.id });

    const plan2 = await doAction(cookies["front"], { action: "visits.plan", stayId: ctx.stayId, date: todayStr });
    check("前置齐备后方案无阻断", (plan2.items || []).every((i) => i.blockers.length === 0), JSON.stringify(plan2.items));
    const cf = await doAction(cookies["front"], { action: "visits.plan.confirm", solutionId: plan2.solutionId });
    check("方案原子确认并发2张门禁", cf.ok === true && cf.passes.length === 2, JSON.stringify(cf).slice(0, 200));
    check("确认联动护理避让", cf.ok === true && Number(cf.avoidCount) >= 1, `avoid=${cf.avoidCount}`);
    check("确认返回原子事务号", cf.ok === true && String(cf.txnToken || "").length >= 10);

    // 容量拆分：第三个全齐备访客同时段 → 必须拆到别的时段（峰值≤容量2）
    const a3 = await provision(ctx, "郑三", slot, {});
    const plan3 = await doAction(cookies["front"], { action: "visits.plan", stayId: ctx.stayId, date: todayStr });
    const it3 = (plan3.items || []).find((i) => i.visitId === a3.id);
    const fixedIv = [{ s: slot, e: plan2.items[0].end }, { s: slot, e: plan2.items[1].end }];
    const allIv = [...fixedIv, ...(plan3.items || []).map((i) => ({ s: i.start, e: i.end }))];
    const min = (x) => new Date(x.replace(" ", "T") + ":00").getTime() / 60000;
    let peak = 0;
    for (const a of allIv) peak = Math.max(peak, allIv.filter((b) => min(a.s) >= min(b.s) && min(a.s) < min(b.e)).length);
    check("容量受限时第三人拆到不同时段(split)", !!it3 && it3.start !== slot && plan3.kind === "split", JSON.stringify(it3));
    check("拆分后同时在房峰值≤容量2", peak <= 2, `peak=${peak}`);
    const cf3 = await doAction(cookies["front"], { action: "visits.plan.confirm", solutionId: plan3.solutionId });
    check("拆分方案确认成功", cf3.ok === true && cf3.passes.length === 1, JSON.stringify(cf3).slice(0, 160));

    // 无效门禁码
    const badCode = await doAction(cookies["front"], { action: "gates.swipe", passCode: "P-NOPE-99", direction: "in" });
    check("无效门禁码拒绝入场", badCode.ok === false);

    // 未入场撤回 → 立即失效
    const revoke = await doAction(ctx.fam, { action: "auths.revoke", id: a1.authId, reason: "产妇休息暂停探访" });
    check("撤回未入场授权立即失效门禁", revoke.ok === true && Number(revoke.revokedPasses) >= 1, JSON.stringify(revoke));
    const famPage = await get("/family", ctx.fam);
    check("家属端门禁显示已失效(撤回)", famPage.text.includes("已失效(撤回)"));
    const fdPage = await get("/frontdesk", cookies["front"]);
    check("前台工作台含门禁台", fdPage.status === 200 && fdPage.text.includes("门禁台"));
  }
}

// 17. 爽约降级 → 前台凭产妇书面确认覆盖留痕
{
  const ctx = await bookStay("B");
  check("协同测试B取到独立房间", !!ctx);
  if (ctx) {
    const slot = nextSlot();
    const b1 = await provision(ctx, "钱爽", slot, {});
    const plan = await doAction(cookies["front"], { action: "visits.plan", stayId: ctx.stayId, date: todayStr });
    const cf = await doAction(cookies["front"], { action: "visits.plan.confirm", solutionId: plan.solutionId });
    check("B方案确认发门禁", cf.ok === true);
    const ns = await doAction(cookies["front"], { action: "visits.noshow", id: b1.id });
    check("未到场登记爽约", ns.ok === true, JSON.stringify(ns));
    // 同名再约一场（授权仍有效）
    const v2 = await doAction(ctx.fam, { action: "visits.create", stayId: ctx.stayId, visitorName: "钱爽", relation: "亲属", visitTime: `${todayStr} 18:00`, hours: 1 });
    await doAction(cookies["front"], { action: "visits.health", id: v2.id, result: "ok", note: "正常" });
    await doAction(cookies["front"], { action: "visits.disinfect", id: v2.id });
    const plan2 = await doAction(cookies["front"], { action: "visits.plan", stayId: ctx.stayId, date: todayStr });
    const it = (plan2.items || []).find((i) => i.visitId === v2.id);
    check("爽约降低后续排队优先级(基准5上调)", !!it && Number(it.priority) > 5, JSON.stringify(it));
    const ov = await doAction(cookies["front"], { action: "visits.override", id: b1.id, basis: "mother_written", reason: "产妇书面同意照常接待（冒烟）" });
    check("前台凭书面确认覆盖并留理由", ov.ok === true, JSON.stringify(ov));
    const ovBad = await doAction(cookies["front"], { action: "visits.override", id: b1.id, basis: "urgent_care", reason: "" });
    check("无理由覆盖被拒绝", ovBad.ok === false);
    const famPage = await get("/family", ctx.fam);
    check("家属端可见覆盖留痕", famPage.text.includes("已覆盖") || famPage.text.includes("产妇书面确认"));
  }
}

// 18. 健康异常阻断门禁 + 全天占满触发次日改约
{
  const ctx = await bookStay("C");
  check("协同测试C取到独立房间", !!ctx);
  if (ctx) {
    const slot = nextSlot();
    const c1 = await provision(ctx, "孙异", slot, { isTemp: true, health: "abnormal" });
    const plan = await doAction(cookies["front"], { action: "visits.plan", stayId: ctx.stayId, date: todayStr });
    const it = (plan.items || []).find((i) => i.visitId === c1.id);
    check("健康异常进入方案阻断项", !!it && it.blockers.includes("health"), JSON.stringify(it));
    const cf = await doAction(cookies["front"], { action: "visits.plan.confirm", solutionId: plan.solutionId });
    check("健康异常时不分配门禁(原子拦截)", cf.ok === false && /健康异常/.test(cf.error || ""), JSON.stringify(cf));
    // 拒绝该异常申请后，构造全天占满 → 第三人改约次日
    await doAction(cookies["front"], { action: "visits.update", id: c1.id, op: "reject" });
    const x1 = await provision(ctx, "全甲", `${todayStr} 09:00`, { hours: 11 });
    const x2 = await provision(ctx, "全乙", `${todayStr} 09:00`, { hours: 11 });
    const x3 = await provision(ctx, "加塞", `${todayStr} 13:00`, { hours: 2 });
    const plan2 = await doAction(cookies["front"], { action: "visits.plan", stayId: ctx.stayId, date: todayStr });
    const it3 = (plan2.items || []).find((i) => i.visitId === x3.id);
    const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    check("当日容量耗尽触发改约(reschedule)", plan2.kind === "reschedule" && !!it3 && it3.start.startsWith(tomorrow), JSON.stringify(it3));
    const cf2 = await doAction(cookies["front"], { action: "visits.plan.confirm", solutionId: plan2.solutionId });
    check("改约方案确认并发次日门禁", cf2.ok === true && cf2.passes.length === 3 && cf2.passes.find((p) => p.visitId === x3.id)?.from.startsWith(tomorrow),
      JSON.stringify(cf2).slice(0, 180));
  }
}

// 19. 全链路：入场→在场撤回升级护士长→避让未确认阻止闭环→确认后闭环
{
  const ctx = await bookStay("D");
  check("协同测试D取到独立房间", !!ctx);
  if (ctx) {
    const slot = nextSlot();
    await doAction(cookies["nurse1"], { action: "tasks.create", stayId: ctx.stayId, type: "baby_bath", title: "宝宝洗澡（闭环测试）", scheduledAt: slot });
    const d1 = await provision(ctx, "王探", slot, { isTemp: true });
    const plan = await doAction(cookies["front"], { action: "visits.plan", stayId: ctx.stayId, date: todayStr });
    const cf = await doAction(cookies["front"], { action: "visits.plan.confirm", solutionId: plan.solutionId });
    check("D方案原子确认发门禁并生成避让", cf.ok === true && cf.passes.length === 1 && cf.avoidanceIds.length >= 1, JSON.stringify(cf).slice(0, 200));
    const passCode = cf.passes[0].code;
    const visitId = cf.passes[0].visitId;

    const sin = await doAction(cookies["front"], { action: "gates.swipe", passCode, direction: "in" });
    check("有效期内刷卡入场", sin.ok === true && sin.direction === "in", JSON.stringify(sin));
    const closeEarly = await doAction(cookies["front"], { action: "visits.closeout", id: visitId });
    check("访客在房时禁止闭环", closeEarly.ok === false && /离场|出场/.test(closeEarly.error || ""), JSON.stringify(closeEarly));

    const rev = await doAction(ctx.fam, { action: "auths.revoke", id: d1.authId, reason: "产妇临时不适" });
    check("在场撤回升级护士长且保留门禁", rev.ok === true && rev.escalated === true, JSON.stringify(rev));
    const hnPage = await get("/headnurse", cookies["headnurse"]);
    check("护士长工作台出现在场撤回协调", hnPage.text.includes("王探"));
    const resolve = await doAction(cookies["headnurse"], { action: "auths.escalation.resolve", id: d1.authId, note: "陪同离场，回收门禁" });
    check("护士长协调离场并回收门禁", resolve.ok === true, JSON.stringify(resolve));

    const closePending = await doAction(cookies["front"], { action: "visits.closeout", id: visitId });
    check("护理避让未确认阻止闭环", closePending.ok === false && /护理避让/.test(closePending.error || ""), JSON.stringify(closePending));
    const ah = await doAction(cookies["nurse1"], { action: "avoidances.handle", id: cf.avoidanceIds[0], result: "探访时段已暂缓非紧急入房护理（冒烟）" });
    check("护理师确认避让结果", ah.ok === true);
    const closed = await doAction(cookies["front"], { action: "visits.closeout", id: visitId });
    check("进出+人数+避让齐备后预约闭环", closed.ok === true && /闭环/.test(closed.message || ""), JSON.stringify(closed));
  }
}

// 20. 越权：家属不能操作门禁台 / 确认方案
{
  const gateByFamily = await doAction(cookies["family1"], { action: "gates.swipe", passCode: "P-WHATEVER-00", direction: "in" });
  check("家属不能操作门禁", gateByFamily.ok === false);
  const confirmByFamily = await doAction(cookies["family1"], { action: "visits.plan.confirm", solutionId: 1 });
  check("家属不能前台确认方案", confirmByFamily.ok === false);
}

// 释放协同测试占用房间（办理出所 → 房间恢复空房，保证冒烟可重复运行）
for (const ctx of releaseList) {
  await doAction(cookies["front"], { action: "stays.checkout", stayId: ctx.stayId, reason: "冒烟协同测试清理" });
  await doAction(cookies["front"], { action: "rooms.update", id: ctx.roomId, status: "vacant" });
}

console.log(`\n结果：${passed} 通过，${failed} 失败`);
process.exit(failed ? 1 : 0);
