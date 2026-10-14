// TEMPORARY: Production Gmail OAuth verification mechanism (October 14
// 2026 incident -- docs/AI-HANDOFF.md). Exists only to send a single
// real Daily Fundraising Agenda email to the owner, proving the newly-
// corrected GMAIL_OAUTH_CLIENT_ID/_CLIENT_SECRET actually work, without
// waiting for the next natural 9 AM Eastern scheduled window. Remove or
// disable this route once that verification is complete -- see
// docs/AI-HANDOFF.md's own removal note once it is applied.
//
// Safety properties, each by construction, not by convention:
// - Reuses sendDailyAgenda() verbatim -- the exact same function the
//   real scheduled() handler calls (lib/agenda/send-agenda.ts) -- so the
//   data, links, and sender/recipient are genuinely Production's own,
//   with zero reimplementation to get wrong.
// - The Gmail-sending function's existing fail-closed allowlist
//   (lib/agenda/email-send-guard.ts) still runs regardless of caller --
//   this route inherits it automatically; Staging still cannot send
//   through this path either.
// - Authentication alone is NOT sufficient: beyond getChatGPTUser()
//   (which merely confirms SOME verified identity), this route explicitly
//   compares that identity's email against env.STAGING_OWNER_EMAIL, the
//   one configured Production owner, and refuses anything else.
// - The claim (lib/agenda/test-send-log.ts) is a real, atomic, persistent
//   D1 INSERT, never an in-memory flag and never a read-only preflight
//   check -- see that file's own header comment for why it is a single,
//   permanent, non-reclaimable claim, deliberately unlike the recurring
//   daily agenda's own claim logic.
// - This route never reads, writes, or even references the real
//   scheduled send's own idempotency table -- it uses an
//   entirely separate table, agenda_manual_test_send_log, so it cannot
//   mark October 15 (or any date) as sent or otherwise interfere with
//   the real schedule's own record.
// - Never logs or returns a credential, token, or response body -- every
//   error surfaced is `.message` only, matching gmail-client.ts's own
//   established discipline. On success, the one value surfaced is
//   Gmail's own message id, via sendDailyAgenda's return value (itself
//   from the Gmail-sending function -- see gmail-client.ts's own header
//   comment for exactly what it reads from the response and why that one
//   field is safe), as delivery evidence for a controlled test -- this
//   route never reads a response body itself.

import { env } from "cloudflare:workers";
import { getChatGPTUser } from "../../../chatgpt-auth";
import { sendDailyAgenda } from "../../../../lib/agenda/send-agenda";
import { userIdForEmail } from "../../../../lib/auth/profile";
import { buildTestSendClaimQuery, buildTestSendCommitQuery, buildTestSendFailureQuery } from "../../../../lib/agenda/test-send-log";

export async function POST() {
  const identity = await getChatGPTUser();
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });

  // Explicit, visible server-side owner check -- authentication alone
  // (confirming SOME verified identity) is deliberately treated as
  // insufficient. On both Independent Staging and Independent
  // Production, getChatGPTUser() already only ever authenticates via a
  // signature-verified Cloudflare Access JWT whose email claim was
  // separately checked against this exact same env.STAGING_OWNER_EMAIL
  // (lib/auth/cloudflare-access.ts's ownerEmail parameter) -- this check
  // is intentionally redundant with that, as the explicit, auditable
  // verification this mechanism's own authorization requires.
  const ownerEmail = env.STAGING_OWNER_EMAIL;
  if (!ownerEmail || identity.email !== ownerEmail) {
    return Response.json({ error: "Not authorized" }, { status: 403 });
  }

  const now = Math.floor(Date.now() / 1000);
  const userId = userIdForEmail(ownerEmail);

  const claim = buildTestSendClaimQuery(userId, now);
  const claimResult = await env.DB.prepare(claim.sql).bind(...claim.params).run() as { meta: { changes?: number } };
  if ((claimResult.meta.changes ?? 0) === 0) {
    return Response.json({ error: "This one-time test send has already been claimed or completed. It cannot run a second time through this route." }, { status: 409 });
  }

  try {
    const messageId = await sendDailyAgenda(now);
    const commit = buildTestSendCommitQuery(now, messageId);
    await env.DB.prepare(commit.sql).bind(...commit.params).run();
    return Response.json({ sent: true, messageId: messageId ?? null });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    const failure = buildTestSendFailureQuery(now, message);
    await env.DB.prepare(failure.sql).bind(...failure.params).run();
    return Response.json({ error: message }, { status: 500 });
  }
}
