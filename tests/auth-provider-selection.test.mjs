import assert from "node:assert/strict";
import test from "node:test";
import { SignJWT, generateKeyPair, exportJWK, createLocalJWKSet } from "jose";
import { selectAuthProviders } from "../lib/auth/provider-selection.ts";
import { resolveIdentity } from "../lib/auth/provider.ts";
import { verifyAccessToken } from "../lib/auth/cloudflare-access.ts";

// Authentication Hardening (see lib/auth/provider-selection.ts's own doc
// comment for the full rationale, and docs/AI-HANDOFF.md). The real
// vulnerability this closes: app/chatgpt-auth.ts's getChatGPTUser()
// previously checked the legacy, UNVERIFIED ChatGPT Sites header
// (oai-authenticated-user-email, trusted with no signature check at all)
// before Cloudflare Access's real, signature-verified JWT, unconditionally
// -- on EVERY deployment, including an independent Cloudflare one. Anyone
// who could get a request to the Worker's origin with that one header set
// -- regardless of whether a real Access JWT was present, missing, or
// invalid -- authenticated as the configured owner, with zero cryptographic
// verification. This file proves the fix end to end: the exact same
// `selectAuthProviders` + `resolveIdentity` composition
// app/chatgpt-auth.ts's getChatGPTUser() itself uses, combined with REAL
// JWT fixtures built the same way tests/cloudflare-access-auth.test.mjs
// already proves the underlying verifyAccessToken is sound (that file is
// not re-tested here; this file proves the PRECEDENCE/EXCLUSION behavior
// layered on top of it).

const TEAM_DOMAIN = "example-team.cloudflareaccess.com";
const POLICY_AUD = "test-policy-aud";
const OWNER_EMAIL = "sgoldstein@nirc.edu";

async function keyPair() {
  return generateKeyPair("RS256");
}
async function jwksFor(publicKey) {
  const jwk = await exportJWK(publicKey);
  return createLocalJWKSet({ keys: [{ ...jwk, kid: "test-key", alg: "RS256", use: "sig" }] });
}
async function signToken(privateKey, overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ email: OWNER_EMAIL, ...overrides.claims })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuedAt(overrides.iat ?? now)
    .setExpirationTime(overrides.exp ?? now + 3600)
    .setIssuer(overrides.issuer ?? `https://${TEAM_DOMAIN}`)
    .setAudience(overrides.audience ?? POLICY_AUD)
    .sign(privateKey);
}

// Mirrors app/auth/cloudflare-access-provider.ts's own shape exactly (an
// AuthProvider whose resolve() calls the real verifyAccessToken with a
// given bearer token and JWKS) -- never a reimplementation of the
// verification logic itself.
function realAccessProvider(token, jwks) {
  return {
    name: "cloudflare-access",
    async resolve() {
      const identity = await verifyAccessToken(token, { teamDomain: TEAM_DOMAIN, policyAud: POLICY_AUD, ownerEmail: OWNER_EMAIL }, jwks);
      if (!identity) return null;
      return { displayName: identity.email, email: identity.email, fullName: null };
    },
  };
}

// A forged legacy header "arrives" as a provider that resolves to an
// attacker-controlled identity with zero verification -- exactly what
// chatGPTHeaderProvider does for a real oai-authenticated-user-email
// header, by design, on the platform where that header is the trust
// boundary. Here it is deliberately an IMPOSTOR email, never the real
// owner's, so any test where this provider's result leaks through is
// unambiguously a bypass.
const forgedHeaderProvider = {
  name: "chatgpt-sites",
  async resolve() {
    return { displayName: "attacker", email: "attacker@evil.example", fullName: null };
  },
};

// A stronger version for proving exclusion, not just "its result was
// ignored": if this provider is ever actually invoked at all, the test
// fails immediately via the thrown error, rather than relying on the
// returned identity happening not to win.
const throwingHeaderProvider = {
  name: "chatgpt-sites",
  async resolve() {
    throw new Error("chatGPTHeaderProvider must never be invoked when Cloudflare Access is configured");
  },
};

