# Local API and Excel interchange

The browser and desktop application use the same local HTTP API. The server binds to `127.0.0.1`.

```sh
uv run openrevrec serve --workspace ./Example.orr --port 4318
```

For an authenticated local server, pass `--token YOUR_TOKEN`. Requests then include `Authorization: Bearer YOUR_TOKEN`. The desktop generates a random token on every engine launch and supplies it automatically. This is a local interface, not a hosted multi-user service.

## Read state

```sh
curl 'http://127.0.0.1:4318/api/state?scenario_id=main&period=2026-09'
```

The response includes the workspace, policy selected for the requested period, `policy_versions`, customers, contracts, scenarios, change sets, closes, notes, evidence, judgment reviews, and calculated report. Account mappings have an `effective_period`; currency and rounding remain fixed for the workspace. Monetary values are decimal strings; journals also contain integer minor-unit amounts.

## Record a command

```sh
curl http://127.0.0.1:4318/api/commands \
  -H 'Content-Type: application/json' \
  -d '{"command":"create_customer","payload":{"name":"Example customer"},"scenario_id":"main","idempotency_key":"customer-example-1"}'
```

The response contains `{ "result": ..., "state": ... }`. An idempotency key permits a client to retry the same request without duplicating the accepted change.

Command names include:

- `create_customer`, `create_contract`, `edit_details`
- `record_opening_position`, `record_billing`, `record_usage`, `record_progress`, `record_milestone`, `record_right_exercise`, `record_adjustment`
- `modify_contract`, `reassess_variable_consideration`, `set_policy`, `record_control_totals`, `record_population_manifest`
- `create_scenario`, `apply_scenario`, `rebase_scenario`, `archive_scenario`, `restore_scenario`
- `close_period`, `reopen_period`, `add_note`, `attach_evidence`, `record_judgment_review`

`record_judgment_review` accepts `target_change_set_id`, `reviewer`, `conclusion`, `support_memo`, and `disposition` (`supported` or `exception`). An exception also requires `exception_reason`. It can target an initial contract or another judgment change visible in the scenario. A later review supersedes the earlier disposition without deleting history. Its support memo can refer to an internal analysis, with file attachments linked separately.

`POST /api/preview` accepts the same command envelope and returns `{ "before": ..., "state": ..., "comparison": ... }` without persisting the change. `before` is the report being changed. Applying a scenario previews Main before and after acceptance, even when the request originates inside the scenario. Rebasing previews the target scenario. Use the returned `before` report for the financial comparison rather than the report currently displayed by the caller.

`set_policy` accepts `effective_period` in `YYYY-MM` form with an `accounts` mapping. A mapping effective in October changes October and later journals while an earlier period retains its prior mapping. A change affecting an accepted closed period requires that period to be reopened first.

`set_policy` also accepts full `account_profiles`, `profile_assignments`, and `obligation_profile_assignments` maps. A profile has a stable ID and `{ "name": "Services", "accounts": { "revenue": "4100" }, "dimensions": { "Department": "Recurring" } }`. Contract assignments map contract IDs to profile IDs; obligation assignments map contract IDs to `{ obligation_id: profile_id }`. Billing and balance lines use the contract profile. Revenue resolution order is direct obligation account override, obligation profile, contract role override, contract profile, then workspace default. Revenue dimensions merge the contract profile with the obligation profile, with obligation values winning on shared keys. Account or contract dimension remapping requires `account_transition` (`transfer` or `external`) when the changed route has a nonzero prior-month balance. A zero-balance route begins using the new mapping without a transfer. Journal JSON carries `account_profile_id` and `dimensions`; the workbook uses one column per encountered dimension and exports both assignment maps. Journals may remain unbalanced by dimension when revenue and balance lines use different dimension combinations. The report and workbook show each imbalance; the destination ledger's interunit handling remains outside this command.

`record_right_exercise` accepts `contract_id`, the material-right `obligation_id`, an exercise `effective_date` inside the option window, `delivery_method` (`exact_days`, `monthly`, `prorated_monthly`, or `point_in_time`), `delivery_start`, `delivery_end`, and a rationale. A point-in-time method uses the same start and end date and needs a subsequent 100% `record_milestone` on that date. The `Right Exercises` import sheet carries the same fields with a stable `source_id`.

`link_renewal_contract` accepts the original `contract_id`, exercised-right `obligation_id`, `renewal_contract_id`, `additional_consideration`, `price_basis` (`new_consideration_only`), and rationale. The renewal contract must belong to the same customer, cover exactly the exercised right's delivery dates, and contain only the new transaction price; the submitted amount must equal its initial transaction price. An optional `effective_date` must match the exercise date. Each right and renewal contract can be linked once. The `Renewal Links` import sheet runs after contracts and right exercises and requires a stable `source_id`. The export's `Renewal links` sheet shows both prices and current-month revenue together, while the source contracts' balances remain separate.

