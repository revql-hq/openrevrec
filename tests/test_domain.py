"""Reviewed synthetic accounting examples; no mocked engine or data store."""

from copy import deepcopy
from decimal import Decimal

import pytest

from openrevrec.domain import allocate, calculate, validate_contract


def obligation(identifier="service", *, method="monthly", ssp="1200.00", **fields):
    return {"id": identifier, "name": identifier.title(), "kind": "service", "ssp": ssp,
            "method": method, "start_date": "2026-01-01", "end_date": "2026-12-31", **fields}


def contract(*, price="1200.00", obligations=None, activities=None, **fields):
    return {"id": "contract", "name": "Example", "customer_id": "customer",
            "start_date": "2026-01-01", "end_date": "2026-12-31",
            "consideration": [{"id": "fixed", "label": "Fixed fee", "kind": "fixed", "amount": price}],
            "obligations": obligations or [obligation()], "activities": activities or [], **fields}


def event(kind, day="2026-01-01", **fields):
    return {"type": kind, "effective_date": day, **fields}


def report(item, period="2026-01"):
    return calculate({"contracts": [item]}, period)


def summary(item, period="2026-01"):
    return report(item, period)["summary"]


def revenue_by_month(result):
    rows = {}
    for row in result["schedule"]:
        rows[row["period"]] = rows.get(row["period"], Decimal(0)) + Decimal(row["revenue"])
    return rows


def assert_balanced(result):
    entries = result["journals"]
    assert sum(row["debit_minor"] for row in entries) == sum(row["credit_minor"] for row in entries)
    for row in entries:
        assert Decimal(row["debit"]) * 100 == row["debit_minor"]
        assert Decimal(row["credit"]) * 100 == row["credit_minor"]
        assert row["debit_minor"] == 0 or row["credit_minor"] == 0


def test_largest_remainder_is_exact_and_has_stable_identifier_ties():
    assert allocate("100.00", {"z": "1", "b": "1", "a": "1"}) == {
        "z": Decimal("33.33"), "b": Decimal("33.33"), "a": Decimal("33.34")}
    assert allocate("-0.01", {"b": "1", "a": "1"}) == {"b": Decimal("0"), "a": Decimal("-0.01")}
    assert allocate("0.00", {"none": "0"}) == {"none": Decimal("0")}


def test_allocation_reconciles_with_high_precision_ssp_and_subcent_total():
    result = allocate("123456.785", {"a": "1.000001", "b": "333.333333", "c": "0"})
    assert sum(result.values()) == Decimal("123456.79")
    assert result["c"] == 0


@pytest.mark.parametrize("total,weights", [("1", {"a": "0"}), ("1", {"a": "-1"}), ("NaN", {"a": "1"}), (1.2, {"a": "1"})])
def test_invalid_allocations_raise_clear_errors(total, weights):
    with pytest.raises(ValueError):
        allocate(total, weights)


def test_prepaid_saas_recognition_deferred_and_balanced_journal():
    item = contract(activities=[event("billing", amount="1200")])
    result = report(item)
    assert result["summary"] == {
        "transaction_price": "1200.00", "revenue": "100.00", "recognized_to_date": "100.00",
        "billings": "1200.00", "billed_to_date": "1200.00", "deferred_revenue": "1100.00",
        "contract_asset": "0.00", "remaining_revenue": "1100.00"}
    assert_balanced(result)
    assert [(row["role"], row["debit"], row["credit"]) for row in result["journals"]] == [
        ("billing_clearing", "1200.00", "0.00"), ("deferred_revenue", "0.00", "1100.00"), ("revenue", "0.00", "100.00")]
    assert summary(item, "2026-12")["remaining_revenue"] == "0.00"


def test_exact_days_include_both_endpoints_and_leap_day():
    item = contract(price="600", start_date="2024-01-31", end_date="2024-03-30", obligations=[
        obligation(method="exact_days", start_date="2024-01-31", end_date="2024-03-30")])
    months = revenue_by_month(report(item, "2024-02"))
    assert months == {"2024-01": Decimal("10.00"), "2024-02": Decimal("290.00"), "2024-03": Decimal("300.00")}


