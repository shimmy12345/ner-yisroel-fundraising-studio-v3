import { sql } from "drizzle-orm";
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

const timestamps = {
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
};

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  name: text("name"),
  preferredFirstName: text("preferred_first_name"),
  organizationName: text("organization_name"),
  jobTitle: text("job_title"),
  timezone: text("timezone").notNull().default("America/New_York"),
  avatarUrl: text("avatar_url"),
  householdImportReviewMode: text("household_import_review_mode", { enum: ["review_every", "changes_only", "auto_unchanged"] }).notNull().default("auto_unchanged"),
  ...timestamps,
});

export const donors = sqliteTable("donors", {
  id: text("id").primaryKey(),
  ownerUserId: text("owner_user_id").references(() => users.id),
  dataSource: text("data_source", { enum: ["live", "sample"] }).notNull().default("live"),
  displayName: text("display_name").notNull(),
  email: text("email"),
  phone: text("phone"),
  location: text("location"),
  relationshipSummary: text("relationship_summary"),
  institutionalMemory: text("institutional_memory"),
  relationshipHealth: integer("relationship_health"),
  preferredCommunication: text("preferred_communication"),
  interests: text("interests", { mode: "json" }).$type<string[]>(),
  family: text("family", { mode: "json" }).$type<Record<string, string>>(),
  donorCode: text("donor_code"),
  spouse: text("spouse"),
  address: text("address"),
  externalSource: text("external_source"),
  externalId: text("external_id"),
  lastName: text("last_name"),
  primaryFirstName: text("primary_first_name"),
  spouseFirstName: text("spouse_first_name"),
  primaryTitle: text("primary_title"),
  spouseTitle: text("spouse_title"),
  alternateMobilePhone: text("alternate_mobile_phone"),
  homePhone: text("home_phone"),
  addressLine1: text("address_line_1"),
  city: text("city"),
  state: text("state"),
  postalCode: text("postal_code"),
  country: text("country"),
  sourceSnapshot: text("source_snapshot", { mode: "json" }).$type<Record<string, string>>(),
  contactNote: text("contact_note"),
  archivedAt: integer("archived_at", { mode: "timestamp" }),
  mergedIntoDonorId: text("merged_into_donor_id"),
  ...timestamps,
});

export const donorViews = sqliteTable("donor_views", {
  userId: text("user_id").notNull().references(() => users.id),
  donorId: text("donor_id").notNull().references(() => donors.id),
  viewedAt: integer("viewed_at", { mode: "timestamp" }).notNull(),
}, (table) => [
  primaryKey({ columns: [table.userId, table.donorId] }),
  index("donor_views_user_date_idx").on(table.userId, table.viewedAt),
]);

export const relationshipQueueDismissals = sqliteTable("relationship_queue_dismissals", {
  userId: text("user_id").notNull().references(() => users.id),
  itemKey: text("item_key").notNull(),
  donorId: text("donor_id").notNull().references(() => donors.id),
  dismissedAt: integer("dismissed_at", { mode: "timestamp" }).notNull(),
}, (table) => [
  primaryKey({ columns: [table.userId, table.itemKey] }),
  index("relationship_queue_dismissals_user_date_idx").on(table.userId, table.dismissedAt),
]);

export const donorMergeAudits = sqliteTable("donor_merge_audits", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id),
  survivingDonorId: text("surviving_donor_id").notNull().references(() => donors.id),
  archivedDonorId: text("archived_donor_id").notNull().references(() => donors.id),
  fieldChoicesJson: text("field_choices_json", { mode: "json" }).$type<Record<string, string>>().notNull(),
  survivorBeforeJson: text("survivor_before_json", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
  duplicateBeforeJson: text("duplicate_before_json", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
  survivorAfterJson: text("survivor_after_json", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
  movedCountsJson: text("moved_counts_json", { mode: "json" }).$type<Record<string, number>>().notNull(),
  source: text("source").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
}, (table) => [
  index("donor_merge_audits_user_date_idx").on(table.userId, table.createdAt),
  index("donor_merge_audits_archived_idx").on(table.archivedDonorId),
]);

export const donorContactAudits = sqliteTable("donor_contact_audits", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id),
  donorId: text("donor_id").notNull().references(() => donors.id),
  action: text("action", { enum: ["created", "updated", "merged_with_jl"] }).notNull(),
  changedFields: text("changed_fields", { mode: "json" }).$type<string[]>().notNull(),
  beforeJson: text("before_json", { mode: "json" }).$type<Record<string, string> | null>(),
  afterJson: text("after_json", { mode: "json" }).$type<Record<string, string>>().notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
}, (table) => [index("donor_contact_audits_donor_date_idx").on(table.donorId, table.createdAt)]);

