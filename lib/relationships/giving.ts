export type OwnedGivingActivity = { donorId: string; ownerUserId: string | null; recordOrigin: string };

export const DONOR_GIVING_SQL = `SELECT id, activity_date, committed_cents, paid_cents, balance_cents, item_type, description, category
  FROM giving_activities
  WHERE donor_id = ? AND owner_user_id = ? AND record_origin = 'live' AND category NOT IN ('needs_review','nonfinancial_entry')
  ORDER BY activity_date DESC LIMIT 500`;

export function visibleGivingForDonor<T extends OwnedGivingActivity>(rows: T[], donorId: string, ownerUserId: string) {
  return rows.filter((row) => row.donorId === donorId && row.ownerUserId === ownerUserId && row.recordOrigin === "live");
}
