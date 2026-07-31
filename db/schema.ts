import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

const timestamps = {
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
};

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  name: text("name"),
  ...timestamps,
});

export const donors = sqliteTable("donors", {
  id: text("id").primaryKey(),
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
  ...timestamps,
});

export const interactions = sqliteTable("interactions", {
  id: text("id").primaryKey(),
  donorId: text("donor_id").notNull().references(() => donors.id),
  userId: text("user_id").notNull().references(() => users.id),
  type: text("type", { enum: ["call", "email", "meeting", "note", "gift"] }).notNull(),
  occurredAt: integer("occurred_at", { mode: "timestamp" }).notNull(),
  summary: text("summary").notNull(),
  source: text("source").notNull().default("manual"),
  ...timestamps,
}, (table) => [index("interactions_donor_date_idx").on(table.donorId, table.occurredAt)]);

export const gifts = sqliteTable("gifts", {
  id: text("id").primaryKey(),
  donorId: text("donor_id").notNull().references(() => donors.id),
  amountCents: integer("amount_cents").notNull(),
  fund: text("fund").notNull(),
  receivedAt: integer("received_at", { mode: "timestamp" }).notNull(),
  acknowledgedAt: integer("acknowledged_at", { mode: "timestamp" }),
  ...timestamps,
}, (table) => [index("gifts_donor_date_idx").on(table.donorId, table.receivedAt)]);

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
