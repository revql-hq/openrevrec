import { useEffect, useState } from "react";
import { CircleCheck, LoaderCircle, TerminalSquare } from "lucide-react";
import type { ViewProps } from "./App";
import type { View } from "./types";
import { api, money, monthLabel, post, total } from "./api";
import {
  Button,
  Empty,
  ErrorMessage,
  ExportButton,
  Field,
  Section,
  Tag,
} from "./components";

type Check = {
  id: string;
  label: string;
  status: "pass" | "review" | "block";
  detail: string;
  count: number;
  target: { view: View; id?: string; tab?: string; obligation_id?: string };
};
type Rollforward = {
  contract_id: string;
  contract_name: string;
  opening_contract_asset: string;
  opening_deferred_revenue: string;
  revenue: string;
  billings: string;
  closing_contract_asset: string;
  closing_deferred_revenue: string;
};
type Billing = {
  contract_id: string;
  contract_name: string;
  revenue: string;
  billings: string;
  net_movement: string;
  closing_contract_asset: string;
  closing_deferred_revenue: string;
};
type Coverage = {
  contract_id: string;
  contract_name: string;
  remaining_revenue: string;
  future_scheduled: string;
  unscheduled: string;
  status: "covered" | "gap";
  obligation_gaps: { obligation_id: string; name: string; unscheduled: string }[];
};
type Impact = {
  scenario_id: string;
  name: string;
  base_version: number;
  main_version: number;
  behind: boolean;
  period_revenue_delta: string;
  transaction_price_delta: string;
  remaining_revenue_delta: string;
  affected_periods: string[];
};
export type Review = {
  period: string;
  scenario_id: string;
  status: "ready" | "review" | "blocked" | "closed";
  checks: Check[];
  warnings: string[];
  rollforward: Rollforward[];
  billing_vs_revenue: Billing[];
  recognition_coverage: Coverage[];
  scenario_impacts: Impact[];
  external_control?: { period: string; source_name: string; rationale: string; billings: string; contract_asset: string; deferred_revenue: string; close_cutoff_date?: string; recorded_at: string } | null;
  external_control_comparison: Record<string, { derived: string; external: string; difference: string }>;
  population_manifest?: { change_set_id?: string; source_name: string; rationale: string; contract_references: string[]; billing_references: { contract_reference: string; invoice_reference: string; amount?: string }[]; usage_references?: { contract_reference: string; usage_reference: string; quantity?: string; invoice_value?: string }[]; opening_positions?: { contract_reference: string; cutover_date: string; billed_to_date: string; contract_asset: string; deferred_revenue: string; recognized_to_date: string }[]; opening_obligations?: { contract_reference: string; cutover_date: string; obligation_id: string; recognized_to_date: string }[] } | null;
  population_comparison: {
    expected_contract_count: number; actual_contract_count: number; expected_billing_count: number; actual_billing_count: number;
    expected_usage_count?: number; actual_usage_count?: number;
    missing_contracts: string[]; unexpected_contracts: string[]; duplicate_contracts: string[];
    unidentified_contracts: { id: string; name: string }[];
    missing_billings: [string, string][]; unexpected_billings: [string, string][]; duplicate_billings: [string, string][];
    unidentified_billings: { contract_id: string; activity_id: string }[];
    unverified_billings?: [string, string][];
    mismatched_billings?: { contract_reference: string; invoice_reference: string; source_amount: string; workspace_amount: string; activity_id: string }[];
    missing_usage?: [string, string][]; unexpected_usage?: [string, string][]; duplicate_usage?: [string, string][];
    unidentified_usage?: { contract_id: string; activity_id: string }[];
    unverified_usage?: [string, string][];
    mismatched_usage?: { contract_reference: string; usage_reference: string; source_quantity: string; workspace_quantity: string; source_invoice_value: string; workspace_invoice_value: string; activity_id: string }[];
    source_openings_supplied?: boolean; expected_opening_count?: number; actual_opening_count?: number;
    missing_openings?: [string, string][]; unexpected_openings?: [string, string][]; duplicate_openings?: [string, string][]; unverified_openings?: [string, string][];
    unidentified_openings?: { contract_id: string; activity_id: string }[];
    mismatched_openings?: { contract_reference: string; cutover_date: string; source_values: Record<string, string>; workspace_values: Record<string, string>; activity_id: string }[];
    expected_opening_obligation_count?: number;
    missing_opening_obligations?: [string, string, string][]; unexpected_opening_obligations?: [string, string, string][]; unverified_opening_obligations?: [string, string][];
    mismatched_opening_obligations?: { contract_reference: string; cutover_date: string; obligation_id: string; source_amount: string; workspace_amount: string; activity_id: string }[];
    mismatched_source_opening_obligation_totals?: { contract_reference: string; cutover_date: string; source_total: string; source_opening_total: string }[];
  };
  exceptions: { evidence: { change_set_id: string; entity_name: string; command: string; review_status: string; linked_file_count: number }[]; warnings: { message: string; contract_id: string | null; obligation_id: string | null; related_contract_id: string | null }[] };
  counts: {
    contracts: number;
    open_tasks: number;
    due_tasks: number;
    coverage_gaps: number;
    active_scenarios: number;
    warnings: number;
    late_changes: number;
  };
};

