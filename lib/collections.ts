// Splits `items` into consecutive groups of at most `size`, preserving
// order and never dropping or duplicating an item. Used wherever a single
// D1 query's bound-parameter count must stay under a hard limit (see
// app/api/interactions/shared/route.ts's donor-ownership lookup --
// docs/AI-HANDOFF.md, "too many SQL variables" incident).
export function chunk<T>(items: T[], size: number): T[][] {
  if (size < 1) throw new Error("chunk size must be at least 1");
  const groups: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    groups.push(items.slice(index, index + size));
  }
  return groups;
}
