import { env } from "cloudflare:workers";
import type { ChatGPTUser } from "../../app/chatgpt-auth";

export type UserProfile = {
  id: string;
  email: string;
  fullName: string;
  preferredFirstName: string;
  organizationName: string;
  jobTitle: string;
  timezone: string;
  avatarUrl: string;
};

export function userIdForEmail(email: string) {
  return `user_${email.trim().toLowerCase()}`;
}

export function firstName(value: string) {
  return value.trim().split(/\s+/)[0] || value;
}

export function initials(value: string) {
  const parts = value.trim().split(/\s+/).filter(Boolean);
  return (parts.length > 1 ? `${parts[0][0]}${parts.at(-1)?.[0]}` : parts[0]?.slice(0, 2) || "?").toUpperCase();
}

export async function ensureUserProfile(identity: ChatGPTUser): Promise<UserProfile> {
  const id = userIdForEmail(identity.email);
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(`INSERT INTO users (id, email, name, preferred_first_name, timezone, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'America/New_York', ?, ?)
    ON CONFLICT(id) DO UPDATE SET email = excluded.email, name = COALESCE(users.name, excluded.name), preferred_first_name = COALESCE(users.preferred_first_name, excluded.preferred_first_name), updated_at = excluded.updated_at`)
    .bind(id, identity.email, identity.fullName ?? identity.displayName, firstName(identity.fullName ?? identity.displayName), now, now).run();
  const row = await env.DB.prepare("SELECT id, email, name, preferred_first_name, organization_name, job_title, timezone, avatar_url FROM users WHERE id = ?").bind(id).first<Record<string, string | null>>();
  return {
    id,
    email: row?.email ?? identity.email,
    fullName: row?.name ?? identity.fullName ?? identity.displayName,
    preferredFirstName: row?.preferred_first_name ?? firstName(identity.displayName),
    organizationName: row?.organization_name ?? "",
    jobTitle: row?.job_title ?? "",
    timezone: row?.timezone ?? "America/New_York",
    avatarUrl: row?.avatar_url ?? "",
  };
}
