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

// ===========================================================================
// 16. 家属探访冲突 / 授权 / 门禁协同（独立在住订单，结束后清理，可重复运行）
// ===========================================================================
let conflictStayId = null, conflictRoomId = null;
const tag = Date.now() % 100000;
{
  // 16.0 新建在住订单（复用空房）
  const roomsRes = await fetch(`${BASE}/api/rooms`, { headers: { Cookie: cookies["front"] } });
  const roomsBody = await roomsRes.json();
  const vacant = (roomsBody.rooms || []).find((r) => r.status === "vacant" && r.number !== "802");
  check("协同场景：获取空房", !!vacant);
  if (vacant) {
    conflictRoomId = vacant.id;
    const r = await doAction(cookies["front"], {
      action: "stays.create", roomId: vacant.id, packageId: 1, motherName: `协同测试产妇${tag}`, motherPhone: "13900007777",
      checkInDate: "2026-09-28", deliveryMethod: "顺产", postpartumDays: 3, feedingMethod: "母乳喂养",
      mealTaboos: "忌辛辣", babyName: "协协", babyWeight: 3.1, deposit: 5000,
      familyUsername: `conflictfam${tag}`, familyPassword: "conflict123", familyName: "协同家属", familyRelation: "丈夫",
    });
    check("协同场景：入住登记", r.ok === true, JSON.stringify(r));
    if (r.ok) conflictStayId = r.id;
  }
}

