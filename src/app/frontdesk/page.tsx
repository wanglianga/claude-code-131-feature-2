import Link from "next/link";
import { q } from "@/lib/db";
import { requireUser } from "@/lib/guard";
import { AppShell, Section, DataTable, Badge } from "@/components/ui";
import { DataForm, ActionButton } from "@/components/client";
import {
  VISIT_STATUS, PLAN_DECISION, PLAN_STATUS, DOOR_STATUS, AUTHZ_KIND, AUTHZ_STATUS,
  money, dt, badgeClass,
} from "@/lib/labels";

export const dynamic = "force-dynamic";

function planBlockers(raw: unknown): string[] {
  try { return JSON.parse(String(raw || "[]")) as string[]; } catch { return []; }
}

export default async function FrontdeskPage() {
  await requireUser(["frontdesk", "admin"]);
  const rooms = q("SELECT * FROM rooms ORDER BY number");
  const packages = q("SELECT * FROM packages ORDER BY price");
  const vacantRooms = rooms.filter((r) => r.status === "vacant");
  const inStays = q(
    `SELECT s.id, s.mother_name, s.check_in_date, s.expected_checkout, r.number, r.visitor_capacity, p.name AS package_name
     FROM stays s JOIN rooms r ON r.id=s.room_id JOIN packages p ON p.id=s.package_id
     WHERE s.status='in_stay' ORDER BY r.number`);

  // 协同方案（待确认 / 最近）
  const plans = q(
    `SELECT vp.*, r.number, s.mother_name FROM visit_plans vp
     JOIN stays s ON s.id=vp.stay_id JOIN rooms r ON r.id=s.room_id
     ORDER BY vp.status='proposed' DESC, vp.id DESC LIMIT 10`);

  // 全部未闭环探访（含方案决策/门禁状态）
  const openVisits = q(
    `SELECT v.*, r.number, s.mother_name, a.kind AS authz_kind, a.status AS authz_status, da.id AS access_id, da.status AS access_status,
            da.valid_from, da.valid_to
     FROM visits v
     JOIN stays s ON s.id=v.stay_id JOIN rooms r ON r.id=s.room_id
     LEFT JOIN visit_authorizations a ON a.id=v.authz_id
     LEFT JOIN door_access da ON da.visit_id=v.id AND da.status IN ('active','entered')
     WHERE v.closed=0 AND v.status IN ('pending','approved','no_show')
     ORDER BY substr(v.visit_time,1,10), v.priority_score DESC, v.id`);

  const proposed = plans.filter((p) => p.status === "proposed");
  const activeDoors = openVisits.filter((v) => v.access_id);
  const noShows = openVisits.filter((v) => v.status === "no_show" || Number(v.no_show) === 1);
  const pendingGifts = q(
    `SELECT g.*, r.number, s.mother_name FROM gifts g
     JOIN stays s ON s.id=g.stay_id JOIN rooms r ON r.id=s.room_id
     WHERE g.status='pending' AND s.status='in_stay' ORDER BY g.id`);

  return (
    <AppShell title="前台工作台">
      <div className="grid cols-4">
        <div className="stat"><div className="num">{rooms.filter((r) => r.status === "occupied").length}</div><div className="label">在住房间</div></div>
        <div className="stat"><div className="num">{proposed.length}</div><div className="label">待确认协同方案</div></div>
        <div className="stat"><div className="num">{activeDoors.length}</div><div className="label">有效/在场门禁</div></div>
        <div className="stat"><div className="num">{noShows.length}</div><div className="label">爽约记录</div></div>
      </div>

      {/* ---------- 探访冲突协同中心 ---------- */}
      <Section title="家属探访冲突协同（授权关系 · 探访规则 · 房间容量 · 护理避让 · 婴儿护理）" tone={proposed.length ? "tone-amber" : ""}>
        <div className="muted small mb8">
          规则：按产妇授权关系与爽约历史计算优先级；申请人数超过房间容量或与护理/婴儿护理窗口冲突时，系统给出
          <b>原时段 / 拆分时段 / 改约 / 排队</b>方案；存在<b>临时授权未确认、探访人健康异常、消毒未完成</b>的申请不直接分配门禁，保留原预约转人工。
        </div>
        <div className="grid cols-2">
          <DataForm compact action="visits.generatePlan"
            fields={[
              { name: "stayId", label: "房间", type: "select", required: true, options: inStays.map((s) => ({ value: String(s.id), label: `${s.number} ${s.mother_name}（容量${s.visitor_capacity}人）` })) },
              { name: "date", label: "探访日期", type: "date", required: true },
            ]} submitLabel="生成排队/拆分/改约方案" />
          <div className="muted small" style={{ alignSelf: "center" }}>
            方案生成只做试排，不写任何权限；前台确认后，门禁有效期、访客名单与护士查房避让时间在同一事务内原子更新。
          </div>
        </div>

        <div className="mt8">
          <DataTable cols={["房间", "日期", "方案内容（优先级与处置）", "阻断项", "状态", "操作"]} empty="暂无协同方案"
            rows={plans.map((p) => [
              <Link key="r" href={`/stays/${p.stay_id}`}>{String(p.number)}</Link>,
              String(p.visit_date),
              <span key="c" className="small" style={{ whiteSpace: "pre-line" }}>{String(p.summary)}</span>,
              planBlockers(p.blockers).length
                ? <span key="b" className="badge red">{planBlockers(p.blockers).join("、")}</span>
                : <span key="ok" className="badge green">无阻断</span>,
              <Badge key="s" text={PLAN_STATUS[String(p.status)] || String(p.status)} cls={badgeClass(String(p.status === "proposed" ? "processing" : p.status))} />,
              p.status === "proposed" ? (
                <span key="ops" className="row">
                  <ActionButton action="visits.confirmPlan" payload={{ planId: Number(p.id) }} label="确认方案·原子下发" kind="primary"
                    confirm="确认后将同时写入门禁有效期、访客名单并调整护士查房避让，是否继续？" />
                  <ActionButton action="visits.rejectPlan" payload={{ planId: Number(p.id) }} label="驳回（保留原预约）" kind="danger" />
                </span>
              ) : <span key="x" className="small muted">{String(p.tx_status || "")}</span>,
            ])} />
        </div>
      </Section>

      {/* ---------- 探访申请明细：授权/健康/消毒/方案决策 ---------- */}
      <Section title="探访申请明细（门禁前置三项：授权 · 健康 · 消毒）">
        <DataTable cols={["房间", "探访人", "申请时段", "授权", "健康", "消毒", "优先级/方案", "门禁", "操作"]} empty="暂无未闭环探访"
          rows={openVisits.map((v) => {
            let decision: { assigned?: { start: string; end: string } | null; reason?: string; blockers?: string[]; planId?: number } = {};
            try { decision = JSON.parse(String(v.plan_detail || "{}")); } catch { /* ignore */ }
            const healthBadge = Number(v.health_ok)
              ? <span key="h" className="badge green">通过</span>
              : (v.health_note ? <span key="h" className="badge red">异常：{String(v.health_note)}</span> : <span key="h" className="badge amber">未核验</span>);
            return [
              <Link key="r" href={`/stays/${v.stay_id}`}>{String(v.number)}</Link>,
              <span key="n">{String(v.visitor_name)}<span className="muted small">（{String(v.relation)}）</span>{Number(v.is_temp) ? <span className="badge amber">临时</span> : null}</span>,
              <span key="t" className="small">{dt(v.visit_time)} · {String(v.hours)}h</span>,
              v.authz_id
                ? <span key="a"><Badge text={AUTHZ_KIND[String(v.authz_kind)] || "授权"} cls={String(v.authz_status) === "active" ? "badge green" : "badge red"} /><div className="small muted">{AUTHZ_STATUS[String(v.authz_status)] || ""}</div></span>
                : <span key="a" className="badge red">未关联授权</span>,
              healthBadge,
              Number(v.disinfected) ? <span key="d" className="badge green">已消毒</span> : <span key="d" className="badge amber">未消毒</span>,
              <span key="p" className="small">
                <b>{Number(v.priority_score)}</b>
                {v.plan_decision ? <div><Badge text={PLAN_DECISION[String(v.plan_decision)] || String(v.plan_decision)} cls={v.plan_decision === "blocked" || v.plan_decision === "queue" ? "badge red" : "badge blue"} /></div> : null}
                {decision.assigned ? <div className="muted">排定 {decision.assigned.start.slice(11)}-{decision.assigned.end.slice(11)}</div> : null}
                {decision.blockers?.length ? <div className="badge red">{decision.blockers.join("、")}</div> : null}
              </span>,
              v.access_id
                ? <span key="g"><Badge text={DOOR_STATUS[String(v.access_status)] || ""} cls={badgeClass(String(v.access_status))} /><div className="small muted">{dt(v.valid_from)}~{String(v.valid_to).slice(11, 16)}</div></span>
                : <span key="g" className="badge gray">未下发</span>,
              <span key="ops" className="row">
                {Number(v.health_ok) === 0 && (
                  <DataForm compact action="visits.healthCheck" hidden={{ id: Number(v.id) }}
                    fields={[
                      { name: "healthOk", label: "健康", type: "select", required: true, options: [{ value: "1", label: "核验通过" }, { value: "0", label: "异常" }] },
                      { name: "healthNote", label: "异常说明/体温" },
                    ]} submitLabel="核验" />
                )}
                {Number(v.health_ok) === 1 && Number(v.disinfected) === 0 &&
                  <ActionButton action="visits.update" payload={{ id: Number(v.id), action: "disinfect" }} label="消毒登记" />}
                {v.status === "pending" && !v.plan_decision &&
                  <ActionButton action="visits.update" payload={{ id: Number(v.id), action: "reject" }} label="拒绝" kind="danger" />}
              </span>,
            ];
          })} />
      </Section>

      {/* ---------- 门禁台 ---------- */}
      <div className="grid cols-2">
        <Section title="门禁台（入场/离场刷卡）">
          <DataTable cols={["房间", "探访人", "有效期", "状态", "操作"]} empty="暂无有效门禁"
            rows={activeDoors.map((v) => [
              String(v.number), String(v.visitor_name),
              <span key="t" className="small">{dt(v.valid_from)} ~ {String(v.valid_to).slice(11, 16)}</span>,
              <Badge key="s" text={DOOR_STATUS[String(v.access_status)] || ""} cls={badgeClass(String(v.access_status))} />,
              <span key="ops" className="row">
                {v.access_status === "active" && <ActionButton action="door.enter" payload={{ visitId: Number(v.id) }} label="入场" kind="primary" />}
                {v.access_status === "entered" && <ActionButton action="door.exit" payload={{ visitId: Number(v.id) }} label="离场" />}
              </span>,
            ])} />
        </Section>

        {/* ---------- 爽约与覆盖 / 闭环 ---------- */}
        <Section title="爽约处理 · 优先级覆盖 · 闭环判定">
          <DataTable cols={["探访人", "状态", "操作"]} empty="暂无爽约/待闭环记录"
            rows={openVisits.filter((v) => v.status === "no_show" || (v.access_status === "active") || (v.access_status === "entered")).map((v) => [
              <span key="n">{String(v.visitor_name)}<div className="small muted">{String(v.number)} · {dt(v.visit_time)}</div></span>,
              <span key="s">
                <Badge text={VISIT_STATUS[String(v.status)] || String(v.status)} cls={badgeClass(String(v.status))} />
                {Number(v.no_show) === 1 && (Number(v.no_show_overridden) ? <span className="badge green">已覆盖</span> : <span className="badge amber">影响优先级</span>)}
              </span>,
              <span key="ops" className="row">
                {v.access_status === "active" && v.status !== "no_show" && (
                  <DataForm compact action="visits.markNoShow" hidden={{ id: Number(v.id) }}
                    fields={[{ name: "reason", label: "爽约说明", required: true, placeholder: "超时未到/电话确认放弃" }]}
                    submitLabel="记爽约" />
                )}
                {Number(v.no_show) === 1 && Number(v.no_show_overridden) === 0 && (
                  <DataForm compact action="visits.overrideNoShow" hidden={{ id: Number(v.id) }}
                    fields={[
                      { name: "basis", label: "覆盖依据", type: "select", required: true, options: [
                        { value: "emergency", label: "紧急照护需要" }, { value: "mother_written", label: "产妇书面确认" }] },
                      { name: "reason", label: "理由留档", required: true },
                    ]} submitLabel="覆盖限制" />
                )}
                {Number(v.no_show_overridden) === 1 && <span className="small muted">{String(v.no_show_override_reason)}</span>}
              </span>,
            ])} />
          <div className="muted small mt8">
            活动结束后请到房间360视图对已离场探访执行「闭环判定」：门禁进出记录、实际探访人数、护理避让结果三者齐备方为正常闭环。
          </div>
        </Section>
      </div>

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
              <div className="small muted">{String(r.type)} · {String(r.floor)} · 限{String(r.visitor_capacity)}名探访</div>
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

      <Section title="待发放赠品">
        <DataTable cols={["房间", "产妇", "赠品", "操作"]} empty="暂无待发放赠品"
          rows={pendingGifts.map((g) => [
            <Link key="r" href={`/stays/${g.stay_id}`}>{String(g.number)}</Link>,
            String(g.mother_name), String(g.name),
            <ActionButton key="b" action="gifts.deliver" payload={{ id: Number(g.id) }} label="发放" kind="primary" />,
          ])} />
      </Section>
    </AppShell>
  );
}
