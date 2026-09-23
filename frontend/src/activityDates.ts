import { contractTerms } from "./contractTerms.ts";
import type { Contract, Obligation } from "./types";

function supportsActivity(contract: Contract, obligation: Obligation, activity: string) {
  if (activity === "progress") return obligation.method === "progress";
  if (activity === "usage") return ["usage", "metered"].includes(obligation.method);
  if (activity === "milestone") return ["milestone", "point_in_time"].includes(obligation.method);
  if (activity === "right_exercise") return obligation.kind === "material_right" &&
    !contract.activities.some((row) => row.type === "right_exercise" && row.obligation_id === obligation.id);
  return activity === "adjustment";
}

export function activityEarliestDate(contract: Contract, activity: string, obligation?: Obligation) {
  if (!["progress", "usage", "milestone", "right_exercise"].includes(activity)) return contract.start_date;
  const start = obligation?.start_date || contract.start_date;
  if (activity === "milestone" && obligation?.kind === "material_right") {
    const exercise = contract.activities.find((row) => row.type === "right_exercise" && row.obligation_id === obligation.id);
    return typeof exercise?.delivery_start === "string" ? exercise.delivery_start : obligation.exercise_start || start;
  }
  return activity === "right_exercise" ? obligation?.exercise_start || start : start;
}

/** Start a new activity on a date where its contract and chosen service exist. */
export function suggestedActivityDate(contract: Contract, period: string, activity: string, correctionDate?: string) {
  if (correctionDate) return correctionDate;
  const periodStart = `${period}-01`;
  if (activity === "billing") return periodStart; // Advance invoices can precede delivery.
  const earliest = periodStart > contract.start_date ? periodStart : contract.start_date;
  if (!["progress", "usage", "milestone", "right_exercise"].includes(activity)) return earliest;

  const candidates = new Set([earliest]);
  const versions = [contract.obligations, ...contract.activities
    .filter((row) => row.type === "modification" && Array.isArray(row.obligations))
    .map((row) => row.obligations as Obligation[])];
  for (const obligations of versions) {
    for (const obligation of obligations) {
      if (!supportsActivity(contract, obligation, activity)) continue;
      const start = activityEarliestDate(contract, activity, obligation);
      candidates.add(start > earliest ? start : earliest);
    }
  }
  for (const change of contract.activities) {
    if (change.type === "modification" && change.effective_date > earliest) candidates.add(change.effective_date);
  }
  for (const day of [...candidates].sort()) {
    const active = contractTerms(contract, day).obligations;
    if (active.some((obligation) => supportsActivity(contract, obligation, activity) &&
      activityEarliestDate(contract, activity, obligation) <= day &&
      (activity !== "right_exercise" || !obligation.exercise_end || day <= obligation.exercise_end))) return day;
  }
  return earliest;
}
