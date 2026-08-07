import type { GivingActivity } from "./jl-donations.ts";
import { stableTransactionId } from "./jl-donations.ts";

// Row shape returned by SELECT ... FROM giving_activities for cross-import
// matching. Deliberately snake_case to mirror the raw D1 result; mapped to
// ExistingDonationRecord (camelCase) via toExistingDonationRecord.
export type RawExistingDonationRow = {
  id: string;
  donor_id: string;
  activity_date: number | null;
  committed_cents: number | null;
  source_campaign: string | null;
  source_snapshot: string;
  created_at: number;
};

export type ExistingDonationRecord = {
  activityId: string;
  donorId: string;
  activityDate: number | null;
  committedCents: number | null;
  sourceCampaign: string;
  sourceSnapshot: string;
  importedAt: number;
};

export function toExistingDonationRecord(row: RawExistingDonationRow): ExistingDonationRecord {
  return {
    activityId: row.id,
    donorId: row.donor_id,
    activityDate: row.activity_date,
    committedCents: row.committed_cents,
    sourceCampaign: row.source_campaign ?? "",
    sourceSnapshot: row.source_snapshot,
    importedAt: row.created_at,
  };
}

export type CrossImportMatchType = "confirmed_duplicate" | "possible_duplicate";

export type CrossImportMatch = {
  fingerprint: string;
  matchType: CrossImportMatchType;
  reason: string;
  existing: ExistingDonationRecord;
};

function parseSnapshot(json: string): Record<string, string> {
  try {
    const parsed = JSON.parse(json) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function toMatch(activity: GivingActivity, existing: ExistingDonationRecord, matchType: CrossImportMatchType, reason: string): CrossImportMatch {
  return { fingerprint: activity.fingerprint, matchType, reason, existing };
}

// A stable transaction/payment/reference/receipt/check identifier already
// present on a previously imported record proves this row is the exact
// same source transaction even if some other column (description,
// formatting) has since changed and would otherwise produce a different
// content fingerprint and be imported as a second, duplicate gift.
export function findStableIdCrossImportMatches(activities: GivingActivity[], existing: ExistingDonationRecord[]): CrossImportMatch[] {
  const existingByStableId = new Map<string, ExistingDonationRecord>();
  for (const record of existing) {
    const id = stableTransactionId(parseSnapshot(record.sourceSnapshot));
    if (id) existingByStableId.set(id.trim().toLowerCase(), record);
  }
  const matches: CrossImportMatch[] = [];
  for (const activity of activities) {
    const id = stableTransactionId(activity.sourceValues);
    if (!id) continue;
    const record = existingByStableId.get(id.trim().toLowerCase());
    if (!record) continue;
    matches.push(toMatch(activity, record, "confirmed_duplicate", `Transaction ID "${id}" already exists in Fundraising OS from a prior import.`));
  }
  return matches;
}

// Amount is never sole evidence here either -- this reuses the same
// conservative content fingerprint (donor, date, campaign, item, amount,
// company) already computed for in-file duplicate detection, now compared
// against previously imported gifts instead of other rows in this file.
// Rows already confirmed by a stable transaction ID are excluded so a row
// is never shown as both a confirmed and a possible duplicate.
export function findFingerprintCrossImportMatches(activities: GivingActivity[], existingByFingerprint: Map<string, ExistingDonationRecord>, confirmedFingerprints: Set<string>): CrossImportMatch[] {
  const matches: CrossImportMatch[] = [];
  for (const activity of activities) {
    if (confirmedFingerprints.has(activity.fingerprint)) continue;
    const record = existingByFingerprint.get(activity.fingerprint);
    if (!record) continue;
    matches.push(toMatch(activity, record, "possible_duplicate", "A gift with the same donor, date, campaign, and amount already exists in Fundraising OS."));
  }
  return matches;
}

export type CrossImportDecisionAction = "import_anyway" | "skip" | "review_later";
export type CrossImportDecision = { fingerprint: string; action: CrossImportDecisionAction };

export type CrossImportOutcome = {
  fingerprint: string;
  matchType: CrossImportMatchType;
  action: "imported" | "skipped";
  existing: ExistingDonationRecord;
  auditPreviousJson: string | null;
};

export type CrossImportResolution<T extends GivingActivity = GivingActivity> = {
  // Confirmed (stable-ID) duplicates that must be removed from the
  // insertable set unless explicitly approved. The safe default for a
  // confirmed duplicate is to skip it.
  excludeFingerprints: string[];
  // Possible (content-fingerprint) duplicates explicitly approved via
  // "Import anyway" -- additions, since a possible duplicate is already
  // excluded from insertion by default. Each carries a new, override
  // fingerprint so the insert creates a genuinely separate row instead of
  // colliding with the existing one on the unique fingerprint index.
  approvedAdditions: Array<{ activity: T; auditPreviousJson: string }>;
  // Every match, decided or not, with what actually happened -- for the
  // review report and, where a write occurred, the change-log audit entry.
  outcomes: CrossImportOutcome[];
};

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function resolveCrossImportDecisions<T extends GivingActivity>(activityByFingerprint: Map<string, T>, matches: CrossImportMatch[], decisions: CrossImportDecision[], importId: string): Promise<CrossImportResolution<T>> {
  const decisionByFingerprint = new Map(decisions.map((decision) => [decision.fingerprint, decision]));
  const excludeFingerprints: string[] = [];
  const approvedAdditions: CrossImportResolution<T>["approvedAdditions"] = [];
  const outcomes: CrossImportOutcome[] = [];
  for (const match of matches) {
    const approved = decisionByFingerprint.get(match.fingerprint)?.action === "import_anyway";
    if (match.matchType === "confirmed_duplicate") {
      if (!approved) { excludeFingerprints.push(match.fingerprint); outcomes.push({ fingerprint: match.fingerprint, matchType: match.matchType, action: "skipped", existing: match.existing, auditPreviousJson: null }); continue; }
      const auditPreviousJson = JSON.stringify({ crossImportOverride: true, matchType: match.matchType, existingActivityId: match.existing.activityId });
      outcomes.push({ fingerprint: match.fingerprint, matchType: match.matchType, action: "imported", existing: match.existing, auditPreviousJson });
      continue;
    }
    if (!approved) { outcomes.push({ fingerprint: match.fingerprint, matchType: match.matchType, action: "skipped", existing: match.existing, auditPreviousJson: null }); continue; }
    const activity = activityByFingerprint.get(match.fingerprint);
    if (!activity) { outcomes.push({ fingerprint: match.fingerprint, matchType: match.matchType, action: "skipped", existing: match.existing, auditPreviousJson: null }); continue; }
    const overrideFingerprint = await sha256(`${match.fingerprint}cross-import-override:${importId}`);
    const auditPreviousJson = JSON.stringify({ crossImportOverride: true, matchType: match.matchType, existingActivityId: match.existing.activityId });
    approvedAdditions.push({ activity: { ...activity, fingerprint: overrideFingerprint }, auditPreviousJson });
    outcomes.push({ fingerprint: match.fingerprint, matchType: match.matchType, action: "imported", existing: match.existing, auditPreviousJson });
  }
  return { excludeFingerprints, approvedAdditions, outcomes };
}
