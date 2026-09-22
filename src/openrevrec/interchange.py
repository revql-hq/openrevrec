"""Spreadsheet interchange is an adapter over the same accounting commands."""

from __future__ import annotations

import io
import json
from datetime import date, datetime
from decimal import Decimal

from openpyxl import Workbook, load_workbook
from openpyxl.styles import Font, PatternFill, Alignment

from .workspace import dumps, now

TEMPLATE_VERSION = "1"
SHEETS = {
    "Customers": ["id", "name", "email", "reference"],
    "Contracts": ["id", "customer_id", "name", "start_date", "end_date", "rationale"],
    "Consideration": ["contract_id", "id", "label", "kind", "amount", "included_amount", "potential_amount", "estimated_amount", "estimation_method", "rationale"],
    "Obligations": ["contract_id", "id", "name", "kind", "ssp", "method", "start_date", "end_date", "total_units", "exercise_start", "exercise_end", "rationale"],
    "Billing": ["contract_id", "effective_date", "amount", "reference", "rationale"],
    "Progress": ["contract_id", "obligation_id", "effective_date", "percentage", "rationale"],
    "Usage": ["contract_id", "obligation_id", "effective_date", "quantity", "reference", "rationale"],
    "Milestones": ["contract_id", "obligation_id", "effective_date", "percentage", "rationale"],
    "Adjustments": ["contract_id", "obligation_id", "effective_date", "amount", "rationale"],
    "Reassessments": ["contract_id", "component_id", "effective_date", "included_amount", "rationale"],
    "Notes": ["entity_id", "kind", "body", "due_date"],
    "Commands": ["command", "payload_json"],
}
COMMAND_BY_SHEET = {"Customers": "create_customer", "Billing": "record_billing", "Progress": "record_progress", "Usage": "record_usage", "Milestones": "record_milestone", "Adjustments": "record_adjustment", "Reassessments": "reassess_variable_consideration", "Notes": "add_note"}


def safe_cell(value):
    if isinstance(value, (dict, list)):
        value = dumps(value)
    if isinstance(value, str) and value.startswith(("=", "+", "-", "@")):
        return "'" + value
    return value


def _sheet(book, name, headers, rows=()):
    sheet = book.create_sheet(name)
    sheet.append(headers)
    for row in rows:
        sheet.append([safe_cell(v) for v in row])
    sheet.freeze_panes = "A2"
    sheet.auto_filter.ref = sheet.dimensions
    for cell in sheet[1]:
        cell.font = Font(name="Aptos", bold=True, color="FFFFFF")
        cell.fill = PatternFill("solid", fgColor="303532")
        cell.alignment = Alignment(vertical="center")
    sheet.row_dimensions[1].height = 24
    for column in sheet.columns:
        letter = column[0].column_letter
        length = max((len(str(c.value or "")) for c in column), default=10)
        sheet.column_dimensions[letter].width = min(55, max(16, length + 2))
    return sheet


def template_bytes():
    book = Workbook()
    book.remove(book.active)
    _sheet(book, "Instructions", ["OpenRevRec import template", "Value"], [
        ["Template version", TEMPLATE_VERSION], ["Currency", "Uses workspace currency; decimal amounts, no currency symbols."],
        ["Dates", "YYYY-MM-DD. Service start and end dates are inclusive."],
        ["Relationships", "Supply IDs for customers, contracts, consideration, and obligations; reference these IDs on related sheets."],
        ["Contract setup", "Contracts, Consideration and Obligations are combined into one create_contract command."],
        ["Recognition methods", "exact_days, monthly, point_in_time, progress, usage, milestone"],
        ["Progress", "Cumulative percentage 0–100. Usage quantity is incremental; set total_units on its obligation."],
        ["Consideration kinds", "fixed, variable, usage, credit. Use included_amount for constrained consideration."],
        ["Modifications and policy", "Use Commands with command and payload_json. Any canonical command is supported except close/reopen and scenario lifecycle."],
        ["Import behavior", "All rows validate and commit together. A failed import commits no accounting changes."],
        ["Review", "Always review totals and accounting judgments after import. Amount cells may be numbers or decimal text."],
    ])
    for name, headers in SHEETS.items():
        _sheet(book, name, headers)
    output = io.BytesIO()
    book.save(output)
    return output.getvalue()


