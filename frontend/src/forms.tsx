import { useEffect, useRef, useState, type ReactNode } from "react";
import { changeComponentKind, contractTerms } from "./contractTerms";
import { ArrowLeft, Plus, Trash2 } from "lucide-react";
import { api, post, uid, money, humanize } from "./api";
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
  Component,
  Obligation,
  Command,
  Preview,
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
}: FormProps & {
  title: string;
  subtitle?: string;
  children: ReactNode;
  command: () => Command;
  wide?: boolean;
  confirmLabel?: string;
  successMessage?: string;
  previewRequired?: boolean;
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
              <FinancialPreview
                before={preview.before}
                after={preview.state.report}
                currency={state.workspace.currency}
              />
              <Section title="Journal impact">
                <JournalsTable
                  rows={preview.state.report.journals}
                  currency={state.workspace.currency}
                  contractName={(id) =>
                    preview.state.contracts.find((c) => c.id === id)?.name || id
                  }
                />
              </Section>
              {["modify_contract", "reassess_variable_consideration", "record_adjustment", "set_policy", "reopen_period"].includes(command().command) && <Section title="Support this judgment" subtitle="Attach the document or analysis used for this accounting conclusion.">
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
              <Button onClick={() => setPreview(null)} disabled={busy}>
                <ArrowLeft size={14} />
                Edit details
              </Button>
            ) : (
              <Button onClick={onClose} disabled={busy}>
                Cancel
              </Button>
            )}
            <Button primary type="submit" busy={busy}>
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
    [reference, setReference] = useState("");
  return (
    <CommandDialog
      {...props}
      title="New customer"
      previewRequired={false}
      command={() => ({
        command: "create_customer",
        payload: { name, email, reference },
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
        <Field label="Reference">
          <input
            value={reference}
            onChange={(e) => setReference(e.target.value)}
            placeholder="Your customer ID"
          />
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
          ...(customer ? { email } : {}),
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
  monthly: "Over time · equal monthly",
  point_in_time: "Point in time",
  progress: "Cumulative progress",
  usage: "Units delivered",
  milestone: "Milestone completion",
};
function ComponentEditor({
  items,
  onChange,
}: {
  items: Component[];
  onChange: (items: Component[]) => void;
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
          onClick={() =>
            onChange([
              ...items,
              { id: uid(), label: "", kind: "fixed", amount: "0.00" },
            ])
          }
        >
          <Plus size={14} />
          Add component
        </Button>
      }
    >
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
              disabled={items.length === 1}
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
              changes.
            </p>
          )}
        </div>
      ))}
    </Section>
  );
}
function ObligationEditor({
  items,
  onChange,
  start,
  end,
}: {
  items: Obligation[];
  onChange: (items: Obligation[]) => void;
  start: string;
  end: string;
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
          onClick={() =>
            onChange([
              ...items,
              {
                id: uid(),
                name: "",
                kind: "service",
                ssp: "0.00",
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
              disabled={items.length === 1}
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
                min="0.01"
                step="0.01"
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
          {item.kind === "material_right" && (
            <div className="form-grid">
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
            </div>
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
  const [name, setName] = useState(contract?.name || ""),
    [customer, setCustomer] = useState(
      contract?.customer_id ||
        props.customerId ||
        props.state.customers[0]?.id ||
        "",
    ),
    [start, setStart] = useState(contract?.start_date || `${props.period}-01`),
    [end, setEnd] = useState(
      contract?.end_date ||
        `${Number(props.period.slice(0, 4)) + 1}-${props.period.slice(5)}-01`,
    ),
    [rationale, setRationale] = useState(""),
    [effective, setEffective] = useState(`${props.period}-01`),
    [treatment, setTreatment] = useState("prospective");
  const [components, setComponents] = useState<Component[]>(
    initialTerms?.consideration || [
      { id: uid(), label: "Subscription", kind: "fixed", amount: "12000.00" },
    ],
  );
  const [obligations, setObligations] = useState<Obligation[]>(
    initialTerms?.obligations || [
      {
        id: uid(),
        name: "Subscription service",
        kind: "service",
        ssp: "12000.00",
        method: "exact_days",
        start_date: start,
        end_date: end,
      },
    ],
  );
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
            consideration: components,
            obligations,
            rationale,
          },
        };
  return (
    <CommandDialog
      {...props}
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
                    {c.name}
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
                  const terms = contractTerms(contract, e.target.value);
                  setComponents(terms.consideration);
                  setObligations(terms.obligations);
                }}
              />
            </Field>
            <Field label="Accounting treatment">
              <select
                value={treatment}
                onChange={(e) => setTreatment(e.target.value)}
              >
                <option value="prospective">Prospective</option>
                <option value="catch_up">Cumulative catch-up</option>
              </select>
            </Field>
          </div>
          <p className="notice">
            Changing the effective date reloads the terms in effect on that
            date. Enter revised lifetime consideration, including revenue
            already recognized.{" "}
            {treatment === "prospective"
              ? "Remaining consideration is recognized prospectively from the effective date."
              : "Revenue is recalculated under the revised terms and the difference is recognized on the effective date."}{" "}
            For separate-contract treatment, create a new contract.
          </p>
        </>
      )}
      <ComponentEditor items={components} onChange={setComponents} />
      <ObligationEditor
        items={obligations}
        onChange={setObligations}
        start={start}
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
  props: FormProps & { contract: Contract; activity: string },
) {
  const { contract, activity } = props;
  const [effective, setEffective] = useState(`${props.period}-01`);
  const { obligations, consideration } = contractTerms(contract, effective);
  const [selectedObligation, setObligation] = useState(
      obligations[0]?.id || "",
    ),
    [selectedComponent, setComponent] = useState(
      consideration.find((c) => ["variable", "usage"].includes(c.kind))?.id ||
        "",
    ),
    [amount, setAmount] = useState(""),
    [percentage, setPercentage] = useState(
      activity === "milestone" ? "100" : "",
    ),
    [quantity, setQuantity] = useState(""),
    [reference, setReference] = useState(""),
    [rationale, setRationale] = useState("");
  const obligation = obligations.some((o) => o.id === selectedObligation)
    ? selectedObligation
    : obligations[0]?.id || "";
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
    adjustment: "Record revenue adjustment",
    reassessment: "Reassess consideration",
  };
  const descriptions: Record<string, string> = {
    billing:
      "Billing changes the contract balance. Revenue follows the satisfaction model.",
    progress: "Enter cumulative completion, from 0 to 100 percent.",
    usage:
      "Record incremental units delivered against the total contracted units.",
    milestone:
      "Record cumulative satisfaction. Use 100% for a completed point-in-time obligation.",
    adjustment:
      "Record a signed revenue adjustment with an explicit accounting rationale.",
    reassessment:
      "Change the amount included in the transaction price and record your conclusion.",
  };
  return (
    <CommandDialog
      {...props}
      title={names[activity]}
      subtitle={contract.name}
      command={() => ({
        command:
          activity === "reassessment"
            ? "reassess_variable_consideration"
            : `record_${activity}`,
        payload: {
          contract_id: contract.id,
          effective_date: effective,
          rationale,
          ...(activity === "billing"
            ? { amount, reference }
            : activity === "reassessment"
              ? { component_id: component, included_amount: amount }
              : {
                  obligation_id: obligation,
                  ...(activity === "usage"
                    ? { quantity }
                    : activity === "adjustment"
                      ? { amount }
                      : { percentage }),
                  reference,
                }),
        },
      })}
      successMessage={`${humanize(activity)} recorded.`}
    >
      <p className="notice">{descriptions[activity]}</p>
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
          <Field label="Performance obligation">
            <select
              value={obligation}
              onChange={(e) => setObligation(e.target.value)}
            >
              {obligations.map((o) => (
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
            <input
              type="number"
              min="0"
              max="100"
              step="any"
              required
              value={percentage}
              onChange={(e) => setPercentage(e.target.value)}
            />
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
        {activity !== "reassessment" && (
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
      <Field label="Rationale">
        <textarea
          rows={3}
          required={["adjustment", "reassessment"].includes(activity)}
          value={rationale}
          onChange={(e) => setRationale(e.target.value)}
          placeholder="Explain the activity and supporting evidence."
        />
      </Field>
    </CommandDialog>
  );
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
      command={() => ({
        command: reopen ? "reopen_period" : "close_period",
        payload: { period, rationale },
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
        {review?.checks.map((check) => <div className="check-row close-check-row" key={check.id}>
          <div><strong>{check.label}</strong><p>{check.detail}</p></div><span>{check.status}</span>
        </div>)}
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
    [due, setDue] = useState("");
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
        <Field label="Due date">
          <input
            type="date"
            value={due}
            onChange={(e) => setDue(e.target.value)}
          />
        </Field>
      )}
    </CommandDialog>
  );
}
export function PolicyForm(props: FormProps) {
  const [name, setName] = useState(props.state.workspace.name),
    [accounts, setAccounts] = useState(props.state.policy.accounts),
    [effectivePeriod, setEffectivePeriod] = useState(props.period),
    [rationale, setRationale] = useState("");
  return (
    <CommandDialog
      {...props}
      title="Company & accounting policy"
      subtitle="Choose when the new journal account mapping takes effect."
      command={() => ({
        command: "set_policy",
        payload: { name, accounts, effective_period: effectivePeriod, rationale },
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
          onChange={(e) => setEffectivePeriod(e.target.value)}
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
