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
METHODS = {"exact_days", "monthly", "prorated_monthly", "point_in_time", "progress", "usage", "milestone"}
KINDS = {"service", "implementation", "license", "support", "product", "material_right", "other"}
CONSIDERATION_KINDS = {"fixed", "variable", "usage", "credit"}
ACTIVITY_TYPES = {"billing", "progress", "usage", "milestone", "adjustment", "modification", "reassessment", "opening_position", "right_exercise"}
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


TERM_FIELDS = ("term_basis", "term_assessment_rationale", "term_reassessment_trigger", "term_review_date")


def _validate_term_assessment(terms: dict, effective_date: date | None) -> None:
    basis = terms.get("term_basis", "fixed")
    if not isinstance(basis, str) or basis not in {"fixed", "cancellable", "evergreen"}:
        raise ValueError("Term basis must be fixed, cancellable, or evergreen")
    if basis != "fixed":
        if not isinstance(terms.get("term_assessment_rationale"), str) or not terms["term_assessment_rationale"].strip():
            raise ValueError("A cancellable or evergreen term needs an assessed-term rationale")
        if not isinstance(terms.get("term_reassessment_trigger"), str) or not terms["term_reassessment_trigger"].strip():
            raise ValueError("A cancellable or evergreen term needs a reassessment trigger")
    elif any(terms.get(field) for field in TERM_FIELDS[1:]):
        raise ValueError("Fixed terms cannot carry a cancellable or evergreen term assessment")
    if terms.get("term_review_date"):
        review_date = _date(terms["term_review_date"], "term_review_date")
        if effective_date is not None and review_date < effective_date:
            raise ValueError("Term review date cannot precede the assessment date")


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


def _allocate_components(components: list[dict], obligations: list[dict]) -> dict[str, Decimal]:
    """Allocate the relative-SSP pool and explicitly targeted components."""
    weights = {item["id"]: item["ssp"] for item in obligations}
    targeted = [item for item in components if item.get("allocation_scope") == "specific"]
    if not targeted:
        return allocate(_price(components), weights)
    targeted_total = sum((_price([item]) for item in targeted), ZERO)
    result = allocate(_price(components) - targeted_total, weights)
    for component in targeted:
        targets = set(component["target_obligation_ids"])
        part = allocate(_price([component]), {identifier: weight for identifier, weight in weights.items() if identifier in targets})
        for identifier, value in part.items():
            result[identifier] += value
    if sum(result.values(), ZERO) != _price(components):
        raise ValueError("Targeted component allocation does not reconcile to transaction price")
    if any(value < ZERO for value in result.values()):
        raise ValueError("Specific allocation cannot leave a negative obligation allocation")
    return result


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
        scope = component.get("allocation_scope", "relative_ssp")
        if not isinstance(scope, str) or scope not in {"relative_ssp", "specific"}:
            raise ValueError("Allocation scope must be relative_ssp or specific")
        if scope == "specific":
            if kind not in {"variable", "usage", "credit"}:
                raise ValueError("Specific allocation is supported for variable, usage, or credit components")
            targets = component.get("target_obligation_ids")
            if not isinstance(targets, list) or not targets or any(not isinstance(target, str) or not target for target in targets) or len(targets) != len(set(targets)):
                raise ValueError("Specific allocation requires distinct target obligation IDs")
            if not isinstance(component.get("allocation_rationale"), str) or not component["allocation_rationale"].strip():
                raise ValueError("Specific allocation requires the accountant's rationale")
            value = decimal(component.get("included_amount", component["amount"]))
            if value != money(value):
                raise ValueError("Specifically allocated consideration must be stated in cents")
        elif component.get("target_obligation_ids"):
            raise ValueError("Target obligations require specific allocation scope")
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
            if any(field in obligation for field in ("delivery_method", "delivery_start", "delivery_end")):
                raise ValueError("Record material-right delivery through an exercise event, not baseline terms")
            exercise_start = _date(obligation.get("exercise_start", obligation["start_date"]), "exercise_start")
            exercise_end = _date(obligation.get("exercise_end", obligation["end_date"]), "exercise_end")
            if exercise_end < exercise_start or exercise_start < start:
                raise ValueError("Material-right exercise window must follow the grant and have a valid end")
    if obligations and not any(decimal(item["ssp"]) > ZERO for item in obligations) and _price(components) != ZERO:
        raise ValueError("A nonzero transaction price requires positive SSP")
    obligation_weights = {item["id"]: decimal(item["ssp"]) for item in obligations}
    for component in components:
        if component.get("allocation_scope") == "specific":
            targets = component["target_obligation_ids"]
            if any(target not in obligation_weights for target in targets) or sum((obligation_weights[target] for target in targets), ZERO) <= ZERO:
                raise ValueError("Specific allocation targets must be current obligations with positive SSP")


