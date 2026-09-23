import { useEffect, useRef, type ReactNode } from "react";
import {
  ArrowDownToLine,
  ArrowUpRight,
  Check,
  LoaderCircle,
  Plus,
  X,
} from "lucide-react";
import { dateLabel, humanize, money, total } from "./api";
import type { Journal, Report, Totals } from "./types";

export function Button({
  children,
  primary = false,
  className = "",
  busy,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  primary?: boolean;
  busy?: boolean;
}) {
  return (
    <button
      className={`button ${primary ? "primary" : ""} ${className}`}
      {...props}
      disabled={busy || props.disabled}
    >
      {busy && <LoaderCircle size={14} className="spin" />}
      {children}
    </button>
  );
}
export function Field({
  label,
  hint,
  children,
  className = "",
}: {
  label: string;
  hint?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={`field ${className}`}>
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}
export function Empty({
  title,
  children,
  action,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action && <div className="empty-actions">{action}</div>}
    </div>
  );
}
export function Section({
  title,
  children,
  action,
  subtitle,
}: {
  title?: string;
  children: ReactNode;
  action?: ReactNode;
  subtitle?: string;
}) {
  return (
    <section className="section">
      {title && (
        <div className="section-heading">
          <div>
            <h2>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          {action}
        </div>
      )}
      {children}
    </section>
  );
}
export function Tag({
  children,
  tone = "",
}: {
  children: ReactNode;
  tone?: string;
}) {
  return <span className={`tag ${tone}`}>{children}</span>;
}
export function ErrorMessage({ error }: { error: string }) {
  return error ? (
    <div className="error" role="alert">
      {error}
    </div>
  ) : null;
}
export function Modal({
  title,
  subtitle,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement;
    const node = ref.current;
    const focusable = () =>
      node?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex="0"]',
      );
    const first = focusable()?.[0];
    first?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeRef.current();
      if (e.key === "Tab") {
        const list = focusable();
        if (!list?.length) return;
        const first = list[0],
          last = list[list.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("keydown", key);
      previous?.focus();
    };
  }, []);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`modal ${wide ? "wide" : ""}`}
      >
        <header className="modal-heading">
          <div>
            <h2>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <button
            className="icon-button"
            aria-label="Close dialog"
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </header>
        {children}
      </div>
    </div>
  );
}
export const metricNames: Record<keyof Totals, string> = {
  transaction_price: "Transaction price",
  revenue: "Period revenue",
  recognized_to_date: "Recognized to date",
  billings: "Period billings",
  billed_to_date: "Billed to date",
  deferred_revenue: "Deferred revenue",
  contract_asset: "Contract asset",
  remaining_revenue: "Remaining revenue",
};
export function Metrics({
  summary,
  currency,
  compact = false,
}: {
  summary: Partial<Totals>;
  currency: string;
  compact?: boolean;
}) {
  const keys: (keyof Totals)[] = compact
    ? ["revenue", "deferred_revenue", "contract_asset", "remaining_revenue"]
    : [
        "revenue",
        "billings",
        "deferred_revenue",
        "contract_asset",
        "remaining_revenue",
      ];
  return (
    <div className={`metrics ${compact ? "compact" : ""}`}>
      {keys.map((key) => (
        <div className="metric" key={key}>
          <span>{metricNames[key]}</span>
          <strong>{money(summary[key], currency)}</strong>
        </div>
      ))}
    </div>
  );
}
export function FinancialPreview({
  before,
  after,
  currency,
}: {
  before: Report;
  after: Report;
  currency: string;
}) {
  const keys: (keyof Totals)[] = [
    "transaction_price",
    "revenue",
    "recognized_to_date",
    "deferred_revenue",
    "contract_asset",
    "remaining_revenue",
  ];
  return (
    <div className="preview">
      <div className="preview-title">
        <Check size={16} />
        <h3>Review financial impact</h3>
        <span>{after.period}</span>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Measure</th>
              <th className="number">Current</th>
              <th className="number">After change</th>
              <th className="number">Change</th>
            </tr>
          </thead>
          <tbody>
            {keys.map((key) => {
              const difference = total([
                after.summary[key],
                before.summary[key]?.startsWith("-")
                  ? before.summary[key].slice(1)
                  : `-${before.summary[key]}`,
              ]);
              return (
                <tr key={key}>
                  <td>{metricNames[key]}</td>
                  <td className="number muted">
                    {money(before.summary[key], currency)}
                  </td>
                  <td className="number">
                    {money(after.summary[key], currency)}
                  </td>
                  <td
                    className={`number ${difference === "0.00" ? "muted" : "emphasis"}`}
                  >
                    {difference === "0.00" ? "—" : money(difference, currency)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {after.warnings?.length > 0 && (
        <div className="warning">
          {after.warnings.map((warning, i) => (
            <p key={i}>{warning}</p>
          ))}
        </div>
      )}
      <p className="fine-print">
        Calculated for the selected period. Nothing has been recorded yet.
      </p>
    </div>
  );
}
export function JournalsTable({
  rows,
  currency,
  contractName,
  onContract,
  profileName,
}: {
  rows: Journal[];
  currency: string;
  contractName: (id: string) => string;
  onContract?: (id: string) => void;
  profileName?: (id: string) => string;
}) {
  if (!rows.length)
    return (
      <Empty title="No journal entries in this period">
        Entries are derived from billing and recognized revenue.
      </Empty>
    );
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Account</th>
            <th>Contract</th>
            <th>Description</th>
            <th>Dimensions</th>
            <th className="number">Debit</th>
            <th className="number">Credit</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={`${row.id}-${index}`}>
              <td>
                <span className="tabular">{row.account}</span>{" "}
                <span className="muted account-name">
                  {row.account_name || humanize(row.role)}
                </span>
              </td>
              <td>
                {onContract ? (
                  <button
                    className="table-link"
                    onClick={() => onContract(row.contract_id)}
                  >
                    {contractName(row.contract_id)}
                  </button>
                ) : (
                  contractName(row.contract_id)
                )}
              </td>
              <td className="muted">{row.description}</td>
              <td>{Object.entries(row.dimensions || {}).map(([key, value]) => `${key}: ${value}`).join(" · ") || "—"}{row.account_profile_id && <small className="cell-subtitle">Profile {profileName?.(row.account_profile_id) || row.account_profile_id}</small>}</td>
              <td className="number">
                {Number(row.debit) === 0 ? "—" : money(row.debit, currency)}
              </td>
              <td className="number">
                {Number(row.credit) === 0 ? "—" : money(row.credit, currency)}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th colSpan={4}>Total</th>
            <th className="number">
              {money(total(rows.map((row) => row.debit)), currency)}
            </th>
            <th className="number">
              {money(total(rows.map((row) => row.credit)), currency)}
            </th>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
export function ExportButton({
  scenario,
  period,
  label = "Export workbook",
}: {
  scenario: string;
  period: string;
  label?: string;
}) {
  return (
    <a
      className="button"
      href={`/api/export?scenario_id=${encodeURIComponent(scenario)}&period=${period}`}
      download
    >
      <ArrowDownToLine size={14} />
      {label}
    </a>
  );
}
export function DateText({ value }: { value?: string }) {
  return <span className="nowrap">{dateLabel(value)}</span>;
}
export function AddButton({
  children,
  onClick,
}: {
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <Button onClick={onClick}>
      <Plus size={14} />
      {children}
    </Button>
  );
}
export function JumpButton({
  children,
  onClick,
}: {
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <button className="text-button" onClick={onClick}>
      {children}
      <ArrowUpRight size={13} />
    </button>
  );
}
