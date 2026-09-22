"""Deterministic revenue calculations from an immutable contract baseline.

Dates are inclusive. Money is Decimal throughout and is posted to cents using
ROUND_HALF_UP. Relative SSP allocation uses largest remainders with obligation
IDs as the stable tie breaker, so every allocation reconciles exactly.

Accounting judgments are inputs: the engine does not decide whether an obligation
is distinct, a variable amount meets the constraint, or a modification should be
prospective. Usage measures satisfaction only; changing transaction price requires
a separate consideration reassessment. This is a single-currency workbench, not a
general ledger or an automated ASC 606 conclusion.
"""

from __future__ import annotations

from calendar import monthrange
from collections import defaultdict
from copy import deepcopy
from dataclasses import dataclass
from datetime import date, timedelta
from decimal import Decimal, InvalidOperation, ROUND_FLOOR, ROUND_HALF_UP, localcontext
from typing import Any


CENT = Decimal("0.01")
ZERO = Decimal("0")
ONE = Decimal("1")
METHODS = {"exact_days", "monthly", "point_in_time", "progress", "usage", "milestone"}
KINDS = {"service", "implementation", "license", "support", "product", "material_right", "other"}
CONSIDERATION_KINDS = {"fixed", "variable", "usage", "credit"}
ACTIVITY_TYPES = {"billing", "progress", "usage", "milestone", "adjustment", "modification", "reassessment"}
REPORT_AMOUNTS = (
    "transaction_price", "revenue", "recognized_to_date", "billings", "billed_to_date",
    "deferred_revenue", "contract_asset", "remaining_revenue",
)
DEFAULT_ACCOUNTS = {
    "revenue": "4000", "deferred_revenue": "2300", "contract_asset": "1200", "billing_clearing": "1100",
}
ACCOUNT_NAMES = {
    "revenue": "Revenue", "deferred_revenue": "Deferred revenue", "contract_asset": "Contract asset",
    "billing_clearing": "Billing clearing",
}


def decimal(value: Any, field: str = "amount") -> Decimal:
    """Read an exact, finite number; reject binary floating-point inputs."""
    if isinstance(value, (bool, float)) or value is None:
        raise ValueError(f"{field} must be an exact decimal string or integer")
    try:
        number = Decimal(value)
    except (InvalidOperation, ValueError, TypeError):
        raise ValueError(f"{field} must be a decimal number") from None
    if not number.is_finite():
        raise ValueError(f"{field} must be finite")
    if abs(number) > Decimal("1000000000000000"):
        raise ValueError(f"{field} exceeds the supported amount")
    return number


def money(value: Decimal) -> Decimal:
    return value.quantize(CENT, rounding=ROUND_HALF_UP)


def amount(value: Decimal) -> str:
    return format(money(value) + ZERO, ".2f")


def _date(value: Any, field: str = "date") -> date:
    if not isinstance(value, str):
        raise ValueError(f"{field} must use YYYY-MM-DD")
    try:
        parsed = date.fromisoformat(value)
    except ValueError:
        raise ValueError(f"{field} must use YYYY-MM-DD") from None
    if parsed.isoformat() != value or parsed.year < 1900 or parsed.year > 2199:
        raise ValueError(f"{field} must use YYYY-MM-DD between 1900 and 2199")
    return parsed


def period_end(period: str) -> date:
    try:
        year, month = (int(part) for part in period.split("-"))
        result = date(year, month, monthrange(year, month)[1])
    except (AttributeError, ValueError, TypeError):
        raise ValueError("period must use YYYY-MM") from None
    if result.strftime("%Y-%m") != period or not 1900 <= year <= 2199:
        raise ValueError("period must use YYYY-MM between 1900 and 2199")
    return result


def _month_end(day: date) -> date:
    return day.replace(day=monthrange(day.year, day.month)[1])


def _periods(start: date, end: date):
    current = start.replace(day=1)
    while current <= end:
        yield current.strftime("%Y-%m")
        current = (_month_end(current) + timedelta(days=1))