def test_exact_days_round_cumulative_values_and_reconcile_all_cents():
    item = contract(price="100", obligations=[obligation(method="exact_days")])
    months = revenue_by_month(report(item))
    assert months["2026-01"] == Decimal("8.49")
    assert months["2026-02"] == Decimal("7.67")
    assert sum(months.values()) == Decimal("100")


def test_monthly_gives_partial_first_and_last_month_equal_weight():
    item = contract(price="300", obligations=[obligation(start_date="2026-01-20", end_date="2026-03-02")])
    months = revenue_by_month(report(item))
    assert [months[month] for month in ["2026-01", "2026-02", "2026-03"]] == [Decimal("100")] * 3
    assert sum(months.values()) == Decimal("300")


def test_prorated_calendar_months_weight_partial_months_and_reconcile():
    item = contract(price="300", obligations=[obligation(method="prorated_monthly", start_date="2026-01-20", end_date="2026-03-02")])
    months = revenue_by_month(report(item))
    assert {period: value for period, value in months.items() if value} == {"2026-01": Decimal("80.00"), "2026-02": Decimal("206.67"), "2026-03": Decimal("13.33")}
    assert sum(months.values()) == Decimal("300.00")


def test_point_in_time_requires_satisfaction_and_billing_never_implies_it():
    item = contract(obligations=[obligation(method="point_in_time")], activities=[event("billing", amount="1200")])
    assert summary(item)["revenue"] == "0.00"
    assert report(item)["warnings"]
    item["activities"].append(event("milestone", "2026-02-03", obligation_id="service"))
    assert summary(item, "2026-02")["revenue"] == "1200.00"
    assert summary(item, "2026-02")["deferred_revenue"] == "0.00"


def test_multiple_pobs_allocate_relative_ssp_and_satisfy_independently():
    item = contract(price="1500", obligations=[
        obligation("setup", method="point_in_time", ssp="500", kind="implementation"),
        obligation("subscription", ssp="1500")], activities=[event("milestone", obligation_id="setup")])
    result = report(item)
    assert {row["obligation_id"]: row["amount"] for row in result["contracts"][0]["allocation"]} == {
        "setup": "375.00", "subscription": "1125.00"}
    assert result["summary"]["revenue"] == "468.75"
    assert sum(Decimal(row["revenue"]) for row in result["schedule"]) == Decimal("1500")


def test_progress_is_cumulative_and_can_reverse_an_estimate():
    item = contract(obligations=[obligation(method="progress")], activities=[
        event("progress", obligation_id="service", percentage="25"),
        event("progress", "2026-02-01", obligation_id="service", percentage="40"),
        event("progress", "2026-03-01", obligation_id="service", percentage="30"),
        event("progress", "2026-04-01", obligation_id="service", percentage="100")])
    assert summary(item)["revenue"] == "300.00"
    assert summary(item, "2026-02")["revenue"] == "180.00"
    assert summary(item, "2026-03")["revenue"] == "-120.00"
    assert summary(item, "2026-04")["revenue"] == "840.00"
    assert_balanced(report(item, "2026-03"))


def test_milestones_are_cumulative_satisfaction_independent_of_billing():
    item = contract(obligations=[obligation(method="milestone")], activities=[
        event("milestone", obligation_id="service", percentage="20"),
        event("billing", amount="800"),
        event("milestone", "2026-02-02", obligation_id="service", percentage="60")])
    assert summary(item)["revenue"] == "240.00"
    assert summary(item, "2026-02")["revenue"] == "480.00"
    assert summary(item, "2026-02")["deferred_revenue"] == "80.00"


def test_usage_is_incremental_capped_and_does_not_change_consideration():
    item = contract(obligations=[obligation(method="usage", total_units="100")], activities=[
        event("usage", obligation_id="service", quantity="25"),
        event("usage", "2026-02-01", obligation_id="service", quantity="35"),
        event("usage", "2026-03-01", obligation_id="service", quantity="50")])
    assert summary(item)["revenue"] == "300.00"
    assert summary(item, "2026-02")["revenue"] == "420.00"
    assert summary(item, "2026-02")["contract_asset"] == "720.00"
    assert summary(item, "2026-03")["revenue"] == "480.00"
    assert summary(item, "2026-03")["transaction_price"] == "1200.00"
    assert any("exceeds total_units" in warning for warning in report(item)["warnings"])


