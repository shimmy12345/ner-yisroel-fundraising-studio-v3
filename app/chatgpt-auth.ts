import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { env } from "cloudflare:workers";
import { resolveIdentity, type AuthProvider } from "../lib/auth/provider";
import { selectAuthProviders } from "../lib/auth/provider-selection";
import { cloudflareAccessAuthProvider } from "./auth/cloudflare-access-provider";

export type ChatGPTUser = {
  displayName: string;
  email: string;
  fullName: string | null;
};

const USER_EMAIL_HEADER = "oai-authenticated-user-email";
const USER_FULL_NAME_HEADER = "oai-authenticated-user-full-name";
const USER_FULL_NAME_ENCODING_HEADER =
  "oai-authenticated-user-full-name-encoding";
const PERCENT_ENCODED_UTF8 = "percent-encoded-utf-8";
const SIGN_IN_PATH = "/signin-with-chatgpt";
const SIGN_OUT_PATH = "/signout-with-chatgpt";
const CALLBACK_PATH = "/callback";

// The ChatGPT Sites gateway is the trusted party that sets this header;
// unchanged from before the auth provider abstraction existed.
const chatGPTHeaderProvider: AuthProvider = {
  name: "chatgpt-sites",
  async resolve() {
    const requestHeaders = await headers();
    const email = requestHeaders.get(USER_EMAIL_HEADER);
    if (!email) return null;

    const encodedFullName = requestHeaders.get(USER_FULL_NAME_HEADER);
    const fullName =
      encodedFullName &&
      requestHeaders.get(USER_FULL_NAME_ENCODING_HEADER) === PERCENT_ENCODED_UTF8
        ? safeDecodeURIComponent(encodedFullName)
        : null;

    return {
      displayName: fullName ?? email,
      email,
      fullName,
    };
  },
};

// Authentication Hardening (see lib/auth/provider-selection.ts for the
// full rationale, and docs/AI-HANDOFF.md). On any Worker with real
// Cloudflare Access bindings configured (TEAM_DOMAIN + POLICY_AUD --
// Independent Staging today, an independent Production Worker once one
// exists), the legacy, unverified ChatGPT Sites header is excluded
// entirely -- only a real, signature-verified Access JWT can authenticate.
// On legacy ChatGPT Sites (no such bindings), behavior is unchanged: the
// header is checked first, then Cloudflare Access as a no-op fallback.
export async function getChatGPTUser(): Promise<ChatGPTUser | null> {
  const hasCloudflareAccessConfigured = Boolean(env.TEAM_DOMAIN && env.POLICY_AUD);
  return resolveIdentity(selectAuthProviders(hasCloudflareAccessConfigured, chatGPTHeaderProvider, cloudflareAccessAuthProvider));
}

export async function requireChatGPTUser(
  returnTo: string,
): Promise<ChatGPTUser> {
  const user = await getChatGPTUser();
  if (user) return user;

  redirect(chatGPTSignInPath(returnTo));
}

export function chatGPTSignInPath(returnTo: string): string {
  const safeReturnTo = safeRelativeReturnPath(returnTo);
  return `${SIGN_IN_PATH}?return_to=${encodeURIComponent(safeReturnTo)}`;
}

export function chatGPTSignOutPath(returnTo = "/"): string {
  const safeReturnTo = safeRelativeReturnPath(returnTo);
  return `${SIGN_OUT_PATH}?return_to=${encodeURIComponent(safeReturnTo)}`;
}

function safeRelativeReturnPath(value: string): string {
  if (!value.startsWith("/") || value.startsWith("//")) return "/";

  let url: URL;
  try {
    url = new URL(value, "https://app.local");
  } catch {
    return "/";
  }
  if (url.origin !== "https://app.local") return "/";
  if (isReservedAuthPath(url.pathname)) return "/";

  return `${url.pathname}${url.search}${url.hash}`;
}

function isReservedAuthPath(pathname: string): boolean {
  return (
    pathname === SIGN_IN_PATH ||
    pathname === SIGN_OUT_PATH ||
    pathname === CALLBACK_PATH
  );
}

function safeDecodeURIComponent(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}
