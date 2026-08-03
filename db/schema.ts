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
  ...timestamps,
});

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
  sourceSnapshot: text("source_snapshot", { mode: "json" }).$type<Record<string, string>>().notNull(),
  ...timestamps,
}, (table) => [index("giving_activities_donor_date_idx").on(table.donorId, table.activityDate)]);

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
  ...timestamps,
}, (table) => [index("recommendations_user_status_idx").on(table.userId, table.status)]);
