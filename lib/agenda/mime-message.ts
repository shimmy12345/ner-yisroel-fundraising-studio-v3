// Pure RFC 2822 MIME message construction for Gmail's users.messages.send
// `raw` field. Deliberately has NO "cloudflare:workers" import -- unlike
// gmail-client.ts (which needs the Worker's env for the OAuth secrets and
// therefore can't be imported outside a Workers runtime at all, matching
// this codebase's established fact-accept.ts/fact-supersession.ts split)
// -- so this file alone is what's actually unit-tested.

// Loop-based (not a spread into String.fromCharCode) so this stays safe
// for a full email body's worth of bytes, not just a short subject line.
function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function encodeBase64Url(value: string): string {
  return toBase64(new TextEncoder().encode(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function encodeMimeWord(value: string): string {
  // RFC 2047 encoded-word for a Subject header that may contain non-ASCII
  // (e.g. the em dash in "Fundraising Agenda — Wednesday, August 26").
  return `=?UTF-8?B?${toBase64(new TextEncoder().encode(value))}?=`;
}

export type MimeMessageInput = { from: string; to: string; subject: string; text: string; html: string };

// Builds a base64url-encoded RFC 2822 multipart/alternative message, the
// exact shape Gmail's users.messages.send expects in its `raw` field.
// MIME requires CRLF line endings throughout, including inside each
// body part -- normalizing here means callers (agenda-render.ts) can
// keep writing plain "\n" without needing to know about this constraint.
function toCrlf(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/\n/g, "\r\n");
}

export function buildMimeMessage({ from, to, subject, text, html }: MimeMessageInput): string {
  const boundary = "fundraising-os-agenda-boundary";
  const message = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${encodeMimeWord(subject)}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 7bit",
    "",
    toCrlf(text),
    "",
    `--${boundary}`,
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: 7bit",
    "",
    toCrlf(html),
    "",
    `--${boundary}--`,
    "",
  ].join("\r\n");
  return encodeBase64Url(message);
}