const views = [
  "Close readiness",
  "Accounting warnings",
  "Contract balance rollforward",
  "Billing vs revenue",
  "External controls",
  "Source population",
  "Recognition coverage",
  "Scenario impact",
  "SQL inspector",
] as const;
type ReportView = (typeof views)[number];

export function ReportsWorkspace(props: ViewProps) {
  const { state, period } = props;
  const [view, setView] = useState<ReportView>(views.some((name) => name === props.tab) ? props.tab as ReportView : "Close readiness"),
    [review, setReview] = useState<Review | null>(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true);
  useEffect(() => {
    if (views.some((name) => name === props.tab)) setView(props.tab as ReportView);
  }, [props.tab]);
  useEffect(() => {
    let canceled = false;
    setLoading(true);
    setReview(null);
    api<Review>(
      `/api/reports?scenario_id=${encodeURIComponent(state.scenario_id)}&period=${period}`,
    )
      .then((value) => {
        if (!canceled) {
          setReview(value);
          setError("");
        }
      })
      .catch((e) => {
        if (!canceled) setError(e.message);
      })
      .finally(() => {
        if (!canceled) setLoading(false);
      });
    return () => {
      canceled = true;
    };
  }, [state.scenario_id, state.frontier, period]);
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>Reports</h1>
          <p>
            Prebuilt views for period review, reconciliation, and open
            accounting questions.
          </p>
        </div>
        <div className="button-group">
          <ExportButton scenario={state.scenario_id} period={period} />
          <a className="button" href={`/api/export-package?scenario_id=${encodeURIComponent(state.scenario_id)}&period=${period}`} download>Download support package</a>
        </div>
      </div>
      <div className="report-tabs" role="tablist" aria-label="Reports">
        {views.map((name) => (
          <button
            key={name}
            role="tab"
            aria-selected={view === name}
            className={view === name ? "active" : ""}
            onClick={() => { setView(name); props.navigate("Reports", undefined, name); }}
          >
            {name}
          </button>
        ))}
      </div>
      <ErrorMessage error={error} />
      {loading && !review ? (
        <div className="inline-loading">
          <LoaderCircle className="spin" size={16} />
          Preparing reports…
        </div>
      ) : (
        review && <ReportContent review={review} view={view} props={props} />
      )}
    </>
  );
}

function ExternalControls({ review, props }: { review: Review; props: ViewProps }) {
  const [sourceName, setSourceName] = useState(review.external_control?.source_name || "");
  const [rationale, setRationale] = useState(review.external_control?.rationale || "");
  const [billings, setBillings] = useState(review.external_control?.billings || "");
  const [asset, setAsset] = useState(review.external_control?.contract_asset || "");
  const [deferred, setDeferred] = useState(review.external_control?.deferred_revenue || "");
  const [cutoff, setCutoff] = useState(review.external_control?.close_cutoff_date || "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const fields = [
    ["billings", "Source billing total"],
    ["contract_asset", "Contract asset GL balance"],
    ["deferred_revenue", "Deferred revenue GL balance"],
  ] as const;
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await post("/api/commands", { command: "record_control_totals", scenario_id: "main", period: props.period, payload: { period: props.period, source_name: sourceName, rationale, billings, contract_asset: asset, deferred_revenue: deferred, ...(cutoff ? { close_cutoff_date: cutoff } : {}) } });
      await props.refresh("External controls recorded.");
    } catch (caught) { setError((caught as Error).message); }
    finally { setBusy(false); }
  };
  return <Section title="Independent source and GL controls" subtitle="Compare the model to totals prepared outside OpenRevRec on the same accounting basis. A match checks agreement, not completeness or classification.">
    <p className="muted">The billing total is for {monthLabel(props.period)}. Asset and deferred balances are ending balances. Enter the corresponding external totals and retain the source name and review explanation.</p>
    {review.external_control && <div className="table-wrap"><table><thead><tr><th>Measure</th><th className="number">Model</th><th className="number">External</th><th className="number">Difference</th></tr></thead><tbody>{fields.map(([key, label]) => <tr key={key}><td>{label}</td><td className="number">{money(review.external_control_comparison[key]?.derived, props.state.workspace.currency)}</td><td className="number">{money(review.external_control_comparison[key]?.external, props.state.workspace.currency)}</td><td className="number">{money(review.external_control_comparison[key]?.difference, props.state.workspace.currency)}</td></tr>)}</tbody></table></div>}
    {props.state.scenario_id === "main" && !props.state.report.closed ? <form onSubmit={(event) => void submit(event)}>
      <div className="form-grid"><Field label="External source name"><input required value={sourceName} onChange={(event) => setSourceName(event.target.value)} placeholder="ERP report or billing extract" /></Field><Field label="Review explanation"><input required value={rationale} onChange={(event) => setRationale(event.target.value)} placeholder="Identify the extract and reconciliation basis" /></Field></div>
      <div className="form-grid"><Field label="Source billings"><input required type="number" step="0.01" value={billings} onChange={(event) => setBillings(event.target.value)} /></Field><Field label="Contract asset GL balance"><input required type="number" step="0.01" value={asset} onChange={(event) => setAsset(event.target.value)} /></Field><Field label="Deferred revenue GL balance"><input required type="number" step="0.01" value={deferred} onChange={(event) => setDeferred(event.target.value)} /></Field></div>
      <Field label="Close cutoff date" hint="Entries recorded by this date are normal close work, rather than late entries. If blank, period end is used."><input type="date" min={`${props.period}-${new Date(Number(props.period.slice(0, 4)), Number(props.period.slice(5)), 0).getDate()}`} value={cutoff} onChange={(event) => setCutoff(event.target.value)} /></Field>
      <Button primary type="submit" busy={busy}>Record controls</Button>
    </form> : <p className="notice">Controls can be entered on an open Main period. Reopen a closed period before revising them.</p>}
    <ErrorMessage error={error} />
  </Section>;
}

