import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  donorBackLabel,
  donorDirectoryReturnPath,
  donorNavigationHref,
  meetingBriefNavigationHref,
  safeDonorOrigin,
  safeInternalReturnPath,
} from "../lib/navigation/donor-navigation.ts";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("donor return context preserves search, filters, sort, and safe origins", () => {
  const returnTo = donorDirectoryReturnPath({ q: "Goldstein", filter: "manual", sort: "last-name", cursor: "40" });
  assert.equal(returnTo, "/donors?q=Goldstein&filter=manual&sort=last-name&cursor=40");
  const href = donorNavigationHref("donor/one", returnTo, "search");
  assert.match(href, /^\/donors\/donor%2Fone\?/);
  assert.equal(new URL(href, "https://example.test").searchParams.get("from"), returnTo);
  assert.equal(new URL(href, "https://example.test").searchParams.get("origin"), "search");
  assert.equal(donorBackLabel("search"), "Back to Donors");
  assert.equal(safeDonorOrigin(undefined, returnTo), "search");
});

test("donor navigation supports Today, queue, meeting brief, and timeline origins", () => {
  assert.equal(donorBackLabel("today"), "Back to Today");
  assert.equal(donorBackLabel("queue"), "Back to Today");
  assert.equal(donorBackLabel("meeting-brief"), "Back to Meeting Brief");
  assert.equal(donorBackLabel("timeline"), "Back to Timeline");
  const brief = meetingBriefNavigationHref("abc", "/?priorities=all#relationship-queue", "queue");
  assert.equal(new URL(brief, "https://example.test").searchParams.get("from"), "/?priorities=all#relationship-queue");
});

test("unsafe or stale return locations fall back without creating an open redirect", () => {
  assert.equal(safeInternalReturnPath("https://evil.example/path"), "/donors");
  assert.equal(safeInternalReturnPath("//evil.example/path"), "/donors");
  assert.equal(safeInternalReturnPath("/api/private"), "/donors");
  assert.equal(safeInternalReturnPath("/%E0%A4%A"), "/%E0%A4%A");
  assert.equal(safeDonorOrigin("invented", "/"), "today");
});

test("donor page exposes understandable breadcrumbs, Home, resilient Back, and merged-record context", async () => {
  const [page, controls] = await Promise.all([read("app/donors/[id]/page.tsx"), read("app/components/DonorNavigation.tsx")]);
  assert.match(page, /Workspace<\/a><span>\/</);
  assert.match(page, /<strong>\{donor\.display_name\}<\/strong>/);
  assert.match(page, /DonorBackNavigation/);
  assert.match(page, /redirect\(donorNavigationHref\(donor\.merged_into_donor_id, returnTo, origin\)\)/);
  assert.match(controls, /← \{label\}/);
  assert.match(controls, /aria-label="Today's Workspace"/);
  assert.match(controls, /window\.history\.back\(\)/);
  assert.match(controls, /sessionStorage\.setItem/);
  assert.match(controls, /window\.scrollTo/);
  assert.match(controls, /MAX_AGE_MS/);
});

test("all current donor-entry surfaces carry their origin", async () => {
  const [directory, directoryExperience, search, today, queue, brief] = await Promise.all([
    read("app/donors/page.tsx"),
    read("app/donors/DonorDirectoryExperience.tsx"),
    read("app/donors/DonorDirectorySearch.tsx"),
    read("app/page.tsx"),
    read("app/components/RelationshipQueueExperience.tsx"),
    read("app/donors/[id]/meeting-brief/page.tsx"),
  ]);
  assert.match(directoryExperience, /DonorOriginLink/);
  assert.match(directory, /donorDirectoryReturnPath/);
  assert.match(search, /rememberDonorOrigin/);
  assert.match(search, /history\.replaceState/);
  assert.match(today, /"today"/);
  assert.match(queue, /queueReturnTo/);
  assert.match(queue, /"queue"/);
  assert.match(brief, /"meeting-brief"/);
});
