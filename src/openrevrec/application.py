"""Canonical accounting commands shared by desktop, Python, HTTP, Excel and CLI."""

from __future__ import annotations

import copy
import hashlib
import json
import re
import sqlite3
from contextlib import closing
from datetime import date
from decimal import Decimal, InvalidOperation

from . import __version__
from .workspace import Workspace, dumps, identifier, now
from .domain import _date, _price, _resolved_account, _resolved_dimensions, period_end as domain_period_end

ACTIVITY_TYPES = {
    "record_billing": "billing", "record_progress": "progress", "record_usage": "usage",
    "record_milestone": "milestone", "record_adjustment": "adjustment",
    "record_rate_change": "rate_change",
    "modify_contract": "modification", "reassess_variable_consideration": "reassessment",
    "record_opening_position": "opening_position",
    "record_right_exercise": "right_exercise",
}
SCENARIO_COMMANDS = {"create_scenario", "apply_scenario", "rebase_scenario", "archive_scenario", "restore_scenario"}
CORRECTABLE_COMMANDS = {"record_billing", "record_progress", "record_usage", "record_milestone", "record_rate_change"}
JUDGMENT_COMMANDS = {"create_contract", "record_opening_position", "record_right_exercise", "link_renewal_contract", "modify_contract", "reassess_variable_consideration", "record_adjustment", "record_rate_change", "set_policy", "reopen_period"}
COMMANDS = {"create_customer", "create_contract", "link_renewal_contract", "set_policy", "record_control_totals", "record_population_manifest", "record_export_posting", "record_term_review", "close_period", "reopen_period", "add_note", "edit_note", "edit_details", "attach_evidence", "record_judgment_review", "correct_activity"} | set(ACTIVITY_TYPES) | SCENARIO_COMMANDS
DEFAULT_ACCOUNTS = {"revenue": "4000", "deferred_revenue": "2300", "contract_asset": "1200", "billing_clearing": "1100"}
DESCRIPTIVE_COMMANDS = {"edit_details", "add_note", "edit_note", "attach_evidence", "record_judgment_review"}


def _independent_invoices(left: dict, right: dict) -> bool:
    """Two identified positive invoices add independently to a contract balance."""
    if left["command"] != "record_billing" or right["command"] != "record_billing":
        return False
    a, b = left["payload"], right["payload"]
    if Decimal(a["amount"]) <= 0 or Decimal(b["amount"]) <= 0:
        return False
    for field in ("reference", "import_source_identity"):
        if a.get(field) and b.get(field):
            if a[field] == b[field]:
                return False
    return any(a.get(field) and b.get(field) for field in ("reference", "import_source_identity"))


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


def term_assessment_at(state: dict, contract: dict, effective_date: str) -> dict:
    """Resolve the dated term assessment and any later documented unchanged review."""
    fields = ("term_basis", "term_assessment_rationale", "term_reassessment_trigger", "term_review_date")
    assessment = {field: contract.get(field, "") for field in fields}
    assessment["term_basis"] = assessment["term_basis"] or "fixed"
    assessment_version = contract.get("version", 0)
    assessment_date = contract["start_date"]
    changes = sorted((activity for activity in contract["activities"] if activity["type"] == "modification" and activity["effective_date"] <= effective_date), key=lambda item: (item["effective_date"], item.get("version", 0)))
    for activity in changes:
        if not any(field in activity for field in fields):
            continue
        if activity.get("term_basis") == "fixed":
            assessment = {field: "" for field in fields}
            assessment["term_basis"] = "fixed"
        assessment.update({field: activity[field] for field in fields if field in activity})
        assessment_version = activity.get("version", 0)
        assessment_date = activity["effective_date"]
    reviews = [review for review in state.get("term_reviews", []) if review["contract_id"] == contract["id"] and assessment_date <= review["effective_date"] <= effective_date and review["version"] > assessment_version]
    latest_review = max(reviews, key=lambda item: (item["effective_date"], item["version"]), default=None)
    if latest_review:
        assessment["term_review_date"] = latest_review["next_review_date"]
    return {**assessment, "assessment_version": assessment_version, "latest_review": latest_review}


