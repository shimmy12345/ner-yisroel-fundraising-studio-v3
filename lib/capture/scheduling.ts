export function toLocalDateTimeValue(date: Date) {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function parseScheduledDate(value: string) {
  const parsed = new Date(value);
  return value && Number.isFinite(parsed.getTime()) ? parsed : null;
}

export function isFutureScheduledDate(value: string, now = new Date()) {
  const parsed = parseScheduledDate(value);
  return parsed ? parsed.getTime() > now.getTime() : false;
}

export function schedulingLabel(value: string, now = new Date()) {
  const parsed = parseScheduledDate(value);
  if (!parsed) return "Choose a date and time";
  if (Math.abs(parsed.getTime() - now.getTime()) < 90_000) return "Now";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(parsed);
}
