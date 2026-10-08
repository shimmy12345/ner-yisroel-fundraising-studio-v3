import { jwtVerify, createRemoteJWKSet, type JWTVerifyGetKey } from "jose";

export type AccessIdentity = { email: string };

export type AccessVerifyConfig = {
  teamDomain: string;
  policyAud: string;
  ownerEmail?: string;
  // Allow-lists ONE specific Service Token (identified by its Client ID,
  // the JWT's `common_name` claim) to authenticate as `ownerEmail` itself
  // -- for a trusted automation (e.g. a morning-brief script) acting as
  // the owner's own workspace, never a separate identity. A Cloudflare
  // Access service-token JWT never carries an `email` claim at all (see
  // Cloudflare's own JWT claims reference: service tokens set `common_name`
  // to the token's Client ID and leave `sub` empty, in place of `email`) --
  // this app's own identity check would otherwise reject every service-
  // token request outright, 2026-10-08. Both this AND `ownerEmail` must be
  // configured for a service-token JWT to be accepted at all -- this app
  // never silently accepts an arbitrary service token merely because
  // Access already let it through; it independently re-verifies WHICH one,
  // the same defense-in-depth discipline as the `ownerEmail` check below.
  allowedServiceTokenClientId?: string;
};

const jwksCache = new Map<string, JWTVerifyGetKey>();

function jwksFor(teamDomain: string): JWTVerifyGetKey {
  let jwks = jwksCache.get(teamDomain);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`https://${teamDomain}/cdn-cgi/access/certs`));
    jwksCache.set(teamDomain, jwks);
  }
  return jwks;
}

// Verifies a Cloudflare Access JWT against the team's published JWKS.
// Missing, malformed, expired, wrong-issuer, and wrong-audience tokens all
// collapse to null (unauthenticated) rather than throwing, so callers treat
// every rejection reason identically and never leak verification detail.
export async function verifyAccessToken(
  token: string | null,
  config: AccessVerifyConfig,
  jwks: JWTVerifyGetKey = jwksFor(config.teamDomain),
): Promise<AccessIdentity | null> {
  if (!token) return null;

  let payload;
  try {
    ({ payload } = await jwtVerify(token, jwks, {
      issuer: `https://${config.teamDomain}`,
      audience: config.policyAud,
    }));
  } catch {
    return null;
  }

  const email = typeof payload.email === "string" ? payload.email : null;
  if (email) {
    if (config.ownerEmail && email.toLowerCase() !== config.ownerEmail.toLowerCase()) return null;
    return { email };
  }

  // No `email` claim -- a service-token-authenticated request (see
  // AccessVerifyConfig's own doc comment for why service tokens never
  // carry one). Accept ONLY the one specific, allow-listed Client ID, and
  // only when `ownerEmail` is ALSO configured -- the resulting identity is
  // that owner, never a separate "service" identity, so data scoping
  // (owner_user_id) behaves exactly as if the owner had signed in
  // themselves.
  const commonName = typeof payload.common_name === "string" ? payload.common_name : null;
  if (commonName && config.allowedServiceTokenClientId && config.ownerEmail && commonName === config.allowedServiceTokenClientId) {
    return { email: config.ownerEmail };
  }
  return null;
}
