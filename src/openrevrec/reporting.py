"""Prebuilt review views derived from canonical accounting state."""

from __future__ import annotations

from decimal import Decimal

from .application import period_end


ZERO = Decimal("0")


def _amount(value: Decimal) -> str:
    return f"{value.quantize(Decimal('0.01')):.2f}"


def _decimal(value) -> Decimal:
    return Decimal(str(value or "0"))


def build_review(state: dict, scenario_impacts: list[dict] | None = None) -> dict:
    """Build close-oriented views without changing accounting state."""
    report = state["report"]
    period = report["period"]
    future_by_contract: dict[str, Decimal] = {}
    scheduled_by_obligation: dict[tuple[str, str], dict[str, Decimal]] = {}
    for row in report["schedule"]:
        key = (row["contract_id"], row["obligation_id"])
        bucket = scheduled_by_obligation.setdefault(key, {"past": ZERO, "future": ZERO})
        bucket["future" if row["period"] > period else "past"] += _decimal(row["revenue"])
        if row["period"] > period:
            contract_id = row["contract_id"]
            future_by_contract[contract_id] = future_by_contract.get(contract_id, ZERO) + _decimal(row["revenue"])

    rollforward = []
    billing_vs_revenue = []
    coverage = []
    for contract in report["contracts"]:
        revenue = _decimal(contract["revenue"])
        billings = _decimal(contract["billings"])
        recognized = _decimal(contract["recognized_to_date"])
        billed = _decimal(contract["billed_to_date"])
        opening_net = (recognized - revenue) - (billed - billings)
        closing_net = recognized - billed
        rollforward.append({
            "contract_id": contract["id"], "contract_name": contract["name"],
            "opening_contract_asset": _amount(max(ZERO, opening_net)),
            "opening_deferred_revenue": _amount(max(ZERO, -opening_net)),
            "revenue": _amount(revenue), "billings": _amount(billings),
            "closing_contract_asset": _amount(max(ZERO, closing_net)),
            "closing_deferred_revenue": _amount(max(ZERO, -closing_net)),
        })
        billing_vs_revenue.append({
            "contract_id": contract["id"], "contract_name": contract["name"],
            "revenue": _amount(revenue), "billings": _amount(billings),
            "net_movement": _amount(revenue - billings),
            "closing_contract_asset": _amount(max(ZERO, closing_net)),
            "closing_deferred_revenue": _amount(max(ZERO, -closing_net)),
        })
        remaining = max(ZERO, _decimal(contract["remaining_revenue"]))
        scheduled = max(ZERO, future_by_contract.get(contract["id"], ZERO))
        gap = max(ZERO, remaining - scheduled)
        obligation_gaps = []
        for allocation in contract["allocation"]:
            bucket = scheduled_by_obligation.get((contract["id"], allocation["obligation_id"]), {"past": ZERO, "future": ZERO})
            missing = max(ZERO, _decimal(allocation["amount"]) - bucket["past"] - bucket["future"])
            if missing:
                obligation_gaps.append({"obligation_id": allocation["obligation_id"], "name": allocation["name"], "unscheduled": _amount(missing)})
        coverage.append({
            "contract_id": contract["id"], "contract_name": contract["name"],
            "remaining_revenue": _amount(remaining), "future_scheduled": _amount(scheduled),
            "unscheduled": _amount(gap), "status": "gap" if gap else "covered", "obligation_gaps": obligation_gaps,
        })

    debit = sum((_decimal(row["debit"]) for row in report["journals"]), ZERO)
    credit = sum((_decimal(row["credit"]) for row in report["journals"]), ZERO)
    allocation_mismatches = [
        contract for contract in report["contracts"]
        if sum((_decimal(row["amount"]) for row in contract["allocation"]), ZERO) != _decimal(contract["transaction_price"])
    ]
    open_tasks = [note for note in state["notes"] if note.get("kind") == "task" and not note.get("completed")]
    due_tasks = [note for note in open_tasks if note.get("due_date") and note["due_date"] <= period_end(period)]
    gaps = [row for row in coverage if _decimal(row["unscheduled"]) != ZERO]
    active_scenarios = [row for row in state["scenarios"] if row["id"] != "main" and row["status"] == "active"]
    supported_changes = {row.get("target_change_set_id") for row in state.get("evidence", [])}
    judgment_commands = {"modify_contract", "reassess_variable_consideration", "record_adjustment", "set_policy", "reopen_period"}
    entity_names = {row["id"]: row["name"] for row in state["contracts"] + state["customers"]}
    unsupported_judgments = [
        {"change_set_id": row["id"], "command": row["command"], "entity_id": row["entity_id"],
         "entity_name": entity_names.get(row["entity_id"], row["entity_id"]),
         "effective_date": row["effective_date"], "rationale": row.get("rationale", "")}
        for row in state["change_sets"]
        if row["command"] in judgment_commands and row["effective_date"] <= period_end(period)
        and row["id"] not in supported_changes
    ]
    late_changes = [
        row for row in state["change_sets"]
        if row.get("effective_date", "") <= period_end(period)
        and row.get("recorded_at", "")[:10] > period_end(period)
        and row["command"] not in {"create_customer", "edit_details", "add_note", "edit_note", "attach_evidence", "close_period", "create_scenario", "apply_scenario", "rebase_scenario", "archive_scenario", "restore_scenario"}
    ]
    warning_targets = []
    for warning in report["warnings"]:
        match = next((c for c in state["contracts"] if warning.startswith(c["name"] + ":") or warning.startswith(c["name"] + " / ")), None)
        obligation = next((o for o in match["obligations"] if f" / {o['name']}:" in warning), None) if match else None
        warning_targets.append({"message": warning, "contract_id": match["id"] if match else None,
                                "obligation_id": obligation["id"] if obligation else None})

    checks = [
        _check("journal", "Journal balances", debit == credit,
               "Debits and credits agree." if debit == credit else f"Journal is out of balance by {_amount(debit - credit)}.",
               "block", 0 if debit == credit else 1),
        _check("allocation", "Allocations reconcile", not allocation_mismatches,
               "Allocated consideration agrees to transaction price." if not allocation_mismatches else f"{len(allocation_mismatches)} contract allocation(s) do not reconcile.",
               "block", len(allocation_mismatches)),
        _check("warnings", "Accounting warnings", not report["warnings"],
               "No calculation warnings." if not report["warnings"] else f"{len(report['warnings'])} warning(s) need review.",
               "review", len(report["warnings"])),
        _check("tasks", "Close tasks due", not due_tasks,
               "No open tasks due by period end." if not due_tasks else f"{len(due_tasks)} task(s) are due by period end.",
               "review", len(due_tasks)),
        _check("cutoff", "Post-period entries", not late_changes,
               "No entries affecting this period were recorded after period end." if not late_changes else f"{len(late_changes)} entry or entries affecting this period were recorded after period end.",
               "review", len(late_changes)),
        _check("coverage", "Remaining revenue scheduled", not gaps,
               "Remaining revenue has a future schedule." if not gaps else f"{len(gaps)} contract(s) have unscheduled remaining revenue.",
               "review", len(gaps)),
        _check("scenarios", "Open accounting scenarios", not active_scenarios,
               "No active proposals remain." if not active_scenarios else f"{len(active_scenarios)} active scenario(s) remain outside Main.",
               "review", len(active_scenarios)),
        _check("evidence", "Judgment changes supported", not unsupported_judgments,
               "Every judgment change has linked evidence." if not unsupported_judgments else f"{len(unsupported_judgments)} judgment change(s) lack linked evidence.",
               "review", len(unsupported_judgments)),
    ]
    targets = {
        "journal": {"view": "Journal entries"},
        "allocation": {"view": "Contracts", "id": allocation_mismatches[0]["id"], "tab": "Allocation"} if allocation_mismatches else {"view": "Contracts"},
        "warnings": {"view": "Contracts", "id": warning_targets[0]["contract_id"], "tab": "Recognition", "obligation_id": warning_targets[0]["obligation_id"]} if warning_targets and warning_targets[0]["contract_id"] else {"view": "Revenue"},
        "tasks": ({"view": "Contracts", "id": due_tasks[0]["entity_id"], "tab": "Notes"} if due_tasks[0].get("entity_id") in {c["id"] for c in state["contracts"]} else {"view": "Customers", "id": due_tasks[0]["entity_id"]}) if due_tasks and due_tasks[0].get("entity_id") in entity_names else {"view": "Home"},
        "cutoff": {"view": "Activity", "id": late_changes[0]["id"]} if late_changes else {"view": "Activity"},
        "coverage": {"view": "Contracts", "id": gaps[0]["contract_id"], "tab": "Recognition", "obligation_id": gaps[0]["obligation_gaps"][0]["obligation_id"] if gaps[0]["obligation_gaps"] else None} if gaps else {"view": "Revenue"},
        "scenarios": {"view": "Scenarios", "id": active_scenarios[0]["id"]} if active_scenarios else {"view": "Scenarios"},
        "evidence": {"view": "Activity", "id": unsupported_judgments[0]["change_set_id"]} if unsupported_judgments else {"view": "Activity"},
    }
    for check in checks:
        check["target"] = targets[check["id"]]
    overall = "blocked" if any(row["status"] == "block" for row in checks) else "review" if any(row["status"] == "review" for row in checks) else "ready"
    if report.get("closed"):
        overall = "closed"
    return {
        "period": period, "scenario_id": state["scenario_id"], "status": overall,
        "checks": checks, "warnings": list(report["warnings"]),
        "rollforward": rollforward, "billing_vs_revenue": billing_vs_revenue,
        "recognition_coverage": coverage, "scenario_impacts": scenario_impacts or [],
        "exceptions": {"allocation": allocation_mismatches, "warnings": warning_targets, "tasks": due_tasks, "cutoff": late_changes,
                       "coverage": gaps, "scenarios": active_scenarios, "evidence": unsupported_judgments},
        "counts": {
            "contracts": len(report["contracts"]), "open_tasks": len(open_tasks),
            "due_tasks": len(due_tasks), "coverage_gaps": len(gaps),
            "active_scenarios": len(active_scenarios), "warnings": len(report["warnings"]),
            "late_changes": len(late_changes),
            "unsupported_judgments": len(unsupported_judgments),
        },
    }


def _check(identifier: str, label: str, passed: bool, detail: str, failure: str, count: int) -> dict:
    return {"id": identifier, "label": label, "status": "pass" if passed else failure, "detail": detail, "count": count}
