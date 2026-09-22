import type { Component, Contract, Obligation } from "./types";

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
    }
  }
  return { consideration, obligations, termAssessment };
}

export function changeComponentKind(item: Component, kind: string): Component {
  const next = { ...item, kind };
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
    delete next.allocation_rationale;
  }
  return next;
}
