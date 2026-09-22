"""End-to-end tests use real portable workspaces and real SQLite transactions."""

from __future__ import annotations

import io
import sqlite3
from copy import deepcopy

import pytest
from openpyxl import load_workbook

from openrevrec.application import Application
from openrevrec.demo import load_demo
from openrevrec.interchange import export_bytes, import_bytes, template_bytes


def app(tmp_path):
    return Application.create(tmp_path / "Test company.orr", "Test company")


def seed(application):
    customer = application.execute("create_customer", {"id": "cus_1", "name": "Customer"})
    contract = {
        "id": "con_1", "name": "Annual service", "customer_id": customer["result"]["id"],
        "start_date": "2026-09-01", "end_date": "2027-08-31",
        "consideration": [{"id": "price_1", "label": "Fixed fee", "kind": "fixed", "amount": "12000.00"}],
        "obligations": [{"id": "pob_1", "name": "Service", "kind": "service", "ssp": "12000.00", "method": "exact_days", "start_date": "2026-09-01", "end_date": "2027-08-31"}],
    }
    application.execute("create_contract", contract, period="2026-09")
    return contract


def test_commands_persist_exact_history_and_are_idempotent(tmp_path):
    application = app(tmp_path)
    seed(application)
    first = application.execute("record_billing", {"contract_id": "con_1", "effective_date": "2026-09-01", "amount": "12000.00", "reference": "INV-1"}, idempotency_key="invoice-1", period="2026-09")
    second = application.execute("record_billing", {"contract_id": "con_1", "effective_date": "2026-09-01", "amount": "12000.00", "reference": "INV-1"}, idempotency_key="invoice-1", period="2026-09")
    assert second["result"]["replayed"] is True
    assert first["result"]["change_set_id"] == second["result"]["change_set_id"]
    assert second["state"]["report"]["summary"]["billings"] == "12000.00"
    with pytest.raises(ValueError, match="different input"):
        application.execute("record_billing", {"contract_id": "con_1", "effective_date": "2026-09-01", "amount": "1.00"}, idempotency_key="invoice-1")


def test_preview_rolls_back_every_write(tmp_path):
    application = app(tmp_path)
    seed(application)
    before = application.state(period="2026-09")
    preview = application.preview("record_billing", {"contract_id": "con_1", "effective_date": "2026-09-01", "amount": "12000.00"}, period="2026-09")
    after = application.state(period="2026-09")
    assert preview["state"]["report"]["summary"]["billings"] == "12000.00"
    assert after["frontier"] == before["frontier"]
    assert after["report"]["summary"]["billings"] == "0.00"


def test_scenario_isolation_compare_and_apply(tmp_path):
    application = app(tmp_path)
    seed(application)
    scenario = application.execute("create_scenario", {"name": "Proposed price change"})["result"]["id"]
    application.execute("modify_contract", {
        "contract_id": "con_1", "effective_date": "2026-10-01", "treatment": "prospective",
        "consideration": [{"id": "price_1", "label": "Fixed fee", "kind": "fixed", "amount": "18000.00"}],
        "rationale": "Customer expanded the remaining service scope.",
    }, scenario_id=scenario, period="2026-10")
    main = application.state("main", "2026-10")
    proposed = application.state(scenario, "2026-10")
    assert main["report"]["summary"]["transaction_price"] == "12000.00"
    assert proposed["report"]["summary"]["transaction_price"] == "18000.00"
    assert application.compare(scenario, "2026-10")["affected_periods"]
    application.execute("apply_scenario", {"scenario_id": scenario}, period="2026-10")
    accepted = application.state("main", "2026-10")
    assert accepted["report"]["summary"]["transaction_price"] == "18000.00"
    assert next(s for s in accepted["scenarios"] if s["id"] == scenario)["status"] == "applied"
    applied = [c for c in accepted["change_sets"] if c["command"] == "modify_contract"]
    assert applied[0]["originating_change_set_id"]