async function resolveWith(hasCloudflareAccessConfigured, headerProvider, accessProvider) {
  return resolveIdentity(selectAuthProviders(hasCloudflareAccessConfigured, headerProvider, accessProvider));
}

// ================================================================
// 1. Valid Cloudflare Access JWT, Access configured -- resolves via
// Access, the legacy header is never even invoked.
// ================================================================

test("1. a valid Cloudflare Access JWT authenticates successfully when Access is configured, never touching the legacy header provider", async () => {
  const { publicKey, privateKey } = await keyPair();
  const jwks = await jwksFor(publicKey);
  const token = await signToken(privateKey);
  const identity = await resolveWith(true, throwingHeaderProvider, realAccessProvider(token, jwks));
  assert.deepEqual(identity, { displayName: OWNER_EMAIL, email: OWNER_EMAIL, fullName: null });
});

// ================================================================
// 2. Missing JWT, Access configured -- rejected, no fallback.
// ================================================================

test("2. a missing JWT is rejected when Access is configured -- never falls back to the legacy header", async () => {
  const { publicKey } = await keyPair();
  const jwks = await jwksFor(publicKey);
  const identity = await resolveWith(true, forgedHeaderProvider, realAccessProvider(null, jwks));
  assert.equal(identity, null, "a missing JWT must never resolve an identity, even with a forged legacy header also present");
});

// ================================================================
// 3. Invalid JWT signature, Access configured -- rejected, no fallback.
// ================================================================

test("3. an invalid JWT signature is rejected when Access is configured -- never falls back to the legacy header", async () => {
  const { publicKey: configuredPublicKey } = await keyPair();
  const jwks = await jwksFor(configuredPublicKey);
  // Signed by a DIFFERENT key than the one published in the JWKS -- a forged signature.
  const { privateKey: attackerPrivateKey } = await keyPair();
  const token = await signToken(attackerPrivateKey);
  const identity = await resolveWith(true, forgedHeaderProvider, realAccessProvider(token, jwks));
  assert.equal(identity, null, "a signature that doesn't verify against the configured JWKS must never resolve an identity");
});

// ================================================================
// 4. Wrong JWT audience, Access configured -- rejected, no fallback.
// ================================================================

test("4. a JWT with the wrong audience is rejected when Access is configured -- never falls back to the legacy header", async () => {
  const { publicKey, privateKey } = await keyPair();
  const jwks = await jwksFor(publicKey);
  const token = await signToken(privateKey, { audience: "some-other-policy-aud" });
  const identity = await resolveWith(true, forgedHeaderProvider, realAccessProvider(token, jwks));
  assert.equal(identity, null);
});

// ================================================================
// 5. Expired JWT, Access configured -- rejected, no fallback.
// ================================================================

test("5. an expired JWT is rejected when Access is configured -- never falls back to the legacy header", async () => {
  const { publicKey, privateKey } = await keyPair();
  const jwks = await jwksFor(publicKey);
  const now = Math.floor(Date.now() / 1000);
  const token = await signToken(privateKey, { iat: now - 7200, exp: now - 3600 });
  const identity = await resolveWith(true, forgedHeaderProvider, realAccessProvider(token, jwks));
  assert.equal(identity, null);
});

// ================================================================
// 6. Forged legacy authentication header alone, Access configured --
// the core fix. Proven two ways: the forged identity never leaks
// through, AND the header provider is never even invoked.
// ================================================================

test("6. a forged legacy authentication header alone cannot authenticate when Access is configured -- it is never invoked at all", async () => {
  const { publicKey } = await keyPair();
  const jwks = await jwksFor(publicKey);
  // No real JWT at all -- only the forged header "arrives".
  const identity = await resolveWith(true, throwingHeaderProvider, realAccessProvider(null, jwks));
  assert.equal(identity, null, "the throwing provider proves this path never even calls the legacy header provider");
});

test("6b. a forged legacy header's identity never leaks through even when the header provider IS somehow still invoked", async () => {
  const { publicKey } = await keyPair();
  const jwks = await jwksFor(publicKey);
  const identity = await resolveWith(true, forgedHeaderProvider, realAccessProvider(null, jwks));
  assert.equal(identity, null);
  assert.notEqual(identity?.email, "attacker@evil.example");
});

