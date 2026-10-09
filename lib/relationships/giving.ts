export type OwnedGivingActivity = { donorId: string; ownerUserId: string | null; recordOrigin: string };

// Manual Pledge Balance Corrections (see docs/AI-HANDOFF.md) -- the
// LEFT JOIN + COALESCE below is the SQL-level realization of the one
// effective-balance rule (lib/relationships/pledge-balance-correction.ts's
// effectiveBalanceCents is the same rule's canonical, unit-tested
// statement -- never a second, divergent calculation). `balance_cents`
// is aliased to the SAME column name the raw column always had, so
// every existing consumer of this query's rows needs ZERO changes.
// giving_activities.balance_cents itself is never overwritten -- only
// the in-memory row returned to the application substitutes an active
// correction's value, when one exists.
export const DONOR_GIVING_SQL = `SELECT ga.id, ga.donor_id, ga.external_source, ga.activity_date, ga.committed_cents, ga.paid_cents, COALESCE(pbc.corrected_balance_cents, ga.balance_cents) AS balance_cents, ga.item_type, ga.description, ga.source_campaign, ga.category, ga.workspace_status, ga.private_note, ga.confirmed_by_activity_id, ga.updated_at
  FROM giving_activities ga
  LEFT JOIN pledge_balance_corrections pbc ON pbc.pledge_activity_id = ga.id AND pbc.reversed_at IS NULL
  WHERE ga.donor_id = ? AND ga.owner_user_id = ? AND ga.record_origin = 'live'
  ORDER BY ga.activity_date DESC LIMIT 500`;

export function visibleGivingForDonor<T extends OwnedGivingActivity>(rows: T[], donorId: string, ownerUserId: string) {
  return rows.filter((row) => row.donorId === donorId && row.ownerUserId === ownerUserId && row.recordOrigin === "live");
}