def test_prebuilt_reports_reconcile_balances_and_surface_scenario_impact(tmp_path):
    application = app(tmp_path)
    seed(application)
    application.execute("record_billing", {"contract_id": "con_1", "effective_date": "2026-09-01", "amount": "12000.00"}, period="2026-09")
    scenario = application.execute("create_scenario", {"name": "Price review"})["result"]["id"]
    application.execute("modify_contract", {
        "contract_id": "con_1", "effective_date": "2026-10-01", "treatment": "prospective",
        "consideration": [{"id": "price_1", "label": "Fixed fee", "kind": "fixed", "amount": "18000.00"}],
        "rationale": "Review expanded scope.",
    }, scenario_id=scenario, period="2026-10")

    review = application.reports("main", "2026-09")
    row = review["rollforward"][0]
    assert row["opening_contract_asset"] == "0.00"
    assert row["opening_deferred_revenue"] == "0.00"
    assert row["closing_deferred_revenue"] == "11013.70"
    assert review["recognition_coverage"][0]["status"] == "covered"
    assert review["scenario_impacts"][0]["name"] == "Price review"
    assert review["scenario_impacts"][0]["affected_periods"]
    assert next(check for check in review["checks"] if check["id"] == "journal")["status"] == "pass"


def test_close_readiness_flags_entries_recorded_after_period_end(tmp_path):
    application = app(tmp_path)
    customer = application.execute("create_customer", {"id": "cus_late", "name": "Late customer"})
    application.execute("create_contract", {
        "id": "con_late", "name": "August service", "customer_id": customer["result"]["id"],
        "start_date": "2020-08-01", "end_date": "2020-08-31",
        "consideration": [{"id": "price_late", "label": "Fixed", "kind": "fixed", "amount": "3100.00"}],
        "obligations": [{"id": "pob_late", "name": "Service", "kind": "service", "ssp": "3100.00", "method": "exact_days", "start_date": "2020-08-01", "end_date": "2020-08-31"}],
    }, period="2020-08")
    cutoff = next(check for check in application.reports("main", "2020-08")["checks"] if check["id"] == "cutoff")
    assert cutoff["status"] == "review"
    assert cutoff["count"] == 1


def test_scenario_rebase_detects_same_entity_conflict(tmp_path):
    application = app(tmp_path)
    seed(application)
    scenario = application.execute("create_scenario", {"name": "Alternative"})["result"]["id"]
    application.execute("record_billing", {"contract_id": "con_1", "effective_date": "2026-10-01", "amount": "1000.00"}, scenario_id=scenario)
    application.execute("record_billing", {"contract_id": "con_1", "effective_date": "2026-10-02", "amount": "1000.00"})
    with pytest.raises(ValueError, match="same accounting records"):
        application.execute("rebase_scenario", {"scenario_id": scenario})
    with pytest.raises(ValueError, match="Main has advanced"):
        application.execute("apply_scenario", {"scenario_id": scenario})


def test_archive_and_restore_keep_scenario_history(tmp_path):
    application = app(tmp_path)
    seed(application)
    scenario = application.execute("create_scenario", {"name": "Saved alternative"})["result"]["id"]
    application.execute("record_billing", {"contract_id": "con_1", "effective_date": "2026-09-01", "amount": "2000.00"}, scenario_id=scenario)
    application.execute("archive_scenario", {"scenario_id": scenario})
    assert next(s for s in application.state()["scenarios"] if s["id"] == scenario)["status"] == "archived"
    application.execute("restore_scenario", {"scenario_id": scenario})
    state = application.state(scenario, "2026-09")
    assert next(s for s in state["scenarios"] if s["id"] == scenario)["status"] == "active"
    assert state["report"]["summary"]["billings"] == "2000.00"


