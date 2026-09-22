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

The response includes the workspace, policy selected for the requested period, `policy_versions`, customers, contracts, scenarios, change sets, closes, notes, evidence, and calculated report. Account mappings have an `effective_period`; currency and rounding remain fixed for the workspace. Monetary values are decimal strings; journals also contain integer minor-unit amounts.

## Record a command

```sh
curl http://127.0.0.1:4318/api/commands \
  -H 'Content-Type: application/json' \
  -d '{"command":"create_customer","payload":{"name":"Example customer"},"scenario_id":"main","idempotency_key":"customer-example-1"}'
```

The response contains `{ "result": ..., "state": ... }`. An idempotency key permits a client to retry the same request without duplicating the accepted change.

Command names include:

- `create_customer`, `create_contract`, `edit_details`
- `record_billing`, `record_usage`, `record_progress`, `record_milestone`, `record_adjustment`
- `modify_contract`, `reassess_variable_consideration`, `set_policy`
- `create_scenario`, `apply_scenario`, `rebase_scenario`, `archive_scenario`, `restore_scenario`
- `close_period`, `reopen_period`, `add_note`, `attach_evidence`

`POST /api/preview` accepts the same command envelope and returns `{ "before": ..., "state": ..., "comparison": ... }` without persisting the change. `before` is the report being changed. Applying a scenario previews Main before and after acceptance, even when the request originates inside the scenario. Rebasing previews the target scenario. Use the returned `before` report for the financial comparison rather than the report currently displayed by the caller.

`set_policy` accepts `effective_period` in `YYYY-MM` form with an `accounts` mapping. A mapping effective in October changes October and later journals while an earlier period retains its prior mapping. A change affecting an accepted closed period requires that period to be reopened first.

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
| `GET /api/template` | Excel import workbook with data-entry sheets and a Commands sheet |
| `POST /api/import` | Import a workbook using multipart `file` and `scenario_id` |
| `POST /api/evidence` | Attach a multipart `file` with optional `entity_id`, `target_change_set_id`, `obligation_id`, `period_close_id`, and `rationale` |
| `GET /api/evidence/ID` | Download linked evidence |
| `GET /api/search?q=subscription` | Workspace search |
| `POST /api/sql` | Read-only SQL; body `{ "query": "SELECT ..." }` |
| `POST /api/demo` | Load five example contracts into an empty workspace |

The reports response includes close checks with semantic `target` values and exact `exceptions`, a contract asset and deferred revenue rollforward, billing versus recognition timing, future recognition coverage, and active scenario impacts. Judgment support is checked by change-set ID; a file elsewhere on the same contract does not clear an unsupported judgment. The Excel export includes these views, account policy, change lineage, judgment support, an evidence index, and detailed accounting support. Closed-period financial values come from the accepted checkpoint; the evidence index retains each attachment's later recorded date.

Download the import template from the application or `/api/template`. It includes sheets for customers, contracts, consideration, obligations, billing, progress, usage, milestones, adjustments, reassessments, and notes. Supply stable IDs to connect records across sheets. Contract, consideration, and obligation rows are combined into one contract baseline.

The Commands sheet accepts `command` and `payload_json` for changes such as modifications and policy. Period close, reopen, and scenario lifecycle commands must be performed separately. Every imported row becomes a canonical application command and passes through the same validation as an interactive change. An import commits all its accounting changes together or none if validation fails.

Column headings must be unique and recognized, and every populated column must have a heading. Formula cells must be replaced with reviewed values. Exports read detail and review sheets from one database snapshot so concurrent commands cannot mix accounting versions within a workbook.

```sh
curl -o commands.xlsx http://127.0.0.1:4318/api/template
curl -F file=@commands.xlsx -F scenario_id=main http://127.0.0.1:4318/api/import
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
