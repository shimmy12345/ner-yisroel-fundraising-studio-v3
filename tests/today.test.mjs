import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const today = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
const liveData = await readFile(new URL("../lib/workspace/live-data.ts", import.meta.url), "utf8");
const queueExperience = await readFile(new URL("../app/components/RelationshipQueueExperience.tsx", import.meta.url), "utf8");
const completion = await readFile(new URL("../app/api/recommendations/[id]/complete/route.ts", import.meta.url), "utf8");
const completeButton = await readFile(new URL("../app/components/CompletePriorityButton.tsx", import.meta.url), "utf8");
const dismissal = await readFile(new URL("../app/api/recommendations/[id]/dismiss/route.ts", import.meta.url), "utf8");
const dismissButton = await readFile(new URL("../app/components/DismissPriorityButton.tsx", import.meta.url), "utf8");
const reschedule = await readFile(new URL("../app/api/recommendations/[id]/reschedule/route.ts", import.meta.url), "utf8");
const rescheduleButton = await readFile(new URL("../app/components/RescheduleButton.tsx", import.meta.url), "utf8");
const capturePage = await readFile(new URL("../app/capture/page.tsx", import.meta.url), "utf8");
const capture = await readFile(new URL("../app/capture/CaptureExperience.tsx", import.meta.url), "utf8");
const donorPage = await readFile(new URL("../app/donors/[id]/page.tsx", import.meta.url), "utf8");
const unifiedTimeline = await readFile(new URL("../app/donors/[id]/UnifiedRelationshipTimeline.tsx", import.meta.url), "utf8");
const relationshipRead = await readFile(new URL("../lib/relationships/read.ts", import.meta.url), "utf8");
const appShell = await readFile(new URL("../app/components/AppShell.tsx", import.meta.url), "utf8");
const briefExperience = await readFile(new URL("../app/components/BriefExperience.tsx", import.meta.url), "utf8");
const styles = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
const recommendationCandidates = await readFile(new URL("../lib/relationships/recommendation-candidates.ts", import.meta.url), "utf8");

