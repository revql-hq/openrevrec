import { useEffect, useState } from "react";
import type { ViewProps } from "./App";
import type { Change, Evidence, Report } from "./types";
import { api, dateLabel, humanize, money } from "./api";
import { Button, ErrorMessage, JournalsTable, Section } from "./components";
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
  comparison: { summary: Record<string, string>; affected_periods: string[] };
  evidence: Evidence[];
};

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
        </dl>
        {change.rationale && <p>{change.rationale}</p>}
        {isContract && <Button onClick={() => props.navigate("Contracts", change.entity_id)}>Open contract</Button>}
      </div>
    </Section>
    <Section title={`Financial effect · ${detail.period}`} subtitle={detail.comparison.affected_periods.length ? `Affected periods: ${detail.comparison.affected_periods.join(", ")}` : "No revenue schedule change in the selected period."}>
      <div className="table-wrap"><table><thead><tr><th>Measure</th><th>Before</th><th>After</th><th>Change</th></tr></thead><tbody>
        {measures.map((key) => <tr key={key}><td>{humanize(key)}</td><td className="number">{money(before.summary[key as keyof typeof before.summary], currency)}</td><td className="number">{money(after.summary[key as keyof typeof after.summary], currency)}</td><td className="number">{money(detail.comparison.summary[key], currency)}</td></tr>)}
      </tbody></table></div>
      {(before.policy_version !== after.policy_version || before.policy_effective_period !== after.policy_effective_period) && <p className="muted">Account policy: version {before.policy_version} effective {before.policy_effective_period} → version {after.policy_version} effective {after.policy_effective_period}</p>}
    </Section>
    <Section title={isContract ? "Contract journal after change" : "Journal after change"} subtitle={`Account policy version ${after.policy_version || 1}, effective ${after.policy_effective_period || "baseline"}.`}>
      <JournalsTable rows={isContract ? after.journals.filter((row) => row.contract_id === change.entity_id) : after.journals} currency={currency} contractName={(id) => props.state.contracts.find((item) => item.id === id)?.name || id} />
    </Section>
    <EvidencePanel props={props} entityId={isContract ? change.entity_id : undefined} targetChangeSetId={change.id} scenarioId={change.scenario_id} linkedEvidence={detail.evidence} onAttached={() => setRevision((value) => value + 1)} />
    <Section title="Canonical command">
      <details><summary>View recorded payload</summary><pre className="mono">{JSON.stringify(change.payload, null, 2)}</pre></details>
    </Section>
  </>;
}