export const interactions = sqliteTable("interactions", {
  id: text("id").primaryKey(),
  donorId: text("donor_id").notNull().references(() => donors.id),
  userId: text("user_id").notNull().references(() => users.id),
  type: text("type", { enum: ["call", "email", "meeting", "visit", "note", "personal", "gift"] }).notNull(),
  occurredAt: integer("occurred_at", { mode: "timestamp" }).notNull(),
  // True only for Monday.com-imported rows, where the source supplied a
  // calendar date and nothing else -- occurredAt is anchored at UTC noon,
  // not a real captured time. Every other interaction keeps a genuine
  // wall-clock moment and this stays false.
  occurredAtDateOnly: integer("occurred_at_date_only", { mode: "boolean" }).notNull().default(false),
  summary: text("summary").notNull(),
  source: text("source").notNull().default("manual"),
  ...timestamps,
}, (table) => [index("interactions_donor_date_idx").on(table.donorId, table.occurredAt)]);

export const activityStatusAudits = sqliteTable("activity_status_audits", {
  id: text("id").primaryKey(),
  interactionId: text("interaction_id").notNull().references(() => interactions.id),
  userId: text("user_id").notNull().references(() => users.id),
  action: text("action").notNull(),
  fromStatus: text("from_status").notNull(),
  toStatus: text("to_status").notNull(),
  previousSource: text("previous_source").notNull(),
  nextSource: text("next_source").notNull(),
  previousOccurredAt: integer("previous_occurred_at").notNull(),
  nextOccurredAt: integer("next_occurred_at").notNull(),
  previousSummary: text("previous_summary").notNull(),
  nextSummary: text("next_summary").notNull(),
  followUpId: text("follow_up_id"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  undoneAt: integer("undone_at", { mode: "timestamp" }),
}, (table) => [index("activity_status_audits_interaction_date_idx").on(table.interactionId, table.createdAt)]);

export const dataHealthRepairAudits = sqliteTable("data_health_repair_audits", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id),
  recordType: text("record_type", { enum: ["interaction", "reminder"] }).notNull(),
  recordId: text("record_id").notNull(),
  action: text("action", { enum: ["reattach", "move_to_survivor", "archive", "dismiss_false_positive"] }).notNull(),
  previousDonorId: text("previous_donor_id"),
  nextDonorId: text("next_donor_id"),
  previousStateJson: text("previous_state_json", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
  nextStateJson: text("next_state_json", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
  reason: text("reason").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
}, (table) => [
  index("idx_data_health_repairs_user_record").on(table.userId, table.recordType, table.recordId, table.createdAt),
  index("idx_data_health_repairs_user_date").on(table.userId, table.createdAt),
]);

export const legacyTestCleanupAudits = sqliteTable("legacy_test_cleanup_audits", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id),
  previewHash: text("preview_hash").notNull(),
  recordsJson: text("records_json", { mode: "json" }).$type<Array<Record<string, string>>>().notNull(),
  archivedInteractions: integer("archived_interactions").notNull(),
  archivedReminders: integer("archived_reminders").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
}, (table) => [index("idx_legacy_test_cleanup_user_date").on(table.userId, table.createdAt)]);

export const gifts = sqliteTable("gifts", {
  id: text("id").primaryKey(),
  donorId: text("donor_id").notNull().references(() => donors.id),
  amountCents: integer("amount_cents").notNull(),
  fund: text("fund").notNull(),
  receivedAt: integer("received_at", { mode: "timestamp" }).notNull(),
  acknowledgedAt: integer("acknowledged_at", { mode: "timestamp" }),
  ...timestamps,
}, (table) => [index("gifts_donor_date_idx").on(table.donorId, table.receivedAt)]);

