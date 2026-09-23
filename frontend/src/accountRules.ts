import type { AccountDimensionRule } from "./types";

/** Parse a table pasted from a reviewed chart; blank dimension cells mean absent. */
export function parseApprovedCombinations(input: string): AccountDimensionRule[] {
  const lines = input.replaceAll("\r", "").split("\n").filter((line) => line.trim());
  if (lines.length < 2) throw new Error("Paste a header and at least one account row.");
  const headers = lines[0].split("\t").map((value) => value.trim());
  if (headers[0]?.toLowerCase() !== "account" || headers.some((value) => !value) ||
      new Set(headers.map((value) => value.toLowerCase())).size !== headers.length) {
    throw new Error("Use a unique Account header followed by distinct dimension names.");
  }
  const seen = new Set<string>();
  return lines.slice(1).map((line, index) => {
    const cells = line.split("\t").map((value) => value.trim());
    if (cells.length > headers.length || !cells[0]) {
      throw new Error(`Row ${index + 2} needs an account and no extra columns.`);
    }
    const dimensions = Object.fromEntries(headers.slice(1).flatMap((name, i) =>
      cells[i + 1] ? [[name, cells[i + 1]]] : []));
    const rule = { account: cells[0], dimensions };
    const identity = JSON.stringify([rule.account, Object.entries(dimensions).sort(([a], [b]) => a.localeCompare(b))]);
    if (seen.has(identity)) throw new Error(`Row ${index + 2} repeats an approved combination.`);
    seen.add(identity);
    return rule;
  });
}
