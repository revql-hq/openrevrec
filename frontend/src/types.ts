export type Customer = {
  id: string;
  name: string;
  email?: string;
  reference?: string;
  description?: string;
};
export type Component = {
  id: string;
  label: string;
  kind: string;
  amount: string;
  included_amount?: string;
  potential_amount?: string;
  estimated_amount?: string;
  estimation_method?: string;
  rationale?: string;
};
export type Obligation = {
  id: string;
  name: string;
  kind: string;
  ssp: string;
  method: string;
  start_date: string;
  end_date: string;
  total_units?: string;
  rationale?: string;
  exercise_start?: string;
  exercise_end?: string;
};
export type Activity = {
  id: string;
  type: string;
  effective_date: string;
  recorded_at?: string;
  obligation_id?: string;
  amount?: string;
  percentage?: string;
  quantity?: string;
  reference?: string;
  rationale?: string;
  [key: string]: unknown;
};
export type Contract = {
  id: string;
  name: string;
  customer_id: string;
  start_date: string;
  end_date: string;
  consideration: Component[];
  obligations: Obligation[];
  activities: Activity[];
  rationale?: string;
  reference?: string;
  description?: string;
};
export type Totals = {
  transaction_price: string;
  revenue: string;
  recognized_to_date: string;
  billings: string;
  billed_to_date: string;
  deferred_revenue: string;
  contract_asset: string;
  remaining_revenue: string;
};
export type ContractReport = Totals & {
  id: string;
  name: string;
  customer_id: string;
  allocation: {
    obligation_id: string;
    name: string;
    ssp: string;
    amount: string;
  }[];
};
export type Journal = {
  id: string;
  period: string;
  contract_id: string;
  account: string;
  account_name: string;
  role: string;
  debit: string;
  credit: string;
  debit_minor: number;
  credit_minor: number;
  description: string;
};
export type Schedule = {
  period: string;
  contract_id: string;
  obligation_id: string;
  revenue: string;
};
export type CatchUp = {
  activity_id?: string;
  contract_id: string;
  obligation_id: string;
  effective_date: string;
  period: string;
  previous_recognized: string;
  required_cumulative: string;
  catch_up: string;
  rationale?: string;
};
export type Report = {
  period: string;
  policy_version?: number;
  policy_effective_period?: string;
  policy_accounts?: Record<string, string>;
  summary: Totals;
  contracts: ContractReport[];
  schedule: Schedule[];
  journals: Journal[];
  warnings: string[];
  catch_ups?: CatchUp[];
  closed?: boolean;
  close_id?: string;
};
export type Scenario = {
  id: string;
  name: string;
  status: string;
  base_version: number;
  created_at: string;
};
export type Change = {
  id: string;
  command?: string;
  type?: string;
  created_at?: string;
  recorded_at?: string;
  scenario_id?: string;
  payload?: Record<string, unknown>;
  rationale?: string;
  [key: string]: unknown;
};
export type Note = {
  id: string;
  entity_id?: string;
  kind: string;
  body: string;
  due_date?: string;
  created_at?: string;
  completed?: boolean;
};
export type Close = {
  id: string;
  period: string;
  status?: string;
  closed_at?: string;
  created_at?: string;
  reopened_at?: string;
  rationale?: string;
  [key: string]: unknown;
};
export type Evidence = {
  id: string;
  entity_id?: string;
  scenario_id?: string;
  target_change_set_id?: string;
  obligation_id?: string;
  period_close_id?: string;
  name: string;
  path: string;
  rationale?: string;
  recorded_at?: string;
};
export type State = {
  workspace: { id: string; name: string; currency: string; created_at: string };
  policy: {
    version: number;
    effective_period: string;
    currency: string;
    rounding: string;
    accounts: Record<string, string>;
  };
  policy_versions: {
    version: number;
    effective_period: string;
    accounts: Record<string, string>;
    change_set_id?: string;
  }[];
  customers: Customer[];
  contracts: Contract[];
  scenarios: Scenario[];
  change_sets: Change[];
  closes: Close[];
  notes: Note[];
  evidence?: Evidence[];
  report: Report;
  scenario_id: string;
  frontier: number;
};
export type Command = { command: string; payload: Record<string, unknown> };
export type Comparison = {
  rows: {
    period: string;
    main_revenue: string;
    scenario_revenue: string;
    delta: string;
  }[];
  summary: Partial<Totals>;
  [key: string]: unknown;
};
export type Preview = { before: Report; state: State; comparison?: Comparison };
export type View =
  | "Home"
  | "Customers"
  | "Contracts"
  | "Revenue"
  | "Scenarios"
  | "Journal entries"
  | "Reports"
  | "Imports"
  | "Activity"
  | "Settings";
