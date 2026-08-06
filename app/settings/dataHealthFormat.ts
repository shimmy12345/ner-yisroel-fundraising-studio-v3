export function formatTimestamp(value: string, useLocalTime: boolean) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  if (useLocalTime) return date.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
  return `${date.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" })} UTC`;
}