export const givingActivities = sqliteTable("giving_activities", {
  id: text("id").primaryKey(),
  donorId: text("donor_id").notNull().references(() => donors.id),
  ownerUserId: text("owner_user_id").references(() => users.id),
  externalSource: text("external_source").notNull(),
  externalHouseholdId: text("external_household_id").notNull(),
  sourceFingerprint: text("source_fingerprint").notNull(),
  activityDate: integer("activity_date", { mode: "timestamp" }),
  committedCents: integer("committed_cents"),
  paidCents: integer("paid_cents"),
  balanceCents: integer("balance_cents"),
  itemType: text("item_type"),
  description: text("description"),
  sourceCampaign: text("source_campaign"),
  recordOrigin: text("record_origin", { enum: ["live", "verification", "sample"] }).notNull().default("live"),
  category: text("category").notNull(),
  workspaceStatus: text("workspace_status", { enum: ["active", "hidden", "duplicate", "needs_review", "invalid", "merged"] }).notNull().default("active"),
  privateNote: text("private_note"),
  confirmedByActivityId: text("confirmed_by_activity_id"),
  sourceSnapshot: text("source_snapshot", { mode: "json" }).$type<Record<string, string>>().notNull(),
  ...timestamps,
}, (table) => [index("giving_activities_donor_date_idx").on(table.donorId, table.activityDate)]);

export const givingActivityManagementAudits = sqliteTable("giving_activity_management_audits", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id),
  activityId: text("activity_id").notNull(),
  importId: text("import_id"),
  action: text("action").notNull(),
  previousDonorId: text("previous_donor_id"),
  nextDonorId: text("next_donor_id"),
  previousStatus: text("previous_status"),
  nextStatus: text("next_status"),
  previousNote: text("previous_note"),
  nextNote: text("next_note"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  undoneAt: integer("undone_at", { mode: "timestamp" }),
}, (table) => [
  index("idx_giving_management_audit_activity_date").on(table.activityId, table.createdAt),
  index("idx_giving_management_audit_import").on(table.importId, table.createdAt),
]);

export const sampleCleanupAudits = sqliteTable("sample_cleanup_audits", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id),
  backupConfirmed: integer("backup_confirmed", { mode: "boolean" }).notNull(),
  removedDonors: integer("removed_donors").notNull(),
  removedGifts: integer("removed_gifts").notNull(),
  removedInteractions: integer("removed_interactions").notNull(),
  removedRecommendations: integer("removed_recommendations").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});

export const jlRefreshState = sqliteTable("jl_refresh_state", {
  userId: text("user_id").primaryKey().notNull().references(() => users.id),
  lastHouseholdRefreshAt: integer("last_household_refresh_at", { mode: "timestamp" }),
  lastDonationRefreshAt: integer("last_donation_refresh_at", { mode: "timestamp" }),
  lastDonationRangeStart: integer("last_donation_range_start", { mode: "timestamp" }),
  lastDonationRangeEnd: integer("last_donation_range_end", { mode: "timestamp" }),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});

export const jlPaymentAssignments = sqliteTable("jl_payment_assignments", {
  userId: text("user_id").notNull().references(() => users.id),
  paymentFingerprint: text("payment_fingerprint").notNull(),
  decisionType: text("decision_type", { enum: ["apply_to_pledge", "new_gift"] }).notNull(),
  pledgeActivityId: text("pledge_activity_id").references(() => givingActivities.id),
  appliedImportId: text("applied_import_id").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
}, (table) => [
  primaryKey({ columns: [table.userId, table.paymentFingerprint] }),
  index("jl_payment_assignments_pledge_idx").on(table.pledgeActivityId),
]);

export const jlPaymentAssignmentAudits = sqliteTable("jl_payment_assignment_audits", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id),
  importId: text("import_id").notNull(),
  paymentFingerprint: text("payment_fingerprint").notNull(),
  donorId: text("donor_id").notNull().references(() => donors.id),
  pledgeActivityId: text("pledge_activity_id").references(() => givingActivities.id),
  decisionType: text("decision_type", { enum: ["apply_to_pledge", "new_gift"] }).notNull(),
  paymentCents: integer("payment_cents").notNull(),
  appliedCents: integer("applied_cents").notNull(),
  newGiftCents: integer("new_gift_cents").notNull(),
  overpaymentAction: text("overpayment_action", { enum: ["split_remainder_new_gift"] }),
  previousPaidCents: integer("previous_paid_cents"),
  nextPaidCents: integer("next_paid_cents"),
  previousBalanceCents: integer("previous_balance_cents"),
  nextBalanceCents: integer("next_balance_cents"),
  previousStatus: text("previous_status"),
  nextStatus: text("next_status"),
  paymentDate: integer("payment_date", { mode: "timestamp" }),
  remainingBalanceCents: integer("remaining_balance_cents"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
}, (table) => [
  uniqueIndex("jl_payment_assignment_audits_import_payment_idx").on(table.importId, table.paymentFingerprint),
  index("jl_payment_assignment_audits_user_date_idx").on(table.userId, table.createdAt),
  index("jl_payment_assignment_audits_pledge_idx").on(table.pledgeActivityId, table.createdAt),
]);