if (conflictStayId) {
  const famLogin = await login(`conflictfam${tag}`, "conflict123");
  check("协同家属账号可登录", famLogin.ok === true);
  const fam = famLogin.cookie;
  const D = "2026-10-02";
  const T = `${D} 14:00`;

  // 16.1 授权：3份常规（丈夫/母亲/姨妈） + 1份临时已确认（同事）+ 1份临时未确认（外人）
  async function makeAuthz(name, relation, kind, confirm) {
    const c = await doAction(fam, { action: "authz.create", stayId: conflictStayId, visitorName: name, relation, kind });
    if (c.ok && confirm) {
      await doAction(fam, { action: "authz.confirm", id: c.id, motherConfirmText: `产妇书面确认同意${name}来访` });
    }
    return c;
  }
  const azHusband = await makeAuthz("协同丈夫", "丈夫", "routine", true);
  const azMother = await makeAuthz("协同母亲", "母亲", "routine", true);
  const azAunt = await makeAuthz("协同姨妈", "姨母", "routine", true);
  const azColleague = await makeAuthz("协同同事", "同事", "temp", true);
  const azOutsider = await makeAuthz("协同外人", "朋友", "temp", false);
  check("授权登记与产妇确认", azHusband.ok && azMother.ok && azAunt.ok && azColleague.ok && azOutsider.ok);

  // 护士长先在 14:30 安排一次查房（确认方案时应被原子改期避让）
  const tsk = await doAction(cookies["headnurse"], {
    action: "tasks.create", stayId: conflictStayId, type: "rounds", title: "协同测试-午后查房", scheduledAt: `${D} 14:30`,
  });
  check("冲突时段护理任务已建", tsk.ok === true);

  // 16.2 五份申请同一时段（房间容量2人）
  async function makeVisit(name, relation, isTemp) {
    return await doAction(fam, {
      action: "visits.create", stayId: conflictStayId, visitorName: name, relation, visitTime: T, hours: 2, isTemp,
    });
  }
  const vHusband = await makeVisit("协同丈夫", "丈夫", false);
  const vMother = await makeVisit("协同母亲", "母亲", false);
  const vAunt = await makeVisit("协同姨妈", "姨母", false);
  const vColleague = await makeVisit("协同同事", "同事", true);
  const vOutsider = await makeVisit("协同外人", "朋友", true);
  check("五份同时间段探访申请已提交", [vHusband, vMother, vAunt, vColleague, vOutsider].every((r) => r.ok));

  // 16.3 健康核验：前4人通过，第5人异常；前4人完成消毒
  for (const v of [vHusband, vMother, vAunt, vColleague]) {
    await doAction(cookies["front"], { action: "visits.healthCheck", id: v.id, healthOk: 1 });
    await doAction(cookies["front"], { __action: "visits.update", id: v.id, action: "disinfect", note: "手部消毒+测温正常" });
  }
  const hcBad = await doAction(cookies["front"], { action: "visits.healthCheck", id: vOutsider.id, healthOk: 0, healthNote: "体温37.9℃伴咳嗽" });
  check("探访人健康异常登记（阻止门禁）", hcBad.ok === true);

  // 16.4 阻断项存在时，直接尝试为第5人下发门禁/入场必须失败（此时还未生成方案，无权限）
  const earlyEnter = await doAction(cookies["front"], { action: "door.enter", visitId: vOutsider.id });
  check("未获权限探访人不能入场", earlyEnter.ok === false);

  // 16.5 生成方案：2原时段 + 2改约 + 1阻断
  const plan = await doAction(cookies["front"], { action: "visits.generatePlan", stayId: conflictStayId, date: D });
  check("冲突方案生成成功", plan.ok === true, JSON.stringify(plan));
  check("方案：2人原时段", plan.counts?.direct === 2, JSON.stringify(plan.counts));
  check("方案：2人改约", plan.counts?.reschedule === 2, JSON.stringify(plan.counts));
  check("方案：1人阻断转人工", plan.counts?.blocked === 1, JSON.stringify(plan.counts));
  check("方案阻断项含临时授权未确认", (plan.blockers || []).some((b) => b.includes("临时授权")));
  check("方案阻断项含健康异常", (plan.blockers || []).some((b) => b.includes("健康异常")));
  check("方案阻断项含消毒未完成", (plan.blockers || []).some((b) => b.includes("消毒未完成")));

  // 阻断人仍尝试入场：依旧失败（未下发门禁）
  const blockedEnter = await doAction(cookies["front"], { action: "door.enter", visitId: vOutsider.id });
  check("阻断申请未分配门禁", blockedEnter.ok === false);

  // 16.6 前台确认方案：门禁 + 访客名单 + 护理避让原子更新
  const conf = await doAction(cookies["front"], { action: "visits.confirmPlan", planId: plan.planId });
  check("方案原子确认成功", conf.ok === true, JSON.stringify(conf));
  check("原子下发4张门禁", conf.confirmed === 4, String(conf.confirmed));
  check("护理查房避让改期1项", conf.moved === 1, String(conf.moved));
  check("阻断申请保留原预约", conf.blocked === 1, String(conf.blocked));

  // 方案已确认，重复确认必须被拒绝
  const confAgain = await doAction(cookies["front"], { action: "visits.confirmPlan", planId: plan.planId });
  check("方案不可重复确认", confAgain.ok === false);

  const shiftMin = (s, dm) => {
    const d = new Date(s.replace(" ", "T"));
    d.setMinutes(d.getMinutes() + dm);
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  const at = (id) => plan.placements.find((x) => x.visitId === id)?.assigned || null;
  const enterAt = (id) => { const a = at(id); return a ? shiftMin(a.start, 2) : null; };
  const leaveAt = (id) => { const a = at(id); return a ? shiftMin(a.end, -8) : null; };

  // 16.7 未入场撤回授权：临时同事门禁立即失效
  const revokeBefore = await doAction(fam, { action: "authz.revoke", id: azColleague.id, reason: "产妇临时取消同事来访" });
  check("探访前撤回授权成功", revokeBefore.ok === true);
  const enterRevoked = await doAction(cookies["front"], { action: "door.enter", visitId: vColleague.id, eventTime: enterAt(vColleague.id) });
  check("撤回后未入场家属门禁立即失效", enterRevoked.ok === false);

  // 16.8 已入场撤回授权：升级护士长，且门禁未被远程失效
  const enterH = await doAction(cookies["front"], { action: "door.enter", visitId: vHusband.id, eventTime: enterAt(vHusband.id) });
  check("丈夫正常入场", enterH.ok === true, JSON.stringify(enterH));
  const revokeInside = await doAction(fam, { action: "authz.revoke", id: azHusband.id, reason: "产妇身体不适希望结束探访" });
  check("已入场撤回升级护士长", revokeInside.ok === true && revokeInside.escalated === true, JSON.stringify(revokeInside));
  const hnPage = await get("/headnurse", cookies["headnurse"]);
  check("护士长工作台出现场协调区", hnPage.status === 200 && hnPage.text.includes("探访人仍在场"));
  const resolveEsc = await doAction(cookies["headnurse"], { action: "authz.resolveEscalation", id: azHusband.id, note: "现场沟通后协同丈夫自愿离场，门禁当场失效" });
  check("护士长完成现场协调", resolveEsc.ok === true);

  // 16.9 正常闭环：母亲入场→离场→护理回填避让结果→闭环判定（三项齐备为健康闭环）
  const momAvoidId = (conf.visitAvoidances || []).find((x) => x.visitId === vMother.id)?.avoidanceId;
  check("母亲探访生成了避让单", typeof momAvoidId === "number", JSON.stringify(conf.visitAvoidances));
  const avoidDone = await doAction(cookies["nurse1"], { action: "avoidances.update", id: momAvoidId, status: "done", result: "查房治疗已提前完成，探访时段未进入房间" });
  check("护理回填避让完成", avoidDone.ok === true);
  const enterM = await doAction(cookies["front"], { action: "door.enter", visitId: vMother.id, eventTime: enterAt(vMother.id) });
  const exitM = await doAction(cookies["front"], { action: "door.exit", visitId: vMother.id, eventTime: leaveAt(vMother.id) });
  check("母亲入场与离场记录", enterM.ok && exitM.ok);
  const closeM = await doAction(cookies["front"], { action: "visits.closeLoop", id: vMother.id });
  check("正常探访闭环判定（进出+人数+避让齐备）", closeM.ok === true && closeM.closed === true && closeM.healthy === true, JSON.stringify(closeM));

  // 丈夫仅入场无离场（且避让未回填）→ 闭环异常；护士长人工核销
  const closeH = await doAction(cookies["front"], { action: "visits.closeLoop", id: vHusband.id });
  check("进出不配对判定为闭环异常", closeH.ok === true && closeH.healthy === false, JSON.stringify(closeH));
  const forceH = await doAction(cookies["headnurse"], { action: "visits.forceClose", id: vHusband.id, note: "监控核实已离场，补刷失败，准予核销" });
  check("闭环异常可由护士长人工核销", forceH.ok === true);

  // 16.10 爽约：姨妈（已排定改约时段、门禁已下发）未到场 → 记爽约失效门禁 → 前台凭产妇书面确认覆盖限制（留理由）
  const noShow = await doAction(cookies["front"], { action: "visits.markNoShow", id: vAunt.id, reason: "超过预约时间30分钟未到场，电话确认放弃" });
  check("未到场登记爽约且门禁失效", noShow.ok === true);
  const auntEnterAfterNoShow = await doAction(cookies["front"], { action: "door.enter", visitId: vAunt.id });
  check("爽约后门禁不可再入场", auntEnterAfterNoShow.ok === false);
  const override = await doAction(cookies["front"], {
    action: "visits.overrideNoShow", id: vAunt.id, basis: "mother_written", reason: "产妇书面确认姨妈系紧急照护需要，本次不影响后续优先级",
  });
  check("前台凭产妇书面确认覆盖爽约限制并留理由", override.ok === true);
  const overrideNoReason = await doAction(cookies["front"], { action: "visits.overrideNoShow", id: vAunt.id, basis: "mother_written" });
  check("覆盖爽约必须填写理由", overrideNoReason.ok === false);

  // 16.11 页面渲染检查
  const fdPage = await get("/frontdesk", cookies["front"]);
  check("前台页含冲突协同中心", fdPage.status === 200 && fdPage.text.includes("家属探访冲突协同"));
  const nursePage = await get("/nurse", cookies["nurse1"]);
  check("护理页含探访避让区", nursePage.status === 200 && nursePage.text.includes("探访护理避让"));
  const famPage = await get("/family", fam);
  check("家属页含授权与门禁状态", famPage.status === 200 && famPage.text.includes("探访授权与预约") && famPage.text.includes("门禁状态"));
  const stayPage = await get(`/stays/${conflictStayId}`, cookies["admin"]);
  check("房间360含门禁与避让记录", stayPage.status === 200 && stayPage.text.includes("门禁授权与进出记录") && stayPage.text.includes("护士查房避让结果"));

  // 16.12 清理：出所结算并恢复空房（与既有入住冒烟相同策略）
  await doAction(cookies["finance"], { action: "stays.checkout", stayId: conflictStayId, reason: "协同冒烟结束退所" });
  await doAction(cookies["finance"], { action: "settlements.confirm", stayId: conflictStayId });
  await doAction(cookies["front"], { action: "rooms.update", id: conflictRoomId, status: "vacant" });
}

console.log(`\n结果：${passed} 通过，${failed} 失败`);
process.exit(failed ? 1 : 0);
