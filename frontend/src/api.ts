export async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...options,
    headers:
      options?.body instanceof FormData
        ? options.headers
        : { "Content-Type": "application/json", ...options?.headers },
  });
  const data = await response.json().catch(() => null);
  if (!response.ok)
    throw new Error(
      data?.error || `The request could not be completed (${response.status}).`,
    );
  return data as T;
}
export function post<T>(path: string, payload: unknown) {
  return api<T>(path, { method: "POST", body: JSON.stringify(payload) });
}
export const uid = () => crypto.randomUUID();
export const today = () => new Date().toLocaleDateString("en-CA");
export const monthLabel = (period: string) =>
  new Date(`${period}-01T12:00:00`).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
  });
export const dateLabel = (date?: string) =>
  date
    ? new Date(
        date.length === 10 ? `${date}T12:00:00` : date,
      ).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
      })
    : "—";
export const humanize = (value = "") =>
  value.replaceAll("_", " ").replace(/^./, (c) => c.toUpperCase());
export function money(value: string | number | undefined, currency = "USD") {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number(value || 0));
}
export function total(values: (string | undefined)[]) {
  const minor = values.reduce((sum, value) => {
    const [whole, fraction = ""] = (value || "0").split(".");
    const negative = whole.startsWith("-");
    return (
      sum +
      BigInt(
        `${whole.replace("-", "")}${fraction.padEnd(2, "0").slice(0, 2)}`,
      ) *
        (negative ? -1n : 1n)
    );
  }, 0n);
  return `${minor < 0n ? "-" : ""}${(minor < 0n ? -minor : minor) / 100n}.${String((minor < 0n ? -minor : minor) % 100n).padStart(2, "0")}`;
}
