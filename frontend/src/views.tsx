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
  FinancialPreview,
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
  Report,
  Note,
  Schedule,
} from "./types";
import { methods } from "./forms";
import { contractTerms, termReviewStatus } from "./contractTerms";
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
                      {!report && contract.cutover_date ? `Awaiting opening position · ${contract.cutover_date}` : `${contract.obligations.length} obligation${contract.obligations.length === 1 ? "" : "s"}`}
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
                    {report ? money(report.transaction_price, currency) : "—"}
                  </td>
                  <td className="number">{report ? money(report.revenue, currency) : "—"}</td>
                  <td className="number">
                    {report ? money(report.deferred_revenue, currency) : "—"}
                  </td>
                  <td className="number">
                    {report ? money(report.remaining_revenue, currency) : "—"}
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
          <Empty title={query ? "No matching contracts" : state.contracts.length ? "No contracts in this view" : "No contracts yet"}>
            {query
              ? "Try a different name or customer."
              : state.contracts.length
                ? "Choose another filter to see more contracts."
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
  const [contractFilter, setContractFilter] = useState<"service" | "balance" | "all">("service");
  const periodStart = `${period}-01`;
  const periodEnd = `${period}-31`;
  const homeContracts = state.contracts.filter((contract) => {
    if (contractFilter === "all") return true;
    if (contractFilter === "service") {
      const opening = contract.activities.find((activity) => activity.type === "opening_position");
      if (opening && opening.effective_date.slice(0, 7) > period) return false;
      return contractTerms(contract, periodEnd).obligations.some(
        (obligation) => obligation.start_date <= periodEnd && obligation.end_date >= periodStart,
      );
    }
    const report = state.report.contracts.find((item) => item.id === contract.id);
    return Boolean(report && [report.deferred_revenue, report.contract_asset, report.remaining_revenue]
      .some((amount) => Math.abs(Number(amount)) > 0.005));
  });
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
              this workspace. For established contracts, include a reviewed opening position with legacy recognized revenue, billing, and contract balance at a monthly cutover.
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
            <button
              className="attention-action"
              onClick={() => navigate("Reports")}
              aria-label={`Review ${state.report.warnings.length} accounting warning${state.report.warnings.length === 1 ? "" : "s"}`}
            >
              <span className="attention-count">{state.report.warnings.length}</span>
              <strong>
                Accounting warning{state.report.warnings.length === 1 ? "" : "s"}
              </strong>
              <span className="attention-verb">Review</span>
              <ChevronRight size={15} aria-hidden="true" />
            </button>
          )}
          {state.notes.filter((n) => n.kind === "task" && !n.completed)
            .length ? (
            <NotesList
              props={props}
              notes={state.notes.filter(
                (n) => n.kind === "task" && !n.completed,
              )}
            />
          ) : !state.report.warnings.length ? (
            <div className="clear-state">
              <CircleCheck size={17} />
              <div>
                <strong>Nothing needs attention</strong>
              </div>
            </div>
          ) : null}
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
        title="Contracts"
        action={
          <JumpButton onClick={() => navigate("Contracts")}>
            View all contracts
          </JumpButton>
        }
      >
        <div className="table-toolbar">
          <label>Show <select value={contractFilter} onChange={(event) => setContractFilter(event.target.value as "service" | "balance" | "all")}>
            <option value="service">Service terms in this month</option>
            <option value="balance">Outstanding balance or remaining revenue</option>
            <option value="all">All contracts</option>
          </select></label>
          <span className="muted">{homeContracts.length} of {state.contracts.length} contracts</span>
        </div>
        <ContractTable contracts={homeContracts} props={props} />
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
                    <td className="muted">{customer.reference ? `${customer.source_system ? `${customer.source_system} · ` : ""}${customer.reference}` : "—"}</td>
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
    [termsView, setTermsView] = useState<"effective" | "baseline">("effective"),
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
  const effectiveTerms = contractTerms(contract, `${props.period}-31`);
  const isMetered = effectiveTerms.consideration.some((item) => item.kind === "metered");
  const availableAction = isMetered && !["billing", "usage"].includes(action) ? "billing" : action;
  const termReview = termReviewStatus(state, contract, `${props.period}-31`);
  const shownTerms = termsView === "effective" ? effectiveTerms : contract;
  const serviceDates = effectiveTerms.obligations.flatMap((obligation) => [obligation.start_date, obligation.end_date]).sort();
  const openingActivity = contract.activities.find((activity) => activity.type === "opening_position");
  const pendingOpening = Boolean(contract.cutover_date && !openingActivity);
  const unlinkedExercises = contract.activities.filter((activity) => activity.type === "right_exercise" && !(state.renewal_links || []).some((link) => link.contract_id === contract.id && link.obligation_id === activity.obligation_id));
  const renewalSupport = (state.report.renewal_links || []).filter((link) => link.contract_id === contract.id || link.renewal_contract_id === contract.id);
  const termsToggle = <div className="button-group"><Button type="button" primary={termsView === "effective"} onClick={() => setTermsView("effective")}>Effective at {props.period} end</Button><Button type="button" primary={termsView === "baseline"} onClick={() => setTermsView("baseline")}>Original baseline</Button></div>;
  return (
    <>
      <Heading
        title={contract.name}
        subtitle={`${customer?.name || "Customer"} · ${dateLabel(contract.start_date)} – ${dateLabel(contract.end_date)}${(contract.term_basis || "fixed") === "fixed" ? "" : " · initial assessed term"}`}
      >
        <Button
          onClick={() => dialog({ type: "details", entityId: contract.id })}
        >
          Edit details
        </Button>
        {unlinkedExercises.length > 0 && <Button disabled={pendingOpening} onClick={() => dialog({ type: "renewal_link", contractId: contract.id })}>Link renewal</Button>}
        <Button
          disabled={pendingOpening || isMetered}
          onClick={() => dialog({ type: "contract", contractId: contract.id })}
        >
          Record accounting change
        </Button>
        {!isMetered && !contract.activities.length && (contract.cutover_date || contract.start_date < `${props.period}-01`) && <Button onClick={() => dialog({ type: "opening_position", contractId: contract.id })}>Record opening position</Button>}
        <div className="split-action">
          <select
            aria-label="Activity type"
            value={availableAction}
            onChange={(e) => setAction(e.target.value)}
          >
            <option value="billing">Billing</option>
            {!isMetered && <option value="progress">Progress</option>}
            <option value="usage">Units delivered</option>
            {!isMetered && <option value="milestone">Satisfaction milestone</option>}
            {effectiveTerms.obligations.some((item) => item.kind === "material_right") && <option value="right_exercise">Exercise material right</option>}
            {!isMetered && <option value="reassessment">Consideration reassessment</option>}
            {!isMetered && <option value="adjustment">Revenue adjustment</option>}
          </select>
          <Button
            primary
            disabled={pendingOpening}
            onClick={() =>
              dialog({
                type: "activity",
                contractId: contract.id,
                activity: availableAction,
              })
            }
          >
            <Plus size={14} />
            Record
          </Button>
        </div>
      </Heading>
      {report && <Metrics summary={report} currency={currency} compact />}
      {pendingOpening && <p className="notice">Opening position due at {dateLabel(contract.cutover_date)}. Record and reconcile it before post-cutover activity; this contract is excluded from accounting reports until then.</p>}
      {openingActivity && <p className="notice">This contract starts from an accepted legacy position on {dateLabel(openingActivity.effective_date)}. Earlier periods are outside this workspace's reported population.</p>}
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
          {isMetered && <p className="notice">Invoice-value rate: {effectiveTerms.consideration[0].unit_rate} {currency}/unit. Revenue includes delivered units only; future volume is unknown.</p>}
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
                  <dt>{isMetered ? "Earned invoice value to date" : "Transaction price"}</dt>
                  <dd>{report ? money(report.transaction_price, currency) : "Outside reported period"}</dd>
                </div>
                <div>
                  <dt>Recognized to date</dt>
                  <dd>{report ? money(report.recognized_to_date, currency) : "Outside reported period"}</dd>
                </div>
                <div>
                  <dt>Billed to date</dt>
                  <dd>{report ? money(report.billed_to_date, currency) : "Outside reported period"}</dd>
                </div>
                <div>
                  <dt>{(contract.term_basis || "fixed") === "fixed" ? "Original legal term" : "Initial assessed accounting term"}</dt>
                  <dd>
                    {dateLabel(contract.start_date)} –{" "}
                    {dateLabel(contract.end_date)}
                  </dd>
                </div>
                {serviceDates.length > 0 && <div><dt>Current service span</dt><dd>{dateLabel(serviceDates[0])} – {dateLabel(serviceDates[serviceDates.length - 1])}</dd></div>}
                <div><dt>Term basis</dt><dd>{effectiveTerms.termAssessment.basis === "fixed" ? "Fixed" : effectiveTerms.termAssessment.basis === "cancellable" ? "Cancellable" : "Evergreen"}</dd></div>
                {effectiveTerms.termAssessment.basis !== "fixed" && <>
                  <div><dt>Assessment basis</dt><dd>{effectiveTerms.termAssessment.rationale}</dd></div>
                  <div><dt>Reassess when</dt><dd>{effectiveTerms.termAssessment.trigger}</dd></div>
                  {termReview.reviewDate && <div><dt>Planned review</dt><dd>{dateLabel(termReview.reviewDate)}{termReview.reviewDate <= `${props.period}-31` ? " · due" : ""}</dd></div>}
                  {termReview.latestReview && <div><dt>Last review</dt><dd>{dateLabel(termReview.latestReview.effective_date)} · {termReview.latestReview.reviewer}</dd></div>}
                </>}
              </dl>
              {termReview.basis !== "fixed" && <Button type="button" onClick={() => dialog({ type: "term_review", contractId: contract.id })}>Complete term review</Button>}
              {contract.rationale && (
                <p className="rationale">{contract.rationale}</p>
              )}
            </Section>
            <Section title={`Performance obligations · effective at ${props.period} end`}>
              <div className="obligation-list">
                {effectiveTerms.obligations.map((o) => (
                  <button key={o.id} onClick={() => setTab("Obligations")}>
                    <span>
                      <strong>{o.name}</strong>
                      <small>{methods[o.method]}</small>
                    </span>
                    <span>
                      {report ? money(report.allocation.find((a) => a.obligation_id === o.id)?.amount, currency) : "—"}
                      <ChevronRight size={13} />
                    </span>
                  </button>
                ))}
              </div>
            </Section>
          </div>
          <Section title="Recent contract activity">
            <ActivityTable contract={contract} currency={currency} limit={6} onCorrect={(activity) => dialog({ type: "activity", contractId: contract.id, activity: activity.type, action: "correct", entityId: activity.id })} />
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
          title={termsView === "effective" ? `Consideration · effective at ${props.period} end` : "Original baseline consideration"}
          subtitle="Changes are preserved in the accounting activity history."
          action={termsToggle}
        >
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Component</th>
                  <th>Type</th>
                  <th className="number">{isMetered ? "Rate" : "Amount"}</th>
                  <th className="number">{isMetered ? "Earned to date" : "Included amount"}</th>
                  <th>Rationale</th>
                </tr>
              </thead>
              <tbody>
                {shownTerms.consideration.map((c) => (
                  <tr key={c.id}>
                    <td className="strong">{c.label}</td>
                    <td>{humanize(c.kind)}</td>
                    <td className="number">{c.kind === "metered" ? `${c.unit_rate} ${currency}/unit` : money(c.amount, currency)}</td>
                    <td className="number">
                      {c.kind === "metered" ? report ? money(report.transaction_price, currency) : "—" : money(c.included_amount || c.amount, currency)}
                    </td>
                    <td className="muted">{c.rationale || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {isMetered && <p className="fine-print">Units are aggregated by calendar month before the rate is applied and rounded to cents.</p>}
        </Section>
      )}
      {tab === "Obligations" && (
        <Section
          title={termsView === "effective" ? `Performance obligations · effective at ${props.period} end` : "Original baseline obligations"}
          subtitle="Service dates and standalone selling prices reflect the selected terms view."
          action={termsToggle}
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
                {shownTerms.obligations.map((o) => (
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
                    <td className="number">{o.method === "metered" ? "Not used" : money(o.ssp, currency)}</td>
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
                          {(() => { const exercise = contract.activities.find((item) => item.type === "right_exercise" && item.obligation_id === o.id && item.effective_date <= `${props.period}-31`); return exercise ? `Exercised ${dateLabel(exercise.effective_date)} · ${methods[String(exercise.delivery_method)] || humanize(String(exercise.delivery_method))} delivery ${dateLabel(String(exercise.delivery_start))} to ${dateLabel(String(exercise.delivery_end))}` : `Exercise by ${dateLabel(o.exercise_end || o.end_date)}`; })()}
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
          title="Transaction price allocation"
          subtitle={isMetered ? "The single service obligation receives the earned amount from actual units at the reviewed invoice-value rate. Future units are not forecast." : "The included transaction price is allocated at posting precision. Relative SSP is the default; eligible components can target specified obligations."}
        >
          {!report ? <p className="notice">This contract is outside the selected period's reported population.</p> : <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Performance obligation</th>
                  <th className="number">Standalone selling price</th>
                  <th className="number">Allocated consideration</th>
                </tr>
              </thead>
              <tbody>
                {report.allocation.map((a) => (
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
                      total(report.allocation.map((a) => a.ssp)),
                      currency,
                    )}
                  </th>
                  <th className="number">
                    {money(
                      total(report.allocation.map((a) => a.amount)),
                      currency,
                    )}
                  </th>
                </tr>
              </tfoot>
            </table>
          </div>}
          {Boolean(report?.allocation_components?.some((item) => item.scope === "specific")) && <><h3>Specific-allocation conclusions</h3><div className="table-wrap"><table><thead><tr><th>Component</th><th className="number">Included amount</th><th className="number">Recognized to date</th><th>Target obligations</th><th>Service month</th><th>Accounting rationale</th></tr></thead><tbody>{report?.allocation_components?.filter((item) => item.scope === "specific").map((item) => <tr key={item.component_id}><td>{item.label}</td><td className="number">{money(item.included_amount, currency)}</td><td className="number">{item.recognized_to_date === null || item.recognized_to_date === undefined ? "—" : money(item.recognized_to_date, currency)}</td><td>{item.target_obligation_ids.map((id) => report.allocation.find((row) => row.obligation_id === id)?.name || id).join(", ")}</td><td>{item.target_period || "All service periods"}</td><td>{item.rationale}</td></tr>)}</tbody></table></div></>}
          {Boolean(report?.original_promise_changes?.length) && <><h3>Changes assigned to original promises</h3><div className="table-wrap"><table><thead><tr><th>Effective date</th><th>Component</th><th>Original obligation</th><th className="number">Allocated change</th><th className="number">Recognized to date</th><th>Accounting rationale</th></tr></thead><tbody>{report?.original_promise_changes?.map((item, index) => <tr key={`${item.activity_id || item.effective_date}:${item.obligation_id}:${index}`}><td>{dateLabel(item.effective_date)}</td><td>{item.component}</td><td>{item.obligation}</td><td className="number">{money(item.allocated_change, currency)}</td><td className="number">{money(item.recognized_to_date, currency)}</td><td>{item.rationale}</td></tr>)}</tbody></table></div></>}
          {renewalSupport.length > 0 && <><h3>Linked renewal</h3>{renewalSupport.map((link) => <div key={link.change_set_id} className="notice"><p><Button type="button" onClick={() => props.navigate("Contracts", link.contract_id, "Allocation")}>{link.contract_name}</Button> → <Button type="button" onClick={() => props.navigate("Contracts", link.renewal_contract_id, "Allocation")}>{link.renewal_contract_name}</Button> · delivery {dateLabel(link.delivery_start)} – {dateLabel(link.delivery_end)}</p><p>Original right allocation {money(link.original_right_allocation, currency)} + current renewal price {money(link.current_renewal_price, currency)} = {money(link.combined_consideration, currency)}. This month: {money(link.right_revenue, currency)} + {money(link.renewal_revenue, currency)} = {money(link.combined_revenue, currency)} revenue.</p><p className="fine-print">{link.rationale}</p></div>)}</>}
        </Section>
      )}
      {tab === "Recognition" && (
        <Section title="Revenue by performance obligation" subtitle={props.focus ? `Reviewing ${report?.allocation.find((item) => item.obligation_id === props.focus)?.name || props.focus}.` : undefined}>
          {!report ? <p className="notice">This contract is outside the selected period's reported population.</p> : <ScheduleTable
            rows={state.report.schedule.filter(
              (s) => s.contract_id === contract.id,
            )}
            props={props}
            byObligation
            allIdentifiers={report.allocation.map((item) => item.obligation_id)}
          />}
        </Section>
      )}
      {tab === "Billing" && (
        <Section
          title="Billing activity"
          subtitle="Enter externally established invoice amounts and dates. This workbench does not track cash, receivables, or when an unbilled right becomes unconditional."
          action={pendingOpening ? undefined :
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
            onCorrect={(activity) => dialog({ type: "activity", contractId: contract.id, activity: activity.type, action: "correct", entityId: activity.id })}
          />
        </Section>
      )}
      {tab === "Changes" && (
        <>
          <Section title="Accounting activity">
            <ActivityTable contract={contract} currency={currency} onCorrect={(activity) => dialog({ type: "activity", contractId: contract.id, activity: activity.type, action: "correct", entityId: activity.id })} />
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
  onCorrect,
}: {
  contract: Contract;
  currency: string;
  type?: string;
  limit?: number;
  onCorrect?: (activity: Contract["activities"][number]) => void;
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
            {onCorrect && <th>Source fact</th>}
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
                  (a.type === "opening_position" ? String(a.source_name || "Legacy source") : "") ||
                  "—"}
              </td>
              <td className="number">
                {a.type === "opening_position"
                  ? Number(a.contract_asset || 0) > 0 ? `Opening asset ${money(String(a.contract_asset), currency)}` : Number(a.deferred_revenue || 0) > 0 ? `Opening deferred ${money(String(a.deferred_revenue), currency)}` : "No opening net balance"
                  : a.type === "right_exercise"
                  ? `Delivery ${dateLabel(String(a.delivery_start))} to ${dateLabel(String(a.delivery_end))}`
                  : a.amount !== undefined
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
              {onCorrect && <td>{["billing", "progress", "usage", "milestone"].includes(a.type) && <Button type="button" onClick={() => onCorrect(a)}>Correct</Button>}{Boolean(a.corrects) && <small className="cell-subtitle">Corrected from {String(a.corrects)}</small>}</td>}
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
  shownPeriods,
}: {
  rows: Schedule[];
  props: ViewProps;
  byObligation?: boolean;
  allIdentifiers?: string[];
  shownPeriods?: string[];
}) {
  const periods = shownPeriods || [...new Set(rows.length ? rows.map((r) => r.period) : [props.period])].sort();
  const identifierFor = (row: Schedule) => byObligation ? `${row.contract_id}\u0000${row.obligation_id}` : row.contract_id;
  const identifiers = [
    ...new Set(
      [...allIdentifiers.map((id) => byObligation && !id.includes("\u0000") ? `${rows[0]?.contract_id || props.selected || ""}\u0000${id}` : id), ...rows.map(identifierFor)],
    ),
  ];
  const currency = props.state.workspace.currency;
  const values = new Map<string, string[]>();
  const periodValues = new Map<string, string[]>();
  for (const row of rows) {
    const id = identifierFor(row);
    const key = `${row.period}\u0000${id}`;
    values.set(key, [...(values.get(key) || []), row.revenue]);
    periodValues.set(row.period, [...(periodValues.get(row.period) || []), row.revenue]);
  }
  const name = (id: string) =>
    byObligation
      ? (() => { const [contractId, obligationId] = id.split("\u0000"); const contract = props.state.contracts.find((item) => item.id === contractId); const obligation = contract && contractTerms(contract, `${props.period}-31`).obligations.find((item) => item.id === obligationId); return `${props.selected === contractId ? "" : `${contract?.name || contractId} / `}${obligation?.name || obligationId}`; })()
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
            <tr key={id} className={id === props.focus || (byObligation && id.split("\u0000")[1] === props.focus) ? "focus-obligation" : ""}>
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
                    total(values.get(`${p}\u0000${id}`) || []),
                    currency,
                  )}
                </td>
              ))}
              <td className="number strong">
                {money(
                  total(periods.flatMap((period) => values.get(`${period}\u0000${id}`) || [])),
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
                  total(periodValues.get(p) || []),
                  currency,
                )}
              </th>
            ))}
            <th className="number">
              {money(total(periods.flatMap((period) => periodValues.get(period) || [])), currency)}
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
  const [group, setGroup] = useState("contract"),
    [horizon, setHorizon] = useState("12"),
    [customerFilter, setCustomerFilter] = useState("");
  const months = Number(horizon);
  const shownPeriods = Array.from({ length: months }, (_, index) => {
    const [year, month] = props.period.split("-").map(Number);
    const date = new Date(Date.UTC(year, month - 1 + index, 1));
    return date.toISOString().slice(0, 7);
  });
  const visibleContracts = props.state.contracts.filter((contract) => !customerFilter || contract.customer_id === customerFilter);
  const visibleIds = new Set(visibleContracts.map((contract) => contract.id));
  const rows = props.state.report.schedule.filter((row) => visibleIds.has(row.contract_id) && shownPeriods.includes(row.period));
  const unscheduled = props.state.report.contracts.filter((contract) => visibleIds.has(contract.id)).map((contract) => {
    const future = total(props.state.report.schedule.filter((row) => row.contract_id === contract.id && row.period > props.period).map((row) => row.revenue));
    return { contract, gap: total([contract.remaining_revenue, future.startsWith("-") ? future.slice(1) : `-${future}`]) };
  }).filter((item) => Number(item.gap) > 0);
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
        <label>Horizon <select value={horizon} onChange={(event) => setHorizon(event.target.value)}><option value="6">6 months</option><option value="12">12 months</option><option value="24">24 months</option><option value="60">60 months</option></select></label>
        <label>Customer <select value={customerFilter} onChange={(event) => setCustomerFilter(event.target.value)}><option value="">All customers</option>{props.state.customers.map((customer) => <option key={customer.id} value={customer.id}>{customer.name}</option>)}</select></label>
      </div>
      <ScheduleTable
        rows={rows}
        props={props}
        byObligation={group === "obligation"}
        shownPeriods={shownPeriods}
        allIdentifiers={group === "contract" ? visibleContracts.map((contract) => contract.id) : visibleContracts.flatMap((contract) => contractTerms(contract, `${props.period}-31`).obligations.map((obligation) => `${contract.id}\u0000${obligation.id}`))}
      />
      {unscheduled.length > 0 && <Section title="Unscheduled remaining revenue" subtitle="Recognition still depends on future recorded progress, finite units, or milestones; zero in the calendar does not mean none remains."><div className="table-wrap"><table><thead><tr><th>Contract</th><th className="number">Unscheduled</th></tr></thead><tbody>{unscheduled.map(({ contract, gap }) => <tr key={contract.id}><td><button className="table-link" onClick={() => props.navigate("Contracts", contract.id, "Recognition")}>{contract.name}</button></td><td className="number">{money(gap, props.state.workspace.currency)}</td></tr>)}</tbody></table></div></Section>}
      <p className="fine-print">
        Calendar months only. Selected period highlighted; totals cover the displayed horizon. Closed Main periods retain their accepted results.
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
                <Section title="Proposed accounting changes" subtitle="Every proposal recorded in this scenario remains visible even when financial effects offset.">
                  {comparison.proposals?.length ? <div className="table-wrap"><table><thead><tr><th>Effective</th><th>Change</th><th>Entity</th><th>Review note</th></tr></thead><tbody>{comparison.proposals.map((proposal) => <tr key={proposal.id}><td>{dateLabel(proposal.effective_date)}</td><td><button className="table-link" onClick={() => navigate("Activity", proposal.id)}>{humanize(proposal.command)}</button></td><td>{state.contracts.find((contract) => contract.id === proposal.entity_id)?.name || state.customers.find((customer) => customer.id === proposal.entity_id)?.name || proposal.entity_id}</td><td>{proposal.rationale || "—"}</td></tr>)}</tbody></table></div> : <p className="muted">No accounting proposals recorded.</p>}
                </Section>
                {Boolean(comparison.conflicts?.length) && <Section title="Main changes requiring conflict review" subtitle="These accepted accounting changes touch the same records as this scenario."><div className="table-wrap"><table><thead><tr><th>Main version</th><th>Change</th><th>Entity</th></tr></thead><tbody>{comparison.conflicts?.map((conflict) => <tr key={conflict.version}><td>{conflict.version}</td><td>{humanize(conflict.command)}</td><td>{conflict.entity_id}</td></tr>)}</tbody></table></div></Section>}
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
                {Boolean(comparison.details?.length) && <Section title="Obligation-level recognition differences"><div className="table-wrap"><table><thead><tr><th>Period</th><th>Contract</th><th>Obligation</th><th className="number">Main</th><th className="number">Scenario</th><th className="number">Difference</th></tr></thead><tbody>{comparison.details?.map((row) => <tr key={`${row.period}:${row.contract_id}:${row.obligation_id}`}><td>{row.period}</td><td>{state.contracts.find((contract) => contract.id === row.contract_id)?.name || row.contract_id}</td><td>{row.obligation_id}</td><td className="number">{money(row.current, currency)}</td><td className="number">{money(row.proposed, currency)}</td><td className="number">{money(row.delta, currency)}</td></tr>)}</tbody></table></div></Section>}
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
        subtitle={state.scenario_id === "main" ? "Derived from Main accounting state for " + monthLabel(props.period) + "." : "Hypothetical journal for " + monthLabel(props.period) + " in the selected scenario."}
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
          profileName={(id) => state.policy.account_profiles?.[id]?.name || id}
          onContract={(id) => props.navigate("Contracts", id)}
        />
      </Section>
      {Boolean(state.report.segment_imbalances?.length) && <Section title="Dimension balancing review" subtitle="The journal balances overall. These dimension combinations do not; confirm whether your ledger adds interunit entries or prepare the required entries before posting."><div className="table-wrap"><table><thead><tr><th>Contract</th><th>Dimensions</th><th className="number">Net debit / (credit)</th></tr></thead><tbody>{state.report.segment_imbalances?.map((item, index) => <tr key={`${item.contract_id}:${index}`}><td><button className="table-link" onClick={() => props.navigate("Contracts", item.contract_id)}>{state.contracts.find((contract) => contract.id === item.contract_id)?.name || item.contract_id}</button></td><td>{Object.entries(item.dimensions).map(([key, value]) => `${key}: ${value}`).join(" · ") || "Unassigned"}</td><td className="number">{money(item.net_debit, state.workspace.currency)}</td></tr>)}</tbody></table></div></Section>}
      <JournalPostingRecord key={`${state.scenario_id}:${props.period}`} props={props} />
      <p className="fine-print">
        Billing clearing assumes a complementary invoice posting outside OpenRevRec. Reconcile that account before posting this export; posting both full journals without mapping the offset can duplicate revenue or deferred balances. Contract asset here is a simplified revenue-less-billing position, not an assessment of unconditional receivables.
      </p>
    </>
  );
}

