import { useEffect, useRef, useState, type ReactNode } from "react";
import { changeComponentKind, contractTerms } from "./contractTerms";
import { ArrowLeft, Plus, Trash2 } from "lucide-react";
import { api, post, uid, money, humanize, dateLabel, total } from "./api";
import type { Review } from "./ReportsWorkspace";
import {
  Button,
  Field,
  Modal,
  ErrorMessage,
  FinancialPreview,
  Section,
  JournalsTable,
} from "./components";
import type {
  State,
  Customer,
  Contract,
  Activity,
  Component,
  Obligation,
  Command,
  Preview,
  AccountProfile,
} from "./types";

type FormProps = {
  state: State;
  period: string;
  onClose: () => void;
  onDone: (message: string) => Promise<void>;
};
export function CommandDialog({
  title,
  subtitle,
  children,
  command,
  state,
  period,
  onClose,
  onDone,
  wide = false,
  confirmLabel = "Record change",
  successMessage = "Change recorded.",
  previewRequired = true,
  canSubmit = true,
}: FormProps & {
  title: string;
  subtitle?: string;
  children: ReactNode;
  command: () => Command;
  wide?: boolean;
  confirmLabel?: string;
  successMessage?: string;
  previewRequired?: boolean;
  canSubmit?: boolean;
}) {
  const [preview, setPreview] = useState<Preview | null>(null),
    [supportFile, setSupportFile] = useState<File | null>(null),
    [supportNote, setSupportNote] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const pending = useRef<{ body: string; key: string } | null>(null);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const envelope = { ...command(), scenario_id: state.scenario_id, period };
      if (!preview && previewRequired) {
        setPreview(await post<Preview>("/api/preview", envelope));
      } else {
        const body = JSON.stringify(envelope);
        if (pending.current?.body !== body)
          pending.current = { body, key: uid() };
        // A lost response or failed refresh must not duplicate accepted activity.
        const accepted = await post<{ result: { change_set_id: string } }>("/api/commands", {
          ...envelope,
          idempotency_key: pending.current.key,
        });
        if (supportFile) {
          const data = new FormData();
          data.append("file", supportFile);
          data.append("target_change_set_id", accepted.result.change_set_id);
          data.append("scenario_id", state.scenario_id);
          data.append("period", period);
          data.append("rationale", supportNote);
          const entityId = envelope.payload.contract_id || envelope.payload.entity_id;
          if (typeof entityId === "string") data.append("entity_id", entityId);
          await api("/api/evidence", { method: "POST", body: data });
          setSupportFile(null);
        }
        await onDone(successMessage);
        onClose();
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={title}
      subtitle={subtitle}
      onClose={() => {
        if (!busy) onClose();
      }}
      wide={wide}
    >
      <form
        onSubmit={submit}
        onChange={() => {
          if (preview) setPreview(null);
        }}
      >
        <div className="modal-body">
          {preview ? (
            <>
              {preview.focus_period && preview.selected_period && preview.focus_period !== preview.selected_period && <p className="notice">This change takes effect after the selected month. The preview below starts in {preview.focus_period}; the selected month is {preview.selected_period}.</p>}
              <FinancialPreview
                before={preview.before}
                after={preview.state.report}
                currency={state.workspace.currency}
              />
              {Boolean(preview.comparison?.details?.length) && (
                <Section title="Recognition changes across periods" subtitle="Each changed obligation is shown, even when contract-level increases and decreases offset.">
                  <div className="table-wrap"><table><thead><tr><th>Period</th><th>Contract</th><th>Obligation</th><th className="number">Current</th><th className="number">After change</th><th className="number">Change</th></tr></thead><tbody>
                    {preview.comparison?.details?.map((row) => <tr key={`${row.period}:${row.contract_id}:${row.obligation_id}`}><td>{row.period}</td><td>{preview.state.contracts.find((contract) => contract.id === row.contract_id)?.name || row.contract_id}</td><td>{row.obligation_id}</td><td className="number">{money(row.current, state.workspace.currency)}</td><td className="number">{money(row.proposed, state.workspace.currency)}</td><td className="number">{money(row.delta, state.workspace.currency)}</td></tr>)}
                  </tbody></table></div>
                </Section>
              )}
              <Section title="Journal impact">
                <JournalsTable
                  rows={preview.state.report.journals}
                  currency={state.workspace.currency}
                  contractName={(id) =>
                    preview.state.contracts.find((c) => c.id === id)?.name || id
                  }
                />
              </Section>
              {["record_opening_position", "modify_contract", "reassess_variable_consideration", "record_adjustment", "set_policy", "reopen_period"].includes(command().command) && <Section title="Support this judgment" subtitle="Attach the document or analysis used for this accounting conclusion.">
                <Field label="Supporting file (optional)"><input type="file" onChange={(event) => setSupportFile(event.target.files?.[0] || null)} /></Field>
                {supportFile && <Field label="Evidence note"><input value={supportNote} onChange={(event) => setSupportNote(event.target.value)} placeholder="What this file supports" /></Field>}
              </Section>}
            </>
          ) : (
            children
          )}
          <ErrorMessage error={error} />
        </div>
        <footer className="modal-footer">
          <span className="fine-print">
            {state.scenario_id === "main"
              ? "Recording in Main"
              : `Recording in ${state.scenarios.find((s) => s.id === state.scenario_id)?.name || "scenario"}`}
          </span>
          <div className="button-group">
            {preview ? (
              <Button type="button" onClick={() => setPreview(null)} disabled={busy}>
                <ArrowLeft size={14} />
                Edit details
              </Button>
            ) : (
              <Button type="button" onClick={onClose} disabled={busy}>
                Cancel
              </Button>
            )}
            <Button primary type="submit" busy={busy} disabled={!canSubmit}>
              {preview || !previewRequired ? confirmLabel : "Preview impact"}
            </Button>
          </div>
        </footer>
      </form>
    </Modal>
  );
}
export function CustomerForm(props: FormProps) {
  const [name, setName] = useState(""),
    [email, setEmail] = useState(""),
    [reference, setReference] = useState(""),
    [sourceSystem, setSourceSystem] = useState("");
  return (
    <CommandDialog
      {...props}
      title="New customer"
      previewRequired={false}
      command={() => ({
        command: "create_customer",
        payload: { name, email, reference, source_system: sourceSystem },
      })}
      confirmLabel="Create customer"
      successMessage="Customer created."
    >
      <Field label="Customer name">
        <input
          autoFocus
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Acme, Inc."
        />
      </Field>
      <div className="form-grid">
        <Field label="Email">
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </Field>
        <Field label="External customer ID">
          <input
            value={reference}
            onChange={(e) => setReference(e.target.value)}
            placeholder="Your customer ID"
          />
        </Field>
        <Field label="Source system" hint="Use the system that assigned the external customer ID; the same ID cannot identify two customers in one source system.">
          <input value={sourceSystem} onChange={(e) => setSourceSystem(e.target.value)} placeholder="e.g. CRM" />
        </Field>
      </div>
    </CommandDialog>
  );
}
export function DetailsForm(
  props: FormProps & { entity: Customer | Contract },
) {
  const { entity } = props;
  const customer = !("customer_id" in entity);
  const [name, setName] = useState(entity.name),
    [reference, setReference] = useState(entity.reference || ""),
    [sourceSystem, setSourceSystem] = useState(customer ? entity.source_system || "" : ""),
    [description, setDescription] = useState(entity.description || ""),
    [email, setEmail] = useState(customer ? entity.email || "" : "");
  return (
    <CommandDialog
      {...props}
      title={`Edit ${customer ? "customer" : "contract"} details`}
      subtitle="Update descriptive fields without changing accounting terms."
      previewRequired={false}
      command={() => ({
        command: "edit_details",
        payload: {
          entity_id: entity.id,
          name,
          reference,
          description,
          ...(customer ? { email, source_system: sourceSystem } : {}),
        },
      })}
      confirmLabel="Save details"
      successMessage="Details updated."
    >
      <Field label="Name">
        <input
          autoFocus
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </Field>
      <div className="form-grid">
        {customer && (
          <Field label="Email">
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </Field>
        )}
        <Field label="Reference">
          <input
            value={reference}
            onChange={(e) => setReference(e.target.value)}
          />
        </Field>
        {customer && <Field label="Source system"><input value={sourceSystem} onChange={(e) => setSourceSystem(e.target.value)} /></Field>}
      </div>
      <Field label="Description">
        <textarea
          rows={4}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Optional internal description"
        />
      </Field>
      <p className="fine-print">
        Use Record modification for changes to consideration, obligations,
        timing, or recognition.
      </p>
    </CommandDialog>
  );
}
const kinds = [
  "service",
  "implementation",
  "license",
  "support",
  "product",
  "material_right",
  "other",
];
export const methods: Record<string, string> = {
  exact_days: "Over time · exact days",
  monthly: "Equal amount per touched calendar month",
  prorated_monthly: "Calendar-month weights · partial months prorated",
  point_in_time: "Point in time",
  progress: "Cumulative progress",
  usage: "Finite units / contracted quantity",
  milestone: "Milestone completion",
};
function ComponentEditor({
  items,
  obligations,
  onChange,
  allowEmpty = false,
}: {
  items: Component[];
  obligations: Obligation[];
  onChange: (items: Component[]) => void;
  allowEmpty?: boolean;
}) {
  const update = (i: number, patch: Partial<Component>) =>
    onChange(
      items.map((item, index) => (index === i ? { ...item, ...patch } : item)),
    );
  return (
    <Section
      title="Consideration"
      subtitle="Build the transaction price from its individual components."
      action={
        <Button
          type="button"
          onClick={() =>
            onChange([
              ...items,
              { id: uid(), label: "", kind: "fixed", amount: "" },
            ])
          }
        >
          <Plus size={14} />
          Add component
        </Button>
      }
    >
      <p className="fine-print">Relative SSP across all obligations is the default. You may direct an eligible variable, usage, or credit component to selected obligations with a recorded accounting rationale. Allocation to particular service periods remains outside this workflow.</p>
      {items.map((item, i) => (
        <div className="editor-row" key={item.id}>
          <div className="form-grid component-grid">
            <Field label="Description">
              <input
                required
                value={item.label}
                onChange={(e) => update(i, { label: e.target.value })}
                placeholder="Annual subscription"
              />
            </Field>
            <Field label="Type">
              <select
                value={item.kind}
                onChange={(e) =>
                  onChange(
                    items.map((old, index) =>
                      index === i
                        ? changeComponentKind(item, e.target.value)
                        : old,
                    ),
                  )
                }
              >
                {["fixed", "variable", "usage", "credit"].map((kind) => (
                  <option key={kind} value={kind}>
                    {humanize(kind)}
                  </option>
                ))}
              </select>
            </Field>
            <Field
              label={item.kind === "variable" ? "Potential amount" : "Amount"}
            >
              <input
                type="number"
                step="0.01"
                required
                value={item.amount}
                onChange={(e) =>
                  update(i, {
                    amount: e.target.value,
                    ...(item.kind === "variable"
                      ? { potential_amount: e.target.value }
                      : {}),
                  })
                }
              />
            </Field>
            <button
              className="icon-button remove"
              type="button"
              aria-label={`Remove component ${i + 1}`}
              disabled={!allowEmpty && items.length === 1}
              onClick={() => onChange(items.filter((_, index) => i !== index))}
            >
              <Trash2 size={15} />
            </button>
          </div>
          {["variable", "usage"].includes(item.kind) && (
            <>
              <div className="form-grid">
                <Field label="Estimated amount">
                  <input
                    type="number"
                    step="0.01"
                    value={item.estimated_amount || ""}
                    onChange={(e) =>
                      update(i, { estimated_amount: e.target.value })
                    }
                  />
                </Field>
                <Field label="Amount included in transaction price">
                  <input
                    type="number"
                    step="0.01"
                    required
                    value={item.included_amount || ""}
                    onChange={(e) =>
                      update(i, { included_amount: e.target.value })
                    }
                  />
                </Field>
                <Field label="Estimation method">
                  <select
                    value={item.estimation_method || "most_likely_amount"}
                    onChange={(e) =>
                      update(i, { estimation_method: e.target.value })
                    }
                  >
                    <option value="most_likely_amount">
                      Most likely amount
                    </option>
                    <option value="expected_value">Expected value</option>
                  </select>
                </Field>
              </div>
              <Field label="Constraint rationale">
                <input
                  value={item.rationale || ""}
                  onChange={(e) => update(i, { rationale: e.target.value })}
                  placeholder="Explain the amount included and the constraint."
                />
              </Field>
            </>
          )}
          {item.kind === "usage" && (
            <p className="fine-print">
              Usage-based pricing is separate from the satisfaction method.
              Reassess consideration explicitly when the included amount
              changes. Uncapped metered rates, tiers, and overages are not calculated from units in this workflow.
            </p>
          )}
          {["variable", "usage", "credit"].includes(item.kind) && <>
            <Field label="Allocation treatment"><select value={item.allocation_scope || "relative_ssp"} onChange={(event) => {
              if (event.target.value === "specific") update(i, { allocation_scope: "specific", target_obligation_ids: [], allocation_rationale: "" });
              else onChange(items.map((candidate, index) => {
                if (index !== i) return candidate;
                const { allocation_scope: _scope, target_obligation_ids: _targets, allocation_rationale: _rationale, ...rest } = candidate;
                return rest;
              }));
            }}><option value="relative_ssp">Relative SSP across all obligations</option><option value="specific">Specific eligible obligations</option></select></Field>
            {item.allocation_scope === "specific" && <>
              <fieldset className="target-list"><legend>Target performance obligations</legend>
                {obligations.map((obligation) => <label key={obligation.id}><input type="checkbox" checked={item.target_obligation_ids?.includes(obligation.id) || false} onChange={(event) => update(i, { target_obligation_ids: event.target.checked ? [...(item.target_obligation_ids || []), obligation.id] : (item.target_obligation_ids || []).filter((id) => id !== obligation.id) })} /> {obligation.name || obligation.id}</label>)}
              </fieldset>
              <Field label="Specific-allocation rationale" hint="Record why this component relates specifically to these obligations and why the resulting allocation is consistent with the accounting conclusion."><textarea required rows={2} value={item.allocation_rationale || ""} onChange={(event) => update(i, { allocation_rationale: event.target.value })} /></Field>
            </>}
          </>}
        </div>
      ))}
    </Section>
  );
}
function recognitionTimingPreview(item: Obligation): string | null {
  if (!["exact_days", "monthly", "prorated_monthly"].includes(item.method) || !item.start_date || !item.end_date || item.end_date < item.start_date) return null;
  const first = new Date(`${item.start_date}T00:00:00Z`);
  const last = new Date(`${item.end_date}T00:00:00Z`);
  const monthCount = (last.getUTCFullYear() - first.getUTCFullYear()) * 12 + last.getUTCMonth() - first.getUTCMonth() + 1;
  if (!Number.isFinite(monthCount) || monthCount < 1 || monthCount > 1200) return null;
  const monthStart = (day: Date) => new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), 1));
  const monthEnd = (day: Date) => new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth() + 1, 0));
  const days = (a: Date, b: Date) => Math.round((b.getTime() - a.getTime()) / 86400000) + 1;
  const totalDays = days(first, last);
  const firstDays = days(first, last < monthEnd(first) ? last : monthEnd(first));
  const lastDays = days(first > monthStart(last) ? first : monthStart(last), last);
  const firstWeight = firstDays / monthEnd(first).getUTCDate();
  const lastWeight = lastDays / monthEnd(last).getUTCDate();
  const denominator = item.method === "monthly" ? monthCount : item.method === "exact_days" ? totalDays : monthCount === 1 ? firstWeight : firstWeight + monthCount - 2 + lastWeight;
  const share = (servedDays: number, calendarDays: number) => {
    const weight = item.method === "monthly" ? 1 : item.method === "exact_days" ? servedDays : servedDays / calendarDays;
    return `${((100 * weight) / denominator).toFixed(1)}%`;
  };
  const portions = monthCount === 1 ? [`only month ${share(totalDays, monthEnd(first).getUTCDate())}`] : [`first month ${share(firstDays, monthEnd(first).getUTCDate())}`];
  if (monthCount > 2) {
    const middle = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 1));
    portions.push(`next full month ${share(days(middle, monthEnd(middle)), monthEnd(middle).getUTCDate())}`);
  }
  if (monthCount > 1) portions.push(`last month ${share(lastDays, monthEnd(last).getUTCDate())}`);
  const convention = item.method === "monthly" ? "Every touched month has equal weight, including partial months." : item.method === "prorated_monthly" ? "Partial months count by serviced days divided by that month's calendar days; all weights are normalized." : "Every service day has equal weight.";
  return `Illustrative share of this obligation's allocation: ${portions.join(" · ")}. ${convention}`;
}
function ObligationEditor({
  items,
  onChange,
  start,
  end,
  allowEmpty = false,
}: {
  items: Obligation[];
  onChange: (items: Obligation[]) => void;
  start: string;
  end: string;
  allowEmpty?: boolean;
}) {
  const update = (i: number, patch: Partial<Obligation>) =>
    onChange(
      items.map((item, index) => (index === i ? { ...item, ...patch } : item)),
    );
  return (
    <Section
      title="Performance obligations"
      subtitle="Allocate consideration by relative standalone selling price."
      action={
        <Button
          type="button"
          onClick={() =>
            onChange([
              ...items,
              {
                id: uid(),
                name: "",
                kind: "service",
                ssp: "",
                method: "exact_days",
                start_date: start,
                end_date: end,
              },
            ])
          }
        >
          <Plus size={14} />
          Add obligation
        </Button>
      }
    >
      {items.map((item, i) => (
        <div className="editor-row" key={item.id}>
          <div className="form-grid obligation-heading">
            <Field label="Obligation">
              <input
                required
                value={item.name}
                onChange={(e) => update(i, { name: e.target.value })}
                placeholder="Subscription service"
              />
            </Field>
            <Field label="Type">
              <select
                value={item.kind}
                onChange={(e) =>
                  update(i, {
                    kind: e.target.value,
                    ...(e.target.value === "material_right"
                      ? { method: "point_in_time" }
                      : {}),
                  })
                }
              >
                {kinds.map((kind) => (
                  <option key={kind} value={kind}>
                    {humanize(kind)}
                  </option>
                ))}
              </select>
            </Field>
            <button
              type="button"
              className="icon-button remove"
              aria-label={`Remove obligation ${i + 1}`}
              disabled={!allowEmpty && items.length === 1}
              onClick={() => onChange(items.filter((_, index) => i !== index))}
            >
              <Trash2 size={15} />
            </button>
          </div>
          <div className="form-grid">
            <Field label="Standalone selling price">
              <input
                type="number"
                required
                min="0"
                step="any"
                value={item.ssp}
                onChange={(e) => update(i, { ssp: e.target.value })}
              />
            </Field>
            <Field label="Recognition method">
              <select
                value={item.method}
                onChange={(e) => update(i, { method: e.target.value })}
              >
                {Object.entries(methods).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <div className="form-grid">
            <Field label="Start date">
              <input
                type="date"
                required
                value={item.start_date}
                onChange={(e) => update(i, { start_date: e.target.value })}
              />
            </Field>
            <Field label="End date">
              <input
                type="date"
                required
                min={item.start_date}
                value={item.end_date}
                onChange={(e) => update(i, { end_date: e.target.value })}
              />
            </Field>
            {item.method === "usage" && (
              <Field label="Total contracted units">
                <input
                  type="number"
                  min="0.000001"
                  step="any"
                  required
                  value={item.total_units || ""}
                  onChange={(e) => update(i, { total_units: e.target.value })}
                />
              </Field>
            )}
          </div>
          {recognitionTimingPreview(item) && <p className="fine-print">{recognitionTimingPreview(item)}</p>}
          {item.kind === "material_right" && (
            <><p className="fine-print">This workflow recognizes the right when the promised goods or services are delivered, or when the right expires. Exercise followed by later delivery needs separate accounting treatment and is not represented here.</p><div className="form-grid">
              <Field label="Exercise window begins">
                <input
                  type="date"
                  value={item.exercise_start || ""}
                  onChange={(e) =>
                    update(i, { exercise_start: e.target.value })
                  }
                />
              </Field>
              <Field label="Exercise window ends">
                <input
                  type="date"
                  value={item.exercise_end || item.end_date}
                  onChange={(e) => update(i, { exercise_end: e.target.value })}
                />
              </Field>
            </div></>
          )}
          <Field label="Accounting rationale">
            <input
              value={item.rationale || ""}
              onChange={(e) => update(i, { rationale: e.target.value })}
              placeholder="Optional conclusion or supporting reference"
            />
          </Field>
        </div>
      ))}
    </Section>
  );
}
export function ContractForm(
  props: FormProps & { contract?: Contract; customerId?: string },
) {
  const { contract } = props;
  const initialTerms = contract
    ? contractTerms(contract, `${props.period}-01`)
    : undefined;
  const annualStart = `${props.period}-01`;
  const annualEnd = new Date(Date.UTC(Number(props.period.slice(0, 4)) + 1, Number(props.period.slice(5)) - 1, 0)).toISOString().slice(0, 10);
  const [name, setName] = useState(contract?.name || ""),
    [customer, setCustomer] = useState(
      contract?.customer_id ||
        props.customerId ||
        "",
    ),
    [start, setStart] = useState(contract?.start_date || ""),
    [end, setEnd] = useState(contract?.end_date || ""),
    [cutover, setCutover] = useState(contract?.cutover_date || ""),
    [template, setTemplate] = useState(contract ? "existing" : ""),
    [rationale, setRationale] = useState(""),
    [effective, setEffective] = useState(`${props.period}-01`),
    [treatment, setTreatment] = useState(""),
    [loadedEffective, setLoadedEffective] = useState(`${props.period}-01`),
    [termsDirty, setTermsDirty] = useState(false);
  const [components, setComponents] = useState<Component[]>(
    initialTerms?.consideration || [
      { id: uid(), label: "", kind: "fixed", amount: "" },
    ],
  );
  const [obligations, setObligations] = useState<Obligation[]>(
    initialTerms?.obligations || [
      {
        id: uid(),
        name: "",
        kind: "service",
        ssp: "",
        method: "exact_days",
        start_date: start,
        end_date: end,
      },
    ],
  );
  const unsupportedProspectiveTargeting = Boolean(contract && treatment === "prospective" && components.some((item) => item.allocation_scope === "specific"));
  const command = (): Command =>
    contract
      ? {
          command: "modify_contract",
          payload: {
            contract_id: contract.id,
            effective_date: effective,
            treatment,
            consideration: components,
            obligations,
            rationale,
          },
        }
      : {
          command: "create_contract",
          payload: {
            name,
            customer_id: customer,
            start_date: start,
            end_date: end,
            ...(cutover ? { cutover_date: cutover } : {}),
            consideration: components,
            obligations,
            rationale,
          },
        };
  return (
    <CommandDialog
      {...props}
      canSubmit={(!contract || effective === loadedEffective) && !unsupportedProspectiveTargeting}
      title={contract ? `Modify ${contract.name}` : "New contract"}
      subtitle={
        contract
          ? "Record a dated accounting change to the existing contract."
          : "Define the contract, transaction price, and performance obligations."
      }
      command={command}
      wide
      confirmLabel={contract ? "Record modification" : "Create contract"}
      successMessage={
        contract ? "Contract modification recorded." : "Contract created."
      }
    >
      {!contract ? (
        <>
          <Field label="Starting point" hint="The annual template uses an inclusive 12-month service term. Enter all actual prices and SSPs yourself.">
            <select required value={template} onChange={(event) => {
              const choice = event.target.value;
              setTemplate(choice);
              const nextStart = choice === "annual" ? annualStart : "";
              const nextEnd = choice === "annual" ? annualEnd : "";
              setStart(nextStart);
              setEnd(nextEnd);
              setComponents([{ id: uid(), label: choice === "annual" ? "Subscription" : "", kind: "fixed", amount: "" }]);
              setObligations([{ id: uid(), name: choice === "annual" ? "Subscription service" : "", kind: "service", ssp: "", method: "exact_days", start_date: nextStart, end_date: nextEnd }]);
            }}><option value="">Choose a starting point</option><option value="blank">Blank contract</option><option value="annual">Annual subscription template</option></select>
          </Field>
          <div className="form-grid">
            <Field label="Contract name">
              <input
                autoFocus
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="2026 subscription agreement"
              />
            </Field>
            <Field label="Customer">
              <select
                required
                value={customer}
                onChange={(e) => setCustomer(e.target.value)}
              >
                <option value="">Choose customer</option>
                {props.state.customers.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}{c.reference ? ` · ${c.reference}` : ""}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <div className="form-grid">
            <Field label="Contract start">
              <input
                type="date"
                required
                value={start}
                onChange={(e) => {
                  setStart(e.target.value);
                  setObligations(
                    obligations.map((o) =>
                      o.start_date === start
                        ? { ...o, start_date: e.target.value }
                        : o,
                    ),
                  );
                }}
              />
            </Field>
            <Field label="Contract end">
              <input
                type="date"
                required
                min={start}
                value={end}
                onChange={(e) => {
                  setEnd(e.target.value);
                  setObligations(
                    obligations.map((o) =>
                      o.end_date === end
                        ? { ...o, end_date: e.target.value }
                        : o,
                    ),
                  );
                }}
              />
            </Field>
          </div>
          <Field label="Existing-contract cutover date (optional)" hint="Use the first day of a later calendar month when migrating accepted legacy balances. Record an opening position on this contract before entering new activity; close is blocked until that position is accepted.">
            <input type="date" value={cutover} min={start || undefined} onChange={(event) => setCutover(event.target.value)} />
          </Field>
          <p className="fine-print">Service start and end dates are both included in recognition. For an evergreen arrangement, enter the assessed accounting term and document its basis; an unlimited term is not modeled.</p>
        </>
      ) : (
        <>
          <div className="form-grid">
            <Field label="Effective date">
              <input
                type="date"
                required
                value={effective}
                onChange={(e) => {
                  setEffective(e.target.value);
                }}
              />
            </Field>
            <Field label="Accounting treatment">
              <select
                required
                value={treatment}
                onChange={(e) => setTreatment(e.target.value)}
              >
                <option value="">Choose treatment</option>
                <option value="prospective">Prospective</option>
                <option value="catch_up">Cumulative catch-up</option>
              </select>
            </Field>
          </div>
          {effective !== loadedEffective && <div className="notice"><p>The terms below were loaded for {dateLabel(loadedEffective)}. Choose how to use them at {dateLabel(effective)} before previewing.</p><div className="button-group"><Button type="button" onClick={() => { if (termsDirty && !window.confirm("Replace the term edits in this form with the terms effective on the new date?")) return; const terms = contractTerms(contract, effective); setComponents(terms.consideration); setObligations(terms.obligations); setLoadedEffective(effective); setTermsDirty(false); }}>Load effective terms</Button><Button type="button" onClick={() => setLoadedEffective(effective)}>Keep edited terms</Button></div></div>}
          <p className="notice">
            Changing the effective date keeps your edits until you choose to load that date's terms or keep the edited terms. Enter revised lifetime consideration, including revenue
            already recognized.{" "}
            {treatment === "prospective"
              ? "Remaining consideration is recognized prospectively from the effective date."
              : "Revenue is recalculated under the revised terms and the difference is recognized on the effective date."}{" "}
            A separate-contract conclusion must be recorded as a new contract. This form does not link that contract to its amendment or represent mixed treatments; retain the connection in supporting evidence before using this path.
          </p>
          {unsupportedProspectiveTargeting && <p className="warning">Prospective changes that retain specifically allocated components require a separate reviewed allocation treatment. This form cannot calculate that combination.</p>}
        </>
      )}
      <ComponentEditor items={components} obligations={obligations} allowEmpty={Boolean(contract)} onChange={(items) => { setComponents(items); setTermsDirty(true); }} />
      <ObligationEditor
        items={obligations}
        allowEmpty={Boolean(contract)}
        onChange={(items) => {
          setObligations(items);
          const currentIds = new Set(items.map((item) => item.id));
          setComponents((current) => current.map((item) => item.target_obligation_ids
            ? { ...item, target_obligation_ids: item.target_obligation_ids.filter((id) => currentIds.has(id)) }
            : item));
          setTermsDirty(true);
        }}
        start={contract ? effective : start}
        end={end}
      />
      <Field
        label={
          contract
            ? "Reason for modification"
            : "Contract accounting conclusion"
        }
      >
        <textarea
          rows={3}
          required={!!contract}
          value={rationale}
          onChange={(e) => setRationale(e.target.value)}
          placeholder="Describe the judgment and supporting evidence."
        />
      </Field>
    </CommandDialog>
  );
}
export function ActivityForm(
  props: FormProps & { contract: Contract; activity: string; correctionTarget?: Activity },
) {
  const { contract, activity, correctionTarget } = props;
  const [effective, setEffective] = useState(correctionTarget?.effective_date || `${props.period}-01`);
  const { obligations, consideration } = contractTerms(contract, effective);
  const eligibleObligations = obligations.filter((item) => {
    if (activity === "usage") return item.method === "usage";
    if (activity === "progress") return item.method === "progress";
    if (activity === "right_exercise") return item.kind === "material_right" && !contract.activities.some((event) => event.type === "right_exercise" && event.obligation_id === item.id);
    if (activity === "milestone") {
      const exercise = contract.activities.find((event) => event.type === "right_exercise" && event.obligation_id === item.id);
      return ["milestone", "point_in_time"].includes(item.method) && (!exercise || exercise.delivery_method === "point_in_time");
    }
    return true;
  });
  const [selectedObligation, setObligation] = useState(
      correctionTarget?.obligation_id || eligibleObligations[0]?.id || "",
    ),
    [selectedComponent, setComponent] = useState(
      consideration.find((c) => ["variable", "usage"].includes(c.kind))?.id ||
        "",
    ),
    [amount, setAmount] = useState(correctionTarget?.amount || ""),
    [percentage, setPercentage] = useState(
      correctionTarget?.percentage || (activity === "milestone" ? "100" : ""),
    ),
    [quantity, setQuantity] = useState(correctionTarget?.quantity || ""),
    [reference, setReference] = useState(correctionTarget?.reference || ""),
    [deliveryMethod, setDeliveryMethod] = useState(""),
    [deliveryStart, setDeliveryStart] = useState(""),
    [deliveryEnd, setDeliveryEnd] = useState(""),
    [creditOriginal, setCreditOriginal] = useState(typeof correctionTarget?.applies_to_change_set_id === "string" ? correctionTarget.applies_to_change_set_id : typeof correctionTarget?.applies_to_reference === "string" ? "external" : ""),
    [externalInvoice, setExternalInvoice] = useState(typeof correctionTarget?.applies_to_reference === "string" ? correctionTarget.applies_to_reference : ""),
    [rationale, setRationale] = useState("");
  const positiveBillings = contract.activities.filter((item) => item.type === "billing" && Number(item.amount || 0) > 0 && item.effective_date <= effective);
  const obligation = eligibleObligations.some((o) => o.id === selectedObligation)
    ? selectedObligation
    : eligibleObligations[0]?.id || "";
  const selectedTerms = eligibleObligations.find((item) => item.id === obligation);
  const selectedRightExercise = contract.activities.find((item) => item.type === "right_exercise" && item.obligation_id === obligation && item.effective_date <= effective);
  const priorActivities = contract.activities.filter((item) => item.obligation_id === obligation && item.effective_date <= effective && item.id !== correctionTarget?.id);
  const opening = contract.activities.find((item) => item.type === "opening_position" && item.effective_date <= effective);
  const openingMeasure = (opening?.opening_obligations as { obligation_id: string; measure?: string }[] | undefined)?.find((row) => row.obligation_id === obligation)?.measure || "0";
  const priorPercentage = [...priorActivities].filter((item) => item.type === activity).sort((a, b) => a.effective_date.localeCompare(b.effective_date) || String(a.recorded_at || "").localeCompare(String(b.recorded_at || ""))).at(-1)?.percentage || openingMeasure;
  const priorUnits = Number(openingMeasure) + priorActivities.filter((item) => item.type === "usage").reduce((sum, item) => sum + Number(item.quantity || 0), 0);
  const variableComponents = consideration.filter((c) =>
    ["variable", "usage"].includes(c.kind),
  );
  const component = variableComponents.some((c) => c.id === selectedComponent)
    ? selectedComponent
    : variableComponents[0]?.id || "";
  const names: Record<string, string> = {
    billing: "Record billing",
    progress: "Update progress",
    usage: "Record units delivered",
    milestone: "Record satisfaction milestone",
    right_exercise: "Exercise material right",
    adjustment: "Record revenue adjustment",
    reassessment: "Reassess consideration",
  };
  const descriptions: Record<string, string> = {
    billing:
      "Billing changes the simplified revenue-less-billing contract balance. Revenue follows satisfaction. This entry does not classify unconditional receivables or cash receipts.",
    progress: "Enter cumulative completion, from 0 to 100 percent.",
    usage:
      "Record incremental units delivered against the total contracted units.",
    milestone:
      "Record cumulative satisfaction. Use 100% for a completed point-in-time obligation.",
    right_exercise:
      "Record the option exercise and the later delivery of the promised service or good. Exercise alone does not recognize the right's allocated revenue.",
    adjustment:
      "Record a signed revenue adjustment with an explicit accounting rationale.",
    reassessment:
      "Change the amount included in the transaction price and record your conclusion.",
  };
  return (
    <CommandDialog
      {...props}
      title={correctionTarget ? `Correct ${activity}` : names[activity]}
      subtitle={correctionTarget ? `${contract.name} · replaces the selected source activity while retaining its history` : contract.name}
      command={() => {
        const payload = {
          contract_id: contract.id,
          effective_date: effective,
          rationale,
          ...(activity === "billing"
            ? { amount, reference, ...(Number(amount) < 0 ? creditOriginal === "external" ? { applies_to_reference: externalInvoice } : { applies_to_change_set_id: creditOriginal } : {}) }
            : activity === "reassessment"
              ? { component_id: component, included_amount: amount }
              : activity === "right_exercise"
                ? { obligation_id: obligation, delivery_method: deliveryMethod, delivery_start: deliveryStart, delivery_end: deliveryEnd }
              : {
                  obligation_id: obligation,
                  ...(activity === "usage"
                    ? { quantity }
                    : activity === "adjustment"
                      ? { amount }
                      : { percentage }),
                  reference,
                }),
        };
        return correctionTarget
          ? { command: "correct_activity", payload: { target_change_set_id: correctionTarget.id, rationale, replacement: payload } }
          : { command: activity === "reassessment" ? "reassess_variable_consideration" : `record_${activity}`, payload };
      }}
      successMessage={correctionTarget ? `${humanize(activity)} source fact corrected.` : `${humanize(activity)} recorded.`}
    >
      <p className="notice">{correctionTarget ? "Replace the original source facts. The original entry stays in change history; this correction recalculates all affected periods." : descriptions[activity]}</p>
      {activity === "milestone" && selectedTerms?.kind === "material_right" && <p className="fine-print">{selectedRightExercise ? `This exercised right requires a 100% delivery milestone on ${dateLabel(String(selectedRightExercise.delivery_start))}.` : "A milestone for an unexercised right represents delivery within its exercise window, not an election with later delivery."}</p>}
      <div className="form-grid">
        <Field label="Effective date">
          <input
            type="date"
            required
            value={effective}
            onChange={(e) => setEffective(e.target.value)}
          />
        </Field>
        {activity !== "billing" && activity !== "reassessment" && (
          <Field label="Performance obligation" hint={!eligibleObligations.length ? "No obligation uses a compatible satisfaction method at this date." : undefined}>
            <select
              required
              value={obligation}
              disabled={Boolean(correctionTarget)}
              onChange={(e) => setObligation(e.target.value)}
            >
              {!eligibleObligations.length && <option value="">No compatible obligation</option>}
              {eligibleObligations.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name} · {methods[o.method]}
                </option>
              ))}
            </select>
          </Field>
        )}
        {activity === "reassessment" && (
          <Field label="Consideration component">
            <select
              required
              value={component}
              onChange={(e) => setComponent(e.target.value)}
            >
              <option value="">Choose component</option>
              {consideration
                .filter((c) => ["variable", "usage"].includes(c.kind))
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
            </select>
          </Field>
        )}
      </div>
      {activity === "right_exercise" && <><Field label="Delivery recognition method" hint="Select how the goods or services acquired through this right are delivered."><select required value={deliveryMethod} onChange={(event) => { setDeliveryMethod(event.target.value); if (event.target.value === "point_in_time") setDeliveryEnd(deliveryStart); }}><option value="">Choose method</option><option value="exact_days">Over time · exact days</option><option value="monthly">Equal amount per touched month</option><option value="prorated_monthly">Prorated calendar months</option><option value="point_in_time">Point in time · record a 100% delivery milestone</option></select></Field><div className="form-grid"><Field label={deliveryMethod === "point_in_time" ? "Delivery date" : "Delivery begins"}><input required type="date" min={effective} value={deliveryStart} onChange={(event) => { setDeliveryStart(event.target.value); if (deliveryMethod === "point_in_time") setDeliveryEnd(event.target.value); }} /></Field>{deliveryMethod !== "point_in_time" && <Field label="Delivery ends"><input required type="date" min={deliveryStart || effective} value={deliveryEnd} onChange={(event) => setDeliveryEnd(event.target.value)} /></Field>}</div><p className="fine-print">The right's existing allocation stays with this obligation. Time-based methods schedule it over the delivery term. For point-in-time delivery, record the satisfaction milestone on the delivery date.</p></>}
      <div className="form-grid">
        {["billing", "adjustment", "reassessment"].includes(activity) && (
          <Field
            label={
              activity === "reassessment" ? "Revised included amount" : "Amount"
            }
          >
            <input
              type="number"
              step="0.01"
              required
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.00"
            />
          </Field>
        )}
        {["progress", "milestone"].includes(activity) && (
          <Field label="Cumulative completion (%)">
            {selectedTerms?.method === "point_in_time" ? <select required value={percentage} onChange={(e) => setPercentage(e.target.value)}><option value="">Choose status</option><option value="0">Not yet satisfied</option><option value="100">Satisfied and delivered</option></select> : <input
              type="number"
              min="0"
              max="100"
              step="any"
              required
              value={percentage}
              onChange={(e) => setPercentage(e.target.value)}
            />}
          </Field>
        )}
        {activity === "usage" && (
          <Field label="Units delivered">
            <input
              type="number"
              min="0.000001"
              step="any"
              required
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
            />
          </Field>
        )}
        {activity !== "reassessment" && activity !== "right_exercise" && (
          <Field
            label={
              activity === "billing"
                ? "Invoice reference"
                : "Supporting reference"
            }
          >
            <input
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              placeholder={
                activity === "billing" ? "INV-2026-001" : "Optional reference"
              }
            />
          </Field>
        )}
      </div>
      {activity === "billing" && Number(amount) < 0 && <><Field label="Original invoice for this credit" hint="A credit memo reduces the billed balance. A contractual price reduction is a separate consideration change."><select required value={creditOriginal} onChange={(event) => setCreditOriginal(event.target.value)}><option value="">Choose original invoice</option>{positiveBillings.map((item) => <option value={item.id} key={item.id}>{item.reference || item.id} · {item.effective_date} · {money(item.amount, props.state.workspace.currency)}</option>)}<option value="external">Original invoice is outside this workspace</option></select></Field>{creditOriginal === "external" && <Field label="External original invoice reference"><input required value={externalInvoice} onChange={(event) => setExternalInvoice(event.target.value)} placeholder="Original invoice ID" /></Field>}</>}
      {["progress", "milestone"].includes(activity) && obligation && <p className="fine-print">Previously recorded cumulative completion: {priorPercentage}%. Proposed change: {percentage ? Number(percentage) - Number(priorPercentage) : "—"} percentage points. Resulting completion: {percentage || "—"}%.</p>}
      {activity === "usage" && obligation && <p className="fine-print">Previously recorded units: {priorUnits}. This entry adds {quantity || "—"} units; resulting cumulative units: {quantity ? priorUnits + Number(quantity) : "—"}{selectedTerms?.total_units ? " of " + selectedTerms.total_units + " contracted" : ""}.</p>}
      <Field label="Rationale">
        <textarea
          rows={3}
          required={Boolean(correctionTarget) || ["adjustment", "reassessment", "right_exercise"].includes(activity) || (activity === "billing" && Number(amount) < 0)}
          value={rationale}
          onChange={(e) => setRationale(e.target.value)}
          placeholder="Explain the activity and supporting evidence."
        />
      </Field>
    </CommandDialog>
  );
}
export function OpeningPositionForm(props: FormProps & { contract: Contract }) {
  const { contract } = props;
  const [effective, setEffective] = useState(contract.cutover_date || `${props.period}-01`);
  const [billed, setBilled] = useState("");
  const [asset, setAsset] = useState("");
  const [deferred, setDeferred] = useState("");
  const [sourceName, setSourceName] = useState("");
  const [rationale, setRationale] = useState("");
  const [rows, setRows] = useState<Record<string, { recognized: string; measure: string }>>(
    Object.fromEntries(contract.obligations.map((item) => [item.id, { recognized: "", measure: "" }])),
  );
  const validCents = (value: string) => /^\d+(?:\.\d{1,2})?$/.test(value);
  const recognizedAmounts = contract.obligations.map((item) => rows[item.id]?.recognized || "");
  const recognizedTotal = recognizedAmounts.every(validCents) ? total(recognizedAmounts) : null;
  const derivedNet = recognizedTotal !== null && validCents(billed) ? total([recognizedTotal, `-${billed}`]) : null;
  const enteredNet = validCents(asset) && validCents(deferred) ? total([asset, `-${deferred}`]) : null;
  const setRow = (id: string, field: "recognized" | "measure", value: string) =>
    setRows((current) => ({ ...current, [id]: { ...current[id], [field]: value } }));
  return <CommandDialog
    {...props}
    title="Record opening position"
    subtitle={`${contract.name} · accepted legacy position before ${effective || "cutover"}`}
    wide
    command={() => ({ command: "record_opening_position", payload: {
      contract_id: contract.id, effective_date: effective, billed_to_date: billed,
      contract_asset: asset, deferred_revenue: deferred, source_name: sourceName, rationale,
      opening_obligations: contract.obligations.map((item) => ({
        obligation_id: item.id, recognized_to_date: rows[item.id]?.recognized || "",
        ...(["progress", "milestone", "point_in_time", "usage"].includes(item.method) ? { measure: rows[item.id]?.measure || "" } : {}),
      })),
    } })}
    confirmLabel="Record opening position"
    successMessage="Opening position recorded and reconciled."
  >
    <p className="notice">Use the current accounting terms for this contract. Enter cumulative amounts accepted at the end of the prior month. OpenRevRec will calculate forward from this cutover; it will not reconstruct or report the earlier months.</p>
    <div className="form-grid">
      <Field label="Cutover month (first day)"><input type="date" required value={effective} onChange={(event) => setEffective(event.target.value)} /></Field>
      <Field label="Legacy source name"><input required value={sourceName} onChange={(event) => setSourceName(event.target.value)} placeholder="Approved workbook or schedule" /></Field>
    </div>
    <Section title="Recognized revenue by obligation" subtitle="These are cumulative legacy balances through the day before cutover, not new revenue for this month.">
      {contract.obligations.map((item) => <div className="form-grid" key={item.id}>
        <Field label={`${item.name} · recognized to date`}><input type="number" min="0" step="0.01" required value={rows[item.id]?.recognized || ""} onChange={(event) => setRow(item.id, "recognized", event.target.value)} /></Field>
        {["progress", "milestone", "point_in_time", "usage"].includes(item.method) && <Field label={item.method === "usage" ? `${item.name} · cumulative units delivered` : `${item.name} · cumulative completion (%)`}><input type="number" min="0" max={item.method === "usage" ? item.total_units : "100"} step={item.method === "point_in_time" ? "100" : "any"} required value={rows[item.id]?.measure || ""} onChange={(event) => setRow(item.id, "measure", event.target.value)} /></Field>}
      </div>)}
    </Section>
    <div className="form-grid">
      <Field label="Legacy billed to date"><input type="number" min="0" step="0.01" required value={billed} onChange={(event) => setBilled(event.target.value)} /></Field>
      <Field label="Legacy contract asset"><input type="number" min="0" step="0.01" required value={asset} onChange={(event) => setAsset(event.target.value)} /></Field>
      <Field label="Legacy deferred revenue"><input type="number" min="0" step="0.01" required value={deferred} onChange={(event) => setDeferred(event.target.value)} /></Field>
    </div>
    <p className="fine-print">{derivedNet !== null && enteredNet !== null ? <>Recognized less billed: {money(derivedNet, props.state.workspace.currency)}. Entered asset less deferred: {money(enteredNet, props.state.workspace.currency)}. {derivedNet === enteredNet ? "Amounts agree." : "Amounts do not agree."}</> : "Enter cent-precision amounts to preview the reconciliation."} Only one balance side may be positive.</p>
    <Field label="Reconciliation rationale"><textarea rows={3} required value={rationale} onChange={(event) => setRationale(event.target.value)} placeholder="Identify the accepted legacy close and explain the tie-out." /></Field>
  </CommandDialog>;
}
export function ScenarioForm(props: FormProps) {
  const [name, setName] = useState("");
  return (
    <CommandDialog
      {...props}
      title="New scenario"
      previewRequired={false}
      subtitle="Explore accounting changes in an isolated copy of Main."
      command={() => ({ command: "create_scenario", payload: { name } })}
      confirmLabel="Create scenario"
      successMessage="Scenario created. Select it to explore changes."
    >
      <Field label="Scenario name">
        <input
          autoFocus
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Revised renewal terms"
        />
      </Field>
      <p className="notice">
        The scenario starts from the current Main version. Record changes,
        compare the financial impact, then apply it when ready.
      </p>
    </CommandDialog>
  );
}
export function LifecycleForm(
  props: FormProps & { action: string; scenarioId: string },
) {
  const scenario = props.state.scenarios.find((s) => s.id === props.scenarioId);
  const [rationale, setRationale] = useState("");
  const actionName = humanize(props.action);
  return (
    <CommandDialog
      {...props}
      title={`${actionName} scenario`}
      subtitle={scenario?.name}
      command={() => ({
        command: `${props.action}_scenario`,
        payload: { scenario_id: props.scenarioId, rationale },
      })}
      confirmLabel={`${actionName} scenario`}
      successMessage={`Scenario ${props.action === "apply" ? "applied to Main" : `${props.action}d`}.`}
    >
      <p className="notice">
        {props.action === "apply"
          ? "Review the financial impact before accepting these changes into Main. Closed periods remain protected."
          : props.action === "rebase"
            ? "Bring in the latest accepted Main changes while retaining this scenario’s proposed changes. Conflicts must be resolved before applying."
            : props.action === "archive"
              ? "Keep this scenario and its history, and remove it from the active list."
              : "Return this archived scenario to the active list."}
      </p>
      <Field label="Review note">
        <textarea
          value={rationale}
          onChange={(e) => setRationale(e.target.value)}
          rows={3}
        />
      </Field>
    </CommandDialog>
  );
}
export function CloseForm(props: FormProps & { reopen?: boolean }) {
  const [rationale, setRationale] = useState("");
  const [review, setReview] = useState<Review | null>(null);
  const [reviewError, setReviewError] = useState("");
  const [acceptance, setAcceptance] = useState<Record<string, string>>({});
  const { state, period, reopen } = props;
  useEffect(() => {
    if (reopen) return;
    let canceled = false;
    api<Review>(`/api/reports?scenario_id=main&period=${period}`)
      .then((result) => { if (!canceled) { setReview(result); setReviewError(""); } })
      .catch((caught) => { if (!canceled) setReviewError((caught as Error).message); });
    return () => { canceled = true; };
  }, [period, reopen, state.frontier]);
  return (
    <CommandDialog
      {...props}
      title={reopen ? `Reopen ${period}` : `Close ${period}`}
      subtitle={
        reopen
          ? "Preserve the prior checkpoint and explicitly reopen accounting."
          : "Review the period and create an immutable accounting checkpoint."
      }
      wide
      canSubmit={Boolean(reopen) || Boolean(review && review.status !== "blocked" && !reviewError)}
      command={() => ({
        command: reopen ? "reopen_period" : "close_period",
        payload: { period, rationale, ...(!reopen ? { review_dispositions: Object.fromEntries((review?.checks || []).filter((check) => check.status === "review").map((check) => [check.id, { disposition: "accepted", reason: acceptance[check.id] || "" }])) } : {}) },
      })}
      confirmLabel={reopen ? "Reopen period" : "Close period"}
      successMessage={`${period} ${reopen ? "reopened" : "closed"}.`}
    >
      <div className="review-facts">
        <div>
          <span>Revenue</span>
          <strong>
            {money(state.report.summary.revenue, state.workspace.currency)}
          </strong>
        </div>
        <div>
          <span>Billings</span>
          <strong>
            {money(state.report.summary.billings, state.workspace.currency)}
          </strong>
        </div>
        <div>
          <span>Journal lines</span>
          <strong>{state.report.journals.length}</strong>
        </div>
        <div><span>Readiness</span><strong>{review?.status || "Loading"}</strong></div>
      </div>
      {!reopen && <Section title="Close readiness" subtitle="The same built-in checks shown in Reports.">
        <ErrorMessage error={reviewError} />
        {!review && !reviewError && <p className="muted">Loading current close checks…</p>}
        {review?.checks.map((check) => <div className="check-row close-check-row" key={check.id}>
          <div><strong>{check.label}</strong><p>{check.detail}</p>{check.status === "review" && <Field label={`Acceptance reason for ${check.label}`} hint="Explain why this open item can remain at close. The reason is retained in the close record."><textarea required rows={2} value={acceptance[check.id] || ""} onChange={(event) => setAcceptance({ ...acceptance, [check.id]: event.target.value })} /></Field>}</div><span>{check.status}</span>
        </div>)}
        {review?.status === "blocked" && <p className="warning">Resolve blocking checks before closing this period.</p>}
      </Section>}
      {state.report.warnings.length > 0 && (
        <div className="warning">
          {state.report.warnings.map((w, i) => (
            <p key={i}>{w}</p>
          ))}
        </div>
      )}
      <Section title="Derived journal">
        <JournalsTable
          rows={state.report.journals}
          currency={state.workspace.currency}
          contractName={(id) =>
            state.contracts.find((c) => c.id === id)?.name || id
          }
        />
      </Section>
      <Field label={reopen ? "Reason for reopening" : "Close review note"}>
        <textarea
          required
          rows={3}
          value={rationale}
          onChange={(e) => setRationale(e.target.value)}
          placeholder={
            reopen
              ? "Explain why this accepted period needs to reopen."
              : "Document your reconciliation and acceptance."
          }
        />
      </Field>
      {!reopen && (
        <p className="fine-print">
          Closing creates a backup and preserves recognized revenue, balances,
          and the finalized journal.
        </p>
      )}
    </CommandDialog>
  );
}
export function NoteForm(props: FormProps & { entityId?: string }) {
  const [kind, setKind] = useState("note"),
    [body, setBody] = useState(""),
    [due, setDue] = useState(""),
    [closePeriod, setClosePeriod] = useState("");
  return (
    <CommandDialog
      {...props}
      title="Add working context"
      previewRequired={false}
      command={() => ({
        command: "add_note",
        payload: {
          entity_id: props.entityId,
          kind,
          body,
          ...(due ? { due_date: due } : {}),
          ...(kind === "task" && closePeriod ? { period: closePeriod } : {}),
        },
      })}
      confirmLabel="Save note"
      successMessage="Working context saved."
    >
      <Field label="Type">
        <select value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="note">Note</option>
          <option value="memo">Accounting memo</option>
          <option value="task">Task</option>
        </select>
      </Field>
      <Field label={kind === "task" ? "Task" : "Content"}>
        <textarea
          required
          autoFocus
          rows={5}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Write the context you want to keep with this record."
        />
      </Field>
      {kind === "task" && (
        <><Field label="Due date">
          <input
            type="date"
            value={due}
            onChange={(e) => setDue(e.target.value)}
          />
        </Field><Field label="Close period" hint="An unfinished task assigned to a period appears in its close checks even without a due date."><input type="month" value={closePeriod} onChange={(event) => setClosePeriod(event.target.value)} /></Field></>
      )}
    </CommandDialog>
  );
}
export function PolicyForm(props: FormProps) {
  const [name, setName] = useState(props.state.workspace.name),
    [accounts, setAccounts] = useState(props.state.policy.accounts),
    [overrides, setOverrides] = useState(props.state.policy.account_overrides || { contracts: {}, obligations: {} }),
    [profiles, setProfiles] = useState<Record<string, AccountProfile>>(props.state.policy.account_profiles || {}),
    [assignments, setAssignments] = useState<Record<string, string>>(props.state.policy.profile_assignments || {}),
    [effectivePeriod, setEffectivePeriod] = useState(props.period),
    [rationale, setRationale] = useState(""),
    [transition, setTransition] = useState(""),
    [scope, setScope] = useState("contract"),
    [contractId, setContractId] = useState(""),
    [role, setRole] = useState("revenue"),
    [obligationId, setObligationId] = useState(""),
    [accountCode, setAccountCode] = useState(""),
    [editingProfileId, setEditingProfileId] = useState(""),
    [profileName, setProfileName] = useState(""),
    [profileAccounts, setProfileAccounts] = useState<Record<string, string>>({}),
    [dimensionRows, setDimensionRows] = useState<{ id: string; key: string; value: string }[]>([]),
    [assignmentContractId, setAssignmentContractId] = useState(""),
    [assignmentProfileId, setAssignmentProfileId] = useState("");
  const selectedContract = props.state.contracts.find((contract) => contract.id === contractId);
  const obligations = selectedContract ? Array.from(new Map([...selectedContract.obligations, ...selectedContract.activities.flatMap((activity) => (activity.obligations as typeof selectedContract.obligations | undefined) || [])].map((obligation) => [obligation.id, obligation])).values()) : [];
  const addMapping = () => {
    const code = accountCode.trim();
    if (!contractId || !code || (scope === "obligation" && !obligationId)) return;
    if (scope === "contract") {
      setOverrides({ ...overrides, contracts: { ...overrides.contracts, [contractId]: { ...(overrides.contracts[contractId] || {}), [role]: code } } });
    } else {
      setOverrides({ ...overrides, obligations: { ...overrides.obligations, [contractId]: { ...(overrides.obligations[contractId] || {}), [obligationId]: code } } });
    }
    setAccountCode("");
  };
  const selectProfile = (id: string) => {
    setEditingProfileId(id);
    setProfileName(profiles[id]?.name || "");
    setProfileAccounts(profiles[id]?.accounts || {});
    setDimensionRows(Object.entries(profiles[id]?.dimensions || {}).map(([key, value]) => ({ id: uid(), key, value })));
  };
  const saveProfile = () => {
    const id = editingProfileId || uid();
    const dimensions = Object.fromEntries(dimensionRows.map((row) => [row.key.trim(), row.value.trim()]));
    setProfiles({ ...profiles, [id]: { name: profileName.trim(), accounts: Object.fromEntries(Object.entries(profileAccounts).filter(([, value]) => value.trim()).map(([role, value]) => [role, value.trim()])), dimensions } });
    selectProfile("");
  };
  const validProfile = profileName.trim() && dimensionRows.every((row) => row.key.trim() && row.value.trim()) && new Set(dimensionRows.map((row) => row.key.trim())).size === dimensionRows.length;
  const chooseEffectivePeriod = (month: string) => {
    setEffectivePeriod(month);
    const policy = [...props.state.policy_versions]
      .filter((item) => item.effective_period <= month)
      .sort((a, b) => a.effective_period.localeCompare(b.effective_period) || a.version - b.version)
      .at(-1);
    if (policy) {
      setAccounts(policy.accounts);
      setOverrides(policy.account_overrides || { contracts: {}, obligations: {} });
      setProfiles(policy.account_profiles || {});
      setAssignments(policy.profile_assignments || {});
      selectProfile("");
    }
  };
  return (
    <CommandDialog
      {...props}
      period={effectivePeriod}
      title="Company & accounting policy"
      subtitle="Four journal roles can route through reusable profiles, contract mappings, and obligation revenue mappings."
      command={() => ({
        command: "set_policy",
        payload: { name, accounts, account_overrides: overrides, account_profiles: profiles, profile_assignments: assignments, account_transition: transition || undefined, effective_period: effectivePeriod, rationale },
      })}
      confirmLabel="Save policy"
      successMessage="Company policy updated."
    >
      <Field label="Company name">
        <input
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </Field>
      <Field label="Effective period">
        <input
          required
          type="month"
          value={effectivePeriod}
          onChange={(e) => chooseEffectivePeriod(e.target.value)}
        />
      </Field>
      {Object.entries(accounts).map(([role, account]) => (
        <Field key={role} label={humanize(role)}>
          <input
            required
            value={account}
            onChange={(e) =>
              setAccounts({ ...accounts, [role]: e.target.value })
            }
          />
        </Field>
      ))}
      <Section title="Reusable accounting profiles" subtitle="A profile supplies optional GL accounts and journal dimensions for every assigned contract. Direct contract and obligation mappings take precedence over its accounts. Ordinary contract movements share one dimension set; cross-dimension balance transfers may need ERP segment balancing.">
        {Object.entries(profiles).map(([id, profile]) => <div className="upload-row" key={id}><span><strong>{profile.name}</strong> · {Object.entries(profile.accounts).map(([role, code]) => `${humanize(role)} ${code}`).join(", ") || "Default accounts"}{Object.keys(profile.dimensions).length ? ` · ${Object.entries(profile.dimensions).map(([key, value]) => `${key}: ${value}`).join(", ")}` : ""}</span><Button type="button" onClick={() => selectProfile(id)}>Edit</Button><Button type="button" onClick={() => { const next = { ...profiles }; delete next[id]; setProfiles(next); setAssignments(Object.fromEntries(Object.entries(assignments).filter(([, profileId]) => profileId !== id))); if (editingProfileId === id) selectProfile(""); }}>Remove</Button></div>)}
        <Field label="Profile"><select value={editingProfileId} onChange={(event) => selectProfile(event.target.value)}><option value="">New profile</option>{Object.entries(profiles).map(([id, profile]) => <option key={id} value={id}>{profile.name}</option>)}</select></Field>
        <Field label="Profile name"><input value={profileName} onChange={(event) => setProfileName(event.target.value)} placeholder="e.g. Managed services" /></Field>
        <div className="form-grid">{Object.keys(accounts).map((role) => <Field key={role} label={`${humanize(role)} account`} hint="Leave blank to use the workspace default."><input value={profileAccounts[role] || ""} onChange={(event) => setProfileAccounts({ ...profileAccounts, [role]: event.target.value })} /></Field>)}</div>
        <h4>Journal dimensions</h4>
        {dimensionRows.map((row, index) => <div className="form-grid" key={row.id}><Field label="Dimension name"><input value={row.key} onChange={(event) => setDimensionRows(dimensionRows.map((item, i) => i === index ? { ...item, key: event.target.value } : item))} placeholder="Department" /></Field><Field label="Value"><input value={row.value} onChange={(event) => setDimensionRows(dimensionRows.map((item, i) => i === index ? { ...item, value: event.target.value } : item))} placeholder="Recurring" /></Field><Button type="button" onClick={() => setDimensionRows(dimensionRows.filter((item) => item.id !== row.id))}>Remove dimension</Button></div>)}
        <div className="button-group"><Button type="button" onClick={() => setDimensionRows([...dimensionRows, { id: uid(), key: "", value: "" }])}>Add dimension</Button><Button type="button" disabled={!validProfile} onClick={saveProfile}>{editingProfileId ? "Update profile" : "Add profile"}</Button></div>
        <h4>Contract assignments</h4>
        {Object.entries(assignments).map(([id, profileId]) => <div className="upload-row" key={id}><span>{props.state.contracts.find((contract) => contract.id === id)?.name || id} → {profiles[profileId]?.name || profileId}</span><Button type="button" onClick={() => { const next = { ...assignments }; delete next[id]; setAssignments(next); }}>Remove</Button></div>)}
        <div className="form-grid"><Field label="Contract"><select value={assignmentContractId} onChange={(event) => setAssignmentContractId(event.target.value)}><option value="">Choose contract</option>{props.state.contracts.map((contract) => <option key={contract.id} value={contract.id}>{contract.name}</option>)}</select></Field><Field label="Profile"><select value={assignmentProfileId} onChange={(event) => setAssignmentProfileId(event.target.value)}><option value="">Choose profile</option>{Object.entries(profiles).map(([id, profile]) => <option key={id} value={id}>{profile.name}</option>)}</select></Field></div>
        <Button type="button" disabled={!assignmentContractId || !assignmentProfileId} onClick={() => { setAssignments({ ...assignments, [assignmentContractId]: assignmentProfileId }); setAssignmentContractId(""); }}>Assign profile</Button>
      </Section>
      <Section title="Specific account mappings" subtitle="Contract mappings take precedence over profile and workspace accounts. An obligation revenue mapping takes precedence over its contract's revenue account.">
        {Object.entries(overrides.contracts).flatMap(([id, roles]) => Object.entries(roles).map(([mappedRole, code]) => (
          <div className="upload-row" key={`contract:${id}:${mappedRole}`}><span>{props.state.contracts.find((contract) => contract.id === id)?.name || id} · {humanize(mappedRole)} → {code}</span><Button type="button" onClick={() => { const next = { ...overrides.contracts, [id]: { ...roles } }; delete next[id][mappedRole]; if (!Object.keys(next[id]).length) delete next[id]; setOverrides({ ...overrides, contracts: next }); }}>Remove</Button></div>
        )))}
        {Object.entries(overrides.obligations).flatMap(([id, mapped]) => Object.entries(mapped).map(([pobId, code]) => (
          <div className="upload-row" key={`obligation:${id}:${pobId}`}><span>{props.state.contracts.find((contract) => contract.id === id)?.name || id} · {pobId} revenue → {code}</span><Button type="button" onClick={() => { const next = { ...overrides.obligations, [id]: { ...mapped } }; delete next[id][pobId]; if (!Object.keys(next[id]).length) delete next[id]; setOverrides({ ...overrides, obligations: next }); }}>Remove</Button></div>
        )))}
        <div className="form-grid">
          <Field label="Mapping level"><select value={scope} onChange={(e) => setScope(e.target.value)}><option value="contract">Contract</option><option value="obligation">Obligation revenue</option></select></Field>
          <Field label="Contract"><select value={contractId} onChange={(e) => { setContractId(e.target.value); setObligationId(""); }}><option value="">Choose contract</option>{props.state.contracts.map((contract) => <option key={contract.id} value={contract.id}>{contract.name}</option>)}</select></Field>
          {scope === "contract" ? <Field label="Journal role"><select value={role} onChange={(e) => setRole(e.target.value)}>{Object.keys(accounts).map((item) => <option key={item} value={item}>{humanize(item)}</option>)}</select></Field> : <Field label="Obligation"><select value={obligationId} onChange={(e) => setObligationId(e.target.value)}><option value="">Choose obligation</option>{obligations.map((obligation) => <option key={obligation.id} value={obligation.id}>{obligation.name}</option>)}</select></Field>}
          <Field label="GL account code"><input value={accountCode} onChange={(e) => setAccountCode(e.target.value)} placeholder="e.g. 4100" /></Field>
        </div>
        <Button type="button" disabled={!contractId || !accountCode.trim() || (scope === "obligation" && !obligationId)} onClick={addMapping}>Add mapping</Button>
      </Section>
      <Field label="Opening balance treatment" hint="Required when changing a deferred revenue or contract asset account or a profile dimension with an opening balance. Transfer adds balanced opening entries to this month's journal. External means you will post and reconcile the transfer outside OpenRevRec.">
        <select value={transition} onChange={(e) => setTransition(e.target.value)}><option value="">Choose when needed</option><option value="transfer">Transfer opening balances in journal</option><option value="external">External transfer and reconciliation</option></select>
      </Field>
      <Field label="Reason for change">
        <textarea
          required
          rows={3}
          value={rationale}
          onChange={(e) => setRationale(e.target.value)}
        />
      </Field>
    </CommandDialog>
  );
}
