"""Prebuilt review views derived from canonical accounting state."""

from __future__ import annotations

from decimal import Decimal

from .application import JUDGMENT_COMMANDS, period_end


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
    opening_by_obligation = {(contract["id"], row["obligation_id"]): _decimal(row["recognized_to_date"])
                             for contract in state["contracts"] for activity in contract["activities"]
                             if activity["type"] == "opening_position" and activity["effective_date"][:7] <= period
                             for row in activity["opening_obligations"]}
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
            missing = max(ZERO, _decimal(allocation["amount"]) - opening_by_obligation.get((contract["id"], allocation["obligation_id"]), ZERO) - bucket["past"] - bucket["future"])
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
    pending_cutovers = [contract for contract in state["contracts"]
                        if contract.get("cutover_date") and contract["cutover_date"][:7] <= period
                        and not any(activity["type"] == "opening_position" for activity in contract["activities"])]
    control = next((item for item in state.get("controls", []) if item["period"] == period), None)
    control_fields = ("billings", "contract_asset", "deferred_revenue")
    control_comparison = {
        field: {"derived": report["summary"][field], "external": control[field],
                "difference": _amount(_decimal(report["summary"][field]) - _decimal(control[field]))}
        for field in control_fields
    } if control else {}
    control_differences = [field for field, values in control_comparison.items() if _decimal(values["difference"]) != ZERO]
    open_tasks = [note for note in state["notes"] if note.get("kind") == "task" and not note.get("completed")]
    due_tasks = [note for note in open_tasks if (note.get("due_date") and note["due_date"] <= period_end(period)) or (note.get("period") and note["period"] <= period)]
    due_term_reviews = []
    for contract in state["contracts"]:
        if contract["start_date"] > period_end(period):
            continue
        assessment = {field: contract.get(field, "") for field in ("term_basis", "term_assessment_rationale", "term_reassessment_trigger", "term_review_date")}
        assessment["term_basis"] = assessment["term_basis"] or "fixed"
        for activity in sorted(contract["activities"], key=lambda item: (item["effective_date"], item.get("recorded_at", ""))):
            if activity["effective_date"] > period_end(period) or activity["type"] != "modification":
                continue
            if activity.get("term_basis") == "fixed":
                assessment = {field: "" for field in assessment}
            assessment.update({field: activity[field] for field in assessment if field in activity})
        if assessment["term_basis"] != "fixed" and assessment["term_review_date"] and assessment["term_review_date"] <= period_end(period):
            due_term_reviews.append({"id": contract["id"], "name": contract["name"], "review_date": assessment["term_review_date"], "trigger": assessment["term_reassessment_trigger"]})
    gaps = [row for row in coverage if _decimal(row["unscheduled"]) != ZERO]
    manual_methods = {"progress", "usage"}
    expected_manual_gaps = []
    review_gaps = []
    for gap in gaps:
        contract = next((item for item in state["contracts"] if item["id"] == gap["contract_id"]), None)
        if contract is None:
            review_gaps.append(gap)
            continue
        obligations = contract["obligations"]
        for activity in sorted(contract["activities"], key=lambda item: (item["effective_date"], item.get("recorded_at", ""))):
            if activity["effective_date"] <= period_end(period) and activity["type"] == "modification":
                obligations = activity.get("obligations", obligations)
        methods = {item["id"]: item["method"] for item in obligations}
        if gap["obligation_gaps"] and all(methods.get(item["obligation_id"]) in manual_methods for item in gap["obligation_gaps"]):
            expected_manual_gaps.append(gap)
        else:
            review_gaps.append(gap)
    relevant_scenarios = {impact["scenario_id"] for impact in scenario_impacts or []
                          if any(changed <= period for changed in impact["affected_periods"])}
    active_scenarios = [row for row in state["scenarios"] if row["id"] in relevant_scenarios and row["status"] == "active"]
    reviews_by_change = {}
    for review in state.get("judgment_reviews", []):
        reviews_by_change[review["target_change_set_id"]] = review
    files_by_change = {}
    for file in state.get("evidence", []):
        files_by_change[file.get("target_change_set_id")] = files_by_change.get(file.get("target_change_set_id"), 0) + 1
    entity_names = {row["id"]: row["name"] for row in state["contracts"] + state["customers"]}
    unsupported_judgments = [
        {"change_set_id": row["id"], "command": row["command"], "entity_id": row["entity_id"],
         "entity_name": entity_names.get(row["entity_id"], row["entity_id"]),
         "effective_date": row["effective_date"], "rationale": row.get("rationale", ""),
         "review_status": reviews_by_change.get(row["id"], {}).get("disposition", "missing"),
         "linked_file_count": files_by_change.get(row["id"], 0)}
        for row in state["change_sets"]
        if row["command"] in JUDGMENT_COMMANDS and row["effective_date"] <= period_end(period)
        and reviews_by_change.get(row["id"], {}).get("disposition") != "supported"
    ]
    cutoff_date = control.get("close_cutoff_date") if control else None
    cutoff_date = cutoff_date or period_end(period)
    late_changes = [
        row for row in state["change_sets"]
        if row.get("effective_date", "") <= period_end(period)
        and row.get("recorded_at", "")[:10] > cutoff_date
        and row["command"] not in {"create_customer", "edit_details", "add_note", "edit_note", "attach_evidence", "record_judgment_review", "record_control_totals", "record_export_posting", "close_period", "create_scenario", "apply_scenario", "rebase_scenario", "archive_scenario", "restore_scenario"}
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
        _check("cutover", "Declared cutovers have opening positions", not pending_cutovers,
               "Every contract due for cutover has an accepted opening position." if not pending_cutovers else f"{len(pending_cutovers)} contract(s) need a reconciled opening position before close.",
               "block", len(pending_cutovers)),
        _check("external_controls", "Independent source and GL controls", bool(control) and not control_differences,
               "Entered source billing and GL balances agree to this model; confirm the source basis separately." if control and not control_differences else f"{len(control_differences)} external total(s) differ from the model." if control else "No independent source billing and GL balance totals have been entered for this period.",
               "review", len(control_differences) if control else 1),
        _check("warnings", "Accounting warnings", not report["warnings"],
               "No calculation warnings." if not report["warnings"] else f"{len(report['warnings'])} warning(s) need review.",
               "review", len(report["warnings"])),
        _check("tasks", "Close tasks due", not due_tasks,
               "No open tasks due by period end." if not due_tasks else f"{len(due_tasks)} task(s) are due by period end.",
               "review", len(due_tasks)),
        _check("term_reviews", "Contract term assessments due", not due_term_reviews,
               "No planned term assessments are due." if not due_term_reviews else f"{len(due_term_reviews)} cancellable or evergreen term assessment(s) need review.",
               "review", len(due_term_reviews)),
        _check("cutoff", "Entries after close cutoff", not late_changes,
               f"No entries affecting this period were recorded after {cutoff_date}." if not late_changes else f"{len(late_changes)} entry or entries affecting this period were recorded after {cutoff_date}.",
               "review", len(late_changes)),
        _check("coverage", "Remaining revenue scheduled", not review_gaps,
               f"No unexpected schedule gaps. {len(expected_manual_gaps)} contract(s) need future satisfaction facts." if not review_gaps else f"{len(review_gaps)} contract(s) have unexplained schedule gaps.",
               "review", len(review_gaps)),
        _check("scenarios", "Open accounting scenarios affecting this period", not active_scenarios,
               "No active proposals affect this period or earlier periods." if not active_scenarios else f"{len(active_scenarios)} active scenario(s) affect this period or earlier periods.",
               "review", len(active_scenarios)),
        _check("evidence", "Judgment conclusions reviewed", not unsupported_judgments,
               "Every judgment change has a supported review record." if not unsupported_judgments else f"{len(unsupported_judgments)} judgment change(s) lack a supported review record or have an open exception.",
               "review", len(unsupported_judgments)),
    ]
    targets = {
        "journal": {"view": "Journal entries"},
        "allocation": {"view": "Contracts", "id": allocation_mismatches[0]["id"], "tab": "Allocation"} if allocation_mismatches else {"view": "Contracts"},
        "cutover": {"view": "Contracts", "id": pending_cutovers[0]["id"], "tab": "Overview"} if pending_cutovers else {"view": "Contracts"},
        "external_controls": {"view": "Reports", "tab": "External controls"},
        "warnings": {"view": "Contracts", "id": warning_targets[0]["contract_id"], "tab": "Recognition", "obligation_id": warning_targets[0]["obligation_id"]} if warning_targets and warning_targets[0]["contract_id"] else {"view": "Revenue"},
        "tasks": ({"view": "Contracts", "id": due_tasks[0]["entity_id"], "tab": "Notes"} if due_tasks[0].get("entity_id") in {c["id"] for c in state["contracts"]} else {"view": "Customers", "id": due_tasks[0]["entity_id"]}) if due_tasks and due_tasks[0].get("entity_id") in entity_names else {"view": "Home"},
        "term_reviews": {"view": "Contracts", "id": due_term_reviews[0]["id"], "tab": "Overview"} if due_term_reviews else {"view": "Contracts"},
        "cutoff": {"view": "Activity", "id": late_changes[0]["id"]} if late_changes else {"view": "Activity"},
        "coverage": {"view": "Contracts", "id": review_gaps[0]["contract_id"], "tab": "Recognition", "obligation_id": review_gaps[0]["obligation_gaps"][0]["obligation_id"] if review_gaps[0]["obligation_gaps"] else None} if review_gaps else {"view": "Revenue"},
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
        "external_control": control, "external_control_comparison": control_comparison,
        "recognition_coverage": coverage, "scenario_impacts": scenario_impacts or [],
        "exceptions": {"allocation": allocation_mismatches, "cutover": pending_cutovers, "warnings": warning_targets, "tasks": due_tasks, "term_reviews": due_term_reviews, "cutoff": late_changes,
                       "coverage": gaps, "scenarios": active_scenarios, "evidence": unsupported_judgments},
        "counts": {
            "contracts": len(report["contracts"]), "open_tasks": len(open_tasks),
            "due_tasks": len(due_tasks), "due_term_reviews": len(due_term_reviews), "coverage_gaps": len(gaps),
            "active_scenarios": len(active_scenarios), "warnings": len(report["warnings"]),
            "late_changes": len(late_changes),
            "unsupported_judgments": len(unsupported_judgments),
        },
    }


def _check(identifier: str, label: str, passed: bool, detail: str, failure: str, count: int) -> dict:
    return {"id": identifier, "label": label, "status": "pass" if passed else failure, "detail": detail, "count": count}
