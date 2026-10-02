import Link from "next/link";
import { q, today } from "@/lib/db";
import { requireUser } from "@/lib/guard";
import { AppShell, Section, DataTable, Badge } from "@/components/ui";
import { DataForm, ActionButton } from "@/components/client";
import {
  VISIT_STATUS, VISIT_HEALTH, SOLUTION_KIND, SOLUTION_STATUS, PASS_STATUS, AUTH_STATUS,
  money, dt, badgeClass,
} from "@/lib/labels";

export const dynamic = "force-dynamic";

export default async function FrontdeskPage() {
  await requireUser(["frontdesk", "admin"]);
  const date = today();
  const rooms = q("SELECT * FROM rooms ORDER BY number");
  const packages = q("SELECT * FROM packages ORDER BY price");
  const vacantRooms = rooms.filter((r) => r.status === "vacant");

  const inStays = q(
    `SELECT s.id, s.mother_name, r.number, r.capacity, p.name AS package_name
     FROM stays s JOIN rooms r ON r.id=s.room_id JOIN packages p ON p.id=s.package_id
     WHERE s.status='in_stay' ORDER BY r.number`);

  // 今日全部探访（在住订单）
  const todaysVisits = q(
    `SELECT v.*, r.number, r.capacity, s.mother_name FROM visits v
     JOIN stays s ON s.id=v.stay_id JOIN rooms r ON r.id=s.room_id
     WHERE v.visit_date=? ORDER BY v.visit_time, v.id`, date);

  // 待确认方案 + 全部方案（近期）
  const proposedSolutions = q(
    `SELECT sol.*, r.number, s.mother_name FROM visit_solutions sol
     JOIN stays s ON s.id=sol.stay_id JOIN rooms r ON r.id=sol.room_id
     WHERE sol.status='proposed' ORDER BY sol.visit_date, sol.id DESC`);
  const recentSolutions = q(
    `SELECT sol.*, r.number FROM visit_solutions sol JOIN stays s ON s.id=sol.stay_id JOIN rooms r ON r.id=sol.room_id
     ORDER BY sol.id DESC LIMIT 8`);

  // 有效 / 在房门禁
  const activePasses = q(
    `SELECT ap.*, r.number FROM access_passes ap JOIN stays s ON s.id=ap.stay_id JOIN rooms r ON r.id=s.room_id
     WHERE ap.status IN ('active','inside') ORDER BY ap.valid_from, ap.id DESC LIMIT 30`);

  const pendingGifts = q(
    `SELECT g.*, r.number, s.mother_name FROM gifts g
     JOIN stays s ON s.id=g.stay_id JOIN rooms r ON r.id=s.room_id
     WHERE g.status='pending' AND s.status='in_stay' ORDER BY g.id`);

  // 护理避让（今日，待确认）
  const avoidances = q(
    `SELECT a.*, r.number FROM care_avoidances a JOIN stays s ON s.id=a.stay_id JOIN rooms r ON r.id=s.room_id
     WHERE substr(a.window_start,1,10)=? ORDER BY a.window_start`, date);

  const pendingCheck = todaysVisits.filter((v) => ["pending", "approved"].includes(String(v.status)));

  async function solutionItems(solutionId: number) {
    return q(
      `SELECT it.*, v.visitor_name, v.relation, v.is_temp, v.health_status, v.disinfected, v.authorized,
              v.temp_auth_status, v.no_show
       FROM visit_solution_items it JOIN visits v ON v.id=it.visit_id
       WHERE it.solution_id=? ORDER BY it.seq`, solutionId);
  }

  const blockers = (v: Record<string, unknown>): string[] => {
    const b: string[] = [];
    if (!Number(v.authorized)) b.push("无授权");
    if (Number(v.is_temp) && String(v.temp_auth_status) !== "active") b.push("临时授权未确认");
    if (String(v.health_status) !== "ok") b.push(String(v.health_status) === "abnormal" ? "健康异常" : "健康未核验");
    if (!Number(v.disinfected)) b.push("消毒未完成");
    return b;
  };

  return (
    <AppShell title="前台工作台 · 探访冲突 / 授权 / 门禁协同">
      <div className="grid cols-4">
        <div className="stat"><div className="num">{rooms.filter((r) => r.status === "occupied").length}</div><div className="label">在住房间</div></div>
        <div className="stat"><div className="num">{pendingCheck.length}</div><div className="label">今日待排期探访</div></div>
        <div className="stat"><div className="num">{proposedSolutions.length}</div><div className="label">待确认方案</div></div>
        <div className="stat"><div className="num">{activePasses.filter((p) => p.status === "inside").length}</div><div className="label">当前在房访客</div></div>
      </div>

      {/* 协同方案生成 */}
      <Section title="探访协同方案（容量 / 授权 / 护理避让 / 婴儿护理 → 排队·拆分·改约）"
        tone={proposedSolutions.length ? "tone-amber" : ""}>
        <DataForm compact action="visits.plan"
          fields={[
            { name: "stayId", label: "房间", type: "select", required: true, options: inStays.map((s) => ({ value: String(s.id), label: `${s.number} ${s.mother_name}（容量${s.capacity}人）` })) },
            { name: "date", label: "排期日期", type: "date", required: true, defaultValue: date },
          ]} submitLabel="生成协同方案" />
        <div className="muted small mt8">
          引擎综合产妇授权关系、探访规则、房间容量、护理避让时段与婴儿护理安排生成方案；同一申请若存在
          <b>临时授权未确认 / 健康异常 / 消毒未完成</b>，方案确认时将被拦截、保留原预约并转人工。
        </div>

        {proposedSolutions.length > 0 && (
          <div className="mt16">
            {await Promise.all(proposedSolutions.map(async (sol) => {
              const items = await solutionItems(Number(sol.id));
              const anyBlock = items.some((it) => blockers(it).length);
              return (
                <div key={String(sol.id)} className="stat" style={{ marginBottom: 12 }}>
                  <div className="row" style={{ justifyContent: "space-between" }}>
                    <b>方案#{String(sol.id)} · {String(sol.number)}房 {String(sol.mother_name)} · {String(sol.visit_date)}</b>
                    <span className="row">
                      <Badge text={SOLUTION_KIND[String(sol.kind)] || String(sol.kind)} cls="badge amber" />
                      <Badge text={SOLUTION_STATUS[String(sol.status)] || ""} cls={badgeClass("proposed")} />
                    </span>
                  </div>
                  <div className="muted small mt8">{String(sol.reason)}　窗口 {dt(sol.window_start)} ~ {dt(sol.window_end)}</div>
                  <DataTable cols={["序", "探访人", "安排时段", "排队号", "前置项", "操作"]}
                    rows={items.map((it) => {
                      const bs = blockers(it);
                      return [
                        Number(it.seq),
                        <span key="n">{String(it.visitor_name)}<span className="muted small">（{String(it.relation)}）</span>{Number(it.is_temp) ? <span className="badge amber">临时</span> : null}</span>,
                        <span key="t" className="small">{dt(it.assigned_start)} ~ {dt(it.assigned_end)}</span>,
                        Number(it.queue_no),
                        bs.length ? <span key="b" className="badge red">{bs.join("、")}</span> : <span key="ok" className="badge green">齐备</span>,
                        <span key="ops" className="row">
                          {String(it.health_status) !== "ok" && (
                            <DataForm compact action="visits.health" hidden={{ id: Number(it.visit_id), result: "ok" }}
                              fields={[{ name: "note", label: "健康核验", placeholder: "如测温36.6℃，无症状" }]} submitLabel="健康正常" />
                          )}
                          {!Number(it.disinfected) && (
                            <ActionButton action="visits.disinfect" payload={{ id: Number(it.visit_id) }} label="消毒登记" />
                          )}
                        </span>,
                      ];
                    })} />
                  <div className="row mt8" style={{ justifyContent: "space-between" }}>
                    <span className={anyBlock ? "badge red" : "badge green"}>
                      {anyBlock ? "存在前置阻断项，确认将被拦截并保留原预约" : "门禁有效期 + 访客名单 + 护理避让将原子更新"}
                    </span>
                    <span className="row">
                      <ActionButton action="visits.plan" payload={{ stayId: Number(sol.stay_id), date: String(sol.visit_date) }} label="重新生成" />
                      <ActionButton action="visits.plan.confirm" payload={{ solutionId: Number(sol.id) }} label="前台确认方案（原子生效）" kind="primary"
                        confirm="确认后将原子更新门禁有效期、访客名单与护理避让，是否继续？" />
                    </span>
                  </div>
                </div>
              );
            }))}
          </div>
        )}
      </Section>

      {/* 今日探访核验 */}
      <Section title="今日探访核验与排期（健康 / 消毒 / 爽约 / 闭环）">
        <DataTable cols={["房间", "探访人", "预约时段", "状态", "授权", "健康", "消毒", "爽约/覆盖", "操作"]}
          empty="今日暂无探访"
          rows={todaysVisits.map((v) => {
            const tempBadge = Number(v.is_temp) ? <span className="badge amber">临时</span> : null;
            return [
              <Link key="r" href={`/stays/${v.stay_id}`}>{String(v.number)}</Link>,
              <span key="v">{String(v.visitor_name)}<span className="muted small">（{String(v.relation)}）</span>{tempBadge}</span>,
              <span key="t" className="small">{dt(v.visit_time)}~{dt(v.end_time)}<br />排队#{Number(v.queue_no) || "-"}</span>,
              <Badge key="s" text={VISIT_STATUS[String(v.status)] || String(v.status)} cls={badgeClass(String(v.status))} />,
              Number(v.authorized)
                ? (Number(v.is_temp)
                    ? <span key="a" className={String(v.temp_auth_status) === "active" ? "badge green" : "badge red"}>临时{String(v.temp_auth_status) === "active" ? "已确认" : "待确认"}</span>
                    : <span key="a" className="badge green">已授权</span>)
                : <span key="a" className="badge red">无授权</span>,
              <span key="h" className={String(v.health_status) === "ok" ? "badge green" : String(v.health_status) === "abnormal" ? "badge red" : "badge gray"}>
                {VISIT_HEALTH[String(v.health_status)] || "未核验"}
              </span>,
              Number(v.disinfected) ? <span key="d" className="badge green">已消毒</span> : <span key="d2" className="badge gray">未消毒</span>,
              <span key="ns">
                {Number(v.no_show)
                  ? (v.override_reason
                    ? <span className="badge blue">已覆盖<br /><span className="small">{String(v.override_reason)}</span></span>
                    : <span className="badge red">爽约·降级</span>)
                  : <span className="muted small">-</span>}
              </span>,
              <span key="ops" className="row">
                {["pending", "approved"].includes(String(v.status)) && (
                  <span className="row">
                    {String(v.health_status) !== "ok" && (
                      <DataForm compact action="visits.health" hidden={{ id: Number(v.id), result: "ok" }}
                        fields={[{ name: "note", label: "健康", placeholder: "测温/症状" }]} submitLabel="健康" />
                    )}
                    {String(v.health_status) === "ok" && (
                      <DataForm compact action="visits.health" hidden={{ id: Number(v.id), result: "abnormal" }}
                        fields={[{ name: "note", label: "异常说明", placeholder: "如发热37.8℃" }]} submitLabel="健康异常" />
                    )}
                    {!Number(v.disinfected) && <ActionButton action="visits.disinfect" payload={{ id: Number(v.id) }} label="消毒" />}
                  </span>
                )}
                {(String(v.status) === "scheduled" || String(v.status) === "approved") && !v.entered_at && (
                  <ActionButton action="visits.noshow" payload={{ id: Number(v.id) }} label="爽约" kind="danger" />
                )}
                {Number(v.no_show) && !v.override_reason && (
                  <DataForm compact action="visits.override" hidden={{ id: Number(v.id) }}
                    fields={[
                      { name: "basis", label: "覆盖依据", type: "select", required: true, options: [{ value: "urgent_care", label: "紧急照护需要" }, { value: "mother_written", label: "产妇书面确认" }] },
                      { name: "reason", label: "理由(留痕)", required: true },
                    ]} submitLabel="覆盖限制" />
                )}
                {(String(v.status) === "scheduled" || String(v.status) === "completed") && (
                  <ActionButton action="visits.closeout" payload={{ id: Number(v.id) }} label="闭环" kind="primary" />
                )}
              </span>,
            ];
          })} />
      </Section>

      {/* 门禁台 */}
      <div className="grid cols-2">
        <Section title="门禁台（有效期校验 + 进出留痕）">
          <DataForm compact action="gates.swipe"
            fields={[
              { name: "passCode", label: "门禁码", required: true, placeholder: "如 P801-XXXX-01AB" },
              { name: "direction", label: "方向", type: "select", required: true, options: [{ value: "in", label: "入场" }, { value: "out", label: "出场" }] },
              { name: "gate", label: "门禁点", placeholder: "默认楼层门禁" },
            ]} submitLabel="刷卡" />
          <div className="mt8">
            <DataTable cols={["门禁码", "房间", "探访人", "有效期", "状态"]} empty="暂无有效门禁"
              rows={activePasses.map((p) => [
                <span key="c" className="small">{String(p.pass_code)}</span>,
                String(p.number), String(p.visitor_name),
                <span key="t" className="small">{dt(p.valid_from)}~{dt(p.valid_to)}</span>,
                <Badge key="s" text={PASS_STATUS[String(p.status)] || String(p.status)} cls={badgeClass(String(p.status))} />,
              ])} />
          </div>
        </Section>

        <Section title="护理避让联动（查房 / 婴儿护理 暂缓入房）">
          <DataTable cols={["房间", "避让安排", "时段", "状态"]} empty="今日暂无避让安排"
            rows={avoidances.map((a) => [
              String(a.number),
              <span key="t">{String(a.title)}<div className="muted small">{String(a.result || "等待护理执行结果")}</div></span>,
              <span key="w" className="small">{dt(a.window_start)}~{dt(a.window_end)}</span>,
              <Badge key="s" text={String(a.status) === "done" ? "避让已确认" : "待避让确认"} cls={badgeClass(String(a.status) === "done" ? "done" : "planned")} />,
            ])} />
        </Section>
      </div>

      {/* 房间 / 入住 / 赠品 */}
      <Section title="房间状态">
        <div className="grid cols-4">
          {rooms.map((r) => (
            <div className="stat" key={String(r.id)}>
              <div className="room-head row" style={{ justifyContent: "space-between" }}>
                <b style={{ fontSize: 18 }}>{String(r.number)}</b>
                <Badge
                  text={r.status === "occupied" ? "在住" : r.status === "vacant" ? "空房" : "清扫中"}
                  cls={r.status === "occupied" ? "badge blue" : r.status === "vacant" ? "badge green" : "badge amber"} />
              </div>
              <div className="small muted">{String(r.type)} · {String(r.floor)} · 容量{String(r.capacity)}人</div>
              {r.status === "cleaning" && (
                <div className="mt8">
                  <ActionButton action="rooms.update" payload={{ id: Number(r.id), status: "vacant" }} label="清扫完成→空房" kind="primary" />
                </div>
              )}
            </div>
          ))}
        </div>
      </Section>

      <Section title="产妇入住登记（自动建护理计划/赠品/费用/家属账号）">
        <DataForm action="stays.create"
          fields={[
            { name: "motherName", label: "产妇姓名", required: true },
            { name: "motherPhone", label: "产妇电话" },
            { name: "roomId", label: "房间", type: "select", required: true, options: vacantRooms.map((r) => ({ value: String(r.id), label: `${r.number}（${r.type}）` })) },
            { name: "packageId", label: "房型套餐", type: "select", required: true, options: packages.map((p) => ({ value: String(p.id), label: `${p.name}（${money(p.price)} / ${p.days}天 / ${p.room_type}）` })) },
            { name: "checkInDate", label: "入住日期", type: "date", required: true },
            { name: "deliveryMethod", label: "分娩方式", type: "select", required: true, options: [{ value: "顺产", label: "顺产" }, { value: "剖宫产", label: "剖宫产" }, { value: "顺产转剖宫产", label: "顺产转剖宫产" }] },
            { name: "postpartumDays", label: "产后天数", type: "number", required: true },
            { name: "feedingMethod", label: "哺乳方式", type: "select", required: true, options: [{ value: "母乳喂养", label: "母乳喂养" }, { value: "混合喂养", label: "混合喂养" }, { value: "人工喂养", label: "人工喂养" }] },
            { name: "allergyHistory", label: "过敏史", placeholder: "如：青霉素过敏；海鲜过敏" },
            { name: "mealTaboos", label: "餐食禁忌", placeholder: "如：忌辛辣、忌海鲜" },
            { name: "doctorAdvice", label: "医生建议", type: "textarea" },
            { name: "babyName", label: "宝宝小名" },
            { name: "babyWeight", label: "宝宝体重(kg)", type: "number", step: "0.01" },
            { name: "jaundiceLevel", label: "黄疸值(mg/dL)", type: "number", step: "0.1" },
            { name: "jaundiceNote", label: "黄疸观察" },
            { name: "visitors", label: "授权探访家属（顿号分隔）", placeholder: "如：张强（丈夫）、李秀兰（婆婆）" },
            { name: "deposit", label: "押金(元)", type: "number" },
            { name: "familyUsername", label: "家属登录账号" },
            { name: "familyPassword", label: "家属登录密码", placeholder: "默认 family123" },
            { name: "familyName", label: "家属姓名" },
            { name: "familyRelation", label: "与产妇关系", placeholder: "如：丈夫" },
          ]}
          submitLabel="办理入住" />
      </Section>

      <div className="grid cols-2">
        <Section title="待发放赠品">
          <DataTable cols={["房间", "产妇", "赠品", "操作"]} empty="暂无待发放赠品"
            rows={pendingGifts.map((g) => [
              <Link key="r" href={`/stays/${g.stay_id}`}>{String(g.number)}</Link>,
              String(g.mother_name), String(g.name),
              <ActionButton key="b" action="gifts.deliver" payload={{ id: Number(g.id) }} label="发放" kind="primary" />,
            ])} />
        </Section>
        <Section title="近期方案（已确认 / 已替代）">
          <DataTable cols={["房间", "日期", "类型", "状态", "窗口"]} empty="暂无历史方案"
            rows={recentSolutions.map((s) => [
              String(s.number), String(s.visit_date),
              SOLUTION_KIND[String(s.kind)] || String(s.kind),
              <Badge key="st" text={SOLUTION_STATUS[String(s.status)] || String(s.status)} cls={badgeClass(String(s.status))} />,
              <span key="w" className="small">{dt(s.window_start)}~{dt(s.window_end)}</span>,
            ])} />
        </Section>
      </div>
    </AppShell>
  );
}