def test_close_checkpoint_blocks_change_and_reopen_is_explicit(tmp_path):
    application = app(tmp_path)
    seed(application)
    application.execute("record_billing", {"contract_id": "con_1", "effective_date": "2026-09-01", "amount": "12000.00"}, period="2026-09")
    closed = application.execute("close_period", {"period": "2026-09", "rationale": "Reconciled to billing support."}, period="2026-09")
    assert closed["state"]["report"]["closed"] is True
    assert closed["result"]["backup_path"].endswith(".orr")
    with pytest.raises(ValueError, match="affects closed period"):
        application.execute("record_billing", {"contract_id": "con_1", "effective_date": "2026-09-30", "amount": "1.00"}, period="2026-09")
    application.execute("reopen_period", {"period": "2026-09", "rationale": "Late invoice requires correction."}, period="2026-09")
    updated = application.execute("record_billing", {"contract_id": "con_1", "effective_date": "2026-09-30", "amount": "1.00"}, period="2026-09")
    assert updated["state"]["report"]["summary"]["billings"] == "12001.00"


def test_sqlite_rejects_direct_history_changes(tmp_path):
    application = app(tmp_path)
    seed(application)
    with application.workspace.connect() as db:
        with pytest.raises(sqlite3.IntegrityError, match="immutable"):
            db.execute("DELETE FROM change_sets")
    result = application.query("SELECT command, entity_id FROM change_sets ORDER BY version")
    assert result["columns"] == ["command", "entity_id"]
    assert len(result["rows"]) == 2
    with pytest.raises(ValueError):
        application.query("DELETE FROM change_sets")


def test_metadata_edits_and_company_setup_do_not_change_accounting(tmp_path):
    application = app(tmp_path)
    seed(application)
    before = application.state(period="2026-09")["report"]
    application.execute("edit_details", {
        "entity_id": "cus_1", "name": "Renamed customer", "email": "accounting@example.com",
        "reference": "CRM-42", "description": "Internal operating note",
    })
    application.execute("set_policy", {
        "name": "Renamed company", "accounts": {"revenue": "4100"}, "rationale": "Initial company setup",
    })
    state = application.state(period="2026-09")
    assert state["workspace"]["name"] == "Renamed company"
    assert state["customers"][0]["email"] == "accounting@example.com"
    assert state["customers"][0]["reference"] == "CRM-42"
    assert state["report"]["summary"] == before["summary"]


def test_accounting_activity_view_matches_sql_inspector_starter_query(tmp_path):
    application = app(tmp_path)
    seed(application)
    application.execute("record_billing", {"contract_id": "con_1", "effective_date": "2026-09-01", "amount": "12.00"})
    result = application.query("SELECT scenario_id, activity_type, contract_id, effective_date, recorded_at FROM accounting_activity ORDER BY recorded_at DESC LIMIT 25")
    assert result["columns"] == ["scenario_id", "activity_type", "contract_id", "effective_date", "recorded_at"]
    assert result["rows"][0][1:3] == ["record_billing", "con_1"]


def test_template_import_is_atomic_and_export_is_valid(tmp_path):
    application = app(tmp_path)
    book = load_workbook(io.BytesIO(template_bytes()))
    book["Customers"].append(["cus_import", "Imported customer", "", "C-1"])
    book["Contracts"].append(["con_import", "cus_import", "Imported contract", "2026-09-01", "2026-09-30", "Reviewed contract"])
    book["Consideration"].append(["con_import", "price_import", "Fixed fee", "fixed", "1000.00", "", "", "", "", ""])
    book["Obligations"].append(["con_import", "pob_import", "September service", "service", "1000.00", "exact_days", "2026-09-01", "2026-09-30", "", "", "", ""])
    data = io.BytesIO(); book.save(data); book.close()
    result = import_bytes(application, data.getvalue(), "import.xlsx", period="2026-09")
    assert result["result"]["imported"] == 2
    assert len(result["state"]["contracts"]) == 1
    review = application.reports("main", "2026-09")
    sheets = load_workbook(io.BytesIO(export_bytes(result["state"], review))).sheetnames
    assert sheets[:4] == ["Workspace", "Summary", "Close readiness", "Contract rollforward"]
    assert "Recognition coverage" in sheets

    bad = load_workbook(io.BytesIO(template_bytes()))
    bad["Customers"].append(["cus_second", "Second", "", ""])
    bad["Contracts"].append(["con_bad", "missing", "Bad", "2026-09-01", "2026-09-30", ""])
    bad["Consideration"].append(["con_bad", "p", "Fixed", "fixed", "10", "", "", "", "", ""])
    bad["Obligations"].append(["con_bad", "o", "Service", "service", "10", "exact_days", "2026-09-01", "2026-09-30", "", "", "", ""])
    broken = io.BytesIO(); bad.save(broken); bad.close()
    with pytest.raises(ValueError, match="No accounting rows were imported"):
        import_bytes(application, broken.getvalue(), "bad.xlsx")
    assert not any(c["id"] == "cus_second" for c in application.state()["customers"])