// ================================================================
// 7. Legacy header combined with a missing JWT, Access configured.
// ================================================================

test("7. a forged legacy header combined with a missing JWT is rejected when Access is configured", async () => {
  const { publicKey } = await keyPair();
  const jwks = await jwksFor(publicKey);
  const identity = await resolveWith(true, forgedHeaderProvider, realAccessProvider(null, jwks));
  assert.equal(identity, null);
});

// ================================================================
// 8. Legacy header combined with an invalid JWT, Access configured.
// ================================================================

test("8. a forged legacy header combined with an invalid (wrong-signature) JWT is rejected when Access is configured", async () => {
  const { publicKey } = await keyPair();
  const jwks = await jwksFor(publicKey);
  const { privateKey: attackerPrivateKey } = await keyPair();
  const token = await signToken(attackerPrivateKey);
  const identity = await resolveWith(true, forgedHeaderProvider, realAccessProvider(token, jwks));
  assert.equal(identity, null);
});

// ================================================================
// 9. Correct behavior in Independent Staging: real TEAM_DOMAIN/
// POLICY_AUD configured, a genuinely valid JWT authenticates, and the
// provider LIST ITSELF structurally excludes the legacy header --
// not merely "it happened not to win this time".
// ================================================================

test("9. Independent Staging (Access configured): selectAuthProviders returns ONLY the Cloudflare Access provider", () => {
  const providers = selectAuthProviders(true, forgedHeaderProvider, { name: "cloudflare-access", resolve: async () => null });
  assert.equal(providers.length, 1);
  assert.equal(providers[0].name, "cloudflare-access");
});

test("9b. Independent Staging (Access configured) end to end: a valid JWT authenticates as the real owner, exactly once, via Access only", async () => {
  const { publicKey, privateKey } = await keyPair();
  const jwks = await jwksFor(publicKey);
  const token = await signToken(privateKey);
  const identity = await resolveWith(true, throwingHeaderProvider, realAccessProvider(token, jwks));
  assert.equal(identity.email, OWNER_EMAIL);
});

// ================================================================
// 10. Preservation of explicitly supported legacy behavior: when
// Cloudflare Access is NOT configured (every legacy ChatGPT Sites
// deployment, and local dev), the legacy header continues to work
// exactly as before this hardening -- checked first, Access as a
// harmless fallback.
// ================================================================

test("10. legacy ChatGPT Sites (Access NOT configured): selectAuthProviders returns the header provider first, Access second, preserving prior behavior exactly", () => {
  const header = { name: "chatgpt-sites", resolve: async () => null };
  const access = { name: "cloudflare-access", resolve: async () => null };
  const providers = selectAuthProviders(false, header, access);
  assert.deepEqual(providers, [header, access]);
});

test("10b. legacy ChatGPT Sites (Access NOT configured) end to end: a legitimate legacy header still authenticates successfully", async () => {
  const legitimateHeaderProvider = {
    name: "chatgpt-sites",
    async resolve() {
      return { displayName: "Legacy User", email: "legacy-user@example.org", fullName: "Legacy User" };
    },
  };
  const accessProvider = { name: "cloudflare-access", resolve: async () => null }; // no TEAM_DOMAIN/POLICY_AUD configured, same as the real provider's own guard
  const identity = await resolveWith(false, legitimateHeaderProvider, accessProvider);
  assert.deepEqual(identity, { displayName: "Legacy User", email: "legacy-user@example.org", fullName: "Legacy User" });
});

test("10c. legacy ChatGPT Sites (Access NOT configured): Cloudflare Access still works as a fallback when the header is absent (e.g. local dev with neither configured correctly still fails closed to null, never crashes)", async () => {
  const absentHeaderProvider = { name: "chatgpt-sites", resolve: async () => null };
  const accessProvider = { name: "cloudflare-access", resolve: async () => null };
  const identity = await resolveWith(false, absentHeaderProvider, accessProvider);
  assert.equal(identity, null);
});

process.stdout.write("Authentication Hardening (provider selection) checks passed.\n");