for (const action of ["Search Donor", "Import JL Export", "Add Interaction", "Create Reminder", "Workspace Health"]) assert.match(today, new RegExp(action));
for (const section of ["Today's Agenda", "Coming Up", "Quick Actions", "Morning Brief"]) assert.match(today, new RegExp(section));
assert.ok(today.indexOf("Morning Brief") < today.indexOf("Quick Actions"), "Morning Brief must be visible near the top, ahead of Quick Actions");
assert.ok(today.indexOf("Quick Actions") < today.indexOf("Today's Agenda"), "Quick Actions must be visible near the top, ahead of the detailed agenda");
assert.ok(today.indexOf("Today's Agenda") < today.indexOf("Coming Up"));
assert.match(today, /returnTo=%2F/);
assert.match(queueExperience, /priorities=all#\$\{queueAnchor\}/);
assert.match(today, /showAll \? 50 : 10/);
assert.match(today, /No activities or follow-ups need attention today/);
assert.match(today, /agendaIsEmpty.*comingIsEmpty/);
// The old "Birthdays and anniversaries will appear here in a future update"
// placeholder is obsolete now that important dates are implemented and must
// never come back -- comingIsEmpty's existing message already covers an
// empty relationship-date list as part of its broader "nothing coming up"
// wording, so no separate empty-state copy is needed here.
assert.doesNotMatch(today, /future update/i);
assert.doesNotMatch(styles, /future-placeholder/);
assert.match(today, /No meetings, reminders, commitments, or relationship dates are coming up/);
assert.match(today, /activity\.typeLabel/);
assert.match(today, /activity\.donorName/);
assert.match(today, /activity\.subject/);
assert.match(today, /Log Outcome/);
for (const group of ["Overdue", "Due today", "This Week", "Later"]) assert.match(queueExperience, new RegExp(group));
assert.match(queueExperience, /scope === "agenda"/);
assert.match(queueExperience, /expanded \? 5/);
assert.doesNotMatch(today, /ACT NOW|PLAN AHEAD|REFERENCE|LIVE WORKSPACE/);
for (const behavior of ["completedToday", "markComplete", "Read Again", "Dismiss for today", "localStorage"]) assert.match(briefExperience, new RegExp(behavior));
assert.match(briefExperience, /speech\.message === "Full brief finished\."/);
assert.match(styles, /today-command-grid/);
// Today Workspace Layout Cleanup (see docs/AI-HANDOFF.md): Today's Agenda
// now takes the flexible 1fr share and Coming Up is capped at 480px so it
// stays a useful secondary panel rather than growing with .content's
// wider max-width -- see that same entry for why .content itself widened.
assert.match(styles, /grid-template-columns:minmax\(0,1fr\) minmax\(340px,480px\)/, "Today's Agenda must take the larger, flexible work area; Coming Up stays a capped secondary panel");
assert.match(styles, /max-width: 1800px/, "the outer .content container must use substantially more of a wide desktop's width than the old 1540px cap");
// Coming Up's body (everything after its header) must be desktop-bounded
// and internally scrollable so ~20 real entries can't stretch the whole
// page -- header stays outside/above this wrapper so it remains visible.
assert.match(today, /<div className="command-panel-body">/, "Coming Up's body must be wrapped so it can be bounded/scrolled independently of its header");
assert.match(styles, /\.today-coming-up \.command-panel-body \{ max-height:clamp\(/, "Coming Up's bounded height must only apply within .today-coming-up, never to Today's Agenda");
assert.match(styles, /@media \(max-width:760px\)[\s\S]*today-actions-section \.today-quick-actions \{ grid-template-columns:1fr 1fr/);

assert.match(liveData, /Overdue follow-up/);
assert.match(liveData, /Open commitment/);
assert.match(liveData, /Contact gap/);
// Recent-gift/open-commitment/contact-gap wording itself now comes from
// the shared recommendation engine (see tests/recommendation-engine.test.mjs
// for the wording coverage), not duplicated in live-data.ts.
assert.match(recommendationCandidates, /has not been marked acknowledged yet/);
assert.match(liveData, /i\.user_id = \? AND d\.owner_user_id = \? AND d\.data_source = 'live'/);
assert.match(liveData, /ga\.owner_user_id = \? AND ga\.record_origin = 'live'/);
assert.match(liveData, /capture-scheduled:%/);
assert.match(liveData, /i\.occurred_at > i\.created_at/);
assert.match(liveData, /scheduleBucket\(row\.source, row\.occurred_at, row\.created_at, now, timezone\) === "today"/);
assert.match(liveData, /scheduleBucket\(row\.source, row\.occurred_at, row\.created_at, now, timezone\) === "upcoming"/);
assert.match(liveData, /relationship_queue_dismissals/);
assert.match(liveData, /donor_views v JOIN donors/);
assert.match(liveData, /d\.archived_at IS NULL/);

assert.match(completion, /id = \? AND user_id = \? AND status = 'open'/);
assert.match(completion, /owner_user_id = \? AND data_source = 'live'/);
assert.doesNotMatch(completeButton, /window\.location\.reload\(\)/);
assert.match(completeButton, /onOptimisticComplete/);
assert.match(queueExperience, /completeOptimistically/);
assert.match(queueExperience, /restoreFailedCompletion/);

// Dismiss mirrors Complete's authorization shape exactly: same owner/status
// WHERE guard, same auth check, and it must never touch Monday.com at all
// (no fetch/API call, no write to any monday-* source table -- local D1
// status flip only).
assert.match(dismissal, /getChatGPTUser\(\)/, "Dismiss must require authentication, same as Complete");
assert.match(dismissal, /status = 'dismissed'/);
assert.match(dismissal, /id = \? AND user_id = \? AND status = 'open'/, "Dismiss must only ever mutate the caller's own open recommendation, same guard shape as Complete");
assert.match(dismissal, /owner_user_id = \? AND data_source = 'live'/);
assert.doesNotMatch(dismissal.replace(/^\s*\/\/.*$/gm, ""), /fetch\(/, "Dismiss must never call the Monday.com API");
assert.doesNotMatch(dismissal, /UPDATE interactions|UPDATE donors|UPDATE donor_historical_context/, "Dismiss must only ever write the recommendations table");
assert.doesNotMatch(dismissButton, /window\.location\.reload\(\)/);
assert.match(dismissButton, /\/dismiss`/, "the button must post to the dismiss route, not complete");

// Reschedule mirrors Complete/Dismiss's authorization shape exactly (same
// auth check, same owner/status WHERE guard), but must ONLY ever write
// due_at/due_at_date_only -- never action, reason (so Monday provenance
// text is never touched), status (so it can never masquerade as
// complete/dismiss), or donor_id, and it must never INSERT (no duplicate
// recommendation) or touch any other table.
assert.match(reschedule, /getChatGPTUser\(\)/, "Reschedule must require authentication, same as Complete/Dismiss");
assert.match(reschedule, /id = \? AND user_id = \? AND status = 'open'/, "Reschedule must only ever mutate the caller's own open recommendation, same guard shape as Complete/Dismiss");
assert.match(reschedule, /owner_user_id = \? AND data_source = 'live'/);
const rescheduleSet = /SET ([^"]+)\n\s*WHERE/.exec(reschedule);
assert.ok(rescheduleSet, "the reschedule route's UPDATE statement must exist and be readable");
assert.equal(rescheduleSet[1].trim(), "due_at = ?, due_at_date_only = 1, updated_at = ?", "Reschedule may only ever touch due_at/due_at_date_only/updated_at -- never action, reason, status, or donor_id");
assert.doesNotMatch(reschedule, /INSERT INTO/, "Reschedule must never create a new recommendation row -- same id, no duplicate");
assert.doesNotMatch(reschedule, /crypto\.randomUUID/, "Reschedule must update the existing row by its own id, never mint a new one");
assert.doesNotMatch(reschedule.replace(/^\s*\/\/.*$/gm, ""), /fetch\(/, "Reschedule must never call the Monday.com API");
assert.doesNotMatch(reschedule, /UPDATE interactions|INSERT INTO interactions|UPDATE donors|UPDATE giving_activities|UPDATE gifts/, "Reschedule must never touch interactions, donors, or giving/pledge data");
// Always date-only: the UI only ever collects a calendar date, never a
// time, so a guessed time-of-day must never be invented here.
assert.doesNotMatch(reschedule, /getHours|setHours|zonedTimeToUtc/i, "Reschedule must never construct a time-of-day -- date-only, UTC-noon anchor only");
assert.doesNotMatch(rescheduleButton, /window\.location\.reload\(\)/);
assert.match(rescheduleButton, /\/reschedule`/, "the button must post to the reschedule route");
assert.match(rescheduleButton, /type="date"/, "Reschedule must collect a date only, never a time");
assert.doesNotMatch(rescheduleButton, /type="datetime-local"|type="time"/, "Reschedule must never collect a time of day");

// Temporary Error 1102 diagnostic instrumentation on the donor page: one
// compact structured log line per request, timings/counts only. Extracts
// the exact object literal passed to logger.info(...) and checks it both
// positively (donorId is truncated, never the raw column) and negatively
// (no sensitive donor field ever appears inside that specific call).
assert.equal((donorPage.match(/logger\.info\(/g) ?? []).length, 1, "the donor page must emit exactly one structured log line, not many noisy console.log calls");
assert.equal((donorPage.match(/console\.(log|info)\(/g) ?? []).length, 0, "the donor page must log only through the shared logger, never a bare console call");
const donorPageLogCall = /logger\.info\("donor_page_render", \{([\s\S]*?)\n {2}\}\);/.exec(donorPage);
assert.ok(donorPageLogCall, "the donor_page_render structured log call must exist and be readable as a single block");
const logCallBody = donorPageLogCall[1];
assert.match(logCallBody, /donorId: donor\.id\.slice\(0, 8\)/, "donorId must be truncated, never the full identifier");
for (const sensitive of ["display_name", "donor.email", "donor.phone", "home_phone", "address_line_1", "contact_note", "relationship_summary", "institutional_memory", ".summary", ".description", ".text\b", "SELECT ", "INSERT ", "UPDATE "]) {
  assert.doesNotMatch(logCallBody, new RegExp(sensitive), `the structured log call must never include ${sensitive}`);
}
// Every explicitly-named field inside the call must be a timing/count or
// one of the four identifying fields -- never a raw value pulled from a
// query result row. (Shorthand properties like `mode,`/`cfRay,` have no
// colon; `...marks,` is a spread and matches neither pattern here.)
const loggedKeys = [...logCallBody.matchAll(/^\s*(\w+)(?::|,)/gm)].map((match) => match[1]);
assert.deepEqual(loggedKeys, ["donorId", "mode", "cfRay", "d1Calls", "totalMs"], "the log call must explicitly name exactly these five identifying/summary fields, plus the ...marks spread");
// Every render phase the task asked for must actually be instrumented,
// either via a direct marks.xxxMs assignment or via timedAll(marks,
// "xxx", ...) (which sets `${key}Ms`/`${key}Rows` through bracket
// notation, so it's checked by call-site name here instead).
const directMarkKeys = [...donorPage.matchAll(/marks\.(\w+)\s*=/g)].map((match) => match[1]);
for (const key of directMarkKeys) assert.match(key, /Ms$|Rows$/, `marks field "${key}" must be a timing (*Ms) or a count (*Rows), never a raw value`);
const timedAllKeys = [...donorPage.matchAll(/timedAll\(marks, "(\w+)"/g)].map((match) => match[1]);
for (const phase of ["donorLookup", "donorViews", "donorResearch", "historicalContext", "yahrtzeits", "importantDates", "evidence"]) {
  assert.ok(directMarkKeys.includes(`${phase}Ms`), `${phase} must be timed (marks.${phase}Ms)`);
}
for (const phase of ["giving", "gifts", "interactions", "reminders", "paymentEvents", "contactAudits", "donorDirectory", "acknowledgments", "asks"]) {
  assert.ok(timedAllKeys.includes(phase), `${phase} must be timed via timedAll(marks, "${phase}", ...)`);
}
// cf-ray correlation: the same next/headers API this app already uses
// elsewhere (app/chatgpt-auth.ts) for other request headers -- not an
// invented mechanism.
assert.match(donorPage, /headers\(\)\)\.get\("cf-ray"\)/, "the donor page must read cf-ray via next/headers, matching the app's existing header-access pattern");
// Instrumentation must only wrap already-issued promises, never add a new
// D1 statement of its own -- 24 env.DB.prepare(...) call sites: the
// original 21 (verified directly via the same regex on origin/feature/
// independent-cloudflare-sandbox before this task, not assumed) plus one
// legitimate new query added by the Ask feature (asks by donor, timed via
// timedAll(marks, "asks", ...) like every other phase above) plus one
// more legitimate new query added by the Monthly Payment Plan feature
// (active payment plans by donor, timed via timedAll(marks,
// "paymentPlans", ...)) plus one more legitimate new query added by
// Relationship Snapshot Architecture Stage 2 (this donor's current
// donor_relationship_facts rows, timed via timedAll(marks,
// "relationshipFacts", ...), feeding fact-level recommendation
// actionability -- see docs/AI-HANDOFF.md) -- all real, intentional
// additions, not an instrumentation leak.
assert.equal((donorPage.match(/env\.DB\.prepare\(/g) ?? []).length, 24, "the donor page must have exactly the pre-instrumentation D1 query count plus the one new asks query, the one new payment-plans query, and the one new relationship-facts query");

assert.match(appShell, /active === "import"/);
assert.match(appShell, /href="\/onboarding\/import"/);
assert.match(capturePage, /requestedParams\.returnTo === "\/"/);
assert.match(capture, /window\.location\.assign\(returnTo\)/);
assert.match(donorPage, /One chronological story/);
assert.match(donorPage, /isScheduledActivity\(item\.source, item\.occurred_at, item\.created_at\)/);
assert.match(unifiedTimeline, /scheduled/i);
assert.match(relationshipRead, /source LIKE 'capture-completed:%'/);
assert.match(relationshipRead, /source NOT LIKE 'capture-scheduled:%'.*occurred_at <= created_at/);

process.stdout.write("Today 2.0 checks passed.\n");
