import { useState, useEffect } from "react";
import {
  ArrowDownToLine,
  ArrowRight,
  ArrowUpRight,
  Plus,
  Check,
  CircleCheck,
  GitBranch,
  LockKeyhole,
  UnlockKeyhole,
  Search,
  FileSpreadsheet,
  Upload,
  ChevronRight,
  FileText,
  LoaderCircle,
} from "lucide-react";
import type { ViewProps } from "./App";
import {
  api,
  post,
  dateLabel,
  humanize,
  money,
  total,
  monthLabel,
  uid,
  today,
} from "./api";
import {
  Button,
  Empty,
  ErrorMessage,
  ExportButton,
  JournalsTable,
  JumpButton,
  Metrics,
  Section,
  Tag,
  DateText,
  AddButton,
} from "./components";
import type {
  Contract,
  ContractReport,
  Comparison,
  Note,
  Schedule,
} from "./types";
import { methods } from "./forms";
import { EvidencePanel } from "./EvidencePanel";
import { ChangeDetail } from "./ChangeDetail";
import { ReportsWorkspace } from "./ReportsWorkspace";

function Heading({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        <h1>{title}</h1>
        {subtitle && <p>{subtitle}</p>}
      </div>
      {children && <div className="button-group">{children}</div>}
    </div>
  );
}
function ContractTable({
  contracts,
  props,
  searchable = false,
}: {
  contracts: Contract[];
  props: ViewProps;
  searchable?: boolean;
}) {
  const [query, setQuery] = useState("");
  const { state, navigate } = props;
  const currency = state.workspace.currency;
  const filtered = contracts.filter((c) =>
    `${c.name} ${state.customers.find((customer) => customer.id === c.customer_id)?.name}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  return (
    <>
      {searchable && (
        <div className="table-toolbar">
          <div className="filter-input">
            <Search size={15} />
            <input
              aria-label="Filter contracts"
              placeholder="Filter contracts…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <span className="muted">{filtered.length} contracts</span>
        </div>
      )}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Contract</th>
              <th>Customer</th>
              <th className="number">Transaction price</th>
              <th className="number">Period revenue</th>
              <th className="number">Deferred revenue</th>
              <th className="number">Remaining</th>
              <th>Term</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((contract) => {
              const report = state.report.contracts.find(
                (c) => c.id === contract.id,
              );
              return (
                <tr key={contract.id}>
                  <td>
                    <button
                      className="table-link strong"
                      onClick={() => navigate("Contracts", contract.id)}
                    >
                      {contract.name}
                    </button>
                    <small className="cell-subtitle">
                      {contract.obligations.length} obligation
                      {contract.obligations.length === 1 ? "" : "s"}
                    </small>
                  </td>
                  <td>
                    <button
                      className="table-link"
                      onClick={() =>
                        navigate("Customers", contract.customer_id)
                      }
                    >
                      {state.customers.find(
                        (c) => c.id === contract.customer_id,
                      )?.name || "—"}
                    </button>
                  </td>
                  <td className="number">
                    {money(report?.transaction_price, currency)}
                  </td>
                  <td className="number">{money(report?.revenue, currency)}</td>
                  <td className="number">
                    {money(report?.deferred_revenue, currency)}
                  </td>
                  <td className="number">
                    {money(report?.remaining_revenue, currency)}
                  </td>
                  <td className="muted nowrap">
                    <DateText value={contract.start_date} />
                    <small className="cell-subtitle">
                      to {dateLabel(contract.end_date)}
                    </small>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {!filtered.length && (
          <Empty title={query ? "No matching contracts" : "No contracts yet"}>
            {query
              ? "Try a different name or customer."
              : "Create a contract to define your first revenue schedule."}
          </Empty>
        )}
      </div>
    </>
  );
}
function NotesList({ notes, props }: { notes: Note[]; props: ViewProps }) {
  const [error, setError] = useState("");
  const complete = async (note: Note) => {
    try {
      await post("/api/commands", {
        command: "edit_note",
        payload: { id: note.id, completed: !note.completed },
        scenario_id: props.state.scenario_id,
        period: props.period,
        idempotency_key: uid(),
      });
      await props.refresh("Task updated.");
    } catch (e) {
      setError((e as Error).message);
    }
  };
  if (!notes.length)
    return <div className="quiet-empty">No notes or tasks yet.</div>;
  return (
    <>
      <div className="notes-list">
        {notes.map((note) => (
          <div
            className={`note-row ${note.completed ? "completed" : ""}`}
            key={note.id}
          >
            {note.kind === "task" ? (
              <button
                className={`task-check ${note.completed ? "checked" : ""}`}
                aria-label={
                  note.completed ? "Mark task incomplete" : "Complete task"
                }
                onClick={() => complete(note)}
              >
                {note.completed && <Check size={13} />}
              </button>
            ) : (
              <FileText size={16} />
            )}
            <div>
              <div className="note-label">
                {humanize(note.kind)}
                {note.due_date && (
                  <span
                    className={
                      note.due_date < today() && !note.completed
                        ? "overdue"
                        : ""
                    }
                  >
                    Due {dateLabel(note.due_date)}
                  </span>
                )}
              </div>
              <p>{note.body}</p>
              {note.entity_id &&
                props.state.contracts.some((c) => c.id === note.entity_id) && (
                  <button
                    className="text-button"
                    onClick={() => props.navigate("Contracts", note.entity_id)}
                  >
                    {
                      props.state.contracts.find((c) => c.id === note.entity_id)
                        ?.name
                    }
                    <ArrowUpRight size={12} />
                  </button>
                )}
            </div>
          </div>
        ))}
      </div>
      <ErrorMessage error={error} />
    </>
  );
}
function ChangesList({
  props,
  contractId,
  limit,
}: {
  props: ViewProps;
  contractId?: string;
  limit?: number;
}) {
  const changes = [...props.state.change_sets]
    .filter(
      (c) =>
        !contractId ||
        c.payload?.contract_id === contractId ||
        c.payload?.id === contractId ||
        c.entity_id === contractId,
    )
    .slice(0, limit);
  if (!changes.length)
    return <div className="quiet-empty">No recorded changes yet.</div>;
  return (
    <div className="changes-list">
      {changes.map((change, index) => (
        <div className="change-row" key={change.id || index}>
          <span className="change-dot" />
          <div>
            <strong><button className="text-button" onClick={() => props.navigate("Activity", change.id)}>{humanize(change.command || change.type || "Accounting change")}</button></strong>
            <span>
              {String(
                change.payload?.name ||
                  change.payload?.reference ||
                  change.payload?.rationale ||
                  change.rationale ||
                  "Recorded through an accounting command",
              )}
            </span>
          </div>
          <span className="change-meta">
            <DateText value={change.created_at || change.recorded_at} />
            <small>
              {change.scenario_id === "main"
                ? "Main"
                : props.state.scenarios.find((s) => s.id === change.scenario_id)
                    ?.name || "Main"}
            </small>
          </span>
        </div>
      ))}
    </div>
  );
}
export function HomeView(props: ViewProps) {
  const { state, period, dialog, navigate } = props;
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const closes = state.closes.filter(
    (c) => c.status !== "reopened" && !c.reopened_at,
  );
  const closed = closes.some((c) => c.period === period);
  const active = state.scenarios.filter(
    (s) => s.id !== "main" && s.status === "active",
  );
  const demo = async () => {
    setBusy(true);
    setError("");
    try {
      await post("/api/demo", {});
      await props.refresh("Five example contracts are ready to explore.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (!state.contracts.length)
    return (
      <div className="onboarding">
        <div className="eyebrow">A local workspace for revenue accounting</div>
        <h1>Start with a contract.</h1>
        <p>
          Keep consideration, obligations, and accounting decisions together.
          Review the revenue, explore a scenario, and close the period when
          you’re ready.
        </p>
        <div className="button-group">
          <Button
            primary
            onClick={() =>
              dialog({ type: state.customers.length ? "contract" : "customer" })
            }
          >
            <Plus size={15} />
            {state.customers.length
              ? "Create a contract"
              : "Add your first customer"}
          </Button>
          <Button onClick={demo} busy={busy}>
            Explore example contracts
            <ArrowRight size={14} />
          </Button>
        </div>
        <ErrorMessage error={error} />
        <div className="onboarding-divider" />
        <div className="onboarding-secondary">
          <FileSpreadsheet size={19} />
          <div>
            <h3>Already working in a spreadsheet?</h3>
            <p>
              Use the Excel template to bring structured accounting data into
              this workspace.
            </p>
            <button className="text-button" onClick={() => navigate("Imports")}>
              Import a workbook
              <ArrowRight size={13} />
            </button>
          </div>
        </div>
        <div className="onboarding-footnote">
          No account. No cloud connection. Your workspace stays on this device.
        </div>
      </div>
    );
  return (
    <>
      <Heading
        title={monthLabel(period)}
        subtitle={`Your working period${
          closes.length
            ? ` · Last closed ${monthLabel(
                closes
                  .map((c) => c.period)
                  .sort()
                  .at(-1)!,
              )}`
            : " · No periods closed yet"
        }`}
      >
        <Tag tone={closed ? "closed" : ""}>
          {closed ? "Closed" : "Open period"}
        </Tag>
        <Button
          primary
          disabled={state.scenario_id !== "main"}
          title={
            state.scenario_id !== "main"
              ? "Switch to Main to close a period"
              : undefined
          }
          onClick={() => dialog({ type: "close", reopen: closed })}
        >
          {closed ? <UnlockKeyhole size={14} /> : <LockKeyhole size={14} />}{" "}
          {closed ? "Reopen period" : "Review & close"}
        </Button>
      </Heading>
      <Metrics
        summary={state.report.summary}
        currency={state.workspace.currency}
      />
      <div className="home-columns">
        <Section
          title="Needs attention"
          action={
            <AddButton onClick={() => dialog({ type: "note" })}>
              Add task or note
            </AddButton>
          }
        >
          {state.report.warnings.length > 0 && (
            <div className="warning">
              {state.report.warnings.map((warning, i) => (
                <p key={i}>{warning}</p>
              ))}
            </div>
          )}
          {state.notes.filter((n) => n.kind === "task" && !n.completed)
            .length ? (
            <NotesList
              props={props}
              notes={state.notes.filter(
                (n) => n.kind === "task" && !n.completed,
              )}
            />
          ) : (
            <div className="clear-state">
              <CircleCheck size={17} />
              <div>
                <strong>No open tasks</strong>
                <p>
                  {state.report.warnings.length
                    ? "Review the accounting warnings before closing."
                    : "Review the period’s activity and journals before closing."}
                </p>
              </div>
            </div>
          )}
        </Section>
        <Section
          title="Active scenarios"
          action={
            <button
              className="text-button"
              onClick={() => dialog({ type: "scenario" })}
            >
              <Plus size={14} />
              New scenario
            </button>
          }
        >
          {active.length ? (
            <div className="scenario-shortlist">
              {active.map((s) => (
                <button key={s.id} onClick={() => navigate("Scenarios", s.id)}>
                  <GitBranch size={15} />
                  <span>
                    <strong>{s.name}</strong>
                    <small>Based on Main version {s.base_version}</small>
                  </span>
                  <ChevronRight size={14} />
                </button>
              ))}
            </div>
          ) : (
            <div className="quiet-empty">
              Create a scenario to explore changes before accepting them into
              Main.
            </div>
          )}
        </Section>
      </div>
      <Section
        title="Contracts in this period"
        action={
          <JumpButton onClick={() => navigate("Contracts")}>
            View all contracts
          </JumpButton>
        }
      >
        <ContractTable contracts={state.contracts} props={props} />
      </Section>
      <Section
        title="Recent activity"
        action={
          <JumpButton onClick={() => navigate("Activity")}>
            View activity
          </JumpButton>
        }
      >
        <ChangesList props={props} limit={5} />
      </Section>
    </>
  );
}
export function CustomersView(props: ViewProps) {
  const { state, selected, dialog, navigate } = props;
  const customer = state.customers.find((c) => c.id === selected);
  if (customer) {
    const contracts = state.contracts.filter(
      (c) => c.customer_id === customer.id,
    );
    const reports = state.report.contracts.filter(
      (c) => c.customer_id === customer.id,
    );
    return (
      <>
        <Heading
          title={customer.name}
          subtitle={
            [customer.reference, customer.email].filter(Boolean).join(" · ") ||
            "Customer accounting overview"
          }
        >
          <Button
            onClick={() => dialog({ type: "details", entityId: customer.id })}
          >
            Edit details
          </Button>
          <Button
            onClick={() => dialog({ type: "note", entityId: customer.id })}
          >
            Add note
          </Button>
          <Button
            primary
            onClick={() =>
              dialog({ type: "contract", customerId: customer.id })
            }
          >
            <Plus size={14} />
            New contract
          </Button>
        </Heading>
        <Metrics
          currency={state.workspace.currency}
          compact
          summary={{
            revenue: total(reports.map((r) => r.revenue)),
            deferred_revenue: total(reports.map((r) => r.deferred_revenue)),
            contract_asset: total(reports.map((r) => r.contract_asset)),
            remaining_revenue: total(reports.map((r) => r.remaining_revenue)),
          }}
        />
        <Section title="Contracts">
          <ContractTable contracts={contracts} props={props} />
        </Section>
        <Section title="Notes & tasks">
          <NotesList
            props={props}
            notes={state.notes.filter((n) => n.entity_id === customer.id)}
          />
        </Section>
      </>
    );
  }
  return (
    <>
      <Heading
        title="Customers"
        subtitle="The accounting view of your customer relationships."
      >
        <Button primary onClick={() => dialog({ type: "customer" })}>
          <Plus size={14} />
          New customer
        </Button>
      </Heading>
      {!state.customers.length ? (
        <Empty
          title="No customers yet"
          action={
            <Button onClick={() => dialog({ type: "customer" })}>
              Add customer
            </Button>
          }
        >
          Add a customer, then create their contracts.
        </Empty>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Customer</th>
                <th>Reference</th>
                <th className="number">Contracts</th>
                <th className="number">Period revenue</th>
                <th className="number">Deferred revenue</th>
                <th className="number">Contract asset</th>
                <th className="number">Remaining revenue</th>
              </tr>
            </thead>
            <tbody>
              {state.customers.map((customer) => {
                const reports = state.report.contracts.filter(
                  (c) => c.customer_id === customer.id,
                );
                return (
                  <tr key={customer.id}>
                    <td>
                      <button
                        className="table-link strong"
                        onClick={() => navigate("Customers", customer.id)}
                      >
                        {customer.name}
                      </button>
                      <small className="cell-subtitle">{customer.email}</small>
                    </td>
                    <td className="muted">{customer.reference || "—"}</td>
                    <td className="number">
                      {
                        state.contracts.filter(
                          (c) => c.customer_id === customer.id,
                        ).length
                      }
                    </td>
                    {[
                      "revenue",
                      "deferred_revenue",
                      "contract_asset",
                      "remaining_revenue",
                    ].map((key) => (
                      <td className="number" key={key}>
                        {money(
                          total(
                            reports.map(
                              (r) => r[key as keyof ContractReport] as string,
                            ),
                          ),
                          state.workspace.currency,
                        )}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
export function ContractsView(props: ViewProps) {
  return (
    <>
      <Heading
        title="Contracts"
        subtitle="Consideration, performance obligations, and every accounting decision."
      >
        <ExportButton
          scenario={props.state.scenario_id}
          period={props.period}
        />
        <Button
          primary
          onClick={() =>
            props.dialog({
              type: props.state.customers.length ? "contract" : "customer",
            })
          }
        >
          <Plus size={14} />
          New contract
        </Button>
      </Heading>
      <ContractTable
        props={props}
        contracts={props.state.contracts}
        searchable
      />
    </>
  );
}
export function ContractView(props: ViewProps) {
  const { state, selected, dialog } = props;
  const [tab, setTab] = useState(props.tab || "Overview"),
    [action, setAction] = useState("billing");
  const contract = state.contracts.find((c) => c.id === selected);
  if (!contract)
    return (
      <Empty title="Contract not found">
        This contract may belong to a different scenario.
      </Empty>
    );
  const report = state.report.contracts.find((c) => c.id === contract.id);
  const currency = state.workspace.currency;
  const customer = state.customers.find((c) => c.id === contract.customer_id);
  return (
    <>
      <Heading
        title={contract.name}
        subtitle={`${customer?.name || "Customer"} · ${dateLabel(contract.start_date)} – ${dateLabel(contract.end_date)}`}
      >
        <Button
          onClick={() => dialog({ type: "details", entityId: contract.id })}
        >
          Edit details
        </Button>
        <Button
          onClick={() => dialog({ type: "contract", contractId: contract.id })}
        >
          Record accounting change
        </Button>
        <div className="split-action">
          <select
            aria-label="Activity type"
            value={action}
            onChange={(e) => setAction(e.target.value)}
          >
            <option value="billing">Billing</option>
            <option value="progress">Progress</option>
            <option value="usage">Units delivered</option>
            <option value="milestone">Satisfaction milestone</option>
            <option value="reassessment">Consideration reassessment</option>
            <option value="adjustment">Revenue adjustment</option>
          </select>
          <Button
            primary
            onClick={() =>
              dialog({
                type: "activity",
                contractId: contract.id,
                activity: action,
              })
            }
          >
            <Plus size={14} />
            Record
          </Button>
        </div>
      </Heading>
      {report && <Metrics summary={report} currency={currency} compact />}
      <div className="tabs" role="tablist" aria-label="Contract sections">
        {[
          "Overview",
          "Consideration",
          "Obligations",
          "Allocation",
          "Recognition",
          "Billing",
          "Changes",
          "Evidence",
          "Notes",
        ].map((name) => (
          <button
            key={name}
            role="tab"
            aria-selected={tab === name}
            className={tab === name ? "active" : ""}
            onClick={() => setTab(name)}
          >
            {name}
          </button>
        ))}
      </div>
      {tab === "Overview" && (
        <>
          <div className="detail-columns">
            <Section title="Contract details">
              <dl className="definition-list">
                <div>
                  <dt>Customer</dt>
                  <dd>
                    <button
                      className="table-link"
                      onClick={() =>
                        props.navigate("Customers", contract.customer_id)
                      }
                    >
                      {customer?.name}
                    </button>
                  </dd>
                </div>
                <div>
                  <dt>Transaction price</dt>
                  <dd>{money(report?.transaction_price, currency)}</dd>
                </div>
                <div>
                  <dt>Recognized to date</dt>
                  <dd>{money(report?.recognized_to_date, currency)}</dd>
                </div>
                <div>
                  <dt>Billed to date</dt>
                  <dd>{money(report?.billed_to_date, currency)}</dd>
                </div>
                <div>
                  <dt>Contract term</dt>
                  <dd>
                    {dateLabel(contract.start_date)} –{" "}
                    {dateLabel(contract.end_date)}
                  </dd>
                </div>
              </dl>
              {contract.rationale && (
                <p className="rationale">{contract.rationale}</p>
              )}
            </Section>
            <Section title="Performance obligations">
              <div className="obligation-list">
                {contract.obligations.map((o) => (
                  <button key={o.id} onClick={() => setTab("Obligations")}>
                    <span>
                      <strong>{o.name}</strong>
                      <small>{methods[o.method]}</small>
                    </span>
                    <span>
                      {money(
                        report?.allocation.find((a) => a.obligation_id === o.id)
                          ?.amount,
                        currency,
                      )}
                      <ChevronRight size={13} />
                    </span>
                  </button>
                ))}
              </div>
            </Section>
          </div>
          <Section title="Recent contract activity">
            <ActivityTable contract={contract} currency={currency} limit={6} />
          </Section>
          <Section
            title="Working context"
            action={
              <AddButton
                onClick={() => dialog({ type: "note", entityId: contract.id })}
              >
                Add note
              </AddButton>
            }
          >
            <NotesList
              notes={state.notes.filter((n) => n.entity_id === contract.id)}
              props={props}
            />
          </Section>
        </>
      )}
      {tab === "Consideration" && (
        <Section
          title="Baseline consideration"
          subtitle="Later reassessments and modifications are preserved in Changes."
        >
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Component</th>
                  <th>Type</th>
                  <th className="number">Amount</th>
                  <th className="number">Included amount</th>
                  <th>Rationale</th>
                </tr>
              </thead>
              <tbody>
                {contract.consideration.map((c) => (
                  <tr key={c.id}>
                    <td className="strong">{c.label}</td>
                    <td>{humanize(c.kind)}</td>
                    <td className="number">{money(c.amount, currency)}</td>
                    <td className="number">
                      {money(c.included_amount || c.amount, currency)}
                    </td>
                    <td className="muted">{c.rationale || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      )}
      {tab === "Obligations" && (
        <Section
          title="Performance obligations"
          subtitle="Baseline satisfaction methods and standalone selling prices."
        >
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Obligation</th>
                  <th>Recognition method</th>
                  <th className="number">Standalone price</th>
                  <th>Service term</th>
                  <th>Accounting conclusion</th>
                </tr>
              </thead>
              <tbody>
                {contract.obligations.map((o) => (
                  <tr key={o.id}>
                    <td>
                      <strong>{o.name}</strong>
                      <small className="cell-subtitle">
                        {humanize(o.kind)}
                      </small>
                    </td>
                    <td>
                      {methods[o.method]}
                      {o.total_units && (
                        <small className="cell-subtitle">
                          {o.total_units} contracted units
                        </small>
                      )}
                    </td>
                    <td className="number">{money(o.ssp, currency)}</td>
                    <td className="nowrap">
                      {dateLabel(o.start_date)}
                      <small className="cell-subtitle">
                        to {dateLabel(o.end_date)}
                      </small>
                    </td>
                    <td className="muted">
                      {o.rationale || "—"}
                      {o.kind === "material_right" && (
                        <small className="cell-subtitle">
                          Exercise by {dateLabel(o.exercise_end || o.end_date)}
                        </small>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      )}
      {tab === "Allocation" && (
        <Section
          title="Relative SSP allocation"
          subtitle="The included transaction price is allocated at posting precision."
        >
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Performance obligation</th>
                  <th className="number">Standalone selling price</th>
                  <th className="number">Allocated consideration</th>
                </tr>
              </thead>
              <tbody>
                {report?.allocation.map((a) => (
                  <tr key={a.obligation_id}>
                    <td>{a.name}</td>
                    <td className="number">{money(a.ssp, currency)}</td>
                    <td className="number">{money(a.amount, currency)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th>Total</th>
                  <th className="number">
                    {money(
                      total(report?.allocation.map((a) => a.ssp) || []),
                      currency,
                    )}
                  </th>
                  <th className="number">
                    {money(
                      total(report?.allocation.map((a) => a.amount) || []),
                      currency,
                    )}
                  </th>
                </tr>
              </tfoot>
            </table>
          </div>
        </Section>
      )}
      {tab === "Recognition" && (
        <Section title="Revenue by performance obligation" subtitle={props.focus ? `Reviewing ${report?.allocation.find((item) => item.obligation_id === props.focus)?.name || props.focus}.` : undefined}>
          <ScheduleTable
            rows={state.report.schedule.filter(
              (s) => s.contract_id === contract.id,
            )}
            props={props}
            byObligation
            allIdentifiers={report?.allocation.map((item) => item.obligation_id)}
          />
        </Section>
      )}
      {tab === "Billing" && (
        <Section
          title="Billing activity"
          subtitle="Invoices affect contract balances independently of recognition."
          action={
            <AddButton
              onClick={() =>
                dialog({
                  type: "activity",
                  contractId: contract.id,
                  activity: "billing",
                })
              }
            >
              Record billing
            </AddButton>
          }
        >
          <ActivityTable
            contract={contract}
            currency={currency}
            type="billing"
          />
        </Section>
      )}
      {tab === "Changes" && (
        <>
          <Section title="Accounting activity">
            <ActivityTable contract={contract} currency={currency} />
          </Section>
          <Section title="Change history">
            <ChangesList props={props} contractId={contract.id} />
          </Section>
        </>
      )}
      {tab === "Evidence" && (
        <EvidencePanel props={props} entityId={contract.id} />
      )}{" "}
      {tab === "Notes" && (
        <Section
          title="Notes, memos & tasks"
          action={
            <AddButton
              onClick={() => dialog({ type: "note", entityId: contract.id })}
            >
              Add working context
            </AddButton>
          }
        >
          <NotesList
            props={props}
            notes={state.notes.filter((n) => n.entity_id === contract.id)}
          />
        </Section>
      )}
    </>
  );
}
function ActivityTable({
  contract,
  currency,
  type,
  limit,
}: {
  contract: Contract;
  currency: string;
  type?: string;
  limit?: number;
}) {
  const activities = [...(contract.activities || [])]
    .filter((a) => !type || a.type === type)
    .reverse()
    .slice(0, limit);
  return activities.length ? (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Effective date</th>
            <th>Activity</th>
            <th>Obligation / reference</th>
            <th className="number">Value</th>
            <th>Rationale</th>
          </tr>
        </thead>
        <tbody>
          {activities.map((a, i) => (
            <tr key={a.id || i}>
              <td className="nowrap">{dateLabel(a.effective_date)}</td>
              <td>
                {humanize(a.type)}
                {Boolean(a.treatment) && (
                  <small className="cell-subtitle">
                    {humanize(String(a.treatment))}
                  </small>
                )}
              </td>
              <td>
                {contract.obligations.find((o) => o.id === a.obligation_id)
                  ?.name ||
                  a.reference ||
                  "—"}
              </td>
              <td className="number">
                {a.amount !== undefined
                  ? money(a.amount, currency)
                  : a.percentage !== undefined
                    ? `${a.percentage}%`
                    : a.quantity !== undefined
                      ? `${a.quantity} units`
                      : a.included_amount !== undefined
                        ? money(String(a.included_amount), currency)
                        : "—"}
              </td>
              <td className="muted wrap">{a.rationale || "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  ) : (
    <Empty title="No recorded activity">
      Record billing or a satisfaction update to add accounting activity.
    </Empty>
  );
}
function ScheduleTable({
  rows,
  props,
  byObligation = false,
  allIdentifiers = [],
}: {
  rows: Schedule[];
  props: ViewProps;
  byObligation?: boolean;
  allIdentifiers?: string[];
}) {
  const periods = [...new Set(rows.length ? rows.map((r) => r.period) : [props.period])].sort();
  const identifiers = [
    ...new Set(
      [...allIdentifiers, ...rows.map((r) => (byObligation ? r.obligation_id : r.contract_id))],
    ),
  ];
  const currency = props.state.workspace.currency;
  const name = (id: string) =>
    byObligation
      ? props.state.report.contracts.flatMap((c) => c.allocation).find((o) => o.obligation_id === id)?.name ||
        props.state.contracts.flatMap((c) => c.obligations).find((o) => o.id === id)?.name || id
      : props.state.contracts.find((c) => c.id === id)?.name || id;
  return identifiers.length ? (
    <div className="table-wrap schedule-table">
      <table>
        <thead>
          <tr>
            <th className="sticky-column">
              {byObligation ? "Obligation" : "Contract"}
            </th>
            {periods.map((p) => (
              <th
                className={`number ${p === props.period ? "selected-period" : ""}`}
                key={p}
              >
                {new Date(`${p}-01T12:00:00`).toLocaleDateString("en-US", {
                  month: "short",
                  year: "2-digit",
                })}
              </th>
            ))}
            <th className="number">Total</th>
          </tr>
        </thead>
        <tbody>
          {identifiers.map((id) => (
            <tr key={id} className={id === props.focus ? "focus-obligation" : ""}>
              <td className="sticky-column">
                {byObligation ? (
                  name(id)
                ) : (
                  <button
                    className="table-link"
                    onClick={() => props.navigate("Contracts", id)}
                  >
                    {name(id)}
                  </button>
                )}
              </td>
              {periods.map((p) => (
                <td
                  className={`number ${p === props.period ? "selected-period" : ""}`}
                  key={p}
                >
                  {money(
                    total(
                      rows
                        .filter(
                          (r) =>
                            r.period === p &&
                            (byObligation ? r.obligation_id : r.contract_id) ===
                              id,
                        )
                        .map((r) => r.revenue),
                    ),
                    currency,
                  )}
                </td>
              ))}
              <td className="number strong">
                {money(
                  total(
                    rows
                      .filter(
                        (r) =>
                          (byObligation ? r.obligation_id : r.contract_id) ===
                          id,
                      )
                      .map((r) => r.revenue),
                  ),
                  currency,
                )}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th className="sticky-column">Total revenue</th>
            {periods.map((p) => (
              <th
                className={`number ${p === props.period ? "selected-period" : ""}`}
                key={p}
              >
                {money(
                  total(
                    rows.filter((r) => r.period === p).map((r) => r.revenue),
                  ),
                  currency,
                )}
              </th>
            ))}
            <th className="number">
              {money(total(rows.map((r) => r.revenue)), currency)}
            </th>
          </tr>
        </tfoot>
      </table>
    </div>
  ) : (
    <Empty title="No revenue schedule yet">
      Create a contract to derive a recognition schedule.
    </Empty>
  );
}
export function RevenueView(props: ViewProps) {
  const [group, setGroup] = useState("contract");
  return (
    <>
      <Heading
        title="Revenue"
        subtitle="Recognition schedules derived from contract terms and recorded satisfaction."
      >
        <ExportButton
          scenario={props.state.scenario_id}
          period={props.period}
        />
      </Heading>
      <Metrics
        summary={props.state.report.summary}
        currency={props.state.workspace.currency}
        compact
      />
      <div className="table-toolbar">
        <div className="segmented-control">
          <button
            className={group === "contract" ? "active" : ""}
            onClick={() => setGroup("contract")}
          >
            By contract
          </button>
          <button
            className={group === "obligation" ? "active" : ""}
            onClick={() => setGroup("obligation")}
          >
            By obligation
          </button>
        </div>
        <span className="muted">
          Full contract terms · {props.state.workspace.currency}
        </span>
      </div>
      <ScheduleTable
        rows={props.state.report.schedule}
        props={props}
        byObligation={group === "obligation"}
      />
      <p className="fine-print">
        Selected period highlighted. Closed Main periods retain their accepted
        results.
      </p>
    </>
  );
}

export function ScenarioView(props: ViewProps) {
  const { state, selected, navigate, dialog, setScenario, period } = props;
  const candidates = state.scenarios.filter((s) => s.id !== "main");
  const scenario =
    candidates.find((s) => s.id === selected) ||
    candidates.find((s) => s.status === "active") ||
    candidates[0];
  const [comparison, setComparison] = useState<Comparison | null>(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(false);
  useEffect(() => {
    let canceled = false;
    if (!scenario) {
      setComparison(null);
      return;
    }
    setLoading(true);
    setComparison(null);
    api<Comparison>(
      `/api/compare?scenario_id=${encodeURIComponent(scenario.id)}&period=${period}`,
    )
      .then((value) => {
        if (!canceled) {
          setComparison(value);
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
  }, [scenario?.id, period, state.frontier]);
  if (!scenario)
    return (
      <>
        <Heading
          title="Scenarios"
          subtitle="Explore an alternative accounting reality without changing Main."
        >
          <Button primary onClick={() => dialog({ type: "scenario" })}>
            <Plus size={14} />
            New scenario
          </Button>
        </Heading>
        <Empty
          title="No scenarios yet"
          action={
            <Button onClick={() => dialog({ type: "scenario" })}>
              Create a scenario
            </Button>
          }
        >
          A scenario starts from the current Main version and keeps its
          proposals isolated.
        </Empty>
      </>
    );
  const currency = state.workspace.currency;
  const behind = Number(comparison?.main_version || 0) > scenario.base_version;
  const active = scenario.status === "active";
  return (
    <>
      <Heading
        title="Scenarios"
        subtitle="Review financial impact before accepting an accounting change."
      >
        <Button onClick={() => dialog({ type: "scenario" })}>
          <Plus size={14} />
          New scenario
        </Button>
      </Heading>
      <div className="scenario-layout">
        <aside className="scenario-list">
          {candidates.map((item) => (
            <button
              key={item.id}
              className={item.id === scenario.id ? "active" : ""}
              onClick={() => navigate("Scenarios", item.id)}
            >
              <GitBranch size={15} />
              <span>
                <strong>{item.name}</strong>
                <small>
                  {humanize(item.status)} · Main v{item.base_version}
                </small>
              </span>
              <ChevronRight size={14} />
            </button>
          ))}
        </aside>
        <div className="scenario-detail">
          <div className="scenario-detail-heading">
            <div>
              <div className="eyebrow">
                {humanize(scenario.status)} scenario
              </div>
              <h2>{scenario.name}</h2>
              <p>
                Based on Main version {scenario.base_version}
                {behind ? " · Main has advanced" : ""}
              </p>
            </div>
            <div className="button-group">
              {active && (
                <Button
                  onClick={() =>
                    dialog({
                      type: "lifecycle",
                      action: "archive",
                      scenarioId: scenario.id,
                    })
                  }
                >
                  Archive
                </Button>
              )}
              {active && behind && (
                <Button
                  onClick={() =>
                    dialog({
                      type: "lifecycle",
                      action: "rebase",
                      scenarioId: scenario.id,
                    })
                  }
                >
                  Rebase
                </Button>
              )}
              {active && (
                <Button
                  primary
                  disabled={behind}
                  title={behind ? "Rebase before applying" : undefined}
                  onClick={() =>
                    dialog({
                      type: "lifecycle",
                      action: "apply",
                      scenarioId: scenario.id,
                    })
                  }
                >
                  Apply to Main
                </Button>
              )}
              {scenario.status === "archived" && (
                <Button
                  primary
                  onClick={() =>
                    dialog({
                      type: "lifecycle",
                      action: "restore",
                      scenarioId: scenario.id,
                    })
                  }
                >
                  Restore
                </Button>
              )}
            </div>
          </div>
          {error && <ErrorMessage error={error} />}{" "}
          {loading ? (
            <div className="inline-loading">
              <LoaderCircle className="spin" size={16} />
              Calculating comparison…
            </div>
          ) : (
            comparison && (
              <>
                <Section
                  title="Selected-period difference"
                  subtitle={monthLabel(period)}
                >
                  <Metrics
                    compact
                    summary={comparison.summary}
                    currency={currency}
                  />
                </Section>
                <Section title="Revenue difference by period">
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Period</th>
                          <th className="number">Main</th>
                          <th className="number">Scenario</th>
                          <th className="number">Difference</th>
                        </tr>
                      </thead>
                      <tbody>
                        {comparison.rows.map((row) => (
                          <tr key={row.period}>
                            <td>{monthLabel(row.period)}</td>
                            <td className="number">
                              {money(row.main_revenue, currency)}
                            </td>
                            <td className="number">
                              {money(row.scenario_revenue, currency)}
                            </td>
                            <td
                              className={`number ${Number(row.delta) !== 0 ? "emphasis" : "muted"}`}
                            >
                              {Number(row.delta) === 0
                                ? "—"
                                : money(row.delta, currency)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </Section>
                <div className="button-group">
                  <Button
                    onClick={() => {
                      setScenario(scenario.id);
                      navigate("Contracts");
                    }}
                  >
                    Open scenario workspace
                  </Button>
                  <Button onClick={() => setScenario("main")}>
                    Return to Main
                  </Button>
                </div>
              </>
            )
          )}
        </div>
      </div>
    </>
  );
}

export function JournalView(props: ViewProps) {
  const { state } = props;
  const debit = total(state.report.journals.map((row) => row.debit)),
    credit = total(state.report.journals.map((row) => row.credit));
  return (
    <>
      <Heading
        title="Journal entries"
        subtitle={`Derived from accepted accounting state for ${monthLabel(props.period)}.`}
      >
        <ExportButton
          scenario={state.scenario_id}
          period={props.period}
          label="Export support"
        />
      </Heading>
      <div className="review-facts">
        <div>
          <span>Total debits</span>
          <strong>{money(debit, state.workspace.currency)}</strong>
        </div>
        <div>
          <span>Total credits</span>
          <strong>{money(credit, state.workspace.currency)}</strong>
        </div>
        <div>
          <span>Balance</span>
          <strong>
            {money(total([debit, `-${credit}`]), state.workspace.currency)}
          </strong>
        </div>
        <div>
          <span>Lines</span>
          <strong>{state.report.journals.length}</strong>
        </div>
      </div>
      <Section>
        <JournalsTable
          rows={state.report.journals}
          currency={state.workspace.currency}
          contractName={(id) =>
            state.contracts.find((c) => c.id === id)?.name || id
          }
          onContract={(id) => props.navigate("Contracts", id)}
        />
      </Section>
      <p className="fine-print">
        Billing clearing is the offset for invoice activity. Map the four
        semantic account roles to your general ledger in Settings.
      </p>
    </>
  );
}

export function ReportsView(props: ViewProps) {
  return <ReportsWorkspace {...props} />;
}

export function ImportsView(props: ViewProps) {
  const [file, setFile] = useState<File | null>(null),
    [imports, setImports] = useState<
      {
        id: string;
        source: string;
        recorded_at: string;
        status: string;
        imported?: number;
        error?: string;
      }[]
    >([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const load = () =>
    api<{ imports: typeof imports }>("/api/imports")
      .then((v) => setImports(v.imports))
      .catch((e) => setError(e.message));
  useEffect(() => {
    void load();
  }, [props.state.frontier]);
  const upload = async () => {
    if (!file) return;
    setBusy(true);
    setError("");
    const data = new FormData();
    data.append("file", file);
    data.append("scenario_id", props.state.scenario_id);
    data.append("period", props.period);
    try {
      await api("/api/import", { method: "POST", body: data });
      setFile(null);
      await props.refresh("Workbook imported.");
      void load();
    } catch (e) {
      setError((e as Error).message);
      void load();
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Heading
        title="Imports"
        subtitle="Bulk entry uses the same accounting commands and validation as the workbench."
      >
        <a className="button" href="/api/template" download>
          <ArrowDownToLine size={14} />
          Download template
        </a>
      </Heading>
      <Section
        title="Import workbook"
        subtitle="All accounting rows commit together. If one row fails, no accounting changes are recorded."
      >
        <div className="upload-row">
          <label className="file-picker">
            <Upload size={17} />
            <span>{file?.name || "Choose an .xlsx workbook"}</span>
            <input
              type="file"
              accept=".xlsx"
              onChange={(e) => setFile(e.target.files?.[0] || null)}
            />
          </label>
          <Button primary disabled={!file} busy={busy} onClick={upload}>
            Review and import
          </Button>
        </div>
        <ErrorMessage error={error} />
        <p className="fine-print">
          The source workbook and row result are retained under this workspace’s
          attachments. Formulas are rejected; import reviewed values.
        </p>
      </Section>
      <Section title="Import history">
        {imports.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Workbook</th>
                  <th>Recorded</th>
                  <th>Status</th>
                  <th className="number">Rows</th>
                  <th>Result</th>
                </tr>
              </thead>
              <tbody>
                {imports.map((item) => (
                  <tr key={item.id}>
                    <td>{item.source}</td>
                    <td>{dateLabel(item.recorded_at)}</td>
                    <td>
                      <Tag
                        tone={item.status === "accepted" ? "closed" : "warning"}
                      >
                        {humanize(item.status)}
                      </Tag>
                    </td>
                    <td className="number">{item.imported ?? "—"}</td>
                    <td className="muted">
                      {item.error || "All rows accepted"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty title="No imports yet">
            Download the template, fill it with reviewed data, then import it
            here.
          </Empty>
        )}
      </Section>
    </>
  );
}

export function ActivityView(props: ViewProps) {
  if (props.selected) return <ChangeDetail {...props} changeSetId={props.selected} />;
  return <ActivityList {...props} />;
}

function ActivityList(props: ViewProps) {
  const { state } = props;
  const [query, setQuery] = useState("");
  const changes = [...state.change_sets].filter((change) =>
    `${change.command} ${change.entity_id} ${JSON.stringify(change.payload)}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  return (
    <>
      <Heading
        title="Activity"
        subtitle="Every accepted command is preserved in recorded order."
      >
        <Button onClick={() => props.dialog({ type: "note" })}>
          <Plus size={14} />
          Add note or task
        </Button>
      </Heading>
      <div className="table-toolbar">
        <div className="filter-input">
          <Search size={15} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter activity…"
          />
        </div>
        <span className="muted">{changes.length} change sets</span>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Version</th>
              <th>Recorded</th>
              <th>Effective</th>
              <th>Command</th>
              <th>Record</th>
              <th>Scenario</th>
              <th>Source</th>
            </tr>
          </thead>
          <tbody>
            {changes.map((change, index) => (
              <tr key={String(change.id || index)}>
                <td className="number tabular">
                  {String(change.version ?? "—")}
                </td>
                <td>
                  <DateText value={String(change.recorded_at || "")} />
                </td>
                <td>
                  <DateText value={String(change.effective_date || "")} />
                </td>
                <td className="strong"><button className="text-button" onClick={() => props.navigate("Activity", change.id)}>{humanize(change.command || change.type || "change")}</button></td>
                <td className="mono">{String(change.entity_id || "—")}</td>
                <td>
                  {change.scenario_id === "main"
                    ? "Main"
                    : state.scenarios.find((s) => s.id === change.scenario_id)
                        ?.name || String(change.scenario_id || "—")}
                </td>
                <td className="muted">{String(change.source || "—")}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!changes.length && (
          <Empty title="No matching activity">
            Clear the filter to see the complete history.
          </Empty>
        )}
      </div>
    </>
  );
}

export function SettingsView(props: ViewProps) {
  const { state } = props;
  return (
    <>
      <Heading
        title="Settings"
        subtitle="Workspace identity, policy version, and journal account mapping."
      >
        <Button
          primary
          disabled={state.scenario_id !== "main"}
          onClick={() => props.dialog({ type: "policy" })}
        >
          Update account mapping
        </Button>
      </Heading>
      <div className="settings-grid">
        <Section title="Workspace">
          <dl className="definition-list">
            <div>
              <dt>Name</dt>
              <dd>{state.workspace.name}</dd>
            </div>
            <div>
              <dt>Currency</dt>
              <dd>{state.workspace.currency}</dd>
            </div>
            <div>
              <dt>Workspace ID</dt>
              <dd className="mono">{state.workspace.id}</dd>
            </div>
            <div>
              <dt>Created</dt>
              <dd>{dateLabel(state.workspace.created_at)}</dd>
            </div>
          </dl>
        </Section>
        <Section title="Calculation context">
          <dl className="definition-list">
            <div>
              <dt>Policy version</dt>
              <dd>{state.policy.version}</dd>
            </div>
            <div>
              <dt>Effective period</dt>
              <dd>{state.policy.effective_period === "0001-01" ? "Workspace start" : state.policy.effective_period}</dd>
            </div>
            <div>
              <dt>Ruleset</dt>
              <dd>orr-0.1</dd>
            </div>
            <div>
              <dt>Engine</dt>
              <dd>0.1.0</dd>
            </div>
            <div>
              <dt>Posting</dt>
              <dd>{humanize(state.policy.rounding)}</dd>
            </div>
          </dl>
        </Section>
      </div>
      <Section
        title="Journal account mapping"
        subtitle={`Mapping effective for ${props.period}. Earlier periods retain their prior mapping.`}
      >
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Role</th>
                <th>Account code</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(state.policy.accounts).map(([role, account]) => (
                <tr key={role}>
                  <td>{humanize(role)}</td>
                  <td className="mono">{account}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>
      <Section title="Local-first operation">
        <p className="body-copy">
          This workspace works without a cloud account or model service. SQLite
          is authoritative; the desktop, CLI, Python, Excel, and MCP interfaces
          all use the same accounting commands.
        </p>
      </Section>
    </>
  );
}
