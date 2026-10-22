import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// AI Meeting Notes from Trip Planning -- confirmed live defect
// (2026-10-22): `summaryText` is pre-loaded from `initialSummaryText`
// (the meeting's existing saved summary, or its scheduling placeholder)
// whenever this screen is reused from a trip, so its own non-empty
// check was already true before the fundraiser did anything at all.
// Typing fresh notes directly into "Meeting notes" and saving WITHOUT
// running Organize Notes or editing the summary field silently re-saved
// the stale pre-loaded text instead of what was just typed -- confirmed
// by a real Staging save/read-back, not inferred. Structural regression
// guard: the fix (`summaryTouched`, set only by Organize Notes or a
// direct summary edit, never by the initial pre-load) must stay wired
// to every place `summaryText` can change and to the save-time choice
// between it and a freshly typed transcript.
const component = await readFile(new URL("../app/donors/[id]/meeting-notes/MeetingNotesExperience.tsx", import.meta.url), "utf8");

assert.match(component, /const \[summaryTouched, setSummaryTouched\] = useState\(false\);/, "summaryTouched must start false regardless of any pre-loaded initialSummaryText");
assert.match(component, /setSummaryTouched\(true\);\s*setSummaryText\(data\.summary\);/, "Organize Notes' own summary update must mark the field touched");
assert.match(component, /onChange=\{\(event\) => \{ setSummaryTouched\(true\); setSummaryText\(event\.target\.value\); \}\}/, "directly editing the summary field must mark it touched");
assert.match(component, /const finalSummary = summaryTouched && summaryText\.trim\(\)\.length > 0/, "save must only prefer summaryText over a freshly typed transcript once the fundraiser has actually touched it");
assert.match(component, /: transcript\.trim\(\)\.length > 0\s*\? transcript\.trim\(\)\s*: summaryText\.trim\(\);/, "an untouched (pre-loaded only) summary must fall back to a freshly typed transcript, never silently win over it");

console.log("meeting-notes-experience-summary-fallback.test.mjs: all assertions passed");
