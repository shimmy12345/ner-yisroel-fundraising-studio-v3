import type { ImportRow } from "./recognition.ts";
import { parseFinancialDate } from "../financial-date.ts";

export const JL_DONATION_COLUMNS = ["Code", "Name", "Total Due", "Item Num", "Desc", "Campaign", "Due Date", "Amount", "Paid", "Balance Due", "Company"] as const;
export const JL_COMPACT_DONATION_COLUMNS = ["Code", "First Name", "Last Name", "Date", "Campaign", "Amount"] as const;

export type GivingCategory = "completed_gift" | "open_pledge" | "partially_paid_pledge" | "event_or_ad" | "nonfinancial_entry" | "needs_review";
export type GivingActivity = {
  rowNumber: number;
  fingerprint: string;
  externalHouseholdId: string;
  sourceName: string;
  activityDate: number | null;
  committedCents: number | null;
  paidCents: number | null;
  balanceCents: number | null;
  itemType: string;
  description: string;
  sourceCampaign: string;
  category: GivingCategory;
  suspiciousDate: boolean;
  reviewReason: string | null;
  sourceValues: Record<string, string>;
};

export type DonationPreview = {
  activities: GivingActivity[];
  duplicateRows: Array<{ row: number; fingerprint: string }>;
  counts: Record<GivingCategory, number> & { total: number; zeroDollar: number; suspiciousDates: number };
};

export type DonationClassificationOptions = { compactPaymentStatus?: "fully_paid" };

export function isJlDonationExport(columns: string[]) {
  const found = new Set(columns.map((column) => column.trim().toLowerCase()));
  const fullExport = JL_DONATION_COLUMNS.every((column) => found.has(column.toLowerCase()));
  const compactExport = isCompactJlDonationExport(columns);
  return fullExport || compactExport;
}

export function isCompactJlDonationExport(columns: string[]) {
  const found = new Set(columns.map((column) => column.trim().toLowerCase()));
  return JL_COMPACT_DONATION_COLUMNS.every((column) => found.has(column.toLowerCase()));
}

function isExplicitJlPayment(activity: GivingActivity) {
  // Full JL exports distinguish payment transactions with Item Num/Desc. Do not
  // infer this from Campaign: campaigns describe purpose, not transaction type.
  return /\b(?:payment|pmt|pymt|installment)\b/i.test(`${activity.itemType} ${activity.description}`)
    && (activity.paidCents ?? 0) > 0;
}

export function paymentActivitiesForAssignment(activities: GivingActivity[], columns: string[]) {
  if (isCompactJlDonationExport(columns)) return activities;
  return activities.filter(isExplicitJlPayment).map((activity) => ({
    ...activity,
    // A full-export payment can carry pledge context in Amount/Balance Due. The
    // actual payment applied is the Paid value, never the contextual total.
    committedCents: activity.paidCents,
  }));
}

function currency(value: string) {
  if (!value.trim()) return 0;
  const normalized = value.replace(/[$,\s]/g, "").replace(/^\((.+)\)$/, "-$1");
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? Math.round(parsed * 100) : null;
}

function activityDate(value: string) {
  return parseFinancialDate(value);
}

function eventOrAd(item: string, description: string) {
  return /reservation|dinner|\bad\b|full\s*page|half\s*page|quarter\s*page|sponsor|journal|banquet|table/i.test(`${item} ${description}`);
}

function complimentary(item: string, description: string) {
  return /included|complimentary|no\s*charge|free\b/i.test(`${item} ${description}`);
}

export function classifyJlDonation(row: ImportRow, now = new Date(), options: DonationClassificationOptions = {}): Omit<GivingActivity, "rowNumber" | "fingerprint" | "sourceValues"> {
  const code = row.Code?.trim() ?? "";
  const committedCents = currency(row.Amount ?? "");
  const hasPaymentStatus = Object.hasOwn(row, "Paid") && Object.hasOwn(row, "Balance Due");
  const paidCents = hasPaymentStatus ? currency(row.Paid ?? "") : options.compactPaymentStatus === "fully_paid" ? committedCents : 0;
  const balanceCents = hasPaymentStatus ? currency(row["Balance Due"] ?? "") : 0;
  const date = activityDate(row["Due Date"] ?? row.Date ?? "");
  const itemType = row["Item Num"]?.trim() ?? "";
  const description = row.Desc?.trim() ?? "";
  const sourceName = row.Name?.trim() || [row["First Name"], row["Last Name"]].filter(Boolean).join(" ").trim();
  const earliest = Date.UTC(1980, 0, 1) / 1000;
  const latest = Date.UTC(now.getUTCFullYear() + 1, now.getUTCMonth(), now.getUTCDate()) / 1000;
  const suspiciousDate = date !== null && (date < earliest || date > latest);
  let category: GivingCategory;
  let reviewReason: string | null = null;
  if (!code) { category = "needs_review"; reviewReason = "Missing JL Code"; }
  else if (date === null) { category = "needs_review"; reviewReason = "Missing or invalid activity date"; }
  else if (suspiciousDate) { category = "needs_review"; reviewReason = "Suspicious historical or future date"; }
  else if (!hasPaymentStatus && options.compactPaymentStatus !== "fully_paid") { category = "needs_review"; reviewReason = "Payment status cannot be determined because Paid and Balance Due columns are missing"; }
  else if (committedCents === null || paidCents === null || balanceCents === null || committedCents < 0 || paidCents < 0 || balanceCents < 0) { category = "needs_review"; reviewReason = "Malformed or negative amount"; }
  else if (Math.abs(committedCents - paidCents - balanceCents) > 1) { category = "needs_review"; reviewReason = "Amount does not equal paid plus balance"; }
  else if (complimentary(itemType, description) || (committedCents === 0 && paidCents === 0 && balanceCents === 0)) category = "nonfinancial_entry";
  else if (eventOrAd(itemType, description)) category = "event_or_ad";
  else if (paidCents > 0 && balanceCents > 0) category = "partially_paid_pledge";
  else if (committedCents > 0 && paidCents === 0 && balanceCents === committedCents) category = "open_pledge";
  else if (committedCents > 0 && paidCents === committedCents && balanceCents === 0) category = "completed_gift";
  else { category = "needs_review"; reviewReason = "Amounts are ambiguous"; }
  return { externalHouseholdId: code, sourceName, activityDate: date, committedCents, paidCents, balanceCents, itemType, description, sourceCampaign: row.Campaign?.trim() ?? "", category, suspiciousDate, reviewReason };
}

