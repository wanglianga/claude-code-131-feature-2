import { redirect } from "next/navigation";
import { q, q1 } from "@/lib/db";
import { requireUser } from "@/lib/guard";
import { AppShell, Section, DataTable, KV, Badge } from "@/components/ui";
import { DataForm, ActionButton } from "@/components/client";
import {
  PLAN_TYPES, VISIT_STATUS, FEE_TYPES, AUTHZ_KIND, AUTHZ_STATUS, DOOR_STATUS,
  PLAN_DECISION, money, dt, badgeClass,
} from "@/lib/labels";

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
  const visits = showVisits ? q("SELECT * FROM visits WHERE stay_id=? ORDER BY visit_time DESC LIMIT 10", stayId) : [];
  const authorizations = showVisits
    ? q("SELECT * FROM visit_authorizations WHERE stay_id=? ORDER BY status='active' DESC, id DESC", stayId)
    : [];
  const doorEvents = showVisits
    ? q(`SELECT de.* FROM door_events de WHERE de.stay_id=? ORDER BY de.event_at DESC LIMIT 8`, stayId)
    : [];
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

      <div>
        {showVisits && (
          <Section title="探访授权与预约（授权经产妇确认后方可排期）">
            <div className="muted small mb8">
              常规授权入住时由产妇书面登记；临时来访（朋友/亲戚）须先登记临时授权并由产妇书面/线上确认。
              产妇可在探访前随时撤回：未入场家属门禁立即失效并通知前台；已入场的撤回将升级护士长现场协调。
            </div>
            <DataTable cols={["探访人", "关系", "类型", "状态", "产妇确认", "操作"]} empty="暂无授权"
              rows={authorizations.map((a) => [
                String(a.visitor_name), String(a.relation || "-"),
                AUTHZ_KIND[String(a.kind)] || String(a.kind),
                <Badge key="s" text={AUTHZ_STATUS[String(a.status)] || String(a.status)} cls={badgeClass(String(a.status === "active" ? "approved" : a.status === "pending" ? "processing" : "cancelled"))} />,
                <span key="c" className="small">{a.mother_confirmed_text ? String(a.mother_confirmed_text) : "—"}{a.revoke_reason ? <div className="badge gray">撤回：{String(a.revoke_reason)}</div> : null}{Number(a.escalated_head_nurse) ? <div className="badge red">撤回时在场·护士长协调中</div> : null}</span>,
                a.status === "pending" ? (
                  <DataForm key="cf" compact action="authz.confirm" hidden={{ id: Number(a.id) }}
                    fields={[{ name: "motherConfirmText", label: "产妇书面确认", required: true, placeholder: "如：产妇张丽微信确认同意来访" }]}
                    submitLabel="产妇确认生效" />
                ) : a.status === "active" ? (
                  <DataForm key="rv" compact action="authz.revoke" hidden={{ id: Number(a.id) }}
                    fields={[{ name: "reason", label: "撤回原因", required: true }]}
                    submitLabel="撤回授权" />
                ) : <span key="x" className="small muted">{dt(a.revoked_at || a.confirmed_at)}</span>,
              ])} />
            <details className="mt8">
              <summary className="muted">登记新的探访授权</summary>
              <DataForm compact action="authz.create" hidden={{ stayId }}
                fields={[
                  { name: "visitorName", label: "探访人姓名", required: true },
                  { name: "relation", label: "与产妇关系", placeholder: "如：朋友 / 表姐" },
                  { name: "kind", label: "授权类型", type: "select", required: true, options: [
                    { value: "routine", label: "常规授权（长期）" }, { value: "temp", label: "临时授权（单次）" }] },
                ]} submitLabel="登记（随后需产妇确认）" />
            </details>

            <div className="mt16">
              <DataForm compact action="visits.create" hidden={{ stayId }}
                fields={[
                  { name: "visitorName", label: "探访人姓名", required: true },
                  { name: "relation", label: "与产妇关系", placeholder: "如：丈夫 / 婆婆" },
                  { name: "visitTime", label: "探访时间", type: "datetime-local", required: true },
                  { name: "hours", label: "时长(小时)", type: "number", defaultValue: 2 },
                  { name: "isTemp", label: "临时增加探访", type: "checkbox" },
                ]} submitLabel="提交预约" />
            </div>
          </Section>
        )}
      </div>

      {showVisits && (
        <Section title="我的探访排期与门禁状态">
          <DataTable cols={["探访人", "时间", "状态", "方案", "门禁", "闭环结果"]} empty="暂无预约"
            rows={visits.map((v) => {
              let d: { assigned?: { start: string; end: string } | null; blockers?: string[] } = {};
              try { d = JSON.parse(String(v.plan_detail || "{}")); } catch { /* ignore */ }
              return [
                <span key="v">{String(v.visitor_name)}{Number(v.is_temp) ? <span className="badge amber">临时</span> : null}</span>,
                <span key="t" className="small">{dt(v.visit_time)}</span>,
                <span key="s">
                  <Badge text={VISIT_STATUS[String(v.status)] || ""} cls={badgeClass(String(v.status))} />
                  {Number(v.no_show) === 1 && <span className="badge red">爽约{Number(v.no_show_overridden) ? "（已覆盖）" : ""}</span>}
                </span>,
                <span key="p" className="small">
                  {v.plan_decision ? <Badge text={PLAN_DECISION[String(v.plan_decision)] || String(v.plan_decision)} cls={v.plan_decision === "blocked" || v.plan_decision === "queue" ? "badge red" : "badge blue"} /> : "待排期"}
                  {d.assigned ? <div>{d.assigned.start.slice(11)}-{d.assigned.end.slice(11)}</div> : null}
                  {d.blockers?.length ? <div className="badge red">{d.blockers.join("、")}</div> : null}
                </span>,
                <span key="g" className="small">
                  {Number(v.access_granted)
                    ? <><Badge text={v.entered_at ? (v.left_at ? "已离场" : "在场") : "门禁有效"} cls={v.left_at ? "badge gray" : "badge green"} /><div>凭证 {String(v.access_token)}</div></>
                    : <span className="muted">未下发</span>}
                </span>,
                <span key="c" className="small">{Number(v.closed) ? String(v.closed_result) : "活动结束后判定"}</span>,
              ];
            })} />
          <div className="muted small mt8">最近门禁进出记录：</div>
          <DataTable cols={["时间", "探访人", "方向", "前台操作人"]} empty="暂无进出记录"
            rows={doorEvents.map((e) => [
              dt(e.event_at), String(e.visitor_name),
              String(e.direction) === "enter" ? <span key="d" className="badge green">入场</span> : <span key="d" className="badge gray">离场</span>,
              String(e.operator_name || "-"),
            ])} />
        </Section>
      )}

      <div className="grid cols-2">
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