def export_bytes(state, review=None):
    report = state["report"]
    book = Workbook()
    book.remove(book.active)
    _sheet(book, "Workspace", ["Field", "Value"], [["Company", state["workspace"]["name"]], ["Workspace ID", state["workspace"]["id"]], ["Currency", state["policy"]["currency"]], ["Period", report["period"]], ["Scenario", state["scenario_id"]], ["Version", state["frontier"]], ["Policy version", report.get("policy_version", state["policy"]["version"])], ["Policy effective period", report.get("policy_effective_period", state["policy"]["effective_period"])], ["Ruleset", "orr-0.1"], ["Engine", "0.1.0"], ["Exported at", now()], ["Accepted close", bool(report.get("closed"))], ["Support metadata", "Evidence recorded after close is shown with its own recorded date; financial values use the accepted checkpoint." if report.get("closed") else "Current accepted workspace state."]])
    _sheet(book, "Summary", ["Measure", "Amount"], [[k.replace("_", " ").capitalize(), Decimal(v)] for k, v in report["summary"].items() if isinstance(v, (str, int))])
    if review:
        _sheet(book, "Close readiness", ["Check", "Status", "Detail", "Exceptions"], [[row["label"], row["status"], row["detail"], row["count"]] for row in review["checks"]])
        money_keys = {"opening_contract_asset", "opening_deferred_revenue", "revenue", "billings", "closing_contract_asset", "closing_deferred_revenue"}
        rollforward_keys = ["contract_id", "contract_name", "opening_contract_asset", "opening_deferred_revenue", "revenue", "billings", "closing_contract_asset", "closing_deferred_revenue"]
        _sheet(book, "Contract rollforward", rollforward_keys, [[Decimal(row[k]) if k in money_keys else row[k] for k in rollforward_keys] for row in review["rollforward"]])
        billing_keys = ["contract_id", "contract_name", "revenue", "billings", "net_movement", "closing_contract_asset", "closing_deferred_revenue"]
        _sheet(book, "Billing vs revenue", billing_keys, [[Decimal(row[k]) if k not in {"contract_id", "contract_name"} else row[k] for k in billing_keys] for row in review["billing_vs_revenue"]])
        coverage_keys = ["contract_id", "contract_name", "remaining_revenue", "future_scheduled", "unscheduled", "status"]
        _sheet(book, "Recognition coverage", coverage_keys, [[Decimal(row[k]) if k in {"remaining_revenue", "future_scheduled", "unscheduled"} else row[k] for k in coverage_keys] for row in review["recognition_coverage"]])
        scenario_keys = ["scenario_id", "name", "base_version", "main_version", "behind", "period_revenue_delta", "transaction_price_delta", "remaining_revenue_delta", "affected_periods"]
        _sheet(book, "Scenario impact", scenario_keys, [[Decimal(row[k]) if k.endswith("_delta") else ", ".join(row[k]) if k == "affected_periods" else row[k] for k in scenario_keys] for row in review["scenario_impacts"]])
    contract_keys = ["id", "name", "customer_id", "transaction_price", "revenue", "recognized_to_date", "billings", "billed_to_date", "deferred_revenue", "contract_asset", "remaining_revenue"]
    sheet = _sheet(book, "Contract balances", contract_keys, [[c.get(k, "") if k in contract_keys[:3] else Decimal(c.get(k, "0")) for k in contract_keys] for c in report["contracts"]])
    for row in sheet.iter_rows(min_row=2, min_col=4):
        for cell in row:
            cell.number_format = '#,##0.00;[Red](#,##0.00);–'
    _sheet(book, "Recognition schedule", ["period", "contract_id", "obligation_id", "revenue"], [[r["period"], r["contract_id"], r["obligation_id"], Decimal(r["revenue"])] for r in report["schedule"]])
    journal_keys = ["period", "contract_id", "account", "account_name", "role", "debit", "credit", "description", "policy_version", "policy_effective_period"]
    _sheet(book, "Journal entries", journal_keys, [[Decimal(r.get(k, "0")) if k in {"debit", "credit"} else report.get(k, "") if k in {"policy_version", "policy_effective_period"} else r.get(k, "") for k in journal_keys] for r in report["journals"]])
    _sheet(book, "Account policy", ["Role", "Account", "Policy version", "Effective period"], [[role, account, report.get("policy_version", state["policy"]["version"]), report.get("policy_effective_period", state["policy"]["effective_period"])] for role, account in report.get("policy_accounts", state["policy"]["accounts"]).items()])
    _sheet(book, "Allocation support", ["contract_id", "obligation_id", "name", "ssp", "amount"], [[c["id"], a["obligation_id"], a["name"], Decimal(a["ssp"]), Decimal(a["amount"])] for c in report["contracts"] for a in c["allocation"]])
    _sheet(book, "Activity", ["version", "change_set_id", "scenario_id", "command", "entity_id", "effective_date", "recorded_at", "rationale", "source", "payload"], [[r.get(k, "") for k in ["version", "id", "scenario_id", "command", "entity_id", "effective_date", "recorded_at", "rationale", "source", "payload"]] for r in reversed(state["change_sets"])])
    entity_names = {row["id"]: row["name"] for row in state["contracts"] + state["customers"]}
    period_end = report["period"] + "-31"
    judgment_commands = {"modify_contract", "reassess_variable_consideration", "record_adjustment", "set_policy", "reopen_period"}
    changes = [row for row in reversed(state["change_sets"]) if row["effective_date"] <= period_end and row["command"] not in {"add_note", "edit_note", "edit_details", "attach_evidence"}]
    evidence_by_change = {}
    for item in state["evidence"]:
        evidence_by_change.setdefault(item.get("target_change_set_id"), []).append(item)
    _sheet(book, "Change lineage", ["Version", "Change set ID", "Scenario", "Command", "Entity", "Entity ID", "Effective date", "Recorded at", "Rationale", "Treatment", "Originating change ID", "Evidence files"],
           [[row["version"], row["id"], row["scenario_id"], row["command"], entity_names.get(row["entity_id"], row["entity_id"]), row["entity_id"], row["effective_date"], row["recorded_at"], row.get("rationale", ""), row["payload"].get("treatment", ""), row.get("originating_change_set_id", ""), ", ".join(item["name"] for item in evidence_by_change.get(row["id"], []))] for row in changes])
    _sheet(book, "Judgment support", ["Change set ID", "Command", "Entity", "Effective date", "Rationale", "Treatment", "Support status", "Evidence IDs", "Evidence files"],
           [[row["id"], row["command"], entity_names.get(row["entity_id"], row["entity_id"]), row["effective_date"], row.get("rationale", ""), row["payload"].get("treatment", ""), "Supported" if evidence_by_change.get(row["id"]) else "Needs support", ", ".join(item["id"] for item in evidence_by_change.get(row["id"], [])), ", ".join(item["name"] for item in evidence_by_change.get(row["id"], []))] for row in changes if row["command"] in judgment_commands])
    _sheet(book, "Evidence index", ["Evidence ID", "File name", "Entity", "Entity ID", "Change set ID", "Obligation ID", "Period close ID", "Recorded at", "Workspace path", "Rationale", "Scenario"],
           [[item["id"], item["name"], entity_names.get(item.get("entity_id"), item.get("entity_id", "")), item.get("entity_id", ""), item.get("target_change_set_id", ""), item.get("obligation_id", ""), item.get("period_close_id", ""), item.get("recorded_at", ""), item["path"], item.get("rationale", ""), item.get("scenario_id", "")] for item in state["evidence"]])
    _sheet(book, "Notes", ["id", "entity_id", "kind", "body", "due_date", "completed"], [[n.get(k, "") for k in ["id", "entity_id", "kind", "body", "due_date", "completed"]] for n in state["notes"]])
    _sheet(book, "Closes", ["period", "status", "frontier", "recorded_at", "rationale"], [[c.get(k, "") for k in ["period", "status", "frontier", "recorded_at", "rationale"]] for c in state["closes"]])
    _sheet(book, "Warnings", ["Accounting review"], [[w] for w in report["warnings"]])
    output = io.BytesIO()
    book.save(output)
    return output.getvalue()


