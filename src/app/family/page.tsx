import { redirect } from "next/navigation";
import { q, q1 } from "@/lib/db";
import { requireUser } from "@/lib/guard";
import { AppShell, Section, DataTable, KV, Badge } from "@/components/ui";
import { DataForm, ActionButton } from "@/components/client";
import { PLAN_TYPES, VISIT_STATUS, VISIT_HEALTH, FEE_TYPES, AUTH_STATUS, PASS_STATUS, money, dt, badgeClass } from "@/lib/labels";

export const dynamic = "force-dynamic";

export default async function FamilyPage() {
  const user = await requireUser(["family"]);
  const link = q1(
    `SELECT fl.stay_id, fl.relation, fl.name AS link_name FROM family_links fl WHERE fl.user_id=? LIMIT 1`, user.id);
  if (!link) {
    return (
      <AppShell title="家属端">
        <Section title="提示"><div className="empty">您的账号尚未关联入住订单，请联系前台登记。</div></Section>
      </AppShell>
    );
  }
  const stayId = Number(link.stay_id);
  const stay = q1(
    `SELECT s.*, r.number AS room_number, r.type AS room_type, p.name AS package_name
     FROM stays s JOIN rooms r ON r.id=s.room_id JOIN packages p ON p.id=s.package_id WHERE s.id=?`, stayId)!;
  const perms = JSON.parse(String(stay.visit_permissions || "{}"));
  const showCare = perms.careSummary !== false;
  const showFees = perms.fees !== false;
  const showVisits = perms.visits !== false;

  const records = showCare
    ? q(`SELECT * FROM care_records WHERE stay_id=? AND visible_to_family=1 ORDER BY created_at DESC LIMIT 20`, stayId)
    : [];
  const todayTasks = showCare
    ? q(`SELECT t.*, u.name AS assignee FROM care_tasks t LEFT JOIN users u ON u.id=t.assignee_id
         WHERE t.stay_id=? AND t.visible_to_family=1 AND t.status='done' ORDER BY t.done_at DESC LIMIT 10`, stayId)
    : [];
  const visits = showVisits ? q("SELECT * FROM visits WHERE stay_id=? ORDER BY visit_time DESC LIMIT 12", stayId) : [];
  const authorizations = showVisits ? q("SELECT * FROM visit_authorizations WHERE stay_id=? ORDER BY id DESC", stayId) : [];
  const passes = showVisits
    ? q("SELECT * FROM access_passes WHERE stay_id=? ORDER BY valid_from DESC LIMIT 12", stayId) : [];
  const passEvents = showVisits
    ? q("SELECT ae.* FROM access_events ae JOIN access_passes ap ON ap.id=ae.pass_id WHERE ap.stay_id=? ORDER BY ae.gate_time DESC LIMIT 12", stayId) : [];
  const myAvoidances = showVisits
    ? q("SELECT * FROM care_avoidances WHERE stay_id=? ORDER BY window_start DESC LIMIT 6", stayId) : [];
  const fees = showFees ? q("SELECT * FROM fees WHERE stay_id=? AND status='confirmed' ORDER BY created_at", stayId) : [];
  const settlement = showFees ? q1("SELECT * FROM settlements WHERE stay_id=?", stayId) : undefined;
  const feedbacks = q("SELECT * FROM feedbacks WHERE stay_id=? ORDER BY created_at DESC LIMIT 10", stayId);
  const followUps = q("SELECT * FROM follow_ups WHERE stay_id=? ORDER BY scheduled_at", stayId);
  const messages = q("SELECT * FROM messages WHERE stay_id=? AND audience IN ('all','family') ORDER BY created_at DESC LIMIT 10", stayId);
  const rounds = showCare ? q("SELECT * FROM doctor_rounds WHERE stay_id=? ORDER BY round_date DESC LIMIT 5", stayId) : [];

  const feeTotal = fees.filter((f) => f.direction === "charge").reduce((s, f) => s + Number(f.amount), 0);
  const refundTotal = fees.filter((f) => f.direction === "refund").reduce((s, f) => s + Number(f.amount), 0);

  return (
    <AppShell title={`家属端 · ${stay.mother_name}（${stay.room_number}房）`}>
      <Section title="入住信息" extra={<Badge text={stay.status === "in_stay" ? "在住" : "已出所"} cls={badgeClass(String(stay.status))} />}>
        <KV items={[
          ["房间 / 套餐", `${stay.room_number}（${stay.room_type}）/ ${stay.package_name}`],
          ["入住 / 预计出所", `${stay.check_in_date} ~ ${stay.expected_checkout}${stay.actual_checkout ? `（实际 ${stay.actual_checkout}）` : ""}`],
          ["宝宝", `${stay.baby_name} · ${stay.baby_weight}kg`],
          ["黄疸观察", `${stay.jaundice_level}mg/dL ${stay.jaundice_note || ""}`],
          ["哺乳方式", String(stay.feeding_method)],
          ["我的身份", `${link.link_name}（${link.relation}）`],
        ]} />
      </Section>

      {showCare && (
        <div className="grid cols-2">
          <Section title="护理摘要（经授权）">
            <DataTable cols={["时间", "内容", "记录人", "操作"]} empty="暂无护理摘要"
              rows={records.map((r) => [
                <span key="t" className="small">{dt(r.created_at)}</span>,
                <span key="c">{String(r.content)}</span>,
                String(r.created_by_name),
                Number(r.disputed)
                  ? <span key="d" className="badge red">已质疑，核查中</span>
                  : (
                    <DataForm key="df" compact action="records.dispute" hidden={{ id: Number(r.id) }}
                      fields={[{ name: "reason", label: "质疑原因", placeholder: "如与实际不符，请说明" }]}
                      submitLabel="质疑" />
                  ),
              ])} />
            <div className="muted small mt8">已完成的护理项目：</div>
            <DataTable cols={["时间", "项目", "执行人"]} empty="暂无"
              rows={todayTasks.map((t) => [
                <span key="t" className="small">{dt(t.done_at)}</span>,
                <span key="n">{PLAN_TYPES[String(t.type)] || String(t.type)} · {String(t.title)}</span>,
                String(t.assignee || "-"),
              ])} />
          </Section>

          <Section title="医生巡诊与随访">
            <DataTable cols={["日期", "查体发现", "医生建议"]} empty="暂无巡诊记录"
              rows={rounds.map((r) => [String(r.round_date), String(r.findings), String(r.advice)])} />
            <div className="muted small mt8">回访 / 随访安排：</div>
            <DataTable cols={["类型", "时间", "状态", "结果"]} empty="暂无随访安排"
              rows={followUps.map((f) => [
                String(f.type), dt(f.scheduled_at),
                <Badge key="s" text={f.status === "done" ? "已完成" : "待执行"} cls={badgeClass(String(f.status))} />,
                String(f.result || "-"),
              ])} />
          </Section>
        </div>
      )}

      {showVisits && (
        <Section title="探访授权管理（产妇可随时撤回）">
            <div className="muted small">
              常规授权在入住时登记；临时探访需先授予临时授权并经产妇<b>确认</b>后方可排期发门禁。
              探访前可撤回：<b>未入场家属门禁立即失效并通知前台</b>；若家属已入场，撤回将升级护士长现场协调。
            </div>
            <DataTable cols={["探访人", "关系", "类型", "状态", "操作"]} empty="暂无授权记录"
              rows={authorizations.map((a) => [
                <span key="n">{String(a.visitor_name)}</span>,
                String(a.relation || "-"),
                String(a.auth_type) === "temporary" ? "临时" : "常规",
                <Badge key="s" text={AUTH_STATUS[String(a.status)] || String(a.status)} cls={badgeClass(String(a.status))} />,
                String(a.status) === "pending" ? (
                  <ActionButton key="ok" action="auths.confirm" payload={{ id: Number(a.id) }} label="产妇确认授权" kind="primary" />
                ) : ["active", "revoking"].includes(String(a.status)) ? (
                  <DataForm key="rv" compact action="auths.revoke" hidden={{ id: Number(a.id) }}
                    fields={[{ name: "reason", label: "撤回原因", placeholder: "如：今日身体不适，暂不接待" }]}
                    submitLabel={String(a.status) === "revoking" ? "查看(已升级护士长)" : "撤回授权"} />
                ) : <span key="x" className="muted small">{String(a.revoke_reason || "-")}</span>,
              ])} />
            <details className="mt8">
              <summary className="muted">为新探访人授予临时授权</summary>
              <DataForm compact action="auths.grant" hidden={{ stayId }}
                fields={[
                  { name: "visitorName", label: "探访人姓名", required: true },
                  { name: "relation", label: "与产妇关系", placeholder: "如：朋友 / 同事" },
                  { name: "authType", label: "授权类型", type: "select", required: true, options: [{ value: "temporary", label: "临时授权（本次探访）" }, { value: "routine", label: "常规授权（长期）" }] },
                ]} submitLabel="提交授权申请（待确认）" />
            </details>
        </Section>
      )}

      <div className="grid cols-2">
        {showVisits && (
          <Section title="探访预约 / 门禁 / 闭环">
            <DataForm compact action="visits.create" hidden={{ stayId }}
              fields={[
                { name: "visitorName", label: "探访人姓名", required: true },
                { name: "relation", label: "与产妇关系", placeholder: "如：丈夫 / 婆婆" },
                { name: "visitTime", label: "探访时间", type: "datetime-local", required: true },
                { name: "hours", label: "时长(小时)", type: "number", defaultValue: 2 },
                { name: "isTemp", label: "临时增加探访", type: "checkbox" },
              ]} submitLabel="提交预约" />
            <div className="muted small mt8">
              同一时段申请人数超过房间容量时，前台将按授权关系、探访规则、容量与护理安排生成排队 / 拆分 / 改约方案；
              爽约记录会影响后续同名人排队优先级（前台可依紧急照护或产妇书面确认覆盖）。
            </div>
            <div className="mt8">
              <DataTable cols={["探访人", "时间", "状态", "授权/健康/消毒", "实到/闭环"]} empty="暂无预约"
                rows={visits.map((v) => [
                  <span key="v">{String(v.visitor_name)}{Number(v.is_temp) ? <span className="badge amber">临时</span> : null}{Number(v.no_show) ? <span className="badge red">爽约</span> : null}</span>,
                  <span key="t" className="small">{dt(v.visit_time)}~{dt(v.end_time)}</span>,
                  <Badge key="s" text={VISIT_STATUS[String(v.status)] || ""} cls={badgeClass(String(v.status))} />,
                  <span key="chk" className="small">
                    {Number(v.authorized) ? <span className="badge green">授权</span> : <span className="badge red">无授权</span>}
                    <span className={String(v.health_status) === "ok" ? "badge green" : "badge gray"}>{VISIT_HEALTH[String(v.health_status)] || "未核验"}</span>
                    {Number(v.disinfected) ? <span className="badge green">已消毒</span> : <span className="badge gray">待消毒</span>}
                    {v.override_reason ? <div className="muted small">覆盖：{String(v.override_reason)}</div> : null}
                  </span>,
                  <span key="c" className="small">实到 {Number(v.actual_count)} 人{v.closed_result ? ` · ${v.closed_result === "closed" ? "已闭环" : String(v.closed_result)}` : ""}</span>,
                ])} />
            </div>
            <div className="mt8">
              <div className="muted small">我的门禁与进出记录：</div>
              <DataTable cols={["门禁码", "探访人", "有效期", "状态"]} empty="暂未发放门禁"
                rows={passes.map((p) => [
                  <span key="c" className="small">{String(p.pass_code)}</span>,
                  String(p.visitor_name),
                  <span key="t" className="small">{dt(p.valid_from)}~{dt(p.valid_to)}</span>,
                  <Badge key="s" text={PASS_STATUS[String(p.status)] || String(p.status)} cls={badgeClass(String(p.status))} />,
                ])} />
              <ul className="timeline mt8">
                {passEvents.map((e) => (
                  <li key={String(e.id)}>
                    <span className="t-time">{dt(e.gate_time)}</span>
                    <b>{String(e.visitor_name)}</b> {String(e.direction) === "in" ? "入场" : String(e.direction) === "out" ? "出场" : "门禁失效"}（{String(e.gate)}）
                  </li>
                ))}
                {passEvents.length === 0 && <li className="muted small">暂无进出记录</li>}
              </ul>
            </div>
            {myAvoidances.length > 0 && (
              <div className="muted small mt8">
                护理避让：{myAvoidances.map((a) => `${dt(a.window_start).slice(5)}-${dt(a.window_end).slice(11, 16)}${String(a.status) === "done" ? "（已避让）" : "（计划中）"}`).join("；")}
              </div>
            )}
          </Section>
        )}

        {showFees && (
          <Section title="费用明细">
            <DataTable cols={["时间", "项目", "方向", "金额"]} empty="暂无费用"
              rows={fees.map((f) => [
                <span key="t" className="small">{dt(f.created_at)}</span>,
                <span key="d">{FEE_TYPES[String(f.type)] || String(f.type)} · {String(f.description)}</span>,
                f.direction === "refund" ? <span key="r" className="badge blue">退款</span> : <span key="c" className="badge gray">应收</span>,
                <b key="m">{money(f.amount)}</b>,
              ])} />
            <div className="mt8">
              <KV items={[
                ["应收合计", money(feeTotal)],
                ["退款合计", money(refundTotal)],
                ["应付净额", <b key="n">{money(feeTotal - refundTotal)}</b>],
                ...(settlement ? [["结算状态", <Badge key="s" text={settlement.status === "confirmed" ? "已结算" : "结算中"} cls={badgeClass(String(settlement.status))} />] as [string, React.ReactNode]] : []),
              ]} />
            </div>
          </Section>
        )}
      </div>

      <div className="grid cols-2">
        <Section title="意见反馈（影响护理师排班与中心口碑）">
          <DataForm compact action="feedbacks.create" hidden={{ stayId }}
            fields={[
              { name: "rating", label: "评分", type: "select", required: true, options: [5, 4, 3, 2, 1].map((n) => ({ value: String(n), label: "★".repeat(n) })) },
              { name: "content", label: "反馈内容", type: "textarea", required: true },
            ]} submitLabel="提交反馈" />
          <div className="mt8">
            <DataTable cols={["时间", "评分", "内容", "中心回复"]} empty="暂无反馈"
              rows={feedbacks.map((f) => [
                <span key="t" className="small">{dt(f.created_at)}</span>,
                <span key="r" className={Number(f.rating) <= 2 ? "badge red" : "badge green"}>{"★".repeat(Number(f.rating))}</span>,
                String(f.content),
                <span key="resp" className="small">{String(f.response || "待回复")}</span>,
              ])} />
          </div>
        </Section>

        <Section title="与中心沟通">
          <DataForm compact action="messages.create" hidden={{ stayId }}
            fields={[{ name: "content", label: "留言内容", type: "textarea", required: true, placeholder: "如：想咨询明天增加一次探访" }]}
            submitLabel="发送留言" />
          <ul className="timeline mt8">
            {messages.map((m) => (
              <li key={String(m.id)}>
                <span className="t-time">{dt(m.created_at)}</span>
                <b>{String(m.from_name)}</b>：{String(m.content)}
              </li>
            ))}
          </ul>
        </Section>
      </div>
    </AppShell>
  );
}
