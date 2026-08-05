export type LegacyTestRecordType = "interaction" | "reminder";

export type LegacyTestCleanupRecord = {
  recordId: string;
  recordType: LegacyTestRecordType;
  sourceMarker: string;
  reason: string;
};

export type LegacyTestCleanupPreview = {
  candidates: LegacyTestCleanupRecord[];
  blocked: LegacyTestCleanupRecord[];
  counts: { interactions: number; reminders: number };
  previewToken: string;
};

type CandidateInteraction = { id: string; source: string };
type CandidateReminder = { id: string; status: string };
type CleanupDb = { prepare(sql: string): { bind(...values: unknown[]): { all<T>(): Promise<{ results: T[] }> } } };

export const LEGACY_TEST_CLEANUP_CONFIRMATION = "ARCHIVE LEGACY TEST ORPHANS";

export const SAMPLE_INTERACTIONS_SQL = `SELECT i.id,i.source FROM interactions i
  INNER JOIN donors d ON d.id=i.donor_id
  WHERE i.user_id=? AND d.data_source='sample' AND i.source NOT LIKE 'archived:%'
  ORDER BY i.id`;

export const SAMPLE_REMINDERS_SQL = `SELECT r.id,r.status FROM recommendations r
  INNER JOIN donors d ON d.id=r.donor_id
  WHERE r.user_id=? AND d.data_source='sample' AND r.status<>'dismissed'
  ORDER BY r.id`;

export const UNCERTAIN_INTERACTIONS_SQL = `SELECT i.id,i.source FROM interactions i
  LEFT JOIN donors d ON d.id=i.donor_id
  WHERE i.user_id=? AND i.source NOT LIKE 'archived:%'
    AND (d.id IS NULL OR d.data_source<>'sample')
    AND (d.id IS NULL OR d.owner_user_id<>? OR d.data_source<>'live' OR d.archived_at IS NOT NULL)
  ORDER BY i.id`;

export const UNCERTAIN_REMINDERS_SQL = `SELECT r.id,r.status FROM recommendations r
  LEFT JOIN donors d ON d.id=r.donor_id
  WHERE r.user_id=? AND r.status<>'dismissed'
    AND (d.id IS NULL OR d.data_source<>'sample')
    AND (d.id IS NULL OR d.owner_user_id<>? OR d.data_source<>'live' OR d.archived_at IS NOT NULL)
  ORDER BY r.id`;

async function digest(value: string) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function loadLegacyTestCleanupPreview(db: CleanupDb, userId: string): Promise<LegacyTestCleanupPreview> {
  const [interactions, reminders, uncertainInteractions, uncertainReminders] = await Promise.all([
    db.prepare(SAMPLE_INTERACTIONS_SQL).bind(userId).all<CandidateInteraction>(),
    db.prepare(SAMPLE_REMINDERS_SQL).bind(userId).all<CandidateReminder>(),
    db.prepare(UNCERTAIN_INTERACTIONS_SQL).bind(userId, userId).all<CandidateInteraction>(),
    db.prepare(UNCERTAIN_REMINDERS_SQL).bind(userId, userId).all<CandidateReminder>(),
  ]);
  const candidates: LegacyTestCleanupRecord[] = [
    ...interactions.results.map((row) => ({ recordId: row.id, recordType: "interaction" as const, sourceMarker: `interaction.source=${row.source}; donor.data_source=sample`, reason: "Owner-scoped activity linked to a donor explicitly isolated as sample data." })),
    ...reminders.results.map((row) => ({ recordId: row.id, recordType: "reminder" as const, sourceMarker: `recommendation.status=${row.status}; donor.data_source=sample`, reason: "Owner-scoped reminder linked to a donor explicitly isolated as sample data." })),
  ];
  const blocked: LegacyTestCleanupRecord[] = [
    ...uncertainInteractions.results.map((row) => ({ recordId: row.id, recordType: "interaction" as const, sourceMarker: `interaction.source=${row.source}; no sample marker`, reason: "Origin is not proven by deterministic sample metadata. Automated cleanup is blocked." })),
    ...uncertainReminders.results.map((row) => ({ recordId: row.id, recordType: "reminder" as const, sourceMarker: `recommendation.status=${row.status}; no sample marker`, reason: "Origin is not proven by deterministic sample metadata. Automated cleanup is blocked." })),
  ];
  const tokenSource = candidates.map((row) => `${row.recordType}:${row.recordId}:${row.sourceMarker}`).join("\n");
  return {
    candidates,
    blocked,
    counts: {
      interactions: candidates.filter((row) => row.recordType === "interaction").length,
      reminders: candidates.filter((row) => row.recordType === "reminder").length,
    },
    previewToken: await digest(tokenSource),
  };
}
