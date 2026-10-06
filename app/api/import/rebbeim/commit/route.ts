import { env } from "cloudflare:workers";
import { getChatGPTUser } from "../../../../chatgpt-auth";
import { ensureUserProfile } from "../../../../../lib/auth/profile";
import { getDataMode } from "../../../../../lib/workspace/mode";
import { numericDonorCode } from "../../../../../lib/relationships/donor-identity";
import { buildRebbeimImportPreview, type RebbeimImportDonorLookup, type RebbiRecord } from "../../../../../lib/relationships/rebbeim.ts";
import type { ImportRow } from "../../../../../lib/import/recognition.ts";
import { logger } from "../../../../../lib/logger";

type DonorRow = { id: string; display_name: string; donor_code: string | null; external_id: string | null };
type RebbiRow = { id: string; display_name: string; normalized_name: string };
type ExistingPairRow = { donor_id: string; rebbi_id: string };
type Body = { rows?: ImportRow[] };

// Writes only rows that independently re-classify server-side as
// ready_to_add -- the client's own preview is never trusted as the basis
// for a write (same discipline as app/api/import/dob/commit/route.ts).
// Every write is a guarded `INSERT ... WHERE NOT EXISTS`, so even a
// duplicate row within this same submission, or a full re-submission of
// an already-committed file, is a safe no-op rather than a duplicate
// relationship or an error. Never creates a new canonical Rebbi -- an
// unrecognized name is always rejected here, exactly as it was blocked in
// preview.
export async function POST(request: Request) {
  const identity = await getChatGPTUser();
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });
  const profile = await ensureUserProfile(identity);
  const mode = await getDataMode(profile.id);
  if (mode !== "live") return Response.json({ error: "Rebbeim import is only available in your live workspace." }, { status: 422 });

  const body = await request.json().catch(() => null) as Body | null;
  if (!body?.rows || !Array.isArray(body.rows) || body.rows.length === 0) {
    return Response.json({ error: "No rows were submitted." }, { status: 422 });
  }

  const [donorRows, canonicalRows, existingPairRows] = await Promise.all([
    env.DB.prepare("SELECT id, display_name, donor_code, external_id FROM donors WHERE owner_user_id=? AND data_source='live' AND archived_at IS NULL").bind(profile.id).all<DonorRow>(),
    env.DB.prepare("SELECT id, display_name, normalized_name FROM rebbeim WHERE user_id=?").bind(profile.id).all<RebbiRow>(),
    env.DB.prepare("SELECT donor_id, rebbi_id FROM donor_rebbeim WHERE user_id=?").bind(profile.id).all<ExistingPairRow>(),
  ]);

  const donorLookup: RebbeimImportDonorLookup = new Map();
  for (const row of donorRows.results) {
    const code = numericDonorCode({ donorCode: row.donor_code, externalId: row.external_id });
    if (!code) continue;
    if (!donorLookup.has(code)) donorLookup.set(code, []);
    donorLookup.get(code)!.push({ donorId: row.id, donorName: row.display_name });
  }
  const canonical: RebbiRecord[] = canonicalRows.results.map((row) => ({ id: row.id, displayName: row.display_name, normalizedName: row.normalized_name }));
  const existingPairs = new Set(existingPairRows.results.map((row) => `${row.donor_id}\u001f${row.rebbi_id}`));

  const reclassified = buildRebbeimImportPreview(body.rows, donorLookup, canonical, existingPairs);

  const now = Math.floor(Date.now() / 1000);
  const statements = [];
  const rejected: Array<{ rowNumber: number; status: string; reason: string }> = [];
  let addedCount = 0;
  let alreadyExistsCount = 0;
  const writtenPairsThisBatch = new Set<string>();

  for (const row of reclassified) {
    if (row.status === "already_exists") { alreadyExistsCount++; continue; }
    if (row.status !== "ready_to_add") {
      rejected.push({ rowNumber: row.rowNumber, status: row.status, reason: row.issue ?? "This row is not eligible to be written." });
      continue;
    }
    const pairKey = `${row.matchedDonorId}\u001f${row.matchedRebbiId}`;
    if (writtenPairsThisBatch.has(pairKey)) continue; // duplicate row within this file, already queued once
    writtenPairsThisBatch.add(pairKey);
    statements.push(env.DB.prepare(`INSERT INTO donor_rebbeim (donor_id, rebbi_id, user_id, source, created_at)
      SELECT ?, ?, ?, 'bulk_import', ?
      WHERE NOT EXISTS (SELECT 1 FROM donor_rebbeim WHERE donor_id = ? AND rebbi_id = ?)`)
      .bind(row.matchedDonorId, row.matchedRebbiId, profile.id, now, row.matchedDonorId, row.matchedRebbiId));
    addedCount++;
  }

  if (statements.length === 0) return Response.json({ addedCount: 0, alreadyExistsCount, rejected });

  try {
    await env.DB.batch(statements);
  } catch (error) {
    logger.error("rebbeim_import_commit_failed", error, { userId: profile.id });
    return Response.json({ error: "The import could not be saved. No rows were written." }, { status: 500 });
  }
  logger.info("rebbeim_import_committed", { userId: profile.id, addedCount, alreadyExistsCount, rejectedCount: rejected.length });
  return Response.json({ addedCount, alreadyExistsCount, rejected });
}