def test_usage_price_reassessment_is_separate_from_usage_satisfaction():
    item = contract(consideration=[{"id": "usage_fee", "kind": "usage", "amount": "2000", "included_amount": "1200"}],
                    obligations=[obligation(method="usage", total_units="100")], activities=[
                        event("usage", obligation_id="service", quantity="25"),
                        event("reassessment", "2026-02-01", component_id="usage_fee", included_amount="2000", rationale="Updated estimate")])
    assert summary(item)["revenue"] == "300.00"
    assert summary(item, "2026-02")["revenue"] == "200.00"


def test_variable_reassessment_records_catchup_without_rewriting_history():
    item = contract(consideration=[
        {"id": "fixed", "kind": "fixed", "amount": "1200"},
        {"id": "bonus", "kind": "variable", "amount": "1200", "included_amount": "0", "potential_amount": "1200"}],
        activities=[event("reassessment", "2026-07-01", id="reestimate", component_id="bonus", included_amount="1200", rationale="Constraint resolved")])
    assert summary(item, "2026-06")["transaction_price"] == "1200.00"
    assert summary(item, "2026-06")["recognized_to_date"] == "600.00"
    july = report(item, "2026-07")
    assert july["summary"]["revenue"] == "800.00"
    assert july["summary"]["recognized_to_date"] == "1400.00"
    assert july["catch_ups"] == [{"activity_id": "reestimate", "contract_id": "contract", "obligation_id": "service",
                                     "effective_date": "2026-07-01", "period": "2026-07", "previous_recognized": "600.00",
                                     "required_cumulative": "1200.00", "catch_up": "600.00", "rationale": "Constraint resolved"}]
    assert revenue_by_month(july)["2026-06"] == Decimal("100")
    assert sum(revenue_by_month(july).values()) == Decimal("2400")
    assert_balanced(july)


def test_variable_downward_reassessment_can_create_negative_revenue():
    item = contract(consideration=[{"id": "bonus", "kind": "variable", "amount": "1200", "included_amount": "1200"}],
                    activities=[event("reassessment", "2026-07-01", component_id="bonus", included_amount="600", rationale="Constraint tightened")])
    assert summary(item, "2026-07")["revenue"] == "-250.00"
    assert summary(item, "2026-07")["recognized_to_date"] == "350.00"
    assert_balanced(report(item, "2026-07"))


def test_prospective_modification_preserves_prior_revenue_and_spreads_remaining_price():
    item = contract(activities=[event("modification", "2026-07-01", treatment="prospective", rationale="Distinct remaining services",
                                     consideration=[{"id": "fixed", "kind": "fixed", "amount": "1800"}])])
    result = report(item, "2026-07")
    months = revenue_by_month(result)
    assert [months[f"2026-{month:02}"] for month in range(1, 7)] == [Decimal("100")] * 6
    assert [months[f"2026-{month:02}"] for month in range(7, 13)] == [Decimal("200")] * 6
    assert result["summary"]["remaining_revenue"] == "1000.00"
    assert result["catch_ups"] == []
    assert sum(months.values()) == Decimal("1800")


def test_prospective_added_obligation_uses_remaining_ssp():
    item = contract(activities=[event("modification", "2026-07-01", treatment="prospective", rationale="Added distinct service",
                                     consideration=[{"id": "fixed", "kind": "fixed", "amount": "1800"}], obligations=[
                                         obligation(), obligation("added", ssp="600", start_date="2026-07-01")])])
    result = report(item, "2026-07")
    allocation = {row["obligation_id"]: row["amount"] for row in result["contracts"][0]["allocation"]}
    assert allocation == {"service": "1200.00", "added": "600.00"}
    assert result["summary"]["revenue"] == "200.00"