function SourcePopulation({ review, props }: { review: Review; props: ViewProps }) {
  const manifest = review.population_manifest;
  const comparison = review.population_comparison;
  const [sourceName, setSourceName] = useState(manifest?.source_name || "");
  const [rationale, setRationale] = useState(manifest?.rationale || "");
  const [contracts, setContracts] = useState((manifest?.contract_references || []).join("\n"));
  const [billings, setBillings] = useState((manifest?.billing_references || []).map((item) => `${item.contract_reference} | ${item.invoice_reference}${item.amount !== undefined ? ` | ${item.amount}` : ""}`).join("\n"));
  const [usage, setUsage] = useState((manifest?.usage_references || []).map((item) => `${item.contract_reference} | ${item.usage_reference}${item.quantity !== undefined ? ` | ${item.quantity} | ${item.invoice_value}` : ""}`).join("\n"));
  const [openings, setOpenings] = useState((manifest?.opening_positions || []).map((item) => `${item.contract_reference} | ${item.cutover_date} | ${item.billed_to_date} | ${item.contract_asset} | ${item.deferred_revenue} | ${item.recognized_to_date}`).join("\n"));
  const [openingObligations, setOpeningObligations] = useState((manifest?.opening_obligations || []).map((item) => `${item.contract_reference} | ${item.cutover_date} | ${item.obligation_id} | ${item.recognized_to_date}`).join("\n"));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError("");
    const billingReferences = [];
    for (const [index, line] of billings.split(/\r?\n/).entries()) {
      if (!line.trim()) continue;
      const divider = line.includes("\t") ? "\t" : "|";
      const parts = line.split(divider).map((part) => part.trim());
      if (![2, 3].includes(parts.length) || !parts.every(Boolean)) {
        setError(`Invoice line ${index + 1} needs contract reference | invoice reference | signed amount. Existing ID-only rows can remain for review.`);
        return;
      }
      billingReferences.push({ contract_reference: parts[0], invoice_reference: parts[1], ...(parts.length === 3 ? { amount: parts[2] } : {}) });
    }
    const usageReferences = [];
    for (const [index, line] of usage.split(/\r?\n/).entries()) {
      if (!line.trim()) continue;
      const divider = line.includes("\t") ? "\t" : "|";
      const parts = line.split(divider).map((part) => part.trim());
      if (![2, 4].includes(parts.length) || !parts.every(Boolean)) {
        setError(`Priced usage line ${index + 1} needs contract reference | usage record ID | units | invoice value. Existing ID-only rows can remain for review.`);
        return;
      }
      usageReferences.push({ contract_reference: parts[0], usage_reference: parts[1], ...(parts.length === 4 ? { quantity: parts[2], invoice_value: parts[3] } : {}) });
    }
    const openingPositions = [];
    for (const [index, line] of openings.split(/\r?\n/).entries()) {
      if (!line.trim()) continue;
      const divider = line.includes("\t") ? "\t" : "|";
      const parts = line.split(divider).map((part) => part.trim());
      if (parts.length !== 6 || !parts.every(Boolean)) {
        setError(`Opening line ${index + 1} needs contract reference | cutover date | billed to date | contract asset | deferred revenue | recognized to date.`);
        return;
      }
      openingPositions.push({ contract_reference: parts[0], cutover_date: parts[1], billed_to_date: parts[2], contract_asset: parts[3], deferred_revenue: parts[4], recognized_to_date: parts[5] });
    }
    const openingObligationRows = [];
    for (const [index, line] of openingObligations.split(/\r?\n/).entries()) {
      if (!line.trim()) continue;
      const divider = line.includes("\t") ? "\t" : "|";
      const parts = line.split(divider).map((part) => part.trim());
      if (parts.length !== 4 || !parts.every(Boolean)) {
        setError(`Opening obligation line ${index + 1} needs contract reference | cutover date | obligation ID | recognized to date.`);
        return;
      }
      openingObligationRows.push({ contract_reference: parts[0], cutover_date: parts[1], obligation_id: parts[2], recognized_to_date: parts[3] });
    }
    setBusy(true);
    try {
      await post("/api/commands", { command: "record_population_manifest", scenario_id: "main", period: props.period, payload: {
        period: props.period, source_name: sourceName, rationale,
        contract_references: contracts.split(/\r?\n/).map((item) => item.trim()).filter(Boolean), billing_references: billingReferences, usage_references: usageReferences, opening_positions: openingPositions, opening_obligations: openingObligationRows,
      } });
      await props.refresh("Source population recorded.");
    } catch (caught) { setError((caught as Error).message); }
    finally { setBusy(false); }
  };
  const groups = [
    ["Missing contracts", comparison.missing_contracts],
    ["Unexpected contracts", comparison.unexpected_contracts],
    ["Duplicate workspace contracts", comparison.duplicate_contracts],
    ["Missing invoices", comparison.missing_billings.map((item) => item.join(" / "))],
    ["Unexpected invoices", comparison.unexpected_billings.map((item) => item.join(" / "))],
    ["Duplicate workspace invoices", comparison.duplicate_billings.map((item) => item.join(" / "))],
    ["Invoice amounts not checked", (comparison.unverified_billings || []).map((item) => item.join(" / "))],
    ["Missing priced usage", (comparison.missing_usage || []).map((item) => item.join(" / "))],
    ["Unexpected priced usage", (comparison.unexpected_usage || []).map((item) => item.join(" / "))],
    ["Duplicate workspace priced usage", (comparison.duplicate_usage || []).map((item) => item.join(" / "))],
    ["Priced usage values not checked", (comparison.unverified_usage || []).map((item) => item.join(" / "))],
    ["Missing cutover openings", (comparison.missing_openings || []).map((item) => item.join(" / "))],
    ["Unexpected cutover openings", (comparison.unexpected_openings || []).map((item) => item.join(" / "))],
    ["Duplicate workspace openings", (comparison.duplicate_openings || []).map((item) => item.join(" / "))],
    ["Opening balances not checked", (comparison.unverified_openings || []).map((item) => item.join(" / "))],
    ["Missing opening obligations", (comparison.missing_opening_obligations || []).map((item) => item.join(" / "))],
    ["Unexpected opening obligations", (comparison.unexpected_opening_obligations || []).map((item) => item.join(" / "))],
    ["Opening obligation amounts not checked", (comparison.unverified_opening_obligations || []).map((item) => item.join(" / "))],
  ] as const;
  return <Section title="Source population" subtitle="Compare independent agreements, invoices, priced usage, and cutover openings with workspace records.">
    <p className="muted">Include contracts active or carrying a balance and {monthLabel(props.period)} invoices, priced usage, and cutover openings. Use the accounting contract reference for an opening position; its balance covers the combined contract if agreements were combined.</p>
    {manifest ? <>
      <p className="notice">{manifest.source_name} · Workspace/source: {comparison.actual_contract_count}/{comparison.expected_contract_count} agreements · {comparison.actual_billing_count}/{comparison.expected_billing_count} invoices · {comparison.actual_usage_count || 0}/{comparison.expected_usage_count || 0} priced usage · {comparison.actual_opening_count || 0}/{comparison.expected_opening_count || 0} cutover openings.</p>
      {groups.map(([label, items]) => items.length > 0 && <div className="check-row review" key={label}><span className="check-icon">{items.length}</span><div><strong>{label}</strong><p>{items.join(", ")}</p></div></div>)}
      {comparison.unidentified_contracts.map((item) => <div className="check-row review" key={item.id}><span className="check-icon">1</span><div><strong>Contract missing source reference</strong><p>{item.name}</p></div><Button onClick={() => props.navigate("Contracts", item.id, "Overview")}>Open</Button></div>)}
      {comparison.unidentified_billings.map((item) => <div className="check-row review" key={item.activity_id}><span className="check-icon">1</span><div><strong>Billing missing source identity</strong><p>{item.contract_id}</p></div><Button onClick={() => props.navigate("Activity", item.activity_id)}>Open</Button></div>)}
      {(comparison.mismatched_billings || []).map((item) => <div className="check-row review" key={`${item.contract_reference}:${item.invoice_reference}`}><span className="check-icon">1</span><div><strong>Invoice amount differs</strong><p>{item.contract_reference} / {item.invoice_reference}: source {money(item.source_amount, props.state.workspace.currency)}; workspace {money(item.workspace_amount, props.state.workspace.currency)}</p></div><Button onClick={() => props.navigate("Activity", item.activity_id)}>Open</Button></div>)}
      {(comparison.unidentified_usage || []).map((item) => <div className="check-row review" key={item.activity_id}><span className="check-icon">1</span><div><strong>Priced usage missing source identity</strong><p>{item.contract_id}</p></div><Button onClick={() => props.navigate("Activity", item.activity_id)}>Open</Button></div>)}
      {(comparison.mismatched_usage || []).map((item) => <div className="check-row review" key={`${item.contract_reference}:${item.usage_reference}`}><span className="check-icon">1</span><div><strong>Priced usage values differ</strong><p>{item.contract_reference} / {item.usage_reference}: source {item.source_quantity} units, {money(item.source_invoice_value, props.state.workspace.currency)}; workspace {item.workspace_quantity} units, {money(item.workspace_invoice_value, props.state.workspace.currency)}</p></div><Button onClick={() => props.navigate("Activity", item.activity_id)}>Open</Button></div>)}
      {(comparison.unidentified_openings || []).map((item) => <div className="check-row review" key={item.activity_id}><span className="check-icon">1</span><div><strong>Opening missing contract reference</strong><p>{item.contract_id}</p></div><Button onClick={() => props.navigate("Activity", item.activity_id)}>Open</Button></div>)}
      {(comparison.mismatched_openings || []).map((item) => <div className="check-row review" key={`${item.contract_reference}:${item.cutover_date}`}><span className="check-icon">1</span><div><strong>Opening balances differ</strong><p>{item.contract_reference} / {item.cutover_date}: {Object.keys(item.source_values).filter((field) => item.source_values[field] !== item.workspace_values[field]).map((field) => `${field.replaceAll("_", " ")} source ${money(item.source_values[field], props.state.workspace.currency)}, workspace ${money(item.workspace_values[field], props.state.workspace.currency)}`).join("; ")}</p></div><Button onClick={() => props.navigate("Activity", item.activity_id)}>Open</Button></div>)}
      {(comparison.mismatched_opening_obligations || []).map((item) => <div className="check-row review" key={`${item.contract_reference}:${item.cutover_date}:${item.obligation_id}`}><span className="check-icon">1</span><div><strong>Opening obligation amount differs</strong><p>{item.contract_reference} / {item.obligation_id}: source {money(item.source_amount, props.state.workspace.currency)}; workspace {money(item.workspace_amount, props.state.workspace.currency)}</p></div><Button onClick={() => props.navigate("Activity", item.activity_id)}>Open</Button></div>)}
      {(comparison.mismatched_source_opening_obligation_totals || []).map((item) => <div className="check-row review" key={`${item.contract_reference}:${item.cutover_date}:source-total`}><span className="check-icon">1</span><div><strong>Source obligation amounts do not sum to the source opening</strong><p>{item.contract_reference}: obligation sum {money(item.source_total, props.state.workspace.currency)}; opening recognized {money(item.source_opening_total, props.state.workspace.currency)}</p></div></div>)}
      {!groups.some(([, items]) => items.length) && !comparison.unidentified_contracts.length && !comparison.unidentified_billings.length && !(comparison.mismatched_billings || []).length && !(comparison.unidentified_usage || []).length && !(comparison.mismatched_usage || []).length && !(comparison.unidentified_openings || []).length && !(comparison.mismatched_openings || []).length && !(comparison.mismatched_opening_obligations || []).length && !(comparison.mismatched_source_opening_obligation_totals || []).length && <p className="notice">Every listed source record matches a workspace record.</p>}
    </> : <p className="notice">No independent source population has been recorded for this period.</p>}
    {props.state.scenario_id === "main" && !props.state.report.closed ? <form onSubmit={(event) => void submit(event)}>
      <div className="form-grid"><Field label="Independent source name"><input required value={sourceName} onChange={(event) => setSourceName(event.target.value)} placeholder="Billing extract and contract register" /></Field><Field label="Population and cutoff basis"><input required value={rationale} onChange={(event) => setRationale(event.target.value)} placeholder="Identify filters, cutoff, and source owner" /></Field></div>
      <div className="form-grid"><Field label="Source contract references" hint="One contract reference per line; leave empty only if the source population is empty."><textarea rows={8} value={contracts} onChange={(event) => setContracts(event.target.value)} /></Field><Field label="Source invoices and credits" hint="One per line: contract reference | invoice reference | signed amount. Paste three tab-separated columns or use |. Older ID-only rows stay under review until amounts are supplied."><textarea rows={8} value={billings} onChange={(event) => setBillings(event.target.value)} /></Field></div>
      <Field label="Source priced-usage records" hint="One per line: contract reference | unique usage record ID | delivered units | invoice value. Paste four tab-separated columns or use |. Older ID-only rows stay under review until values are supplied."><textarea rows={6} value={usage} onChange={(event) => setUsage(event.target.value)} /></Field>
      <Field label="Source cutover openings" hint="One per line: accounting contract reference | cutover date | billed to date | contract asset | deferred revenue | recognized to date. Paste six tab-separated columns or use |. Include only openings effective in this month; enter zero balances explicitly."><textarea rows={6} value={openings} onChange={(event) => setOpenings(event.target.value)} /></Field>
      <Field label="Source opening obligation amounts" hint="For a contract with multiple obligations, paste one line per mapped obligation: accounting contract reference | cutover date | obligation ID | recognized to date. Include zero amounts; source rows should sum to the contract's source opening total."><textarea rows={6} value={openingObligations} onChange={(event) => setOpeningObligations(event.target.value)} /></Field>
      <Button primary type="submit" busy={busy}>Record source population</Button>
    </form> : <p className="fine-print">Reopen the period to revise the accepted source population.</p>}
    <ErrorMessage error={error} />
  </Section>;
}

