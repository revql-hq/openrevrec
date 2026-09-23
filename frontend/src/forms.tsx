import { useEffect, useRef, useState, type ReactNode } from "react";
import { changeComponentKind, changeObligationKind, changeObligationMethod, contractTerms, suggestedModificationDate, termReviewStatus } from "./contractTerms";
import { activityEarliestDate, suggestedActivityDate, supportsActivityOnDate } from "./activityDates";
import { eligibleBillingOriginals } from "./billingCredits";
import { parseApprovedCombinations } from "./accountRules";
import { ArrowLeft, Plus, Trash2 } from "lucide-react";
import { api, post, uid, money, humanize, dateLabel, total, today } from "./api";
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
  RunoffPosition,
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
              {command().command === "link_modification_contract" && preview.state.report.modification_links?.filter((link) => link.contract_id === command().payload.contract_id && link.added_contract_id === command().payload.added_contract_id).map((link) => <Section key={link.change_set_id} title="Separate-contract amendment support" subtitle="The link changes the accounting record and explanation; each contract keeps its own schedule and balance.">
                <p>{link.contract_name} + {link.added_contract_name} · approved {dateLabel(link.effective_date)}</p>
                <p>Original revenue {money(link.original_revenue, state.workspace.currency)} + added revenue {money(link.added_revenue, state.workspace.currency)} = {money(link.combined_revenue, state.workspace.currency)} this month.</p>
                <p className="fine-print">Original asset {money(link.original_contract_asset, state.workspace.currency)} / deferred {money(link.original_deferred_revenue, state.workspace.currency)}; added asset {money(link.added_contract_asset, state.workspace.currency)} / deferred {money(link.added_deferred_revenue, state.workspace.currency)}.</p>
              </Section>)}
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
                  profileName={(id) => preview.state.policy.account_profiles?.[id]?.name || id}
                />
              </Section>
              {["create_contract", "record_opening_position", "correct_opening_position", "link_renewal_contract", "link_modification_contract", "modify_contract", "reassess_variable_consideration", "record_adjustment", "record_rate_change", "record_account_runoff", "set_policy", "reopen_period"].includes(command().command) && <Section title="Support this judgment" subtitle="Attach the document or analysis used for this accounting conclusion.">
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
            disabled={!customer && Boolean((entity as Contract).source_contracts?.length)}
            onChange={(e) => setReference(e.target.value)}
          />
        </Field>
        {customer && <Field label="Source system"><input value={sourceSystem} onChange={(e) => setSourceSystem(e.target.value)} /></Field>}
      </div>
      {!customer && Boolean((entity as Contract).source_contracts?.length) && <p className="fine-print">This primary source agreement belongs to a reviewed combined contract and stays fixed in its accounting history.</p>}
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
  metered: "Metered units · invoice value",
  milestone: "Milestone completion",
};
function ComponentEditor({
  items,
  obligations,
  onChange,
  allowEmpty = false,
  reviewedMixed = false,
}: {
  items: Component[];
  obligations: Obligation[];
  onChange: (items: Component[]) => void;
  allowEmpty?: boolean;
  reviewedMixed?: boolean;
}) {
  const update = (i: number, patch: Partial<Component>) =>
    onChange(
      items.map((item, index) => (index === i ? { ...item, ...patch } : item)),
    );
  const periodTargets = obligations.filter((obligation) => ["exact_days", "monthly", "prorated_monthly"].includes(obligation.method) && obligation.kind !== "material_right");
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
      <p className="fine-print">{reviewedMixed ? "Enter the revised fixed lifetime price here, then allocate it by obligation below." : "Relative SSP across all obligations is the default. An eligible variable or usage amount may target one service month within one time-based obligation when the accountant documents the allocation conclusion. Credits may target obligations, but not a service month."}</p>
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
                {["fixed", "variable", "usage", "metered", "credit"].map((kind) => (
                  <option key={kind} value={kind}>
                    {humanize(kind)}
                  </option>
                ))}
              </select>
            </Field>
            {item.kind !== "metered" && <Field
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
            </Field>}
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
              changes. Uncapped right-to-invoice service has a separate metered workflow.
            </p>
          )}
          {item.kind === "metered" && <>
            <p className="fine-print">Use only for one service obligation set to Metered units, with no minimum or other consideration. Document why the amount entitled to invoice corresponds directly to value delivered. Future units are not forecast.</p>
            <div className="form-grid">
              <Field label="Value source"><select value={item.metered_value_mode || "unit_rate"} onChange={(event) => update(i, { metered_value_mode: event.target.value as "unit_rate" | "invoice_value", unit_rate: "" })}><option value="unit_rate">Price per unit</option><option value="invoice_value">Externally priced invoice value</option></select></Field>
              {(item.metered_value_mode || "unit_rate") === "unit_rate" && <Field label="Price per unit"><input type="number" min="0" step="any" required value={item.unit_rate || ""} onChange={(event) => update(i, { unit_rate: event.target.value })} /></Field>}
              <Field label="Invoice-value conclusion" hint={item.metered_value_mode === "invoice_value" ? "Explain why the externally priced amount entitled to invoice corresponds directly to value delivered." : "Explain why the amount invoiced per unit corresponds directly to the value of service delivered to the customer."}><textarea required rows={3} value={item.rationale || ""} onChange={(event) => update(i, { rationale: event.target.value })} /></Field>
            </div>
            {item.metered_value_mode === "invoice_value" && <p className="fine-print">Record the actual priced value and a source reference with each usage entry. This mode accepts a reviewed amount from a billing or pricing source; it does not calculate tiers or overages or record an invoice automatically.</p>}
          </>}
          {["variable", "usage", "credit"].includes(item.kind) && <>
            <Field label="Allocation treatment"><select value={item.allocation_scope || "relative_ssp"} onChange={(event) => {
              if (event.target.value === "specific") update(i, { allocation_scope: "specific", target_obligation_ids: [], allocation_rationale: "" });
              else onChange(items.map((candidate, index) => {
                if (index !== i) return candidate;
                const { allocation_scope: _scope, target_obligation_ids: _targets, target_period: _period, allocation_rationale: _rationale, ...rest } = candidate;
                return rest;
              }));
            }}><option value="relative_ssp">Relative SSP across all obligations</option><option value="specific">Specific eligible obligations</option></select></Field>
            {item.allocation_scope === "specific" && <>
              {["variable", "usage"].includes(item.kind) && <Field label="Specific service month (optional)" hint="Use only when the amount relates to a distinct month within one time-based series obligation. A later estimate change catches up in its effective month."><input type="month" value={item.target_period || ""} onChange={(event) => update(i, { target_period: event.target.value, target_obligation_ids: event.target.value ? (item.target_obligation_ids || []).filter((id) => periodTargets.some((obligation) => obligation.id === id)).slice(0, 1) : item.target_obligation_ids || [] })} /></Field>}
              {item.target_period ? <Field label="Target time-based obligation"><select required value={item.target_obligation_ids?.[0] || ""} onChange={(event) => update(i, { target_obligation_ids: event.target.value ? [event.target.value] : [] })}><option value="">Choose obligation</option>{periodTargets.map((obligation) => <option key={obligation.id} value={obligation.id}>{obligation.name || obligation.id}</option>)}</select></Field> : <fieldset className="target-list"><legend>Target performance obligations</legend>
                {obligations.map((obligation) => <label key={obligation.id}><input type="checkbox" checked={item.target_obligation_ids?.includes(obligation.id) || false} onChange={(event) => update(i, { target_obligation_ids: event.target.checked ? [...(item.target_obligation_ids || []), obligation.id] : (item.target_obligation_ids || []).filter((id) => id !== obligation.id) })} /> {obligation.name || obligation.id}</label>)}
              </fieldset>}
              <Field label="Specific-allocation rationale" hint={item.target_period ? "Explain why the payment terms relate specifically to this month's distinct service and why allocating the full amount there meets the allocation objective." : "Record why this component relates specifically to these obligations and why the resulting allocation is consistent with the accounting conclusion."}><textarea required rows={2} value={item.allocation_rationale || ""} onChange={(event) => update(i, { allocation_rationale: event.target.value })} /></Field>
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
  reviewedMixed = false,
}: {
  items: Obligation[];
  onChange: (items: Obligation[]) => void;
  start: string;
  end: string;
  allowEmpty?: boolean;
  reviewedMixed?: boolean;
}) {
  const update = (i: number, patch: Partial<Obligation>) =>
    onChange(
      items.map((item, index) => (index === i ? { ...item, ...patch } : item)),
    );
  return (
    <Section
      title="Performance obligations"
      subtitle={reviewedMixed ? "Define the promises for the reviewed allocation below." : "Allocate consideration by relative standalone selling price."}
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
                  onChange(items.map((candidate, index) => index === i ? changeObligationKind(candidate, e.target.value) : candidate))
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
            {item.method !== "metered" && <Field label="Standalone selling price">
              <input
                type="number"
                required
                min="0"
                step="any"
                value={item.ssp}
                onChange={(e) => update(i, { ssp: e.target.value })}
              />
            </Field>}
            <Field label="Recognition method">
              <select
                value={item.method}
                onChange={(e) => onChange(items.map((candidate, index) => index === i ? changeObligationMethod(candidate, e.target.value) : candidate))}
              >
                {Object.entries(methods).filter(([value]) => item.kind !== "material_right" || value === "point_in_time").map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          {item.method === "metered" && <p className="fine-print">Standalone selling price is not needed when this is the contract's only service obligation.</p>}
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
            <><p className="fine-print">The right's allocation is recognized when the option expires or when the promised goods or services are delivered. Record an exercise and its future delivery on the contract after creation; link a separate renewal contract if it contains new consideration.</p><div className="form-grid">
              <Field label="Exercise window begins">
                <input
                  type="date"
                  min={item.start_date}
                  value={item.exercise_start || ""}
                  onChange={(e) =>
                    update(i, { exercise_start: e.target.value })
                  }
                />
              </Field>
              <Field label="Exercise window ends">
                <input
                  type="date"
                  min={item.exercise_start || item.start_date}
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
  const initialEffective = contract ? suggestedModificationDate(contract, props.period) : `${props.period}-01`;
  const initialTerms = contract
    ? { ...contractTerms(contract, initialEffective), termAssessment: termReviewStatus(props.state, contract, initialEffective) }
    : undefined;
  const annualStart = `${props.period}-01`;
  const annualEnd = new Date(Date.UTC(Number(props.period.slice(0, 4)) + 1, Number(props.period.slice(5)) - 1, 0)).toISOString().slice(0, 10);
  const [name, setName] = useState(contract?.name || ""),
    [sourceReference, setSourceReference] = useState(contract?.reference || ""),
    [combineSources, setCombineSources] = useState(false),
    [primaryAgreementDate, setPrimaryAgreementDate] = useState(""),
    [additionalSources, setAdditionalSources] = useState([{ id: uid(), reference: "", agreement_date: "", customer_id: "", relationship_rationale: "" }]),
    [combinationBasis, setCombinationBasis] = useState(""),
    [combinationRationale, setCombinationRationale] = useState(""),
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
    [effective, setEffective] = useState(initialEffective),
    [treatment, setTreatment] = useState(""),
    [mixedAllocations, setMixedAllocations] = useState<Record<string, { treatment: string; amount: string; revised_progress?: string }>>({}),
    [loadedEffective, setLoadedEffective] = useState(initialEffective),
    [termsDirty, setTermsDirty] = useState(false),
    [termBasis, setTermBasis] = useState<"fixed" | "cancellable" | "evergreen">(initialTerms?.termAssessment.basis || "fixed"),
    [termRationale, setTermRationale] = useState(initialTerms?.termAssessment.rationale || ""),
    [termTrigger, setTermTrigger] = useState(initialTerms?.termAssessment.trigger || ""),
    [termReviewDate, setTermReviewDate] = useState(initialTerms?.termAssessment.reviewDate || ""),
    [loadedTermAssessment, setLoadedTermAssessment] = useState(initialTerms?.termAssessment);
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
  const termAssessment = {
    term_basis: termBasis,
    term_assessment_rationale: termBasis === "fixed" ? "" : termRationale,
    term_reassessment_trigger: termBasis === "fixed" ? "" : termTrigger,
    term_review_date: termBasis === "fixed" ? "" : termReviewDate,
  };
  const termAssessmentChanged = !loadedTermAssessment || termAssessment.term_basis !== loadedTermAssessment.basis ||
    termAssessment.term_assessment_rationale !== loadedTermAssessment.rationale ||
    termAssessment.term_reassessment_trigger !== loadedTermAssessment.trigger ||
    termAssessment.term_review_date !== loadedTermAssessment.reviewDate;
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
            ...(treatment === "mixed" ? { mixed_allocation: obligations.map((item) => ({
              obligation_id: item.id,
              treatment: mixedAllocations[item.id]?.treatment || "",
              amount: mixedAllocations[item.id]?.amount || "",
              ...(mixedAllocations[item.id]?.treatment === "catch_up" && mixedAllocations[item.id]?.revised_progress
                ? { revised_progress: mixedAllocations[item.id].revised_progress }
                : {}),
            })) } : {}),
            ...(termAssessmentChanged ? termAssessment : {}),
          },
        }
      : {
          command: "create_contract",
          payload: {
            name,
            reference: sourceReference,
            customer_id: customer,
            start_date: start,
            end_date: end,
            ...(cutover ? { cutover_date: cutover } : {}),
            consideration: components,
            obligations,
            rationale,
            ...(combineSources ? {
              source_contracts: [
                { reference: sourceReference, agreement_date: primaryAgreementDate, customer_id: customer },
                ...additionalSources.map((source) => ({
                  reference: source.reference,
                  agreement_date: source.agreement_date,
                  customer_id: source.customer_id || customer,
                  ...(source.customer_id && source.customer_id !== customer
                    ? { relationship_rationale: source.relationship_rationale }
                    : {}),
                })),
              ],
              combination_basis: combinationBasis,
              combination_rationale: combinationRationale,
            } : {}),
            ...termAssessment,
          },
        };
  return (
    <CommandDialog
      {...props}
      canSubmit={!contract || effective === loadedEffective}
      title={contract ? `Modify ${contract.name}` : "New contract"}
      subtitle={
        contract
          ? `Record a dated accounting change. Enter amounts in ${props.state.workspace.currency}; this workspace does not calculate FX.`
          : `Define the contract, price, and obligations. Enter amounts in ${props.state.workspace.currency}; this workspace does not calculate FX.`
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
              setTermBasis("fixed");
              setTermRationale("");
              setTermTrigger("");
              setTermReviewDate("");
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
            <Field label={combineSources ? "Primary source agreement reference" : "Source contract reference"} hint="Use the stable ID from the contract register so close can compare its full population.">
              <input required={combineSources} value={sourceReference} onChange={(event) => setSourceReference(event.target.value)} placeholder="Agreement ID" />
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
          <label className="confirmation-row"><input type="checkbox" checked={combineSources} onChange={(event) => setCombineSources(event.target.checked)} /> Account for multiple source agreements as one contract</label>
          {combineSources && <Section title="Combined source agreements" subtitle="Record the legal agreements and the accountant's AASB 15 paragraph 17 conclusion. Their consideration and obligations belong in this one accounting contract.">
            <Field label="Primary agreement date"><input required type="date" value={primaryAgreementDate} onChange={(event) => setPrimaryAgreementDate(event.target.value)} /></Field>
            {additionalSources.map((source, index) => <div className="form-grid" key={source.id}>
              <Field label={`Additional agreement ${index + 1} reference`}><input required value={source.reference} onChange={(event) => setAdditionalSources(additionalSources.map((row) => row.id === source.id ? { ...row, reference: event.target.value } : row))} placeholder="AG-2" /></Field>
              <Field label="Agreement date"><input required type="date" value={source.agreement_date} onChange={(event) => setAdditionalSources(additionalSources.map((row) => row.id === source.id ? { ...row, agreement_date: event.target.value } : row))} /></Field>
              <Field label="Legal customer" hint="Select the legal party to this agreement. A different customer needs a documented related-party basis."><select value={source.customer_id} onChange={(event) => setAdditionalSources(additionalSources.map((row) => row.id === source.id ? { ...row, customer_id: event.target.value } : row))}><option value="">Same as primary customer</option>{props.state.customers.filter((item) => item.id !== customer).map((item) => <option key={item.id} value={item.id}>{item.name}{item.reference ? ` · ${item.reference}` : ""}</option>)}</select></Field>
              {source.customer_id && source.customer_id !== customer && <Field label="Related-party relationship" hint="Explain how this legal customer is related to the primary customer; the accountant must confirm the relationship."><textarea required rows={2} value={source.relationship_rationale} onChange={(event) => setAdditionalSources(additionalSources.map((row) => row.id === source.id ? { ...row, relationship_rationale: event.target.value } : row))} /></Field>}
              {additionalSources.length > 1 && <Button type="button" onClick={() => setAdditionalSources(additionalSources.filter((row) => row.id !== source.id))}>Remove agreement</Button>}
            </div>)}
            <Button type="button" onClick={() => setAdditionalSources([...additionalSources, { id: uid(), reference: "", agreement_date: "", customer_id: "", relationship_rationale: "" }])}>Add source agreement</Button>
            {additionalSources.some((source) => source.customer_id && source.customer_id !== customer) && <p className="notice">The combined revenue and balance will appear under the primary customer. The source agreement keeps its legal customer for review and export.</p>}
            <Field label="Combination basis"><select required value={combinationBasis} onChange={(event) => setCombinationBasis(event.target.value)}><option value="">Choose criterion</option><option value="package">Single commercial objective</option><option value="interdependent_price">Interdependent price or performance</option><option value="single_obligation">One performance obligation across agreements</option></select></Field>
            <Field label="Why these agreements form one accounting contract"><textarea required rows={3} value={combinationRationale} onChange={(event) => setCombinationRationale(event.target.value)} placeholder="Explain the timing, customer relationship, and selected criterion." /></Field>
          </Section>}
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
            <Field label={termBasis === "fixed" ? "Contract end" : "Assessed accounting end"}>
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
          <p className="fine-print">Service start and end dates are both included in recognition. For cancellable or evergreen contracts, use only the period assessed as enforceable. An unlimited term is not modeled.</p>
        </>
      ) : (
        <>
          <div className="form-grid">
            <Field label="Effective date">
              <input
                type="date"
                required
                min={contract.start_date}
                value={effective}
                onChange={(e) => {
                  setEffective(e.target.value);
                }}
              />
            </Field>
            <Field label="Accounting treatment" hint="Use prospective for distinct remaining service, catch-up for one continuing non-distinct service, or mixed when both effects are present.">
              <select
                required
                value={treatment}
                onChange={(e) => setTreatment(e.target.value)}
              >
                <option value="">Choose treatment</option>
                <option value="prospective">Prospective</option>
                <option value="catch_up">Cumulative catch-up</option>
                <option value="mixed">Mixed: catch-up and prospective</option>
              </select>
            </Field>
          </div>
          {effective !== loadedEffective && <div className="notice"><p>The terms below were loaded for {dateLabel(loadedEffective)}. Choose how to use them at {dateLabel(effective)} before previewing.</p><div className="button-group"><Button type="button" onClick={() => { if (termsDirty && !window.confirm("Replace the term edits in this form with the terms effective on the new date?")) return; const terms = contractTerms(contract, effective); const assessment = termReviewStatus(props.state, contract, effective); setComponents(terms.consideration); setObligations(terms.obligations); setTermBasis(assessment.basis); setTermRationale(assessment.rationale); setTermTrigger(assessment.trigger); setTermReviewDate(assessment.reviewDate); setLoadedTermAssessment(assessment); setLoadedEffective(effective); setTermsDirty(false); }}>Load effective terms</Button><Button type="button" onClick={() => setLoadedEffective(effective)}>Keep edited terms</Button></div></div>}
          <p className="notice">
            Enter revised lifetime consideration, including revenue already recognized.{" "}
            {treatment === "prospective"
              ? "Remaining consideration is recognized prospectively from the effective date."
              : treatment === "mixed"
                ? "Allocate it to each obligation; partially satisfied service catches up and distinct remaining service stays prospective."
                : "Revenue is recalculated under the revised terms and the difference is recognized on the effective date."}{" "}
            Use Link added service only for a qualifying separate-contract amendment with unchanged original terms.
          </p>
          {treatment === "prospective" && components.some((item) => item.allocation_scope === "specific") && <p className="fine-print">Targeted consideration stays with its named obligation or service month. A price change attributable to already satisfied service needs a catch-up treatment; preview checks that boundary.</p>}
        </>
      )}
      <Field label="Term basis" hint="Use the assessed enforceable term for recognition. Reassess it when the stated trigger occurs.">
        <select value={termBasis} onChange={(event) => { setTermBasis(event.target.value as typeof termBasis); setTermsDirty(true); }}>
          <option value="fixed">Fixed term</option>
          <option value="cancellable">Cancellable arrangement</option>
          <option value="evergreen">Evergreen arrangement</option>
        </select>
      </Field>
      {termBasis !== "fixed" && <>
        <Field label="Why this term is enforceable"><textarea required rows={2} value={termRationale} onChange={(event) => { setTermRationale(event.target.value); setTermsDirty(true); }} placeholder="Explain the assessed accounting end and the enforceable rights or obligations." /></Field>
        <Field label="Reassessment trigger"><textarea required rows={2} value={termTrigger} onChange={(event) => { setTermTrigger(event.target.value); setTermsDirty(true); }} placeholder="For example, a cancellation notice or renewal decision." /></Field>
        <Field label="Planned review date (optional)" hint="An event-based trigger may have no known date. This date is recorded for review; it does not extend the accounting term automatically."><input type="date" min={contract ? effective : start} value={termReviewDate} onChange={(event) => { setTermReviewDate(event.target.value); setTermsDirty(true); }} /></Field>
      </>}
      <ComponentEditor items={components} obligations={obligations} allowEmpty={Boolean(contract)} reviewedMixed={treatment === "mixed"} onChange={(items) => { setComponents(items); setTermsDirty(true); }} />
      <ObligationEditor
        items={obligations}
        allowEmpty={Boolean(contract)}
        reviewedMixed={treatment === "mixed"}
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
      {contract && treatment === "mixed" && <Section title="Mixed-treatment allocation" subtitle="Record the reviewed lifetime price for every obligation; these amounts must add to revised lifetime consideration.">
        <p className="fine-print">Use catch-up for an existing partially satisfied, non-distinct service; prospective for distinct remaining service; retained for an already satisfied original promise. If an amendment changes a progress-based service's completion measure, enter its revised percentage for the catch-up. This path requires fixed consideration and no earlier opening position or accounting change.</p>
        {obligations.map((item) => <div className="form-grid" key={item.id}>
          <Field label={`${item.name || "Obligation"} treatment`}><select required value={mixedAllocations[item.id]?.treatment || ""} onChange={(event) => setMixedAllocations((current) => ({ ...current, [item.id]: { treatment: event.target.value, amount: current[item.id]?.amount || "", revised_progress: event.target.value === "catch_up" ? current[item.id]?.revised_progress || "" : "" } }))}><option value="">Choose effect</option><option value="catch_up">Cumulative catch-up</option><option value="prospective">Prospective</option><option value="retained">Already satisfied; retain earned revenue</option></select></Field>
          <Field label="Revised lifetime allocation"><input required type="number" min="0" step="0.01" value={mixedAllocations[item.id]?.amount || ""} onChange={(event) => setMixedAllocations((current) => ({ ...current, [item.id]: { ...current[item.id], treatment: current[item.id]?.treatment || "", amount: event.target.value } }))} /></Field>
          {item.method === "progress" && mixedAllocations[item.id]?.treatment === "catch_up" && <Field label="Revised completion at amendment (%)" hint="Leave blank if the previous completion measure is still valid. Enter the newly reviewed cumulative percentage if the amended scope changes progress."><input type="number" min="0.000001" max="99.999999" step="any" value={mixedAllocations[item.id]?.revised_progress || ""} onChange={(event) => setMixedAllocations((current) => ({ ...current, [item.id]: { ...current[item.id], treatment: "catch_up", amount: current[item.id]?.amount || "", revised_progress: event.target.value } }))} /></Field>}
        </div>)}
      </Section>}
      <Field
        label={
          contract
            ? "Reason for modification"
            : "Contract accounting conclusion"
        }
        hint={contract && treatment === "prospective" ? "Explain why the remaining promises are distinct and how the revised consideration relates to them." : treatment === "mixed" ? "Explain each obligation's treatment and how the revised price was allocated." : undefined}
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
export function TermReviewForm(props: FormProps & { contract: Contract }) {
  const [effectiveDate, setEffectiveDate] = useState(today());
  const [reviewer, setReviewer] = useState("");
  const [conclusion, setConclusion] = useState("");
  const [supportMemo, setSupportMemo] = useState("");
  const [nextReviewDate, setNextReviewDate] = useState("");
  const assessment = termReviewStatus(props.state, props.contract, effectiveDate);
  return <CommandDialog {...props} title="Complete term review" subtitle={props.contract.name}
    previewRequired={false} confirmLabel="Record review" successMessage="Term review recorded."
    command={() => ({ command: "record_term_review", payload: {
      contract_id: props.contract.id, effective_date: effectiveDate, reviewer, conclusion,
      support_memo: supportMemo, next_review_date: nextReviewDate,
    } })}>
    <p className="fine-print">This records a conclusion that the assessed accounting term and service dates remain unchanged. If either changed, record a contract modification instead.</p>
    <Field label="Review date"><input required type="date" max={today()} min={props.contract.start_date} value={effectiveDate} onChange={(event) => setEffectiveDate(event.target.value)} /></Field>
    <Field label="Reviewer"><input required value={reviewer} onChange={(event) => setReviewer(event.target.value)} placeholder="Name of accountant or reviewer" /></Field>
    <Field label="Conclusion"><textarea required rows={2} value={conclusion} onChange={(event) => setConclusion(event.target.value)} placeholder="Why the assessed term remains unchanged" /></Field>
    <Field label="Supporting basis"><textarea required rows={2} value={supportMemo} onChange={(event) => setSupportMemo(event.target.value)} placeholder="Notice, contract clause, correspondence, or other evidence reviewed" /></Field>
    <Field label="Next planned review" hint={assessment.reviewDate ? `Current planned review: ${dateLabel(assessment.reviewDate)}. Set the next date to complete this scheduled review.` : "Optional for an event-driven reassessment without a scheduled date."}>
      <input type="date" required={Boolean(assessment.reviewDate)} min={effectiveDate} value={nextReviewDate} onChange={(event) => setNextReviewDate(event.target.value)} />
    </Field>
  </CommandDialog>;
}

export function ActivityForm(
  props: FormProps & { contract: Contract; activity: string; correctionTarget?: Activity },
) {
  const { contract, activity, correctionTarget } = props;
  const [effective, setEffective] = useState(() => suggestedActivityDate(contract, props.period, activity, correctionTarget?.effective_date));
  const { obligations, consideration } = contractTerms(contract, effective);
  const eligibleObligations = obligations.filter((item) => supportsActivityOnDate(contract, item, activity, effective));
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
    [invoiceValue, setInvoiceValue] = useState(correctionTarget?.invoice_value || ""),
    [unitRate, setUnitRate] = useState(String(correctionTarget?.unit_rate || "")),
    [reference, setReference] = useState(correctionTarget?.reference || ""),
    [sourceContractReference, setSourceContractReference] = useState(correctionTarget?.source_contract_reference || ""),
    [deliveryMethod, setDeliveryMethod] = useState(""),
    [deliveryStart, setDeliveryStart] = useState(""),
    [deliveryEnd, setDeliveryEnd] = useState(""),
    [creditOriginal, setCreditOriginal] = useState(typeof correctionTarget?.applies_to_change_set_id === "string" ? correctionTarget.applies_to_change_set_id : typeof correctionTarget?.applies_to_reference === "string" ? "external" : ""),
    [externalInvoice, setExternalInvoice] = useState(typeof correctionTarget?.applies_to_reference === "string" ? correctionTarget.applies_to_reference : ""),
    [rationale, setRationale] = useState("");
  const positiveBillings = eligibleBillingOriginals(contract, effective, sourceContractReference);
  const creditOriginalChoice = creditOriginal === "external" || positiveBillings.some((item) => item.id === creditOriginal) ? creditOriginal : "";
  const creditReady = activity !== "billing" || !(Number(amount) < 0) ||
    (creditOriginalChoice === "external" ? Boolean(externalInvoice.trim()) : Boolean(creditOriginalChoice));
  const sourceReady = !contract.source_contracts?.length || !["billing", "usage"].includes(activity) || Boolean(sourceContractReference);
  const obligation = eligibleObligations.some((o) => o.id === selectedObligation)
    ? selectedObligation
    : "";
  const selectedTerms = eligibleObligations.find((item) => item.id === obligation);
  const requiresObligation = !["billing", "reassessment", "rate_change"].includes(activity);
  const minimumEffectiveDate = activity === "billing" ? undefined : activityEarliestDate(contract, activity, selectedTerms);
  const invoiceValueMode = selectedTerms?.method === "metered" && consideration[0]?.metered_value_mode === "invoice_value";
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
  const preModificationVariableIds = new Set<string>();
  const changedOriginalPromiseIds = new Set<string>();
  let componentsBeforeAmendment = contract.consideration;
  for (const change of [...contract.activities].filter((item) => ["modification", "reassessment"].includes(item.type) && item.effective_date <= effective).sort((a, b) => a.effective_date.localeCompare(b.effective_date) || (a.version || 0) - (b.version || 0))) {
    if (change.type === "reassessment") {
      componentsBeforeAmendment = componentsBeforeAmendment.map((item) => item.id === change.component_id ? { ...item, included_amount: String(change.included_amount) } : item);
      continue;
    }
    const revised = (change.consideration as Component[] | undefined) || componentsBeforeAmendment;
    if (change.treatment === "prospective") {
      for (const item of componentsBeforeAmendment) {
        if (!["variable", "usage"].includes(item.kind)) continue;
        preModificationVariableIds.add(item.id);
        const next = revised.find((candidate) => candidate.id === item.id);
        if (!next || Number(next.included_amount ?? next.amount) !== Number(item.included_amount ?? item.amount) || (next.allocation_scope || "relative_ssp") !== (item.allocation_scope || "relative_ssp") || (next.target_period || "") !== (item.target_period || "") || JSON.stringify(next.target_obligation_ids || []) !== JSON.stringify(item.target_obligation_ids || [])) changedOriginalPromiseIds.add(item.id);
      }
    }
    componentsBeforeAmendment = revised;
  }
  const reassessmentNeedsOriginalPromise = activity === "reassessment" && preModificationVariableIds.has(component);
  const changedOriginalPromise = reassessmentNeedsOriginalPromise && changedOriginalPromiseIds.has(component);
  const names: Record<string, string> = {
    billing: "Record billing",
    progress: "Update progress",
    usage: "Record units delivered",
    rate_change: "Change invoice-value rate",
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
      selectedTerms?.method === "metered" ? invoiceValueMode ? "Record delivered units and their externally priced invoice value. Cite the pricing source. This recognizes revenue; it does not post a billing entry." : "Record incremental units delivered. The reviewed rate recognizes revenue from actual units; no quantity cap or forecast is assumed." : "Record incremental units delivered against the total contracted units.",
    rate_change: "The revised rate applies to units delivered on or after its effective date. Earlier units retain their original rate; each month rounds once after all usage is valued.",
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
      canSubmit={!changedOriginalPromise && (!requiresObligation || Boolean(selectedTerms)) && creditReady && sourceReady}
      command={() => {
        const payload = {
          contract_id: contract.id,
          effective_date: effective,
          rationale,
          ...(["billing", "usage"].includes(activity) && contract.source_contracts?.length
            ? { source_contract_reference: sourceContractReference }
            : {}),
          ...(activity === "billing"
            ? { amount, reference, ...(Number(amount) < 0 ? creditOriginalChoice === "external" ? { applies_to_reference: externalInvoice } : { applies_to_change_set_id: creditOriginalChoice } : {}) }
            : activity === "reassessment"
              ? { component_id: component, included_amount: amount }
              : activity === "rate_change"
                ? { component_id: consideration[0].id, unit_rate: unitRate }
              : activity === "right_exercise"
                ? { obligation_id: obligation, delivery_method: deliveryMethod, delivery_start: deliveryStart, delivery_end: deliveryEnd }
              : {
                  obligation_id: obligation,
                  ...(activity === "usage"
                    ? { quantity, ...(invoiceValueMode ? { invoice_value: invoiceValue } : {}) }
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
      {["billing", "usage"].includes(activity) && Boolean(contract.source_contracts?.length) && <Field label="Source agreement" hint="Choose the legal agreement that carries this invoice or usage source record; the accounting schedule remains combined."><select required value={sourceContractReference} onChange={(event) => { setSourceContractReference(event.target.value); setCreditOriginal(""); setExternalInvoice(""); }}><option value="">Choose source agreement</option>{contract.source_contracts?.map((source) => <option key={source.reference} value={source.reference}>{source.reference} · {props.state.customers.find((item) => item.id === (source.customer_id || contract.customer_id))?.name || source.customer_id || contract.customer_id}</option>)}</select></Field>}
      {changedOriginalPromise && <p className="warning">This variable amount changed as part of a prospective amendment. A later estimate change needs a reviewed split between the original and amended promises.</p>}
      {reassessmentNeedsOriginalPromise && !changedOriginalPromise && <p className="fine-print">This amount predates a prospective amendment. Its change follows the original allocation, with revenue for services already delivered recognized in this period. Preview checks whether the original promise and satisfaction path remain identifiable.</p>}
      {activity === "milestone" && selectedTerms?.kind === "material_right" && <p className="fine-print">{selectedRightExercise ? `This exercised right requires a 100% delivery milestone on ${dateLabel(String(selectedRightExercise.delivery_start))}.` : "A milestone for an unexercised right represents delivery within its exercise window, not an election with later delivery."}</p>}
      <div className="form-grid">
        <Field label="Effective date">
          <input
            type="date"
            required
            min={minimumEffectiveDate}
            max={activity === "right_exercise" ? selectedTerms?.exercise_end : undefined}
            value={effective}
            onChange={(e) => setEffective(e.target.value)}
          />
        </Field>
        {activity !== "billing" && activity !== "reassessment" && activity !== "rate_change" && (
          <Field label="Performance obligation" hint={!eligibleObligations.length ? "No obligation is eligible for this activity on the selected date. Check its service or exercise dates." : undefined}>
            <select
              required
              value={obligation}
              disabled={Boolean(correctionTarget)}
              onChange={(e) => {
                setObligation(e.target.value);
                const chosen = eligibleObligations.find((item) => item.id === e.target.value);
                const first = activityEarliestDate(contract, activity, chosen);
                if (effective < first) setEffective(first);
              }}
            >
              <option value="">{eligibleObligations.length ? "Choose an eligible obligation" : "No eligible obligation on this date"}</option>
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
              activity === "reassessment" ? `Revised included amount (${props.state.workspace.currency})` : `Amount (${props.state.workspace.currency})`
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
          <Field label="Units delivered" hint={correctionTarget ? "Enter zero if the original source row recorded units that were not delivered." : undefined}>
            <input
              type="number"
              min={correctionTarget ? "0" : "0.000001"}
              step="any"
              required
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
            />
          </Field>
        )}
        {activity === "usage" && invoiceValueMode && <Field label={`Value entitled to invoice for these units (${props.state.workspace.currency})`} hint="Use the actual amount from the approved pricing source, in cents. Record the invoice separately under Billing when issued."><input type="number" min="0" step="0.01" required value={invoiceValue} onChange={(event) => setInvoiceValue(event.target.value)} /></Field>}
        {activity === "rate_change" && <Field label={`Revised price per unit (${props.state.workspace.currency}/unit)`} hint={`Rate currently effective on this date: ${consideration[0]?.unit_rate || "—"} ${props.state.workspace.currency}/unit.`}><input type="number" min="0" step="any" required value={unitRate} onChange={(event) => setUnitRate(event.target.value)} /></Field>}
        {activity !== "reassessment" && activity !== "right_exercise" && activity !== "rate_change" && (
          <Field
            label={
              activity === "billing"
                ? "Invoice reference"
                : "Supporting reference"
            }
          >
            <input
              required={activity === "usage" && invoiceValueMode}
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              placeholder={
                activity === "billing" ? "INV-2026-001" : invoiceValueMode ? "Pricing source or meter record ID" : "Optional reference"
              }
            />
          </Field>
        )}
      </div>
      {activity === "billing" && Number(amount) < 0 && <><Field label="Original invoice for this credit" hint="Choose an invoice from the same source agreement. A credit memo reduces the billed balance; a contractual price reduction is a separate consideration change."><select required value={creditOriginalChoice} onChange={(event) => setCreditOriginal(event.target.value)}><option value="">Choose original invoice</option>{positiveBillings.map((item) => <option value={item.id} key={item.id}>{item.reference || item.id} · {item.effective_date} · {money(item.amount, props.state.workspace.currency)}</option>)}<option value="external">Original invoice is outside this workspace</option></select></Field>{creditOriginalChoice === "external" && <Field label="External original invoice reference"><input required value={externalInvoice} onChange={(event) => setExternalInvoice(event.target.value)} placeholder="Original invoice ID" /></Field>}</>}
      {["progress", "milestone"].includes(activity) && obligation && <p className="fine-print">Previously recorded cumulative completion: {priorPercentage}%. Proposed change: {percentage ? Number(percentage) - Number(priorPercentage) : "—"} percentage points. Resulting completion: {percentage || "—"}%.</p>}
      {activity === "usage" && obligation && <p className="fine-print">Previously recorded units: {priorUnits}. This entry adds {quantity || "—"} units; resulting cumulative units: {quantity ? priorUnits + Number(quantity) : "—"}{selectedTerms?.total_units ? " of " + selectedTerms.total_units + " contracted" : ""}.</p>}
      <Field label="Rationale">
        <textarea
          rows={3}
          required={Boolean(correctionTarget) || ["adjustment", "reassessment", "right_exercise", "rate_change"].includes(activity) || (activity === "billing" && Number(amount) < 0)}
          value={rationale}
          onChange={(e) => setRationale(e.target.value)}
          placeholder={activity === "rate_change" ? "Why does invoice value at the new rate still correspond to value delivered? Cite the approved rate source." : "Explain the activity and supporting evidence."}
        />
      </Field>
    </CommandDialog>
  );
}
export function RenewalLinkForm(props: FormProps & { contract: Contract }) {
  const { contract, state } = props;
  const available = contract.activities.filter((item) => item.type === "right_exercise" && item.obligation_id && !(state.renewal_links || []).some((link) => link.contract_id === contract.id && link.obligation_id === item.obligation_id));
  const [obligationId, setObligationId] = useState(available[0]?.obligation_id || "");
  const [renewalId, setRenewalId] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [rationale, setRationale] = useState("");
  const exercise = available.find((item) => item.obligation_id === obligationId);
  const renewals = state.contracts.filter((item) => item.id !== contract.id && item.customer_id === contract.customer_id && Boolean(exercise) &&
    item.start_date <= String(exercise?.delivery_start) && item.end_date >= String(exercise?.delivery_end) &&
    item.obligations.every((obligation) => obligation.start_date >= String(exercise?.delivery_start) && obligation.end_date <= String(exercise?.delivery_end)) &&
    !(state.renewal_links || []).some((link) => link.renewal_contract_id === item.id));
  const renewal = renewals.find((item) => item.id === renewalId);
  const newPrice = renewal ? total(renewal.consideration.map((item) => ["variable", "usage"].includes(item.kind) ? item.included_amount ?? item.amount : item.amount)) : "0.00";
  const rightAllocation = state.report.contracts.find((item) => item.id === contract.id)?.allocation.find((item) => item.obligation_id === obligationId)?.amount;
  return <CommandDialog {...props} title="Link renewal contract" subtitle="Pair an exercised material right with the contract for its new price." confirmLabel="Link renewal" successMessage="Renewal contract linked." canSubmit={Boolean(exercise && renewal && confirmed && rationale.trim())} command={() => ({ command: "link_renewal_contract", payload: { contract_id: contract.id, obligation_id: obligationId, renewal_contract_id: renewalId, additional_consideration: newPrice, price_basis: "new_consideration_only", effective_date: exercise?.effective_date, rationale } })}>
    <p className="fine-print">Create the renewal contract and record the right exercise first. The original right allocation remains on {contract.name}; the renewal contract records only its new consideration.</p>
    <Field label="Exercised material right"><select required value={obligationId} onChange={(event) => { setObligationId(event.target.value); setRenewalId(""); setConfirmed(false); }}><option value="">Choose right</option>{available.map((item) => <option key={item.id} value={item.obligation_id}>{contract.obligations.find((obligation) => obligation.id === item.obligation_id)?.name || item.obligation_id} · exercised {dateLabel(item.effective_date)}</option>)}</select></Field>
    {exercise && <p className="fine-print">Delivery: {dateLabel(String(exercise.delivery_start))} – {dateLabel(String(exercise.delivery_end))}</p>}
    <Field label="Renewal contract"><select required value={renewalId} onChange={(event) => { setRenewalId(event.target.value); setConfirmed(false); }}><option value="">Choose contract</option>{renewals.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field>
    {exercise && renewals.length === 0 && <p className="notice">No eligible renewal. Create one whose term covers this delivery window, with all obligations inside it and only new consideration.</p>}
    {renewal && <p>Original right allocation: <strong>{rightAllocation ? money(rightAllocation, state.workspace.currency) : "See original contract"}</strong>. Initial new consideration: <strong>{money(newPrice, state.workspace.currency)}</strong>.</p>}
    <label className="confirmation-row"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /> I reviewed the renewal contract and confirm its price contains only new consideration.</label>
    <Field label="Accounting rationale"><textarea required rows={3} value={rationale} onChange={(event) => setRationale(event.target.value)} placeholder="Explain the renewal price and the carried right allocation." /></Field>
  </CommandDialog>;
}

export function ModificationLinkForm(props: FormProps & { contract: Contract }) {
  const { contract, state } = props;
  const candidates = state.contracts.filter((item) => item.id !== contract.id && item.customer_id === contract.customer_id &&
    item.start_date > contract.start_date && !item.cutover_date && item.consideration.every((component) => component.kind === "fixed") &&
    !(state.modification_links || []).some((link) => link.added_contract_id === item.id) &&
    !(state.renewal_links || []).some((link) => link.renewal_contract_id === item.id));
  const [addedId, setAddedId] = useState("");
  const [effective, setEffective] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [rationale, setRationale] = useState("");
  const added = candidates.find((item) => item.id === addedId);
  const additional = added ? total(added.consideration.map((item) => ["variable", "usage"].includes(item.kind) ? item.included_amount ?? item.amount : item.amount)) : "0.00";
  return <CommandDialog {...props} title="Link separate-contract amendment" subtitle={`Original: ${contract.name}`} confirmLabel="Link added service" successMessage="Separate-contract amendment linked." canSubmit={Boolean(added && effective && confirmed && rationale.trim())} command={() => ({ command: "link_modification_contract", payload: { contract_id: contract.id, added_contract_id: addedId, effective_date: effective, additional_consideration: additional, price_basis: "distinct_at_standalone_price", original_terms_effect: "unchanged", rationale } })}>
    <p className="notice">Use this only when the added goods or services are distinct, the amendment's net price increase reflects their standalone selling prices, and the original terms are unchanged. Create the added-service contract first. If the original service is also repriced and all remaining services are distinct, enter one prospective modification on the original contract instead.</p>
    <Field label="Added-service contract"><select required value={addedId} onChange={(event) => { const next = candidates.find((item) => item.id === event.target.value); setAddedId(event.target.value); setEffective(next ? (next.start_date < contract.end_date ? next.start_date : contract.end_date) : ""); setConfirmed(false); }}><option value="">Choose contract</option>{candidates.map((item) => <option key={item.id} value={item.id}>{item.name} · starts {dateLabel(item.start_date)}</option>)}</select></Field>
    {candidates.length === 0 && <p className="fine-print">Create an unlinked added-service contract for this customer first.</p>}
    <div className="form-grid"><Field label="Amendment approval date"><input type="date" required min={new Date(Date.parse(contract.start_date) + 86400000).toISOString().slice(0, 10)} max={added ? (added.start_date < contract.end_date ? added.start_date : contract.end_date) : undefined} value={effective} onChange={(event) => setEffective(event.target.value)} /></Field><Field label="Initial added consideration"><input readOnly value={additional} /></Field></div>
    <label className="confirmation-row"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /> I reviewed the amendment: the added service is distinct, the price increase reflects its standalone price, and the original contract's remaining promises and price are unchanged.</label>
    <Field label="Accounting rationale"><textarea required rows={3} value={rationale} onChange={(event) => setRationale(event.target.value)} placeholder="Explain why the added promises are distinct and how the price increase reflects standalone selling prices." /></Field>
  </CommandDialog>;
}

export function OpeningPositionForm(props: FormProps & { contract: Contract; correctionTarget?: Activity }) {
  const { contract, correctionTarget } = props;
  const [effective, setEffective] = useState(correctionTarget?.effective_date || contract.cutover_date || `${props.period}-01`);
  const [billed, setBilled] = useState(String(correctionTarget?.billed_to_date || ""));
  const [asset, setAsset] = useState(String(correctionTarget?.contract_asset || ""));
  const [deferred, setDeferred] = useState(String(correctionTarget?.deferred_revenue || ""));
  const [sourceName, setSourceName] = useState(String(correctionTarget?.source_name || ""));
  const [rationale, setRationale] = useState(correctionTarget?.rationale || "");
  const [correctionReason, setCorrectionReason] = useState("");
  const [rows, setRows] = useState<Record<string, { recognized: string; measure: string }>>(
    Object.fromEntries(contract.obligations.map((item) => {
      const opening = (correctionTarget?.opening_obligations as { obligation_id: string; recognized_to_date: string; measure?: string }[] | undefined)?.find((row) => row.obligation_id === item.id);
      return [item.id, { recognized: opening?.recognized_to_date || "", measure: opening?.measure || "" }];
    })),
  );
  const validCents = (value: string) => /^\d+(?:\.\d{1,2})?$/.test(value);
  const recognizedAmounts = contract.obligations.map((item) => rows[item.id]?.recognized || "");
  const recognizedTotal = recognizedAmounts.every(validCents) ? total(recognizedAmounts) : null;
  const derivedNet = recognizedTotal !== null && validCents(billed) ? total([recognizedTotal, `-${billed}`]) : null;
  const enteredNet = validCents(asset) && validCents(deferred) ? total([asset, `-${deferred}`]) : null;
  const setRow = (id: string, field: "recognized" | "measure", value: string) =>
    setRows((current) => ({ ...current, [id]: { ...current[id], [field]: value } }));
  const replacement = () => ({
    contract_id: contract.id, effective_date: effective, billed_to_date: billed,
    contract_asset: asset, deferred_revenue: deferred, source_name: sourceName, rationale,
    opening_obligations: contract.obligations.map((item) => ({
      obligation_id: item.id, recognized_to_date: rows[item.id]?.recognized || "",
      ...(["progress", "milestone", "point_in_time", "usage"].includes(item.method) ? { measure: rows[item.id]?.measure || "" } : {}),
    })),
  });
  return <CommandDialog
    {...props}
    title={correctionTarget ? "Correct opening position" : "Record opening position"}
    subtitle={`${contract.name} · accepted legacy position before ${effective || "cutover"} · amounts in ${props.state.workspace.currency}`}
    wide
    command={() => correctionTarget ? { command: "correct_opening_position", payload: { target_change_set_id: correctionTarget.id, rationale: correctionReason, replacement: replacement() } } : { command: "record_opening_position", payload: replacement() }}
    confirmLabel={correctionTarget ? "Record correction" : "Record opening position"}
    successMessage={correctionTarget ? "Opening position corrected and recalculated." : "Opening position recorded and reconciled."}
  >
    <p className="notice">Use the current accounting terms for this contract. Enter cumulative amounts accepted at the end of the prior month. OpenRevRec will calculate forward from this cutover; it will not reconstruct or report the earlier months.</p>
    {correctionTarget && <p className="notice">This replaces the accepted opening facts while preserving the original change in history. Later activity will be recalculated. Reopen closed periods first.</p>}
    <div className="form-grid">
      <Field label="Cutover month (first day)"><input type="date" required readOnly={Boolean(correctionTarget)} value={effective} onChange={(event) => setEffective(event.target.value)} /></Field>
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
    {correctionTarget && <Field label="Reason for correcting the opening"><textarea rows={2} required value={correctionReason} onChange={(event) => setCorrectionReason(event.target.value)} placeholder="Explain which source facts changed and why." /></Field>}
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
          profileName={(id) => state.policy.account_profiles?.[id]?.name || id}
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
export function AccountRunoffForm(props: FormProps & { contractId: string; role: "contract_asset" | "deferred_revenue" }) {
  const pending = props.state.report.runoff_pending?.find((item) => item.contract_id === props.contractId && item.role === props.role);
  const accepted = props.state.runoff_allocations?.find((item) => item.contract_id === props.contractId && item.role === props.role && item.period === props.period);
  const contract = props.state.contracts.find((item) => item.id === props.contractId);
  const balance = props.state.report.contracts.find((item) => item.id === props.contractId)?.[props.role];
  const source = accepted?.positions || pending?.positions;
  const [rows, setRows] = useState<RunoffPosition[]>(() => source?.map((item) => ({ ...item })) || []);
  const [rationale, setRationale] = useState(accepted?.rationale || "");
  if (!source || balance === undefined) return <Modal title="Account runoff unavailable" onClose={props.onClose}><p>This period has no account balance to allocate.</p></Modal>;
  const validAmounts = rows.every((row) => /^\d+(\.\d{1,2})?$/.test(row.balance));
  const allocated = validAmounts ? total(rows.map((row) => row.balance)) : "";
  return <CommandDialog {...props} wide title="Allocate historical account runoff" subtitle={`${contract?.name || props.contractId} · ${humanize(props.role)} · ${props.period}`}
    confirmLabel={accepted ? "Revise allocation" : "Record allocation"} successMessage="Account runoff allocation recorded."
    canSubmit={Boolean(validAmounts && allocated === balance && rationale.trim())}
    command={() => ({ command: "record_account_runoff", payload: { contract_id: props.contractId, role: props.role, period: props.period,
      positions: rows.map((row) => ({ account: row.account, dimensions: row.dimensions, account_profile_id: row.account_profile_id || null, balance: row.balance })), rationale } })}>
    <p className="muted">Enter each account's closing balance. Together they must equal the contract's {humanize(props.role).toLowerCase()} balance of {money(balance, props.state.workspace.currency)}. An old account can decrease to zero but cannot increase.</p>
    {rows.map((row, index) => <Field key={`${row.account}:${index}`} label={`${row.account} closing balance`} hint={Object.entries(row.dimensions).map(([key, value]) => `${key}: ${value}`).join(" · ") || "No dimensions"}>
      <input required inputMode="decimal" value={row.balance}
        onChange={(event) => setRows(rows.map((item, itemIndex) => itemIndex === index ? { ...item, balance: event.target.value } : item))} />
    </Field>)}
    <p className="fine-print">Allocated: {allocated ? money(allocated, props.state.workspace.currency) : "Enter valid amounts"} · Contract balance: {money(balance, props.state.workspace.currency)}</p>
    <Field label="Accounting rationale"><textarea required rows={3} value={rationale} onChange={(event) => setRationale(event.target.value)} placeholder="Explain which historical services or billings support this split." /></Field>
  </CommandDialog>;
}

export function PolicyForm(props: FormProps) {
  const [name, setName] = useState(props.state.workspace.name),
    [accounts, setAccounts] = useState(props.state.policy.accounts),
    [overrides, setOverrides] = useState(props.state.policy.account_overrides || { contracts: {}, obligations: {} }),
    [profiles, setProfiles] = useState<Record<string, AccountProfile>>(props.state.policy.account_profiles || {}),
    [ruleSource, setRuleSource] = useState(props.state.policy.account_dimension_source || ""),
    [coverageMode, setCoverageMode] = useState<"listed" | "complete">(props.state.policy.account_dimension_coverage || "listed"),
    [pastedRules, setPastedRules] = useState(""),
    [pasteError, setPasteError] = useState(""),
    [ruleRows, setRuleRows] = useState<{ id: string; account: string; dimensions: { id: string; key: string; value: string }[] }[]>(
      (props.state.policy.account_dimension_rules || []).map((rule) => ({
        id: uid(), account: rule.account,
        dimensions: Object.entries(rule.dimensions).map(([key, value]) => ({ id: uid(), key, value })),
      })),
    ),
    [assignments, setAssignments] = useState<Record<string, string>>(props.state.policy.profile_assignments || {}),
    [obligationAssignments, setObligationAssignments] = useState<Record<string, Record<string, string>>>(props.state.policy.obligation_profile_assignments || {}),
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
    [assignmentProfileId, setAssignmentProfileId] = useState(""),
    [obligationContractId, setObligationContractId] = useState(""),
    [assignmentObligationId, setAssignmentObligationId] = useState(""),
    [obligationProfileId, setObligationProfileId] = useState("");
  const draftPayload = {
    name, accounts, account_overrides: overrides, account_profiles: profiles,
    profile_assignments: assignments, obligation_profile_assignments: obligationAssignments,
    account_dimension_rules: ruleRows.map((row) => ({ account: row.account.trim(), dimensions: Object.fromEntries(row.dimensions.map((dimension) => [dimension.key.trim(), dimension.value.trim()])) })),
    account_dimension_source: ruleSource, account_dimension_coverage: coverageMode,
    account_transition: transition || undefined, effective_period: effectivePeriod, rationale,
  };
  const draftSnapshot = JSON.stringify(draftPayload);
  const loadedSnapshot = useRef(draftSnapshot);
  const loadedMonth = useRef(effectivePeriod);
  useEffect(() => {
    if (loadedMonth.current !== effectivePeriod) {
      loadedSnapshot.current = draftSnapshot;
      loadedMonth.current = effectivePeriod;
    }
  }, [effectivePeriod, draftSnapshot]);
  const originalProfile = editingProfileId ? profiles[editingProfileId] : undefined;
  const profileEditorDirty = profileName !== (originalProfile?.name || "") ||
    JSON.stringify(profileAccounts) !== JSON.stringify(originalProfile?.accounts || {}) ||
    JSON.stringify(dimensionRows.map((row) => [row.key, row.value])) !== JSON.stringify(Object.entries(originalProfile?.dimensions || {}));
  const selectedContract = props.state.contracts.find((contract) => contract.id === contractId);
  const obligations = selectedContract ? Array.from(new Map([...selectedContract.obligations, ...selectedContract.activities.flatMap((activity) => (activity.obligations as typeof selectedContract.obligations | undefined) || [])].map((obligation) => [obligation.id, obligation])).values()) : [];
  const assignmentContract = props.state.contracts.find((contract) => contract.id === obligationContractId);
  const assignmentObligations = assignmentContract ? Array.from(new Map([...assignmentContract.obligations, ...assignmentContract.activities.flatMap((activity) => (activity.obligations as typeof assignmentContract.obligations | undefined) || [])].map((obligation) => [obligation.id, obligation])).values()) : [];
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
  const replacePastedRules = () => {
    try {
      const parsed = parseApprovedCombinations(pastedRules);
      setRuleRows(parsed.map((rule) => ({ id: uid(), account: rule.account,
        dimensions: Object.entries(rule.dimensions).map(([key, value]) => ({ id: uid(), key, value })) })));
      setPasteError("");
      setPastedRules("");
    } catch (error) {
      setPasteError(error instanceof Error ? error.message : "The pasted table could not be read.");
    }
  };
  const chooseEffectivePeriod = (month: string) => {
    if (month === effectivePeriod) return true;
    const unsavedDraft = draftSnapshot !== loadedSnapshot.current || profileEditorDirty || Boolean(pastedRules.trim() || accountCode.trim());
    if (unsavedDraft && !window.confirm(`Discard unsaved policy edits and load the saved mappings for ${month}?`)) return false;
    const policy = [...props.state.policy_versions]
      .filter((item) => item.effective_period <= month)
      .sort((a, b) => a.effective_period.localeCompare(b.effective_period) || a.version - b.version)
      .at(-1);
    if (!policy) return false;
    setName(props.state.workspace.name);
    setAccounts(policy.accounts);
    setOverrides(policy.account_overrides || { contracts: {}, obligations: {} });
    setProfiles(policy.account_profiles || {});
    setRuleSource(policy.account_dimension_source || "");
    setCoverageMode(policy.account_dimension_coverage || "listed");
    setRuleRows((policy.account_dimension_rules || []).map((rule) => ({
      id: uid(), account: rule.account,
      dimensions: Object.entries(rule.dimensions).map(([key, value]) => ({ id: uid(), key, value })),
    })));
    setAssignments(policy.profile_assignments || {});
    setObligationAssignments(policy.obligation_profile_assignments || {});
    setRationale("");
    setTransition("");
    setPastedRules("");
    setPasteError("");
    setEditingProfileId("");
    setProfileName("");
    setProfileAccounts({});
    setDimensionRows([]);
    setScope("contract");
    setContractId("");
    setRole("revenue");
    setObligationId("");
    setAccountCode("");
    setAssignmentContractId("");
    setAssignmentProfileId("");
    setObligationContractId("");
    setAssignmentObligationId("");
    setObligationProfileId("");
    setEffectivePeriod(month);
    return true;
  };
  return (
    <CommandDialog
      {...props}
      wide
      period={effectivePeriod}
      title="Company & accounting policy"
      subtitle="Four required journal roles can route to more GL codes through profiles and overrides. Balance routes stay at contract level; revenue can vary by obligation."
      command={() => ({ command: "set_policy", payload: draftPayload })}
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
          onChange={(e) => { if (!chooseEffectivePeriod(e.target.value)) e.target.value = effectivePeriod; }}
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
      <Section title="Reusable accounting profiles" subtitle="A profile supplies optional GL accounts and journal dimensions. Assign one to a contract for balance lines, or to an obligation for its revenue lines. A different revenue dimension can need interunit balancing in the destination ledger.">
        {Object.entries(profiles).map(([id, profile]) => <div className="upload-row" key={id}><span><strong>{profile.name}</strong> · {Object.entries(profile.accounts).map(([role, code]) => `${humanize(role)} ${code}`).join(", ") || "Default accounts"}{Object.keys(profile.dimensions).length ? ` · ${Object.entries(profile.dimensions).map(([key, value]) => `${key}: ${value}`).join(", ")}` : ""}</span><Button type="button" onClick={() => selectProfile(id)}>Edit</Button><Button type="button" onClick={() => { const next = { ...profiles }; delete next[id]; setProfiles(next); setAssignments(Object.fromEntries(Object.entries(assignments).filter(([, profileId]) => profileId !== id))); setObligationAssignments(Object.fromEntries(Object.entries(obligationAssignments).map(([contractId, items]) => [contractId, Object.fromEntries(Object.entries(items).filter(([, profileId]) => profileId !== id))]).filter(([, items]) => Object.keys(items).length))); if (editingProfileId === id) selectProfile(""); }}>Remove</Button></div>)}
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
        <h4>Obligation revenue assignments</h4>
        {Object.entries(obligationAssignments).flatMap(([contractId, items]) => Object.entries(items).map(([obligationId, profileId]) => <div className="upload-row" key={`${contractId}:${obligationId}`}><span>{props.state.contracts.find((contract) => contract.id === contractId)?.name || contractId} / {obligationId} → {profiles[profileId]?.name || profileId}</span><Button type="button" onClick={() => { const next = { ...obligationAssignments, [contractId]: { ...items } }; delete next[contractId][obligationId]; if (!Object.keys(next[contractId]).length) delete next[contractId]; setObligationAssignments(next); }}>Remove</Button></div>))}
        <div className="form-grid"><Field label="Contract"><select value={obligationContractId} onChange={(event) => { setObligationContractId(event.target.value); setAssignmentObligationId(""); }}><option value="">Choose contract</option>{props.state.contracts.map((contract) => <option key={contract.id} value={contract.id}>{contract.name}</option>)}</select></Field><Field label="Revenue obligation"><select value={assignmentObligationId} onChange={(event) => setAssignmentObligationId(event.target.value)}><option value="">Choose obligation</option>{assignmentObligations.map((obligation) => <option key={obligation.id} value={obligation.id}>{obligation.name}</option>)}</select></Field><Field label="Revenue profile"><select value={obligationProfileId} onChange={(event) => setObligationProfileId(event.target.value)}><option value="">Choose profile</option>{Object.entries(profiles).map(([id, profile]) => <option key={id} value={id}>{profile.name}</option>)}</select></Field></div>
        <Button type="button" disabled={!obligationContractId || !assignmentObligationId || !obligationProfileId} onClick={() => { setObligationAssignments({ ...obligationAssignments, [obligationContractId]: { ...(obligationAssignments[obligationContractId] || {}), [assignmentObligationId]: obligationProfileId } }); setAssignmentObligationId(""); }}>Assign obligation profile</Button>
      </Section>
      <Section title="Specific account mappings" subtitle="For revenue, an obligation account override takes precedence over its obligation profile, then the contract mapping, contract profile, and workspace default.">
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
      <Section title="Approved posting combinations" subtitle="Local preflight against a reviewed list of exact GL account and dimension combinations. Choose whether this list covers selected accounts or every journal account. The destination ledger remains authoritative.">
        <Field label="Chart or account-structure source" hint="Name the approved source and version used to build this list."><input required={ruleRows.length > 0} value={ruleSource} onChange={(event) => setRuleSource(event.target.value)} placeholder="e.g. September account structure export" /></Field>
        <Field label="Preflight coverage" hint="Selected accounts leaves unlisted journal accounts for close review. Every journal account blocks close if any account lacks an approved combination; use this only when the list is complete for the period."><select value={coverageMode} onChange={(event) => setCoverageMode(event.target.value as "listed" | "complete")}><option value="listed">Selected accounts; review unlisted accounts</option><option value="complete">Every journal account; block gaps</option></select></Field>
        {coverageMode === "complete" && ruleRows.length === 0 && <p className="notice">Add at least one approved combination before saving complete coverage.</p>}
        <details><summary>Paste combinations from a spreadsheet</summary><p className="fine-print">Paste tab-separated columns headed Account, then dimension names. Each row is one complete allowed combination; a blank cell means the dimension is absent, not a wildcard. This replaces the list below when you click Apply.</p><Field label="Approved combinations table"><textarea rows={5} value={pastedRules} onChange={(event) => { setPastedRules(event.target.value); setPasteError(""); }} placeholder={"Account\tDepartment\tProject\n4000\tRecurring\tP-17\n2300\tHead office\tP-17"} /></Field>{pasteError && <p className="error">{pasteError}</p>}<Button type="button" disabled={!pastedRules.trim()} onClick={replacePastedRules}>Apply pasted combinations</Button></details>
        {ruleRows.map((rule, index) => <div className="editor-row" key={rule.id}>
          <div className="form-grid">
            <Field label="GL account"><input required value={rule.account} onChange={(event) => setRuleRows(ruleRows.map((item, i) => i === index ? { ...item, account: event.target.value } : item))} placeholder="e.g. 4100" /></Field>
            <Button type="button" onClick={() => setRuleRows(ruleRows.filter((item) => item.id !== rule.id))}>Remove combination</Button>
          </div>
          {rule.dimensions.map((dimension) => <div className="form-grid" key={dimension.id}>
            <Field label="Dimension name"><input required value={dimension.key} onChange={(event) => setRuleRows(ruleRows.map((item, i) => i === index ? { ...item, dimensions: item.dimensions.map((part) => part.id === dimension.id ? { ...part, key: event.target.value } : part) } : item))} placeholder="Department" /></Field>
            <Field label="Allowed value"><input required value={dimension.value} onChange={(event) => setRuleRows(ruleRows.map((item, i) => i === index ? { ...item, dimensions: item.dimensions.map((part) => part.id === dimension.id ? { ...part, value: event.target.value } : part) } : item))} placeholder="Recurring" /></Field>
            <Button type="button" onClick={() => setRuleRows(ruleRows.map((item, i) => i === index ? { ...item, dimensions: item.dimensions.filter((part) => part.id !== dimension.id) } : item))}>Remove dimension</Button>
          </div>)}
          <Button type="button" onClick={() => setRuleRows(ruleRows.map((item, i) => i === index ? { ...item, dimensions: [...item.dimensions, { id: uid(), key: "", value: "" }] } : item))}>Add dimension</Button>
        </div>)}
        <Button type="button" onClick={() => setRuleRows([...ruleRows, { id: uid(), account: "", dimensions: [] }])}>Add approved combination</Button>
      </Section>
      <Field label="Opening balance treatment" hint="Required when changing a deferred revenue or contract asset account or a profile dimension with an opening balance. Transfer adds balanced opening entries. External requires separate ledger reconciliation. Runoff keeps the old account balance until you explicitly allocate each month's closing balance by account; unallocated months cannot close.">
        <select value={transition} onChange={(e) => setTransition(e.target.value)}><option value="">Choose when needed</option><option value="transfer">Transfer opening balances in journal</option><option value="external">External transfer and reconciliation</option><option value="runoff">Keep old balances for reviewed runoff</option></select>
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