def allocate(total: Any, weights: dict[str, Any]) -> dict[str, Decimal]:
    """Allocate a posted amount exactly, including deterministic penny residuals.

Weights can be SSP or remaining SSP after a prospective modification. Zero
weights receive zero. Negative totals are supported for reductions to remaining
consideration, but negative weights are never valid.
    """
    with localcontext() as context:
        context.prec = 48
        posted = money(decimal(total))
        values = {str(key): decimal(value, "allocation weight") for key, value in weights.items()}
        if any(value < ZERO for value in values.values()):
            raise ValueError("Allocation weights cannot be negative")
        denominator = sum(values.values(), ZERO)
        if denominator == ZERO:
            if posted != ZERO:
                raise ValueError("Nonzero consideration requires positive remaining SSP")
            return {key: ZERO.quantize(CENT) for key in values}
        units = abs(int(posted * 100))
        quotas = {key: Decimal(units) * value / denominator for key, value in values.items()}
        floors = {key: int(value.to_integral_value(rounding=ROUND_FLOOR)) for key, value in quotas.items()}
        order = sorted(values, key=lambda key: (-(quotas[key] - floors[key]), key))
        for key in order[:units - sum(floors.values())]:
            floors[key] += 1
        sign = -ONE if posted < ZERO else ONE
        return {key: Decimal(floors[key]) * CENT * sign for key in values}


def _price(components: list[dict]) -> Decimal:
    return money(sum((decimal(component.get("included_amount", component.get("amount", "0")))
                      if component["kind"] in {"variable", "usage"}
                      else decimal(component["amount"]) for component in components), ZERO))


def _identifier(item: dict, label: str) -> str:
    if not isinstance(item, dict):
        raise ValueError(f"{label} must be an object")
    identifier = item.get("id")
    if not isinstance(identifier, str) or not identifier.strip():
        raise ValueError(f"{label} requires a nonempty id")
    return identifier


def _validate_terms(components: Any, obligations: Any, *, allow_empty: bool = False) -> None:
    if not isinstance(components, list) or not components:
        raise ValueError("A contract requires at least one consideration component")
    if not isinstance(obligations, list) or (not obligations and not allow_empty):
        raise ValueError("A contract requires at least one performance obligation")
    seen: set[str] = set()
    for component in components:
        identifier = _identifier(component, "Consideration")
        if identifier in seen:
            raise ValueError(f"Duplicate consideration id: {identifier}")
        seen.add(identifier)
        kind = component.get("kind")
        if kind not in CONSIDERATION_KINDS:
            raise ValueError(f"Unsupported consideration kind: {kind}")
        number = decimal(component.get("amount", "0"), "consideration amount")
        if kind == "credit" and number > ZERO:
            raise ValueError("Credit consideration must be zero or negative")
        if kind != "credit" and number < ZERO:
            raise ValueError("Use a credit component for negative consideration")
        for key in ("included_amount", "potential_amount", "estimated_amount"):
            if key in component and decimal(component[key], key) < ZERO:
                raise ValueError(f"{key} cannot be negative")
        if kind not in {"variable", "usage"} and "included_amount" in component:
            raise ValueError("Only variable or usage consideration may specify included_amount")
    if _price(components) < ZERO:
        raise ValueError("Total transaction price cannot be negative")
    seen.clear()
    for obligation in obligations:
        identifier = _identifier(obligation, "Obligation")
        if identifier in seen:
            raise ValueError(f"Duplicate obligation id: {identifier}")
        seen.add(identifier)
        if not str(obligation.get("name", "")).strip():
            raise ValueError("Each obligation requires a name")
        if obligation.get("kind") not in KINDS:
            raise ValueError(f"Unsupported obligation kind: {obligation.get('kind')}")
        if obligation.get("method") not in METHODS:
            raise ValueError(f"Unsupported satisfaction method: {obligation.get('method')}")
        if decimal(obligation.get("ssp"), "SSP") < ZERO:
            raise ValueError("SSP cannot be negative")
        start = _date(obligation.get("start_date"), "obligation start_date")
        end = _date(obligation.get("end_date"), "obligation end_date")
        if end < start:
            raise ValueError("An obligation end_date cannot precede start_date")
        if obligation["method"] == "usage" and decimal(obligation.get("total_units"), "total_units") <= ZERO:
            raise ValueError("Usage satisfaction requires positive total_units")
        if obligation["kind"] == "material_right":
            if obligation["method"] != "point_in_time":
                raise ValueError("Material rights require point_in_time satisfaction")
            exercise_start = _date(obligation.get("exercise_start", obligation["start_date"]), "exercise_start")
            exercise_end = _date(obligation.get("exercise_end", obligation["end_date"]), "exercise_end")
            if exercise_end < exercise_start or exercise_start < start:
                raise ValueError("Material-right exercise window must follow the grant and have a valid end")
    if obligations and not any(decimal(item["ssp"]) > ZERO for item in obligations) and _price(components) != ZERO:
        raise ValueError("A nonzero transaction price requires positive SSP")


