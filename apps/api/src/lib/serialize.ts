// Response mappers. Every msat leaves the API as a decimal string (JSON has
// no bigint — ADR-008) and every timestamp as ISO 8601 UTC; these helpers are
// the single place where that convention is enforced.

export const msat = (amount: bigint): string => amount.toString();

export const iso = (date: Date): string => date.toISOString();

export const isoOrNull = (date: Date | null): string | null => (date ? date.toISOString() : null);
