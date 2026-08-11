import { env } from "cloudflare:workers";
import { getChatGPTUser } from "../../../chatgpt-auth";
import { ensureUserProfile } from "../../../../lib/auth/profile";
import { getDataMode } from "../../../../lib/workspace/mode";
import { extractDomain, normalizeUrl } from "../../../../lib/research/url-normalize";
import { normalizeOrganizationName, planFinding, planSharedAffiliations, type ExistingActiveFinding } from "../../../../lib/research/pipeline";
import { classifyEvidenceCategory } from "../../../../lib/research/classification";
import { SOURCE_TIERS, type SourceTier } from "../../../../lib/research/types";
import { logger } from "../../../../lib/logger";

// Donor Research Stage A. Provider-agnostic, manual-entry only -- no
// outbound fetch, no search-provider API key, anywhere in this file. Every
// piece of evidence is exactly what the fundraiser typed in. Evidence
// stays in donor_research_pending_evidence (never donor_research_sources)
// until identity is explicitly confirmed -- see decideIdentity() below --
// so a misidentified donor's evidence can never reach the shared,
// dedupe-able, shared-affiliation-eligible evidence pool.

type Body = { action?: string; runId?: string; url?: string; title?: string; snippet?: string; publishedAt?: string; candidateId?: string; decision?: string; evidence?: Array<{ pendingEvidenceId?: string; sourceTier?: string; organization?: string }> };
type PendingEvidenceRow = { id: string; url: string; title: string; snippet: string | null; published_at: number | null };

async function ownedLiveDonor(donorId: string, userId: string) {
  const mode = await getDataMode(userId);
  if (mode !== "live") return null;
  return env.DB.prepare("SELECT id, display_name FROM donors WHERE id=? AND owner_user_id=? AND data_source='live' AND archived_at IS NULL LIMIT 1").bind(donorId, userId).first<{ id: string; display_name: string }>();
}

async function openRun(runId: string, donorId: string, userId: string) {
  return env.DB.prepare("SELECT id, status FROM donor_research_runs WHERE id=? AND donor_id=? AND user_id=? AND status='open' LIMIT 1").bind(runId, donorId, userId).first<{ id: string; status: string }>();
}