def _ordered_activities(contract: dict) -> list[dict]:
    # Terms take effect at the beginning of a day, before that day's delivery.
    # Preserve command order within each phase, including successive revisions.
    def phase(item: dict) -> int:
        return 0 if item.get("type") in {"modification", "reassessment"} else 2 if item.get("type") == "adjustment" else 1

    return [item for _, item in sorted(enumerate(contract.get("activities", [])),
                                      key=lambda pair: (pair[1]["effective_date"], phase(pair[1]), pair[0]))]


def validate_contract(contract: dict) -> None:
    """Validate terms and the chronological activity stream without mutation."""
    _identifier(contract, "Contract")
    if not str(contract.get("name", "")).strip():
        raise ValueError("A contract requires a name")
    if not str(contract.get("customer_id", "")).strip():
        raise ValueError("A contract requires customer_id")
    start = _date(contract.get("start_date"), "contract start_date")
    end = _date(contract.get("end_date"), "contract end_date")
    if end < start:
        raise ValueError("Contract end_date cannot precede start_date")
    components = deepcopy(contract.get("consideration"))
    obligations = deepcopy(contract.get("obligations"))
    _validate_terms(components, obligations)
    activities = contract.get("activities", [])
    if not isinstance(activities, list):
        raise ValueError("activities must be a list")
    seen = set()
    for activity in activities:
        if not isinstance(activity, dict):
            raise ValueError("Each activity must be an object")
        _date(activity.get("effective_date"), "activity effective_date")
        if "id" in activity:
            identifier = _identifier(activity, "Activity")
            if identifier in seen:
                raise ValueError(f"Duplicate activity id: {identifier}")
            seen.add(identifier)
    for activity in _ordered_activities(contract):
        kind = activity.get("type")
        if kind not in ACTIVITY_TYPES:
            raise ValueError(f"Unsupported activity type: {kind}")
        if kind == "modification":
            if activity.get("treatment") not in {"prospective", "catch_up"}:
                raise ValueError("Modification treatment must be prospective or catch_up")
            if not str(activity.get("rationale", "")).strip():
                raise ValueError("A modification requires an accounting rationale")
            components = deepcopy(activity.get("consideration", components))
            obligations = deepcopy(activity.get("obligations", obligations))
            _validate_terms(components, obligations, allow_empty=True)
            continue
        if kind == "reassessment":
            component = next((item for item in components if item["id"] == activity.get("component_id")), None)
            if component is None or component["kind"] not in {"variable", "usage"}:
                raise ValueError("Reassessment must identify a current variable or usage component")
            if decimal(activity.get("included_amount"), "included_amount") < ZERO:
                raise ValueError("included_amount cannot be negative")
            if not str(activity.get("rationale", "")).strip():
                raise ValueError("A reassessment requires an accounting rationale")
            component["included_amount"] = activity["included_amount"]
            if _price(components) < ZERO:
                raise ValueError("Total transaction price cannot be negative")
            continue
        if kind == "billing":
            decimal(activity.get("amount"), "billing amount")
            continue
        obligation = next((item for item in obligations if item["id"] == activity.get("obligation_id")), None)
        if obligation is None:
            raise ValueError(f"Activity references an unknown current obligation: {activity.get('obligation_id')}")
        if kind == "adjustment":
            decimal(activity.get("amount"), "adjustment amount")
            continue
        if activity["effective_date"] < obligation["start_date"]:
            raise ValueError("Satisfaction activity cannot precede the obligation start_date")
        expected = {"progress": {"progress"}, "usage": {"usage"}, "milestone": {"milestone", "point_in_time"}}[kind]
        if obligation["method"] not in expected:
            raise ValueError(f"{kind} activity does not match the obligation satisfaction method")
        if kind == "usage":
            if decimal(activity.get("quantity"), "quantity") < ZERO:
                raise ValueError("Usage quantity must be nonnegative; use an adjustment for corrections")
        else:
            percentage = decimal(activity.get("percentage", "100" if kind == "milestone" else None), "percentage")
            if not ZERO <= percentage <= 100:
                raise ValueError("Cumulative percentage must be between 0 and 100")
            if obligation["method"] == "point_in_time" and percentage not in {ZERO, Decimal(100)}:
                raise ValueError("Point-in-time satisfaction must be 0 or 100 percent")
            if obligation["kind"] == "material_right":
                first = obligation.get("exercise_start", obligation["start_date"])
                last = obligation.get("exercise_end", obligation["end_date"])
                if not first <= activity["effective_date"] <= last:
                    raise ValueError("Material-right exercise must fall within the exercise window")


