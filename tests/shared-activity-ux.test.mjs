import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// Phase 2 UX for shared multi-donor activities. This codebase's UI layer has
// no component-rendering test harness (see tests/activity-editing.test.mjs
// and tests/capture.test.mjs for the established convention this file
// follows): behavior is verified by reading the real, committed source and
// asserting the exact code paths exist, not by mounting components.

const captureExperience = await readFile(new URL("../app/capture/CaptureExperience.tsx", import.meta.url), "utf8");
const recipientPicker = await readFile(new URL("../app/capture/RecipientPicker.tsx", import.meta.url), "utf8");
const sharedRoute = await readFile(new URL("../app/api/interactions/shared/route.ts", import.meta.url), "utf8");
const sharedIdRoute = await readFile(new URL("../app/api/interactions/shared/[id]/route.ts", import.meta.url), "utf8");
const timelineExperience = await readFile(new URL("../app/donors/[id]/UnifiedRelationshipTimeline.tsx", import.meta.url), "utf8");
const sharedActivityActions = await readFile(new URL("../app/components/SharedActivityActions.tsx", import.meta.url), "utf8");
const meetingBriefPage = await readFile(new URL("../app/donors/[id]/meeting-brief/page.tsx", import.meta.url), "utf8");
const globalsCss = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

