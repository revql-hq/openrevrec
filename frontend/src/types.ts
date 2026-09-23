export type Customer = {
  id: string;
  name: string;
  email?: string;
  reference?: string;
  source_system?: string;
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
  unit_rate?: string;
  metered_value_mode?: "unit_rate" | "invoice_value";
  pricing_basis?: "right_to_invoice";
  rounding_period?: "calendar_month";
  allocation_scope?: "relative_ssp" | "specific";
  target_obligation_ids?: string[];
  target_period?: string;
  allocation_rationale?: string;
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
  version?: number;
  type: string;
  effective_date: string;
  recorded_at?: string;
  obligation_id?: string;
  amount?: string;
  percentage?: string;
  quantity?: string;
  unit_rate?: string;
  invoice_value?: string;
  component_id?: string;
  reference?: string;
  rationale?: string;
  [key: string]: unknown;
};
export type Contract = {
  id: string;
  version?: number;
  name: string;
  customer_id: string;
  start_date: string;
  end_date: string;
  term_basis?: "fixed" | "cancellable" | "evergreen";
  term_assessment_rationale?: string;
  term_reassessment_trigger?: string;
  term_review_date?: string;
  cutover_date?: string;
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
  allocation_components?: {
    component_id: string;
    label: string;
    kind: string;
    included_amount: string;
    recognized_to_date?: string | null;
    scope: "relative_ssp" | "specific";
    target_obligation_ids: string[];
    target_period?: string;
    rationale: string;
    unit_rate?: string;
    metered_value_mode?: "unit_rate" | "invoice_value";
    pricing_basis?: string;
    rounding_period?: string;
  }[];
  original_promise_changes?: {
    activity_id?: string | null;
    effective_date: string;
    component_id: string;
    component: string;
    obligation_id: string;
    obligation: string;
    allocated_change: string;
    recognized_to_date: string;
    rationale: string;
  }[];
  metered_rate_history?: { effective_date: string; unit_rate: string; rationale: string; activity_id: string }[];
  metered_usage_valuation?: { activity_id: string; effective_date: string; period: string; quantity: string; unit_rate: string; unrounded_value: string; value_source?: "unit_rate" | "invoice_value"; reference?: string }[];
  metered_monthly_values?: { period: string; quantity: string; unrounded_value: string; revenue: string }[];
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
  account_profile_id?: string;
  dimensions?: Record<string, string>;
};
export type AccountProfile = {
  name: string;
  accounts: Record<string, string>;
  dimensions: Record<string, string>;
};
export type AccountDimensionRule = { account: string; dimensions: Record<string, string> };
export type RunoffPosition = { account: string; dimensions: Record<string, string>; account_profile_id?: string | null; balance: string; opening_balance?: string };
export type RunoffAllocation = { contract_id: string; role: "contract_asset" | "deferred_revenue"; period: string; positions: RunoffPosition[]; rationale: string; change_set_id?: string };
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
  journal_batch_id?: string;
  policy_version?: number;
  policy_effective_period?: string;
  policy_accounts?: Record<string, string>;
  policy_account_profiles?: Record<string, AccountProfile>;
  policy_obligation_profile_assignments?: Record<string, Record<string, string>>;
  summary: Totals;
  contracts: ContractReport[];
  schedule: Schedule[];
  journals: Journal[];
  account_transitions?: { contract_id: string; role: string; from_account: string; to_account: string; opening_balance: string; treatment: string; from_dimensions?: Record<string, string>; to_dimensions?: Record<string, string> }[];
  account_positions?: { contract_id: string; role: string; account: string; dimensions: Record<string, string>; account_profile_id?: string | null; balance: string }[];
  runoff_active?: boolean;
  runoff_pending?: { contract_id: string; role: "contract_asset" | "deferred_revenue"; period: string; closing_balance: string; positions: RunoffPosition[] }[];
  runoff_unresolved?: { contract_id: string; role: "contract_asset" | "deferred_revenue"; period: string; closing_balance: string; positions: RunoffPosition[] }[];
  segment_imbalances?: { contract_id: string; dimensions: Record<string, string>; net_debit: string }[];
  account_dimension_exceptions?: { journal_id: string; contract_id: string; account: string; role: string; dimensions: Record<string, string> }[];
  account_dimension_unvalidated_accounts?: string[];
  policy_account_dimension_rules?: AccountDimensionRule[];
  policy_account_dimension_source?: string;
  warnings: string[];
  catch_ups?: CatchUp[];
  renewal_links?: RenewalLinkReport[];
  modification_links?: ModificationLinkReport[];
  closed?: boolean;
  close_id?: string;
};
export type RenewalLinkReport = {
  change_set_id: string;
  recorded_at: string;
  contract_id: string;
  contract_name: string;
  obligation_id: string;
  obligation_name: string;
  renewal_contract_id: string;
  renewal_contract_name: string;
  exercise_date: string;
  delivery_start: string;
  delivery_end: string;
  original_right_allocation: string;
  initial_new_consideration: string;
  current_renewal_price: string;
  combined_consideration: string;
  right_revenue: string;
  renewal_revenue: string;
  combined_revenue: string;
  rationale: string;
};
export type ModificationLinkReport = {
  change_set_id: string;
  recorded_at: string;
  contract_id: string;
  contract_name: string;
  added_contract_id: string;
  added_contract_name: string;
  effective_date: string;
  price_basis: string;
  original_terms_effect: string;
  initial_additional_consideration: string;
  current_added_price: string;
  original_revenue: string;
  added_revenue: string;
  combined_revenue: string;
  original_contract_asset: string;
  original_deferred_revenue: string;
  added_contract_asset: string;
  added_deferred_revenue: string;
  rationale: string;
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
  period?: string;
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
export type JudgmentReview = {
  target_change_set_id: string;
  reviewer: string;
  disposition: "supported" | "exception";
  conclusion: string;
  support_memo: string;
  exception_reason?: string;
  recorded_at: string;
  change_set_id: string;
};
export type TermReview = {
  contract_id: string;
  effective_date: string;
  reviewer: string;
  conclusion: string;
  support_memo: string;
  next_review_date: string;
  version: number;
  change_set_id: string;
};
export type PostingComparison = {
  source_batch_id: string;
  target_batch_id: string;
  source_close_id?: string | null;
  posting_references: string[];
  current_batch_posted: boolean;
  target_closed: boolean;
  available: boolean;
  lines: {
    contract_id: string;
    account: string;
    dimensions: Record<string, string>;
    roles: string[];
    obligation_ids: string[];
    posted_net: string;
    revised_net: string;
    debit: string;
    credit: string;
  }[];
};
export type State = {
  workspace: { id: string; name: string; currency: string; created_at: string };
  policy: {
    version: number;
    effective_period: string;
    currency: string;
    rounding: string;
    accounts: Record<string, string>;
    account_overrides?: {
      contracts: Record<string, Record<string, string>>;
      obligations: Record<string, Record<string, string>>;
    };
    account_profiles?: Record<string, AccountProfile>;
    profile_assignments?: Record<string, string>;
    obligation_profile_assignments?: Record<string, Record<string, string>>;
    account_transition?: "transfer" | "external" | "runoff";
    account_dimension_rules?: AccountDimensionRule[];
    account_dimension_source?: string;
  };
  policy_versions: {
    version: number;
    effective_period: string;
    accounts: Record<string, string>;
    account_overrides?: {
      contracts: Record<string, Record<string, string>>;
      obligations: Record<string, Record<string, string>>;
    };
    account_profiles?: Record<string, AccountProfile>;
    profile_assignments?: Record<string, string>;
    obligation_profile_assignments?: Record<string, Record<string, string>>;
    account_dimension_rules?: AccountDimensionRule[];
    account_dimension_source?: string;
    change_set_id?: string;
  }[];
  customers: Customer[];
  contracts: Contract[];
  renewal_links?: { contract_id: string; obligation_id: string; renewal_contract_id: string; change_set_id: string }[];
  modification_links?: { contract_id: string; added_contract_id: string; change_set_id: string; effective_date: string }[];
  scenarios: Scenario[];
  change_sets: Change[];
  closes: Close[];
  notes: Note[];
  evidence?: Evidence[];
  judgment_reviews?: JudgmentReview[];
  term_reviews?: TermReview[];
  runoff_allocations?: RunoffAllocation[];
  postings?: { period: string; batch_id: string; close_id?: string; external_journal_reference: string; posted_date: string; rationale: string; recorded_at: string }[];
  posting_comparisons?: PostingComparison[];
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
  details?: { period: string; contract_id: string; obligation_id: string; current: string; proposed: string; delta: string }[];
  affected_periods?: string[];
  proposals?: { id: string; command: string; entity_id: string; effective_date: string; rationale: string }[];
  conflicts?: { command: string; entity_id: string; version: number }[];
  summary: Partial<Totals>;
  [key: string]: unknown;
};
export type Preview = { before: Report; state: State; comparison?: Comparison; selected_period?: string; focus_period?: string };
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