def _fraction(obligation: dict, day: date, measures: dict[str, Decimal]) -> Decimal:
    start, end = _date(obligation["start_date"]), _date(obligation["end_date"])
    if day < start:
        return ZERO
    method = obligation["method"]
    if method == "exact_days":
        return min(ONE, Decimal((day - start).days + 1) / Decimal((end - start).days + 1))
    if method == "monthly":
        if day >= end:
            return ONE
        count = (end.year - start.year) * 12 + end.month - start.month + 1
        completed = (day.year - start.year) * 12 + day.month - start.month
        month_start = max(start, day.replace(day=1))
        month_end = min(end, _month_end(day))
        partial = Decimal((day - month_start).days + 1) / Decimal((month_end - month_start).days + 1)
        return (Decimal(completed) + partial) / Decimal(count)
    if obligation["kind"] == "material_right":
        if day >= _date(obligation.get("exercise_end", obligation["end_date"])):
            return ONE
    value = measures.get(obligation["id"], ZERO)
    return min(ONE, value / decimal(obligation["total_units"])) if method == "usage" else value / 100


@dataclass
class _Curve:
    obligation: dict
    target: Decimal
    anchor: Decimal = ZERO
    recognized: Decimal = ZERO
    frozen: bool = False

    def value(self, day: date, measures: dict[str, Decimal]) -> Decimal:
        if self.frozen or self.anchor >= ONE:
            return self.recognized
        progress = _fraction(self.obligation, day, measures)
        remaining_progress = min(ONE, max(ZERO, (progress - self.anchor) / (ONE - self.anchor)))
        return money(self.recognized + (self.target - self.recognized) * remaining_progress)


