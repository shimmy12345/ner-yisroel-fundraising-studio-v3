import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  activityStatus,
  completedPlannedAt,
  isCompletedActivity,
  isNoResponseActivity,
  isScheduledActivity,
} from "../lib/workspace/scheduled-activity.ts";

const outcomeRoute = await readFile(new URL("../app/api/interactions/[id]/outcome/route.ts", import.meta.url), "utf8");
const outcomePage = await readFile(new URL("../app/interactions/[id]/outcome/page.tsx", import.meta.url), "utf8");
const outcomeExperience = await readFile(new URL("../app/interactions/[id]/outcome/OutcomeExperience.tsx", import.meta.url), "utf8");
const liveData = await readFile(new URL("../lib/workspace/live-data.ts", import.meta.url), "utf8");
const donorPage = await readFile(new URL("../app/donors/[id]/page.tsx", import.meta.url), "utf8");
const unifiedTimeline = await readFile(new URL("../app/donors/[id]/UnifiedRelationshipTimeline.tsx", import.meta.url), "utf8");
const activityActions = await readFile(new URL("../app/components/ActivityActions.tsx", import.meta.url), "utf8");

const plannedAt = 1770000000;
const completedSource = `capture-completed:${plannedAt}:completed:capture-scheduled:call`;
const noResponseSource = `capture-completed:${plannedAt}:no-response:capture-scheduled:call`;
assert.equal(isCompletedActivity(completedSource), true);
assert.equal(isScheduledActivity(completedSource, plannedAt + 3600, plannedAt - 3600), false);
assert.equal(completedPlannedAt(completedSource), plannedAt);
assert.equal(isNoResponseActivity(noResponseSource), true);
assert.equal(activityStatus(completedSource, plannedAt + 3600, plannedAt - 3600), "completed");
assert.equal(activityStatus(`cancelled:${completedSource}`, plannedAt, plannedAt - 3600), "cancelled");

assert.match(liveData, /\/interactions\/\$\{encodeURIComponent\(item\.id\)\}\/outcome/);
assert.match(liveData, /i\.source NOT LIKE 'capture-completed:%'/);
assert.match(outcomePage, /activityStatus/);
assert.match(outcomePage, /i\.user_id = \? AND d\.owner_user_id = \?/);
assert.match(outcomePage, /activity_status_audits/);
for (const label of ["Outcome / result", "Completed date", "Add a follow-up activity", "Follow-up type", "Close Activity", "Close and Schedule Follow-up", "Cancelled", "Reschedule", "No response", "Reopen activity", "Undo this change"]) {
  assert.match(outcomeExperience, new RegExp(label));
}
assert.match(outcomeExperience, /if \(saving\) return/);
assert.match(outcomeExperience, /window\.confirm/);
assert.match(outcomeRoute, /UPDATE interactions SET occurred_at = \?, summary = \?, source = \?.*source = \? AND occurred_at = \?/);
assert.match(outcomeRoute, /capture-completed:/);
assert.match(outcomeRoute, /capture-scheduled:followup:/);
assert.match(outcomeRoute, /activity-followup-\$\{id\}/);
assert.match(outcomeRoute, /ON CONFLICT\(id\) DO UPDATE/);
assert.match(outcomeRoute, /activity_status_audits/);
assert.match(outcomeRoute, /previous_source/);
assert.match(outcomeRoute, /undone_at/);
assert.match(outcomeRoute, /action === "reopen"/);
assert.match(outcomeRoute, /env\.DB\.batch\(statements\)/);
assert.doesNotMatch(outcomeRoute, /DELETE FROM interactions/);
assert.match(unifiedTimeline, /Originally planned for/);
assert.match(unifiedTimeline, /Log Outcome/);
assert.match(unifiedTimeline, /Cancelled/);
assert.match(activityActions, /Edit outcome/);

process.stdout.write("Activity outcome closure checks passed.\n");