def _ordered_activities(contract: dict) -> list[dict]:
    # Terms take effect at the beginning of a day, before that day's delivery.
    # Preserve command order within each phase, including successive revisions.
    def phase(item: dict) -> int:
        return (0 if item.get("type") in {"modification", "reassessment"} else
                1 if item.get("type") == "right_exercise" else
                3 if item.get("type") == "adjustment" else 2)

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
    term_assessment = {field: contract[field] for field in TERM_FIELDS if field in contract}
    _validate_term_assessment(term_assessment, start)
    declared_cutover = _date(contract["cutover_date"], "cutover_date") if contract.get("cutover_date") else None
    if declared_cutover and (declared_cutover.day != 1 or declared_cutover <= start):
        raise ValueError("Contract cutover must be the first day of a month after the contract begins")
    components = deepcopy(contract.get("consideration"))
    obligations = deepcopy(contract.get("obligations"))
    _validate_terms(components, obligations)
    if term_assessment.get("term_basis") in {"cancellable", "evergreen"} and any(_date(item["end_date"], "obligation end_date") > end for item in obligations):
        raise ValueError("An obligation cannot extend beyond the initial assessed accounting end")
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
    openings = [activity for activity in activities if activity.get("type") == "opening_position"]
    if len(openings) > 1:
        raise ValueError("A contract can have only one opening position")
    if openings:
        opening_day = _date(openings[0]["effective_date"])
        if opening_day.day != 1 or opening_day <= start:
            raise ValueError("Opening position must start on the first day of a month after the contract begins")
        if declared_cutover and opening_day != declared_cutover:
            raise ValueError("Opening position date must match the contract's declared cutover")
        if any(activity is not openings[0] and _date(activity["effective_date"]) < opening_day for activity in activities):
            raise ValueError("Do not mix reconstructed pre-cutover activity with an opening position")
        if any(activity is not openings[0] and activity.get("type") in {"modification", "reassessment"} and _date(activity["effective_date"]) == opening_day for activity in activities):
            raise ValueError("Opening terms already represent the cutover judgment; record later term changes after the cutover day")
    exercised_rights: dict[str, dict] = {}
    delivered_rights: set[str] = set()
    for activity in _ordered_activities(contract):
        kind = activity.get("type")
        if kind not in ACTIVITY_TYPES:
            raise ValueError(f"Unsupported activity type: {kind}")
        if kind == "opening_position":
            if not str(activity.get("source_name", "")).strip() or not str(activity.get("rationale", "")).strip():
                raise ValueError("Opening position requires a legacy source and reconciliation rationale")
            rows = activity.get("opening_obligations")
            if not isinstance(rows, list) or any(not isinstance(row, dict) or not isinstance(row.get("obligation_id"), str) for row in rows) or {row["obligation_id"] for row in rows} != {item["id"] for item in obligations} or len(rows) != len(obligations):
                raise ValueError("Opening position needs one recognized amount for every current obligation")
            allocations = _allocate_components(components, obligations)
            recognized_total = ZERO
            for row in rows:
                obligation = next(item for item in obligations if item["id"] == row["obligation_id"])
                raw_recognized = decimal(row.get("recognized_to_date"), "opening recognized amount")
                recognized_amount = money(raw_recognized)
                if raw_recognized != recognized_amount:
                    raise ValueError("Opening monetary amounts must be stated in cents")
                if not ZERO <= recognized_amount <= allocations[obligation["id"]]:
                    raise ValueError("Opening recognized amounts must be between zero and their allocated consideration")
                recognized_total += recognized_amount
                if obligation["method"] in {"progress", "milestone", "point_in_time", "usage"}:
                    measure = decimal(row.get("measure"), "opening cumulative measure")
                    limit = decimal(obligation["total_units"]) if obligation["method"] == "usage" else Decimal(100)
                    if not ZERO <= measure <= limit or (obligation["method"] == "point_in_time" and measure not in {ZERO, Decimal(100)}):
                        raise ValueError("Opening cumulative measure is outside the obligation's supported range")
                else:
                    if row.get("measure") not in (None, ""):
                        raise ValueError("Time-based obligations do not use an opening cumulative measure")
                    measure = ZERO
                if obligation["kind"] == "material_right":
                    expired = opening_day > _date(obligation.get("exercise_end", obligation["end_date"]))
                    expected = allocations[obligation["id"]] if expired or measure == Decimal(100) else ZERO
                    if recognized_amount != expected:
                        raise ValueError("Opening material-right recognition must match delivery or expiry; partial breakage estimates need separate review")
                    if measure == Decimal(100):
                        delivered_rights.add(obligation["id"])
                if _fraction(obligation, opening_day - timedelta(days=1), {obligation["id"]: measure}) >= ONE and recognized_amount != allocations[obligation["id"]]:
                    raise ValueError("A fully satisfied obligation must have its full allocation recognized at cutover")
            billed = decimal(activity.get("billed_to_date"), "opening billed amount")
            asset = decimal(activity.get("contract_asset"), "opening contract asset")
            deferred = decimal(activity.get("deferred_revenue"), "opening deferred revenue")
            if any(value != money(value) for value in (billed, asset, deferred)):
                raise ValueError("Opening monetary amounts must be stated in cents")
            if billed < ZERO or asset < ZERO or deferred < ZERO or (asset and deferred):
                raise ValueError("Opening billing and balances must be nonnegative, with only one net balance side")
            if recognized_total - billed != asset - deferred:
                raise ValueError("Opening recognized less billed must reconcile to the legacy contract asset or deferred revenue")
            continue
        if kind == "modification":
            if activity.get("treatment") not in {"prospective", "catch_up"}:
                raise ValueError("Modification treatment must be prospective or catch_up")
            if not str(activity.get("rationale", "")).strip():
                raise ValueError("A modification requires an accounting rationale")
            if any(field in activity for field in TERM_FIELDS):
                prior_review_date = term_assessment.get("term_review_date")
                if activity.get("term_basis") == "fixed":
                    term_assessment = {}
                term_assessment.update({field: activity[field] for field in TERM_FIELDS if field in activity})
                review_effective = _date(activity["effective_date"]) if term_assessment.get("term_review_date") != prior_review_date else None
                _validate_term_assessment(term_assessment, review_effective)
            components = deepcopy(activity.get("consideration", components))
            revised_obligations = deepcopy(activity.get("obligations", obligations))
            for identifier in exercised_rights:
                prior_right = next((item for item in obligations if item["id"] == identifier), None)
                revised_right = next((item for item in revised_obligations if item["id"] == identifier), None)
                if prior_right is None or revised_right is None or any(prior_right.get(field) != revised_right.get(field) for field in ("kind", "method", "ssp", "start_date", "end_date", "exercise_start", "exercise_end")):
                    raise ValueError("An exercised material right needs a separate reviewed treatment before changing or removing its terms")
            obligations = revised_obligations
            _validate_terms(components, obligations, allow_empty=True)
            if activity["treatment"] == "prospective" and any(item.get("allocation_scope") == "specific" for item in components):
                raise ValueError("Prospective modifications with specifically allocated components need a separate reviewed allocation treatment")
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
            if component.get("allocation_scope") == "specific" and decimal(component["included_amount"]) != money(decimal(component["included_amount"])):
                raise ValueError("Specifically allocated consideration must be stated in cents")
            if _price(components) < ZERO:
                raise ValueError("Total transaction price cannot be negative")
            continue
        if kind == "billing":
            decimal(activity.get("amount"), "billing amount")
            continue
        obligation = next((item for item in obligations if item["id"] == activity.get("obligation_id")), None)
        if obligation is None:
            raise ValueError(f"Activity references an unknown current obligation: {activity.get('obligation_id')}")
        if kind == "right_exercise":
            identifier = obligation["id"]
            if obligation["kind"] != "material_right":
                raise ValueError("Exercise must identify a material-right obligation")
            if identifier in exercised_rights or identifier in delivered_rights:
                raise ValueError("A material right can be exercised or delivered only once")
            first = obligation.get("exercise_start", obligation["start_date"])
            last = obligation.get("exercise_end", obligation["end_date"])
            if not first <= activity["effective_date"] <= last:
                raise ValueError("Material-right exercise must fall within the exercise window")
            delivery_method = activity.get("delivery_method")
            if delivery_method not in {"exact_days", "monthly", "prorated_monthly", "point_in_time"}:
                raise ValueError("Choose a supported material-right delivery method")
            delivery_start = _date(activity.get("delivery_start"), "delivery_start")
            delivery_end = _date(activity.get("delivery_end"), "delivery_end")
            if delivery_start < _date(activity["effective_date"]) or delivery_end < delivery_start:
                raise ValueError("Material-right delivery must begin on or after exercise and end on or after delivery begins")
            if delivery_method == "point_in_time" and delivery_start != delivery_end:
                raise ValueError("Point-in-time material-right delivery needs one delivery date")
            if not str(activity.get("rationale", "")).strip():
                raise ValueError("Material-right exercise needs an accounting rationale")
            exercised_rights[identifier] = activity
            continue
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
                if obligation["id"] in exercised_rights:
                    exercise = exercised_rights[obligation["id"]]
                    if exercise["delivery_method"] != "point_in_time" or activity["effective_date"] != exercise["delivery_start"]:
                        raise ValueError("Material-right satisfaction must match the exercised point-in-time delivery date")
                else:
                    first = obligation.get("exercise_start", obligation["start_date"])
                    last = obligation.get("exercise_end", obligation["end_date"])
                    if not first <= activity["effective_date"] <= last:
                        raise ValueError("Material-right delivery must fall within the exercise window")
                if percentage == Decimal(100):
                    delivered_rights.add(obligation["id"])


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
    if method == "prorated_monthly":
        if day >= end:
            return ONE
        count = (end.year - start.year) * 12 + end.month - start.month + 1
        first_end = min(end, _month_end(start))
        first_weight = Decimal((first_end - start).days + 1) / Decimal(_month_end(start).day)
        if count == 1:
            total_weight = first_weight
            elapsed = Decimal((day - start).days + 1) / Decimal(_month_end(start).day)
        else:
            last_start = end.replace(day=1)
            last_weight = Decimal((end - last_start).days + 1) / Decimal(_month_end(end).day)
            total_weight = first_weight + Decimal(count - 2) + last_weight
            months_before = (day.year - start.year) * 12 + day.month - start.month
            elapsed = (Decimal((day - start).days + 1) / Decimal(_month_end(start).day) if months_before == 0 else
                       first_weight + Decimal(months_before - 1) + Decimal(day.day) / Decimal(_month_end(day).day))
        return min(ONE, elapsed / total_weight)
    if obligation["kind"] == "material_right":
        if obligation.get("delivery_method"):
            delivered = {**obligation, "kind": "service", "method": obligation["delivery_method"],
                         "start_date": obligation["delivery_start"], "end_date": obligation["delivery_end"]}
            return _fraction(delivered, day, measures)
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
    allocations = _allocate_components(components, obligations)
    curves = {item["id"]: _Curve(item, allocations[item["id"]]) for item in obligations}
    measures: dict[str, Decimal] = {}
    recognized: dict[str, Decimal] = defaultdict(lambda: ZERO)
    schedule: dict[tuple[str, str], Decimal] = defaultdict(lambda: ZERO)
    activities: dict[date, list[dict]] = defaultdict(list)
    opening = next((item for item in contract.get("activities", []) if item["type"] == "opening_position"), None)
    cutover_day = _date(opening["effective_date"]) if opening else None
    opening_billed = ZERO
    if opening:
        opening_billed = money(decimal(opening["billed_to_date"]))
        for row in opening["opening_obligations"]:
            identifier = row["obligation_id"]
            obligation = curves[identifier].obligation
            recognized[identifier] = money(decimal(row["recognized_to_date"]))
            if obligation["method"] in {"progress", "milestone", "point_in_time", "usage"}:
                measures[identifier] = decimal(row["measure"])
            curve = curves[identifier]
            curve.anchor = _fraction(obligation, cutover_day - timedelta(days=1), measures)
            curve.recognized = recognized[identifier]
    all_dates = [_date(contract["start_date"]), _date(contract["end_date"])]
    for item in obligations:
        all_dates.extend([_date(item["start_date"]), _date(item["end_date"])])
        if item.get("exercise_end"):
            all_dates.append(_date(item["exercise_end"]))
    for activity in _ordered_activities(contract):
        if activity["type"] == "opening_position":
            continue
        day = _date(activity["effective_date"])
        activities[day].append(activity)
        all_dates.append(day)
        if activity["type"] == "right_exercise":
            all_dates.extend([_date(activity["delivery_start"]), _date(activity["delivery_end"])])
        for item in activity.get("obligations", []):
            all_dates.extend([_date(item["start_date"]), _date(item["end_date"])])
            if item.get("exercise_end"):
                all_dates.append(_date(item["exercise_end"]))
    selected_end = period_end(selected)
    previous_end = selected_end.replace(day=1) - timedelta(days=1)
    first = cutover_day or min(all_dates + [selected_end])
    last = max(all_dates + [selected_end])
    months = list(_periods(first, last))
    boundaries = {period_end(month) for month in months}
    for day in activities:
        boundaries.add(day)
        if day - timedelta(days=1) >= first:
            boundaries.add(day - timedelta(days=1))
    boundaries.add(selected_end)
    if previous_end >= first:
        boundaries.add(previous_end)
    billings: dict[str, Decimal] = defaultdict(lambda: ZERO)
    catch_ups: list[dict] = []
    warnings: list[str] = []
    selected_snapshot: dict = {}
    prior_recognized = sum(recognized.values(), ZERO)
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
                for item in obligations:
                    old = old_curves.get(item["id"])
                    if old and old.obligation.get("delivery_method"):
                        for field in ("delivery_method", "delivery_start", "delivery_end"):
                            item[field] = old.obligation[field]
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
                    allocated = _allocate_components(components, obligations)
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
                if kind == "right_exercise":
                    obligation = next(item for item in obligations if item["id"] == identifier)
                    for field in ("delivery_method", "delivery_start", "delivery_end"):
                        obligation[field] = activity[field]
                        curves[identifier].obligation[field] = activity[field]
                elif kind in {"progress", "milestone"}:
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
                "allocation_components": [{"component_id": item["id"], "label": item.get("label", item["id"]), "kind": item["kind"],
                                           "included_amount": amount(_price([item])),
                                           "scope": item.get("allocation_scope", "relative_ssp"),
                                           "target_obligation_ids": item.get("target_obligation_ids", []),
                                           "rationale": item.get("allocation_rationale", "")}
                                          for item in components],
            }
    billed = opening_billed + sum((value for month, value in billings.items() if month <= selected), ZERO)
    previous_billed = opening_billed + sum((value for month, value in billings.items() if month < selected), ZERO)
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
        "allocation_components": selected_snapshot["allocation_components"],
        "cutover_period": cutover_day.strftime("%Y-%m") if cutover_day else None,
        "beginning_deferred_revenue": amount(beginning_deferred), "beginning_contract_asset": amount(beginning_asset),
        "catch_ups": [row for row in catch_ups if row["period"] == selected],
    }
    rows = [{"period": month, "contract_id": contract["id"], "obligation_id": identifier, "revenue": amount(value)}
            for (month, identifier), value in sorted(schedule.items()) if first.strftime("%Y-%m") <= month <= last.strftime("%Y-%m")]
    for identifier, curve in curves.items():
        if curve.frozen:
            continue
        obligation = curve.obligation
        if obligation["method"] in {"milestone", "point_in_time"} and curve.value(last, measures) != curve.target:
            warnings.append(f"{contract['name']} / {obligation['name']}: satisfaction has not been recorded; confirm whether delivery occurred.")
        if obligation["method"] == "usage" and measures.get(identifier, ZERO) > decimal(obligation["total_units"]):
            warnings.append(f"{contract['name']} / {obligation['name']}: recorded usage exceeds total_units; recognition is capped at the allocation.")
    return report, rows, catch_ups, warnings


