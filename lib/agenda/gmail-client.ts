// Gmail API sending for the Daily Fundraising Agenda email, using the
// send-only `gmail.send` OAuth authorization already granted and stored
// as three Cloudflare Worker secrets (see docs/AI-HANDOFF.md's "Daily
// Fundraising Agenda Email" section for the setup this was built against):
//   GMAIL_OAUTH_CLIENT_ID, GMAIL_OAUTH_CLIENT_SECRET,
//   GMAIL_OAUTH_REFRESH_TOKEN
//
// Imports "cloudflare:workers" for those secrets, which means (matching
// this codebase's own established fact-accept.ts/fact-supersession.ts
// split) this file cannot be imported outside a Workers runtime at all --
// there is no plain-Node unit test for refreshAccessToken()/sendGmail()
// themselves; buildMimeMessage() (the actual message-construction logic)
// lives in the separate, dependency-free mime-message.ts specifically so
// it stays unit-testable. This file is exercised only via the live-verify
// step against real Independent Staging Gmail sending, per the same
// convention this session has used for every other Workers-only route.
//
// Security/logging rules this file must never violate:
// - Never include the client secret, refresh token, access token, or any
//   Authorization header value in a thrown Error's message or in any log
//   line -- callers (the scheduled handler) log via lib/logger.ts, which
//   only ever records `error.message`, so every message thrown here is
//   written with that in mind: HTTP status/statusText only, never a
//   request/response body, which could echo request contents back.
// - Never log the full Gmail API response body on success either -- only
//   the fields the caller actually needs (here, nothing beyond "it
//   didn't throw").

import { env } from "cloudflare:workers";
import { buildMimeMessage, type MimeMessageInput } from "./mime-message.ts";

const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const SEND_ENDPOINT = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";

export class GmailNotConfiguredError extends Error {
  constructor() {
    super("Gmail OAuth secrets are not configured on this Worker");
    this.name = "GmailNotConfiguredError";
  }
}

function requireGmailCredentials(): { clientId: string; clientSecret: string; refreshToken: string } {
  const clientId = env.GMAIL_OAUTH_CLIENT_ID;
  const clientSecret = env.GMAIL_OAUTH_CLIENT_SECRET;
  const refreshToken = env.GMAIL_OAUTH_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) throw new GmailNotConfiguredError();
  return { clientId, clientSecret, refreshToken };
}

// One access token per send -- at one email/day there is no reason to
// cache this across invocations, which also means there is never a stale
// token sitting in memory/KV to worry about invalidating.
export async function refreshAccessToken(): Promise<string> {
  const { clientId, clientSecret, refreshToken } = requireGmailCredentials();
  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }).toString(),
  });
  if (!response.ok) {
    // Deliberately status-only -- the response body is never read here,
    // so it can never end up in this Error's message or a log line.
    throw new Error(`Gmail token refresh failed: HTTP ${response.status} ${response.statusText}`);
  }
  const payload = (await response.json()) as { access_token?: string };
  if (!payload.access_token) throw new Error("Gmail token refresh response did not include an access token");
  return payload.access_token;
}

export async function sendGmail(input: MimeMessageInput): Promise<void> {
  requireGmailCredentials();
  const accessToken = await refreshAccessToken();
  const response = await fetch(SEND_ENDPOINT, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ raw: buildMimeMessage(input) }),
  });
  if (!response.ok) {
    // Status-only, same reasoning as refreshAccessToken() above -- the
    // response body is never read, so a Gmail error payload (which could
    // echo parts of the request) can never reach a log line or an Error
    // message.
    throw new Error(`Gmail send failed: HTTP ${response.status} ${response.statusText}`);
  }
}