def _project(contract: dict, selected: str) -> tuple[dict, list[dict], list[dict], list[str]]:
    components = deepcopy(contract["consideration"])
    obligations = deepcopy(contract["obligations"])
    allocations = allocate(_price(components), {item["id"]: item["ssp"] for item in obligations})
    curves = {item["id"]: _Curve(item, allocations[item["id"]]) for item in obligations}
    measures: dict[str, Decimal] = {}
    recognized: dict[str, Decimal] = defaultdict(lambda: ZERO)
    schedule: dict[tuple[str, str], Decimal] = defaultdict(lambda: ZERO)
    activities: dict[date, list[dict]] = defaultdict(list)
    all_dates = [_date(contract["start_date"]), _date(contract["end_date"])]
    for item in obligations:
        all_dates.extend([_date(item["start_date"]), _date(item["end_date"])])
        if item.get("exercise_end"):
            all_dates.append(_date(item["exercise_end"]))
    for activity in _ordered_activities(contract):
        day = _date(activity["effective_date"])
        activities[day].append(activity)
        all_dates.append(day)
        for item in activity.get("obligations", []):
            all_dates.extend([_date(item["start_date"]), _date(item["end_date"])])
            if item.get("exercise_end"):
                all_dates.append(_date(item["exercise_end"]))
    selected_end = period_end(selected)
    previous_end = selected_end.replace(day=1) - timedelta(days=1)
    first, last = min(all_dates + [selected_end]), max(all_dates + [selected_end])
    months = list(_periods(first, last))
    boundaries = {period_end(month) for month in months}
    for day in activities:
        boundaries.update((day, day - timedelta(days=1)))
    boundaries.update((selected_end, previous_end))
    billings: dict[str, Decimal] = defaultdict(lambda: ZERO)
    catch_ups: list[dict] = []
    warnings: list[str] = []
    selected_snapshot: dict = {}
    prior_recognized = ZERO
    current_price = _price(components)

    def accrue(day: date) -> None:
        month = day.strftime("%Y-%m")
        for identifier, curve in curves.items():
            required = curve.value(day, measures)
            schedule[(month, identifier)] += required - recognized[identifier]
            recognized[identifier] = required

    for day in sorted(boundaries):
        daily = activities.get(day, [])
        if daily:
            # Effective accounting changes begin at the start of their day.
            # Apply term/price changes, then satisfaction, then adjustments.
            # This avoids a same-day billing/progress import order changing terms.
            for activity in daily:
                kind = activity["type"]
                if kind == "billing":
                    billings[day.strftime("%Y-%m")] += money(decimal(activity["amount"]))
                if kind not in {"modification", "reassessment"}:
                    continue
                prior = dict(recognized)
                old_curves = curves
                if kind == "modification":
                    components = deepcopy(activity.get("consideration", components))
                    obligations = deepcopy(activity.get("obligations", obligations))
                    treatment = activity["treatment"]
                else:
                    component = next(item for item in components if item["id"] == activity["component_id"])
                    component["included_amount"] = activity["included_amount"]
                    treatment = "catch_up"
                current_price = _price(components)
                if treatment == "prospective":
                    remaining = current_price - sum(prior.values(), ZERO)
                    fractions = {item["id"]: _fraction(item, day - timedelta(days=1), measures) for item in obligations}
                    weights = {item["id"]: decimal(item["ssp"]) * (ONE - fractions[item["id"]]) for item in obligations}
                    allocated = allocate(remaining, weights)
                    curves = {
                        item["id"]: _Curve(item, prior.get(item["id"], ZERO) + allocated[item["id"]],
                                           fractions[item["id"]], prior.get(item["id"], ZERO))
                        for item in obligations
                    }
                    for identifier, old in old_curves.items():
                        if identifier not in curves:
                            curves[identifier] = _Curve(old.obligation, prior[identifier], recognized=prior[identifier], frozen=True)
                    if remaining < ZERO:
                        warnings.append(f"{contract['name']}: prospective remaining consideration is negative; future revenue includes reversals.")
                else:
                    allocated = allocate(current_price, {item["id"]: item["ssp"] for item in obligations})
                    curves = {item["id"]: _Curve(item, allocated[item["id"]]) for item in obligations}
                    for identifier, old in old_curves.items():
                        if identifier not in curves:
                            curves[identifier] = _Curve(old.obligation, ZERO, recognized=ZERO, frozen=True)
                    for identifier, curve in curves.items():
                        required = curve.value(day - timedelta(days=1), measures)
                        previous = prior.get(identifier, ZERO)
                        if required != previous:
                            catch_ups.append({
                                "activity_id": activity.get("id"), "contract_id": contract["id"],
                                "obligation_id": identifier, "effective_date": day.isoformat(),
                                "period": day.strftime("%Y-%m"), "previous_recognized": amount(previous),
                                "required_cumulative": amount(required), "catch_up": amount(required - previous),
                                "rationale": activity.get("rationale", ""),
                            })
                # Catch-up deltas belong to the effective month, not the previous
                # day used to measure performance already delivered.
                for identifier, curve in curves.items():
                    required = curve.value(day - timedelta(days=1), measures)
                    schedule[(day.strftime("%Y-%m"), identifier)] += required - recognized[identifier]
                    recognized[identifier] = required
            for activity in daily:
                kind = activity["type"]
                identifier = activity.get("obligation_id")
                if kind in {"progress", "milestone"}:
                    measures[identifier] = decimal(activity.get("percentage", "100"))
                elif kind == "usage":
                    measures[identifier] = measures.get(identifier, ZERO) + decimal(activity["quantity"])
            accrue(day)
            for activity in daily:
                if activity["type"] != "adjustment":
                    continue
                identifier = activity["obligation_id"]
                curve = curves[identifier]
                change = money(decimal(activity["amount"]))
                current = recognized[identifier] + change
                curve.anchor = _fraction(curve.obligation, day, measures)
                curve.recognized = current
                recognized[identifier] = current
                schedule[(day.strftime("%Y-%m"), identifier)] += change
                if curve.anchor >= ONE and current != curve.target:
                    warnings.append(f"{contract['name']} / {curve.obligation['name']}: adjustment after full satisfaction leaves remaining revenue; revise consideration or record a correcting adjustment.")
        else:
            accrue(day)
        if day == previous_end:
            prior_recognized = sum(recognized.values(), ZERO)
        if day == selected_end:
            selected_snapshot = {
                "transaction_price": current_price,
                "recognized_to_date": sum(recognized.values(), ZERO),
                "allocation": [{"obligation_id": identifier, "name": curve.obligation["name"],
                                "ssp": amount(decimal(curve.obligation["ssp"])), "amount": amount(curve.target),
                                "retired": curve.frozen}
                               for identifier, curve in curves.items()],
            }
    billed = sum((value for month, value in billings.items() if month <= selected), ZERO)
    previous_billed = sum((value for month, value in billings.items() if month < selected), ZERO)
    total_recognized = selected_snapshot["recognized_to_date"]
    monthly_revenue = sum((value for (month, _), value in schedule.items() if month == selected), ZERO)
    ending_deferred, ending_asset = max(ZERO, billed - total_recognized), max(ZERO, total_recognized - billed)
    beginning_deferred, beginning_asset = max(ZERO, previous_billed - prior_recognized), max(ZERO, prior_recognized - previous_billed)
    report = {
        "id": contract["id"], "name": contract["name"], "customer_id": contract["customer_id"],
        "transaction_price": amount(selected_snapshot["transaction_price"]), "revenue": amount(monthly_revenue),
        "recognized_to_date": amount(total_recognized), "billings": amount(billings[selected]),
        "billed_to_date": amount(billed), "deferred_revenue": amount(ending_deferred), "contract_asset": amount(ending_asset),
        "remaining_revenue": amount(selected_snapshot["transaction_price"] - total_recognized),
        "allocation": selected_snapshot["allocation"],
        "beginning_deferred_revenue": amount(beginning_deferred), "beginning_contract_asset": amount(beginning_asset),
        "catch_ups": [row for row in catch_ups if row["period"] == selected],
    }
    rows = [{"period": month, "contract_id": contract["id"], "obligation_id": identifier, "revenue": amount(value)}
            for (month, identifier), value in sorted(schedule.items()) if first.strftime("%Y-%m") <= month <= last.strftime("%Y-%m")]
    for identifier, curve in curves.items():
        if curve.frozen:
            continue
        obligation = curve.obligation
        if obligation["method"] in {"progress", "usage", "milestone", "point_in_time"} and curve.value(last, measures) != curve.target:
            warnings.append(f"{contract['name']} / {obligation['name']}: unsatisfied revenue has no forecast date; record further satisfaction activity.")
        if obligation["method"] == "usage" and measures.get(identifier, ZERO) > decimal(obligation["total_units"]):
            warnings.append(f"{contract['name']} / {obligation['name']}: recorded usage exceeds total_units; recognition is capped at the allocation.")
    return report, rows, catch_ups, warnings


