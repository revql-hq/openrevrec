import type { Contract } from "./types";

/** A credit can reference only an earlier positive invoice from its legal source agreement. */
export function eligibleBillingOriginals(contract: Contract, effectiveDate: string, sourceReference: string) {
  return contract.activities.filter((item) => {
    if (item.type !== "billing" || Number(item.amount || 0) <= 0 || item.effective_date > effectiveDate) return false;
    if (!contract.source_contracts?.length) return true;
    return Boolean(sourceReference) && (item.source_contract_reference || contract.reference) === sourceReference;
  });
}
