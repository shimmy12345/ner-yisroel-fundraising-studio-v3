import type { ImportRow } from "./recognition.ts";
import { parseFinancialDate } from "../financial-date.ts";

export const JL_DONATION_COLUMNS = ["Code", "Name", "Total Due", "Item Num", "Desc", "Campaign", "Due Date", "Amount", "Paid", "Balance Due", "Company"] as const;
export const JL_COMPACT_DONATION_COLUMNS = ["Code", "First Name", "Last Name", "Date", "Campaign", "Amount"] as const;

export type GivingCategory = "completed_gift" | "open_pledge" | "partially_paid_pledge" | "event_or_ad" | "nonfinancial_entry" | "needs_review";
// Recognized headers for a stable per-transaction identifier. JL Solutions
// exports do not always include one; when present it proves two
// identical-looking rows are genuinely different transactions (or the exact
// same one). This list is a best-effort set of plausible header names and
// should be extended once real JL Solutions export headers are confirmed.
const STABLE_ID_COLUMNS = ["Transaction ID", "Payment ID", "Txn ID", "Reference", "Receipt Number", "Confirmation Number", "Check Number"] as const;
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
  // The category this row would have without the possible-duplicate
  // override, so an explicit "import anyway" decision can restore it
  // without recomputing classification from scratch.
  underlyingCategory: GivingCategory;
  suspiciousDate: boolean;
  reviewReason: string | null;
  sourceValues: Record<string, string>;
  // Set only when this row shares donor/date/campaign/amount content with
  // another row in the same file and neither has a stable transaction ID to
  // prove they are different transactions. Never set from amount alone.
  duplicateStatus: "possible_duplicate" | null;
  duplicateGroupKey: string | null;
  duplicateGroupSize: number;
};

export function stableTransactionId(row: ImportRow): string | null {
  for (const column of STABLE_ID_COLUMNS) {
    const value = row[column]?.trim();
    if (value) return value;
  }
  return null;
}

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

export function classifyJlDonation(row: ImportRow, now = new Date(), options: DonationClassificationOptions = {}): Omit<GivingActivity, "rowNumber" | "fingerprint" | "sourceValues" | "underlyingCategory" | "duplicateStatus" | "duplicateGroupKey" | "duplicateGroupSize"> {
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

// Amount is never the sole evidence of duplication — canonicalFingerprint
// already combines donor, date, item, description, campaign, amount, and
// company. This groups rows sharing that combined signature so repeated
// legitimate transactions (same donor/date/campaign/amount, no stable ID to
// prove otherwise) can be flagged for a human decision instead of silently
// discarded.
export async function buildJlDonationPreview(rows: ImportRow[], now = new Date(), options: DonationClassificationOptions = {}): Promise<DonationPreview> {
  const prepared = await Promise.all(rows.map(async (row, index) => ({
    row,
    rowNumber: index + 2,
    stableId: stableTransactionId(row),
    groupFingerprint: await sha256(canonicalFingerprint(row)),
    classified: classifyJlDonation(row, now, options),
    sourceValues: Object.fromEntries(Object.entries(row).map(([column, value]) => [column, value.trim()])),
  })));

  const activities: GivingActivity[] = [];
  const duplicateRows: DonationPreview["duplicateRows"] = [];

  // Stable-ID duplicates: a repeated ID is proof of the same transaction,
  // so this preserves the original hard-rejection behavior exactly.
  const seenStableIds = new Set<string>();
  const withoutStableId: typeof prepared = [];
  for (const item of prepared) {
    if (item.stableId === null) { withoutStableId.push(item); continue; }
    const idKey = item.stableId.trim().toLowerCase();
    if (seenStableIds.has(idKey)) { duplicateRows.push({ row: item.rowNumber, fingerprint: item.groupFingerprint }); continue; }
    seenStableIds.add(idKey);
    activities.push({ rowNumber: item.rowNumber, fingerprint: item.groupFingerprint, ...item.classified, underlyingCategory: item.classified.category, duplicateStatus: null, duplicateGroupKey: null, duplicateGroupSize: 1, sourceValues: item.sourceValues });
  }

  // No stable ID: group by content signature. A group of one is a normal,
  // unambiguous row; a group of two or more cannot be proven duplicate or
  // distinct from this export alone, so every member becomes reviewable
  // rather than being collapsed into a single kept row.
  const groups = new Map<string, typeof withoutStableId>();
  for (const item of withoutStableId) {
    const group = groups.get(item.groupFingerprint) ?? [];
    group.push(item);
    groups.set(item.groupFingerprint, group);
  }
  for (const [groupFingerprint, members] of groups) {
    for (let occurrence = 0; occurrence < members.length; occurrence += 1) {
      const item = members[occurrence];
      // Every activity gets a unique fingerprint whenever it shares a group
      // with another row — needed so fingerprint-keyed lookups downstream
      // never collapse two distinct rows, independent of whether this
      // specific row is flagged as a possible duplicate below.
      const fingerprint = members.length > 1 ? await sha256(`${groupFingerprint}occurrence:${occurrence}`) : groupFingerprint;
      // Only treat repetition as the reportable issue when the row would
      // otherwise import cleanly. A row that already needs review for a
      // structural reason (missing code, invalid date, ...) keeps that
      // reason — duplication is not its primary problem, and rows missing
      // key fields can coincidentally share a fingerprint of empty values.
      const isPossibleDuplicate = members.length > 1 && item.classified.category !== "needs_review";
      activities.push({
        rowNumber: item.rowNumber,
        fingerprint,
        ...item.classified,
        category: isPossibleDuplicate ? "needs_review" : item.classified.category,
        underlyingCategory: item.classified.category,
        reviewReason: isPossibleDuplicate ? `Possible duplicate: identical donor, date, campaign, and amount appears ${members.length} times with no transaction ID to confirm these are separate gifts` : item.classified.reviewReason,
        duplicateStatus: isPossibleDuplicate ? "possible_duplicate" : null,
        duplicateGroupKey: isPossibleDuplicate ? groupFingerprint : null,
        duplicateGroupSize: isPossibleDuplicate ? members.length : 1,
        sourceValues: item.sourceValues,
      });
    }
  }
  activities.sort((a, b) => a.rowNumber - b.rowNumber);

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