`create_contract` and `modify_contract` can carry `term_basis` (`fixed`, `cancellable`, or `evergreen`), `term_assessment_rationale`, `term_reassessment_trigger`, and optional `term_review_date`. A nonfixed basis requires the rationale and trigger. The original contract end and current obligation dates represent the assessed accounting term; a later change to the current service dates belongs in a dated modification. The import template has corresponding Contracts and Amendments columns, and the export includes Term assessments and Term reviews sheets. A due review date becomes a close-review check; it does not change recognition automatically. `record_term_review` accepts `contract_id`, `effective_date`, `reviewer`, `conclusion`, `support_memo`, and `next_review_date`. It records an unchanged assessment and reschedules the check without changing revenue. When a review was already scheduled, the next date is required. The review date cannot be in the future or a closed period. A later term amendment supersedes the review.

## Reports and interchange

| Endpoint | Purpose |
| --- | --- |
| `GET /api/health` | Engine health |
| `GET /api/workspace` | Workspace metadata |
| `GET /api/state?scenario_id=main&period=2026-09` | State and calculated report |
| `GET /api/reports?scenario_id=main&period=2026-09` | Close readiness and prebuilt accounting review views |
| `GET /api/compare?scenario_id=ID&period=2026-09` | Scenario financial comparison |
| `GET /api/changes/ID?period=2026-09` | Recorded change, before and after state and reports, financial comparison, and exact linked evidence |
| `GET /api/export?scenario_id=main&period=2026-09` | Excel report workbook |
| `GET /api/export-package?scenario_id=main&period=2026-09` | ZIP with the workbook, indexed evidence files, and SHA-256 manifest |
| `GET /api/template` | Excel import workbook with data-entry sheets and a Commands sheet |
| `POST /api/import/preview` | Review workbook rows, duplicates, controls, and period impacts without committing |
| `POST /api/import` | Commit a reviewed workbook using multipart `file`, `scenario_id`, `expected_hash`, and `expected_frontier` |
| `POST /api/evidence` | Attach a multipart `file` with optional `entity_id`, `target_change_set_id`, `obligation_id`, `period_close_id`, and `rationale` |
| `POST /api/evidence/reuse` | Link an existing evidence file to another entity or change without uploading a copy |
| `GET /api/evidence/ID` | Download linked evidence |
| `GET /api/search?q=subscription` | Workspace search |
| `POST /api/sql` | Read-only SQL; body `{ "query": "SELECT ..." }` |
| `POST /api/demo` | Load five example contracts into an empty workspace |

The reports response includes close checks with semantic `target` values and exact `exceptions`, a contract asset and deferred revenue rollforward, billing versus recognition timing, future recognition coverage, and active scenario impacts. A judgment change needs a supported review record to clear its review item; exception rows report the review disposition and linked-file count separately. File presence alone does not clear the check. The Excel export includes these views, account policy, change lineage, judgment support with review conclusion and memo, an evidence index, and detailed accounting support. Closed-period financial values come from the accepted checkpoint; the evidence index retains each attachment's later recorded date. The support ZIP includes all files in that index.

External controls are entered with `record_control_totals` for one open Main period: `period`, `source_name`, `rationale`, `billings`, `contract_asset`, and `deferred_revenue`. An optional `close_cutoff_date` (no earlier than period end) distinguishes ordinary close entries from later changes; without it, period end is used. Reports compares those independent totals to the model and shows signed differences. If a control is missing or differs, close requires an explicit acceptance reason. These comparisons only make sense when the external totals use the same contract population and classification basis.

An independent identity check uses `record_population_manifest` on an open Main period with `period`, `source_name`, `rationale`, `contract_references` (an array of source contract IDs), and `billing_references` (an array of `{ "contract_reference": "...", "invoice_reference": "..." }`). Supply empty arrays explicitly when the independent extract has no rows. Reports compares the source lists to active or outstanding workspace contracts and to billing entries effective in that month, including credits. A billing import's stable `source_id` is used when it has no invoice reference. Missing, unexpected, duplicate, or unidentified records become a separate close review item and appear in the workbook. The comparison is captured in the close checkpoint; the source extract and population filters still need the accountant's review. Contracts need a stable `reference` to match the register; invoice references or stable imported source IDs identify billing rows.

After closing a Main period, `record_export_posting` can retain its `journal_batch_id`, `external_journal_reference`, `posted_date`, and `rationale`. The batch ID must match the current closed journal; the command records its immutable close ID. A later reopen and revised journal produces a different batch ID. Main state includes `posting_comparisons` for prior recorded batches, with source and target batch IDs, posting references, whether the source checkpoint is available, and balanced delta lines by contract, account, and dimensions. The Excel export includes a `Replacement journal` sheet. A comparison while the period is open is draft support; after reclose it reflects the accepted replacement. Confirm which recorded batch represents the ledger before posting a delta. OpenRevRec does not post or verify the external journal.

Download the import template from the application or `/api/template`. It includes sheets for customers, contracts, consideration, obligations, opening positions, structured amendments and corrections, billing, progress, usage, milestones, adjustments, reassessments, and notes. Supply stable source IDs for activities so overlapping source extracts can be recognized. Contract, consideration, and obligation rows are combined into one contract baseline.

