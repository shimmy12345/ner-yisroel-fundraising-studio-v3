import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dedupeRelationshipQueue, groupRelationshipQueue, isRecentPastEvent, relationshipQueueBucket } from "../lib/workspace/relationship-queue.ts";
import { removeQueueItem, restoreQueueItem } from "../lib/workspace/optimistic-dismissal.ts";

const now = Math.floor(Date.parse("2026-08-04T14:00:00Z") / 1000);
const timezone = "America/New_York";
const yesterday = Math.floor(Date.parse("2026-08-03T16:00:00Z") / 1000);
const today = Math.floor(Date.parse("2026-08-04T18:00:00Z") / 1000);
const thisWeek = Math.floor(Date.parse("2026-08-07T16:00:00Z") / 1000);

assert.equal(relationshipQueueBucket(yesterday, now, timezone), "overdue");
assert.equal(relationshipQueueBucket(today, now, timezone), "today");
assert.equal(relationshipQueueBucket(thisWeek, now, timezone), "thisWeek");
assert.equal(relationshipQueueBucket(null, now, timezone), "upcoming");
assert.equal(isRecentPastEvent(now - 10 * 86400, now, 30), true);
assert.equal(isRecentPastEvent(now + 86400, now, 30), false, "future-dated gifts are never recent giving");
assert.equal(isRecentPastEvent(now - 31 * 86400, now, 30), false);

const candidates = [
  { queueId: "reminder:fictional-overdue:1", donorId: "fictional-a", dueAt: yesterday, rank: 0, sortAt: yesterday },
  { queueId: "gift:fictional-gift:1", donorId: "fictional-a", dueAt: today, rank: 2, sortAt: today },
  { queueId: "activity:fictional-meeting:1", donorId: "fictional-b", dueAt: today, rank: 1, sortAt: today },
  { queueId: "reminder:fictional-week:1", donorId: "fictional-c", dueAt: thisWeek, rank: 5, sortAt: thisWeek },
  { queueId: "contact-gap:fictional-d:0", donorId: "fictional-d", dueAt: null, rank: 6, sortAt: Number.MAX_SAFE_INTEGER },
];

const queue = dedupeRelationshipQueue(candidates, new Set());
assert.equal(queue.filter((item) => item.donorId === "fictional-a").length, 1, "one donor receives one highest-priority queue card");
assert.equal(queue.find((item) => item.donorId === "fictional-a")?.queueId, "reminder:fictional-overdue:1");
const groups = groupRelationshipQueue(queue, now, timezone);
assert.equal(groups.overdue.length, 1);
assert.equal(groups.today.length, 1);
assert.equal(groups.thisWeek.length, 1);
assert.equal(groups.upcoming.length, 1);

const dismissed = dedupeRelationshipQueue(candidates, new Set(["activity:fictional-meeting:1"]));
assert.equal(dismissed.some((item) => item.queueId === "activity:fictional-meeting:1"), false, "a dismissed source revision leaves the queue");
const changedSource = [...candidates.filter((item) => item.queueId !== "activity:fictional-meeting:1"), { queueId: "activity:fictional-meeting:2", donorId: "fictional-b", dueAt: today, rank: 1, sortAt: today }];
assert.equal(dedupeRelationshipQueue(changedSource, new Set(["activity:fictional-meeting:1"])).some((item) => item.queueId === "activity:fictional-meeting:2"), true, "a changed source returns after an old dismissal");
const originalOrder = new Map(candidates.map((item, index) => [item.queueId, index]));
const optimisticallyRemoved = removeQueueItem(candidates, "activity:fictional-meeting:1");
assert.equal(optimisticallyRemoved.length, candidates.length - 1, "optimistic dismissal updates the visible total immediately");
assert.deepEqual(restoreQueueItem(optimisticallyRemoved, candidates[2], originalOrder), candidates, "failed persistence restores the exact original order");
assert.equal(restoreQueueItem(candidates, candidates[2], originalOrder).length, candidates.length, "rapid Undo cannot duplicate a card");

const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
const liveData = await readFile(new URL("../lib/workspace/live-data.ts", import.meta.url), "utf8");
const donorPage = await readFile(new URL("../app/donors/[id]/page.tsx", import.meta.url), "utf8");
const dismissRoute = await readFile(new URL("../app/api/relationship-queue/dismiss/route.ts", import.meta.url), "utf8");
const queueExperience = await readFile(new URL("../app/components/RelationshipQueueExperience.tsx", import.meta.url), "utf8");
const migration = await readFile(new URL("../drizzle/0017_today_relationship_queue.sql", import.meta.url), "utf8");