export const donationImportRollbackAudits = sqliteTable("donation_import_rollback_audits", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id),
  importId: text("import_id").notNull(),
  backupConfirmed: integer("backup_confirmed", { mode: "boolean" }).notNull(),
  previewJson: text("preview_json", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
  removedGifts: integer("removed_gifts").notNull(),
  restoredPledges: integer("restored_pledges").notNull(),
  restoredBalances: integer("restored_balances").notNull(),
  restoredStatuses: integer("restored_statuses").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
}, (table) => [
  uniqueIndex("donation_import_rollback_audits_import_idx").on(table.importId),
  index("donation_import_rollback_audits_user_date_idx").on(table.userId, table.createdAt),
]);

export const householdImportChanges = sqliteTable("household_import_changes", {
  id: text("id").primaryKey(),
  importId: text("import_id").notNull(),
  userId: text("user_id").notNull().references(() => users.id),
  donorId: text("donor_id").notNull(),
  changeType: text("change_type", { enum: ["insert", "update", "merge", "consolidated"] }).notNull(),
  beforeJson: text("before_json", { mode: "json" }).$type<Record<string, string | number | null> | null>(),
  afterJson: text("after_json", { mode: "json" }).$type<Record<string, string | number | null>>().notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
}, (table) => [
  uniqueIndex("household_import_changes_batch_donor_idx").on(table.importId, table.donorId),
  index("household_import_changes_user_date_idx").on(table.userId, table.createdAt),
]);

export const householdImportRollbackAudits = sqliteTable("household_import_rollback_audits", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id),
  importId: text("import_id").notNull(),
  backupConfirmed: integer("backup_confirmed", { mode: "boolean" }).notNull(),
  previewJson: text("preview_json", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
  removedDonors: integer("removed_donors").notNull(),
  restoredDonors: integer("restored_donors").notNull(),
  preservedLaterEdits: integer("preserved_later_edits").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
}, (table) => [
  uniqueIndex("household_import_rollback_audits_import_idx").on(table.importId),
  index("household_import_rollback_audits_user_date_idx").on(table.userId, table.createdAt),
]);

export const workspaceBackupAudits = sqliteTable("workspace_backup_audits", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id),
  purpose: text("purpose").notNull(),
  importId: text("import_id"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
}, (table) => [index("workspace_backup_audits_user_import_idx").on(table.userId, table.importId, table.createdAt)]);

export const recommendations = sqliteTable("recommendations", {
  id: text("id").primaryKey(),
  donorId: text("donor_id").notNull().references(() => donors.id),
  userId: text("user_id").notNull().references(() => users.id),
  action: text("action").notNull(),
  reason: text("reason").notNull(),
  score: integer("score").notNull(),
  status: text("status", { enum: ["open", "completed", "dismissed"] }).notNull().default("open"),
  dueAt: integer("due_at", { mode: "timestamp" }),
  // Same date-only convention as interactions.occurredAtDateOnly, for
  // Monday.com-imported reminders whose due date has no real time.
  dueAtDateOnly: integer("due_at_date_only", { mode: "boolean" }).notNull().default(false),
  ...timestamps,
}, (table) => [index("recommendations_user_status_idx").on(table.userId, table.status)]);

// Historical context imported from Monday.com (or any future source) that
// is genuinely uncertain -- a fundraiser could not confirm it as a real
// contact, but the raw text is still worth keeping visible. Deliberately
// separate from interactions/recommendations: status is only ever
// 'unconfirmed' or 'dismissed', never 'confirmed' -- confirming something
// means writing a real interactions/recommendations row through the
// existing confirm/create-followup actions, not flipping a flag here.
export const donorHistoricalContext = sqliteTable("donor_historical_context", {
  id: text("id").primaryKey(),
  donorId: text("donor_id").notNull().references(() => donors.id),
  userId: text("user_id").notNull().references(() => users.id),
  text: text("text").notNull(),
  sourceDate: integer("source_date", { mode: "timestamp" }),
  classification: text("classification").notNull(),
  source: text("source").notNull(),
  fingerprint: text("fingerprint").notNull(),
  status: text("status", { enum: ["unconfirmed", "dismissed"] }).notNull().default("unconfirmed"),
  ...timestamps,
}, (table) => [
  uniqueIndex("donor_historical_context_user_fingerprint_uidx").on(table.userId, table.fingerprint),
  index("donor_historical_context_donor_date_idx").on(table.donorId, table.createdAt),
]);

