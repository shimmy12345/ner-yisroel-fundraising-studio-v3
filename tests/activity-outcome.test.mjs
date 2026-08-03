import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
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

const plannedAt = 1770000000;
const completedSource = `capture-completed:${plannedAt}:completed:capture-scheduled:call`;
const noResponseSource = `capture-completed:${plannedAt}:no-response:capture-scheduled:call`;
assert.equal(isCompletedActivity(completedSource), true);
assert.equal(isScheduledActivity(completedSource, plannedAt + 3600, plannedAt - 3600), false);
assert.equal(completedPlannedAt(completedSource), plannedAt);
assert.equal(isNoResponseActivity(noResponseSource), true);

assert.match(liveData, /\/interactions\/\$\{encodeURIComponent\(item\.id\)\}\/outcome/);
assert.match(liveData, /i\.source NOT LIKE 'capture-completed:%'/);
assert.match(outcomePage, /isScheduledActivity/);
assert.match(outcomePage, /i\.user_id = \? AND d\.owner_user_id = \?/);
assert.match(outcomePage, /localDateTimeValue\(now, profile\.timezone\)/);
assert.match(outcomePage, /plannedLabel: dateTimeLabel\(planned, profile\.timezone\)/);
for (const label of ["Outcome / result", "Completed date", "Add a follow-up activity", "Close Activity", "Cancel", "Reschedule", "No response"]) {
  assert.match(outcomeExperience, new RegExp(label));
}
assert.match(outcomeExperience, /status === "saving"/);
assert.match(outcomeRoute, /UPDATE interactions SET occurred_at = \?, summary = \?, source = \?.*source = \? AND occurred_at = \?/);
assert.match(outcomeRoute, /capture-completed:/);
assert.match(outcomeRoute, /capture-scheduled:followup:/);
assert.match(outcomeRoute, /activity-followup-\$\{id\}/);
assert.match(outcomeRoute, /results\[0\]\.meta\.changes/);
assert.match(outcomeRoute, /UPDATE interactions SET occurred_at = \?, source = \?/);
assert.match(outcomeRoute, /env\.DB\.batch\(statements\)/);
assert.doesNotMatch(outcomeRoute, /DELETE FROM interactions/);
assert.match(donorPage, /Originally planned for/);
assert.match(donorPage, /Completed \$\{item\.type\}/);
assert.match(donorPage, /Log Outcome/);

process.stdout.write("Activity outcome closure checks passed.\n");