def test_catchup_modification_posts_effective_month_delta_and_revised_rate():
    item = contract(activities=[event("modification", "2026-07-01", treatment="catch_up", rationale="Existing combined obligation",
                                     consideration=[{"id": "fixed", "kind": "fixed", "amount": "1800"}])])
    july = report(item, "2026-07")
    assert july["summary"]["revenue"] == "450.00"
    assert july["summary"]["recognized_to_date"] == "1050.00"
    assert july["catch_ups"][0]["catch_up"] == "300.00"
    assert revenue_by_month(july)["2026-06"] == Decimal("100")
    assert sum(revenue_by_month(july).values()) == Decimal("1800")


def test_midmonth_prospective_change_preserves_service_delivered_before_effective_date():
    item = contract(price="310", obligations=[obligation(method="exact_days", start_date="2026-01-01", end_date="2026-01-31")],
                    activities=[event("modification", "2026-01-16", treatment="prospective", rationale="Midmonth change",
                                      consideration=[{"id": "fixed", "kind": "fixed", "amount": "470"}])])
    assert summary(item)["revenue"] == "470.00"
    assert summary(item)["remaining_revenue"] == "0.00"
    assert_balanced(report(item))


def test_prospective_termination_preserves_earned_revenue():
    item = contract(activities=[event("modification", "2026-07-01", treatment="prospective", rationale="Termination, six months earned",
                                     consideration=[{"id": "fixed", "kind": "fixed", "amount": "600"}], obligations=[])])
    result = report(item, "2026-07")
    assert result["summary"]["transaction_price"] == "600.00"
    assert result["summary"]["revenue"] == "0.00"
    assert result["summary"]["recognized_to_date"] == "600.00"
    assert result["summary"]["remaining_revenue"] == "0.00"
    assert result["contracts"][0]["allocation"][0]["retired"] is True
    assert sum(revenue_by_month(result).values()) == Decimal("600")


def test_catchup_cancellation_reverses_previously_recognized_revenue():
    item = contract(activities=[event("modification", "2026-07-01", treatment="catch_up", rationale="Entire consideration reversed",
                                     consideration=[{"id": "fixed", "kind": "fixed", "amount": "0"}], obligations=[])])
    result = report(item, "2026-07")
    assert result["summary"]["revenue"] == "-600.00"
    assert result["summary"]["recognized_to_date"] == "0.00"
    assert sum(revenue_by_month(result).values()) == 0
    assert_balanced(result)


def test_fully_satisfied_prospective_price_change_requires_remaining_performance():
    item = contract(obligations=[obligation(method="point_in_time")], activities=[
        event("milestone", obligation_id="service"),
        event("modification", "2026-02-01", treatment="prospective", rationale="Wrong treatment",
              consideration=[{"id": "fixed", "kind": "fixed", "amount": "1800"}])])
    with pytest.raises(ValueError, match="remaining SSP"):
        report(item)


def test_material_right_is_allocated_and_expires_without_exercise():
    item = contract(price="1100", obligations=[
        obligation(ssp="1000"),
        obligation("option", kind="material_right", method="point_in_time", ssp="100", exercise_start="2026-04-01", exercise_end="2026-09-15")])
    assert summary(item, "2026-08")["revenue"] == "83.34"
    september = report(item, "2026-09")
    assert september["summary"]["revenue"] == "183.33"
    assert sum(Decimal(row["revenue"]) for row in september["schedule"] if row["obligation_id"] == "option") == Decimal("100")


def test_material_right_recognizes_when_exercise_and_delivery_are_recorded():
    item = contract(obligations=[obligation(kind="material_right", method="point_in_time", exercise_start="2026-04-01", exercise_end="2026-09-30")],
                    activities=[event("milestone", "2026-05-01", obligation_id="service")])
    assert summary(item, "2026-05")["revenue"] == "1200.00"
    assert summary(item, "2026-09")["revenue"] == "0.00"


def test_material_right_exercise_defers_recognition_until_later_service_delivery():
    item = contract(obligations=[obligation(kind="material_right", method="point_in_time", exercise_start="2026-04-01", exercise_end="2026-06-30")],
                    activities=[event("right_exercise", "2026-06-15", obligation_id="service", delivery_method="exact_days",
                                      delivery_start="2026-07-01", delivery_end="2026-12-31", rationale="Option exercised for second-half service")])
    assert summary(item, "2026-06")["recognized_to_date"] == "0.00"
    july = report(item, "2026-07")
    assert Decimal(july["summary"]["revenue"]) > 0
    assert_balanced(july)
    assert summary(item, "2026-12")["recognized_to_date"] == "1200.00"
    assert summary(item, "2027-01")["revenue"] == "0.00"


