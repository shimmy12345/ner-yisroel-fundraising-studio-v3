import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DONOR_GIVING_SQL, visibleGivingForDonor } from "../lib/relationships/giving.ts";

const rows = [
  { id: "gift-a", donorId: "donor-a", ownerUserId: "owner-1", recordOrigin: "live" },
  { id: "gift-b", donorId: "donor-b", ownerUserId: "owner-1", recordOrigin: "live" },
  { id: "gift-other-owner", donorId: "donor-a", ownerUserId: "owner-2", recordOrigin: "live" },
  { id: "gift-verification", donorId: "donor-a", ownerUserId: "owner-1", recordOrigin: "verification" },
];

assert.deepEqual(visibleGivingForDonor(rows, "donor-a", "owner-1").map((row) => row.id), ["gift-a"]);
assert.match(DONOR_GIVING_SQL, /donor_id = \?/);
assert.match(DONOR_GIVING_SQL, /owner_user_id = \?/);
assert.match(DONOR_GIVING_SQL, /record_origin = 'live'/);

const donorPage = await readFile(new URL("../app/donors/[id]/page.tsx", import.meta.url), "utf8");
const liveData = await readFile(new URL("../lib/workspace/live-data.ts", import.meta.url), "utf8");
const cleanup = await readFile(new URL("../app/api/verification-data/route.ts", import.meta.url), "utf8");
const migration = await readFile(new URL("../drizzle/0005_verification_data_integrity.sql", import.meta.url), "utf8");
assert.match(donorPage, /DONOR_GIVING_SQL/);
assert.match(liveData, /record_origin = 'live'/);
assert.match(cleanup, /record_origin = 'verification'/);
assert.match(cleanup, /CODEX-VERIFY-49db8e2/);
assert.match(cleanup, /mode: "preview"/);
assert.match(cleanup, /backupConfirmed/);
assert.match(cleanup, /await env\.DB\.batch/);
assert.doesNotMatch(cleanup, /description LIKE|Verification activity/);
assert.match(migration, /source_campaign` = 'CODEX-VERIFY-49db8e2'/);

process.stdout.write("Giving integrity checks passed.\n");
