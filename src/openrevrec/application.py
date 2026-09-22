"""Canonical accounting commands shared by desktop, Python, HTTP, Excel and CLI."""

from __future__ import annotations

import copy
import hashlib
import json
import sqlite3
from contextlib import closing
from datetime import date
from decimal import Decimal, InvalidOperation

from . import __version__
from .workspace import Workspace, dumps, identifier, now
from .domain import _date, period_end as domain_period_end

ACTIVITY_TYPES = {
    "record_billing": "billing", "record_progress": "progress", "record_usage": "usage",
    "record_milestone": "milestone", "record_adjustment": "adjustment",
    "modify_contract": "modification", "reassess_variable_consideration": "reassessment",
}
SCENARIO_COMMANDS = {"create_scenario", "apply_scenario", "rebase_scenario", "archive_scenario", "restore_scenario"}
COMMANDS = {"create_customer", "create_contract", "set_policy", "close_period", "reopen_period", "add_note", "edit_note", "edit_details", "attach_evidence"} | set(ACTIVITY_TYPES) | SCENARIO_COMMANDS
DEFAULT_ACCOUNTS = {"revenue": "4000", "deferred_revenue": "2300", "contract_asset": "1200", "billing_clearing": "1100"}


def valid_date(value, label="Effective date") -> str:
    _date(value, label)
    return value


def valid_period(value: str) -> str:
    domain_period_end(value)
    return value


def period_end(period: str) -> str:
    return domain_period_end(period).isoformat()


def decimal_string(value, label="Amount", nonnegative=False) -> str:
    if isinstance(value, (float, bool)):
        raise ValueError(f"{label} must be a decimal string, not floating point.")
    try:
        number = Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError):
        raise ValueError(f"{label} must be a valid decimal number.") from None
    if not number.is_finite() or abs(number) > Decimal("1000000000000"):
        raise ValueError(f"{label} must be a finite amount of at most 1 trillion.")
    if nonnegative and number < 0:
        raise ValueError(f"{label} cannot be negative.")
    return str(number)


def required_text(payload, key):
    value = payload.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{key.replace('_', ' ').capitalize()} is required.")
    return value.strip()


def _calculation(state, period):
    from .domain import calculate
    return calculate(state, period)


def policy_for_period(versions: list[dict], period: str) -> dict:
    """Select the last recorded policy effective on or before a period."""
    applicable = [row for row in versions if row["effective_period"] <= period]
    if not applicable:
        raise ValueError(f"No accounting policy is effective for {period}.")
    return max(applicable, key=lambda row: (row["effective_period"], row["version"]))


def _financial_signature(report):
    """Only accepted period results, not forecasts or display metadata, are locked."""
    keys = ("revenue", "recognized_to_date", "billings", "billed_to_date", "deferred_revenue", "contract_asset", "remaining_revenue", "transaction_price")
    return {
        "summary": {k: report["summary"].get(k, "0.00") for k in keys},
        "contracts": sorted((c["id"], tuple(c.get(k, "0.00") for k in keys)) for c in report["contracts"]),
        "journals": sorted((j["contract_id"], j["account"], j["debit"], j["credit"]) for j in report["journals"]),
        "schedule": sorted((r["contract_id"], r["obligation_id"], r["revenue"])
                           for r in report["schedule"]
                           if r["period"] == report["period"] and Decimal(r["revenue"]) != 0),
    }