def test_exercised_material_right_point_in_time_delivery_after_option_expiry():
    item = contract(obligations=[obligation(kind="material_right", method="point_in_time", exercise_start="2026-04-01", exercise_end="2026-06-30")],
                    activities=[event("right_exercise", "2026-06-15", obligation_id="service", delivery_method="point_in_time",
                                      delivery_start="2026-09-01", delivery_end="2026-09-01", rationale="Option exercised for September delivery"),
                                event("milestone", "2026-09-01", obligation_id="service", percentage="100")])
    assert summary(item, "2026-06")["recognized_to_date"] == "0.00"
    assert summary(item, "2026-08")["recognized_to_date"] == "0.00"
    assert summary(item, "2026-09")["revenue"] == "1200.00"


def test_material_right_exercise_rejects_duplicate_and_unreviewed_term_replacement():
    exercise = event("right_exercise", "2026-06-15", obligation_id="service", delivery_method="exact_days",
                     delivery_start="2026-07-01", delivery_end="2026-12-31", rationale="Reviewed second-half service")
    right = obligation(kind="material_right", method="point_in_time", exercise_start="2026-04-01", exercise_end="2026-06-30")
    with pytest.raises(ValueError, match="only once"):
        validate_contract(contract(obligations=[right], activities=[exercise, deepcopy(exercise)]))
    with pytest.raises(ValueError, match="separate reviewed treatment"):
        validate_contract(contract(obligations=[right], activities=[exercise, event("modification", "2026-08-01", treatment="catch_up", rationale="Change right", obligations=[{**right, "ssp": "1300"}])]))
    with pytest.raises(ValueError, match="delivery method"):
        validate_contract(contract(obligations=[right], activities=[{**exercise, "delivery_method": "usage"}]))


def test_exercised_right_keeps_delivery_pattern_after_price_catch_up():
    item = contract(obligations=[obligation(kind="material_right", method="point_in_time", exercise_start="2026-04-01", exercise_end="2026-06-30")],
                    activities=[event("right_exercise", "2026-06-15", obligation_id="service", delivery_method="monthly",
                                      delivery_start="2026-07-01", delivery_end="2026-12-31", rationale="Reviewed renewal exercise"),
                                event("modification", "2026-08-01", treatment="catch_up", rationale="Revised allocated price",
                                      consideration=[{"id": "fixed", "kind": "fixed", "amount": "1300.00"}])])
    assert summary(item, "2026-06")["revenue"] == "0.00"
    assert summary(item, "2026-07")["revenue"] == "200.00"
    assert summary(item, "2026-12")["recognized_to_date"] == "1300.00"
    assert_balanced(report(item, "2026-08"))


def test_opening_material_right_cannot_be_partly_recognized_or_exercised_after_delivery():
    right = obligation(kind="material_right", method="point_in_time", exercise_start="2026-04-01", exercise_end="2026-09-30")
    opening = event("opening_position", "2026-06-01", billed_to_date="0.00", contract_asset="600.00", deferred_revenue="0.00",
                    source_name="Legacy schedule", rationale="May close tie-out",
                    opening_obligations=[{"obligation_id": "service", "recognized_to_date": "600.00", "measure": "0"}])
    with pytest.raises(ValueError, match="partial breakage"):
        validate_contract(contract(obligations=[right], activities=[opening]))
    delivered = deepcopy(opening)
    delivered["opening_obligations"][0] = {"obligation_id": "service", "recognized_to_date": "1200.00", "measure": "100"}
    delivered["contract_asset"] = "1200.00"
    exercise = event("right_exercise", "2026-06-15", obligation_id="service", delivery_method="monthly",
                     delivery_start="2026-07-01", delivery_end="2026-12-31", rationale="Duplicate option")
    with pytest.raises(ValueError, match="only once"):
        validate_contract(contract(obligations=[right], activities=[delivered, exercise]))