def _assigned_profile(profiles: dict | None, assignments: dict | None, contract_id: str) -> dict:
    return (profiles or {}).get((assignments or {}).get(contract_id), {})


def _resolved_dimensions(profiles: dict | None, assignments: dict | None, contract_id: str) -> dict[str, str]:
    return _assigned_profile(profiles, assignments, contract_id).get("dimensions", {})


def _resolved_account(accounts: dict, overrides: dict, contract_id: str, role: str, obligation_id: str | None = None, *, profiles: dict | None = None, assignments: dict | None = None) -> str:
    if obligation_id is not None:
        account = overrides.get("obligations", {}).get(contract_id, {}).get(obligation_id)
        if account:
            return str(account)
    return str(overrides.get("contracts", {}).get(contract_id, {}).get(role) or _assigned_profile(profiles, assignments, contract_id).get("accounts", {}).get(role) or accounts[role])


def _journals(report: dict, period: str, accounts: dict[str, str], overrides: dict, profiles: dict, assignments: dict, schedule: list[dict], previous_accounts: dict, previous_overrides: dict, previous_profiles: dict, previous_assignments: dict, transition: str) -> tuple[list[dict], list[dict], list[str]]:
    movements = {
        "billing_clearing": decimal(report["billings"]),
        "contract_asset": decimal(report["contract_asset"]) - decimal(report["beginning_contract_asset"]),
        "deferred_revenue": decimal(report["beginning_deferred_revenue"]) - decimal(report["deferred_revenue"]),
        "revenue": -decimal(report["revenue"]),
    }
    if sum(movements.values(), ZERO) != ZERO:
        raise ValueError(f"Journal does not balance for contract {report['id']}")
    result, transitions, warnings = [], [], []
    contract_id = report["id"]
    current_dimensions = _resolved_dimensions(profiles, assignments, contract_id)
    current_profile_id = assignments.get(contract_id)
    def entry(role, account, value, description, suffix="", obligation_ids=None, *, dimensions=None, profile_id=None):
        if value == ZERO:
            return
        row = {
            "id": f"{period}:{report['id']}:{role}{suffix}", "period": period, "contract_id": report["id"],
            "account": account, "account_name": ACCOUNT_NAMES[role], "role": role,
            "debit": amount(max(ZERO, value)), "credit": amount(max(ZERO, -value)),
            "debit_minor": int(max(ZERO, value) * 100), "credit_minor": int(max(ZERO, -value) * 100),
            "description": description,
        }
        if obligation_ids:
            row["obligation_ids"] = obligation_ids
        applied_dimensions = current_dimensions if dimensions is None else dimensions
        if applied_dimensions:
            row["dimensions"] = applied_dimensions.copy()
        applied_profile = current_profile_id if profile_id is None else profile_id
        if applied_profile:
            row["account_profile_id"] = applied_profile
        result.append(row)

    description = f"{report['name']} — {period} revenue and billing movement"
    for role in ("billing_clearing", "contract_asset", "deferred_revenue"):
        entry(role, _resolved_account(accounts, overrides, contract_id, role, profiles=profiles, assignments=assignments), movements[role], description)
    revenue_by_account: dict[str, Decimal] = defaultdict(lambda: ZERO)
    obligations_by_account: dict[str, set[str]] = defaultdict(set)
    for row in schedule:
        if row["period"] == period:
            account = _resolved_account(accounts, overrides, contract_id, "revenue", row["obligation_id"], profiles=profiles, assignments=assignments)
            revenue_by_account[account] += decimal(row["revenue"])
            obligations_by_account[account].add(row["obligation_id"])
    if sum(revenue_by_account.values(), ZERO) != decimal(report["revenue"]):
        raise ValueError(f"Revenue detail does not reconcile for contract {contract_id}")
    for account, revenue in sorted(revenue_by_account.items()):
        suffix = "" if len(revenue_by_account) == 1 else f":{account}"
        entry("revenue", account, -revenue, description, suffix, sorted(obligations_by_account[account]))

    for role, opening_field in (("contract_asset", "beginning_contract_asset"), ("deferred_revenue", "beginning_deferred_revenue")):
        if report.get("cutover_period") == period:
            # A migrated balance enters under the cutover policy. It was not
            # carried in the workspace's prior-period account to transfer.
            continue
        old = _resolved_account(previous_accounts, previous_overrides, contract_id, role, profiles=previous_profiles, assignments=previous_assignments)
        new = _resolved_account(accounts, overrides, contract_id, role, profiles=profiles, assignments=assignments)
        old_dimensions = _resolved_dimensions(previous_profiles, previous_assignments, contract_id)
        opening = decimal(report[opening_field])
        if (old == new and old_dimensions == current_dimensions) or opening == ZERO:
            continue
        change = {"contract_id": contract_id, "role": role, "from_account": old, "to_account": new, "opening_balance": amount(opening), "treatment": transition}
        if old_dimensions or current_dimensions:
            change.update(from_dimensions=old_dimensions.copy(), to_dimensions=current_dimensions.copy())
        transitions.append(change)
        if transition == "transfer":
            direction = ONE if role == "deferred_revenue" else -ONE
            entry(role, old, opening * direction, f"{report['name']} — transfer opening {ACCOUNT_NAMES[role].lower()} from {old} to {new}", ":transfer-out", dimensions=old_dimensions, profile_id=previous_assignments.get(contract_id, ""))
            entry(role, new, -opening * direction, f"{report['name']} — transfer opening {ACCOUNT_NAMES[role].lower()} from {old} to {new}", ":transfer-in", dimensions=current_dimensions, profile_id=current_profile_id or "")
        else:
            warnings.append(f"{report['name']}: reconcile external transfer of {amount(opening)} {ACCOUNT_NAMES[role].lower()} from {old} to {new} for {period}, including segment dimensions.")
    return result, transitions, warnings