def test_demo_walkthrough_has_five_contracts_scenario_and_balanced_journal(tmp_path):
    application = app(tmp_path)
    result = load_demo(application)
    state = result["state"]
    assert len(state["contracts"]) == 5
    assert len([s for s in state["scenarios"] if s["id"] != "main"]) == 1
    assert state["report"]["catch_ups"]
    assert sum(j["debit_minor"] for j in state["report"]["journals"]) == sum(j["credit_minor"] for j in state["report"]["journals"])


def test_apply_preview_from_scenario_shows_main_impact_without_writes(tmp_path):
    application = app(tmp_path)
    seed(application)
    sid = application.execute("create_scenario", {"name": "Billing"})["result"]["id"]
    application.execute("record_billing", {"contract_id": "con_1", "effective_date": "2026-09-01", "amount": "100"}, scenario_id=sid)
    before = application.state(sid, "2026-09")
    preview = application.preview("apply_scenario", {"scenario_id": sid}, scenario_id=sid, period="2026-09")
    assert preview["comparison"]["summary"]["billings"] == "100.00"
    assert preview["state"]["scenario_id"] == "main"
    assert application.state(sid, "2026-09") == before
    assert application.state("main", "2026-09")["report"]["summary"]["billings"] == "0.00"


def test_closed_period_allows_new_future_contract_but_blocks_backdated_billing(tmp_path):
    application = app(tmp_path)
    contract = seed(application)
    closed = application.execute("close_period", {"period": "2026-09"}, period="2026-09")["state"]["report"]
    future = deepcopy(contract)
    future.update(id="future", start_date="2026-10-01")
    future["obligations"][0]["start_date"] = "2026-10-01"
    application.execute("create_contract", future, period="2026-10")
    after = application.state(period="2026-09")["report"]
    assert after["contracts"] == closed["contracts"]
    assert after["summary"] == closed["summary"]
    with pytest.raises(ValueError, match="closed period"):
        application.execute("record_billing", {"contract_id": "future", "effective_date": "2026-09-30", "amount": "100"})


def test_closed_period_protects_obligation_schedule_even_when_totals_match(tmp_path):
    application = app(tmp_path)
    contract = seed(application)
    obligations = [deepcopy(contract["obligations"][0]), deepcopy(contract["obligations"][0])]
    obligations[1]["id"] = "pob_2"
    for obligation in obligations:
        obligation["method"] = "monthly"
    application.execute("modify_contract", {"contract_id": "con_1", "effective_date": "2026-09-01", "treatment": "catch_up", "obligations": obligations, "rationale": "Split services"})
    application.execute("close_period", {"period": "2026-09"})
    obligations[0]["ssp"] = "36000"
    with pytest.raises(ValueError, match="closed period"):
        application.execute("modify_contract", {"contract_id": "con_1", "effective_date": "2026-09-01", "treatment": "catch_up", "obligations": obligations, "rationale": "Reallocate services"})


