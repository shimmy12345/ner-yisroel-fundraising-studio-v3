import type { DonorSearchRecord } from "../relationships/donor-search";

export type HealthIssueType = "interaction" | "reminder";
export type HealthRepairAction = "reattach" | "move_to_survivor" | "archive" | "dismiss_false_positive";

export type HealthIssue = {
  recordType: HealthIssueType;
  recordId: string;
  date: string | null;
  title: string;
  currentDonorId: string;
  whyOrphaned: string;
  likelyCause: string;
  suggestedRepair: string;
  survivingDonorId: string | null;
  canDismiss: boolean;
};

export type HealthIssueResponse = {
  checkId: "orphaned-interactions" | "orphaned-reminders";
  issues: HealthIssue[];
  donors: DonorSearchRecord[];
};

export type OrphanRecordRow = {
  id: string;
  donor_id: string;
  event_at: number | null;
  title: string;
  linked_donor_id: string | null;
  donor_owner_user_id: string | null;
  donor_data_source: string | null;
  donor_archived_at: number | null;
  merged_into_donor_id: string | null;
  survivor_id: string | null;
  survivor_owner_user_id: string | null;
  survivor_data_source: string | null;
  survivor_archived_at: number | null;
};

export const HEALTH_REPAIR_DONORS_SQL = `SELECT id,display_name AS name,last_name AS lastName,
  COALESCE(spouse,spouse_first_name) AS spouse,COALESCE(external_id,donor_code) AS code,email,
  COALESCE(phone,alternate_mobile_phone,home_phone) AS phone
  FROM donors WHERE owner_user_id=? AND data_source='live' AND archived_at IS NULL
  ORDER BY COALESCE(NULLIF(last_name,''),display_name) COLLATE NOCASE,display_name COLLATE NOCASE LIMIT 1000`;

const orphanShape = `d.id AS linked_donor_id,d.owner_user_id AS donor_owner_user_id,d.data_source AS donor_data_source,
  d.archived_at AS donor_archived_at,d.merged_into_donor_id,
  survivor.id AS survivor_id,survivor.owner_user_id AS survivor_owner_user_id,
  survivor.data_source AS survivor_data_source,survivor.archived_at AS survivor_archived_at`;

export const ORPHANED_INTERACTION_DETAILS_SQL = `SELECT i.id,i.donor_id,i.occurred_at AS event_at,
  substr(CASE WHEN instr(i.summary,char(10))>0 THEN substr(i.summary,1,instr(i.summary,char(10))-1) ELSE i.summary END,1,240) AS title,${orphanShape}
  FROM interactions i
  LEFT JOIN donors d ON d.id=i.donor_id
  LEFT JOIN donors survivor ON survivor.id=d.merged_into_donor_id
  WHERE i.user_id=? AND i.source NOT LIKE 'archived:%'
    AND (d.id IS NULL OR d.owner_user_id<>? OR d.data_source<>'live' OR d.archived_at IS NOT NULL)
    AND NOT EXISTS (SELECT 1 FROM data_health_repair_audits a
      WHERE a.user_id=i.user_id AND a.record_type='interaction' AND a.record_id=i.id
        AND a.action='dismiss_false_positive' AND COALESCE(a.previous_donor_id,'')=COALESCE(i.donor_id,''))
  ORDER BY i.occurred_at DESC,i.id`;

export const ORPHANED_REMINDER_DETAILS_SQL = `SELECT r.id,r.donor_id,COALESCE(r.due_at,r.created_at) AS event_at,r.action AS title,${orphanShape}
  FROM recommendations r
  LEFT JOIN donors d ON d.id=r.donor_id
  LEFT JOIN donors survivor ON survivor.id=d.merged_into_donor_id
  WHERE r.user_id=? AND r.status<>'dismissed'
    AND (d.id IS NULL OR d.owner_user_id<>? OR d.data_source<>'live' OR d.archived_at IS NOT NULL)
    AND NOT EXISTS (SELECT 1 FROM data_health_repair_audits a
      WHERE a.user_id=r.user_id AND a.record_type='reminder' AND a.record_id=r.id
        AND a.action='dismiss_false_positive' AND COALESCE(a.previous_donor_id,'')=COALESCE(r.donor_id,''))
  ORDER BY COALESCE(r.due_at,r.created_at) DESC,r.id`;

export function explainOrphan(row: OrphanRecordRow, ownerUserId: string) {
  const validSurvivor = Boolean(
    row.survivor_id &&
    row.survivor_owner_user_id === ownerUserId &&
    row.survivor_data_source === "live" &&
    row.survivor_archived_at === null,
  );
  if (!row.linked_donor_id) return {
    whyOrphaned: "The current donor ID no longer resolves to a donor record.",
    likelyCause: "The donor record may have been removed by an older import or repair that did not move linked history.",
    suggestedRepair: "Reattach this record to the correct active donor, or archive it if the history is invalid.",
    survivingDonorId: null,
    canDismiss: false,
  };
  if (row.donor_owner_user_id !== ownerUserId) return {
    whyOrphaned: "The current donor belongs to a different workspace owner.",
    likelyCause: "An older write linked the record without enforcing owner scope.",
    suggestedRepair: "Reattach this record to an active donor in your workspace.",
    survivingDonorId: null,
    canDismiss: false,
  };
  if (row.donor_data_source !== "live") return {
    whyOrphaned: "The current donor is not a live workspace donor.",
    likelyCause: "Sample or verification data remained linked after the workspace switched to live data.",
    suggestedRepair: "Reattach to a live donor, archive the record, or dismiss it after confirming the link is intentionally excluded.",
    survivingDonorId: null,
    canDismiss: true,
  };
  if (row.donor_archived_at !== null && validSurvivor) return {
    whyOrphaned: "The current donor was archived during a merge.",
    likelyCause: "The merge preserved the donor redirect but did not move this linked record.",
    suggestedRepair: "Move this record to the surviving donor. The original record will be updated in place.",
    survivingDonorId: row.survivor_id,
    canDismiss: false,
  };
  return {
    whyOrphaned: "The current donor is archived and has no usable surviving redirect.",
    likelyCause: "The donor may have been archived by an older import or incomplete merge.",
    suggestedRepair: "Reattach to the correct donor, archive the record, or dismiss it after confirming the archived link is intentional.",
    survivingDonorId: null,
    canDismiss: true,
  };
}

export function toHealthIssue(recordType: HealthIssueType, row: OrphanRecordRow, ownerUserId: string): HealthIssue {
  const explanation = explainOrphan(row, ownerUserId);
  const date = row.event_at === null ? null : new Date(row.event_at * 1000);
  return {
    recordType,
    recordId: row.id,
    date: date && Number.isFinite(date.getTime()) ? date.toISOString() : null,
    title: row.title.trim() || (recordType === "interaction" ? "Untitled interaction" : "Untitled reminder"),
    currentDonorId: row.donor_id,
    ...explanation,
  };
}

export function isHealthIssueCheck(value: string | null): value is HealthIssueResponse["checkId"] {
  return value === "orphaned-interactions" || value === "orphaned-reminders";
}

export function isHealthRepairAction(value: unknown): value is HealthRepairAction {
  return value === "reattach" || value === "move_to_survivor" || value === "archive" || value === "dismiss_false_positive";
}