def calculate(state: dict, period: str) -> dict:
    """Project every contract and derive balanced journals for a selected month.

The supplied state is the already selected temporal/scenario frontier. This
function never mutates it and does not replace the application's closed-period
checkpoint protection. Projections use known future activity; unsatisfied manual
progress/usage is left unforecast rather than inventing future performance.

Exact-day recognition includes both endpoints. Monthly recognition gives each
touched calendar month equal weight, prorating inside that month for midmonth
changes. An unexercised material right recognizes at expiry. An exercise event
can schedule its existing allocation over later promised delivery; the election
itself is not satisfaction.

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
    overrides = policy.get("account_overrides", {"contracts": {}, "obligations": {}})
    profiles = policy.get("account_profiles", {})
    assignments = policy.get("profile_assignments", {})
    year, month = (int(part) for part in period.split("-"))
    previous_period = f"{year - 1:04d}-12" if month == 1 else f"{year:04d}-{month - 1:02d}"
    previous_policy = max((row for row in versions if row.get("effective_period", "0001-01") <= previous_period), key=lambda row: (row.get("effective_period", "0001-01"), row.get("version", 0)), default={})
    previous_accounts = {**DEFAULT_ACCOUNTS, **(previous_policy or policy).get("accounts", {})}
    previous_overrides = (previous_policy or policy).get("account_overrides", {"contracts": {}, "obligations": {}})
    previous_profiles = (previous_policy or policy).get("account_profiles", {})
    previous_assignments = (previous_policy or policy).get("profile_assignments", {})
    if any(not str(accounts[role]).strip() for role in DEFAULT_ACCOUNTS):
        raise ValueError("All four journal account roles require an account code")
    report: dict[str, Any] = {"period": period, "summary": {}, "contracts": [], "schedule": [], "journals": [], "account_transitions": [], "warnings": [], "catch_ups": [],
                              "policy_version": policy.get("version", 1), "policy_effective_period": policy.get("effective_period", "0001-01"),
                              "policy_accounts": accounts, "policy_account_overrides": overrides,
                              "policy_account_profiles": profiles, "policy_profile_assignments": assignments}
    identifiers = set()
    with localcontext() as context:
        context.prec = 48
        for contract in state.get("contracts", []):
            validate_contract(contract)
            if contract["id"] in identifiers:
                raise ValueError(f"Duplicate contract id: {contract['id']}")
            identifiers.add(contract["id"])
            opening = next((item for item in contract.get("activities", []) if item["type"] == "opening_position"), None)
            if contract.get("cutover_date") and not opening:
                if period >= contract["cutover_date"][:7]:
                    report["warnings"].append(f"{contract['name']}: the declared cutover has no accepted opening position; reporting excludes this contract until it is recorded.")
                continue
            if opening and period < opening["effective_date"][:7]:
                # The legacy periods are outside this workspace's accepted
                # accounting population. Never backfill them from current terms.
                continue
            projection, schedule, catch_ups, warnings = _project(contract, period)
            report["contracts"].append(projection)
            report["schedule"].extend(schedule)
            report["catch_ups"].extend(catch_ups)
            report["warnings"].extend(warnings)
            journals, transitions, transition_warnings = _journals(projection, period, accounts, overrides, profiles, assignments, schedule, previous_accounts, previous_overrides, previous_profiles, previous_assignments, policy.get("account_transition", "external"))
            report["journals"].extend(journals)
            report["account_transitions"].extend(transitions)
            report["warnings"].extend(transition_warnings)
        report["summary"] = {key: amount(sum((decimal(item[key]) for item in report["contracts"]), ZERO)) for key in REPORT_AMOUNTS}
    report["schedule"].sort(key=lambda item: (item["period"], item["contract_id"], item["obligation_id"]))
    report["warnings"] = list(dict.fromkeys(report["warnings"]))
    return report
