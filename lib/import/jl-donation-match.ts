import type { DonationPreview, GivingActivity } from "./jl-donations.ts";

export type MatchedHousehold = { id: string; external_id: string };
export type ExistingGivingActivity = { source_fingerprint: string; paid_cents: number | null; balance_cents: number | null; category: string; source_snapshot: string };
export type ImportableGivingActivity = GivingActivity & { donorId: string };

export function matchJlDonationActivities(preview: DonationPreview, households: MatchedHousehold[], existing: ExistingGivingActivity[]) {
  const householdByCode = new Map(households.map((household) => [household.external_id.toLowerCase(), household.id]));
  const existingByFingerprint = new Map(existing.map((activity) => [activity.source_fingerprint, activity]));
  const matched: ImportableGivingActivity[] = [];
  const unknownActivities: GivingActivity[] = [];
  const reviewActivities: GivingActivity[] = [];
  const nonfinancialActivities: GivingActivity[] = [];
  let unknownHousehold = 0;
  let needsReview = 0;
  let nonfinancial = 0;
  for (const activity of preview.activities) {
    if (activity.category === "needs_review") { needsReview += 1; reviewActivities.push(activity); continue; }
    if (activity.category === "nonfinancial_entry") { nonfinancial += 1; nonfinancialActivities.push(activity); continue; }
    const donorId = householdByCode.get(activity.externalHouseholdId.toLowerCase());
    if (!donorId) { unknownHousehold += 1; unknownActivities.push(activity); continue; }
    matched.push({ ...activity, donorId });
  }
  const newActivities = matched.filter((activity) => !existingByFingerprint.has(activity.fingerprint));
  const proposedUpdates = matched.filter((activity) => {
    const prior = existingByFingerprint.get(activity.fingerprint);
    return prior && (prior.paid_cents !== activity.paidCents || prior.balance_cents !== activity.balanceCents || prior.category !== activity.category);
  });
  const alreadyImported = matched.length - newActivities.length - proposedUpdates.length;
  return { matched, newActivities, proposedUpdates, alreadyImported, unknownHousehold, needsReview, nonfinancial, unknownActivities, reviewActivities, nonfinancialActivities };
}