function canonicalFingerprint(row: ImportRow) {
  const compactPaymentMarker = Object.hasOwn(row, "Date") && !Object.hasOwn(row, "Due Date") ? ["compact-payment"] : [];
  return [...compactPaymentMarker, row.Code, row["Due Date"] ?? row.Date, row["Item Num"], row.Desc, row.Campaign, row.Amount, row.Company]
    .map((value) => (value ?? "").trim().replace(/\s+/g, " ").toLowerCase()).join("\u001f");
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function buildJlDonationPreview(rows: ImportRow[], now = new Date(), options: DonationClassificationOptions = {}): Promise<DonationPreview> {
  const activities: GivingActivity[] = [];
  const duplicateRows: DonationPreview["duplicateRows"] = [];
  const seen = new Set<string>();
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const fingerprint = await sha256(canonicalFingerprint(row));
    if (seen.has(fingerprint)) { duplicateRows.push({ row: index + 2, fingerprint }); continue; }
    seen.add(fingerprint);
    activities.push({ rowNumber: index + 2, fingerprint, ...classifyJlDonation(row, now, options), sourceValues: Object.fromEntries(Object.entries(row).map(([column, value]) => [column, value.trim()])) });
  }
  const categories = { completed_gift: 0, open_pledge: 0, partially_paid_pledge: 0, event_or_ad: 0, nonfinancial_entry: 0, needs_review: 0 };
  activities.forEach((activity) => { categories[activity.category] += 1; });
  return { activities, duplicateRows, counts: { ...categories, total: rows.length, zeroDollar: activities.filter((activity) => activity.committedCents === 0 && activity.paidCents === 0 && activity.balanceCents === 0).length, suspiciousDates: activities.filter((activity) => activity.suspiciousDate).length } };
}

export type GivingSnapshot = { lifetimePaidCents: number; last12MonthsCents: number; mostRecent?: GivingActivity; largest?: GivingActivity; typicalPaidCents: number; yearsOfGiving: number; trend: "up" | "down" | "steady" | "new"; outstandingCents: number; mostRecentOpen?: GivingActivity; yearlyPaid: Array<{ year: number; paidCents: number }>; commonDescriptions: string[] };

export function calculateGivingSnapshot(activities: GivingActivity[], now = new Date()): GivingSnapshot {
  const financial = activities.filter((activity) => !["nonfinancial_entry", "needs_review"].includes(activity.category));
  const paid = financial.filter((activity) => (activity.paidCents ?? 0) > 0 && activity.activityDate !== null);
  const cutoff = Math.floor(new Date(now.getFullYear() - 1, now.getMonth(), now.getDate()).getTime() / 1000);
  const priorCutoff = Math.floor(new Date(now.getFullYear() - 2, now.getMonth(), now.getDate()).getTime() / 1000);
  const last12 = paid.filter((activity) => activity.activityDate! >= cutoff).reduce((sum, activity) => sum + activity.paidCents!, 0);
  const prior12 = paid.filter((activity) => activity.activityDate! >= priorCutoff && activity.activityDate! < cutoff).reduce((sum, activity) => sum + activity.paidCents!, 0);
  const sortedAmounts = paid.map((activity) => activity.paidCents!).sort((a, b) => a - b);
  const middle = Math.floor(sortedAmounts.length / 2);
  const typical = sortedAmounts.length ? (sortedAmounts.length % 2 ? sortedAmounts[middle] : Math.round((sortedAmounts[middle - 1] + sortedAmounts[middle]) / 2)) : 0;
  const years = new Map<number, number>();
  paid.forEach((activity) => { const year = new Date(activity.activityDate! * 1000).getUTCFullYear(); years.set(year, (years.get(year) ?? 0) + activity.paidCents!); });
  const descriptions = new Map<string, number>();
  financial.forEach((activity) => { if (activity.description) descriptions.set(activity.description, (descriptions.get(activity.description) ?? 0) + 1); });
  const open = financial.filter((activity) => (activity.balanceCents ?? 0) > 0).sort((a, b) => (b.activityDate ?? 0) - (a.activityDate ?? 0));
  return { lifetimePaidCents: paid.reduce((sum, activity) => sum + activity.paidCents!, 0), last12MonthsCents: last12, mostRecent: [...paid].sort((a, b) => b.activityDate! - a.activityDate!)[0], largest: [...paid].sort((a, b) => b.paidCents! - a.paidCents!)[0], typicalPaidCents: typical, yearsOfGiving: years.size, trend: prior12 === 0 ? (last12 > 0 ? "new" : "steady") : last12 > prior12 * 1.1 ? "up" : last12 < prior12 * .9 ? "down" : "steady", outstandingCents: open.reduce((sum, activity) => sum + activity.balanceCents!, 0), mostRecentOpen: open[0], yearlyPaid: [...years.entries()].sort((a, b) => b[0] - a[0]).map(([year, paidCents]) => ({ year, paidCents })), commonDescriptions: [...descriptions.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([description]) => description) };
}