// Lightweight, append-only "Mark thank-you sent" tracking for a paid
// gift/giving activity -- deliberately not a column on giving_activities/
// gifts (a JL re-import's own UPDATE never references this table, so
// acknowledgment state survives every re-import with no special-casing)
// and deliberately not an interactions row (never counts as a completed
// relationship interaction, never changes last-contact, never generates
// relationship_summary/institutional_memory). Never UPDATEd -- a later
// status change is a new row, so the record of what was marked before is
// never destroyed; current status is the most recent row for a given
// (giftSource, giftId).
export const giftAcknowledgments = sqliteTable("gift_acknowledgments", {
  id: text("id").primaryKey(),
  donorId: text("donor_id").notNull().references(() => donors.id),
  userId: text("user_id").notNull().references(() => users.id),
  giftSource: text("gift_source", { enum: ["giving_activity", "gift"] }).notNull(),
  giftId: text("gift_id").notNull(),
  status: text("status", { enum: ["thank_you_sent", "thank_you_call", "no_acknowledgment_needed"] }).notNull(),
  ...timestamps,
}, (table) => [
  index("gift_acknowledgments_gift_idx").on(table.userId, table.giftSource, table.giftId, table.createdAt),
  index("gift_acknowledgments_donor_idx").on(table.donorId, table.createdAt),
]);

// A donor's relatives' yahrtzeits. The Hebrew date (hebrewMonth/hebrewDay/
// hebrewYear) is canonical and permanent; the Gregorian occurrence is never
// stored -- it's recalculated for the relevant year on every read (see
// lib/calendar/hebrew-date.ts). Editable/deletable, unlike the append-only
// audit tables above -- this row IS the maintained fact, not an event log;
// its own edit history lives in yahrtzeitChanges. fingerprint gives Monday-
// import-style idempotent re-upload.
export const yahrtzeits = sqliteTable("yahrtzeits", {
  id: text("id").primaryKey(),
  donorId: text("donor_id").notNull().references(() => donors.id),
  userId: text("user_id").notNull().references(() => users.id),
  deceasedNameEnglish: text("deceased_name_english").notNull(),
  deceasedNameHebrew: text("deceased_name_hebrew"),
  relationship: text("relationship").notNull(),
  hebrewMonth: text("hebrew_month").notNull(),
  hebrewDay: integer("hebrew_day").notNull(),
  hebrewYear: integer("hebrew_year"),
  source: text("source", { enum: ["manual", "import-yahrtzeit-workbook"] }).notNull(),
  sourceDonorCode: text("source_donor_code"),
  fingerprint: text("fingerprint").notNull(),
  ...timestamps,
}, (table) => [
  uniqueIndex("yahrtzeits_fingerprint_idx").on(table.fingerprint),
  index("yahrtzeits_donor_idx").on(table.donorId, table.hebrewMonth, table.hebrewDay),
  index("yahrtzeits_user_idx").on(table.userId),
]);

