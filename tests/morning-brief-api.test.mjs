import assert from "node:assert/strict";
import fs from "node:fs";
import { buildMorningBriefResponse } from "../lib/workspace/morning-brief-api.ts";

// GET /api/morning-brief (2026-10-08, see docs/AI-HANDOFF.md's "Morning
// Brief API" entry) -- a plain-JSON endpoint for trusted automation (a
// Cloudflare Access Service Token) that cannot complete an interactive
// browser login. buildMorningBriefResponse() is the pure reshaping
// function the route calls; this is unit-tested directly against a
// synthetic WorkspaceBrief fixture, same convention as every other pure
// function in this codebase. Route wiring (auth-first, reuses
// loadWorkspaceBrief, no second computation) is checked structurally
// below, matching this repo's established "no D1/env test harness for
// routes" pattern (e.g. tests/pledge-payment-plan.test.mjs's own route
// checks).

function fixtureBrief(overrides = {}) {
  return {
    overview: "You have 2 priorities today.",
    recommendation: "Focus on the Weil follow-up first.",
    priorities: [
      { queueId: "q1", donorId: "donor-1", name: "Mr. & Mrs. Benjy Weil", initials: "BW", donorCode: "78188", label: "Follow up", signal: "warm", reason: "Pledge balance $20 remaining", why: "Payment plan ending soon", action: "Call to confirm the final payment", href: "/donors/donor-1", dueAt: null, dueLabel: "", bucket: "today" },
    ],
    priorityCount: 1,
    relationshipQueue: { today: [], upcoming: [], later: [] },
    morningBrief: { meetingsToday: 0, overdueFollowUps: 0, recentGifts: 1, upcomingReminders: 0, suggestedPriority: null },
    recentlyViewed: [],
    recentlyUpdated: [],
    todaySchedule: [{ id: "a1", donorId: "donor-2", type: "call", typeLabel: "Call", time: "10:00", period: "AM", date: "Oct 9", donorName: "Mr. Avi Dear", donorCode: "67974", initials: "AD", subject: "Check in on pledge", note: "", prepareHref: null, openHref: "/donors/donor-2", editHref: "/interactions/a1/edit", logOutcomeHref: null, canCancel: true }],
    upcomingActivities: [{ id: "a2", donorId: "donor-3", type: "meeting", typeLabel: "Meeting", time: "2:00", period: "PM", date: "Oct 12", donorName: "Mr. & Mrs. Mordechai Y Goldman", donorCode: "68418", initials: "MG", subject: "Annual review", note: "Bring updated pledge summary", prepareHref: "/donors/donor-3", openHref: "/donors/donor-3", editHref: "/interactions/a2/edit", logOutcomeHref: null, canCancel: false }],
    meetings: [],
    gifts: [{ id: "g1", donorId: "donor-4", name: "Mr. & Mrs. Shmuel Luxenburg", initials: "SL", donorCode: "4930", amount: "$200.00", detail: "Gift · Sep 24, 2026", activityDate: 1790208000 }],
    todayRelationshipDates: [],
    upcomingRelationshipDates: [],
    generatedAt: 1791471717,
    ...overrides,
  };
}

function run() {
  // --- Full shape, every field traceable to the real WorkspaceBrief input. ---
  {
    const result = buildMorningBriefResponse(fixtureBrief());
    assert.equal(result.generatedAt, new Date(1791471717 * 1000).toISOString());
    assert.equal(result.overview, "You have 2 priorities today.");
    assert.equal(result.recommendedFocus, "Focus on the Weil follow-up first.");

    assert.deepEqual(result.priorities, [{ donorId: "donor-1", donorName: "Mr. & Mrs. Benjy Weil", donorCode: "78188", reason: "Pledge balance $20 remaining", why: "Payment plan ending soon", recommendedAction: "Call to confirm the final payment" }]);

    assert.deepEqual(result.todaySchedule, [{ id: "a1", donorId: "donor-2", donorName: "Mr. Avi Dear", donorCode: "67974", type: "call", typeLabel: "Call", date: "Oct 9", time: "10:00", period: "AM", subject: "Check in on pledge", note: "" }]);
    assert.deepEqual(result.upcomingActivities, [{ id: "a2", donorId: "donor-3", donorName: "Mr. & Mrs. Mordechai Y Goldman", donorCode: "68418", type: "meeting", typeLabel: "Meeting", date: "Oct 12", time: "2:00", period: "PM", subject: "Annual review", note: "Bring updated pledge summary" }]);
    // Never leaks UI-only navigation fields (prepareHref/openHref/
    // editHref/logOutcomeHref/canCancel) -- meaningless outside a browser.
    assert.ok(!("prepareHref" in result.todaySchedule[0]));
    assert.ok(!("canCancel" in result.upcomingActivities[0]));

    assert.deepEqual(result.recentGifts, [{ donorId: "donor-4", donorName: "Mr. & Mrs. Shmuel Luxenburg", donorCode: "4930", amount: "$200.00", date: new Date(1790208000 * 1000).toISOString() }]);
  }

  // --- A gift with no activityDate (legacy/never-set data) must report
  // `date: null`, never throw or invent a date. ---
  {
    const result = buildMorningBriefResponse(fixtureBrief({ gifts: [{ id: "g2", donorId: "donor-5", name: "Test Donor", initials: "TD", donorCode: null, amount: "$50.00", detail: "Gift", activityDate: null }] }));
    assert.deepEqual(result.recentGifts, [{ donorId: "donor-5", donorName: "Test Donor", donorCode: null, amount: "$50.00", date: null }]);
  }

  // --- Empty brief -- every array stays an empty array, never omitted or null. ---
  {
    const result = buildMorningBriefResponse(fixtureBrief({ priorities: [], todaySchedule: [], upcomingActivities: [], gifts: [] }));
    assert.deepEqual(result.priorities, []);
    assert.deepEqual(result.todaySchedule, []);
    assert.deepEqual(result.upcomingActivities, []);
    assert.deepEqual(result.recentGifts, []);
  }

  // --- Route wiring: auth-first, reuses the one shared loadWorkspaceBrief
  // (never a second/parallel brief computation), reshapes via
  // buildMorningBriefResponse (never inlines its own field mapping). ---
  {
    const routeSource = fs.readFileSync(new URL("../app/api/morning-brief/route.ts", import.meta.url), "utf8");
    assert.match(routeSource, /const identity = await getChatGPTUser\(\)/, "must authenticate via the shared getChatGPTUser(), never its own auth logic");
    assert.match(routeSource, /if \(!identity\) return Response\.json\(\{ error: "Authentication required" \}, \{ status: 401 \}\)/, "unauthenticated requests must get a clean 401, never a redirect (this is an API route, not a page)");
    assert.match(routeSource, /loadWorkspaceBrief\(/, "must reuse the one shared brief loader, never a second/parallel query path");
    assert.match(routeSource, /buildMorningBriefResponse\(brief\)/, "must reshape via the pure, unit-tested function, never inline its own field mapping in the route");
    assert.doesNotMatch(routeSource, /env\.DB\.prepare/, "must never query D1 directly -- all data comes through loadWorkspaceBrief");
  }

  console.log("morning-brief-api: ok");
}

run();
