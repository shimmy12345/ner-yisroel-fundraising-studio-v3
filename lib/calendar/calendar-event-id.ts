// Deterministic Google Calendar event id derivation (Issue 3 of the
// reviewed design). Google permanently blocks reinserting a deleted
// event's id -- 409 "identifier already exists" -- confirmed against
// Google's own error-handling documentation and a real client issue
// report (see docs/GOOGLE-CALENDAR-INTEGRATION-DESIGN.md SS4.1/SS6). So
// the id must be a pure function of (interactionId, generation), never
// interactionId alone: a cancel-then-reopen bumps generation and gets a
// brand-new id, never reinserting the old, tombstoned one.
//
// Google's own id constraints (verified live against the Events: insert
// reference and a client library's mirrored field docs): lowercase
// base32hex characters (a-v, 0-9) only, length 5-1024.

import { createHash } from "node:crypto";

const BASE32HEX_ALPHABET = "0123456789abcdefghijklmnopqrstuv";

// Encodes raw bytes into Google's allowed base32hex alphabet (a-v0-9).
// Deliberately NOT RFC 4648 base32hex padding-aware -- this is a one-way
// id derivation, never decoded back, so padding/alignment semantics
// don't matter; only "every output character is in the allowed set" does.
function toBase32Hex(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32HEX_ALPHABET[(value >>> (bits - 5)) & 0x1f];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32HEX_ALPHABET[(value << (5 - bits)) & 0x1f];
  return output;
}

// A fixed leading "1" (a valid base32hex digit, never a letter -- Google's
// alphabet is a-v0-9, so an alphabetic prefix like "fos" would itself
// contain characters outside the allowed set) keeps every derived id
// starting with a digit, avoiding any ambiguity with Google's own
// server-generated ids (which are also base32hex but not guaranteed to
// start any particular way) without smuggling in an invalid character.
// The hash covers both interactionId and generation, so two different
// generations of the same meeting are guaranteed-distinct ids, never a
// collision.
export function deriveGoogleEventId(interactionId: string, generation: number): string {
  if (!Number.isInteger(generation) || generation < 0) throw new Error(`generation must be a non-negative integer, got ${generation}`);
  const digest = createHash("sha256").update(`${interactionId}:${generation}`).digest();
  const id = `1${toBase32Hex(digest).slice(0, 40)}`;
  if (id.length < 5 || id.length > 1024) throw new Error(`derived event id length ${id.length} outside Google's allowed 5-1024 range`);
  if (!/^[0-9a-v]+$/.test(id)) throw new Error(`derived event id "${id}" contains a character outside Google's allowed base32hex set`);
  return id;
}