// 1. Single-donor interaction form remains unchanged: the original save
// call, its route selection (POST vs PATCH), and its request body are byte-
// for-byte present, and single-donor is still the default mode.
assert.match(captureExperience, /const \[entryMode, setEntryMode\] = useState<"single" \| "multiple">\("single"\)/, "single donor must remain the default entry mode");
assert.match(captureExperience, /method: initialActivity \? "PATCH" : "POST"/, "the existing single-donor create\/edit routing must be untouched");
assert.match(captureExperience, /fetch\(initialActivity \? `\/api\/interactions\/\$\{encodeURIComponent\(initialActivity\.id\)\}` : "\/api\/interactions"/, "single-donor save must still hit the original route");
// The flag itself is now gated on the CURRENT preview actually having
// something meaningful (see the mobile-ux-fixes/relationship-quality
// tests), not just a bare pass-through -- everything else about the
// single-donor request body is unchanged (the Ask feature's fields are
// appended after it, additive only -- see tests/asks.test.mjs).
assert.match(captureExperience, /acceptRelationshipSnapshot: acceptRelationshipSnapshot && preview\.relationshipSummary !== null,/, "the single-donor request body must still send the relationship-snapshot flag, now correctly gated on the current preview");

// 2. Multi-donor recipient flow submits the shared route only for 2+ donors.
assert.match(sharedRoute, /donorIds\.length < 2\)\s*return Response\.json\(\{ error: "A shared activity needs at least two donors/, "the backend itself refuses fewer than 2 donors");
assert.match(captureExperience, /const sharedReady = recipientIds\.length >= 2 && sharedSummary\.trim\(\)\.length >= 4 && sharedValidDate;/, "the UI must gate save on at least 2 selected donors");
assert.match(captureExperience, /fetch\("\/api\/interactions\/shared", \{/, "multi-donor save must POST to the shared route");
assert.match(captureExperience, /donorIds: recipientIds,/, "the shared-route request body must carry every selected donor id");

// 3. Multi-donor participant flow submits the correct role.
assert.match(captureExperience, /role,\s*\n\s*summary: sharedSummary,/, "role must be included in the shared-activity request body");
assert.match(captureExperience, /const role = roleOverride \?\? ROLE_DEFAULT_BY_KIND\[sharedKind\];/, "role must be explicit (defaulted, but always a real value), never omitted");
assert.match(captureExperience, /setRoleOverride\("participant"\)/, "the UI must let the fundraiser choose participant explicitly");
assert.match(captureExperience, /setRoleOverride\("recipient"\)/, "the UI must let the fundraiser choose recipient explicitly");

// 4. Duplicate donors cannot be selected -- enforced on both the client
// (RecipientPicker only ever adds an id once, via a Set-backed toggle) and
// the server (the shared route rejects a body containing a duplicate).
assert.match(recipientPicker, /const selectedSet = useMemo\(\(\) => new Set\(selectedIds\)/, "the picker must track selection with a Set, structurally preventing duplicates");
assert.match(recipientPicker, /if \(selectedSet\.has\(donorId\)\) \{\s*onChange\(selectedIds\.filter/, "toggling an already-selected donor must remove, never duplicate, them");
assert.match(sharedRoute, /new Set\(donorIds\)\.size !== donorIds\.length\) return Response\.json\(\{ error: "Duplicate donor in recipient list"/, "the backend must reject a duplicate donor id even if the client somehow sent one");

// 5. Recipient count matches selected donors.
assert.match(sharedRoute, /recipientCount: donorIds\.length,/, "the published recipientCount must equal the actual number of donor ids submitted");
assert.match(recipientPicker, /\$\{selectedIds\.length\} selected/, "the picker must always show the live selected count");

// 6. Large-selection confirmation appears above the UX threshold, and never
// blocks the save outright (confirming proceeds with the real count).
assert.match(captureExperience, /const LARGE_SELECTION_CONFIRM_THRESHOLD = 15;/);
assert.match(captureExperience, /if \(recipientIds\.length >= LARGE_SELECTION_CONFIRM_THRESHOLD && !confirmedLarge\) \{\s*setShowLargeConfirm\(true\);\s*return;/, "reaching the threshold must show a confirmation instead of saving immediately");
assert.match(captureExperience, /You're about to log this touchpoint for \{recipientIds\.length\} donors\. Continue\?/, "the confirmation copy must match the approved example wording");
assert.match(captureExperience, /onClick=\{\(\) => saveSharedActivity\(true\)\}/, "confirming must proceed with the save, not block it");

// 7. The 200-recipient backend cap is mirrored, not duplicated as a
// different number, in the UI.
assert.match(sharedRoute, /const MAX_RECIPIENTS = 200;/);
assert.match(captureExperience, /const MAX_SHARED_RECIPIENTS = 200;/, "the UI cap must match the backend cap exactly");
assert.match(captureExperience, /maxRecipients=\{MAX_SHARED_RECIPIENTS\}/, "the picker must actually receive the cap, not just define it unused");
assert.match(recipientPicker, /disabled=\{!checked && atCap\}/, "once at the cap, unselected results must become unselectable rather than silently over-adding");

// 8. Mobile-safe structure: results render inline (not an absolutely-
// positioned floating dropdown), chips wrap instead of overflowing
// horizontally, and narrow-viewport rules exist for the picker/role/confirm UI.
assert.doesNotMatch(recipientPicker, /position:\s*absolute/, "the recipient picker must not use an absolutely-positioned dropdown");
assert.match(globalsCss, /\.recipient-picker-chips \{ display:flex; flex-wrap:wrap;/, "selected-donor chips must wrap, never scroll horizontally");
assert.match(globalsCss, /@media \(max-width:760px\) \{\s*\.recipient-picker-results/, "the picker must have a defined narrow-viewport layout");
assert.match(globalsCss, /\.role-picker-options \{ flex-direction:column; \}/, "the role picker must stack on narrow viewports rather than staying side-by-side");

// 9. Removing one recipient never deletes the whole activity -- only that
// donor's own interactions row is touched; shared_activities itself (and its
// deleted_at) is never written by this branch.
{
  const start = sharedIdRoute.indexOf('if (body?.action === "remove-recipient")');
  const end = sharedIdRoute.indexOf('if (body?.action === "delete-activity")');
  assert.ok(start !== -1 && end !== -1 && start < end, "both branches must exist in the expected order");
  const removeBranch = sharedIdRoute.slice(start, end);
  assert.match(removeBranch, /WHERE id = \? AND user_id = \?"\)\.bind\(`cancelled:\$\{link\.source\}`, now, link\.id, profile\.id\)/, "remove-recipient must cancel exactly the one linked interaction row, addressed by its own id");
  assert.doesNotMatch(removeBranch, /deleted_at/, "remove-recipient must never touch shared_activities.deleted_at");
  assert.match(removeBranch, /recipient_count = MAX\(0, recipient_count - 1\)/, "the recipient count must be decremented, not the whole activity removed");
  assert.match(removeBranch, /'removed'/, "removing a recipient must be recorded in the recipient-audit trail");
}

// 10. Deleting the whole activity affects every still-linked donor through
// the shared_activity_id, and marks the parent deleted -- via the intended
// delete-activity branch, distinct from remove-recipient.
{
  const start = sharedIdRoute.indexOf('if (body?.action === "delete-activity")');
  assert.ok(start !== -1);
  const deleteBranch = sharedIdRoute.slice(start);
  assert.match(deleteBranch, /WHERE shared_activity_id = \? AND user_id = \? AND source NOT LIKE 'cancelled:%' AND source NOT LIKE 'archived:%'/, "delete-activity must select every still-active row linked to this activity, not one donor");
  assert.match(deleteBranch, /links\.results\.map\(\(link\) => env\.DB\.prepare\("UPDATE interactions SET source = \?, updated_at = \? WHERE id = \? AND user_id = \?"\)/, "every linked row must be cancelled");
  assert.match(deleteBranch, /UPDATE shared_activities SET deleted_at = \?, updated_at = \? WHERE id = \? AND user_id = \?/, "the parent shared_activities row must be marked deleted");
}
assert.match(sharedActivityActions, /Remove this donor from the shared activity\? Other linked donors and the activity itself are not affected\./, "the remove-one confirmation must explicitly state other donors are unaffected");
assert.match(sharedActivityActions, /Delete this shared activity entirely\? This removes it from every linked donor's timeline, not just this one\./, "the delete-whole confirmation must explicitly warn it affects every donor");
assert.match(sharedActivityActions, /className="danger-button"/, "delete-whole-activity must be visually distinguished from remove-one-donor, not just worded differently");

// 11. The canonical shared summary (edited once, on the parent) is what
// every linked donor's surfaces actually display -- timeline, Meeting Brief,
// and Assistant all prefer it over the per-row copy.
assert.match(timelineExperience, /splitInteractionSummary\(activity\.shared_activity_summary \?\? activity\.summary\)/);
const meetingBrief = await readFile(new URL("../lib/relationships/meeting-brief.ts", import.meta.url), "utf8");
assert.match(meetingBrief, /summary: item\.shared_activity_summary \?\? item\.summary,/);
const assistantRoute = await readFile(new URL("../app/api/assistant/route.ts", import.meta.url), "utf8");
assert.match(assistantRoute, /latest\.shared_activity_summary \?\? latest\.summary/);

// 12. Recipient timeline copy shows a count, never an enumerated recipient
// list, on the donor timeline or the Meeting Brief card.
assert.match(timelineExperience, /activity\.role === "recipient" \? `Sent to \$\{activity\.shared_activity_recipient_count\} donors`/);
assert.doesNotMatch(timelineExperience, /sharedActivityLabel[\s\S]{0,400}\.map\(/, "the timeline must never map over individual recipients inline");
assert.match(meetingBriefPage, /brief\.lastMeaningfulContact\.role === "recipient" \? `Sent to \$\{brief\.lastMeaningfulContact\.recipientCount\} donors`/);

// 13. Participant timeline copy remains useful (a real count, not just a
// generic "shared" label) on both surfaces.
assert.match(timelineExperience, /: `\$\{activity\.shared_activity_recipient_count\} participants`/);
assert.match(meetingBriefPage, /: `\$\{brief\.lastMeaningfulContact\.recipientCount\} participants`/);

// 14. Meeting Brief rendered output actually reads role/recipientCount from
// the loaded brief, not just the data layer carrying fields nobody displays.
assert.match(meetingBriefPage, /brief\.lastMeaningfulContact\?\.sharedActivityId && brief\.lastMeaningfulContact\.recipientCount/);

// 15. No automatic recommendation/reminder creation anywhere in the shared-
// activity routes -- bulk logging, editing, removing a recipient, and
// deleting the whole activity must never touch the recommendations table.
for (const [label, source] of [["POST /api/interactions/shared", sharedRoute], ["PATCH/DELETE /api/interactions/shared/[id]", sharedIdRoute]]) {
  assert.doesNotMatch(source, /recommendations/i, `${label} must never reference the recommendations table`);
}
assert.match(captureExperience, /No reminder is created automatically for any recipient/, "the UI itself must state this explicitly, not just the backend silently doing it");

process.stdout.write("Shared multi-donor activity UX checks passed.\n");
