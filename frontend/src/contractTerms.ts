import type { Component, Contract, Obligation, State } from "./types";

/** Replay dated terms in the same effective-date / command order as the engine. */
export function contractTerms(contract: Contract, effectiveDate: string) {
  let consideration = contract.consideration.map((item) => ({ ...item }));
  let obligations = contract.obligations.map((item) => ({ ...item }));
  const termAssessment = {
    basis: (contract.term_basis || "fixed") as NonNullable<Contract["term_basis"]>,
    rationale: contract.term_assessment_rationale || "",
    trigger: contract.term_reassessment_trigger || "",
    reviewDate: contract.term_review_date || "",
  };
  const changes = contract.activities
    .filter((activity) => activity.effective_date <= effectiveDate)
    .sort((a, b) => a.effective_date.localeCompare(b.effective_date));
  for (const activity of changes) {
    if (activity.type === "modification") {
      if (activity.term_basis === "fixed" || activity.term_basis === "cancellable" || activity.term_basis === "evergreen") {
        termAssessment.basis = activity.term_basis;
        if (activity.term_basis === "fixed") {
          termAssessment.rationale = "";
          termAssessment.trigger = "";
          termAssessment.reviewDate = "";
        }
      }
      if (typeof activity.term_assessment_rationale === "string") termAssessment.rationale = activity.term_assessment_rationale;
      if (typeof activity.term_reassessment_trigger === "string") termAssessment.trigger = activity.term_reassessment_trigger;
      if (typeof activity.term_review_date === "string") termAssessment.reviewDate = activity.term_review_date;
      if (activity.consideration) {
        consideration = (activity.consideration as Component[]).map((item) => ({
          ...item,
        }));
      }
      if (activity.obligations) {
        obligations = (activity.obligations as Obligation[]).map((item) => ({
          ...item,
        }));
      }
    } else if (activity.type === "reassessment") {
      consideration = consideration.map((item) =>
        item.id === activity.component_id
          ? { ...item, included_amount: activity.included_amount as string }
          : item,
      );
    } else if (activity.type === "rate_change") {
      consideration = consideration.map((item) =>
        item.id === activity.component_id
          ? { ...item, unit_rate: activity.unit_rate as string }
          : item,
      );
    }
  }
  return { consideration, obligations, termAssessment };
}

/** A documented unchanged review replaces only the planned review date. */
export function termReviewStatus(state: State, contract: Contract, effectiveDate: string) {
  const terms = contractTerms(contract, effectiveDate).termAssessment;
  const assessments = contract.activities
    .filter((activity) => activity.type === "modification" && activity.effective_date <= effectiveDate &&
      ["term_basis", "term_assessment_rationale", "term_reassessment_trigger", "term_review_date"].some((field) => field in activity))
    .sort((a, b) => a.effective_date.localeCompare(b.effective_date) || (a.version || 0) - (b.version || 0));
  const latestAssessment = assessments.at(-1);
  const assessmentVersion = latestAssessment?.version || contract.version || 0;
  const assessmentDate = latestAssessment?.effective_date || contract.start_date;
  const latestReview = (state.term_reviews || [])
    .filter((review) => review.contract_id === contract.id && review.version > assessmentVersion &&
      review.effective_date >= assessmentDate && review.effective_date <= effectiveDate)
    .sort((a, b) => b.effective_date.localeCompare(a.effective_date) || b.version - a.version)[0];
  return { ...terms, reviewDate: latestReview ? latestReview.next_review_date : terms.reviewDate, latestReview };
}

export function changeComponentKind(item: Component, kind: string): Component {
  const next = { ...item, kind };
  if (kind !== "metered") {
    delete next.unit_rate;
    delete next.metered_value_mode;
    delete next.pricing_basis;
    delete next.rounding_period;
  }
  if (kind === "variable" || kind === "usage") {
    next.included_amount ??= item.amount;
  } else {
    delete next.included_amount;
    delete next.potential_amount;
    delete next.estimated_amount;
    delete next.estimation_method;
  }
  if (kind === "fixed") {
    delete next.allocation_scope;
    delete next.target_obligation_ids;
    delete next.target_period;
    delete next.allocation_rationale;
  }
  if (kind === "credit") delete next.target_period;
  if (kind === "metered") {
    next.amount = "0.00";
    next.unit_rate = "";
    next.metered_value_mode = "unit_rate";
    next.pricing_basis = "right_to_invoice";
    next.rounding_period = "calendar_month";
    next.rationale = "";
    delete next.allocation_scope;
    delete next.target_obligation_ids;
    delete next.target_period;
    delete next.allocation_rationale;
  }
  return next;
}