async function addEvidence(donorId: string, userId: string, body: Body) {
  const url = body.url?.trim() ?? "";
  const title = body.title?.trim() ?? "";
  if (!url || !title) return Response.json({ error: "A URL and a title are required." }, { status: 422 });
  let parsed: URL;
  try { parsed = new URL(url); } catch { return Response.json({ error: "Enter a valid URL, including https://." }, { status: 422 }); }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return Response.json({ error: "Only http(s) URLs are supported." }, { status: 422 });
  const now = Math.floor(Date.now() / 1000);

  let runId = body.runId?.trim() ?? "";
  if (runId) {
    const run = await openRun(runId, donorId, userId);
    if (!run) return Response.json({ error: "That research run is not open." }, { status: 404 });
  } else {
    runId = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO donor_research_runs (id, donor_id, user_id, status, created_at) VALUES (?,?,?,'open',?)").bind(runId, donorId, userId, now).run();
  }

  const evidenceId = crypto.randomUUID();
  const publishedAt = body.publishedAt ? Math.floor(new Date(body.publishedAt).getTime() / 1000) : null;
  await env.DB.prepare("INSERT INTO donor_research_pending_evidence (id, run_id, donor_id, user_id, url, title, snippet, published_at, created_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .bind(evidenceId, runId, donorId, userId, url, title, body.snippet?.trim() || null, Number.isFinite(publishedAt) ? publishedAt : null, now).run();
  logger.info("research_evidence_added", { userId, donorId, runId });
  return Response.json({ runId, evidenceId });
}

async function proposeIdentity(donorId: string, userId: string, body: Body, donorName: string) {
  const runId = body.runId?.trim() ?? "";
  const run = await openRun(runId, donorId, userId);
  if (!run) return Response.json({ error: "That research run is not open." }, { status: 404 });
  const evidence = await env.DB.prepare("SELECT id FROM donor_research_pending_evidence WHERE run_id=? AND donor_id=? AND user_id=?").bind(runId, donorId, userId).all<{ id: string }>();
  if (evidence.results.length === 0) return Response.json({ error: "Add at least one source before proposing an identity." }, { status: 422 });
  const candidateId = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const label = `${donorName} -- based on ${evidence.results.length} source${evidence.results.length === 1 ? "" : "s"} you added`;
  await env.DB.prepare("INSERT INTO donor_research_identity_candidates (id, run_id, donor_id, user_id, label, status, created_at) VALUES (?,?,?,?,?,'pending',?)").bind(candidateId, runId, donorId, userId, label, now).run();
  return Response.json({ candidateId, label });
}

// The only place Stage A ever writes to donor_research_sources or
// donor_research_findings -- and it only runs after the identity candidate
// for this run is confirmed. Each evidence item's sourceTier is chosen
// explicitly by the fundraiser (never inferred), enforced by the CHECK
// constraint on donor_research_sources.source_tier. No LLM call: the claim
// is the evidence's own title, verbatim; classifyEvidenceCategory() only
// picks which of the six sections it belongs in.
async function classifyAndPromote(donorId: string, userId: string, runId: string, evidenceChoices: NonNullable<Body["evidence"]>) {
  const pending = await env.DB.prepare("SELECT id, url, title, snippet, published_at FROM donor_research_pending_evidence WHERE run_id=? AND donor_id=? AND user_id=?").bind(runId, donorId, userId).all<PendingEvidenceRow>();
  const choiceById = new Map(evidenceChoices.map((choice) => [choice.pendingEvidenceId, choice]));
  const now = Math.floor(Date.now() / 1000);
  const touchedOrganizations = new Set<string>();

  for (const evidence of pending.results) {
    const choice = choiceById.get(evidence.id);
    const sourceTier = choice?.sourceTier as SourceTier | undefined;
    if (!sourceTier || !SOURCE_TIERS.includes(sourceTier)) continue; // no tier chosen -- leave as unpromoted pending evidence, not silently guessed
    const domain = extractDomain(evidence.url);
    const normalizedUrl = normalizeUrl(evidence.url);

    let sourceId = (await env.DB.prepare("SELECT id FROM donor_research_sources WHERE user_id=? AND normalized_url=? LIMIT 1").bind(userId, normalizedUrl).first<{ id: string }>())?.id ?? null;
    if (sourceId) {
      await env.DB.prepare("UPDATE donor_research_sources SET title=?, excerpt=?, retrieved_at=? WHERE id=?").bind(evidence.title, evidence.snippet, now, sourceId).run();
    } else {
      sourceId = crypto.randomUUID();
      await env.DB.prepare("INSERT INTO donor_research_sources (id, user_id, url, normalized_url, domain, title, published_at, retrieved_at, excerpt, source_tier, discovered_via, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
        .bind(sourceId, userId, evidence.url, normalizedUrl, domain, evidence.title, evidence.published_at, now, evidence.snippet, sourceTier, "manual", now).run();
    }

    const category = classifyEvidenceCategory(evidence.title, evidence.snippet ?? "");
    const claim = evidence.title;
    const organizationRaw = choice?.organization?.trim() || null;
    const organizationNormalized = organizationRaw ? normalizeOrganizationName(organizationRaw) : null;
    const activeFindings = await env.DB.prepare("SELECT id, fingerprint, category, organization_normalized FROM donor_research_findings WHERE donor_id=? AND user_id=? AND status IN ('current','unverified')").bind(donorId, userId).all<{ id: string; fingerprint: string; category: string; organization_normalized: string | null }>();
    const existingActiveFindings: ExistingActiveFinding[] = activeFindings.results.map((row) => ({ id: row.id, fingerprint: row.fingerprint, category: row.category as ExistingActiveFinding["category"], organizationNormalized: row.organization_normalized }));

    const plan = planFinding({ category, claim, sourceTier, organizationNormalized, existingActiveFindings });
    let findingId: string;
    if (plan.action === "reuse") {
      findingId = plan.existingFindingId;
      await env.DB.prepare("UPDATE donor_research_findings SET last_confirmed_run_id=? WHERE id=?").bind(runId, findingId).run();
    } else {
      findingId = crypto.randomUUID();
      if (plan.action === "supersede-and-insert") await env.DB.prepare("UPDATE donor_research_findings SET status='superseded' WHERE id=?").bind(plan.supersedesFindingId).run();
      await env.DB.prepare("INSERT INTO donor_research_findings (id, first_seen_run_id, last_confirmed_run_id, donor_id, user_id, category, claim, organization_normalized, status, fingerprint, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
        .bind(findingId, runId, runId, donorId, userId, category, claim, organizationNormalized, plan.status, plan.fingerprint, now).run();
    }
    await env.DB.prepare("INSERT OR IGNORE INTO donor_research_finding_sources (finding_id, source_id) VALUES (?,?)").bind(findingId, sourceId).run();
    if (organizationNormalized) touchedOrganizations.add(organizationNormalized);
  }

  // Shared Public Affiliations: an exact-match organization overlap with
  // another donor in the same workspace, materialized as a
  // possible_connections finding on both sides so it's citable and
  // history-tracked identically to every other finding. Never inferred
  // beyond exact normalized-name matching -- no fuzzy/semantic matching,
  // and never worded as a relationship, friendship, or closeness.
  for (const organizationNormalized of touchedOrganizations) {
    const donorRow = await env.DB.prepare("SELECT display_name FROM donors WHERE id=?").bind(donorId).first<{ display_name: string }>();
    const orgFindingHere = await env.DB.prepare("SELECT claim FROM donor_research_findings WHERE donor_id=? AND user_id=? AND organization_normalized=? AND status IN ('current','unverified') LIMIT 1").bind(donorId, userId, organizationNormalized).first<{ claim: string }>();
    const otherDonors = await env.DB.prepare("SELECT DISTINCT donor_id FROM donor_research_findings WHERE user_id=? AND organization_normalized=? AND donor_id!=? AND status IN ('current','unverified')").bind(userId, organizationNormalized, donorId).all<{ donor_id: string }>();
    if (!donorRow || !orgFindingHere || otherDonors.results.length === 0) continue;
    const organizationDisplayName = orgFindingHere.claim.split(",").pop()?.trim() || organizationNormalized;
    const connectionPlans = planSharedAffiliations({ donorId, organizationDisplayName, organizationNormalized, otherDonorIds: otherDonors.results.map((row) => row.donor_id) });
    for (const connection of connectionPlans) {
      const activeForDonor = await env.DB.prepare("SELECT id, fingerprint FROM donor_research_findings WHERE donor_id=? AND user_id=? AND status IN ('current','unverified')").bind(connection.donorId, userId).all<{ id: string; fingerprint: string }>();
      if (activeForDonor.results.some((row) => row.fingerprint === connection.fingerprint)) continue; // already recorded
      await env.DB.prepare("INSERT INTO donor_research_findings (id, first_seen_run_id, last_confirmed_run_id, donor_id, user_id, category, claim, related_donor_id, organization_normalized, status, fingerprint, created_at) VALUES (?,?,?,?,?,'possible_connections',?,?,?,?,?,?)")
        .bind(crypto.randomUUID(), runId, runId, connection.donorId, userId, connection.claim, connection.relatedDonorId, organizationNormalized, "current", connection.fingerprint, now).run();
    }
  }
}

async function decideIdentity(donorId: string, userId: string, body: Body) {
  const runId = body.runId?.trim() ?? "";
  const candidateId = body.candidateId?.trim() ?? "";
  const decision = body.decision === "confirmed" ? "confirmed" : body.decision === "rejected" ? "rejected" : null;
  if (!runId || !candidateId || !decision) return Response.json({ error: "Choose confirm or reject for a proposed identity." }, { status: 422 });
  const candidate = await env.DB.prepare("SELECT id FROM donor_research_identity_candidates WHERE id=? AND run_id=? AND donor_id=? AND user_id=? AND status='pending'").bind(candidateId, runId, donorId, userId).first<{ id: string }>();
  if (!candidate) return Response.json({ error: "That identity proposal is no longer pending." }, { status: 404 });
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare("UPDATE donor_research_identity_candidates SET status=?, decided_at=? WHERE id=?").bind(decision, now, candidateId).run();
  if (decision === "rejected") return Response.json({ candidateId, status: "rejected" });

  // No research finding can be treated as confirmed until this point.
  await classifyAndPromote(donorId, userId, runId, body.evidence ?? []);
  await env.DB.prepare("UPDATE donor_research_runs SET status='completed', completed_at=? WHERE id=?").bind(now, runId).run();
  logger.info("research_identity_confirmed", { userId, donorId, runId });
  return Response.json({ candidateId, status: "confirmed", runId });
}

async function discardRun(donorId: string, userId: string, body: Body) {
  const runId = body.runId?.trim() ?? "";
  const run = await openRun(runId, donorId, userId);
  if (!run) return Response.json({ error: "That research run is not open." }, { status: 404 });
  await env.DB.prepare("UPDATE donor_research_runs SET status='discarded' WHERE id=?").bind(runId).run();
  return Response.json({ runId, status: "discarded" });
}

export async function POST(request: Request, context: { params: Promise<{ donorId: string }> }) {
  const identity = await getChatGPTUser();
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });
  const profile = await ensureUserProfile(identity);
  const { donorId } = await context.params;
  const donor = await ownedLiveDonor(donorId, profile.id);
  if (!donor) return Response.json({ error: "Donor not found" }, { status: 404 });
  const body = await request.json().catch(() => null) as Body | null;
  if (!body?.action) return Response.json({ error: "Choose a research action." }, { status: 422 });

  try {
    if (body.action === "add_evidence") return await addEvidence(donorId, profile.id, body);
    if (body.action === "propose_identity") return await proposeIdentity(donorId, profile.id, body, donor.display_name);
    if (body.action === "decide_identity") return await decideIdentity(donorId, profile.id, body);
    if (body.action === "discard_run") return await discardRun(donorId, profile.id, body);
    return Response.json({ error: "Unsupported research action." }, { status: 422 });
  } catch (error) {
    logger.error("research_action_failed", error, { userId: profile.id, donorId, action: body.action });
    return Response.json({ error: "The research action could not be completed." }, { status: 500 });
  }
}