def test_manual_adjustment_is_immediate_and_remaining_schedule_reconciles():
    item = contract(activities=[event("adjustment", "2026-06-30", obligation_id="service", amount="120", rationale="Explicit acceleration")])
    assert summary(item, "2026-06")["revenue"] == "220.00"
    assert summary(item, "2026-06")["remaining_revenue"] == "480.00"
    assert summary(item, "2026-07")["revenue"] == "80.00"
    assert sum(revenue_by_month(report(item)).values()) == Decimal("1200")
    assert_balanced(report(item, "2026-06"))


def test_adjustment_after_satisfaction_remains_visible_and_warns():
    item = contract(activities=[event("adjustment", "2026-12-31", obligation_id="service", amount="10")])
    result = report(item, "2026-12")
    assert result["summary"]["remaining_revenue"] == "-10.00"
    assert any("adjustment after full satisfaction" in warning for warning in result["warnings"])


def test_billing_after_recognition_clears_contract_asset_and_creates_deferred():
    item = contract(activities=[event("billing", "2026-03-01", amount="1200")])
    assert summary(item, "2026-02")["contract_asset"] == "200.00"
    result = report(item, "2026-03")
    assert result["summary"]["deferred_revenue"] == "900.00"
    assert result["summary"]["contract_asset"] == "0.00"
    assert {row["role"]: (row["debit"], row["credit"]) for row in result["journals"]} == {
        "billing_clearing": ("1200.00", "0.00"), "contract_asset": ("0.00", "200.00"),
        "deferred_revenue": ("0.00", "900.00"), "revenue": ("0.00", "100.00")}
    assert_balanced(result)


def test_credit_billing_reverses_clearing_without_changing_transaction_price():
    item = contract(activities=[event("billing", amount="1200"), event("billing", "2026-02-01", amount="-1200")])
    result = report(item, "2026-02")
    assert result["summary"]["billings"] == "-1200.00"
    assert result["summary"]["transaction_price"] == "1200.00"
    assert result["summary"]["contract_asset"] == "200.00"
    assert_balanced(result)


def test_positive_and_negative_positions_are_not_netted_between_contracts():
    first = contract(activities=[event("billing", amount="1200")])
    second = contract(id="other")
    result = calculate({"contracts": [first, second]}, "2026-01")
    assert result["summary"]["deferred_revenue"] == "1100.00"
    assert result["summary"]["contract_asset"] == "100.00"
    assert_balanced(result)


def test_calculation_is_repeatable_does_not_mutate_state_and_uses_account_mapping():
    state = {"contracts": [contract()], "policy": {"accounts": {"revenue": "R", "contract_asset": "A"}}}
    original = deepcopy(state)
    first = calculate(state, "2026-01")
    assert first == calculate(state, "2026-01")
    assert state == original
    assert {row["account"] for row in first["journals"]} == {"R", "A"}


def test_no_contracts_returns_a_complete_zero_report():
    result = calculate({}, "2026-01")
    assert result["summary"]["revenue"] == "0.00"
    assert result["contracts"] == result["schedule"] == result["journals"] == []


@pytest.mark.parametrize("period", ["2026-1", "2026-13", "2026-00", "2026-01-01", None])
def test_invalid_period_rejected(period):
    with pytest.raises(ValueError, match="period"):
        report(contract(), period)


@pytest.mark.parametrize("mutate,match", [
    (lambda item: item["obligations"][0].update(ssp="-1"), "SSP"),
    (lambda item: item["consideration"][0].update(amount="NaN"), "finite"),
    (lambda item: item["consideration"][0].update(amount=12.0), "exact decimal"),
    (lambda item: item["obligations"][0].update(method="usage", total_units="0"), "total_units"),
    (lambda item: item["obligations"][0].update(end_date="2025-01-01"), "end_date"),
    (lambda item: item["activities"].append(event("progress", obligation_id="service", percentage="101")), "method"),
    (lambda item: item["activities"].append(event("adjustment", obligation_id="missing", amount="1")), "unknown"),
    (lambda item: item["consideration"][0].update(kind="credit", amount="10"), "negative"),
])
def test_invalid_accounting_input_rejected(mutate, match):
    item = contract()
    mutate(item)
    with pytest.raises(ValueError, match=match):
        validate_contract(item)


