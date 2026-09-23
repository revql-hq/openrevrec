"""Prebuilt review views derived from canonical accounting state."""

from __future__ import annotations

from collections import Counter
from datetime import date, timedelta
from decimal import Decimal

from .application import JUDGMENT_COMMANDS, period_end, term_assessment_at


ZERO = Decimal("0")


def _amount(value: Decimal) -> str:
    return f"{value.quantize(Decimal('0.01')):.2f}"


def _decimal(value) -> Decimal:
    return Decimal(str(value or "0"))


def _population_comparison(state: dict, period: str, manifest: dict | None) -> dict:
    """Compare independent source identities with current Main source facts."""
    period_start, period_last = f"{period}-01", period_end(period)
    reported = {item["id"]: item for item in state["report"]["contracts"]}
    contracts = []
    for contract in state["contracts"]:
        row = reported.get(contract["id"])
        if not row or contract["start_date"] > period_last:
            continue
        effective_end = contract["end_date"]
        for activity in sorted(contract["activities"], key=lambda item: item["effective_date"]):
            if activity["type"] == "modification" and activity["effective_date"] <= period_last and "obligations" in activity:
                effective_end = (max(item["end_date"] for item in activity["obligations"])
                                 if activity["obligations"] else (date.fromisoformat(activity["effective_date"]) - timedelta(days=1)).isoformat())
        outstanding = any(_decimal(row[field]) != ZERO for field in ("contract_asset", "deferred_revenue", "remaining_revenue"))
        has_period_billing = any(item["type"] == "billing" and item["effective_date"][:7] == period for item in contract["activities"])
        if effective_end >= period_start or outstanding or has_period_billing:
            contracts.append(contract)
    actual_contracts = [reference for item in contracts
                        for reference in ([source["reference"] for source in item["source_contracts"]]
                                          if item.get("source_contracts") else [str(item.get("reference") or "").strip()])]
    unidentified_contracts = [{"id": item["id"], "name": item["name"]} for item in contracts
                              if not item.get("source_contracts") and not str(item.get("reference") or "").strip()]
    actual_contract_set = {item for item in actual_contracts if item}
    duplicate_contracts = sorted(item for item, count in Counter(actual_contracts).items() if item and count > 1)
    actual_billing_rows = [(contract, activity) for contract in state["contracts"] for activity in contract["activities"]
                           if activity["type"] == "billing" and activity["effective_date"][:7] == period]
    def billing_reference(activity):
        reference = str(activity.get("reference") or "").strip()
        identity = activity.get("import_source_identity")
        if reference:
            return reference
        if isinstance(identity, list) and len(identity) == 2 and identity[0] == "source_id":
            return str(identity[1]).strip()
        return ""
    actual_billings = [(str(activity.get("source_contract_reference") or contract.get("reference") or "").strip(), billing_reference(activity))
                       for contract, activity in actual_billing_rows]
    unidentified_billings = [{"contract_id": contract["id"], "activity_id": activity["id"]} for (contract, activity), key in zip(actual_billing_rows, actual_billings) if not all(key)]
    actual_billing_set = {key for key in actual_billings if all(key)}
    duplicate_billings = sorted(key for key, count in Counter(actual_billings).items() if all(key) and count > 1)
    actual_billing_by_key: dict[tuple[str, str], list[dict]] = {}
    for (_, activity), key in zip(actual_billing_rows, actual_billings):
        if all(key):
            actual_billing_by_key.setdefault(key, []).append(activity)
    actual_usage_rows = [(contract, activity) for contract in state["contracts"]
                         if len(contract["consideration"]) == 1 and contract["consideration"][0].get("metered_value_mode") == "invoice_value"
                         for activity in contract["activities"] if activity["type"] == "usage" and activity["effective_date"][:7] == period]
    actual_usage = [(str(activity.get("source_contract_reference") or contract.get("reference") or "").strip(), str(activity.get("reference") or "").strip())
                    for contract, activity in actual_usage_rows]
    unidentified_usage = [{"contract_id": contract["id"], "activity_id": activity["id"]}
                          for (contract, activity), key in zip(actual_usage_rows, actual_usage) if not all(key)]
    actual_usage_set = {key for key in actual_usage if all(key)}
    duplicate_usage = sorted(key for key, count in Counter(actual_usage).items() if all(key) and count > 1)
    actual_opening_rows = [(contract, activity) for contract in state["contracts"]
                           for activity in contract["activities"]
                           if activity["type"] == "opening_position" and activity["effective_date"][:7] == period]
    actual_openings = [(str(contract.get("reference") or "").strip(), activity["effective_date"])
                       for contract, activity in actual_opening_rows]
    unidentified_openings = [{"contract_id": contract["id"], "activity_id": activity["id"]}
                             for (contract, activity), key in zip(actual_opening_rows, actual_openings) if not all(key)]
    actual_opening_set = {key for key in actual_openings if all(key)}
    duplicate_openings = sorted(key for key, count in Counter(actual_openings).items() if all(key) and count > 1)
    actual_opening_by_key: dict[tuple[str, str], list[dict]] = {}
    for (_, activity), key in zip(actual_opening_rows, actual_openings):
        if all(key):
            actual_opening_by_key.setdefault(key, []).append(activity)
    expected_contracts = set(manifest["contract_references"]) if manifest else set()
    expected_billing_rows = manifest["billing_references"] if manifest else []
    expected_billings = {(item["contract_reference"], item["invoice_reference"]) for item in expected_billing_rows}
    billing_value_rows = []
    mismatched_billings = []
    unverified_billings = []
    for item in expected_billing_rows:
        key = item["contract_reference"], item["invoice_reference"]
        actual = actual_billing_by_key.get(key, [])
        row = {"contract_reference": key[0], "invoice_reference": key[1],
               "source_amount": item.get("amount", ""),
               "workspace_amount": actual[0]["amount"] if len(actual) == 1 else "",
               "activity_id": actual[0]["id"] if len(actual) == 1 else ""}
        if not actual:
            row["status"] = "Missing in workspace"
        elif len(actual) > 1:
            row["status"] = "Duplicate in workspace"
        elif "amount" not in item:
            row["status"] = "Source amount not supplied"
            unverified_billings.append(key)
        elif _decimal(item["amount"]) != _decimal(actual[0]["amount"]):
            row["status"] = "Amounts differ"
            mismatched_billings.append(row)
        else:
            row["status"] = "Matched"
        billing_value_rows.append(row)
    expected_usage_rows = manifest.get("usage_references", []) if manifest else []
    expected_usage = {(item["contract_reference"], item["usage_reference"]) for item in expected_usage_rows}
    actual_usage_by_key: dict[tuple[str, str], list[dict]] = {}
    for (_, activity), key in zip(actual_usage_rows, actual_usage):
        if all(key):
            actual_usage_by_key.setdefault(key, []).append(activity)
    usage_value_rows = []
    mismatched_usage = []
    unverified_usage = []
    for item in expected_usage_rows:
        key = item["contract_reference"], item["usage_reference"]
        actual = actual_usage_by_key.get(key, [])
        row = {"contract_reference": key[0], "usage_reference": key[1],
               "source_quantity": item.get("quantity", ""), "source_invoice_value": item.get("invoice_value", ""),
               "workspace_quantity": actual[0].get("quantity", "") if len(actual) == 1 else "",
               "workspace_invoice_value": actual[0].get("invoice_value", "") if len(actual) == 1 else "",
               "activity_id": actual[0]["id"] if len(actual) == 1 else ""}
        if not actual:
            row["status"] = "Missing in workspace"
        elif len(actual) > 1:
            row["status"] = "Duplicate in workspace"
        elif "quantity" not in item:
            row["status"] = "Source values not supplied"
            unverified_usage.append(key)
        elif (_decimal(item["quantity"]) != _decimal(actual[0]["quantity"])
              or _decimal(item["invoice_value"]) != _decimal(actual[0]["invoice_value"])):
            row["status"] = "Values differ"
            mismatched_usage.append(row)
        else:
            row["status"] = "Matched"
        usage_value_rows.append(row)
    source_openings_supplied = bool(manifest and "opening_positions" in manifest)
    expected_opening_rows = manifest.get("opening_positions", []) if manifest else []
    expected_openings = {(item["contract_reference"], item["cutover_date"]) for item in expected_opening_rows}
    opening_value_rows = []
    mismatched_openings = []
    for item in expected_opening_rows:
        key = item["contract_reference"], item["cutover_date"]
        actual = actual_opening_by_key.get(key, [])
        values = {field: actual[0][field] if len(actual) == 1 else "" for field in ("billed_to_date", "contract_asset", "deferred_revenue")}
        values["recognized_to_date"] = _amount(sum((_decimal(obligation["recognized_to_date"])
                                                       for obligation in actual[0]["opening_obligations"]), ZERO)) if len(actual) == 1 else ""
        row = {"contract_reference": key[0], "cutover_date": key[1],
               "source_values": {field: item[field] for field in values}, "workspace_values": values,
               "activity_id": actual[0]["id"] if len(actual) == 1 else ""}
        if not actual:
            row["status"] = "Missing in workspace"
        elif len(actual) > 1:
            row["status"] = "Duplicate in workspace"
        elif any(_decimal(item[field]) != _decimal(values[field]) for field in values):
            row["status"] = "Balances differ"
            mismatched_openings.append(row)
        else:
            row["status"] = "Matched"
        opening_value_rows.append(row)
    expected_obligation_rows = manifest.get("opening_obligations", []) if manifest else []
    obligations_by_opening: dict[tuple[str, str], list[dict]] = {}
    for item in expected_obligation_rows:
        obligations_by_opening.setdefault((item["contract_reference"], item["cutover_date"]), []).append(item)
    opening_obligation_rows = []
    missing_opening_obligations = []
    unexpected_opening_obligations = []
    unverified_opening_obligations = []
    mismatched_opening_obligations = []
    mismatched_source_opening_obligation_totals = []
    for opening in expected_opening_rows:
        key = opening["contract_reference"], opening["cutover_date"]
        source_rows = obligations_by_opening.get(key, [])
        actual = actual_opening_by_key.get(key, [])
        if not source_rows and len(actual) == 1 and len(actual[0]["opening_obligations"]) > 1:
            unverified_opening_obligations.append(key)
        if not source_rows:
            continue
        source_total = sum((_decimal(row["recognized_to_date"]) for row in source_rows), ZERO)
        if source_total != _decimal(opening["recognized_to_date"]):
            mismatched_source_opening_obligation_totals.append({
                "contract_reference": key[0], "cutover_date": key[1],
                "source_total": _amount(source_total), "source_opening_total": opening["recognized_to_date"],
            })
        actual_by_id = {row["obligation_id"]: row for row in actual[0]["opening_obligations"]} if len(actual) == 1 else {}
        source_ids = {row["obligation_id"] for row in source_rows}
        if len(actual) == 1:
            for obligation_id in sorted(actual_by_id.keys() - source_ids):
                unexpected_opening_obligations.append((key[0], key[1], obligation_id))
                opening_obligation_rows.append({
                    "contract_reference": key[0], "cutover_date": key[1], "obligation_id": obligation_id,
                    "source_amount": "", "workspace_amount": actual_by_id[obligation_id]["recognized_to_date"],
                    "activity_id": actual[0]["id"], "status": "Obligation not in source",
                })
        for source_row in source_rows:
            obligation_id = source_row["obligation_id"]
            workspace_row = actual_by_id.get(obligation_id)
            result = {"contract_reference": key[0], "cutover_date": key[1], "obligation_id": obligation_id,
                      "source_amount": source_row["recognized_to_date"],
                      "workspace_amount": workspace_row["recognized_to_date"] if workspace_row else "",
                      "activity_id": actual[0]["id"] if len(actual) == 1 else ""}
            if not actual:
                result["status"] = "Opening missing in workspace"
            elif len(actual) > 1:
                result["status"] = "Duplicate opening in workspace"
            elif not workspace_row:
                result["status"] = "Obligation missing in workspace"
                missing_opening_obligations.append((key[0], key[1], obligation_id))
            elif _decimal(source_row["recognized_to_date"]) != _decimal(workspace_row["recognized_to_date"]):
                result["status"] = "Recognized amount differs"
                mismatched_opening_obligations.append(result)
            else:
                result["status"] = "Matched"
            opening_obligation_rows.append(result)
    return {
        "source_name": manifest["source_name"] if manifest else "",
        "expected_contract_count": len(expected_contracts), "actual_contract_count": len(actual_contracts),
        "expected_billing_count": len(expected_billings), "actual_billing_count": len(actual_billing_rows),
        "expected_usage_count": len(expected_usage), "actual_usage_count": len(actual_usage_rows),
        "missing_contracts": sorted(expected_contracts - actual_contract_set),
        "unexpected_contracts": sorted(actual_contract_set - expected_contracts),
        "unidentified_contracts": unidentified_contracts, "duplicate_contracts": duplicate_contracts,
        "missing_billings": sorted(expected_billings - actual_billing_set),
        "unexpected_billings": sorted(actual_billing_set - expected_billings),
        "unidentified_billings": unidentified_billings, "duplicate_billings": duplicate_billings,
        "unverified_billings": unverified_billings, "mismatched_billings": mismatched_billings,
        "billing_value_rows": billing_value_rows,
        "missing_usage": sorted(expected_usage - actual_usage_set),
        "unexpected_usage": sorted(actual_usage_set - expected_usage),
        "unidentified_usage": unidentified_usage, "duplicate_usage": duplicate_usage,
        "unverified_usage": unverified_usage, "mismatched_usage": mismatched_usage,
        "usage_value_rows": usage_value_rows,
        "source_openings_supplied": source_openings_supplied,
        "expected_opening_count": len(expected_openings), "actual_opening_count": len(actual_opening_rows),
        "missing_openings": sorted(expected_openings - actual_opening_set),
        "unexpected_openings": sorted(actual_opening_set - expected_openings) if source_openings_supplied else [],
        "unidentified_openings": unidentified_openings,
        "duplicate_openings": duplicate_openings,
        "unverified_openings": sorted(actual_opening_set) if manifest and not source_openings_supplied else [],
        "mismatched_openings": mismatched_openings,
        "opening_value_rows": opening_value_rows,
        "expected_opening_obligation_count": len(expected_obligation_rows),
        "missing_opening_obligations": missing_opening_obligations,
        "unexpected_opening_obligations": unexpected_opening_obligations,
        "unverified_opening_obligations": unverified_opening_obligations,
        "mismatched_opening_obligations": mismatched_opening_obligations,
        "mismatched_source_opening_obligation_totals": mismatched_source_opening_obligation_totals,
        "opening_obligation_rows": opening_obligation_rows,
    }


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
    population_manifest = next((item for item in state.get("population_manifests", []) if item["period"] == period), None)
    population_comparison = _population_comparison(state, period, population_manifest)
    closed_population = next((item.get("population_comparison") for item in state["closes"] if item["period"] == period and item["status"] == "closed"), None)
    if closed_population:
        population_comparison = closed_population
    population_exceptions = sum(len(value) for key, value in population_comparison.items() if key.startswith(("missing_", "unexpected_", "unidentified_", "duplicate_", "unverified_", "mismatched_")))
    open_tasks = [note for note in state["notes"] if note.get("kind") == "task" and not note.get("completed")]
    due_tasks = [note for note in open_tasks if (note.get("due_date") and note["due_date"] <= period_end(period)) or (note.get("period") and note["period"] <= period)]
    due_term_reviews = []
    for contract in state["contracts"]:
        if contract["start_date"] > period_end(period):
            continue
        assessment = term_assessment_at(state, contract, period_end(period))
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
    details = report.get("warning_details", [])
    if len(details) != len(report["warnings"]) or any(item["message"] != warning for item, warning in zip(details, report["warnings"])):
        details = []  # Older close checkpoints have message text but no source IDs.
    warning_targets = [{"message": warning, "contract_id": None, "obligation_id": None, "related_contract_id": None,
                        **(details[index] if details else {})} for index, warning in enumerate(report["warnings"])]

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
        _check("source_population", "Source contract, invoice, usage, and opening population", bool(population_manifest) and not population_exceptions,
               "Contract, invoice, priced-usage, and cutover-opening source records match." if population_manifest and not population_exceptions else f"{population_exceptions} source record exception(s) need review." if population_manifest else "No independent contract, invoice, priced-usage, or cutover-opening source lists have been entered for this period.",
               "review", population_exceptions if population_manifest else 1),
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
    if report.get("runoff_active"):
        pending_runoff = report.get("runoff_unresolved", report.get("runoff_pending", []))
        checks.insert(3, _check("account_runoff", "Historical account runoff allocated", not pending_runoff,
                                "Every historical account balance has an explicit closing allocation." if not pending_runoff else f"{len(pending_runoff)} contract-period balance(s) need an account allocation before close, including earlier periods.",
                                "block", len(pending_runoff)))
    if report.get("policy_account_dimension_rules"):
        invalid = report.get("account_dimension_exceptions", [])
        uncovered = report.get("account_dimension_unvalidated_accounts", [])
        checks.insert(1, _check(
            "account_dimensions", "Approved account and dimension combinations", not invalid and not uncovered,
            (f"{len(invalid)} journal line(s) use a combination outside the supplied chart."
             if invalid else f"{len(uncovered)} journal account(s) are absent from the supplied chart."
             if uncovered else "Every journal line matches a supplied approved combination."),
            "block" if invalid or (uncovered and report.get("policy_account_dimension_coverage") == "complete") else "review",
            len(invalid) if invalid else len(uncovered),
        ))
    targets = {
        "journal": {"view": "Journal entries"},
        "account_dimensions": {"view": "Journal entries"},
        "allocation": {"view": "Contracts", "id": allocation_mismatches[0]["id"], "tab": "Allocation"} if allocation_mismatches else {"view": "Contracts"},
        "cutover": {"view": "Contracts", "id": pending_cutovers[0]["id"], "tab": "Overview"} if pending_cutovers else {"view": "Contracts"},
        "account_runoff": {"view": "Journal entries"},
        "external_controls": {"view": "Reports", "tab": "External controls"},
        "source_population": {"view": "Reports", "tab": "Source population"},
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
        "population_manifest": population_manifest, "population_comparison": population_comparison,
        "recognition_coverage": coverage, "scenario_impacts": scenario_impacts or [],
        "exceptions": {"allocation": allocation_mismatches, "account_dimensions": report.get("account_dimension_exceptions", []), "cutover": pending_cutovers, "warnings": warning_targets, "tasks": due_tasks, "term_reviews": due_term_reviews, "cutoff": late_changes,
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
