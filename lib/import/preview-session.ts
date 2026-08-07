import type { ImportRow } from "./recognition.ts";

// How long a reviewed donation import's server-stored preview state remains
// usable. Long enough to review hundreds of rejected/reviewable rows by
// hand; short enough that stale sessions do not accumulate indefinitely.
export const PREVIEW_SESSION_TTL_SECONDS = 60 * 60;

export type PreviewSessionRow = {
  id: string;
  owner_user_id: string;
  file_hash: string;
  file_name: string;
  mapping_json: string;
  force_type: string | null;
  row_count: number;
  created_at: number;
  expires_at: number;
};

// A session is usable only for the exact owner that created it, and only
// before it expires. Never trust a client-supplied owner id -- the caller
// must pass the authenticated user's id.
export function isPreviewSessionUsable(session: PreviewSessionRow | null | undefined, authenticatedOwnerUserId: string, now: number): session is PreviewSessionRow {
  if (!session) return false;
  if (session.owner_user_id !== authenticatedOwnerUserId) return false;
  if (session.expires_at <= now) return false;
  return true;
}

export function previewSessionExpiresAt(now: number): number {
  return now + PREVIEW_SESSION_TTL_SECONDS;
}

export function reconstructRowsFromChunks(chunks: string[]): ImportRow[] {
  return chunks.flatMap((chunk) => JSON.parse(chunk) as ImportRow[]);
}