def _financial_signature(report):
    """Only accepted period results, not forecasts or display metadata, are locked."""
    keys = ("revenue", "recognized_to_date", "billings", "billed_to_date", "deferred_revenue", "contract_asset", "remaining_revenue", "transaction_price")
    return {
        "summary": {k: report["summary"].get(k, "0.00") for k in keys},
        "contracts": sorted((c["id"], tuple(c.get(k, "0.00") for k in keys)) for c in report["contracts"]),
        "journals": sorted((j["contract_id"], j["account"], tuple(sorted(j.get("dimensions", {}).items())), j["debit"], j["credit"]) for j in report["journals"]),
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
        baseline_policy = {"version": 1, "effective_period": "0001-01", "currency": meta["currency"], "rounding": "ROUND_HALF_UP", "ruleset_version": "orr-0.1", "accounts": DEFAULT_ACCOUNTS.copy(), "account_changes": DEFAULT_ACCOUNTS.copy(), "account_overrides": {"contracts": {}, "obligations": {}}, "override_changes": {}, "account_profiles": {}, "profile_changes": {}, "profile_assignments": {}, "profile_assignment_changes": {}, "obligation_profile_assignments": {}, "obligation_profile_assignment_changes": {}, "account_dimension_rules": [], "account_dimension_source": ""}
        state = {"workspace": meta, "scenario_id": scenario_id,
                 "policy": baseline_policy, "policy_versions": [baseline_policy],
                 "customers": [], "contracts": [], "renewal_links": [], "notes": [], "evidence": [], "judgment_reviews": [], "term_reviews": [], "closes": [], "controls": [], "population_manifests": [], "postings": []}
        rows = self._rows(db, scenario_id, frontier)
        customers, contracts, notes, closes = {}, {}, {}, {}
        for row in rows:
            p, command = copy.deepcopy(row["payload"]), row["command"]
            if command == "create_customer":
                customers[p["id"]] = p
            elif command == "create_contract":
                p["activities"] = []
                p["change_set_id"] = row["id"]
                p["version"] = row["version"]
                contracts[p["id"]] = p
            elif command in ACTIVITY_TYPES:
                contract = contracts.get(p["contract_id"])
                if contract is None:
                    raise ValueError("History references a missing contract.")
                contract["activities"].append({**p, "id": row["id"], "change_set_id": row["id"], "version": row["version"], "type": ACTIVITY_TYPES[command], "recorded_at": row["recorded_at"], "effective_date": row["effective_date"]})
            elif command == "link_renewal_contract":
                state["renewal_links"].append({**p, "change_set_id": row["id"], "recorded_at": row["recorded_at"], "scenario_id": row["scenario_id"]})
            elif command == "correct_activity":
                contract = contracts.get(p["contract_id"])
                if contract is None:
                    raise ValueError("Correction references a missing contract.")
                for index, activity in enumerate(contract["activities"]):
                    if activity["id"] == p["target_change_set_id"]:
                        contract["activities"][index] = {**p["replacement"], "id": row["id"], "change_set_id": row["id"], "type": activity["type"], "corrects": activity["id"], "recorded_at": activity["recorded_at"], "correction_recorded_at": row["recorded_at"]}
                        break
                else:
                    raise ValueError("Correction references an activity that is not current.")
            elif command == "set_policy":
                effective_period = p.get("effective_period") or row["effective_date"][:7]
                policy = {**baseline_policy, **{k: v for k, v in p.items() if k in {"currency", "rounding"}},
                          "version": len(state["policy_versions"]) + 1, "effective_period": effective_period,
                          "account_changes": p.get("accounts", {}), "accounts": {},
                          "override_changes": p.get("override_changes", {}), "account_overrides": {},
                          "profile_changes": p.get("profile_changes", {}), "account_profiles": {},
                          "profile_assignment_changes": p.get("profile_assignment_changes", {}), "profile_assignments": {},
                          "obligation_profile_assignment_changes": p.get("obligation_profile_assignment_changes", {}), "obligation_profile_assignments": {},
                          "account_dimension_rule_change": p.get("account_dimension_rules"), "account_dimension_source_change": p.get("account_dimension_source"),
                          "account_transition": p.get("account_transition"),
                          "change_set_id": row["id"], "recorded_at": row["recorded_at"]}
                state["policy_versions"].append(policy)
                if p.get("name"):
                    state["workspace"]["name"] = p["name"]
            elif command == "add_note":
                notes[p["id"]] = {**p, "created_at": row["recorded_at"]}
            elif command == "edit_note" and p["id"] in notes:
                notes[p["id"]].update({k: v for k, v in p.items() if k in {"body", "completed", "due_date", "period"}})
            elif command == "edit_details":
                target = customers.get(p["entity_id"]) or contracts.get(p["entity_id"])
                if target:
                    target.update({k: v for k, v in p.items() if k in {"name", "email", "reference", "source_system", "description"}})
            elif command == "attach_evidence":
                state["evidence"].append({**p, "recorded_at": row["recorded_at"], "change_set_id": row["id"], "scenario_id": row["scenario_id"]})
            elif command == "record_judgment_review":
                state["judgment_reviews"].append({**p, "recorded_at": row["recorded_at"], "change_set_id": row["id"], "scenario_id": row["scenario_id"]})
            elif command == "record_term_review":
                state["term_reviews"].append({**p, "version": row["version"], "recorded_at": row["recorded_at"], "change_set_id": row["id"], "scenario_id": row["scenario_id"]})
            elif command == "record_control_totals":
                state["controls"] = [item for item in state["controls"] if item["period"] != p["period"]]
                state["controls"].append({**p, "recorded_at": row["recorded_at"], "change_set_id": row["id"]})
            elif command == "record_population_manifest":
                state["population_manifests"] = [item for item in state["population_manifests"] if item["period"] != p["period"]]
                state["population_manifests"].append({**p, "recorded_at": row["recorded_at"], "change_set_id": row["id"]})
            elif command == "record_export_posting":
                state["postings"].append({**p, "recorded_at": row["recorded_at"], "change_set_id": row["id"]})
            elif command == "close_period":
                closes[p["period"]] = {"id": p["id"], "period": p["period"], "status": "closed", "recorded_at": row["recorded_at"], "frontier": row["version"], "rationale": p.get("rationale", ""), "population_comparison": p.get("population_comparison")}
            elif command == "reopen_period":
                if p["period"] in closes:
                    closes[p["period"]]["status"] = "reopened"
        mapping = {}
        overrides = {"contracts": {}, "obligations": {}}
        profiles = {}
        assignments = {}
        obligation_assignments = {}
        account_dimension_rules = []
        account_dimension_source = ""
        transitions_by_period = {}
        for policy in sorted(state["policy_versions"], key=lambda item: (item["effective_period"], item["version"])):
            mapping.update(policy["account_changes"])
            policy["accounts"] = mapping.copy()
            for scope, changed in policy.get("override_changes", {}).items():
                if scope == "contracts":
                    for contract_id, roles in changed.items():
                        current = overrides[scope].setdefault(contract_id, {})
                        for role, account in roles.items():
                            if account is None:
                                current.pop(role, None)
                            else:
                                current[role] = account
                        if not current:
                            overrides[scope].pop(contract_id, None)
                elif scope == "obligations":
                    for contract_id, obligations in changed.items():
                        current = overrides[scope].setdefault(contract_id, {})
                        for obligation_id, account in obligations.items():
                            if account is None:
                                current.pop(obligation_id, None)
                            else:
                                current[obligation_id] = account
                        if not current:
                            overrides[scope].pop(contract_id, None)
            policy["account_overrides"] = copy.deepcopy(overrides)
            for profile_id, profile in policy.get("profile_changes", {}).items():
                if profile is None:
                    profiles.pop(profile_id, None)
                else:
                    profiles[profile_id] = copy.deepcopy(profile)
            for contract_id, profile_id in policy.get("profile_assignment_changes", {}).items():
                if profile_id is None:
                    assignments.pop(contract_id, None)
                else:
                    assignments[contract_id] = profile_id
            for contract_id, changed in policy.get("obligation_profile_assignment_changes", {}).items():
                current = obligation_assignments.setdefault(contract_id, {})
                for obligation_id, profile_id in changed.items():
                    if profile_id is None:
                        current.pop(obligation_id, None)
                    else:
                        current[obligation_id] = profile_id
                if not current:
                    obligation_assignments.pop(contract_id, None)
            if any(profile_id not in profiles for profile_id in assignments.values()):
                raise ValueError("An accounting profile assignment references a missing profile")
            if any(profile_id not in profiles for items in obligation_assignments.values() for profile_id in items.values()):
                raise ValueError("An obligation profile assignment references a missing profile")
            policy["account_profiles"] = copy.deepcopy(profiles)
            policy["profile_assignments"] = assignments.copy()
            policy["obligation_profile_assignments"] = copy.deepcopy(obligation_assignments)
            if policy.get("account_dimension_rule_change") is not None:
                account_dimension_rules = copy.deepcopy(policy["account_dimension_rule_change"])
                account_dimension_source = policy.get("account_dimension_source_change") or ""
            policy["account_dimension_rules"] = copy.deepcopy(account_dimension_rules)
            policy["account_dimension_source"] = account_dimension_source
            effective_period = policy["effective_period"]
            policy["account_transition"] = policy.get("account_transition") or transitions_by_period.get(effective_period, "external")
            transitions_by_period[effective_period] = policy["account_transition"]
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
                    report["account_transitions"] = snapshot.get("account_transitions", [])
                    report["segment_imbalances"] = snapshot.get("segment_imbalances", [])
                    report["account_dimension_exceptions"] = snapshot.get("account_dimension_exceptions", [])
                    report["account_dimension_unvalidated_accounts"] = snapshot.get("account_dimension_unvalidated_accounts", [])
                    report["closed"] = True
                    report["close_id"] = row["id"]
        report["schedule"].sort(key=lambda r: (r["period"], r["contract_id"], r["obligation_id"]))
        state["report"] = report
        from .interchange import journal_batch_id
        report["journal_batch_id"] = journal_batch_id(state)
        if scenario_id == "main":
            from .posting import compare_journals
            posted = [item for item in state["postings"] if item["period"] == period]
            current_posted = any(item["batch_id"] == report["journal_batch_id"] for item in posted)
            snapshots = {}
            previous = {}
            for item in posted:
                if item["batch_id"] != report["journal_batch_id"]:
                    previous.setdefault(item["batch_id"], []).append(item)
            if previous:
                for row in db.execute("SELECT id, snapshot FROM period_closes WHERE period=?", (period,)):
                    snapshot = json.loads(row["snapshot"])
                    batch = journal_batch_id({"workspace": state["workspace"], "scenario_id": "main", "report": snapshot})
                    if batch in previous:
                        snapshots[batch] = {"close_id": row["id"], "journals": snapshot["journals"]}
            comparisons = []
            for batch, records in previous.items():
                source = snapshots.get(batch)
                comparisons.append({
                    "source_batch_id": batch, "target_batch_id": report["journal_batch_id"],
                    "source_close_id": source["close_id"] if source else None,
                    "posting_references": [item["external_journal_reference"] for item in records],
                    "current_batch_posted": current_posted, "target_closed": bool(report.get("closed")),
                    "available": bool(source),
                    "lines": compare_journals(source["journals"], report["journals"]) if source else [],
                })
            state["posting_comparisons"] = comparisons
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
            p["reference"] = str(p.get("reference") or "").strip()
            p["source_system"] = str(p.get("source_system") or "").strip()
            if p["reference"] and any(c.get("reference") == p["reference"] and (c.get("source_system") or "") == p["source_system"] for c in state["customers"]):
                raise ValueError("A customer already uses this source system and external reference.")
        elif command == "create_contract":
            from .domain import validate_contract
            p["id"] = p.get("id") or identifier("con")
            p["name"] = required_text(p, "name")
            if any(c["id"] == p["id"] for c in state["contracts"]):
                raise ValueError("Contract ID already exists.")
            if not any(c["id"] == p.get("customer_id") for c in state["customers"]):
                raise ValueError("Choose an existing customer.")
            p["reference"] = str(p.get("reference") or "").strip()
            if p["reference"] and any(c.get("reference") == p["reference"] for c in state["contracts"]):
                raise ValueError("A contract already uses this source reference.")
            valid_date(p.get("start_date"), "Start date")
            valid_date(p.get("end_date"), "End date")
            if p["start_date"] > p["end_date"]:
                raise ValueError("End date must follow start date.")
            if p.get("cutover_date"):
                p["cutover_date"] = valid_date(p["cutover_date"], "Cutover date")
                if p["cutover_date"][-2:] != "01" or p["cutover_date"] <= p["start_date"]:
                    raise ValueError("Cutover must be the first day of a month after the contract starts.")
            if p.get("activities"):
                raise ValueError("Record activity through its accounting command after creating the contract.")
            p.pop("activities", None)
            self._normalize_terms(p)
            validate_contract(p)
        elif command == "link_renewal_contract":
            source = next((item for item in state["contracts"] if item["id"] == p.get("contract_id")), None)
            renewal_id = p.get("renewal_contract_id")
            renewal = next((item for item in state["contracts"] if item["id"] == renewal_id), None)
            if source is None or renewal is None or source["id"] == renewal_id:
                raise ValueError("Choose an existing original contract and a different renewal contract.")
            if source["customer_id"] != renewal["customer_id"]:
                raise ValueError("The renewal contract must belong to the same customer as the exercised right.")
            exercise = next((item for item in source["activities"] if item["type"] == "right_exercise" and item["obligation_id"] == p.get("obligation_id")), None)
            if exercise is None:
                raise ValueError("Exercise the material right before linking its renewal contract.")
            if renewal["start_date"] != exercise["delivery_start"] or renewal["end_date"] != exercise["delivery_end"]:
                raise ValueError("The linked renewal contract dates must match the exercised right's delivery dates.")
            if any(item["start_date"] < exercise["delivery_start"] or item["end_date"] > exercise["delivery_end"] for item in renewal["obligations"]):
                raise ValueError("The linked renewal obligations must fall within the exercised right's delivery dates.")
            if any(item["contract_id"] == source["id"] and item["obligation_id"] == p["obligation_id"] for item in state["renewal_links"]):
                raise ValueError("This exercised right already has a linked renewal contract.")
            if any(item["renewal_contract_id"] == renewal_id for item in state["renewal_links"]):
                raise ValueError("A renewal contract cannot carry multiple original rights without a reviewed allocation.")
            if p.get("price_basis") != "new_consideration_only":
                raise ValueError("Confirm that the renewal contract contains only new consideration, excluding the original right allocation.")
            p["additional_consideration"] = decimal_string(p.get("additional_consideration"), "New renewal consideration", True)
            if Decimal(p["additional_consideration"]) != _price(renewal["consideration"]):
                raise ValueError("New renewal consideration must equal the renewal contract's initial transaction price.")
            p["right_exercise_change_set_id"] = exercise["id"]
            p["delivery_start"] = exercise["delivery_start"]
            p["delivery_end"] = exercise["delivery_end"]
            if p.get("effective_date") not in (None, exercise["effective_date"]):
                raise ValueError("The renewal link's effective date must match the right exercise date.")
            p["effective_date"] = exercise["effective_date"]
            p["rationale"] = required_text(p, "rationale")
        elif command == "correct_activity":
            p["rationale"] = required_text(p, "rationale")
            target = next((activity for contract in state["contracts"] for activity in contract["activities"] if activity["id"] == p.get("target_change_set_id")), None)
            if target is None or f"record_{target['type']}" not in CORRECTABLE_COMMANDS:
                raise ValueError("Choose a current billing, progress, usage, or milestone activity to correct.")
            replacement = p.get("replacement")
            if not isinstance(replacement, dict):
                raise ValueError("Provide the replacement source facts.")
            target_command = f"record_{target['type']}"
            allowed = {"contract_id", "effective_date", "rationale", "reference"}
            allowed |= ({"amount", "applies_to_change_set_id", "applies_to_reference"} if target_command == "record_billing" else
                        {"component_id", "unit_rate"} if target_command == "record_rate_change" else
                        {"obligation_id", "quantity" if target_command == "record_usage" else "percentage"})
            if set(replacement) - allowed:
                raise ValueError("Replacement contains fields that do not belong to this activity.")
            target_field = "component_id" if target_command == "record_rate_change" else "obligation_id"
            if replacement.get("contract_id") != target["contract_id"] or (target_command != "record_billing" and replacement.get(target_field) != target.get(target_field)):
                raise ValueError("Correct the original contract and component or obligation; use a reviewed change for reassignment.")
            replacement["rationale"] = p["rationale"]
            p["replacement"] = self._prepare(db, target_command, replacement, scenario_id)
            p["contract_id"] = target["contract_id"]
            p["effective_date"] = p["replacement"]["effective_date"]
        elif command == "record_opening_position":
            contract = next((item for item in state["contracts"] if item["id"] == p.get("contract_id")), None)
            if contract is None:
                raise ValueError("Choose an existing contract for the opening position.")
            if contract["activities"]:
                raise ValueError("Record an opening position before recording this contract's post-cutover activity.")
            p["effective_date"] = valid_date(p.get("effective_date"), "Cutover date")
            if p["effective_date"][-2:] != "01" or p["effective_date"] <= contract["start_date"]:
                raise ValueError("Cutover must be the first day of a month after the contract starts.")
            if contract.get("cutover_date") and p["effective_date"] != contract["cutover_date"]:
                raise ValueError("Opening position date must match the contract's declared cutover.")
            p["source_name"] = required_text(p, "source_name")
            p["rationale"] = required_text(p, "rationale")
            for field in ("billed_to_date", "contract_asset", "deferred_revenue"):
                p[field] = decimal_string(p.get(field), field.replace("_", " "), True)
            rows = p.get("opening_obligations")
            if not isinstance(rows, list) or len(rows) != len(contract["obligations"]):
                raise ValueError("Supply one opening row for each current performance obligation.")
            normalized = []
            for row in rows:
                if not isinstance(row, dict) or not isinstance(row.get("obligation_id"), str):
                    raise ValueError("Each opening row must identify an obligation.")
                item = {"obligation_id": row["obligation_id"], "recognized_to_date": decimal_string(row.get("recognized_to_date"), "Recognized to date", True)}
                if row.get("measure") not in (None, ""):
                    item["measure"] = decimal_string(row["measure"], "Cumulative measure", True)
                normalized.append(item)
            p["opening_obligations"] = normalized
        elif command in ACTIVITY_TYPES:
            contract = next((c for c in state["contracts"] if c["id"] == p.get("contract_id")), None)
            if contract is None:
                raise ValueError("Choose an existing contract.")
            if contract.get("cutover_date") and not any(item["type"] == "opening_position" for item in contract["activities"]):
                raise ValueError("Record the declared opening position before post-cutover activity on this contract.")
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
            if command in {"record_progress", "record_usage", "record_milestone", "record_adjustment", "record_right_exercise"}:
                if not any(o["id"] == p.get("obligation_id") for o in obligations):
                    raise ValueError("Choose a performance obligation.")
            if command == "record_right_exercise":
                if p.get("delivery_method") not in {"exact_days", "monthly", "prorated_monthly", "point_in_time"}:
                    raise ValueError("Choose a supported delivery method for the exercised right.")
                p["delivery_start"] = valid_date(p.get("delivery_start"), "Delivery start")
                p["delivery_end"] = valid_date(p.get("delivery_end"), "Delivery end")
                p["rationale"] = required_text(p, "rationale")
            if command in {"record_billing", "record_adjustment"}:
                p["amount"] = decimal_string(p.get("amount"))
            if command == "record_billing":
                if Decimal(p["amount"]) < 0:
                    original_id = p.get("applies_to_change_set_id")
                    original_reference = str(p.get("applies_to_reference") or "").strip()
                    if bool(original_id) == bool(original_reference):
                        raise ValueError("A billing credit needs exactly one original invoice: a workspace billing entry or an external invoice reference.")
                    if original_id:
                        original = next((item for item in contract["activities"] if item["id"] == original_id and item["type"] == "billing" and Decimal(item["amount"]) > 0), None)
                        if original is None or original["effective_date"] > p["effective_date"]:
                            raise ValueError("Choose an earlier positive billing entry on this contract for the credit.")
                    else:
                        p["applies_to_reference"] = original_reference
                    p["rationale"] = required_text(p, "rationale")
                elif p.get("applies_to_change_set_id") or p.get("applies_to_reference"):
                    raise ValueError("Original invoice links belong only on negative billing credits.")
            if command == "record_adjustment":
                p["rationale"] = required_text(p, "rationale")
            if command in {"record_progress", "record_milestone"}:
                p["percentage"] = decimal_string(p.get("percentage", "100" if command == "record_milestone" else None), "Percentage", True)
                if Decimal(p["percentage"]) > 100:
                    raise ValueError("Cumulative completion must be between 0 and 100.")
            if command == "record_usage":
                p["quantity"] = decimal_string(p.get("quantity"), "Quantity", True)
            if command == "record_rate_change":
                if len(consideration) != 1 or consideration[0]["kind"] != "metered" or p.get("component_id") != consideration[0]["id"]:
                    raise ValueError("Choose the metered consideration component for this rate change.")
                if not contract["start_date"] <= p["effective_date"] <= contract["end_date"]:
                    raise ValueError("A metered rate change must fall within the service term.")
                if scenario_id == "main" and any(close["status"] == "closed" and close["period"] >= p["effective_date"][:7] for close in state["closes"]):
                    raise ValueError("This rate change is effective in a closed period; explicitly reopen it before changing the rate.")
                p["unit_rate"] = decimal_string(p.get("unit_rate"), "Unit rate", True)
                if Decimal(p["unit_rate"]) <= 0:
                    raise ValueError("Unit rate must be positive.")
                if not isinstance(p.get("rationale"), str) or not p["rationale"].strip():
                    raise ValueError("A rate change needs the accountant's renewed invoice-value conclusion.")
                p["rationale"] = p["rationale"].strip()
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
            if "account_overrides" in p:
                requested = p.pop("account_overrides")
                if not isinstance(requested, dict) or set(requested) - {"contracts", "obligations"}:
                    raise ValueError("Account overrides must have contracts and obligations sections.")
                if not isinstance(requested.get("contracts", {}), dict) or not isinstance(requested.get("obligations", {}), dict):
                    raise ValueError("Contract and obligation account overrides must be objects.")
                normalized = {"contracts": {}, "obligations": {}}
                known = {c["id"]: c for c in state["contracts"]}
                for contract_id, roles in requested.get("contracts", {}).items():
                    if contract_id not in known or not isinstance(roles, dict) or set(roles) - set(DEFAULT_ACCOUNTS):
                        raise ValueError("Choose an existing contract and journal role for each account override.")
                    normalized["contracts"][contract_id] = {}
                    for role, account in roles.items():
                        if not isinstance(account, str) or not account.strip():
                            raise ValueError("Every account override needs an account code.")
                        normalized["contracts"][contract_id][role] = account.strip()
                for contract_id, obligations in requested.get("obligations", {}).items():
                    if contract_id not in known or not isinstance(obligations, dict):
                        raise ValueError("Choose an existing contract for each obligation override.")
                    known_ids = {o["id"] for o in known[contract_id]["obligations"]}
                    known_ids.update(o["id"] for event in known[contract_id]["activities"] for o in event.get("obligations", []))
                    normalized["obligations"][contract_id] = {}
                    for obligation_id, account in obligations.items():
                        if obligation_id not in known_ids or not isinstance(account, str) or not account.strip():
                            raise ValueError("Choose an existing obligation and revenue account for each override.")
                        normalized["obligations"][contract_id][obligation_id] = account.strip()
                previous = current_policy.get("account_overrides", {"contracts": {}, "obligations": {}})
                changes = {"contracts": {}, "obligations": {}}
                for scope in changes:
                    for contract_id in set(previous.get(scope, {})) | set(normalized[scope]):
                        old = previous.get(scope, {}).get(contract_id, {})
                        new = normalized[scope].get(contract_id, {})
                        for key in set(old) | set(new):
                            if old.get(key) != new.get(key):
                                changes[scope].setdefault(contract_id, {})[key] = new.get(key)
                p["override_changes"] = changes
                candidate_overrides = normalized
            else:
                p["override_changes"] = {"contracts": {}, "obligations": {}}
                candidate_overrides = current_policy.get("account_overrides", {"contracts": {}, "obligations": {}})
            previous_profiles = current_policy.get("account_profiles", {})
            requested_profiles = p.pop("account_profiles", previous_profiles)
            if not isinstance(requested_profiles, dict):
                raise ValueError("Accounting profiles must be an object.")
            normalized_profiles = {}
            for profile_id, profile in requested_profiles.items():
                if not isinstance(profile_id, str) or not profile_id.strip() or profile_id != profile_id.strip() or not isinstance(profile, dict) or set(profile) - {"name", "accounts", "dimensions"}:
                    raise ValueError("Each accounting profile needs a stable ID, name, account mappings, and dimensions.")
                name = profile.get("name")
                roles = profile.get("accounts", {})
                dimensions = profile.get("dimensions", {})
                if not isinstance(name, str) or not name.strip() or not isinstance(roles, dict) or set(roles) - set(DEFAULT_ACCOUNTS) or any(not isinstance(account, str) or not account.strip() for account in roles.values()):
                    raise ValueError("Accounting profile accounts must map known journal roles to account codes.")
                if not isinstance(dimensions, dict) or any(not isinstance(key, str) or not key.strip() or len(key) > 64 or any(char in key for char in "\r\n\t") or not isinstance(value, str) or not value.strip() for key, value in dimensions.items()):
                    raise ValueError("Accounting profile dimensions need nonempty names and values.")
                normalized_dimensions = {key.strip(): value.strip() for key, value in dimensions.items()}
                if len(normalized_dimensions) != len(dimensions):
                    raise ValueError("Accounting profile dimension names must be unique after trimming spaces.")
                normalized_profiles[profile_id] = {"name": name.strip(), "accounts": {role: account.strip() for role, account in roles.items()},
                                                   "dimensions": normalized_dimensions}
            p["profile_changes"] = {profile_id: normalized_profiles.get(profile_id) for profile_id in set(previous_profiles) | set(normalized_profiles)
                                    if previous_profiles.get(profile_id) != normalized_profiles.get(profile_id)}
            previous_assignments = current_policy.get("profile_assignments", {})
            requested_assignments = p.pop("profile_assignments", previous_assignments)
            if not isinstance(requested_assignments, dict):
                raise ValueError("Profile assignments must be an object.")
            known_contracts = {contract["id"] for contract in state["contracts"]}
            if any(contract_id not in known_contracts or not isinstance(profile_id, str) or profile_id not in normalized_profiles for contract_id, profile_id in requested_assignments.items()):
                raise ValueError("Assign only existing contracts to existing accounting profiles.")
            p["profile_assignment_changes"] = {contract_id: requested_assignments.get(contract_id) for contract_id in set(previous_assignments) | set(requested_assignments)
                                               if previous_assignments.get(contract_id) != requested_assignments.get(contract_id)}
            previous_obligation_assignments = current_policy.get("obligation_profile_assignments", {})
            requested_obligation_assignments = p.pop("obligation_profile_assignments", previous_obligation_assignments)
            if not isinstance(requested_obligation_assignments, dict):
                raise ValueError("Obligation profile assignments must be an object.")
            normalized_obligation_assignments = {}
            for contract_id, assigned in requested_obligation_assignments.items():
                contract = next((item for item in state["contracts"] if item["id"] == contract_id), None)
                if contract is None or not isinstance(assigned, dict):
                    raise ValueError("Assign obligation profiles only within existing contracts.")
                known_obligations = {item["id"] for item in contract["obligations"]}
                known_obligations.update(item["id"] for activity in contract["activities"] for item in activity.get("obligations", []))
                if any(obligation_id not in known_obligations or not isinstance(profile_id, str) or profile_id not in normalized_profiles for obligation_id, profile_id in assigned.items()):
                    raise ValueError("Assign existing accounting profiles to existing obligations.")
                if assigned:
                    normalized_obligation_assignments[contract_id] = assigned.copy()
            p["obligation_profile_assignment_changes"] = {}
            for contract_id in set(previous_obligation_assignments) | set(normalized_obligation_assignments):
                before = previous_obligation_assignments.get(contract_id, {})
                after = normalized_obligation_assignments.get(contract_id, {})
                changed = {obligation_id: after.get(obligation_id) for obligation_id in set(before) | set(after) if before.get(obligation_id) != after.get(obligation_id)}
                if changed:
                    p["obligation_profile_assignment_changes"][contract_id] = changed
            candidate_accounts = {**current_policy["accounts"], **p["accounts"]}
            if "account_dimension_rules" in p:
                rules = p["account_dimension_rules"]
                if not isinstance(rules, list):
                    raise ValueError("Approved account and dimension combinations must be a list.")
                normalized_rules = []
                seen_rules = set()
                for rule in rules:
                    if not isinstance(rule, dict) or set(rule) != {"account", "dimensions"}:
                        raise ValueError("Each approved combination needs an account and dimensions object.")
                    account, dimensions = rule["account"], rule["dimensions"]
                    if not isinstance(account, str) or not account.strip() or not isinstance(dimensions, dict):
                        raise ValueError("Approved combinations need an account code and dimensions object.")
                    normalized_dimensions = {}
                    for key, value in dimensions.items():
                        if not isinstance(key, str) or not key.strip() or len(key) > 64 or any(char in key for char in "\r\n\t") or not isinstance(value, str) or not value.strip():
                            raise ValueError("Approved combination dimensions need nonempty names and values.")
                        normalized_dimensions[key.strip()] = value.strip()
                    if len(normalized_dimensions) != len(dimensions):
                        raise ValueError("Approved combination dimension names must be unique after trimming spaces.")
                    normalized = {"account": account.strip(), "dimensions": normalized_dimensions}
                    identity = (normalized["account"], tuple(sorted(normalized_dimensions.items())))
                    if identity in seen_rules:
                        raise ValueError("Approved account and dimension combinations must be unique.")
                    seen_rules.add(identity)
                    normalized_rules.append(normalized)
                source = p.get("account_dimension_source", "")
                if not isinstance(source, str) or (normalized_rules and not source.strip()):
                    raise ValueError("Name the reviewed chart or account-structure source for approved combinations.")
                p["account_dimension_rules"] = normalized_rules
                p["account_dimension_source"] = source.strip() if normalized_rules else ""
                if (normalized_rules == current_policy.get("account_dimension_rules", [])
                        and p["account_dimension_source"] == current_policy.get("account_dimension_source", "")):
                    p.pop("account_dimension_rules")
                    p.pop("account_dimension_source")
            elif "account_dimension_source" in p:
                raise ValueError("The account-dimension source must accompany its approved combinations.")
            if p.get("account_transition") not in (None, "transfer", "external"):
                raise ValueError("Choose transfer or external reconciliation for existing balance-sheet positions.")
            if any((_resolved_account(current_policy["accounts"], current_policy.get("account_overrides", {}), contract_id, role, profiles=previous_profiles, assignments=previous_assignments),
                    _resolved_dimensions(previous_profiles, previous_assignments, contract_id)) !=
                   (_resolved_account(candidate_accounts, candidate_overrides, contract_id, role, profiles=normalized_profiles, assignments=requested_assignments),
                    _resolved_dimensions(normalized_profiles, requested_assignments, contract_id))
                   for contract_id in known_contracts for role in ("deferred_revenue", "contract_asset")):
                if not p.get("account_transition"):
                    raise ValueError("Choose how existing balance-sheet balances move to the new account: transfer or external reconciliation.")
            if not p.get("account_transition"):
                p.pop("account_transition", None)
            latest_closed = max((c["period"] for c in state["closes"] if c["status"] == "closed"), default=None)
            if latest_closed and p["effective_period"] <= latest_closed and (candidate_accounts != current_policy["accounts"] or any(p["override_changes"].values()) or p["profile_changes"] or p["profile_assignment_changes"] or p["obligation_profile_assignment_changes"] or ("account_dimension_rules" in p and (p["account_dimension_rules"] != current_policy.get("account_dimension_rules", []) or p["account_dimension_source"] != current_policy.get("account_dimension_source", "")))):
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
            if p.get("period"):
                p["period"] = valid_period(p["period"])
        elif command == "edit_note":
            if not any(n["id"] == p.get("id") for n in state["notes"]):
                raise ValueError("Note was not found.")
            if "completed" in p and not isinstance(p["completed"], bool):
                raise ValueError("Completed must be true or false.")
            if "body" in p:
                p["body"] = required_text(p, "body")
            if p.get("due_date"):
                valid_date(p["due_date"], "Due date")
            if p.get("period"):
                p["period"] = valid_period(p["period"])
        elif command == "edit_details":
            if not any(c["id"] == p.get("entity_id") for c in state["customers"] + state["contracts"]):
                raise ValueError("Customer or contract was not found.")
            if set(p) - {"entity_id", "name", "email", "reference", "source_system", "description"}:
                raise ValueError("Accounting terms require an accounting change.")
            if "name" in p:
                p["name"] = required_text(p, "name")
            if "source_system" in p or "reference" in p:
                target = next((c for c in state["customers"] if c["id"] == p["entity_id"]), None)
                if target:
                    reference = str(p.get("reference", target.get("reference") or "") or "").strip()
                    source_system = str(p.get("source_system", target.get("source_system") or "") or "").strip()
                    if reference and any(c["id"] != target["id"] and c.get("reference") == reference and (c.get("source_system") or "") == source_system for c in state["customers"]):
                        raise ValueError("A customer already uses this source system and external reference.")
                    p["reference"], p["source_system"] = reference, source_system
                elif "reference" in p:
                    reference = str(p["reference"] or "").strip()
                    if reference and any(c["id"] != p["entity_id"] and c.get("reference") == reference for c in state["contracts"]):
                        raise ValueError("A contract already uses this source reference.")
                    p["reference"] = reference
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
        elif command == "record_judgment_review":
            if set(p) - {"target_change_set_id", "reviewer", "disposition", "conclusion", "support_memo", "exception_reason"}:
                raise ValueError("Judgment review has unsupported fields.")
            target_id = required_text(p, "target_change_set_id")
            target = next((row for row in state["change_sets"] if row["id"] == target_id), None)
            if target is None or target["command"] not in JUDGMENT_COMMANDS:
                raise ValueError("Judgment change set was not found in this scenario.")
            p["reviewer"] = required_text(p, "reviewer")
            p["conclusion"] = required_text(p, "conclusion")
            p["support_memo"] = required_text(p, "support_memo")
            if p.get("disposition") not in {"supported", "exception"}:
                raise ValueError("Disposition must be supported or exception.")
            if p["disposition"] == "exception":
                p["exception_reason"] = required_text(p, "exception_reason")
            else:
                p.pop("exception_reason", None)
            p["entity_id"] = target["entity_id"]
            p["effective_date"] = target["effective_date"]
        elif command == "record_term_review":
            if set(p) - {"contract_id", "effective_date", "reviewer", "conclusion", "support_memo", "next_review_date"}:
                raise ValueError("Term review has unsupported fields.")
            contract = next((item for item in state["contracts"] if item["id"] == p.get("contract_id")), None)
            if contract is None:
                raise ValueError("Choose an existing contract for this term review.")
            p["effective_date"] = valid_date(p.get("effective_date"), "Review date")
            if p["effective_date"] > date.today().isoformat():
                raise ValueError("A term review cannot be recorded before it occurs.")
            if p["effective_date"] < contract["start_date"]:
                raise ValueError("Review date cannot precede the contract start.")
            if any(close["status"] == "closed" and close["period"] >= p["effective_date"][:7] for close in state["closes"]):
                raise ValueError("Reopen the closed period before recording this term review.")
            if any(review["contract_id"] == contract["id"] and review["effective_date"] > p["effective_date"] for review in state["term_reviews"]):
                raise ValueError("Review date cannot precede a later recorded term review.")
            assessment = term_assessment_at(state, contract, p["effective_date"])
            if assessment["term_basis"] == "fixed":
                raise ValueError("Only cancellable or evergreen terms need this review.")
            p["reviewer"] = required_text(p, "reviewer")
            p["conclusion"] = required_text(p, "conclusion")
            p["support_memo"] = required_text(p, "support_memo")
            p["next_review_date"] = p.get("next_review_date") or ""
            if assessment["term_review_date"] and not p["next_review_date"]:
                raise ValueError("Set a next review date to complete a scheduled term review.")
            if p["next_review_date"]:
                valid_date(p["next_review_date"], "Next review date")
                if p["next_review_date"] <= p["effective_date"]:
                    raise ValueError("Next review date must follow the completed review.")
        elif command == "record_control_totals":
            if scenario_id != "main":
                raise ValueError("External control totals belong to Main, not a scenario.")
            p["period"] = valid_period(p.get("period"))
            if any(close["period"] == p["period"] and close["status"] == "closed" for close in state["closes"]):
                raise ValueError("Reopen the period before revising its external controls.")
            p["source_name"] = required_text(p, "source_name")
            p["rationale"] = required_text(p, "rationale")
            for field in ("billings", "contract_asset", "deferred_revenue"):
                p[field] = decimal_string(p.get(field), field.replace("_", " "))
            if p.get("close_cutoff_date"):
                p["close_cutoff_date"] = valid_date(p["close_cutoff_date"], "Close cutoff date")
                if p["close_cutoff_date"] < period_end(p["period"]):
                    raise ValueError("Close cutoff date cannot precede period end.")
            else:
                p.pop("close_cutoff_date", None)
        elif command == "record_population_manifest":
            if scenario_id != "main":
                raise ValueError("Source population manifests belong to Main, not a scenario.")
            if set(p) - {"period", "source_name", "rationale", "contract_references", "billing_references"}:
                raise ValueError("Source population manifest has unsupported fields.")
            p["period"] = valid_period(p.get("period"))
            if any(close["period"] == p["period"] and close["status"] == "closed" for close in state["closes"]):
                raise ValueError("Reopen the period before revising its source population.")
            p["source_name"] = required_text(p, "source_name")
            p["rationale"] = required_text(p, "rationale")
            references = p.get("contract_references")
            billings = p.get("billing_references")
            if not isinstance(references, list) or not isinstance(billings, list):
                raise ValueError("Provide contract and billing reference lists, even when empty.")
            def normalize_reference(value, label):
                if not isinstance(value, str) or not value.strip():
                    raise ValueError(f"{label} must be nonempty text.")
                return value.strip()
            p["contract_references"] = [normalize_reference(value, "Contract reference") for value in references]
            if len(set(p["contract_references"])) != len(p["contract_references"]):
                raise ValueError("The source contract list contains duplicate references.")
            normalized_billings = []
            for item in billings:
                if not isinstance(item, dict) or set(item) != {"contract_reference", "invoice_reference"}:
                    raise ValueError("Each source billing row needs a contract and invoice reference.")
                normalized_billings.append({key: normalize_reference(item[key], key.replace("_", " ").capitalize()) for key in ("contract_reference", "invoice_reference")})
            p["billing_references"] = normalized_billings
            keys = [(item["contract_reference"], item["invoice_reference"]) for item in normalized_billings]
            if len(set(keys)) != len(keys):
                raise ValueError("The source billing list contains duplicate contract and invoice references.")
        elif command == "record_export_posting":
            if scenario_id != "main":
                raise ValueError("External posting records belong to Main.")
            if set(p) - {"period", "batch_id", "external_journal_reference", "posted_date", "rationale"}:
                raise ValueError("External posting record has unsupported fields.")
            p["period"] = valid_period(p.get("period"))
            p["batch_id"] = required_text(p, "batch_id")
            p["external_journal_reference"] = required_text(p, "external_journal_reference")
            p["posted_date"] = valid_date(p.get("posted_date"), "Posted date")
            p["rationale"] = required_text(p, "rationale")
            accepted = self._state(db, "main", p["period"])["report"]
            if not accepted.get("closed"):
                raise ValueError("Close the period before recording an external journal posting.")
            if p["batch_id"] != accepted["journal_batch_id"]:
                raise ValueError("The journal batch changed. Export and review the current closed-period journal before recording its posting.")
            p["close_id"] = accepted["close_id"]
            if any(item["period"] == p["period"] and item["batch_id"] == p["batch_id"] and item["external_journal_reference"] == p["external_journal_reference"] for item in state["postings"]):
                raise ValueError("This external journal reference is already recorded for the batch.")
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
                from .reporting import build_review
                close_state = self._state(db, "main", p["period"])
                review = build_review(close_state, self._scenario_impacts(db, close_state, p["period"]))
                blockers = [check["label"] for check in review["checks"] if check["status"] == "block"]
                if blockers:
                    raise ValueError("Resolve close blockers: " + ", ".join(blockers))
                dispositions = p.get("review_dispositions", {})
                if not isinstance(dispositions, dict):
                    raise ValueError("Close review dispositions must be an object.")
                required = {check["id"] for check in review["checks"] if check["status"] == "review"}
                if set(dispositions) != required:
                    raise ValueError("Review every open close check and record an acceptance reason before closing.")
                for check_id, disposition in dispositions.items():
                    if not isinstance(disposition, dict) or disposition.get("disposition") != "accepted" or not isinstance(disposition.get("reason"), str) or not disposition["reason"].strip():
                        raise ValueError(f"Close review check {check_id} needs an explicit acceptance reason.")
                p["review_dispositions"] = {check_id: {"disposition": "accepted", "reason": value["reason"].strip()} for check_id, value in dispositions.items()}
                p["review_checks"] = [{"id": check["id"], "status": check["status"], "count": check["count"]} for check in review["checks"]]
                p["population_comparison"] = review["population_comparison"]
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
        for key in ("name", "email", "reference", "source_system", "description", "rationale", "body", "kind", "label", "method", "treatment", "path", "allocation_scope", "allocation_rationale"):
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
        if command in ACTIVITY_TYPES or command in {"create_contract", "link_renewal_contract", "set_policy", "correct_activity"}:
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

    def _scenario_conflicts(self, db, scenario_id, base_version):
        own = [row for row in self._rows(db, scenario_id) if row["scenario_id"] == scenario_id
               and row["command"] not in SCENARIO_COMMANDS | DESCRIPTIVE_COMMANDS]
        main_rows = db.execute("SELECT command, entity_id, version, payload FROM change_sets WHERE scenario_id='main' AND version>? ORDER BY version", (base_version,))
        conflicts = []
        for raw in main_rows:
            main = {**dict(raw), "payload": json.loads(raw["payload"])}
            if main["command"] in DESCRIPTIVE_COMMANDS:
                continue
            if any(proposal["command"] == "set_policy" or main["command"] == "set_policy" or
                   (proposal["entity_id"] == main["entity_id"] and not _independent_invoices(proposal, main))
                   for proposal in own):
                conflicts.append({key: main[key] for key in ("command", "entity_id", "version")})
        return conflicts

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
                conflicts = self._scenario_conflicts(db, sid, scenario["base_version"])
                if conflicts:
                    labels = ", ".join(f"{row['command']} on {row['entity_id']} (v{row['version']})" for row in conflicts[:5])
                    raise ValueError(f"Main changed the same accounting records: {labels}. Create a new scenario from Main and review these proposals again.")
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
                    if row["command"] == "record_judgment_review":
                        copied_payload.pop("entity_id", None)
                        copied_payload.pop("effective_date", None)
                    if row["command"] in {"attach_evidence", "record_judgment_review"} and copied_payload.get("target_change_set_id") in copied_change_ids:
                        copied_payload["target_change_set_id"] = copied_change_ids[copied_payload["target_change_set_id"]]
                    if row["command"] == "correct_activity" and copied_payload.get("target_change_set_id") in copied_change_ids:
                        copied_payload["target_change_set_id"] = copied_change_ids[copied_payload["target_change_set_id"]]
                    if row["command"] == "record_billing" and copied_payload.get("applies_to_change_set_id") in copied_change_ids:
                        copied_payload["applies_to_change_set_id"] = copied_change_ids[copied_payload["applies_to_change_set_id"]]
                    copied_key = None
                    if copied_payload.get("import_source_identity") is not None:
                        copied_key = "import:" + hashlib.sha256(dumps(["main", row["command"], copied_payload["import_source_identity"]]).encode()).hexdigest()
                        if db.execute("SELECT 1 FROM change_sets WHERE idempotency_key=?", (copied_key,)).fetchone():
                            raise ValueError("An imported source row in this scenario is already accepted in Main.")
                    copied_hash = hashlib.sha256(dumps({"command": row["command"], "payload": copied_payload, "scenario_id": "main"}).encode()).hexdigest() if copied_key else None
                    accepted = self._execute_in(db, row["command"], copied_payload, "main", f"scenario:{sid}", copied_key, copied_hash, originating_change_set_id=row["id"])
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
        effective = None
        if isinstance(payload, dict):
            effective = payload.get("effective_date") or payload.get("start_date") or payload.get("effective_period") or payload.get("period")
            if not effective and isinstance(payload.get("replacement"), dict):
                effective = payload["replacement"].get("effective_date")
        effective_period = effective[:7] if isinstance(effective, str) and len(effective) >= 7 else period
        focus_period = max(period, valid_period(effective_period))
        with self.workspace.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            try:
                target = "main" if command == "apply_scenario" else scenario_id
                if command == "rebase_scenario" and isinstance(payload, dict):
                    target = payload.get("scenario_id") or payload.get("id") or scenario_id
                before = self._state(db, target, focus_period)
                self._execute_in(db, command, payload, scenario_id, "preview")
                after = self._state(db, target, focus_period)
                comparison = compare_reports(before["report"], after["report"])
                if before["report"]["journals"] != after["report"]["journals"] or before["report"]["summary"] != after["report"]["summary"]:
                    comparison["affected_periods"] = sorted(set(comparison["affected_periods"]) | {focus_period})
                return {"before": before["report"], "state": after, "comparison": comparison, "selected_period": period, "focus_period": focus_period}
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
                base_version = self._scenario(db, scenario_id)["base_version"]
                proposals = [{"id": row["id"], "command": row["command"], "entity_id": row["entity_id"], "effective_date": row["effective_date"], "rationale": row["rationale"]} for row in self._rows(db, scenario_id) if row["scenario_id"] == scenario_id and row["command"] not in SCENARIO_COMMANDS]
                conflicts = self._scenario_conflicts(db, scenario_id, base_version)
                return {**compare_reports(main["report"], scenario["report"]), "scenario_id": scenario_id, "base_version": base_version, "main_version": self._main_frontier(db), "proposals": proposals, "conflicts": conflicts}
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
                support_state = self._project(db, change["scenario_id"])
                return {"change": change, "period": selected_period, "before_report": before["report"], "after_report": after["report"],
                        "before_state": before, "after_state": after,
                        "before_policy": before["policy"], "after_policy": after["policy"], "comparison": comparison,
                        "evidence": [item for item in support_state["evidence"] if item.get("target_change_set_id") == change_set_id],
                        "judgment_reviews": [item for item in support_state["judgment_reviews"] if item["target_change_set_id"] == change_set_id]}
            finally:
                db.rollback()

    def reports(self, scenario_id="main", period=None):
        """Return close-oriented views built from the same accepted projection."""
        return self.report_bundle(scenario_id, period)["review"]

    def _scenario_impacts(self, db, state, period):
        main = state if state["scenario_id"] == "main" else self._state(db, "main", period)
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
        return impacts

    def report_bundle(self, scenario_id="main", period=None):
        """Read detail and review reports from one database snapshot for export."""
        from .reporting import build_review

        period = valid_period(period or date.today().strftime("%Y-%m"))
        with self.workspace.connect() as db:
            db.execute("BEGIN")
            try:
                state = self._state(db, scenario_id, period)
                return {"state": state, "review": build_review(state, self._scenario_impacts(db, state, period))}
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
    main_detail, scenario_detail = {}, {}
    for report, values in ((main, main_by_period), (proposed, scenario_by_period)):
        for row in report["schedule"]:
            values[row["period"]] = values.get(row["period"], Decimal(0)) + Decimal(row["revenue"])
            detail = main_detail if report is main else scenario_detail
            key = (row["period"], row["contract_id"], row["obligation_id"])
            detail[key] = detail.get(key, Decimal(0)) + Decimal(row["revenue"])
    rows = [{"period": p, "main_revenue": f"{main_by_period.get(p, Decimal(0)):.2f}", "scenario_revenue": f"{scenario_by_period.get(p, Decimal(0)):.2f}", "delta": f"{scenario_by_period.get(p, Decimal(0)) - main_by_period.get(p, Decimal(0)):.2f}"} for p in sorted(main_by_period.keys() | scenario_by_period.keys())]
    zero = Decimal(0)
    details = [{"period": key[0], "contract_id": key[1], "obligation_id": key[2], "current": f"{main_detail.get(key, zero):.2f}", "proposed": f"{scenario_detail.get(key, zero):.2f}", "delta": f"{scenario_detail.get(key, zero) - main_detail.get(key, zero):.2f}"} for key in sorted(main_detail.keys() | scenario_detail.keys()) if main_detail.get(key, zero) != scenario_detail.get(key, zero)]
    return {"rows": rows, "details": details, "summary": {k: f"{Decimal(proposed['summary'].get(k, '0')) - Decimal(main['summary'].get(k, '0')):.2f}" for k in ("revenue", "deferred_revenue", "contract_asset", "remaining_revenue", "transaction_price", "billings")}, "main": main["summary"], "scenario": proposed["summary"], "journals": {"main": main["journals"], "scenario": proposed["journals"]}, "affected_periods": sorted({row["period"] for row in details})}
