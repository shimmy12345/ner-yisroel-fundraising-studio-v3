import type { AuthProvider } from "./provider.ts";

// Authentication Hardening (see docs/AI-HANDOFF.md) -- which identity
// provider(s) app/chatgpt-auth.ts's getChatGPTUser() is allowed to trust,
// and why this is NOT keyed off deploymentEnvironment's NAME.
//
// The legacy ChatGPT Sites gateway is the ONLY trusted party ever allowed
// to set the `oai-authenticated-user-email` header -- chatGPTHeaderProvider
// performs no independent verification of it at all (by design: that
// gateway IS the trust boundary on that platform, unchanged since before
// the auth-provider abstraction existed). An independent Cloudflare
// deployment (today: Independent Staging; in the future: an independent
// Production Worker) has no such gateway in front of it -- only Cloudflare
// Access does, which this app verifies for real: signature, issuer,
// audience, and expiry, all checked against the team's live JWKS (see
// lib/auth/cloudflare-access.ts). Trusting the legacy header there too
// would let an unverified, client-settable header silently grant the same
// access a real signed JWT is required for -- a full authentication bypass
// on any Cloudflare-hosted deployment, reachable by anyone who can get a
// request to the Worker's origin with that one header set, regardless of
// whether Cloudflare Access itself is working correctly.
//
// This is deliberately NOT gated on matching deploymentEnvironment's NAME
// (lib/environment.ts). That value can legitimately default to "staging"
// for a build that never set FUNDRAISING_OS_ENVIRONMENT at all -- the real
// mechanism legacy ChatGPT Sites staging's own build already relies on --
// so a future independent deployment whose build-time environment constant
// was simply never configured would ALSO silently collapse to "staging" by
// that same fallback, and a denylist/allowlist keyed on the string
// "staging" would then incorrectly treat it as the legacy platform. It is
// also not safe to invent and match a brand new environment name (e.g.
// "production-independent") for the same reason: that still depends on
// whoever builds the independent Production Worker remembering to set it
// correctly, which is exactly the "guessed name" failure mode this
// hardening exists to not depend on.
//
// Instead this is gated on an independent, structural fact: does this
// Worker actually have real Cloudflare Access bindings (TEAM_DOMAIN +
// POLICY_AUD) configured at all? Those are RUNTIME `env` bindings set in
// wrangler config -- a completely different configuration mechanism from
// the BUILD-TIME environment-name constant above, so a mistake in one can
// never silently compromise the other. cloudflare-env.d.ts already
// documents these two vars as "only present on the independent staging
// Worker... absent on legacy ChatGPT Sites staging/production" -- this is
// the same signal cloudflareAccessAuthProvider itself already requires
// before it will attempt real verification at all (see
// app/auth/cloudflare-access-provider.ts). Using it here too means: the
// moment a real independent Production Worker is configured with its own
// TEAM_DOMAIN/POLICY_AUD (a prerequisite for Access to protect it at all,
// not an optional extra step someone could forget), the legacy header
// becomes categorically unreachable there -- correct by construction, not
// by remembering to update a name-matching condition.
//
// Fails closed in the one way that matters: when Cloudflare Access IS
// configured, chatGPTHeaderProvider is excluded ENTIRELY, not merely
// deprioritized -- so a missing/invalid/expired Access JWT can never fall
// back to the unverified legacy header. When Access is NOT configured
// (every legacy ChatGPT Sites deployment, and local dev), behavior is
// completely unchanged from before this hardening: the legacy header is
// checked first, then Cloudflare Access as a no-op fallback (its own
// internal guard already returns null immediately without TEAM_DOMAIN/
// POLICY_AUD), exactly as today.
export function selectAuthProviders(
  hasCloudflareAccessConfigured: boolean,
  chatGPTHeaderProvider: AuthProvider,
  cloudflareAccessAuthProvider: AuthProvider,
): AuthProvider[] {
  if (hasCloudflareAccessConfigured) return [cloudflareAccessAuthProvider];
  return [chatGPTHeaderProvider, cloudflareAccessAuthProvider];
}
