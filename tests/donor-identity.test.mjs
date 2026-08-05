import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { donorInitials, numericDonorCode } from "../lib/relationships/donor-identity.ts";

assert.equal(donorInitials({ displayName: "Mr. & Mrs. Yaakov Pollack", primaryFirstName: "Yaakov", lastName: "Pollack" }), "YP", "a household uses its primary contact");
assert.equal(donorInitials({ displayName: "Paul & Karen Goldstein", primaryFirstName: "Paul", lastName: "Goldstein" }), "PG", "spouses do not replace the primary contact");
assert.equal(donorInitials({ displayName: "Paul & Karen Goldstein", primaryFirstName: "Karen", lastName: "Goldstein" }), "KG", "the stored primary contact remains authoritative");
assert.equal(donorInitials({ displayName: "Mr. & Mrs. Yaakov Pollack", lastName: "Pollack" }), "YP", "a household without a primary contact gets meaningful fallback initials");
assert.equal(donorInitials({ displayName: "Dr. & Mrs. Goldstein", lastName: "Goldstein" }), "G", "titles and ampersands never become initials");
assert.equal(donorInitials({ displayName: "Rabbi Ari Ben-David", primaryFirstName: "Rabbi Ari", lastName: "Ben-David" }), "AB", "titles inside imported names and hyphenated surnames are safe");
assert.equal(donorInitials({ displayName: "Friends of Ner Yisroel" }), "FY", "manual organizations have a stable household fallback");
assert.equal(donorInitials({ displayName: "Rebbetzin Éva O’Connor", primaryFirstName: "Rebbetzin Éva", lastName: "O’Connor" }), "ÉO", "Unicode names retain meaningful initials");

assert.equal(numericDonorCode({ donorCode: "JL-49026" }), "49026", "JL donors render only the numeric code");
assert.equal(numericDonorCode({ externalId: "49026", donorCode: "JL-49026" }), "49026");
assert.equal(numericDonorCode({ donorCode: null, externalId: null }), null, "manual donors leave no code or empty space");
assert.equal(numericDonorCode({ donorCode: "manual" }), null, "nonnumeric identifiers are not presented as JL codes");

const files = await Promise.all([
  "app/donors/DonorDirectoryExperience.tsx",
  "app/donors/[id]/page.tsx",
  "app/donors/[id]/meeting-brief/page.tsx",
  "app/capture/DonorAutocomplete.tsx",
  "app/capture/CaptureExperience.tsx",
  "app/page.tsx",
  "app/components/RelationshipQueueExperience.tsx",
].map(async (path) => [path, await readFile(new URL(`../${path}`, import.meta.url), "utf8")]));
for (const [path, source] of files) assert.match(source, /donor-code|donorCode/, `${path} renders the donor code when present`);
for (const path of ["app/donors/DonorDirectoryExperience.tsx", "app/donors/[id]/page.tsx", "app/donors/[id]/meeting-brief/page.tsx", "app/capture/DonorAutocomplete.tsx", "app/capture/CaptureExperience.tsx"]) {
  assert.match(files.find(([name]) => name === path)[1], /donorInitials/, `${path} uses the shared avatar logic`);
}

process.stdout.write("Donor identity polish checks passed.\n");
