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
  exceptions: { evidence: { change_set_id: string; entity_name: string; command: string }[] };
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
  "Contract balance rollforward",
  "Billing vs revenue",
  "Recognition coverage",
  "Scenario impact",
  "SQL inspector",
] as const;
type ReportView = (typeof views)[number];

export function ReportsWorkspace(props: ViewProps) {
  const { state, period } = props;
  const [view, setView] = useState<ReportView>("Close readiness"),
    [review, setReview] = useState<Review | null>(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true);
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
        </div>
      </div>
      <div className="report-tabs" role="tablist" aria-label="Reports">
        {views.map((name) => (
          <button
            key={name}
            role="tab"
            aria-selected={view === name}
            className={view === name ? "active" : ""}
            onClick={() => setView(name)}
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
        {review.exceptions.evidence.length > 0 && <Section title="Judgments needing support">
          <div className="changes-list">{review.exceptions.evidence.map((item) => <div className="change-row support-row" key={item.change_set_id}>
            <div><strong>{item.entity_name}</strong><span>{item.command.replaceAll("_", " ")}</span></div>
            <Button onClick={() => props.navigate("Activity", item.change_set_id)}>Review change</Button>
          </div>)}</div>
        </Section>}
        {review.warnings.length > 0 && (
          <Section title="Accounting warnings">
            <div className="warning">
              {review.warnings.map((warning, index) => (
                <p key={index}>{warning}</p>
              ))}
            </div>
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