@pytest.mark.parametrize("command,payload", [
    ("create_customer", {"id": 42, "name": "Invalid ID"}),
    ("create_customer", {"name": "Invalid text", "email": {"bad": True}}),
    ("create_contract", {"name": "Invalid terms", "customer_id": "cus_1", "start_date": "2026-09-01", "end_date": "2027-08-31", "consideration": [None], "obligations": []}),
    ("set_policy", {"accounts": []}),
    ("create_scenario", []),
    ("add_note", {"id": "note_1", "body": "Duplicate"}),
    ("edit_note", {"id": "note_1", "body": {"invalid": True}}),
    ("edit_note", {"id": "note_1", "due_date": 123}),
    ("edit_note", {"id": "note_1", "due_date": "2026-02-30"}),
])
def test_malformed_commands_are_validation_errors_and_leave_history_unchanged(tmp_path, command, payload):
    application = app(tmp_path)
    seed(application)
    application.execute("add_note", {"id": "note_1", "kind": "task", "body": "Review"})
    before = application.state()
    with pytest.raises(ValueError):
        application.execute(command, payload)
    assert application.state() == before
    application.reports()


def test_workspace_connections_close_on_context_exit(tmp_path):
    application = app(tmp_path)
    with application.workspace.connect() as db:
        connection = db
    with pytest.raises(sqlite3.ProgrammingError, match="closed"):
        connection.execute("SELECT 1")


@pytest.mark.parametrize("headers,row", [
    (["id", "name", "name"], ["cus", "Original", "Overwritten"]),
    (["id", "name", ""], ["cus", "Name", "Silently discarded"]),
])
def test_import_rejects_ambiguous_columns(tmp_path, headers, row):
    application = app(tmp_path)
    book = load_workbook(io.BytesIO(template_bytes()))
    sheet = book["Customers"]
    sheet.delete_rows(1)
    sheet.append(headers)
    sheet.append(row)
    data = io.BytesIO()
    book.save(data)
    book.close()
    with pytest.raises(ValueError):
        import_bytes(application, data.getvalue())
    assert application.state()["customers"] == []


def test_sql_bounds_large_values_and_returns_json_safe_blobs(tmp_path):
    application = app(tmp_path)
    assert application.query("SELECT x'00ff' AS evidence")["rows"] == [[{"hex": "00ff"}]]
    with pytest.raises(ValueError, match="too big"):
        application.query("SELECT zeroblob(1000001)")


def test_close_backup_preserves_precommand_state_and_retry_creates_no_backup(tmp_path):
    application = app(tmp_path)
    seed(application)
    before = application.state(period="2026-09")
    closed = application.execute("close_period", {"period": "2026-09"}, idempotency_key="close-september", period="2026-09")
    backup = Application(closed["result"]["backup_path"])
    assert backup.state(period="2026-09") == before
    backups = list((application.workspace.path / "backups").iterdir())
    retried = application.execute("close_period", {"period": "2026-09"}, idempotency_key="close-september", period="2026-09")
    assert retried["result"]["replayed"] is True
    assert list((application.workspace.path / "backups").iterdir()) == backups


def test_apply_retry_returns_main_and_does_not_duplicate_activity(tmp_path):
    application = app(tmp_path)
    seed(application)
    sid = application.execute("create_scenario", {"name": "Billing"})["result"]["id"]
    application.execute("record_billing", {"contract_id": "con_1", "effective_date": "2026-09-01", "amount": "100"}, scenario_id=sid)
    first = application.execute("apply_scenario", {"scenario_id": sid}, scenario_id=sid, idempotency_key="apply-billing", period="2026-09")
    retry = application.execute("apply_scenario", {"scenario_id": sid}, scenario_id=sid, idempotency_key="apply-billing", period="2026-09")
    assert retry["state"] == first["state"]
    assert retry["state"]["scenario_id"] == "main"
    assert retry["state"]["report"]["summary"]["billings"] == "100.00"


def test_account_mapping_applies_from_its_effective_month_without_rewriting_prior_journals(tmp_path):
    application = app(tmp_path)
    seed(application)
    september = application.state(period="2026-09")
    application.execute("set_policy", {
        "effective_period": "2026-10", "accounts": {"revenue": "4100"},
        "rationale": "New revenue account from October",
    }, period="2026-10")
    earlier = application.state(period="2026-09")
    october = application.state(period="2026-10")
    november = application.state(period="2026-11")
    assert earlier["report"]["journals"] == september["report"]["journals"]
    assert earlier["policy"]["version"] == 1
    assert october["policy"]["version"] == 2
    assert october["report"]["policy_effective_period"] == "2026-10"
    assert {row["account"] for row in october["report"]["journals"] if row["role"] == "revenue"} == {"4100"}
    assert november["policy"]["accounts"]["revenue"] == "4100"