def _value(value):
    if isinstance(value, datetime):
        return value.date().isoformat()
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, (int, float)):
        return str(value)
    return str(value).strip() if value is not None else None


def parse_workbook(data):
    try:
        book = load_workbook(io.BytesIO(data), read_only=True, data_only=False)
    except Exception as exc:
        raise ValueError("This file is not a readable .xlsx workbook.") from exc
    try:
        parsed = {}
        if "Instructions" in book.sheetnames:
            version = book["Instructions"]["B2"].value
            if str(version) != TEMPLATE_VERSION:
                raise ValueError(f"Unsupported template version {version}.")
        for name, headers in SHEETS.items():
            parsed[name] = []
            if name not in book.sheetnames:
                continue
            rows = iter(book[name].iter_rows())
            heading = next(rows, ())
            columns = [str(c.value or "").strip() for c in heading]
            named_columns = [c for c in columns if c]
            if len(named_columns) != len(set(named_columns)):
                raise ValueError(f"{name}: duplicate column headings are not allowed.")
            if any(h not in headers for h in named_columns):
                raise ValueError(f"{name}: unrecognized column. Download the current template.")
            for number, cells in enumerate(rows, 2):
                if all(c.value is None for c in cells):
                    continue
                if any(c.data_type == "f" for c in cells):
                    raise ValueError(f"{name} row {number}: formulas must be replaced with their reviewed values.")
                if any(not key and cell.value is not None for key, cell in zip(columns, cells)):
                    raise ValueError(f"{name} row {number}: every populated column requires a heading.")
                payload = {key: _value(cell.value) for key, cell in zip(columns, cells) if key and cell.value is not None}
                parsed[name].append((number, payload))
        commands = []
        for row, payload in parsed["Customers"]:
            commands.append(("Customers", row, "create_customer", payload))
        contract_ids = {c.get("id") for _, c in parsed["Contracts"]}
        for sheet in ("Consideration", "Obligations"):
            for row, item in parsed[sheet]:
                if item.get("contract_id") not in contract_ids:
                    raise ValueError(f"{sheet} row {row}: terms must reference a contract on the Contracts sheet; use a modification for an existing contract.")
        for row, contract in parsed["Contracts"]:
            for field, sheet in (("consideration", "Consideration"), ("obligations", "Obligations")):
                contract[field] = [{k: v for k, v in p.items() if k != "contract_id"} for _, p in parsed[sheet] if p.get("contract_id") == contract.get("id")]
            commands.append(("Contracts", row, "create_contract", contract))
        for sheet, command in COMMAND_BY_SHEET.items():
            if sheet != "Customers":
                commands.extend((sheet, row, command, p) for row, p in parsed[sheet])
        for row, p in parsed["Commands"]:
            try:
                payload = json.loads(p.get("payload_json", "{}"))
            except json.JSONDecodeError as exc:
                raise ValueError(f"Commands row {row}: payload_json is not valid JSON.") from exc
            if p.get("command") in {"close_period", "reopen_period", "create_scenario", "apply_scenario", "rebase_scenario", "archive_scenario", "restore_scenario"}:
                raise ValueError(f"Commands row {row}: review this workspace operation separately from an import.")
            commands.append(("Commands", row, p.get("command"), payload))
        if not commands:
            raise ValueError("The workbook contains no rows to import.")
        return commands
    finally:
        book.close()


def import_bytes(app, data, filename="import.xlsx", scenario_id="main", period=None):
    commands = parse_workbook(data)
    results = []
    with app.workspace.connect() as db:
        db.execute("BEGIN IMMEDIATE")
        try:
            backup = app.workspace.backup("import")
            for sheet, row, command, payload in commands:
                try:
                    result = app._execute_in(db, command, payload, scenario_id, f"excel:{filename}:v{TEMPLATE_VERSION}:{sheet}:{row}")
                    results.append({"sheet": sheet, "row": row, "status": "accepted", **result})
                except (ValueError, KeyError, TypeError) as exc:
                    raise ValueError(f"{sheet} row {row}: {exc}. No accounting rows were imported.") from exc
            state = app._state(db, scenario_id, period or date.today().strftime("%Y-%m"))
            db.commit()
            return {"result": {"imported": len(results), "rows": results, "template_version": TEMPLATE_VERSION, "backup_path": str(backup)}, "state": state}
        finally:
            if db.in_transaction:
                db.rollback()
