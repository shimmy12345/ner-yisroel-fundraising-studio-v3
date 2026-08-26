// Pure HTML/plain-text rendering of an Agenda (see agenda-model.ts) --
// no D1 access, no network call, no Gmail dependency. Kept separate from
// agenda-model.ts so the preview route and the real sender can both
// render identically without either needing to know how a Gmail MIME
// message is assembled (see gmail-client.ts for that).

import type { Agenda, AgendaItem } from "./agenda-model.ts";

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]);
}

type Section = { title: string; items: AgendaItem[] };

function sections(agenda: Agenda): Section[] {
  return [
    { title: "TODAY'S PRIORITIES", items: agenda.todayPriorities },
    { title: "OVERDUE", items: agenda.overdue },
    { title: "IMPORTANT DATES / STEWARDSHIP", items: agenda.importantDates },
    { title: "SUGGESTED", items: agenda.suggested },
  ];
}

const EMPTY_AGENDA_MESSAGE = "Nothing due, overdue, or scheduled today, and no suggestions worth surfacing right now.";

export function renderAgendaText(agenda: Agenda): string {
  const lines: string[] = [`Fundraising Agenda — ${agenda.dateLabel}`, ""];
  if (agenda.isEmpty) {
    lines.push(EMPTY_AGENDA_MESSAGE);
    return lines.join("\n");
  }
  for (const section of sections(agenda)) {
    if (section.items.length === 0) continue;
    lines.push(section.title);
    for (const item of section.items) {
      lines.push(`- ${item.donorName}: ${item.headline}`);
      if (item.context) lines.push(`  ${item.context}`);
      lines.push(`  ${item.href}`);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

function renderItemHtml(item: AgendaItem): string {
  const context = item.context
    ? `<div style="margin:2px 0 0;color:#555;font-size:13px;">${escapeHtml(item.context)}</div>`
    : "";
  return `<li style="margin:0 0 12px;">
    <div style="font-size:14px;">
      <strong>${escapeHtml(item.donorName)}</strong> — ${escapeHtml(item.headline)}
    </div>
    ${context}
    <div style="margin:4px 0 0;"><a href="${escapeHtml(item.href)}" style="color:#1a5fb4;font-size:13px;">Open in Fundraising OS</a></div>
  </li>`;
}

function renderSectionHtml(section: Section): string {
  if (section.items.length === 0) return "";
  return `<h2 style="font-size:15px;letter-spacing:0.04em;text-transform:uppercase;color:#222;margin:24px 0 8px;border-bottom:1px solid #ddd;padding-bottom:4px;">${escapeHtml(section.title)}</h2>
  <ul style="list-style:none;margin:0;padding:0;">
    ${section.items.map(renderItemHtml).join("\n")}
  </ul>`;
}

export function renderAgendaHtml(agenda: Agenda): string {
  const body = agenda.isEmpty
    ? `<p style="color:#555;">${escapeHtml(EMPTY_AGENDA_MESSAGE)}</p>`
    : sections(agenda).map(renderSectionHtml).join("\n");
  return `<!doctype html>
<html>
  <body style="font-family:-apple-system,Segoe UI,Arial,sans-serif;color:#111;max-width:640px;margin:0 auto;padding:16px;">
    <h1 style="font-size:18px;margin:0 0 4px;">Fundraising Agenda</h1>
    <p style="color:#555;margin:0 0 16px;">${escapeHtml(agenda.dateLabel)}</p>
    ${body}
  </body>
</html>`;
}