def _journals(report: dict, period: str, accounts: dict[str, str]) -> list[dict]:
    movements = {
        "billing_clearing": decimal(report["billings"]),
        "contract_asset": decimal(report["contract_asset"]) - decimal(report["beginning_contract_asset"]),
        "deferred_revenue": decimal(report["beginning_deferred_revenue"]) - decimal(report["deferred_revenue"]),
        "revenue": -decimal(report["revenue"]),
    }
    if sum(movements.values(), ZERO) != ZERO:
        raise ValueError(f"Journal does not balance for contract {report['id']}")
    return [{
        "id": f"{period}:{report['id']}:{role}", "period": period, "contract_id": report["id"],
        "account": str(accounts[role]), "account_name": ACCOUNT_NAMES[role], "role": role,
        "debit": amount(max(ZERO, value)), "credit": amount(max(ZERO, -value)),
        "debit_minor": int(max(ZERO, value) * 100), "credit_minor": int(max(ZERO, -value) * 100),
        "description": f"{report['name']} — {period} revenue and billing movement",
    } for role, value in movements.items() if value != ZERO]


def calculate(state: dict, period: str) -> dict:
    """Project every contract and derive balanced journals for a selected month.

The supplied state is the already selected temporal/scenario frontier. This
function never mutates it and does not replace the application's closed-period
checkpoint protection. Projections use known future activity; unsatisfied manual
progress/usage is left unforecast rather than inventing future performance.

Exact-day recognition includes both endpoints. Monthly recognition gives each
touched calendar month equal weight, prorating inside that month for midmonth
changes. A material right recognizes on recorded exercise or expiration; exercise
here means the related promised goods/services have actually been transferred.
Exercise alone is insufficient where those goods/services remain undelivered.

Prospective modifications preserve prior-day revenue and allocate remaining
lifetime consideration using remaining SSP (SSP times unsatisfied proportion).
Catch-up changes recalculate required cumulative revenue and post the difference
on the effective date. Same-day changes apply before satisfaction; adjustments
follow satisfaction. Command order is preserved within each of those phases.
An adjustment changes cumulative revenue immediately and
spreads the residual allocation across remaining satisfaction; a subsequent
catch-up conclusion supersedes that prior cumulative carrying amount.
    """
    period_end(period)
    policy = state.get("policy", {})
    versions = state.get("policy_versions", [])
    if versions:
        applicable = [row for row in versions if row.get("effective_period", "0001-01") <= period]
        if not applicable:
            raise ValueError(f"No accounting policy is effective for {period}")
        policy = max(applicable, key=lambda row: (row.get("effective_period", "0001-01"), row.get("version", 0)))
    if policy.get("rounding", "ROUND_HALF_UP") != "ROUND_HALF_UP":
        raise ValueError("The supported posting policy is ROUND_HALF_UP")
    accounts = {**DEFAULT_ACCOUNTS, **policy.get("accounts", {})}
    if any(not str(accounts[role]).strip() for role in DEFAULT_ACCOUNTS):
        raise ValueError("All four journal account roles require an account code")
    report: dict[str, Any] = {"period": period, "summary": {}, "contracts": [], "schedule": [], "journals": [], "warnings": [], "catch_ups": [],
                              "policy_version": policy.get("version", 1), "policy_effective_period": policy.get("effective_period", "0001-01"),
                              "policy_accounts": accounts}
    identifiers = set()
    with localcontext() as context:
        context.prec = 48
        for contract in state.get("contracts", []):
            validate_contract(contract)
            if contract["id"] in identifiers:
                raise ValueError(f"Duplicate contract id: {contract['id']}")
            identifiers.add(contract["id"])
            projection, schedule, catch_ups, warnings = _project(contract, period)
            report["contracts"].append(projection)
            report["schedule"].extend(schedule)
            report["catch_ups"].extend(catch_ups)
            report["warnings"].extend(warnings)
            report["journals"].extend(_journals(projection, period, accounts))
        report["summary"] = {key: amount(sum((decimal(item[key]) for item in report["contracts"]), ZERO)) for key in REPORT_AMOUNTS}
    report["schedule"].sort(key=lambda item: (item["period"], item["contract_id"], item["obligation_id"]))
    report["warnings"] = list(dict.fromkeys(report["warnings"]))
    return report
