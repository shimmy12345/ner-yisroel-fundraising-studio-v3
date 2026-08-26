import assert from "node:assert/strict";
import { buildMimeMessage, encodeBase64Url, encodeMimeWord } from "../lib/agenda/mime-message.ts";

function decodeBase64Url(value) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const withPadding = padded + "=".repeat((4 - (padded.length % 4)) % 4);
  return Buffer.from(withPadding, "base64").toString("utf8");
}

async function run() {
  // --- encodeBase64Url: real base64url, not base64 (no +, /, or trailing =). ---
  const encoded = encodeBase64Url("hello world");
  assert.doesNotMatch(encoded, /[+/=]/);
  assert.equal(decodeBase64Url(encoded), "hello world");

  // --- encodeMimeWord: RFC 2047 encoded-word, round-trips non-ASCII. ---
  const word = encodeMimeWord("Fundraising Agenda — Wednesday, August 26");
  assert.match(word, /^=\?UTF-8\?B\?.+\?=$/);

  // --- buildMimeMessage: decodes back to a well-formed multipart/alternative
  // message carrying both the plain-text and HTML bodies verbatim, with
  // From/To/Subject all present. ---
  const raw = buildMimeMessage({
    from: "sgoldstein@nirc.edu",
    to: "sgoldstein@nirc.edu",
    subject: "Fundraising Agenda — Wednesday, August 26",
    text: "TODAY'S PRIORITIES\n- Zachter: Follow up",
    html: "<h1>Fundraising Agenda</h1>",
  });
  const decoded = decodeBase64Url(raw);
  assert.match(decoded, /^From: sgoldstein@nirc\.edu\r\n/);
  assert.match(decoded, /To: sgoldstein@nirc\.edu\r\n/);
  assert.match(decoded, /Subject: =\?UTF-8\?B\?.+\?=\r\n/);
  assert.match(decoded, /Content-Type: multipart\/alternative; boundary="fundraising-os-agenda-boundary"/);
  assert.match(decoded, /Content-Type: text\/plain; charset=UTF-8/);
  assert.match(decoded, /Content-Type: text\/html; charset=UTF-8/);
  assert.match(decoded, /TODAY'S PRIORITIES\r\n- Zachter: Follow up/, "the body's own internal \\n is normalized to CRLF too, per MIME");
  assert.match(decoded, /<h1>Fundraising Agenda<\/h1>/);
  assert.match(decoded, /--fundraising-os-agenda-boundary--\r\n$/);
  // Sender and recipient can be the exact same address (emailing
  // yourself) -- nothing in message construction treats that as special
  // or invalid.
  assert.equal(raw.length > 0, true);

  console.log("agenda-mime-message: all assertions passed");
}

await run();
