import { env } from "cloudflare:workers";
import { getChatGPTUser } from "../../../chatgpt-auth";
import { BUSINESS_DATA_COUNT_SQL, PRODUCTION_BASELINE_HASH } from "../../../../lib/data-health/production-baseline";
import { buildSchemaOnlyBackup } from "../../../../lib/operations/schema-backup";

export const dynamic = "force-dynamic";

type QueryResult = { results?: Array<Record<string, unknown>> };

export async function GET() {
  const identity = await getChatGPTUser();
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });
  if (__FUNDRAISING_OS_ENVIRONMENT__ !== "production") return Response.json({ error: "Schema-only production backup is unavailable in staging" }, { status: 409 });

  try {
    const [schema, marker, businessData] = await Promise.all([
      env.DB.prepare("SELECT name,type,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL ORDER BY type,name").all() as Promise<QueryResult>,
      env.DB.prepare("SELECT schema_hash,created_at FROM production_schema_baseline WHERE id = '0019'").first<{ schema_hash?: string; created_at?: number }>(),
      env.DB.prepare(BUSINESS_DATA_COUNT_SQL).first<{ count?: number }>(),
    ]);
    if (Number(businessData?.count ?? -1) !== 0) {
      return Response.json({ error: "Schema-only backup blocked because business data exists. Use the authenticated workspace backup instead." }, { status: 409 });
    }
    const payload = buildSchemaOnlyBackup(schema.results ?? [], marker);
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload));
    const checksum = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
    return new Response(payload, {
      headers: {
        "content-type": "application/sql; charset=utf-8",
        "content-disposition": `attachment; filename="fundraising-os-production-schema-${stamp}.sql"`,
        "cache-control": "no-store",
        "x-fundraising-os-schema": "0019",
        "x-fundraising-os-schema-hash": PRODUCTION_BASELINE_HASH,
        "x-backup-sha256": checksum,
      },
    });
  } catch {
    return Response.json({ error: "Production schema backup could not be created" }, { status: 500 });
  }
}