def test_future_mapping_is_allowed_after_close_but_backdated_mapping_requires_reopen(tmp_path):
    application = app(tmp_path)
    seed(application)
    application.execute("close_period", {"period": "2026-09"}, period="2026-09")
    application.execute("set_policy", {"effective_period": "2026-10", "accounts": {"revenue": "4100"}}, period="2026-10")
    assert application.state(period="2026-09")["report"]["closed"] is True
    with pytest.raises(ValueError, match="closed period"):
        application.execute("set_policy", {"effective_period": "2026-09", "accounts": {"revenue": "4200"}}, period="2026-09")
    assert application.state(period="2026-09")["policy"]["accounts"]["revenue"] == "4000"


def test_same_month_mapping_uses_last_recorded_policy_and_keeps_versions(tmp_path):
    application = app(tmp_path)
    seed(application)
    application.execute("set_policy", {"effective_period": "2026-10", "accounts": {"revenue": "4100"}}, period="2026-10")
    application.execute("set_policy", {"effective_period": "2026-10", "accounts": {"billing_clearing": "1110"}}, period="2026-10")
    state = application.state(period="2026-10")
    assert [row["version"] for row in state["policy_versions"]] == [1, 2, 3]
    assert state["policy"]["accounts"]["revenue"] == "4100"
    assert state["policy"]["accounts"]["billing_clearing"] == "1110"


def test_backdated_role_change_flows_through_later_policy_without_overwriting_its_role(tmp_path):
    application = app(tmp_path)
    seed(application)
    application.execute("set_policy", {"effective_period": "2026-10", "accounts": {"revenue": "4100"}}, period="2026-10")
    application.execute("set_policy", {"effective_period": "2026-09", "accounts": {"billing_clearing": "1110"}}, period="2026-09")
    application.execute("record_billing", {"contract_id": "con_1", "effective_date": "2026-10-01", "amount": "100.00"}, period="2026-10")
    september = application.state(period="2026-09")
    october = application.state(period="2026-10")
    assert september["policy"]["accounts"]["billing_clearing"] == "1110"
    assert september["policy"]["accounts"]["revenue"] == "4000"
    assert october["policy"]["accounts"]["billing_clearing"] == "1110"
    assert october["policy"]["accounts"]["revenue"] == "4100"
    assert {row["account"] for row in october["report"]["journals"] if row["role"] == "billing_clearing"} == {"1110"}


def test_change_detail_replays_the_exact_financial_transition(tmp_path):
    application = app(tmp_path)
    seed(application)
    change = application.execute("record_billing", {
        "contract_id": "con_1", "effective_date": "2026-09-01", "amount": "12000.00", "reference": "INV-1",
    }, period="2026-09")["result"]["change_set_id"]
    application.execute("record_billing", {
        "contract_id": "con_1", "effective_date": "2026-10-01", "amount": "100.00", "reference": "INV-2",
    }, period="2026-10")
    detail = application.change_detail(change, "2026-09")
    assert detail["change"]["entity_name"] == "Annual service"
    assert detail["before_report"]["summary"]["billings"] == "0.00"
    assert detail["after_report"]["summary"]["billings"] == "12000.00"
    assert detail["comparison"]["summary"]["billings"] == "12000.00"
    assert detail["after_report"]["journals"] != detail["before_report"]["journals"]


def test_policy_change_detail_shows_journal_mapping_even_without_revenue_delta(tmp_path):
    application = app(tmp_path)
    seed(application)
    change = application.execute("set_policy", {"effective_period": "2026-10", "accounts": {"revenue": "4100"}}, period="2026-10")["result"]["change_set_id"]
    detail = application.change_detail(change, "2026-10")
    assert detail["before_policy"]["version"] == 1
    assert detail["after_policy"]["version"] == 2
    assert detail["comparison"]["summary"]["revenue"] == "0.00"
    assert "2026-10" in detail["comparison"]["affected_periods"]