def test_progress_bounds_and_point_in_time_fraction_are_rejected():
    item = contract(obligations=[obligation(method="progress")], activities=[event("progress", obligation_id="service", percentage="101")])
    with pytest.raises(ValueError, match="between 0 and 100"):
        validate_contract(item)
    item = contract(obligations=[obligation(method="point_in_time")], activities=[event("milestone", obligation_id="service", percentage="50")])
    with pytest.raises(ValueError, match="0 or 100"):
        validate_contract(item)


def test_material_right_exercise_outside_window_rejected():
    item = contract(obligations=[obligation(kind="material_right", method="point_in_time", exercise_start="2026-04-01")],
                    activities=[event("milestone", obligation_id="service")])
    with pytest.raises(ValueError, match="exercise window"):
        validate_contract(item)


def test_multiple_changes_preserve_history_and_cumulative_conservation_every_month():
    item = contract(activities=[
        event("billing", amount="500"),
        event("modification", "2026-04-01", treatment="prospective", rationale="First change",
              consideration=[{"id": "fixed", "kind": "fixed", "amount": "1500"}]),
        event("modification", "2026-08-15", treatment="catch_up", rationale="Second change",
              consideration=[{"id": "fixed", "kind": "fixed", "amount": "1800"}]),
        event("billing", "2026-09-15", amount="1300"),
    ])
    for month in range(1, 13):
        result = report(item, f"2026-{month:02}")
        totals = result["summary"]
        assert Decimal(totals["recognized_to_date"]) + Decimal(totals["remaining_revenue"]) == Decimal(totals["transaction_price"])
        assert sum(Decimal(row["amount"]) for row in result["contracts"][0]["allocation"]) == Decimal(totals["transaction_price"])
        assert sum(Decimal(row["revenue"]) for row in result["schedule"] if row["period"] <= result["period"]) == Decimal(totals["recognized_to_date"])
        assert_balanced(result)


def test_same_day_terms_precede_satisfaction_independent_of_import_order():
    item = contract(obligations=[obligation(method="progress")], activities=[
        event("progress", "2026-04-01", obligation_id="added", percentage="25"),
        event("modification", "2026-04-01", treatment="prospective", rationale="New undelivered obligation",
              obligations=[obligation("added", method="progress", start_date="2026-04-01")]),
    ])
    result = report(item, "2026-04")
    assert result["summary"]["revenue"] == "300.00"
    assert result["summary"]["remaining_revenue"] == "900.00"
    assert_balanced(result)


def test_billing_before_service_starts_creates_deferred_and_does_not_accelerate_revenue():
    item = contract(activities=[event("billing", "2025-12-01", amount="1200")])
    december = report(item, "2025-12")
    assert december["summary"]["revenue"] == "0.00"
    assert december["summary"]["deferred_revenue"] == "1200.00"
    assert_balanced(december)
    january = report(item, "2026-01")
    assert january["contracts"][0]["beginning_deferred_revenue"] == "1200.00"
    assert_balanced(january)


def test_successive_variable_reassessments_post_only_incremental_catchups():
    item = contract(consideration=[{"id": "bonus", "kind": "variable", "amount": "1200", "included_amount": "600"}],
                    activities=[
                        event("reassessment", "2026-07-01", component_id="bonus", included_amount="900", rationale="First estimate"),
                        event("reassessment", "2026-07-15", component_id="bonus", included_amount="1200", rationale="Second estimate"),
                    ])
    result = report(item, "2026-07")
    assert result["summary"]["recognized_to_date"] == "700.00"
    assert result["summary"]["revenue"] == "400.00"
    assert sum(revenue_by_month(result).values()) == Decimal("1200")
    assert_balanced(result)


def test_reassessment_cannot_make_total_consideration_negative():
    item = contract(consideration=[
        {"id": "bonus", "kind": "variable", "amount": "1200", "included_amount": "1200"},
        {"id": "credit", "kind": "credit", "amount": "-600"},
    ], activities=[event("reassessment", "2026-07-01", component_id="bonus", included_amount="0", rationale="Constraint tightened")])
    with pytest.raises(ValueError, match="transaction price cannot be negative"):
        report(item, "2026-07")