class Application:
    """Commands own transactions; projections can always be rebuilt from history."""

    def __init__(self, path):
        self.workspace = Workspace(path)

    @classmethod
    def create(cls, path, name="My company", currency="USD"):
        return cls(Workspace.create(path, name, currency).path)

    def _main_frontier(self, db):
        return db.execute("SELECT coalesce(max(version),0) FROM change_sets WHERE scenario_id='main'").fetchone()[0]

    def _scenario(self, db, scenario_id):
        if not isinstance(scenario_id, str) or not scenario_id.strip():
            raise ValueError("scenario_id must be a nonempty string.")
        row = db.execute("SELECT * FROM scenarios WHERE id=?", (scenario_id,)).fetchone()
        if not row:
            raise ValueError("Scenario was not found.")
        return dict(row)

    def _rows(self, db, scenario_id, frontier=None):
        scenario = self._scenario(db, scenario_id)
        if scenario_id == "main":
            rows = db.execute("SELECT * FROM change_sets WHERE scenario_id='main' AND version<=? ORDER BY version", (frontier if frontier is not None else 2**63 - 1,)).fetchall()
        else:
            base_version = scenario["base_version"]
            if frontier is not None:
                lifecycle = db.execute("SELECT version FROM change_sets WHERE scenario_id=? AND command IN ('create_scenario','rebase_scenario') AND version<=? ORDER BY version DESC LIMIT 1", (scenario_id, frontier)).fetchone()
                if lifecycle:
                    base_version = db.execute("SELECT coalesce(max(version),0) FROM change_sets WHERE scenario_id='main' AND version<?", (lifecycle["version"],)).fetchone()[0]
            rows = db.execute("SELECT * FROM change_sets WHERE ((scenario_id='main' AND version<=?) OR scenario_id=?) AND version<=? ORDER BY version", (base_version, scenario_id, frontier if frontier is not None else 2**63 - 1)).fetchall()
        return [{**dict(r), "payload": json.loads(r["payload"])} for r in rows]

    def _project(self, db, scenario_id="main", frontier=None):
        meta = self.workspace.metadata(db)
        baseline_policy = {"version": 1, "effective_period": "0001-01", "currency": meta["currency"], "rounding": "ROUND_HALF_UP", "ruleset_version": "orr-0.1", "accounts": DEFAULT_ACCOUNTS.copy(), "account_changes": DEFAULT_ACCOUNTS.copy()}
        state = {"workspace": meta, "scenario_id": scenario_id,
                 "policy": baseline_policy, "policy_versions": [baseline_policy],
                 "customers": [], "contracts": [], "notes": [], "evidence": [], "closes": []}
        rows = self._rows(db, scenario_id, frontier)
        customers, contracts, notes, closes = {}, {}, {}, {}
        for row in rows:
            p, command = copy.deepcopy(row["payload"]), row["command"]
            if command == "create_customer":
                customers[p["id"]] = p
            elif command == "create_contract":
                p["activities"] = []
                p["change_set_id"] = row["id"]
                contracts[p["id"]] = p
            elif command in ACTIVITY_TYPES:
                contract = contracts.get(p["contract_id"])
                if contract is None:
                    raise ValueError("History references a missing contract.")
                contract["activities"].append({**p, "id": row["id"], "change_set_id": row["id"], "type": ACTIVITY_TYPES[command], "recorded_at": row["recorded_at"], "effective_date": row["effective_date"]})
            elif command == "set_policy":
                effective_period = p.get("effective_period") or row["effective_date"][:7]
                policy = {**baseline_policy, **{k: v for k, v in p.items() if k in {"currency", "rounding"}},
                          "version": len(state["policy_versions"]) + 1, "effective_period": effective_period,
                          "account_changes": p.get("accounts", {}), "accounts": {},
                          "change_set_id": row["id"], "recorded_at": row["recorded_at"]}
                state["policy_versions"].append(policy)
                if p.get("name"):
                    state["workspace"]["name"] = p["name"]
            elif command == "add_note":
                notes[p["id"]] = {**p, "created_at": row["recorded_at"]}
            elif command == "edit_note" and p["id"] in notes:
                notes[p["id"]].update({k: v for k, v in p.items() if k in {"body", "completed", "due_date"}})
            elif command == "edit_details":
                target = customers.get(p["entity_id"]) or contracts.get(p["entity_id"])
                if target:
                    target.update({k: v for k, v in p.items() if k in {"name", "email", "reference", "description"}})
            elif command == "attach_evidence":
                state["evidence"].append({**p, "recorded_at": row["recorded_at"], "change_set_id": row["id"], "scenario_id": row["scenario_id"]})
            elif command == "close_period":
                closes[p["period"]] = {"id": p["id"], "period": p["period"], "status": "closed", "recorded_at": row["recorded_at"], "frontier": row["version"], "rationale": p.get("rationale", "")}
            elif command == "reopen_period":
                if p["period"] in closes:
                    closes[p["period"]]["status"] = "reopened"
        mapping = {}
        for policy in sorted(state["policy_versions"], key=lambda item: (item["effective_period"], item["version"])):
            mapping.update(policy["account_changes"])
            policy["accounts"] = mapping.copy()
        state["policy"] = policy_for_period(state["policy_versions"], date.today().strftime("%Y-%m"))
        state.update(customers=list(customers.values()), contracts=list(contracts.values()), notes=list(notes.values()), closes=sorted(closes.values(), key=lambda c: c["period"]), change_sets=list(reversed(rows)), frontier=max((r["version"] for r in rows), default=0), scenarios=[dict(r) for r in db.execute("SELECT * FROM scenarios ORDER BY created_at")])
        return state

    def _state(self, db, scenario_id, period, frontier=None):
        state = self._project(db, scenario_id, frontier)
        state["policy"] = policy_for_period(state["policy_versions"], valid_period(period))
        report = _calculation(state, valid_period(period))
        if scenario_id == "main":
            active = {c["id"]: c for c in state["closes"] if c["status"] == "closed"}
            for row in db.execute("SELECT * FROM period_closes WHERE frontier<=? ORDER BY recorded_at", (frontier if frontier is not None else 2**63 - 1,)):
                if row["id"] not in active:
                    continue
                snapshot = json.loads(row["snapshot"])
                # Historical rows and finalized journals come from their accepted checkpoint.
                report["schedule"] = [r for r in report["schedule"] if r["period"] != row["period"]] + [r for r in snapshot["schedule"] if r["period"] == row["period"]]
                report["catch_ups"] = [r for r in report["catch_ups"] if r["period"] != row["period"]] + [r for r in snapshot["catch_ups"] if r["period"] == row["period"]]
                if period == row["period"]:
                    report.update({k: snapshot[k] for k in ("summary", "contracts", "journals", "warnings")})
                    report["closed"] = True
                    report["close_id"] = row["id"]
        report["schedule"].sort(key=lambda r: (r["period"], r["contract_id"], r["obligation_id"]))
        state["report"] = report
        return state

    def state(self, scenario_id="main", period=None):
        with self.workspace.connect() as db:
            db.execute("BEGIN")
            try:
                return self._state(db, scenario_id, period or date.today().strftime("%Y-%m"))
            finally:
                db.rollback()

    def _append(self, db, command, payload, scenario_id, source, idempotency_key=None, request_hash=None, originating_change_set_id=None):
        change_id, recorded_at = identifier("cs"), now()
        entity_id = str(payload.get("contract_id") or payload.get("entity_id") or payload.get("id") or payload.get("scenario_id") or command)
        effective = payload.get("effective_date") or payload.get("start_date") or (payload.get("effective_period", "") + "-01" if payload.get("effective_period") else "") or (payload.get("period", "") + "-01" if payload.get("period") else date.today().isoformat())
        valid_date(effective)
        cursor = db.execute("INSERT INTO change_sets(id,scenario_id,command,entity_id,effective_date,recorded_at,source,rationale,payload,idempotency_key,request_hash,originating_change_set_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", (change_id, scenario_id, command, entity_id, effective, recorded_at, source, payload.get("rationale", ""), dumps(payload), idempotency_key, request_hash, originating_change_set_id))
        db.execute("INSERT INTO events VALUES (?,?,?,?,?,?,?,?)", (identifier("evt"), change_id, scenario_id, entity_id, command, effective, recorded_at, dumps(payload)))
        return {"id": payload.get("id", entity_id), "change_set_id": change_id, "version": cursor.lastrowid, "command": command}

    def _prepare(self, db, command, payload, scenario_id):
        if command not in COMMANDS:
            raise ValueError(f"Unknown command: {command}")
        if not isinstance(payload, dict):
            raise ValueError("Command payload must be an object.")
        p = copy.deepcopy(payload)
        self._validate_fields(p)
        scenario = self._scenario(db, scenario_id)
        if scenario["status"] != "active" and command not in {"restore_scenario", "archive_scenario"}:
            raise ValueError("Restore an archived scenario before changing it. Applied scenarios are read-only.")
        state = self._project(db, scenario_id)
        if command == "create_customer":
            p["id"] = p.get("id") or identifier("cus")
            p["name"] = required_text(p, "name")
            if any(c["id"] == p["id"] for c in state["customers"]):
                raise ValueError("Customer ID already exists.")
        elif command == "create_contract":
            from .domain import validate_contract
            p["id"] = p.get("id") or identifier("con")
            p["name"] = required_text(p, "name")
            if any(c["id"] == p["id"] for c in state["contracts"]):
                raise ValueError("Contract ID already exists.")
            if not any(c["id"] == p.get("customer_id") for c in state["customers"]):
                raise ValueError("Choose an existing customer.")
            valid_date(p.get("start_date"), "Start date")
            valid_date(p.get("end_date"), "End date")
            if p["start_date"] > p["end_date"]:
                raise ValueError("End date must follow start date.")
            if p.get("activities"):
                raise ValueError("Record activity through its accounting command after creating the contract.")
            p.pop("activities", None)
            self._normalize_terms(p)
            validate_contract(p)
        elif command in ACTIVITY_TYPES:
            contract = next((c for c in state["contracts"] if c["id"] == p.get("contract_id")), None)
            if contract is None:
                raise ValueError("Choose an existing contract.")
            valid_date(p.get("effective_date"))
            if command != "record_billing" and p["effective_date"] < contract["start_date"]:
                raise ValueError("Accounting activity cannot precede the contract start date.")
            # New obligations introduced by an effective modification are valid targets.
            obligations = contract["obligations"]
            consideration = contract["consideration"]
            for event in sorted(contract["activities"], key=lambda e: (e["effective_date"], e["recorded_at"])):
                if event["effective_date"] <= p["effective_date"] and event["type"] == "modification":
                    obligations = event.get("obligations", obligations)
                    consideration = event.get("consideration", consideration)
            if command in {"record_progress", "record_usage", "record_milestone", "record_adjustment"}:
                if not any(o["id"] == p.get("obligation_id") for o in obligations):
                    raise ValueError("Choose a performance obligation.")
            if command in {"record_billing", "record_adjustment"}:
                p["amount"] = decimal_string(p.get("amount"))
            if command == "record_adjustment":
                p["rationale"] = required_text(p, "rationale")
            if command in {"record_progress", "record_milestone"}:
                p["percentage"] = decimal_string(p.get("percentage", "100" if command == "record_milestone" else None), "Percentage", True)
                if Decimal(p["percentage"]) > 100:
                    raise ValueError("Cumulative completion must be between 0 and 100.")
            if command == "record_usage":
                p["quantity"] = decimal_string(p.get("quantity"), "Quantity", True)
            if command == "modify_contract":
                p["rationale"] = required_text(p, "rationale")
                if p.get("treatment") not in {"prospective", "catch_up"}:
                    raise ValueError("Choose prospective or catch_up treatment. Separate contracts use create_contract.")
                if "consideration" not in p and "obligations" not in p:
                    raise ValueError("A modification must revise consideration or obligations.")
                self._normalize_terms(p, contract)
                # Full-stream validation below must see prior modifications and
                # satisfaction activity. Recasting this as a new baseline would
                # lose the effective terms and reject a valid termination.
            if command == "reassess_variable_consideration":
                p["rationale"] = required_text(p, "rationale")
                component = next((c for c in consideration if c["id"] == p.get("component_id")), None)
                if component is None or component["kind"] not in {"variable", "usage"}:
                    raise ValueError("Choose a variable or usage consideration component.")
                p["included_amount"] = decimal_string(p.get("included_amount"), "Included amount", True)
        elif command == "set_policy":
            p["rationale"] = p.get("rationale") or "Company policy setup"
            p["effective_period"] = valid_period(p.get("effective_period") or date.today().strftime("%Y-%m"))
            if "name" in p:
                p["name"] = required_text(p, "name")
            current_policy = policy_for_period(state["policy_versions"], p["effective_period"])
            if p.get("currency", current_policy["currency"]) != current_policy["currency"]:
                raise ValueError("Workspace currency is fixed. Create a separate workspace for another currency.")
            if p.get("rounding", "ROUND_HALF_UP") != "ROUND_HALF_UP":
                raise ValueError("The prototype supports ROUND_HALF_UP posting only.")
            if "accounts" in p:
                if not isinstance(p["accounts"], dict):
                    raise ValueError("Account mappings must be an object.")
                if p["accounts"].keys() - current_policy["accounts"].keys():
                    raise ValueError("Unknown journal account role.")
                if any(not isinstance(v, str) or not v.strip() for v in p["accounts"].values()):
                    raise ValueError("Every account mapping needs an account code.")
            else:
                p["accounts"] = {}
            latest_closed = max((c["period"] for c in state["closes"] if c["status"] == "closed"), default=None)
            if latest_closed and p["effective_period"] <= latest_closed and {**current_policy["accounts"], **p["accounts"]} != current_policy["accounts"]:
                raise ValueError(f"Account mappings effective {p['effective_period']} would affect closed period {latest_closed}; reopen it before changing policy.")
        elif command == "add_note":
            p["id"] = p.get("id") or identifier("note")
            if any(n["id"] == p["id"] for n in state["notes"]):
                raise ValueError("Note ID already exists.")
            p["body"] = required_text(p, "body")
            p["kind"] = p.get("kind", "note")
            if p["kind"] not in {"note", "memo", "task"}:
                raise ValueError("Note kind must be note, memo, or task.")
            p["completed"] = False
            if p.get("due_date"):
                valid_date(p["due_date"], "Due date")
        elif command == "edit_note":
            if not any(n["id"] == p.get("id") for n in state["notes"]):
                raise ValueError("Note was not found.")
            if "completed" in p and not isinstance(p["completed"], bool):
                raise ValueError("Completed must be true or false.")
            if "body" in p:
                p["body"] = required_text(p, "body")
            if p.get("due_date"):
                valid_date(p["due_date"], "Due date")
        elif command == "edit_details":
            if not any(c["id"] == p.get("entity_id") for c in state["customers"] + state["contracts"]):
                raise ValueError("Customer or contract was not found.")
            if set(p) - {"entity_id", "name", "email", "reference", "description"}:
                raise ValueError("Accounting terms require an accounting change.")
            if "name" in p:
                p["name"] = required_text(p, "name")
        elif command == "attach_evidence":
            p["id"] = p.get("id") or identifier("doc")
            if any(e["id"] == p["id"] for e in state["evidence"]):
                raise ValueError("Evidence ID already exists.")
            required_text(p, "name")
            required_text(p, "path")
            self.workspace.evidence_path(p["path"])
            if p.get("target_change_set_id"):
                target = db.execute("SELECT scenario_id, entity_id FROM change_sets WHERE id=?", (p["target_change_set_id"],)).fetchone()
                if target is None or target["scenario_id"] not in {scenario_id, "main"}:
                    raise ValueError("Linked change set was not found in this scenario.")
                if p.get("entity_id") and p["entity_id"] != target["entity_id"]:
                    raise ValueError("Evidence entity does not match the linked change set.")
            if p.get("obligation_id") and not any(p["obligation_id"] == o["id"] for c in state["contracts"] for o in c["obligations"] + [o for activity in c["activities"] for o in activity.get("obligations", [])]):
                raise ValueError("Linked obligation was not found.")
            if p.get("period_close_id") and not db.execute("SELECT 1 FROM period_closes WHERE id=?", (p["period_close_id"],)).fetchone():
                raise ValueError("Linked period close was not found.")
        elif command in {"close_period", "reopen_period"}:
            if scenario_id != "main":
                raise ValueError("Close and reopen are available only on Main.")
            valid_period(p.get("period"))
            active = [c for c in state["closes"] if c["status"] == "closed"]
            if command == "close_period":
                if not state["contracts"]:
                    raise ValueError("Create a contract before closing a period.")
                if any(c["period"] >= p["period"] for c in active):
                    raise ValueError("Close periods in chronological order. This period or a later one is already closed.")
                if active:
                    latest = max(c["period"] for c in active)
                    year, month = map(int, latest.split("-"))
                    following = f"{year + (month == 12):04d}-{1 if month == 12 else month + 1:02d}"
                    if p["period"] != following:
                        raise ValueError(f"Close {following} before later periods.")
                p["id"] = identifier("close")
            else:
                p["rationale"] = required_text(p, "rationale")
                if not active or p["period"] != max(c["period"] for c in active):
                    raise ValueError("Reopen the latest closed period first to preserve checkpoint order.")
        return p

    @staticmethod
    def _validate_fields(payload):
        """Reject malformed shared fields before they enter immutable history."""
        for key in ("id", "contract_id", "customer_id", "obligation_id", "component_id", "scenario_id", "target_change_set_id", "period_close_id"):
            if key in payload and (not isinstance(payload[key], str) or not payload[key].strip()):
                raise ValueError(f"{key} must be a nonempty string.")
        for key in ("name", "email", "reference", "description", "rationale", "body", "kind", "label", "method", "treatment", "path"):
            if key in payload and not isinstance(payload[key], str):
                raise ValueError(f"{key} must be text.")
        if payload.get("entity_id") is not None and (not isinstance(payload["entity_id"], str) or not payload["entity_id"].strip()):
            raise ValueError("entity_id must be a nonempty string.")
        if payload.get("due_date") not in (None, ""):
            valid_date(payload["due_date"], "Due date")

    def _normalize_terms(self, payload, contract=None):
        for key, prefix in (("consideration", "price"), ("obligations", "pob")):
            if key not in payload:
                continue
            if not isinstance(payload[key], list) or (not payload[key] and contract is None):
                raise ValueError(f"At least one {key} entry is required.")
            ids = set()
            for item in payload[key]:
                if not isinstance(item, dict):
                    raise ValueError(f"Each {key} entry must be an object.")
                self._validate_fields(item)
                item["id"] = item.get("id") or identifier(prefix)
                if item["id"] in ids:
                    raise ValueError(f"Duplicate {key} ID.")
                ids.add(item["id"])
                if key == "consideration":
                    item["kind"] = item.get("kind", "fixed")
                    item["label"] = item.get("label") or item["kind"].capitalize()
                    item["amount"] = decimal_string(item.get("amount", "0"))
                    for field in ("included_amount", "potential_amount", "estimated_amount"):
                        if item.get(field) not in (None, ""):
                            item[field] = decimal_string(item[field], field.replace("_", " "))
                        else:
                            item.pop(field, None)
                else:
                    item["name"] = required_text(item, "name")
                    item["ssp"] = decimal_string(item.get("ssp"), "SSP", True)
                    item["kind"] = item.get("kind", "service")
                    item["method"] = item.get("method", "exact_days")
                    for field in ("start_date", "end_date"):
                        item[field] = item.get(field) or payload.get(field) or (contract or {}).get(field)
                        valid_date(item[field], field.replace("_", " ").capitalize())
                    if item.get("total_units") not in (None, ""):
                        item["total_units"] = decimal_string(item["total_units"], "Total units", True)
                    for field in ("exercise_start", "exercise_end"):
                        if item.get(field) in (None, ""):
                            item.pop(field, None)
                        else:
                            valid_date(item[field], field)

    def _validate_closed(self, db, before, after):
        for close in before["closes"]:
            if close["status"] != "closed":
                continue
            cutoff = period_end(close["period"])
            existing = {c["id"] for c in before["contracts"]}
            # A new contract wholly after this checkpoint is future business.
            # Do not let its lifetime price prevent the next month's onboarding.
            comparable = {**after, "contracts": [c for c in after["contracts"] if
                c["id"] in existing or c["start_date"] <= cutoff
                or any(o["start_date"] <= cutoff for o in c["obligations"])
                or any(a["effective_date"] <= cutoff for a in c["activities"])]}
            if _financial_signature(_calculation(before, close["period"])) != _financial_signature(_calculation(comparable, close["period"])):
                raise ValueError(f"This change affects closed period {close['period']}. Model it in a scenario, then explicitly reopen before applying.")

    def _execute_in(self, db, command, payload, scenario_id, source, idempotency_key=None, request_hash=None, backup_path=None, originating_change_set_id=None):
        if not isinstance(command, str) or command not in COMMANDS:
            raise ValueError(f"Unknown command: {command}")
        if not isinstance(payload, dict):
            raise ValueError("Command payload must be an object.")
        if not isinstance(scenario_id, str) or not scenario_id.strip():
            raise ValueError("scenario_id must be a nonempty string.")
        if idempotency_key is not None and (not isinstance(idempotency_key, str) or not idempotency_key.strip()):
            raise ValueError("idempotency_key must be a nonempty string.")
        if command in SCENARIO_COMMANDS:
            return self._scenario_command(db, command, payload, source, idempotency_key, request_hash)
        before = self._project(db, scenario_id)
        p = self._prepare(db, command, payload, scenario_id)
        result = self._append(db, command, p, scenario_id, source, idempotency_key, request_hash, originating_change_set_id)
        after = self._project(db, scenario_id)
        if command in ACTIVITY_TYPES or command in {"create_contract", "set_policy"}:
            # Full replay validates progress, allocation, usage and amendments together.
            _calculation(after, p.get("effective_date", p.get("start_date", date.today().isoformat()))[:7])
            if scenario_id == "main":
                self._validate_closed(db, before, after)
        if command == "close_period":
            snapshot = _calculation(before, p["period"])
            debit = sum(j["debit_minor"] for j in snapshot["journals"])
            credit = sum(j["credit_minor"] for j in snapshot["journals"])
            if debit != credit:
                raise ValueError("Journal does not balance; this period cannot close.")
            accepted_policy = policy_for_period(before["policy_versions"], p["period"])
            db.execute("INSERT INTO period_closes VALUES (?,?,?,?,?,?,?,?,?,?)", (p["id"], p["period"], result["change_set_id"], result["version"], accepted_policy["version"], "orr-0.1", __version__, now(), dumps(snapshot), str(backup_path or "preview")))
            result["backup_path"] = str(backup_path or "preview")
        return result

    def _scenario_command(self, db, command, payload, source, idempotency_key, request_hash):
        p = copy.deepcopy(payload)
        self._validate_fields(p)
        if command == "create_scenario":
            p["name"] = required_text(p, "name")
            sid = p["id"] = p.get("id") or identifier("scn")
            if sid == "main":
                raise ValueError("Main is reserved for accepted accounting.")
            db.execute("INSERT INTO scenarios VALUES (?,?, 'active', ?,?)", (sid, p["name"], self._main_frontier(db), now()))
            return self._append(db, command, p, sid, source, idempotency_key, request_hash)
        sid = p.get("scenario_id") or p.get("id")
        if not sid or sid == "main":
            raise ValueError("Choose a working scenario, not Main.")
        scenario = self._scenario(db, sid)
        if command == "restore_scenario":
            if scenario["status"] != "archived":
                raise ValueError("Only archived scenarios can be restored.")
            db.execute("UPDATE scenarios SET status='active' WHERE id=?", (sid,))
        elif command == "archive_scenario":
            if scenario["status"] != "active":
                raise ValueError("Only active scenarios can be archived.")
            db.execute("UPDATE scenarios SET status='archived' WHERE id=?", (sid,))
        elif command in {"apply_scenario", "rebase_scenario"}:
            if scenario["status"] != "active":
                raise ValueError("Only active scenarios can be applied or rebased.")
            current = self._main_frontier(db)
            own = [r for r in self._rows(db, sid) if r["scenario_id"] == sid and r["command"] not in SCENARIO_COMMANDS]
            if command == "rebase_scenario":
                changed = {r[0] for r in db.execute("SELECT entity_id FROM change_sets WHERE scenario_id='main' AND version>?", (scenario["base_version"],))}
                touched = {r["entity_id"] for r in own}
                if changed & touched or ("set_policy" in changed and own):
                    raise ValueError("Main changed the same accounting records. Create a new scenario from Main and review these proposals again.")
                db.execute("UPDATE scenarios SET base_version=? WHERE id=?", (current, sid))
                _calculation(self._project(db, sid), date.today().strftime("%Y-%m"))
            else:
                if current != scenario["base_version"]:
                    raise ValueError("Main has advanced. Rebase this scenario and review the comparison before applying.")
                if not own:
                    raise ValueError("There are no proposed changes to apply.")
                copied_change_ids = {}
                for row in own:
                    copied_payload = copy.deepcopy(row["payload"])
                    if row["command"] == "attach_evidence" and copied_payload.get("target_change_set_id") in copied_change_ids:
                        copied_payload["target_change_set_id"] = copied_change_ids[copied_payload["target_change_set_id"]]
                    accepted = self._execute_in(db, row["command"], copied_payload, "main", f"scenario:{sid}", originating_change_set_id=row["id"])
                    copied_change_ids[row["id"]] = accepted["change_set_id"]
                db.execute("UPDATE scenarios SET status='applied' WHERE id=?", (sid,))
        p["scenario_id"] = sid
        result = self._append(db, command, p, sid, source, idempotency_key, request_hash)
        result["scenario_id"] = sid
        return result

    def execute(self, command, payload, scenario_id="main", idempotency_key=None, period=None, source="python"):
        if not isinstance(command, str) or command not in COMMANDS:
            raise ValueError(f"Unknown command: {command}")
        if not isinstance(scenario_id, str) or not scenario_id.strip():
            raise ValueError("scenario_id must be a nonempty string.")
        if idempotency_key is not None and (not isinstance(idempotency_key, str) or not idempotency_key.strip()):
            raise ValueError("idempotency_key must be a nonempty string.")
        period = valid_period(period or date.today().strftime("%Y-%m"))
        request_hash = hashlib.sha256(dumps({"command": command, "payload": payload, "scenario_id": scenario_id}).encode()).hexdigest()
        with self.workspace.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            try:
                if idempotency_key:
                    existing = db.execute("SELECT * FROM change_sets WHERE idempotency_key=?", (idempotency_key,)).fetchone()
                    if existing:
                        if existing["request_hash"] != request_hash:
                            raise ValueError("This idempotency key was already used for different input.")
                        return_scenario = "main" if command in {"apply_scenario", "archive_scenario"} else scenario_id
                        return {"result": {"change_set_id": existing["id"], "version": existing["version"], "id": existing["entity_id"], "replayed": True}, "state": self._state(db, return_scenario, period)}
                # Reserve the writer before backing up, but do not write yet:
                # a separate read connection can copy the committed database.
                backup = self.workspace.backup(command) if command in {"close_period", "reopen_period"} else None
                result = self._execute_in(db, command, payload, scenario_id, source, idempotency_key, request_hash, backup)
                return_scenario = "main" if command in {"apply_scenario", "archive_scenario"} else scenario_id
                state = self._state(db, return_scenario, period)
                db.commit()
                return {"result": result, "state": state}
            except (sqlite3.IntegrityError, sqlite3.OperationalError) as exc:
                db.rollback()
                raise ValueError(f"Workspace operation failed: {exc}") from exc
            finally:
                if db.in_transaction:
                    db.rollback()

    def preview(self, command, payload, scenario_id="main", period=None, **_):
        period = valid_period(period or date.today().strftime("%Y-%m"))
        with self.workspace.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            try:
                target = "main" if command == "apply_scenario" else scenario_id
                if command == "rebase_scenario" and isinstance(payload, dict):
                    target = payload.get("scenario_id") or payload.get("id") or scenario_id
                before = self._state(db, target, period)
                self._execute_in(db, command, payload, scenario_id, "preview")
                after = self._state(db, target, period)
                return {"before": before["report"], "state": after, "comparison": compare_reports(before["report"], after["report"])}
            except (sqlite3.IntegrityError, sqlite3.OperationalError) as exc:
                raise ValueError(f"Workspace operation failed: {exc}") from exc
            finally:
                db.rollback()

    def compare(self, scenario_id, period=None):
        period = valid_period(period or date.today().strftime("%Y-%m"))
        with self.workspace.connect() as db:
            db.execute("BEGIN")
            try:
                main = self._state(db, "main", period)
                scenario = self._state(db, scenario_id, period)
                return {**compare_reports(main["report"], scenario["report"]), "scenario_id": scenario_id, "base_version": self._scenario(db, scenario_id)["base_version"], "main_version": self._main_frontier(db)}
            finally:
                db.rollback()

    def change_detail(self, change_set_id, period=None):
        """Rebuild a change's before and after views from immutable history."""
        if not isinstance(change_set_id, str) or not change_set_id.strip():
            raise ValueError("Choose a change set.")
        with self.workspace.connect() as db:
            db.execute("BEGIN")
            try:
                raw = db.execute("SELECT * FROM change_sets WHERE id=?", (change_set_id,)).fetchone()
                if raw is None:
                    raise ValueError("Change set was not found.")
                change = {**dict(raw), "payload": json.loads(raw["payload"])}
                selected_period = valid_period(period or change["effective_date"][:7])
                scenario_id, before_frontier, after_frontier = change["scenario_id"], change["version"] - 1, change["version"]
                if change["command"] == "apply_scenario":
                    copied = db.execute("SELECT min(version), max(version) FROM change_sets WHERE source=? AND version<?", (f"scenario:{scenario_id}", change["version"])).fetchone()
                    if copied[0] is not None:
                        scenario_id, before_frontier, after_frontier = "main", copied[0] - 1, copied[1]
                before = self._state(db, scenario_id, selected_period, before_frontier)
                after = self._state(db, scenario_id, selected_period, after_frontier)
                comparison = compare_reports(before["report"], after["report"])
                if before["report"]["journals"] != after["report"]["journals"] and selected_period not in comparison["affected_periods"]:
                    comparison["affected_periods"].append(selected_period)
                    comparison["affected_periods"].sort()
                entities = {item["id"]: item["name"] for item in after["customers"] + after["contracts"]}
                entities.update({item["id"]: item["name"] for item in before["customers"] + before["contracts"] if item["id"] not in entities})
                change["entity_name"] = entities.get(change["entity_id"], next((item["name"] for item in after["scenarios"] if item["id"] == change["entity_id"]), change["entity_id"]))
                return {"change": change, "period": selected_period, "before_report": before["report"], "after_report": after["report"],
                        "before_state": before, "after_state": after,
                        "before_policy": before["policy"], "after_policy": after["policy"], "comparison": comparison,
                        "evidence": [item for item in self._project(db, change["scenario_id"])["evidence"] if item.get("target_change_set_id") == change_set_id]}
            finally:
                db.rollback()

    def reports(self, scenario_id="main", period=None):
        """Return close-oriented views built from the same accepted projection."""
        return self.report_bundle(scenario_id, period)["review"]

    def report_bundle(self, scenario_id="main", period=None):
        """Read detail and review reports from one database snapshot for export."""
        from .reporting import build_review

        period = valid_period(period or date.today().strftime("%Y-%m"))
        with self.workspace.connect() as db:
            db.execute("BEGIN")
            try:
                state = self._state(db, scenario_id, period)
                main = state if scenario_id == "main" else self._state(db, "main", period)
                main_version = self._main_frontier(db)
                impacts = []
                for scenario in state["scenarios"]:
                    if scenario["id"] == "main" or scenario["status"] != "active":
                        continue
                    proposed = self._state(db, scenario["id"], period)
                    comparison = compare_reports(main["report"], proposed["report"])
                    impacts.append({
                        "scenario_id": scenario["id"], "name": scenario["name"],
                        "base_version": scenario["base_version"], "main_version": main_version,
                        "behind": main_version > scenario["base_version"],
                        "period_revenue_delta": comparison["summary"]["revenue"],
                        "transaction_price_delta": comparison["summary"]["transaction_price"],
                        "remaining_revenue_delta": comparison["summary"]["remaining_revenue"],
                        "affected_periods": comparison["affected_periods"],
                    })
                return {"state": state, "review": build_review(state, impacts)}
            finally:
                db.rollback()

    def query(self, query):
        if not isinstance(query, str) or not query.strip():
            raise ValueError("Enter a SELECT query.")
        uri = self.workspace.db_path.as_uri() + "?mode=ro"
        with closing(sqlite3.connect(uri, uri=True)) as db:
            db.execute("PRAGMA query_only=ON")
            # VM instruction limits alone do not bound a single huge BLOB/string.
            db.setlimit(sqlite3.SQLITE_LIMIT_LENGTH, 1_000_000)
            db.setlimit(sqlite3.SQLITE_LIMIT_SQL_LENGTH, 100_000)
            # Bound expensive recursive queries and disallow file/extension operations.
            ticks = [0]
            def progress():
                ticks[0] += 1
                return ticks[0] > 1000
            db.set_progress_handler(progress, 1000)
            def authorizer(action, arg1, arg2, *_):
                if action in {sqlite3.SQLITE_ATTACH, sqlite3.SQLITE_DETACH, sqlite3.SQLITE_PRAGMA} or (action == sqlite3.SQLITE_FUNCTION and arg2 == "load_extension"):
                    return sqlite3.SQLITE_DENY
                return sqlite3.SQLITE_OK
            db.set_authorizer(authorizer)
            try:
                cursor = db.execute(query)
                rows = cursor.fetchmany(1001)
                return {"columns": [c[0] for c in cursor.description or []], "rows": [[{"hex": v.hex()} if isinstance(v, bytes) else v for v in r] for r in rows[:1000]], "truncated": len(rows) > 1000}
            except sqlite3.Error as exc:
                raise ValueError(f"SQL query failed: {exc}") from exc


def compare_reports(main, proposed):
    main_by_period, scenario_by_period = {}, {}
    for report, values in ((main, main_by_period), (proposed, scenario_by_period)):
        for row in report["schedule"]:
            values[row["period"]] = values.get(row["period"], Decimal(0)) + Decimal(row["revenue"])
    rows = [{"period": p, "main_revenue": f"{main_by_period.get(p, Decimal(0)):.2f}", "scenario_revenue": f"{scenario_by_period.get(p, Decimal(0)):.2f}", "delta": f"{scenario_by_period.get(p, Decimal(0)) - main_by_period.get(p, Decimal(0)):.2f}"} for p in sorted(main_by_period.keys() | scenario_by_period.keys())]
    return {"rows": rows, "summary": {k: f"{Decimal(proposed['summary'].get(k, '0')) - Decimal(main['summary'].get(k, '0')):.2f}" for k in ("revenue", "deferred_revenue", "contract_asset", "remaining_revenue", "transaction_price", "billings")}, "main": main["summary"], "scenario": proposed["summary"], "journals": {"main": main["journals"], "scenario": proposed["journals"]}, "affected_periods": [r["period"] for r in rows if Decimal(r["delta"]) != 0]}