def test_judgment_support_requires_evidence_linked_to_each_change(tmp_path):
    application = app(tmp_path)
    seed(application)
    first = application.execute("record_adjustment", {"contract_id": "con_1", "obligation_id": "pob_1", "effective_date": "2026-09-30", "amount": "10.00", "rationale": "Reviewed true-up"}, period="2026-09")["result"]["change_set_id"]
    second = application.execute("record_adjustment", {"contract_id": "con_1", "obligation_id": "pob_1", "effective_date": "2026-09-30", "amount": "5.00", "rationale": "Separate estimate"}, period="2026-09")["result"]["change_set_id"]
    folder = application.workspace.path / "attachments"
    (folder / "support.txt").write_text("Reviewed calculation")
    application.execute("attach_evidence", {"name": "support.txt", "path": "attachments/support.txt", "entity_id": "con_1"}, period="2026-09")
    assert {row["change_set_id"] for row in application.reports(period="2026-09")["exceptions"]["evidence"]} == {first, second}
    application.execute("attach_evidence", {"name": "support.txt", "path": "attachments/support.txt", "entity_id": "con_1", "target_change_set_id": first, "obligation_id": "pob_1"}, period="2026-09")
    review = application.reports(period="2026-09")
    assert [row["change_set_id"] for row in review["exceptions"]["evidence"]] == [second]
    assert application.change_detail(first, "2026-09")["evidence"][0]["target_change_set_id"] == first
    assert next(row for row in review["checks"] if row["id"] == "evidence")["target"] == {"view": "Activity", "id": second}


def test_change_detail_covers_modification_and_scenario_application(tmp_path):
    application = app(tmp_path)
    seed(application)
    scenario = application.execute("create_scenario", {"name": "Expanded scope"})["result"]["id"]
    modification = application.execute("modify_contract", {
        "contract_id": "con_1", "effective_date": "2026-10-01", "treatment": "prospective",
        "consideration": [{"id": "price_1", "label": "Fixed fee", "kind": "fixed", "amount": "18000.00"}],
        "rationale": "Expanded service",
    }, scenario_id=scenario, period="2026-10")["result"]["change_set_id"]
    proposed = application.change_detail(modification, "2026-10")
    assert proposed["comparison"]["summary"]["transaction_price"] == "6000.00"
    applied = application.execute("apply_scenario", {"scenario_id": scenario}, scenario_id=scenario, period="2026-10")["result"]["change_set_id"]
    accepted = application.change_detail(applied, "2026-10")
    assert accepted["before_report"]["summary"]["transaction_price"] == "12000.00"
    assert accepted["after_report"]["summary"]["transaction_price"] == "18000.00"
    assert accepted["comparison"]["summary"]["transaction_price"] == "6000.00"


def test_scenario_evidence_follows_the_accepted_judgment_without_copying_the_file(tmp_path):
    application = app(tmp_path)
    seed(application)
    scenario = application.execute("create_scenario", {"name": "Expanded scope"})["result"]["id"]
    proposal = application.execute("modify_contract", {
        "contract_id": "con_1", "effective_date": "2026-10-01", "treatment": "prospective",
        "consideration": [{"id": "price_1", "label": "Fixed fee", "kind": "fixed", "amount": "18000.00"}],
        "rationale": "Expanded service",
    }, scenario_id=scenario, period="2026-10")["result"]["change_set_id"]
    (application.workspace.path / "attachments" / "amendment.txt").write_text("Signed amendment")
    application.execute("attach_evidence", {"name": "amendment.txt", "path": "attachments/amendment.txt", "entity_id": "con_1", "target_change_set_id": proposal}, scenario_id=scenario, period="2026-10")
    application.execute("apply_scenario", {"scenario_id": scenario}, scenario_id=scenario, period="2026-10")
    accepted = next(row for row in application.state(period="2026-10")["change_sets"] if row.get("originating_change_set_id") == proposal)
    detail = application.change_detail(accepted["id"], "2026-10")
    assert detail["evidence"][0]["target_change_set_id"] == accepted["id"]
    assert detail["evidence"][0]["path"] == "attachments/amendment.txt"
    assert accepted["id"] not in {row["change_set_id"] for row in application.reports(period="2026-10")["exceptions"]["evidence"]}