function JournalPostingRecord({ props }: { props: ViewProps }) {
  const { state, period } = props;
  const [reference, setReference] = useState("");
  const [postedDate, setPostedDate] = useState(today());
  const [rationale, setRationale] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const batchId = state.report.journal_batch_id || "";
  const postings = state.scenario_id === "main" ? (state.postings || []).filter((item) => item.period === period) : [];
  const current = postings.filter((item) => item.batch_id === batchId);
  const comparisons = state.scenario_id === "main" ? state.posting_comparisons || [] : [];
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await post("/api/commands", { command: "record_export_posting", scenario_id: "main", period, payload: { period, batch_id: batchId, external_journal_reference: reference, posted_date: postedDate, rationale } });
      setReference("");
      setRationale("");
      await props.refresh("External journal reference recorded.");
    } catch (caught) { setError((caught as Error).message); }
    finally { setBusy(false); }
  };
  return <><Section title="External posting record" subtitle="Record the ledger reference after posting a closed-period batch. OpenRevRec does not transmit or verify the journal in your ledger.">
    <p className="muted">Current journal batch: <code>{batchId || "—"}</code></p>
    {current.map((item) => <p key={item.external_journal_reference}><strong>{item.external_journal_reference}</strong> · posted {dateLabel(item.posted_date)} · {item.rationale}</p>)}
    {comparisons.length > 0 && current.length === 0 && <p className="warning">A prior batch has an external posting record. Reconcile the ledger to that batch before using the replacement support below.</p>}
    {state.scenario_id !== "main" ? <p className="notice">This is hypothetical scenario output.</p> : !state.report.closed ? <p className="notice">Close this period before recording an external posting.</p> : <form onSubmit={(event) => void submit(event)}>
      <div className="form-grid"><label className="field">External journal reference<input required value={reference} onChange={(event) => setReference(event.target.value)} placeholder="ERP journal ID" /></label><label className="field">Posted date<input required type="date" value={postedDate} onChange={(event) => setPostedDate(event.target.value)} /></label></div>
      <label className="field">Posting explanation<input required value={rationale} onChange={(event) => setRationale(event.target.value)} placeholder="Identify the ledger and reconciliation" /></label>
      <Button primary type="submit" busy={busy}>Record posting reference</Button>
    </form>}
    <ErrorMessage error={error} />
  </Section>
    {comparisons.length > 0 && <Section title="Replacement journal support" subtitle="Each comparison nets the recorded posted close against the current journal by contract, account, and dimensions. Confirm which batch represents the ledger before using a delta.">
      {comparisons.length > 1 && <p className="warning">More than one earlier batch has a posting reference. These are alternative comparisons, not amounts to combine. Confirm the ledger's current batch.</p>}
      {comparisons.map((comparison) => <div key={comparison.source_batch_id} className="section">
        <p><strong>{comparison.source_batch_id}</strong> → <strong>{comparison.target_batch_id}</strong> · {comparison.posting_references.join(", ")}</p>
        {comparison.posting_references.length > 1 && <p className="warning">This source batch has multiple external references. Confirm which posting and ledger balance this comparison represents.</p>}
        <p className="fine-print">{comparison.current_batch_posted ? "The current batch also has a posting reference; this comparison is historical." : comparison.target_closed ? "Compared with the accepted replacement close." : "Draft comparison while this period is open; recheck after close."}</p>
        {!comparison.available ? <p className="warning">The posted batch's close snapshot is unavailable. Reconcile its original export before preparing a replacement.</p> : comparison.lines.length === 0 ? <p className="notice">No net ledger change at contract, account, and dimension detail.</p> : <div className="table-wrap"><table><thead><tr><th>Contract</th><th>Account</th><th>Dimensions</th><th className="number">Posted net</th><th className="number">Revised net</th><th className="number">Delta debit</th><th className="number">Delta credit</th></tr></thead><tbody>{comparison.lines.map((line) => <tr key={`${line.contract_id}:${line.account}:${JSON.stringify(line.dimensions)}`}><td>{state.contracts.find((contract) => contract.id === line.contract_id)?.name || line.contract_id}</td><td>{line.account}</td><td>{Object.entries(line.dimensions).map(([key, value]) => `${key}: ${value}`).join(" · ") || "—"}</td><td className="number">{money(line.posted_net, state.workspace.currency)}</td><td className="number">{money(line.revised_net, state.workspace.currency)}</td><td className="number">{money(line.debit, state.workspace.currency)}</td><td className="number">{money(line.credit, state.workspace.currency)}</td></tr>)}</tbody></table></div>}
      </div>)}
    </Section>}
  </>;
}

export function ReportsView(props: ViewProps) {
  return <ReportsWorkspace {...props} />;
}

export function ImportsView(props: ViewProps) {
  const [file, setFile] = useState<File | null>(null),
    [review, setReview] = useState<{
      before: Report;
      state: { report: Report };
      comparison: Comparison & { affected_periods: string[] };
      frontier: number;
      result: {
        file_hash: string;
        imported: number;
        controls: { counts: Record<string, number>; source_billing_total: string; source_usage_quantity: string; opening_positions?: { contract_id: string; cutover_date: string; recognized_to_date: string; billed_to_date: string; contract_asset: string; deferred_revenue: string; source_name: string; obligations: { obligation_id: string; recognized_to_date: string; measure?: string }[] }[] };
        rows: { sheet: string; row: number; command: string; source_id: string; effective_date: string }[];
      };
      period_impacts: { period: string; delta: { revenue: string; billings: string; deferred_revenue: string; contract_asset: string; remaining_revenue: string }; journal_changed: boolean }[];
    } | null>(null),
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
  useEffect(() => {
    setReview(null);
  }, [props.state.scenario_id, props.period, props.state.frontier]);
  const reviewUpload = async () => {
    if (!file) return;
    setBusy(true);
    setError("");
    setReview(null);
    const data = new FormData();
    data.append("file", file);
    data.append("scenario_id", props.state.scenario_id);
    data.append("period", props.period);
    try {
      setReview(await api<typeof review>("/api/import/preview", { method: "POST", body: data }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const upload = async () => {
    if (!file || !review) return;
    setBusy(true);
    setError("");
    const data = new FormData();
    data.append("file", file);
    data.append("scenario_id", props.state.scenario_id);
    data.append("period", props.period);
    data.append("expected_frontier", String(review.frontier));
    data.append("expected_hash", review.result.file_hash);
    try {
      await api("/api/import", { method: "POST", body: data });
      setFile(null);
      setReview(null);
      await props.refresh("Workbook imported.");
      void load();
    } catch (e) {
      setError((e as Error).message);
      setReview(null);
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
        subtitle="Review every row and the accounting impact before the workbook commits as one transaction."
      >
        <div className="upload-row">
          <label className="file-picker">
            <Upload size={17} />
            <span>{file?.name || "Choose an .xlsx workbook"}</span>
            <input
              type="file"
              accept=".xlsx"
              onChange={(e) => { setFile(e.target.files?.[0] || null); setReview(null); }}
            />
          </label>
          <Button disabled={!file} busy={busy} onClick={reviewUpload}>
            Preview workbook
          </Button>
        </div>
        <ErrorMessage error={error} />
        {review && (
          <div className="preview">
            <h3>{review.result.imported} rows ready to import</h3>
            <p className="fine-print">Target: {props.state.workspace.name} · {props.state.scenario_id === "main" ? "Main" : props.state.scenarios.find((scenario) => scenario.id === props.state.scenario_id)?.name || props.state.scenario_id} · {props.state.workspace.currency}. The source workbook will be retained with the import result.</p>
            <p className="fine-print">Source controls: {Object.entries(review.result.controls.counts).map(([command, count]) => `${humanize(command)} ${count}`).join(" · ")}. Billing rows total {money(review.result.controls.source_billing_total, props.state.workspace.currency)}; usage rows total {review.result.controls.source_usage_quantity} units. Corrections are listed separately from original source rows.</p>
            {Boolean(review.result.controls.opening_positions?.length) && <><h3>Opening positions to reconcile</h3><p className="fine-print">Tie these cumulative legacy amounts and the obligation detail to the accepted source and GL before import. They become beginning balances, not current-month postings.</p><div className="table-wrap"><table><thead><tr><th>Contract / source</th><th>Cutover</th><th className="number">Recognized</th><th className="number">Billed</th><th className="number">Asset</th><th className="number">Deferred</th></tr></thead><tbody>{review.result.controls.opening_positions?.map((item) => <tr key={`${item.contract_id}:${item.cutover_date}`}><td>{review.state.report.contracts.find((contract) => contract.id === item.contract_id)?.name || item.contract_id}<small className="cell-subtitle">{item.source_name}</small></td><td>{item.cutover_date}</td><td className="number">{money(item.recognized_to_date, props.state.workspace.currency)}</td><td className="number">{money(item.billed_to_date, props.state.workspace.currency)}</td><td className="number">{money(item.contract_asset, props.state.workspace.currency)}</td><td className="number">{money(item.deferred_revenue, props.state.workspace.currency)}</td></tr>)}</tbody></table></div><div className="table-wrap"><table><thead><tr><th>Contract</th><th>Obligation</th><th className="number">Recognized before cutover</th><th className="number">Cumulative measure</th></tr></thead><tbody>{review.result.controls.opening_positions?.flatMap((item) => item.obligations.map((row) => <tr key={`${item.contract_id}:${row.obligation_id}`}><td>{item.contract_id}</td><td>{row.obligation_id}</td><td className="number">{money(row.recognized_to_date, props.state.workspace.currency)}</td><td className="number">{row.measure || "—"}</td></tr>))}</tbody></table></div></>}
            <div className="table-wrap"><table><thead><tr><th>Sheet / row</th><th>Command</th><th>Effective date</th><th>Source ID</th></tr></thead><tbody>
              {review.result.rows.map((row) => <tr key={`${row.sheet}-${row.row}`}><td>{row.sheet} {row.row}</td><td>{humanize(row.command)}</td><td>{row.effective_date || "—"}</td><td>{row.source_id || "Content / reference"}</td></tr>)}
            </tbody></table></div>
            <FinancialPreview before={review.before} after={review.state.report} currency={props.state.workspace.currency} />
            {review.period_impacts.length > 0 && <><h3>Financial changes by period</h3><div className="table-wrap"><table><thead><tr><th>Period</th><th className="number">Revenue change</th><th className="number">Billing change</th><th className="number">Deferred change</th><th className="number">Asset change</th><th>Journal</th></tr></thead><tbody>{review.period_impacts.map((row) => <tr key={row.period}><td>{row.period}</td><td className="number">{money(row.delta.revenue, props.state.workspace.currency)}</td><td className="number">{money(row.delta.billings, props.state.workspace.currency)}</td><td className="number">{money(row.delta.deferred_revenue, props.state.workspace.currency)}</td><td className="number">{money(row.delta.contract_asset, props.state.workspace.currency)}</td><td>{row.journal_changed ? "Changed" : "Unchanged"}</td></tr>)}</tbody></table></div></>}
            <h3>Recognition by period</h3>
            <div className="table-wrap"><table><thead><tr><th>Period</th><th className="number">Current</th><th className="number">After import</th><th className="number">Change</th></tr></thead><tbody>
              {review.comparison.rows.filter((row) => Number(row.delta) !== 0).map((row) => <tr key={row.period}><td>{row.period}</td><td className="number">{money(row.main_revenue, props.state.workspace.currency)}</td><td className="number">{money(row.scenario_revenue, props.state.workspace.currency)}</td><td className="number">{money(row.delta, props.state.workspace.currency)}</td></tr>)}
            </tbody></table></div>
            <Button primary busy={busy} onClick={upload}>Import reviewed rows</Button>
          </div>
        )}
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
                      {item.error ? <>{item.error} <a href={"/api/imports/" + encodeURIComponent(item.id) + "/errors.csv"} download>Download error CSV</a></> : "All rows accepted"}
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
        subtitle={"Default roles, reusable profiles, and specific overrides effective for " + props.period + ". Earlier periods retain their prior mapping."}
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
        {Boolean(Object.keys(state.policy.account_profiles || {}).length) && <><h3>Reusable profiles</h3><div className="table-wrap"><table><thead><tr><th>Profile</th><th>Accounts</th><th>Dimensions</th><th>Assigned contracts</th><th>Assigned revenue obligations</th></tr></thead><tbody>{Object.entries(state.policy.account_profiles || {}).map(([id, profile]) => <tr key={id}><td>{profile.name}</td><td>{Object.entries(profile.accounts).map(([role, code]) => `${humanize(role)}: ${code}`).join(" · ") || "Workspace defaults"}</td><td>{Object.entries(profile.dimensions).map(([key, value]) => `${key}: ${value}`).join(" · ") || "—"}</td><td>{Object.entries(state.policy.profile_assignments || {}).filter(([, profileId]) => profileId === id).map(([contractId]) => state.contracts.find((contract) => contract.id === contractId)?.name || contractId).join(", ") || "—"}</td><td>{Object.entries(state.policy.obligation_profile_assignments || {}).flatMap(([contractId, items]) => Object.entries(items).filter(([, profileId]) => profileId === id).map(([obligationId]) => `${state.contracts.find((contract) => contract.id === contractId)?.name || contractId} / ${obligationId}`)).join(", ") || "—"}</td></tr>)}</tbody></table></div><p className="fine-print">Contract profiles supply dimensions for balance and billing lines. Obligation profiles route revenue lines separately. Review any dimension-level imbalance and your ledger's interunit posting rules before posting.</p></>}
        {Boolean(Object.keys(state.policy.account_overrides?.contracts || {}).length || Object.keys(state.policy.account_overrides?.obligations || {}).length) && <div className="table-wrap"><table><thead><tr><th>Scope</th><th>Contract</th><th>Role / obligation</th><th>Account</th></tr></thead><tbody>{Object.entries(state.policy.account_overrides?.contracts || {}).flatMap(([contractId, roles]) => Object.entries(roles).map(([role, account]) => <tr key={contractId + role}><td>Contract</td><td>{state.contracts.find((contract) => contract.id === contractId)?.name || contractId}</td><td>{humanize(role)}</td><td className="mono">{account}</td></tr>))}{Object.entries(state.policy.account_overrides?.obligations || {}).flatMap(([contractId, mapped]) => Object.entries(mapped).map(([obligationId, account]) => <tr key={contractId + obligationId}><td>Obligation revenue</td><td>{state.contracts.find((contract) => contract.id === contractId)?.name || contractId}</td><td>{obligationId}</td><td className="mono">{account}</td></tr>))}</tbody></table></div>}
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
