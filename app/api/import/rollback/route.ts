import { env } from "cloudflare:workers";
import { getChatGPTUser } from "../../../chatgpt-auth";
import { logger } from "../../../../lib/logger";
import { ensureUserProfile } from "../../../../lib/auth/profile";

type Change = { source_fingerprint: string; change_type: "insert" | "update"; previous_json: string | null };

export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return Response.json({ error: "Authentication required" }, { status: 401 });
  const body = await request.json().catch(() => ({})) as { importId?: string };
  const importId = body.importId?.trim() ?? "";
  if (!importId) return Response.json({ error: "Import ID is required" }, { status: 422 });
  const userId = (await ensureUserProfile(user)).id;
  const dataImport = await env.DB.prepare("SELECT id, status, report_json FROM data_imports WHERE id = ? AND user_id = ? LIMIT 1").bind(importId, userId).first<{ id: string; status: string; report_json: string }>();
  if (!dataImport) return Response.json({ error: "Import not found" }, { status: 404 });
  if (dataImport.status !== "completed") return Response.json({ error: "This import cannot be rolled back" }, { status: 409 });
  let report: { profile?: string } = {};
  try { report = JSON.parse(dataImport.report_json); } catch { /* invalid reports are rejected below */ }
  if (report.profile !== "JL Solutions Donations") return Response.json({ error: "Only JL donation imports can be rolled back here" }, { status: 422 });
  const changes = await env.DB.prepare("SELECT source_fingerprint, change_type, previous_json FROM giving_activity_import_changes WHERE import_id = ?").bind(importId).all<Change>();
  const inserted = changes.results.filter((change) => change.change_type === "insert").map((change) => change.source_fingerprint);
  const updated = changes.results.filter((change) => change.change_type === "update" && change.previous_json).map((change) => ({ fingerprint: change.source_fingerprint, ...JSON.parse(change.previous_json!) }));
  const now = Math.floor(Date.now() / 1000);
  const statements = [
    env.DB.prepare("DELETE FROM giving_activities WHERE owner_user_id = ? AND external_source = 'JL Solutions' AND source_fingerprint IN (SELECT value FROM json_each(?))").bind(userId, JSON.stringify(inserted)),
    env.DB.prepare(`UPDATE giving_activities SET paid_cents=(SELECT json_extract(value,'$.paid_cents') FROM json_each(?) WHERE json_extract(value,'$.fingerprint')=source_fingerprint), balance_cents=(SELECT json_extract(value,'$.balance_cents') FROM json_each(?) WHERE json_extract(value,'$.fingerprint')=source_fingerprint), category=(SELECT json_extract(value,'$.category') FROM json_each(?) WHERE json_extract(value,'$.fingerprint')=source_fingerprint), source_snapshot=(SELECT json_extract(value,'$.source_snapshot') FROM json_each(?) WHERE json_extract(value,'$.fingerprint')=source_fingerprint), updated_at=? WHERE owner_user_id = ? AND source_fingerprint IN (SELECT json_extract(value,'$.fingerprint') FROM json_each(?))`).bind(JSON.stringify(updated), JSON.stringify(updated), JSON.stringify(updated), JSON.stringify(updated), now, userId, JSON.stringify(updated)),
    env.DB.prepare("DELETE FROM jl_payment_assignments WHERE user_id = ? AND applied_import_id = ?").bind(userId, importId),
    env.DB.prepare("UPDATE data_imports SET status = 'rolled_back' WHERE id = ? AND user_id = ?").bind(importId, userId),
  ];
  try {
    await env.DB.batch(statements);
    logger.info("jl_donation_import_rolled_back", { importId, userId, inserted: inserted.length, updated: updated.length });
    return Response.json({ importId, status: "rolled_back", removedActivities: inserted.length, restoredPledges: updated.length });
  } catch {
    logger.error("jl_donation_rollback_failed", new Error("Database transaction failed"), { importId, userId });
    return Response.json({ error: "Rollback failed and no partial rollback was kept" }, { status: 500 });
  }
}