assert.match(page, /RelationshipQueueExperience/);
assert.match(queueExperience, /donorNavigationHref\(priority\.donorId, queueReturnTo, "queue"\)/, "every queue card exposes a contextual donor link");
assert.match(queueExperience, /CompletePriorityButton/);
assert.match(queueExperience, /Dismiss suggestion/);
assert.match(queueExperience, /completeOptimistically/);
assert.match(queueExperience, /scope === "agenda"/);
assert.match(liveData, /r\.status = 'open'/, "completed reminders cannot remain in the queue");
assert.match(liveData, /i\.source NOT LIKE 'cancelled:%'/, "cancelled activities cannot remain in the queue");
assert.match(liveData, /d\.owner_user_id = \? AND d\.data_source = 'live' AND d\.archived_at IS NULL/, "recent lists exclude archived aliases");
assert.match(donorPage, /INSERT INTO donor_views/);
assert.match(donorPage, /ON CONFLICT\(user_id,donor_id\)/);
assert.match(dismissRoute, /getChatGPTUser/);
assert.match(dismissRoute, /owner_user_id=\?.*data_source='live'.*archived_at IS NULL/);
assert.match(queueExperience, /Suggestion dismissed/);
assert.match(queueExperience, /10_000/);
assert.match(queueExperience, /setItems\(\(value\) => removeQueueItem\(value, item\.queueId\)\)/);
assert.match(queueExperience, /setItems\(\(value\) => restoreQueueItem\(value, item, order\)\)/);
assert.match(queueExperience, /if \(!saved && desiredDismissed/);
assert.match(queueExperience, /persist\("DELETE", item\)/);
assert.match(queueExperience, /Undo/);
assert.doesNotMatch(queueExperience, /window\.location\.(reload|assign)/);
assert.match(migration, /PRIMARY KEY \(`user_id`,`donor_id`\)/);
assert.match(migration, /PRIMARY KEY \(`user_id`,`item_key`\)/);

// --- Regression: dismiss route's validKey regex must accept every queueId
// shape live-data.ts actually generates, not just the ones that existed
// when the route was first written. The recommendation-engine unification
// (lib/workspace/live-data.ts) replaced the old per-kind gift/commitment/
// contact-gap prefixes with a single `recommendation:${donorId}:${kind}`
// format, but the dismiss route's whitelist regex was never updated to
// match -- so every recommendation-engine-sourced suggestion (acknowledge
// gift, open pledge follow-up, contact gap, solicit, relationship
// opportunity, continue-conversation) failed to dismiss with a 400 and was
// optimistically restored client-side. Reminders and scheduled activities
// were unaffected since they kept their own "reminder"/"activity" prefixes.
// This test extracts the actual regex from the route source and runs it
// against real generated shapes so a future prefix change can't silently
// reintroduce the same class of bug.
const validKeySource = dismissRoute.match(/const validKey = \/(.+)\/;/);
assert.ok(validKeySource, "dismiss route must define a validKey regex");
const validKey = new RegExp(validKeySource[1]);
assert.match(liveData, /queueId: `recommendation:\$\{donorId\}:\$\{recommendation\.kind\}`/, "live-data.ts must still generate the single recommendation: prefix this test's fixtures assume");
const donorId = "060617d5-dd39-4751-85bd-fdcc1dcc16ca";
for (const kind of ["acknowledge_gift", "follow_up_pledge", "continue_conversation", "relationship_opportunity", "solicit", "reconnect_contact_gap"]) {
  assert.ok(validKey.test(`recommendation:${donorId}:${kind}`), `dismiss route must accept a real recommendation queueId for kind "${kind}"`);
}
assert.ok(validKey.test(`reminder:some-recommendation-id:1755000000`), "dismiss route must still accept reminder queueIds");
assert.ok(validKey.test(`activity:some-activity-id:1755000000`), "dismiss route must still accept scheduled-activity queueIds");
// The old prefixes are dead -- nothing in the codebase generates them
// anymore -- so they're deliberately no longer whitelisted.
for (const prefix of ["gift", "commitment", "contact-gap"]) assert.ok(!validKey.test(`${prefix}:${donorId}:1`), `"${prefix}:" is not generated anywhere and must not be silently accepted`);

process.stdout.write("Today relationship queue checks passed.\n");
