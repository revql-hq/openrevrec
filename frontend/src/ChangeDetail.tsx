import { useEffect, useState } from "react";
import type { ViewProps } from "./App";
import type { Change, Evidence, JudgmentReview, Report, State } from "./types";
import { api, dateLabel, humanize, money, post } from "./api";
import { contractTerms } from "./contractTerms";
import { Button, ErrorMessage, Field, JournalsTable, Section } from "./components";
import { EvidencePanel } from "./EvidencePanel";

type Detail = {
  change: Change & {
    entity_id: string;
    entity_name: string;
    effective_date: string;
    version: number;
    source: string;
    originating_change_set_id?: string;
  };
  period: string;
  before_report: Report;
  after_report: Report;
  before_state: State;
  after_state: State;
  comparison: { summary: Record<string, string>; affected_periods: string[] };
  evidence: Evidence[];
  judgment_reviews: JudgmentReview[];
};

const JUDGMENT_COMMANDS = new Set(["create_contract", "record_opening_position", "record_right_exercise", "modify_contract", "reassess_variable_consideration", "record_adjustment", "set_policy", "reopen_period"]);

function JudgmentReviewPanel({ props, change, reviews, onRecorded }: { props: ViewProps; change: Detail["change"]; reviews: JudgmentReview[]; onRecorded: () => void }) {
  const [reviewer, setReviewer] = useState("");
  const [disposition, setDisposition] = useState<"supported" | "exception">("supported");
  const [conclusion, setConclusion] = useState("");
  const [supportMemo, setSupportMemo] = useState("");
  const [exceptionReason, setExceptionReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const review = reviews.at(-1);
  const scenario = props.state.scenarios.find((row) => row.id === change.scenario_id);
  const canRecord = scenario?.status === "active";
  const save = async () => {
    setBusy(true);
    setError("");
    try {
      await post("/api/commands", { command: "record_judgment_review", scenario_id: change.scenario_id, period: props.period,
        payload: { target_change_set_id: change.id, reviewer, disposition, conclusion, support_memo: supportMemo, ...(disposition === "exception" ? { exception_reason: exceptionReason } : {}) } });
      await props.refresh("Judgment review recorded.");
      onRecorded();
      setConclusion(""); setSupportMemo(""); setExceptionReason("");
    } catch (caught) { setError((caught as Error).message); }
    finally { setBusy(false); }
  };
  return <Section title="Judgment review" subtitle="Record the accounting conclusion and why its support is sufficient. Files are listed separately below.">
    {review ? <dl className="definition-list">
      <div><dt>Disposition</dt><dd>{humanize(review.disposition)}</dd></div>
      <div><dt>Reviewer</dt><dd>{review.reviewer}</dd></div>
      <div><dt>Conclusion</dt><dd>{review.conclusion}</dd></div>
      <div><dt>Support memo</dt><dd>{review.support_memo}</dd></div>
      {review.exception_reason && <div><dt>Open exception</dt><dd>{review.exception_reason}</dd></div>}
      <div><dt>Recorded</dt><dd>{dateLabel(review.recorded_at)}</dd></div>
    </dl> : <p className="muted">No judgment review has been recorded for this change.</p>}
    {canRecord && <div className="form-grid">
      <Field label="Reviewer"><input value={reviewer} onChange={(event) => setReviewer(event.target.value)} placeholder="Name" /></Field>
      <Field label="Disposition"><select value={disposition} onChange={(event) => setDisposition(event.target.value as "supported" | "exception")}><option value="supported">Supported</option><option value="exception">Open exception</option></select></Field>
      <Field label="Accounting conclusion"><textarea value={conclusion} onChange={(event) => setConclusion(event.target.value)} placeholder="State the accounting conclusion" /></Field>
      <Field label="Basis and support"><textarea value={supportMemo} onChange={(event) => setSupportMemo(event.target.value)} placeholder="Explain the contract terms, analysis, or evidence used" /></Field>
      {disposition === "exception" && <Field label="Why this remains open"><textarea value={exceptionReason} onChange={(event) => setExceptionReason(event.target.value)} /></Field>}
      <Button primary busy={busy} disabled={!reviewer.trim() || !conclusion.trim() || !supportMemo.trim() || (disposition === "exception" && !exceptionReason.trim())} onClick={save}>Record review</Button>
    </div>}
    <ErrorMessage error={error} />
  </Section>;
}

export function ChangeDetail(props: ViewProps & { changeSetId: string }) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let canceled = false;
    setDetail(null);
    api<Detail>(`/api/changes/${encodeURIComponent(props.changeSetId)}?period=${props.period}`)
      .then((result) => {
        if (!canceled) {
          setDetail(result);
          setError("");
        }
      })
      .catch((caught) => {
        if (!canceled) setError((caught as Error).message);
      });
    return () => { canceled = true; };
  }, [props.changeSetId, props.period, revision]);

  if (!detail) return <><ErrorMessage error={error} />{!error && <p className="muted">Loading change…</p>}</>;
  const { change, before_report: before, after_report: after } = detail;
  const currency = props.state.workspace.currency;
  const measures = ["revenue", "billings", "deferred_revenue", "contract_asset", "remaining_revenue", "transaction_price"];
  const isContract = props.state.contracts.some((item) => item.id === change.entity_id);
  const policyPeriod = (value?: string) => value === "0001-01" || !value ? "workspace start" : value;
  const beforeContract = detail.before_state.contracts.find((item) => item.id === change.entity_id);
  const afterContract = detail.after_state.contracts.find((item) => item.id === change.entity_id);
  const beforeTerms = beforeContract ? contractTerms(beforeContract, change.effective_date) : undefined;
  const afterTerms = afterContract ? contractTerms(afterContract, change.effective_date) : undefined;
  const termRows: { area: string; item: string; before: string; after: string }[] = [];
  const describeComponent = (item: NonNullable<typeof beforeTerms>["consideration"][number] | undefined) => item ? [
    item.label, humanize(item.kind), `${item.amount} gross`, `${item.included_amount ?? item.amount} included`,
    ...(item.allocation_scope === "specific" ? [`targets ${item.target_obligation_ids?.join(", ") || "—"}`, ...(item.target_period ? [`service month ${item.target_period}`] : []), `basis ${item.allocation_rationale || "—"}`] : []),
  ].join(" · ") : "—";
  const describeObligation = (item: NonNullable<typeof beforeTerms>["obligations"][number] | undefined) => item ? `${item.name} · ${humanize(item.kind)} · ${humanize(item.method)} · SSP ${item.ssp} · ${item.start_date} to ${item.end_date}` : "—";
  for (const id of new Set([...(beforeTerms?.consideration || []).map((item) => item.id), ...(afterTerms?.consideration || []).map((item) => item.id)])) {
    const prior = describeComponent(beforeTerms?.consideration.find((item) => item.id === id));
    const next = describeComponent(afterTerms?.consideration.find((item) => item.id === id));
    if (prior !== next) termRows.push({ area: "Consideration", item: id, before: prior, after: next });
  }
  for (const id of new Set([...(beforeTerms?.obligations || []).map((item) => item.id), ...(afterTerms?.obligations || []).map((item) => item.id)])) {
    const prior = describeObligation(beforeTerms?.obligations.find((item) => item.id === id));
    const next = describeObligation(afterTerms?.obligations.find((item) => item.id === id));
    if (prior !== next) termRows.push({ area: "Obligation", item: id, before: prior, after: next });
  }
  const correctedActivity = change.command === "correct_activity" ? beforeContract?.activities.find((item) => item.id === change.payload?.target_change_set_id) : undefined;
  const replacement = change.command === "correct_activity" ? change.payload?.replacement as Record<string, unknown> | undefined : undefined;
  return <>
    <div className="page-heading">
      <div>
        <span className="eyebrow">Change set {change.version}</span>
        <h1>{humanize(change.command || "change")}</h1>
        <p>{change.entity_name}</p>
      </div>
      <Button onClick={() => props.navigate("Activity")}>All activity</Button>
    </div>
    <Section title="Recorded decision">
      <div className="change-decision">
        <dl className="definition-list">
          <div><dt>Effective</dt><dd>{dateLabel(change.effective_date)}</dd></div>
          <div><dt>Recorded</dt><dd>{dateLabel(change.recorded_at)}</dd></div>
          <div><dt>Scenario</dt><dd>{change.scenario_id === "main" ? "Main" : props.state.scenarios.find((s) => s.id === change.scenario_id)?.name || change.scenario_id}</dd></div>
          <div><dt>Source</dt><dd>{change.source}</dd></div>
          {Boolean(change.payload?.treatment) && <div><dt>Treatment</dt><dd>{humanize(String(change.payload?.treatment))}</dd></div>}
          {change.originating_change_set_id && <div><dt>Originating change</dt><dd><button className="text-button" onClick={() => props.navigate("Activity", change.originating_change_set_id)}>{change.originating_change_set_id}</button></dd></div>}
          {typeof change.payload?.target_change_set_id === "string" && <div><dt>Corrects</dt><dd><button className="text-button" onClick={() => props.navigate("Activity", String(change.payload?.target_change_set_id))}>{String(change.payload?.target_change_set_id)}</button></dd></div>}
          {typeof change.payload?.applies_to_change_set_id === "string" && <div><dt>Credit applies to</dt><dd><button className="text-button" onClick={() => props.navigate("Activity", String(change.payload?.applies_to_change_set_id))}>{String(change.payload?.applies_to_change_set_id)}</button></dd></div>}
          {typeof change.payload?.applies_to_reference === "string" && <div><dt>External original invoice</dt><dd>{String(change.payload.applies_to_reference)}</dd></div>}
        </dl>
        {change.rationale && <p>{change.rationale}</p>}
        {isContract && <Button onClick={() => props.navigate("Contracts", change.entity_id)}>Open contract</Button>}
      </div>
    </Section>
    {termRows.length > 0 && <Section title="Contract terms changed" subtitle={`Terms immediately before and after this change, effective ${dateLabel(change.effective_date)}.`}><div className="table-wrap"><table><thead><tr><th>Area</th><th>Item</th><th>Before</th><th>After</th></tr></thead><tbody>{termRows.map((row) => <tr key={`${row.area}:${row.item}`}><td>{row.area}</td><td>{row.item}</td><td>{row.before}</td><td>{row.after}</td></tr>)}</tbody></table></div></Section>}
    {change.command === "record_opening_position" && <Section title="Accepted legacy position" subtitle="These are cumulative amounts before cutover, not current-month revenue or journal entries.">
      <dl className="definition-list">
        <div><dt>Legacy source</dt><dd>{String(change.payload?.source_name || "—")}</dd></div>
        <div><dt>Billed to date</dt><dd>{money(String(change.payload?.billed_to_date || 0), currency)}</dd></div>
        <div><dt>Contract asset</dt><dd>{money(String(change.payload?.contract_asset || 0), currency)}</dd></div>
        <div><dt>Deferred revenue</dt><dd>{money(String(change.payload?.deferred_revenue || 0), currency)}</dd></div>
      </dl>
      <div className="table-wrap"><table><thead><tr><th>Obligation</th><th className="number">Recognized before cutover</th><th className="number">Cumulative measure</th></tr></thead><tbody>{((change.payload?.opening_obligations as { obligation_id: string; recognized_to_date: string; measure?: string }[] | undefined) || []).map((row) => <tr key={row.obligation_id}><td>{afterContract?.obligations.find((item) => item.id === row.obligation_id)?.name || row.obligation_id}</td><td className="number">{money(row.recognized_to_date, currency)}</td><td className="number">{row.measure || "—"}</td></tr>)}</tbody></table></div>
    </Section>}
    {correctedActivity && replacement && <Section title="Source fact corrected"><div className="table-wrap"><table><thead><tr><th>Field</th><th>Original</th><th>Replacement</th></tr></thead><tbody>{["effective_date", "amount", "percentage", "quantity", "reference", "applies_to_change_set_id", "applies_to_reference"].filter((key) => correctedActivity[key] !== undefined || replacement[key] !== undefined).map((key) => <tr key={key}><td>{humanize(key)}</td><td>{String(correctedActivity[key] ?? "—")}</td><td>{String(replacement[key] ?? "—")}</td></tr>)}</tbody></table></div></Section>}
    <Section title={`Financial effect · ${detail.period}`} subtitle={detail.comparison.affected_periods.length ? `Affected periods: ${detail.comparison.affected_periods.join(", ")}` : "No revenue schedule change in the selected period."}>
      <div className="table-wrap"><table><thead><tr><th>Measure</th><th>Before</th><th>After</th><th>Change</th></tr></thead><tbody>
        {measures.map((key) => <tr key={key}><td>{humanize(key)}</td><td className="number">{money(before.summary[key as keyof typeof before.summary], currency)}</td><td className="number">{money(after.summary[key as keyof typeof after.summary], currency)}</td><td className="number">{money(detail.comparison.summary[key], currency)}</td></tr>)}
      </tbody></table></div>
      {(before.policy_version !== after.policy_version || before.policy_effective_period !== after.policy_effective_period) && <p className="muted">Account policy: version {before.policy_version} effective {policyPeriod(before.policy_effective_period)} → version {after.policy_version} effective {policyPeriod(after.policy_effective_period)}</p>}
    </Section>
    <Section title={isContract ? "Contract journal after change" : "Journal after change"} subtitle={`Account policy version ${after.policy_version || 1}, effective ${policyPeriod(after.policy_effective_period)}.`}>
      <JournalsTable rows={isContract ? after.journals.filter((row) => row.contract_id === change.entity_id) : after.journals} currency={currency} contractName={(id) => props.state.contracts.find((item) => item.id === id)?.name || id} />
    </Section>
    <EvidencePanel props={props} entityId={isContract ? change.entity_id : undefined} targetChangeSetId={change.id} scenarioId={change.scenario_id} linkedEvidence={detail.evidence} onAttached={() => setRevision((value) => value + 1)} />
    {JUDGMENT_COMMANDS.has(change.command || "") && <JudgmentReviewPanel props={props} change={change} reviews={detail.judgment_reviews} onRecorded={() => setRevision((value) => value + 1)} />}
    <Section title="Canonical command">
      <details><summary>View recorded payload</summary><pre className="mono">{JSON.stringify(change.payload, null, 2)}</pre></details>
    </Section>
  </>;
}
