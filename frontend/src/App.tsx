import { useState, useEffect, useCallback, useRef } from "react";
import {
  House,
  UsersRound,
  Files,
  ChartNoAxesCombined,
  GitBranch,
  BookOpen,
  Table2,
  Import,
  History,
  Settings2,
  Search,
  Plus,
  ChevronsUpDown,
  PanelLeftClose,
  PanelLeftOpen,
  Check,
  Circle,
  X,
  FolderOpen,
  LoaderCircle,
  ChevronRight,
} from "lucide-react";
import { api, monthLabel } from "./api";
import { Button, Empty, ErrorMessage, Modal } from "./components";
import {
  CustomerForm,
  ContractForm,
  ActivityForm,
  RenewalLinkForm,
  ModificationLinkForm,
  OpeningPositionForm,
  TermReviewForm,
  ScenarioForm,
  LifecycleForm,
  CloseForm,
  NoteForm,
  PolicyForm,
  DetailsForm,
} from "./forms";
import {
  HomeView,
  CustomersView,
  ContractsView,
  ContractView,
  RevenueView,
  ScenarioView,
  JournalView,
  ReportsView,
  ImportsView,
  ActivityView,
  SettingsView,
} from "./views";
import type { State, View } from "./types";

declare global {
  interface Window {
    orrDesktop?: {
      platform: string;
      getWorkspace: () => Promise<{ path: string; name: string; needsSetup: boolean }>;
      openWorkspace: () => Promise<unknown>;
      createWorkspace: (setup: { name: string; currency: string; openingPeriod: string; accounts: Record<string, string> }) => Promise<unknown>;
      onCreateWorkspaceRequested: (callback: () => void) => () => void;
    };
  }
}
export type Dialog = {
  type:
    | "customer"
    | "contract"
    | "activity"
    | "renewal_link"
    | "modification_link"
    | "opening_position"
    | "term_review"
    | "scenario"
    | "lifecycle"
    | "close"
    | "note"
    | "policy"
    | "workspace"
    | "details";
  contractId?: string;
  customerId?: string;
  activity?: string;
  action?: string;
  scenarioId?: string;
  reopen?: boolean;
  entityId?: string;
};
export type ViewProps = {
  state: State;
  period: string;
  dialog: (dialog: Dialog) => void;
  navigate: (view: View, id?: string, tab?: string, focus?: string) => void;
  refresh: (message?: string) => Promise<void>;
  setScenario: (scenario: string) => void;
  selected?: string;
  tab?: string;
  focus?: string;
};
const navigation: { name: View; icon: typeof House }[] = [
  { name: "Home", icon: House },
  { name: "Customers", icon: UsersRound },
  { name: "Contracts", icon: Files },
  { name: "Revenue", icon: ChartNoAxesCombined },
  { name: "Scenarios", icon: GitBranch },
  { name: "Journal entries", icon: BookOpen },
  { name: "Reports", icon: Table2 },
  { name: "Imports", icon: Import },
];
export default function App() {
  const [loadedState, setState] = useState<State | null>(null),
    [period, setPeriod] = useState(
      new Date().toLocaleDateString("en-CA").slice(0, 7),
    ),
    [scenario, setScenario] = useState("main"),
    [view, setView] = useState<View>("Home"),
    [selected, setSelected] = useState<string | undefined>(),
    [selectedTab, setSelectedTab] = useState<string | undefined>(),
    [selectedFocus, setSelectedFocus] = useState<string | undefined>(),
    [dialog, setDialog] = useState<Dialog | null>(null),
    [search, setSearch] = useState(false),
    [collapsed, setCollapsed] = useState(false),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true),
    [setupRequired, setSetupRequired] = useState(false),
    [notice, setNotice] = useState("");
  // Never render commands for a new selection using the previous selection's data.
  const state =
    loadedState?.scenario_id === scenario &&
    loadedState.report.period === period
      ? loadedState
      : null;
  const requestVersion = useRef(0);
  const fetchState = useCallback(async () => {
    return api<State>(
      `/api/state?scenario_id=${encodeURIComponent(scenario)}&period=${period}`,
    );
  }, [scenario, period]);
  const refresh = useCallback(
    async (message?: string) => {
      const version = ++requestVersion.current;
      setError("");
      setLoading(true);
      try {
        const next = await fetchState();
        if (version !== requestVersion.current) return;
        setState(next);
        if (
          scenario !== "main" &&
          next.scenarios.find((s) => s.id === scenario)?.status !== "active"
        )
          setScenario("main");
        if (message) setNotice(message);
      } catch (e) {
        if (version === requestVersion.current) setError((e as Error).message);
        throw e;
      } finally {
        if (version === requestVersion.current) setLoading(false);
      }
    },
    [fetchState, scenario],
  );
  useEffect(() => {
    setDialog(null);
    setSearch(false);
    void refresh().catch(() => {});
    return () => {
      requestVersion.current++;
    };
  }, [refresh]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearch((s) => !s);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  useEffect(() => window.orrDesktop?.onCreateWorkspaceRequested(() => setDialog({ type: "workspace", action: "create" })), []);
  useEffect(() => {
    void window.orrDesktop?.getWorkspace().then((value) => {
      if (value.needsSetup) {
        setSetupRequired(true);
        setDialog({ type: "workspace", action: "create" });
      }
    }).catch((e) => setError((e as Error).message));
  }, []);
  useEffect(() => {
    if (!notice) return;
    const timeout = setTimeout(() => setNotice(""), 4500);
    return () => clearTimeout(timeout);
  }, [notice]);
  const navigate = (next: View, id?: string, tab?: string, focus?: string) => {
    setView(next);
    setSelected(id);
    setSelectedTab(tab);
    setSelectedFocus(focus);
    setSearch(false);
  };
  const activeScenario = state?.scenarios.find((s) => s.id === scenario);
  const isClosed = state?.closes.some(
    (c) => c.period === period && c.status !== "reopened" && !c.reopened_at,
  );
  const props: ViewProps | null = state
    ? {
        state,
        period,
        dialog: setDialog,
        navigate,
        refresh,
        setScenario,
        selected,
        tab: selectedTab,
        focus: selectedFocus,
      }
    : null;
  const contract = state?.contracts.find((c) => c.id === dialog?.contractId);
  const detailEntity =
    state && dialog?.entityId
      ? state.customers.find((c) => c.id === dialog.entityId) ||
        state.contracts.find((c) => c.id === dialog.entityId)
      : undefined;
  const formProps = state
    ? { state, period, onClose: () => setDialog(null), onDone: refresh }
    : null;
  const pageTitle =
    selected && view === "Contracts"
      ? state?.contracts.find((c) => c.id === selected)?.name || "Contract"
      : selected && view === "Customers"
        ? state?.customers.find((c) => c.id === selected)?.name || "Customer"
        : selected && view === "Activity"
          ? "Change detail"
        : view;
  return (
    <div className={`app-shell ${collapsed ? "sidebar-collapsed" : ""}`}>
      <aside className="sidebar">
        <div className="sidebar-brand">
          <button
            className="brand"
            onClick={() => navigate("Home")}
            aria-label="OpenRevRec home"
          >
            <span className="brand-symbol">
              <span />
              <span />
              <span />
            </span>
            {!collapsed && <span>OpenRevRec</span>}
          </button>
          <button
            className="icon-button"
            onClick={() => setCollapsed(!collapsed)}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            {collapsed ? (
              <PanelLeftOpen size={16} />
            ) : (
              <PanelLeftClose size={16} />
            )}
          </button>
        </div>
        <button
          className="workspace-switch"
          onClick={() => setDialog({ type: "workspace" })}
          title="Workspace"
        >
          <span className="workspace-initial">
            {state?.workspace.name?.[0]?.toUpperCase() || "O"}
          </span>
          {!collapsed && (
            <>
              <span>
                <strong>{state?.workspace.name || "Local workspace"}</strong>
                <small>Local workspace</small>
              </span>
              <ChevronsUpDown size={13} />
            </>
          )}
        </button>
        <button
          className="search-button"
          onClick={() => setSearch(true)}
          title="Search (⌘K)"
        >
          <Search size={16} />
          {!collapsed && (
            <>
              <span>Search workspace</span>
              <kbd>{navigator.platform.includes("Mac") ? "⌘" : "Ctrl"} K</kbd>
            </>
          )}
        </button>
        <nav aria-label="Main navigation">
          {navigation.map(({ name, icon: Icon }) => (
            <button
              key={name}
              className={`nav-item ${view === name ? "active" : ""}`}
              onClick={() => navigate(name)}
              title={collapsed ? name : undefined}
            >
              <Icon size={17} />
              {!collapsed && <span>{name}</span>}
              {!collapsed &&
                name === "Scenarios" &&
                !!state?.scenarios.filter(
                  (s) => s.id !== "main" && s.status === "active",
                ).length && (
                  <span className="nav-count">
                    {
                      state.scenarios.filter(
                        (s) => s.id !== "main" && s.status === "active",
                      ).length
                    }
                  </span>
                )}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          {[
            { name: "Activity" as View, icon: History },
            { name: "Settings" as View, icon: Settings2 },
          ].map(({ name, icon: Icon }) => (
            <button
              key={name}
              className={`nav-item ${view === name ? "active" : ""}`}
              onClick={() => navigate(name)}
              title={collapsed ? name : undefined}
            >
              <Icon size={17} />
              {!collapsed && <span>{name}</span>}
            </button>
          ))}
          <div className="local-status">
            <span className="status-dot" />
            {!collapsed && <span>Stored on this device</span>}
          </div>
        </div>
      </aside>
      <main className="main">
        <header className="topbar">
          <div className="breadcrumb">
            {selected && (
              <>
                <button onClick={() => navigate(view)}>{view}</button>
                <ChevronRight size={13} />
              </>
            )}
            <span>{pageTitle}</span>
          </div>
          <div className="topbar-controls">
            <div
              className={`scenario-select ${scenario !== "main" ? "in-scenario" : ""}`}
            >
              <GitBranch size={14} />
              <select
                aria-label="Working scenario"
                value={scenario}
                onChange={(e) => setScenario(e.target.value)}
              >
                <option value="main">Main</option>
                {state?.scenarios
                  .filter((s) => s.id !== "main" && s.status === "active")
                  .map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                {scenario !== "main" && activeScenario?.status !== "active" && (
                  <option value={scenario}>
                    {activeScenario?.name || scenario}
                  </option>
                )}
              </select>
            </div>
            <div className="topbar-divider" />
            <input
              className="period-picker"
              aria-label="Working period"
              type="month"
              value={period}
              onChange={(e) => {
                if (e.target.value) setPeriod(e.target.value);
              }}
            />
          </div>
        </header>
        {scenario !== "main" && (
          <div className="scenario-banner">
            <GitBranch size={14} />
            <span>
              Working in <strong>{activeScenario?.name || "scenario"}</strong>.
              Main is unchanged.
            </span>
            <button onClick={() => navigate("Scenarios", scenario)}>
              Compare with Main
              <ChevronRight size={13} />
            </button>
          </div>
        )}
        <div className="content" key={`${view}-${selected || ""}-${selectedTab || ""}-${selectedFocus || ""}`}>
          <ErrorMessage error={error} />
          {!state && loading ? (
            <div className="app-loading">
              <LoaderCircle size={22} className="spin" />
              <p>Opening your workspace…</p>
            </div>
          ) : !state ? (
            <Empty
              title="The workspace could not be opened"
              action={
                <Button onClick={() => refresh().catch(() => {})}>
                  Try again
                </Button>
              }
            >
              Check that the local OpenRevRec service is running.
            </Empty>
          ) : (
            props && (
              <>
                {loading && (
                  <div className="refreshing" aria-label="Refreshing workspace">
                    <LoaderCircle size={13} className="spin" />
                  </div>
                )}
                {view === "Home" && <HomeView {...props} />}
                {view === "Customers" && <CustomersView {...props} />}
                {view === "Contracts" &&
                  (selected ? (
                    <ContractView {...props} />
                  ) : (
                    <ContractsView {...props} />
                  ))}
                {view === "Revenue" && <RevenueView {...props} />}
                {view === "Scenarios" && <ScenarioView {...props} />}
                {view === "Journal entries" && <JournalView {...props} />}
                {view === "Reports" && <ReportsView {...props} />}
                {view === "Imports" && <ImportsView {...props} />}
                {view === "Activity" && <ActivityView {...props} />}
                {view === "Settings" && <SettingsView {...props} />}
              </>
            )
          )}
        </div>
        <footer className="statusbar">
          <span>
            <Circle size={8} />
            {state ? `${state.contracts.length} contracts` : "Connecting"}
          </span>
          <span>
            {state?.workspace.currency || "USD"}
            <span className="status-separator">·</span>
            {monthLabel(period)}
            <span className="status-separator">·</span>
            {isClosed ? "Closed" : "Open"}
            {state?.frontier !== undefined && (
              <>
                <span className="status-separator">·</span>Version{" "}
                {state.frontier}
              </>
            )}
          </span>
        </footer>
      </main>
      {notice && (
        <div className="toast" role="status">
          <Check size={16} />
          <span>{notice}</span>
          <button
            className="icon-button"
            onClick={() => setNotice("")}
            aria-label="Dismiss notification"
          >
            <X size={14} />
          </button>
        </div>
      )}
      {search && state && (
        <SearchDialog
          state={state}
          onClose={() => setSearch(false)}
          navigate={navigate}
        />
      )}{" "}
      {dialog && formProps && (
        <>
          {dialog.type === "customer" && <CustomerForm {...formProps} />}{" "}
          {dialog.type === "contract" && (
            <ContractForm
              {...formProps}
              contract={contract}
              customerId={dialog.customerId}
            />
          )}{" "}
          {dialog.type === "activity" && contract && (
            <ActivityForm
              {...formProps}
              contract={contract}
              activity={dialog.activity || "billing"}
              correctionTarget={dialog.action === "correct" ? contract.activities.find((activity) => activity.id === dialog.entityId) : undefined}
            />
          )}{" "}
          {dialog.type === "renewal_link" && contract && <RenewalLinkForm {...formProps} contract={contract} />}{" "}
          {dialog.type === "modification_link" && contract && <ModificationLinkForm {...formProps} contract={contract} />}{" "}
          {dialog.type === "opening_position" && contract && (
            <OpeningPositionForm {...formProps} contract={contract} />
          )}{" "}
          {dialog.type === "term_review" && contract && (
            <TermReviewForm {...formProps} contract={contract} />
          )}{" "}
          {dialog.type === "scenario" && <ScenarioForm {...formProps} />}{" "}
          {dialog.type === "lifecycle" && (
            <LifecycleForm
              {...formProps}
              action={dialog.action || "apply"}
              scenarioId={dialog.scenarioId || scenario}
            />
          )}{" "}
          {dialog.type === "close" && (
            <CloseForm {...formProps} reopen={dialog.reopen} />
          )}{" "}
          {dialog.type === "note" && (
            <NoteForm {...formProps} entityId={dialog.entityId} />
          )}{" "}
          {dialog.type === "policy" && <PolicyForm {...formProps} />}{" "}
          {dialog.type === "details" && detailEntity && (
            <DetailsForm {...formProps} entity={detailEntity} />
          )}{" "}
          {dialog.type === "workspace" && (
            <WorkspaceDialog state={state!} initialCreate={dialog.action === "create"} setupRequired={setupRequired} onClose={() => { if (!setupRequired) setDialog(null); }} />
          )}
        </>
      )}
    </div>
  );
}
function WorkspaceDialog({
  state,
  initialCreate,
  setupRequired,
  onClose,
}: {
  state: State;
  initialCreate: boolean;
  setupRequired: boolean;
  onClose: () => void;
}) {
  const [path, setPath] = useState(""),
    [error, setError] = useState(""),
    [creating, setCreating] = useState(initialCreate),
    [busy, setBusy] = useState(false),
    [name, setName] = useState(""),
    [currency, setCurrency] = useState("USD"),
    [openingPeriod, setOpeningPeriod] = useState(new Date().toLocaleDateString("en-CA").slice(0, 7)),
    [accounts, setAccounts] = useState<Record<string, string>>({ revenue: "4000", deferred_revenue: "2300", contract_asset: "1200", billing_clearing: "1100" });
  useEffect(() => {
    window.orrDesktop
      ?.getWorkspace()
      .then((value) => setPath(value.path))
      .catch((e) => setError(e.message));
  }, []);
  const change = async (create: boolean) => {
    setBusy(true);
    setError("");
    try {
      if (create) await window.orrDesktop?.createWorkspace({ name: name.trim(), currency, openingPeriod, accounts });
      else await window.orrDesktop?.openWorkspace();
    } catch (e) {
      setError((e as Error).message);
    } finally { setBusy(false); }
  };
  return (
    <Modal title="Workspace" onClose={onClose}>
      <div className="modal-body">
        <h3>{setupRequired ? "Set up your first workspace" : state.workspace.name}</h3>
        <p className="muted">
          Your accounting data lives in a local .orr directory.
        </p>
        {!setupRequired && path && <code className="path">{path}</code>}
        {!setupRequired && <dl className="definition-list">
          <div>
            <dt>Currency</dt>
            <dd>{state.workspace.currency}</dd>
          </div>
          <div>
            <dt>Workspace ID</dt>
            <dd className="mono">{state.workspace.id}</dd>
          </div>
        </dl>}
        {window.orrDesktop ? (creating ? (
          <form onSubmit={(event) => { event.preventDefault(); void change(true); }}>
            <label className="field">Company name<input required value={name} onChange={(event) => setName(event.target.value)} placeholder="Company name" /></label>
            <div className="form-grid">
              <label className="field">Reporting currency<select value={currency} onChange={(event) => setCurrency(event.target.value)}>{["USD", "EUR", "GBP", "CAD", "AUD"].map((code) => <option key={code}>{code}</option>)}</select></label>
              <label className="field">Default accounts effective from<input required type="month" value={openingPeriod} onChange={(event) => setOpeningPeriod(event.target.value)} /></label>
            </div>
            <p className="muted">Choose the four default journal roles. You can assign more specific accounts to contracts and obligations later.</p>
            <div className="form-grid">{([
              ["revenue", "Revenue"], ["deferred_revenue", "Deferred revenue"], ["contract_asset", "Contract asset"], ["billing_clearing", "Billing clearing"],
            ] as const).map(([role, label]) => <label className="field" key={role}>{label}<input required value={accounts[role]} onChange={(event) => setAccounts({ ...accounts, [role]: event.target.value })} /></label>)}</div>
            <p className="muted">The workspace uses one reporting currency and calendar months. This setup does not import opening balances or configure foreign exchange.</p>
            <div className="button-group workspace-actions"><Button type="button" onClick={() => setCreating(false)}>Back</Button><Button primary type="submit" disabled={busy}>Create workspace</Button></div>
          </form>
        ) : <div className="button-group workspace-actions">
            <Button onClick={() => void change(false)} disabled={busy}><FolderOpen size={15} />Open workspace</Button>
            <Button primary onClick={() => setCreating(true)} disabled={busy}><Plus size={15} />Create workspace</Button>
          </div>
        ) : (
          <p className="notice">
            In browser development, the workspace is selected when the local
            service starts. The desktop app includes a workspace picker.
          </p>
        )}
        <ErrorMessage error={error} />
      </div>
    </Modal>
  );
}
function SearchDialog({
  state,
  onClose,
  navigate,
}: {
  state: State;
  onClose: () => void;
  navigate: (view: View, id?: string) => void;
}) {
  const [query, setQuery] = useState(""),
    [remote, setRemote] = useState<
      {
        type: string;
        id: string;
        name: string;
        entity_id?: string;
        contract_id?: string;
      }[]
    >([]),
    [error, setError] = useState("");
  useEffect(() => {
    let canceled = false;
    if (!query.trim()) {
      setRemote([]);
      return;
    }
    const timeout = setTimeout(() => {
      api<{ results: typeof remote }>(
        `/api/search?q=${encodeURIComponent(query)}&scenario_id=${encodeURIComponent(state.scenario_id)}&period=${state.report.period}`,
      )
        .then((value) => {
          if (!canceled) {
            setRemote(value.results || []);
            setError("");
          }
        })
        .catch((e) => {
          if (!canceled) setError(e.message);
        });
    }, 180);
    return () => {
      canceled = true;
      clearTimeout(timeout);
    };
  }, [query, state.scenario_id, state.report.period]);
  const pages: { type: string; id: string; name: string }[] = [
    "Home",
    "Customers",
    "Contracts",
    "Revenue",
    "Scenarios",
    "Journal entries",
    "Reports",
    "Imports",
    "Activity",
    "Settings",
  ]
    .filter((name) => name.toLowerCase().includes(query.toLowerCase()))
    .map((name) => ({ type: "page", id: name, name }));
  const results = [...pages, ...remote];
  const go = (
    item: (typeof results)[number] & {
      contract_id?: string;
      entity_id?: string;
    },
  ) => {
    if (item.type === "page") navigate(item.name as View);
    else if (item.type === "customer") navigate("Customers", item.id);
    else if (item.type === "scenario") navigate("Scenarios", item.id);
    else if (item.type === "contract") navigate("Contracts", item.id);
    else if (
      item.contract_id ||
      state.contracts.some((c) => c.id === item.entity_id)
    )
      navigate("Contracts", item.contract_id || item.entity_id);
    else navigate("Activity");
    onClose();
  };
  return (
    <Modal title="Search workspace" onClose={onClose}>
      <div className="search-input-wrap">
        <Search size={18} />
        <input
          autoFocus
          placeholder="Contracts, customers, notes, or a page…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search query"
          onKeyDown={(e) => {
            if (e.key === "Enter" && results[0]) go(results[0]);
          }}
        />
      </div>
      <div className="search-results">
        {results.slice(0, 24).map((item, i) => (
          <button key={`${item.type}-${item.id}-${i}`} onClick={() => go(item)}>
            <span>
              <strong>{item.name}</strong>
              <small>{humanizeSearch(item.type)}</small>
            </span>
            <ChevronRight size={14} />
          </button>
        ))}
        {!results.length && (
          <Empty title="No matching records">
            Try a customer name, contract, or reference.
          </Empty>
        )}
        <ErrorMessage error={error} />
      </div>
      <div className="search-footer">
        <kbd>Enter</kbd> Open first result <span />
        <kbd>Esc</kbd> Close
      </div>
    </Modal>
  );
}
function humanizeSearch(value: string) {
  return value.replaceAll("_", " ");
}