Consideration and Amendment Consideration sheets accept `allocation_scope`, comma-separated `target_obligation_ids`, `allocation_rationale`, and optional `target_period` in `YYYY-MM` form. Leave them blank for relative SSP. Set `allocation_scope` to `specific` only for an eligible variable, usage, or credit component, with current obligation targets and a documented conclusion. `target_period` is limited to one time-based service obligation and a variable or usage component; the month must overlap its service dates. The export shows final obligation allocations, component targeting decisions, the target month, and cumulative recognition for targeted components. A prospective modification retains earned targeted revenue and allocates revised unrecognized amounts to remaining targets. It rejects revisions to already satisfied targets, reversals of earned targeted amounts, changes in a retained component's allocation scope, and cases with an opening position or unattributed prior obligation adjustment. A later `reassess_variable_consideration` for a variable or usage component promised before the modification allocates the change to the original obligations when the component and satisfaction path remain identifiable; the already-delivered share catches up in that period. The contract report and `Original promise changes` export sheet trace these amounts by component and obligation. Changes to the variable component as part of the amendment, later changes to its scope or service path, and legacy openings require separate review. An initial period-targeted component at legacy cutover remains unsupported.

For an established contract, the `Opening Positions` sheet links by `contract_id` and stable `source_id`; `Opening Obligations` links by `opening_source_id`. The cutover date is the first day of a month, with one cumulative recognized amount per obligation. Manual satisfaction methods also require a cumulative measure. Supply legacy billed-to-date, contract asset, deferred revenue, source name, and reconciliation rationale. The accepted opening position excludes that contract from earlier reports and initializes future schedules and journal movements. Preview the workbook and tie its opening figures to the legacy close before committing it.

The equivalent `record_opening_position` payload uses `contract_id`, `effective_date`, `source_name`, `rationale`, `billed_to_date`, `contract_asset`, `deferred_revenue`, and `opening_obligations`. Each row in `opening_obligations` has `obligation_id` and `recognized_to_date`, plus `measure` for progress, milestone, point-in-time, or finite-unit usage. Set `cutover_date` on a manually created migrated contract; a workbook with both a new contract and a matching opening row sets it automatically. A declared cutover without its opening position blocks close.

The Commands sheet remains available for expert changes such as policy. Period close, reopen, and scenario lifecycle commands must be performed separately. Every imported row becomes a canonical application command and passes through the same validation as an interactive change. Preview is read-only. Commit requires the preview's file hash and workspace frontier and applies all rows together or none if validation fails.

Column headings must be unique and recognized, and every populated column must have a heading. Formula cells must be replaced with reviewed values. Exports read detail and review sheets from one database snapshot so concurrent commands cannot mix accounting versions within a workbook.

```sh
curl -o commands.xlsx http://127.0.0.1:4318/api/template
curl -F file=@commands.xlsx -F scenario_id=main http://127.0.0.1:4318/api/import/preview
# Review the JSON, then submit the same file with expected_hash and expected_frontier from preview.
curl -F file=@commands.xlsx -F scenario_id=main -F expected_hash=HASH -F expected_frontier=FRONTIER http://127.0.0.1:4318/api/import
curl -o september.xlsx 'http://127.0.0.1:4318/api/export?period=2026-09'
```

## Example contract

After creating a customer, replace `CUSTOMER_ID` with its returned identifier:

```json
{
  "command": "create_contract",
  "scenario_id": "main",
  "payload": {
    "customer_id": "CUSTOMER_ID",
    "name": "Annual subscription",
    "start_date": "2026-01-01",
    "end_date": "2026-12-31",
    "consideration": [
      { "id": "subscription-price", "label": "Annual fee", "kind": "fixed", "amount": "12000.00" }
    ],
    "obligations": [
      { "id": "subscription-service", "name": "Subscription", "kind": "service", "ssp": "12000.00", "method": "exact_days", "start_date": "2026-01-01", "end_date": "2026-12-31" }
    ]
  }
}
```

Record billing separately with `record_billing`, supplying `contract_id`, `effective_date`, `amount`, and a reference. Billing does not by itself satisfy an obligation.

## Python

Use `Application` to open an existing workspace or `Application.create` to create one. Python commands share the UI and HTTP command path:

```python
from openrevrec.application import Application

app = Application.create("Example.orr", name="Example company", currency="USD")
customer = app.execute("create_customer", {"name": "Example customer"})
preview = app.preview("set_policy", {"effective_period": "2026-10", "accounts": {"revenue": "4100"}, "rationale": "Use the revenue account from October."})
state = app.state(period="2026-09")
print(state["report"]["summary"])
```

For pure accounting calculations with no database access, use `openrevrec.domain.calculate(state, period)`. Pass policy, customer, and contract state with the same shapes returned by the API.

`Application.report_bundle(scenario_id, period)` returns `state` and `review` from one read transaction. Use it when generating exports that include both views. Workspace connections are context managers: use `with app.workspace.connect() as db:`; the connection closes when the block exits.

SQL inspection limits results to 1,000 rows, query text to 100,000 bytes, and SQLite string/BLOB/row size to 1,000,000 bytes, in addition to its execution instruction limit. BLOB cells are returned as `{ "hex": "..." }` objects so HTTP and MCP responses remain valid JSON.