function WarningRows({ review, props }: { review: Review; props: ViewProps }) {
  const messageCounts = new Map<string, number>();
  review.warnings.forEach((message) => messageCounts.set(message, (messageCounts.get(message) ?? 0) + 1));
  return <div className="report-list">{review.warnings.map((warning, index) => {
    const detail = review.exceptions.warnings[index];
    const target = detail?.message === warning ? detail : null;
    return <div key={`${index}:${warning}`}>
      <span className="warning-message">{warning}
        {(messageCounts.get(warning) ?? 0) > 1 && target?.contract_id && <small>Contract ID: {target.contract_id}</small>}
      </span>
      {target?.contract_id && <Button onClick={() => props.navigate("Contracts", target.contract_id || undefined, target.obligation_id ? "Recognition" : "Overview", target.obligation_id || undefined)}>Open contract</Button>}
      {target?.related_contract_id && <Button onClick={() => props.navigate("Contracts", target.related_contract_id || undefined, "Allocation")}>Open related</Button>}
    </div>;
  })}</div>;
}

function ReportContent({
  review,
  view,
  props,
}: {
  review: Review;
  view: ReportView;
  props: ViewProps;
}) {
  const currency = props.state.workspace.currency;
  if (view === "Accounting warnings")
    return <Section title="Accounting warnings" subtitle={`${review.warnings.length} warning${review.warnings.length === 1 ? "" : "s"} for ${monthLabel(review.period)}.`} action={<Button onClick={() => props.navigate("Reports", undefined, "Close readiness")}>Review close checks</Button>}>
      {review.warnings.length > 0 ? <WarningRows review={review} props={props} /> : <Empty title="No accounting warnings">This period has no accounting warnings.</Empty>}
    </Section>;
  if (view === "Close readiness")
    return (
      <>
        <div className={`readiness-summary ${review.status}`}>
          <div>
            <span className="eyebrow">{monthLabel(review.period)} close</span>
            <h2>
              {review.status === "ready"
                ? "Ready for close"
                : review.status === "closed"
                  ? "Period closed"
                  : review.status === "blocked"
                    ? "Close blocked"
                    : "Review needed"}
            </h2>
            <p>{readinessCopy(review)}</p>
          </div>
          <div className="readiness-counts">
            <div>
              <strong>
                {review.checks.filter((c) => c.status === "pass").length}
              </strong>
              <span>Passed</span>
            </div>
            <div>
              <strong>
                {review.checks.filter((c) => c.status === "review").length}
              </strong>
              <span>Review</span>
            </div>
            <div>
              <strong>
                {review.checks.filter((c) => c.status === "block").length}
              </strong>
              <span>Blocked</span>
            </div>
          </div>
        </div>
        <Section
          title="Close checks"
          subtitle="Open each underlying view to resolve exceptions before accepting the period."
        >
          <div className="check-list">
            {review.checks.map((check) => (
              <div key={check.id} className={`check-row ${check.status}`}>
                <span className="check-icon">
                  {check.status === "pass" ? (
                    <CircleCheck size={16} />
                  ) : (
                    check.count
                  )}
                </span>
                <div>
                  <strong>{check.label}</strong>
                  <p>{check.detail}</p>
                </div>
                <Tag tone={check.status === "pass" ? "closed" : "warning"}>
                  {check.status}
                </Tag>
                <Button onClick={() => props.navigate(check.target.view, check.target.id, check.target.tab, check.target.obligation_id)}>Open</Button>
              </div>
            ))}
          </div>
        </Section>
        {review.exceptions.evidence.length > 0 && <Section title="Judgments needing review">
          <div className="changes-list">{review.exceptions.evidence.map((item) => <div className="change-row support-row" key={item.change_set_id}>
            <div><strong>{item.entity_name}</strong><span>{item.command.replaceAll("_", " ")} · {item.review_status === "exception" ? "open exception" : "review missing"} · {item.linked_file_count} linked file(s)</span></div>
            <Button onClick={() => props.navigate("Activity", item.change_set_id)}>Review change</Button>
          </div>)}</div>
        </Section>}
        {review.warnings.length > 0 && (
          <Section title="Accounting warnings">
            <WarningRows review={review} props={props} />
          </Section>
        )}
      </>
    );
  if (view === "Contract balance rollforward")
    return (
      <Section
        title="Contract balance rollforward"
        subtitle="Opening balance plus revenue less billings equals the closing contract asset or deferred revenue."
      >
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Contract</th>
                <th className="number">Opening asset</th>
                <th className="number">Opening deferred</th>
                <th className="number">Revenue</th>
                <th className="number">Billings</th>
                <th className="number">Closing asset</th>
                <th className="number">Closing deferred</th>
              </tr>
            </thead>
            <tbody>
              {review.rollforward.map((row) => (
                <tr key={row.contract_id}>
                  <td>
                    <button
                      className="table-link strong"
                      onClick={() =>
                        props.navigate("Contracts", row.contract_id, "Overview")
                      }
                    >
                      {row.contract_name}
                    </button>
                  </td>
                  <Amount
                    value={row.opening_contract_asset}
                    currency={currency}
                  />
                  <Amount
                    value={row.opening_deferred_revenue}
                    currency={currency}
                  />
                  <Amount value={row.revenue} currency={currency} />
                  <Amount value={row.billings} currency={currency} />
                  <Amount
                    value={row.closing_contract_asset}
                    currency={currency}
                  />
                  <Amount
                    value={row.closing_deferred_revenue}
                    currency={currency}
                  />
                </tr>
              ))}
            </tbody>
            {review.rollforward.length > 0 && (
              <tfoot>
                <tr>
                  <th>Total</th>
                  {(
                    [
                      "opening_contract_asset",
                      "opening_deferred_revenue",
                      "revenue",
                      "billings",
                      "closing_contract_asset",
                      "closing_deferred_revenue",
                    ] as const
                  ).map((key) => (
                    <th className="number" key={key}>
                      {money(
                        total(review.rollforward.map((row) => row[key])),
                        currency,
                      )}
                    </th>
                  ))}
                </tr>
              </tfoot>
            )}
          </table>
          {!review.rollforward.length && (
            <Empty title="No contract balances">
              Create a contract to produce a rollforward.
            </Empty>
          )}
        </div>
      </Section>
    );
  if (view === "External controls") return <ExternalControls key={review.period} review={review} props={props} />;
  if (view === "Source population") return <SourcePopulation key={`${review.period}:${review.population_manifest?.change_set_id || ""}`} review={review} props={props} />;
  if (view === "Billing vs revenue")
    return (
      <Section
        title="Billing vs revenue"
        subtitle="Shows period timing differences and the resulting contract position."
      >
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Contract</th>
                <th className="number">Revenue</th>
                <th className="number">Billings</th>
                <th className="number">Net movement</th>
                <th className="number">Contract asset</th>
                <th className="number">Deferred revenue</th>
              </tr>
            </thead>
            <tbody>
              {review.billing_vs_revenue.map((row) => (
                <tr key={row.contract_id}>
                  <td>
                    <button
                      className="table-link strong"
                      onClick={() =>
                        props.navigate("Contracts", row.contract_id, "Billing")
                      }
                    >
                      {row.contract_name}
                    </button>
                  </td>
                  <Amount value={row.revenue} currency={currency} />
                  <Amount value={row.billings} currency={currency} />
                  <Amount
                    value={row.net_movement}
                    currency={currency}
                    emphasis
                  />
                  <Amount
                    value={row.closing_contract_asset}
                    currency={currency}
                  />
                  <Amount
                    value={row.closing_deferred_revenue}
                    currency={currency}
                  />
                </tr>
              ))}
            </tbody>
            {review.billing_vs_revenue.length > 0 && (
              <tfoot>
                <tr>
                  <th>Total</th>
                  {(
                    [
                      "revenue",
                      "billings",
                      "net_movement",
                      "closing_contract_asset",
                      "closing_deferred_revenue",
                    ] as const
                  ).map((key) => (
                    <th className="number" key={key}>
                      {money(
                        total(review.billing_vs_revenue.map((row) => row[key])),
                        currency,
                      )}
                    </th>
                  ))}
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </Section>
    );
  if (view === "Recognition coverage")
    return (
      <Section
        title="Recognition coverage"
        subtitle="Compares remaining revenue with the future schedule. Gaps identify obligations that need future satisfaction activity or a reviewed recognition date."
      >
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Contract</th>
                <th>Status</th>
                <th className="number">Remaining revenue</th>
                <th className="number">Future scheduled</th>
                <th className="number">Unscheduled</th>
              </tr>
            </thead>
            <tbody>
              {review.recognition_coverage.map((row) => (
                <tr key={row.contract_id}>
                  <td>
                    <button
                      className="table-link strong"
                      onClick={() =>
                        props.navigate("Contracts", row.contract_id, "Recognition", row.obligation_gaps[0]?.obligation_id)
                      }
                    >
                      {row.contract_name}
                    </button>
                    {row.obligation_gaps.length > 0 && <small className="cell-subtitle">{row.obligation_gaps.map((item) => item.name).join(", ")}</small>}
                  </td>
                  <td>
                    <Tag tone={row.status === "covered" ? "closed" : "warning"}>
                      {row.status}
                    </Tag>
                  </td>
                  <Amount value={row.remaining_revenue} currency={currency} />
                  <Amount value={row.future_scheduled} currency={currency} />
                  <Amount
                    value={row.unscheduled}
                    currency={currency}
                    emphasis={row.status === "gap"}
                  />
                </tr>
              ))}
            </tbody>
            {review.recognition_coverage.length > 0 && (
              <tfoot>
                <tr>
                  <th colSpan={2}>Total</th>
                  {(
                    [
                      "remaining_revenue",
                      "future_scheduled",
                      "unscheduled",
                    ] as const
                  ).map((key) => (
                    <th className="number" key={key}>
                      {money(
                        total(
                          review.recognition_coverage.map((row) => row[key]),
                        ),
                        currency,
                      )}
                    </th>
                  ))}
                </tr>
              </tfoot>
            )}
          </table>
        </div>
        <p className="fine-print">
          A gap is a planning exception, not an automatic accounting error.
          Manual progress, usage, milestone, and point-in-time obligations may
          need future activity before they can be scheduled.
        </p>
      </Section>
    );
  if (view === "Scenario impact")
    return (
      <Section
        title="Scenario impact queue"
        subtitle="Active proposals compared with Main for the selected period and the full recognition schedule."
      >
        {review.scenario_impacts.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Scenario</th>
                  <th>Status</th>
                  <th className="number">Period revenue change</th>
                  <th className="number">Transaction price change</th>
                  <th className="number">Remaining revenue change</th>
                  <th>Affected periods</th>
                </tr>
              </thead>
              <tbody>
                {review.scenario_impacts.map((row) => (
                  <tr key={row.scenario_id}>
                    <td>
                      <button
                        className="table-link strong"
                        onClick={() =>
                          props.navigate("Scenarios", row.scenario_id)
                        }
                      >
                        {row.name}
                      </button>
                      <small className="cell-subtitle">
                        Based on Main v{row.base_version}
                      </small>
                    </td>
                    <td>
                      <Tag tone={row.behind ? "warning" : "closed"}>
                        {row.behind ? "Rebase needed" : "Current"}
                      </Tag>
                    </td>
                    <Amount
                      value={row.period_revenue_delta}
                      currency={currency}
                      emphasis
                    />
                    <Amount
                      value={row.transaction_price_delta}
                      currency={currency}
                      emphasis
                    />
                    <Amount
                      value={row.remaining_revenue_delta}
                      currency={currency}
                      emphasis
                    />
                    <td>
                      {row.affected_periods.length
                        ? row.affected_periods.join(", ")
                        : "No revenue timing change"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty title="No active scenarios">
            Create a scenario to review proposed accounting changes alongside
            Main.
          </Empty>
        )}
      </Section>
    );
  return <SqlInspector />;
}

function Amount({
  value,
  currency,
  emphasis = false,
}: {
  value: string;
  currency: string;
  emphasis?: boolean;
}) {
  return (
    <td
      className={`number ${emphasis && Number(value) !== 0 ? "emphasis" : ""}`}
    >
      {Number(value) === 0 ? "—" : money(value, currency)}
    </td>
  );
}
function readinessCopy(review: Review) {
  if (review.status === "closed")
    return "The accepted checkpoint is preserved. These checks describe the closed result.";
  if (review.status === "blocked")
    return "Resolve the reconciliation failures before closing the period.";
  if (review.status === "review")
    return "The accounting ties, but open questions still need a reviewer.";
  return "Core reconciliations pass and no open review items remain.";
}
function SqlInspector() {
  const [query, setQuery] = useState(
      "SELECT scenario_id, activity_type, contract_id, effective_date, recorded_at\nFROM accounting_activity\nORDER BY recorded_at DESC\nLIMIT 25",
    ),
    [result, setResult] = useState<{
      columns: string[];
      rows: unknown[][];
      truncated: boolean;
    } | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    setError("");
    try {
      setResult(await post("/api/sql", { query }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section
      title="SQL inspector"
      subtitle="Run a custom read-only view. Results are limited to 1,000 rows."
    >
      <textarea
        className="sql-editor"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        spellCheck={false}
      />
      <div className="button-group sql-actions">
        <Button primary onClick={run} busy={busy}>
          <TerminalSquare size={14} />
          Run query
        </Button>
      </div>
      <ErrorMessage error={error} />
      {result && (
        <div className="table-wrap sql-results">
          <table>
            <thead>
              <tr>
                {result.columns.map((column) => (
                  <th key={column}>{column}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {result.rows.map((row, i) => (
                <tr key={i}>
                  {row.map((cell, j) => (
                    <td key={j} className="mono">
                      {cell === null
                        ? "NULL"
                        : typeof cell === "object"
                          ? JSON.stringify(cell)
                          : String(cell)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {result.truncated && (
            <p className="fine-print">Showing the first 1,000 rows.</p>
          )}
        </div>
      )}
    </Section>
  );
}
