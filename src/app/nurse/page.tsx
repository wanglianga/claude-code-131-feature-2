import Link from "next/link";
import { q, today } from "@/lib/db";
import { requireUser } from "@/lib/guard";
import { AppShell, Section, DataTable, Badge } from "@/components/ui";
import { DataForm } from "@/components/client";
import { PLAN_TYPES, TASK_STATUS, dt, badgeClass } from "@/lib/labels";

export const dynamic = "force-dynamic";

export default async function NursePage() {
  const user = await requireUser(["nurse", "matron", "head_nurse", "admin"]);
  const todayStr = today();
  const isHeadNurse = user.role === "head_nurse" || user.role === "admin";

  const myTasks = q(
    `SELECT t.*, r.number, s.mother_name, s.baby_name FROM care_tasks t
     JOIN stays s ON s.id=t.stay_id JOIN rooms r ON r.id=s.room_id
     WHERE s.status='in_stay' AND (t.assignee_id=? OR ?=1)
     ORDER BY t.status='pending' DESC, t.scheduled_at LIMIT 40`,
    user.id, isHeadNurse ? 1 : 0);
  const hostingLogs = q(
    `SELECT h.*, r.number, s.baby_name FROM hosting_logs h
     JOIN stays s ON s.id=h.stay_id JOIN rooms r ON r.id=s.room_id
     ORDER BY h.start_time DESC LIMIT 10`);
  const inStays = q(
    `SELECT s.id, s.mother_name, s.baby_name, s.jaundice_level, r.number FROM stays s
     JOIN rooms r ON r.id=s.room_id WHERE s.status='in_stay' ORDER BY r.number`);
  const avoidances = q(
    `SELECT na.*, r.number FROM nursing_avoidances na
     JOIN stays s ON s.id=na.stay_id JOIN rooms r ON r.id=s.room_id
     WHERE s.status='in_stay' AND na.status='planned'
     ORDER BY na.window_start`);

  return (
    <AppShell title={user.role === "matron" ? "月嫂工作台" : "护理工作台"}>
      <div className="grid cols-3">
        <div className="stat"><div className="num">{myTasks.filter((t) => t.status === "pending").length}</div><div className="label">待执行任务</div></div>
        <div className="stat"><div className="num">{myTasks.filter((t) => t.status === "done" && String(t.done_at || "").startsWith(todayStr)).length}</div><div className="label">今日已完成</div></div>
        <div className="stat"><div className="num">{inStays.length}</div><div className="label">在住房间</div></div>
      </div>

      <Section title="探访护理避让（与门禁方案原子联动：查房/治疗改期请回填结果）" tone={avoidances.length ? "tone-amber" : ""}>
        <DataTable cols={["房间", "避让窗口", "类型", "说明", "避让结果"]} empty="暂无待避让安排"
          rows={avoidances.map((a) => [
            <Link key="r" href={`/stays/${a.stay_id}`}>{String(a.number)}</Link>,
            <span key="t" className="small">{String(a.window_start).slice(5, 16)} ~ {String(a.window_end).slice(11, 16)}</span>,
            a.reason === "baby_care" ? <span key="y" className="badge amber">婴儿护理</span>
              : a.reason === "rounds_shift" ? <span key="y" className="badge blue">护理改期</span>
              : <span key="y" className="badge blue">探访避让</span>,
            <span key="n" className="small">{String(a.note)}</span>,
            <DataForm key="f" compact action="avoidances.update" hidden={{ id: Number(a.id) }}
              fields={[
                { name: "status", label: "结果", type: "select", required: true, options: [
                  { value: "done", label: "已按方案避让" }, { value: "missed", label: "未能避让" }] },
                { name: "result", label: "执行说明", placeholder: "如：查房提前至13:00完成" },
              ]} submitLabel="回填" />,
          ])} />
      </Section>

      <Section title={isHeadNurse ? "全部护理任务" : "我的护理任务"}>
        <DataTable cols={["房间", "时间", "任务", "状态", "执行"]} empty="暂无任务"
          rows={myTasks.map((t) => [
            <Link key="r" href={`/stays/${t.stay_id}`}>{String(t.number)}</Link>,
            <span key="t" className="small">{dt(t.scheduled_at)}</span>,
            <span key="n">{String(t.title)}
              <span className="muted small">（{PLAN_TYPES[String(t.type)] || String(t.type)} · {String(t.mother_name)}）</span>
              {t.record ? <div className="muted small">{String(t.record)}</div> : null}</span>,
            <Badge key="s" text={TASK_STATUS[String(t.status)] || ""} cls={badgeClass(String(t.status))} />,
            t.status === "pending" ? (
              <DataForm key="f" compact action="tasks.update" hidden={{ id: Number(t.id), status: "done" }}
                fields={[{ name: "record", label: "执行记录", required: true, placeholder: "如：体温正常，切口干燥" }]}
                submitLabel="完成" />
            ) : <span key="d" className="muted small">{t.done_at ? dt(t.done_at) : "-"}</span>,
          ])} />
      </Section>

      <div className="grid cols-2">
        <Section title="快速上报异常（黄疸/乳腺堵塞等）">
          <DataForm action="exceptions.create"
            fields={[
              { name: "stayId", label: "房间", type: "select", required: true, options: inStays.map((s) => ({ value: String(s.id), label: `${s.number} ${s.mother_name}（宝宝${s.baby_name}）` })) },
              { name: "type", label: "类型", type: "select", required: true, options: [
                { value: "jaundice", label: "宝宝黄疸升高" },
                { value: "breast_blockage", label: "产妇乳腺堵塞" },
                { value: "meal_taboo", label: "餐食不符合忌口" },
                { value: "matron_leave", label: "月嫂请假" },
                { value: "record_dispute", label: "家属质疑护理记录" },
                { value: "extra_visit", label: "家属临时增加探访" },
              ] },
              { name: "title", label: "标题", required: true },
              { name: "description", label: "详细描述", type: "textarea" },
              { name: "severity", label: "严重度", type: "select", required: true, options: [
                { value: "low", label: "低" }, { value: "medium", label: "中" },
                { value: "high", label: "高" }, { value: "critical", label: "紧急" }] },
            ]} submitLabel="上报异常" />
          {user.role === "matron" && (
            <div className="mt16">
              <div className="muted small">月嫂请假申请：</div>
              <DataForm compact action="matron.leave"
                fields={[
                  { name: "stayId", label: "所在房间", type: "select", required: true, options: inStays.map((s) => ({ value: String(s.id), label: `${s.number} ${s.mother_name}` })) },
                  { name: "fromDate", label: "开始日期", type: "date", required: true },
                  { name: "toDate", label: "结束日期", type: "date", required: true },
                  { name: "reason", label: "请假原因", required: true },
                ]} submitLabel="提交请假" />
            </div>
          )}
        </Section>

        <Section title="宝宝托管日志">
          <DataForm compact action="hosting.create"
            fields={[
              { name: "stayId", label: "房间", type: "select", required: true, options: inStays.map((s) => ({ value: String(s.id), label: `${s.number} 宝宝${s.baby_name}` })) },
              { name: "type", label: "类型", type: "select", options: ["托管", "夜间托管", "洗澡抚触"].map((v) => ({ value: v, label: v })) },
              { name: "startTime", label: "开始时间", type: "datetime-local", required: true },
              { name: "endTime", label: "结束时间", type: "datetime-local" },
              { name: "notes", label: "备注", placeholder: "吃奶、睡眠、排便等" },
            ]} submitLabel="登记托管" />
          <div className="mt8">
            <DataTable cols={["房间", "类型", "开始", "照护人", "备注"]} empty="暂无托管记录"
              rows={hostingLogs.map((h) => [
                String(h.number), String(h.type),
                <span key="t" className="small">{dt(h.start_time)}</span>,
                String(h.caregiver_name), String(h.notes || "-"),
              ])} />
          </div>
        </Section>
      </div>

      <Section title="在住房间黄疸监测">
        <DataTable cols={["房间", "产妇", "宝宝", "最新黄疸值", "进入房间"]}
          rows={inStays.map((s) => [
            String(s.number), String(s.mother_name), String(s.baby_name),
            <span key="j" className={Number(s.jaundice_level) >= 12 ? "badge red" : "badge green"}>{String(s.jaundice_level)} mg/dL</span>,
            <Link key="l" href={`/stays/${s.id}`}>房间360视图</Link>,
          ])} />
      </Section>
    </AppShell>
  );
}
