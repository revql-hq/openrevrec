import type { Component, Contract, Obligation } from "./types";

/** Replay dated terms in the same effective-date / command order as the engine. */
export function contractTerms(contract: Contract, effectiveDate: string) {
  let consideration = contract.consideration.map((item) => ({ ...item }));
  let obligations = contract.obligations.map((item) => ({ ...item }));
  const changes = contract.activities
    .filter((activity) => activity.effective_date <= effectiveDate)
    .sort((a, b) => a.effective_date.localeCompare(b.effective_date));
  for (const activity of changes) {
    if (activity.type === "modification") {
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
  return { consideration, obligations };
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
  return next;
}
