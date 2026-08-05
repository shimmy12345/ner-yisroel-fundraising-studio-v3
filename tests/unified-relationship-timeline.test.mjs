import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { countsInGivingTotals } from "../lib/giving/management.ts";
import { buildUnifiedTimeline, TIMELINE_FILTERS } from "../lib/relationships/unified-timeline.ts";

const giving = [
  { id: "fictional-gift", donor_id: "fictional-donor", external_source: "JL Solutions", activity_date: 900, committed_cents: 10_000, paid_cents: 10_000, balance_cents: 0, item_type: "Gift", description: "Annual gift", category: "completed_gift", workspace_status: "active", private_note: null, updated_at: 900 },
  { id: "fictional-pledge", donor_id: "fictional-donor", external_source: "JL Solutions", activity_date: 700, committed_cents: 50_000, paid_cents: 20_000, balance_cents: 30_000, item_type: "Pledge", description: "Building pledge", category: "partially_paid_pledge", workspace_status: "active", private_note: null, updated_at: 700 },
  { id: "merged-pending", donor_id: "fictional-donor", external_source: "Fundraising OS", activity_date: 900, committed_cents: 10_000, paid_cents: 0, balance_cents: 0, item_type: "Pending gift", description: "Expected annual gift", category: "pending_gift", workspace_status: "merged", private_note: null, updated_at: 900 },
  { id: "undated-gift", donor_id: "fictional-donor", external_source: "JL Solutions", activity_date: null, committed_cents: 2_500, paid_cents: 2_500, balance_cents: 0, item_type: "Gift", description: "Date unavailable", category: "completed_gift", workspace_status: "active", private_note: null, updated_at: 1_200 },
];
const payments = [
  { id: "fictional-payment", payment_date: 800, applied_cents: 20_000, remaining_balance_cents: 30_000, pledge_activity_id: "fictional-pledge", pledge_description: "Building pledge" },
  { id: "fictional-payment", payment_date: 800, applied_cents: 20_000, remaining_balance_cents: 30_000, pledge_activity_id: "fictional-pledge", pledge_description: "Building pledge" },
  { id: "orphan-payment", payment_date: 650, applied_cents: 1_000, remaining_balance_cents: 0, pledge_activity_id: "missing-pledge", pledge_description: null },
];
const interactions = [
  { id: "meeting", type: "meeting", occurred_at: 850, summary: "Donor meeting\nDiscussed current support", source: "capture:meeting", created_at: 850, status_changed_at: null },
  { id: "call", type: "call", occurred_at: 1_100, summary: "Stewardship call\nShare an update", source: "capture-scheduled:call", created_at: 600, status_changed_at: null },
  { id: "cancelled", type: "email", occurred_at: 1_300, summary: "Cancelled email\nNo longer needed", source: "cancelled:capture-scheduled:email", created_at: 600, status_changed_at: 950 },
  { id: "followup", type: "call", occurred_at: 925, summary: "Follow-up call\nOutcome: Connected", source: "capture-completed:900:completed:capture-scheduled:followup:meeting:call", created_at: 700, status_changed_at: 925 },
];
const reminders = [
  { id: "reminder", action: "Send acknowledgement", reason: "Gift follow-up", status: "open", due_at: 1_050, created_at: 700, updated_at: 700 },
  { id: "activity-call", action: "Call reminder", reason: "Generated from scheduled call", status: "open", due_at: 1_100, created_at: 600, updated_at: 600 },
];

const timeline = buildUnifiedTimeline({ giving, legacyGifts: [], payments, interactions, reminders, now: 1_000 });
assert.deepEqual(timeline.map((item) => item.key), [
  "interaction:call", "reminder:reminder", "interaction:cancelled", "interaction:followup", "interaction:meeting", "giving:fictional-gift", "giving:fictional-pledge", "payment:fictional-payment", "payment:orphan-payment", "giving:undated-gift",
], "activities sort by actual time, financial records use stable calendar-date ordering, and undated records sort last");
assert.equal(timeline.filter((item) => item.key === "payment:fictional-payment").length, 1, "duplicate payment events render once");
assert.equal(timeline.some((item) => item.key === "reminder:activity-call"), false, "a generated reminder does not duplicate its scheduled activity");
assert.equal(timeline.some((item) => item.key === "giving:merged-pending"), false, "a merged pending gift does not duplicate its confirmed gift");
assert.equal(timeline.find((item) => item.key === "interaction:cancelled").eventAt, 950, "cancelled work uses its actual status-change time instead of the abandoned planned date");
assert.equal(timeline.find((item) => item.key === "payment:fictional-payment").linkedPledgeExists, true);
assert.equal(timeline.find((item) => item.key === "payment:orphan-payment").linkedPledgeExists, false, "orphaned links become an honest unavailable state rather than a broken anchor");
assert.equal(giving.filter(countsInGivingTotals).reduce((sum, item) => sum + (item.paid_cents ?? 0), 0), 32_500, "payment timeline events and merged pending gifts never add to giving totals");
for (const filter of ["gifts", "pledges", "payments", "calls", "emails", "meetings", "reminders"]) assert.ok(TIMELINE_FILTERS.some((item) => item.id === filter));

const page = await readFile(new URL("../app/donors/[id]/page.tsx", import.meta.url), "utf8");
const component = await readFile(new URL("../app/donors/[id]/UnifiedRelationshipTimeline.tsx", import.meta.url), "utf8");
const interactionHelper = await readFile(new URL("../lib/capture/interaction.ts", import.meta.url), "utf8");
assert.match(page, /UNIFIED RELATIONSHIP TIMELINE/);
assert.doesNotMatch(page, /RELATIONSHIP HISTORY|GIVING HISTORY/);
assert.match(component, /Filter relationship timeline/);
assert.match(component, /href={`#pledge-/);
assert.match(component, /Linked pledge is unavailable/);
assert.match(component, /Log Outcome/);
assert.match(component, /Edit or reopen/);
assert.match(component, /GivingRecordActions/);
assert.match(component, /CompletePriorityButton/);
assert.match(component, /No relationship activity yet/);
assert.match(component, /splitInteractionSummary/);
assert.match(interactionHelper, /Interaction Note/);
assert.match(interactionHelper, /No additional notes recorded/);

process.stdout.write("Unified relationship timeline checks passed.\n");
