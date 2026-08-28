// Shared percentile-rank helper -- used by every Portfolio Focus
// component that needs "how large is this relative to the rest of the
// portfolio." Pure, no D1. Fraction of values <= the given value.
export function percentileRank(values: readonly number[], value: number | null): number {
  if (value == null) return 0;
  if (values.length === 0) return 0;
  let count = 0;
  for (const v of values) if (v <= value) count++;
  return count / values.length;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