def test_close_export_indexes_change_support_and_accepted_policy(tmp_path):
    application = app(tmp_path)
    seed(application)
    policy_change = application.execute("set_policy", {"effective_period": "2026-09", "accounts": {"revenue": "4100"}, "rationale": "Reviewed mapping"}, period="2026-09")["result"]["change_set_id"]
    application.execute("close_period", {"period": "2026-09", "rationale": "Reviewed close"}, period="2026-09")
    (application.workspace.path / "attachments" / "mapping.txt").write_text("Account memo")
    application.execute("attach_evidence", {"name": "mapping.txt", "path": "attachments/mapping.txt", "target_change_set_id": policy_change, "rationale": "Mapping memo"}, period="2026-09")
    bundle = application.report_bundle(period="2026-09")
    book = load_workbook(io.BytesIO(export_bytes(bundle["state"], bundle["review"])), read_only=True)
    assert book["Workspace"]["B13"].value is True
    assert book["Account policy"]["B2"].value == "4100" or any(row[1] == "4100" for row in book["Account policy"].values)
    support = list(book["Judgment support"].values)
    assert any(row[0] == policy_change and row[6] == "Supported" and "mapping.txt" in row[8] for row in support)
    assert any(row[4] == policy_change and row[8] == "attachments/mapping.txt" for row in book["Evidence index"].values)
    assert any(row[8] == 2 for row in book["Journal entries"].values if isinstance(row[8], int))
    book.close()


def test_legacy_policy_command_uses_its_recorded_effective_month(tmp_path):
    application = app(tmp_path)
    seed(application)
    with application.workspace.connect() as db:
        application._append(db, "set_policy", {"effective_date": "2026-10-01", "accounts": {"revenue": "4100"}}, "main", "legacy-test")
    assert application.state(period="2026-09")["policy"]["accounts"]["revenue"] == "4000"
    assert application.state(period="2026-10")["policy"]["accounts"]["revenue"] == "4100"


def test_historical_scenario_detail_keeps_its_original_main_base_after_rebase(tmp_path):
    application = app(tmp_path)
    seed(application)
    scenario = application.execute("create_scenario", {"name": "Billing proposal"})["result"]["id"]
    change = application.execute("record_billing", {"contract_id": "con_1", "effective_date": "2026-10-01", "amount": "100.00"}, scenario_id=scenario, period="2026-10")["result"]["change_set_id"]
    application.execute("create_customer", {"id": "cus_later", "name": "Later Main customer"})
    application.execute("rebase_scenario", {"scenario_id": scenario})
    detail = application.change_detail(change, "2026-10")
    assert {row["id"] for row in detail["before_state"]["customers"]} == {"cus_1"}
    assert detail["comparison"]["summary"]["billings"] == "100.00"
    assert {row["id"] for row in application.state(scenario, "2026-10")["customers"]} == {"cus_1", "cus_later"}


def test_reassessment_and_close_change_details_rebuild_their_recorded_transition(tmp_path):
    application = app(tmp_path)
    load_demo(application)
    reassessment = next(row for row in application.state(period="2026-09")["change_sets"] if row["command"] == "reassess_variable_consideration")
    detail = application.change_detail(reassessment["id"], "2026-09")
    assert detail["comparison"]["summary"]["transaction_price"] == "1000.00"
    assert detail["comparison"]["summary"]["revenue"] == "300.00"
    close = application.execute("close_period", {"period": "2026-09", "rationale": "Reviewed"}, period="2026-09")["result"]["change_set_id"]
    closed_detail = application.change_detail(close, "2026-09")
    assert closed_detail["before_report"].get("closed") is not True
    assert closed_detail["after_report"]["closed"] is True