// Append-only create/update/delete history for yahrtzeits, matching
// donorContactAudits' shape. yahrtzeitId is deliberately not a foreign key
// -- a deletion's audit row must outlive the yahrtzeits row it describes.
export const yahrtzeitChanges = sqliteTable("yahrtzeit_changes", {
  id: text("id").primaryKey(),
  yahrtzeitId: text("yahrtzeit_id").notNull(),
  donorId: text("donor_id").notNull().references(() => donors.id),
  userId: text("user_id").notNull().references(() => users.id),
  action: text("action", { enum: ["created", "updated", "deleted"] }).notNull(),
  changedFields: text("changed_fields", { mode: "json" }).$type<string[]>().notNull(),
  beforeJson: text("before_json", { mode: "json" }).$type<Record<string, unknown> | null>(),
  afterJson: text("after_json", { mode: "json" }).$type<Record<string, unknown> | null>(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
}, (table) => [index("yahrtzeit_changes_yahrtzeit_idx").on(table.yahrtzeitId, table.createdAt)]);

// Donor Research (Stage A) -- provider-agnostic, manual-entry only. No
// external network calls anywhere in this feature yet; see
// lib/research/manual-provider.ts. Evidence entered before identity
// confirmation lives only in donorResearchPendingEvidence, never in the
// shared donorResearchSources pool, so a misidentified donor's evidence
// can never leak into another donor's research or dedupe/shared-affiliation
// matching. donorResearchSources is deliberately NOT donor-scoped: the same
// public page can support findings for multiple donors, which is what makes
// shared-affiliation evidence traceable.
export const donorResearchRuns = sqliteTable("donor_research_runs", {
  id: text("id").primaryKey(),
  donorId: text("donor_id").notNull().references(() => donors.id),
  userId: text("user_id").notNull().references(() => users.id),
  status: text("status", { enum: ["open", "completed", "discarded"] }).notNull().default("open"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  completedAt: integer("completed_at", { mode: "timestamp" }),
}, (table) => [index("donor_research_runs_donor_date_idx").on(table.donorId, table.createdAt)]);

export const donorResearchPendingEvidence = sqliteTable("donor_research_pending_evidence", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull().references(() => donorResearchRuns.id),
  donorId: text("donor_id").notNull().references(() => donors.id),
  userId: text("user_id").notNull().references(() => users.id),
  url: text("url").notNull(),
  title: text("title").notNull(),
  snippet: text("snippet"),
  publishedAt: integer("published_at", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
}, (table) => [index("donor_research_pending_evidence_run_idx").on(table.runId)]);

export const donorResearchIdentityCandidates = sqliteTable("donor_research_identity_candidates", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull().references(() => donorResearchRuns.id),
  donorId: text("donor_id").notNull().references(() => donors.id),
  userId: text("user_id").notNull().references(() => users.id),
  label: text("label").notNull(),
  status: text("status", { enum: ["pending", "confirmed", "rejected"] }).notNull().default("pending"),
  decidedAt: integer("decided_at", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
}, (table) => [index("donor_research_identity_candidates_donor_status_idx").on(table.donorId, table.status)]);

export const donorResearchFindings = sqliteTable("donor_research_findings", {
  id: text("id").primaryKey(),
  firstSeenRunId: text("first_seen_run_id").notNull().references(() => donorResearchRuns.id),
  lastConfirmedRunId: text("last_confirmed_run_id").notNull().references(() => donorResearchRuns.id),
  donorId: text("donor_id").notNull().references(() => donors.id),
  userId: text("user_id").notNull().references(() => users.id),
  category: text("category", { enum: ["professional", "boards_affiliations", "public_philanthropy", "recent_mentions", "possible_connections", "notes_ambiguities"] }).notNull(),
  claim: text("claim").notNull(),
  relatedDonorId: text("related_donor_id").references(() => donors.id),
  organizationNormalized: text("organization_normalized"),
  status: text("status", { enum: ["current", "superseded", "removed_not_found", "unverified"] }).notNull().default("current"),
  fingerprint: text("fingerprint").notNull(),
  supersedesFindingId: text("supersedes_finding_id"),
  notFoundStreak: integer("not_found_streak").notNull().default(0),
  notifiedAt: integer("notified_at", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
}, (table) => [
  index("donor_research_findings_donor_status_category_idx").on(table.donorId, table.status, table.category),
  uniqueIndex("donor_research_findings_donor_fingerprint_active_uidx").on(table.donorId, table.fingerprint).where(sql`${table.status} IN ('current','unverified')`),
  index("donor_research_findings_user_org_idx").on(table.userId, table.organizationNormalized),
]);

export const donorResearchSources = sqliteTable("donor_research_sources", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id),
  url: text("url").notNull(),
  normalizedUrl: text("normalized_url").notNull(),
  domain: text("domain").notNull(),
  title: text("title").notNull(),
  publisher: text("publisher"),
  publishedAt: integer("published_at", { mode: "timestamp" }),
  retrievedAt: integer("retrieved_at", { mode: "timestamp" }).notNull(),
  excerpt: text("excerpt"),
  sourceTier: text("source_tier", { enum: ["primary_institutional", "press_release", "reputable_news", "event_program", "public_search_result"] }).notNull(),
  discoveredVia: text("discovered_via"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
}, (table) => [
  uniqueIndex("donor_research_sources_user_normalized_url_uidx").on(table.userId, table.normalizedUrl),
  index("donor_research_sources_user_domain_idx").on(table.userId, table.domain),
]);

export const donorResearchFindingSources = sqliteTable("donor_research_finding_sources", {
  findingId: text("finding_id").notNull().references(() => donorResearchFindings.id),
  sourceId: text("source_id").notNull().references(() => donorResearchSources.id),
}, (table) => [
  primaryKey({ columns: [table.findingId, table.sourceId] }),
  index("donor_research_finding_sources_source_idx").on(table.sourceId),
]);
