import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  donorBackLabel,
  donorDirectoryFilterPath,
  donorDirectoryReturnPath,
  donorDirectorySearchPath,
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

test("Geographic Filtering for Travel Planning: region/city filter paths round-trip through return-path navigation", () => {
  // Sets both, independently of the free-text search's own `q` param.
  const withBoth = donorDirectoryFilterPath("/donors", { region: "chicago-suburbs", city: "chicago::il" });
  const parsedBoth = new URL(withBoth, "https://example.test");
  assert.equal(parsedBoth.searchParams.get("region"), "chicago-suburbs");
  assert.equal(parsedBoth.searchParams.get("city"), "chicago::il");

  // "all" (or omitting the key) is never written to the URL -- the
  // plain, unfiltered "/donors" stays the common case.
  assert.equal(donorDirectoryFilterPath("/donors", { region: "all" }), "/donors");
  assert.equal(donorDirectoryFilterPath("/donors?region=chicago-suburbs", { region: "all" }), "/donors");

  // Composes with an existing `q` search param without clobbering it --
  // donorDirectoryReturnPath already preserves every param generically,
  // so this proves the round-trip end to end: search + region + city
  // all survive together.
  const combined = donorDirectoryFilterPath(donorDirectorySearchPath("/donors", "Goldstein"), { region: "chicago-suburbs", city: "all" });
  const parsedCombined = new URL(combined, "https://example.test");
  assert.equal(parsedCombined.searchParams.get("q"), "Goldstein");
  assert.equal(parsedCombined.searchParams.get("region"), "chicago-suburbs");
  assert.equal(parsedCombined.searchParams.get("city"), null, "city 'all' must not appear in the URL");
  const returnTo = donorDirectoryReturnPath(Object.fromEntries(parsedCombined.searchParams));
  assert.equal(returnTo, "/donors?q=Goldstein&region=chicago-suburbs", "donorDirectoryReturnPath already preserves region/city generically, with no change needed to that function");

  // Updating only `city` leaves a previously-set `region` untouched.
  const cityOnly = donorDirectoryFilterPath("/donors?region=chicago-suburbs", { city: "chicago::il" });
  assert.equal(new URL(cityOnly, "https://example.test").searchParams.get("region"), "chicago-suburbs");
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
  assert.match(search, /history\.replaceState/);
  assert.match(today, /"today"/);
  assert.match(queue, /queueReturnTo/);
  assert.match(queue, /"queue"/);
  assert.match(brief, /"meeting-brief"/);
});

test("Geographic Filtering for Travel Planning: directory wiring present, filters compose with existing search, no write path introduced", async () => {
  const [directoryPage, directoryExperience, directorySearch, travelRegions, geoFilter] = await Promise.all([
    read("app/donors/page.tsx"),
    read("app/donors/DonorDirectoryExperience.tsx"),
    read("app/donors/DonorDirectorySearch.tsx"),
    read("lib/relationships/travel-regions.ts"),
    read("lib/relationships/donor-geo-filter.ts"),
  ]);

  // The directory page reads region/city from the URL and passes them
  // through, sanitizing an unknown region id rather than trusting it.
  assert.match(directoryPage, /travelRegionById/);
  assert.match(directoryPage, /initialRegion/);
  assert.match(directoryPage, /initialCity/);

  // The directory experience composes the geo filters with the SAME
  // already-filtered (by search) array, rather than filtering the full
  // roster independently and risking the two falling out of sync.
  assert.match(directoryExperience, /filterByGeo\(searched/);
  assert.match(directoryExperience, /cityOptionsForRegion\(relationships, regionId\)/);
  assert.match(directoryExperience, /<select/);

  // The accurate-count requirement: the search component's count line
  // depends on `filtering` (search OR region OR city), not on the
  // search query alone -- otherwise a region/city-only filter would
  // silently show the unfiltered total.
  assert.match(directorySearch, /filtering \? `\$\{resultCount\} of \$\{totalCount\}/);

  // No Production write path was introduced by this feature: the two
  // new, pure logic modules never reference D1 (`env.DB`) or a SQL
  // write verb at all -- they only ever read donor `city`/`state`
  // already fetched elsewhere.
  for (const source of [travelRegions, geoFilter]) {
    assert.doesNotMatch(source, /env\.DB/);
    assert.doesNotMatch(source, /\b(INSERT|UPDATE|DELETE)\b/i);
  }
  // The directory page's own SQL remains exactly one SELECT -- this
  // feature added a read (region/city from the URL), never a write.
  assert.doesNotMatch(directoryPage, /\b(INSERT|UPDATE|DELETE)\b/i);
});
