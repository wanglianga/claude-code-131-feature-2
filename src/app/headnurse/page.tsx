import Link from "next/link";
import { q } from "@/lib/db";
import { requireUser } from "@/lib/guard";
import { AppShell, Section, DataTable, Badge } from "@/components/ui";
import { DataForm } from "@/components/client";
import { EX_TYPES, EX_STATUS, SEVERITY, dt, badgeClass, severityClass } from "@/lib/labels";

export const dynamic = "force-dynamic";

export default async function HeadNursePage() {
  await requireUser(["head_nurse", "admin"]);
  const exceptions = q(
    `SELECT e.*, r.number, s.mother_name FROM exceptions e
     JOIN stays s ON s.id=e.stay_id JOIN rooms r ON r.id=s.room_id
     WHERE e.status IN ('open','processing') ORDER BY
       CASE e.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, e.created_at DESC`);
  const disputes = q(
    `SELECT e.*, r.number, s.mother_name FROM exceptions e
     JOIN stays s ON s.id=e.stay_id JOIN rooms r ON r.id=s.room_id
     WHERE e.synced_head_nurse=1 ORDER BY e.status='open' DESC, e.created_at DESC LIMIT 10`);
  const feedbacks = q(
    `SELECT f.*, r.number, s.mother_name FROM feedbacks f
     JOIN stays s ON s.id=f.stay_id JOIN rooms r ON r.id=s.room_id
     ORDER BY f.status='new' DESC, f.created_at DESC LIMIT 10`);
  const leaves = q(
    `SELECT e.*, r.number FROM exceptions e JOIN stays s ON s.id=e.stay_id JOIN rooms r ON r.id=s.room_id
     WHERE e.type='matron_leave' AND e.status IN ('open','processing')`);
  const matrons = q("SELECT id,name FROM users WHERE active=1 AND role IN ('matron','nurse')");
  const inStays = q(
    `SELECT s.id, r.number, s.mother_name FROM stays s JOIN rooms r ON r.id=s.room_id
     WHERE s.status='in_stay' ORDER BY r.number`);
  const followUps = q(
    `SELECT f.*, r.number, s.mother_name FROM follow_ups f
     JOIN stays s ON s.id=f.stay_id JOIN rooms r ON r.id=s.room_id
     WHERE f.status='pending' ORDER BY f.scheduled_at LIMIT 10`);
  // 撤回授权时探访人已入场 → 护士长现场协调
  const escalations = q(
    `SELECT a.*, r.number FROM visit_authorizations a
     JOIN stays s ON s.id=a.stay_id JOIN rooms r ON r.id=s.room_id
     WHERE a.escalated_head_nurse=1 AND a.status='revoked'
       AND EXISTS (SELECT 1 FROM door_access da JOIN visits v ON v.id=da.visit_id
                   WHERE v.authz_id=a.id AND da.status='entered')
     ORDER BY a.revoked_at DESC`);
  // 已闭环但异常（进出不配对/未避让），或已离场未闭环
  const visitIssues = q(
    `SELECT v.*, r.number FROM visits v JOIN stays s ON s.id=v.stay_id JOIN rooms r ON r.id=s.room_id
     WHERE (v.closed=1 AND (v.closed_result LIKE '%不配对%' OR v.closed_result LIKE '%未避让%'))
        OR (v.closed=0 AND v.left_at IS NOT NULL)
     ORDER BY v.id DESC LIMIT 10`);

  return (
    <AppShell title="护士长工作台">
      <div className="grid cols-4">
        <div className="stat"><div className="num">{exceptions.length}</div><div className="label">待处理异常工单</div></div>
        <div className="stat"><div className="num">{disputes.filter((d) => d.status === "open").length}</div><div className="label">同步我的争议/质疑</div></div>
        <div className="stat"><div className="num">{escalations.length}</div><div className="label">撤回授权在场待协调</div></div>
        <div className="stat"><div className="num">{visitIssues.length}</div><div className="label">探访闭环异常</div></div>
      </div>

      {escalations.length > 0 && (
        <Section title="🚨 产妇撤回授权 · 探访人仍在场（升级协调）" tone="tone-red">
          <DataTable cols={["房间", "探访人", "撤回原因", "现场协调处置"]} empty="暂无"
            rows={escalations.map((a) => [
              String(a.number),
              <span key="n"><b>{String(a.visitor_name)}</b><span className="muted small">（{String(a.relation)}）</span><div className="small muted">撤回时间：{String(a.revoked_at)}</div></span>,
              <span key="r" className="small">{String(a.revoke_reason)}<div className="muted">{String(a.escalated_note || "门禁未远程失效，等待现场协调")}</div></span>,
              <DataForm key="f" compact action="authz.resolveEscalation" hidden={{ id: Number(a.id) }}
                fields={[{ name: "note", label: "协调结果", required: true, placeholder: "如：已现场沟通，探访人16:20自愿离场，门禁当场失效" }]}
                submitLabel="完成现场协调并失效门禁" />,
            ])} />
        </Section>
      )}

      {visitIssues.length > 0 && (
        <Section title="探访闭环异常（门禁进出 / 护理避让）">
          <DataTable cols={["房间", "探访人", "闭环结果", "人工核销"]} empty="暂无"
            rows={visitIssues.map((v) => [
              <Link key="r" href={`/stays/${v.stay_id}`}>{String(v.number)}</Link>,
              <span key="n">{String(v.visitor_name)}<div className="small muted">{String(v.visit_time)}</div></span>,
              <span key="c" className="small">{Number(v.closed) ? String(v.closed_result) : "已离场但未闭环，请前台补做闭环判定"}</span>,
              <DataForm key="f" compact action="visits.forceClose" hidden={{ id: Number(v.id) }}
                fields={[{ name: "note", label: "核销说明", required: true, placeholder: "如：监控核实进出正常，护理避让口头已执行，准予核销" }]}
                submitLabel="人工核销" />,
            ])} />
        </Section>
      )}

      <Section title="异常工单中心（全中心）" tone={exceptions.length ? "tone-red" : ""}>
        <DataTable cols={["房间", "类型", "标题", "严重度", "状态", "责任角色", "处理"]} empty="暂无待处理异常"
          rows={exceptions.map((e) => [
            <Link key="r" href={`/stays/${e.stay_id}`}>{String(e.number)}</Link>,
            EX_TYPES[String(e.type)] || String(e.type),
            <span key="t">{String(e.title)}<div className="muted small">{String(e.description)}</div></span>,
            <Badge key="s" text={SEVERITY[String(e.severity)] || ""} cls={severityClass(String(e.severity))} />,
            <Badge key="st" text={EX_STATUS[String(e.status)] || ""} cls={badgeClass(String(e.status))} />,
            String(e.assigned_role),
            <DataForm key="f" compact action="exceptions.update" hidden={{ id: Number(e.id) }}
              fields={[
                { name: "action", label: "操作", type: "select", required: true, options: [
                  { value: "accept", label: "受理" }, { value: "note", label: "追加记录" },
                  { value: "resolve", label: "解决" }, { value: "close", label: "关闭" }] },
                { name: "note", label: "处理说明" },
              ]} submitLabel="提交" />,
          ])} />
      </Section>

      <div className="grid cols-2">
        <Section title="退所争议 / 护理记录质疑（同步护士长）">
          <DataTable cols={["房间", "类型", "标题", "状态", "解决情况"]} empty="暂无争议"
            rows={disputes.map((e) => [
              <Link key="r" href={`/stays/${e.stay_id}`}>{String(e.number)}</Link>,
              EX_TYPES[String(e.type)] || String(e.type),
              String(e.title),
              <Badge key="st" text={EX_STATUS[String(e.status)] || ""} cls={badgeClass(String(e.status))} />,
              <span key="res" className="small">{String(e.resolution || "处理中")}</span>,
            ])} />
        </Section>

        <Section title="月嫂请假协调">
          <DataTable cols={["房间", "请假事由", "状态", "替班安排"]} empty="暂无请假"
            rows={leaves.map((e) => [
              <Link key="r" href={`/stays/${e.stay_id}`}>{String(e.number)}</Link>,
              <span key="t">{String(e.title)}<div className="muted small">{String(e.description)}</div></span>,
              <Badge key="st" text={EX_STATUS[String(e.status)] || ""} cls={badgeClass(String(e.status))} />,
              <DataForm key="f" compact action="matron.leave" hidden={{ stayId: Number(e.stay_id) }}
                fields={[
                  { name: "fromDate", label: "开始", type: "date", required: true },
                  { name: "toDate", label: "结束", type: "date", required: true },
                  { name: "reason", label: "说明", defaultValue: "替班安排" },
                  { name: "reassignTo", label: "替班人员", type: "select", options: matrons.map((m) => ({ value: String(m.id), label: String(m.name) })) },
                ]} submitLabel="改派夜间照护" />,
            ])} />
          <div className="muted small mt8">在住房间：
            {inStays.map((s) => (
              <Link key={String(s.id)} href={`/stays/${s.id}`} className="badge blue" style={{ marginRight: 6 }}>
                {String(s.number)} {String(s.mother_name)}
              </Link>
            ))}
          </div>
        </Section>
      </div>

      <div className="grid cols-2">
        <Section title="家属反馈（回复并标记是否影响排班）">
          <DataTable cols={["房间", "评分", "内容", "回复"]} empty="暂无反馈"
            rows={feedbacks.map((f) => [
              <Link key="r" href={`/stays/${f.stay_id}`}>{String(f.number)}</Link>,
              <span key="s" className={Number(f.rating) <= 2 ? "badge red" : "badge green"}>{"★".repeat(Number(f.rating))}</span>,
              <span key="c">{String(f.content)}{Number(f.affect_scheduling) ? <span className="badge amber">影响排班</span> : null}</span>,
              f.status === "new" ? (
                <DataForm key="rf" compact action="feedbacks.respond" hidden={{ id: Number(f.id) }}
                  fields={[
                    { name: "response", label: "回复内容", required: true },
                    { name: "affectScheduling", label: "影响护理师排班", type: "checkbox" },
                  ]} submitLabel="回复" />
              ) : <span key="resp" className="small">{String(f.response)}</span>,
            ])} />
        </Section>

        <Section title="出所后回访 / 母婴随访">
          <DataTable cols={["房间", "类型", "计划时间", "内容", "结果"]} empty="暂无待执行随访"
            rows={followUps.map((f) => [
              <Link key="r" href={`/stays/${f.stay_id}`}>{String(f.number)}</Link>,
              String(f.type), dt(f.scheduled_at), String(f.content),
              <DataForm key="ff" compact action="followups.done" hidden={{ id: Number(f.id) }}
                fields={[{ name: "result", label: "随访结果", required: true }]} submitLabel="完成" />,
            ])} />
        </Section>
      </div>
    </AppShell>
  );
}
