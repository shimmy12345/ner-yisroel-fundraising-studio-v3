// Protected, read-only preview of the Daily Fundraising Agenda email --
// generates the exact same Agenda the scheduled handler would (see
// lib/agenda/send-agenda.ts's generateAgenda(), shared by both), renders
// it, and returns it. Never calls sendGmail() or anything in
// lib/agenda/gmail-client.ts -- there is no code path from this route to
// an actual send, by construction (this file has no import of that
// module at all).
//
// Auth: the same getChatGPTUser() gate every other API route in this app
// uses (falls back to Cloudflare Access on the independent staging
// Worker) -- this is not a new, separate auth mechanism.

import { getChatGPTUser } from "../../../chatgpt-auth";
import { generateAgenda } from "../../../../lib/agenda/send-agenda";
import { renderAgendaHtml, renderAgendaText } from "../../../../lib/agenda/agenda-render";

function parseNow(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export async function GET(request: Request) {
  const identity = await getChatGPTUser();
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });

  const url = new URL(request.url);
  // Optional override so a specific day (e.g. one with a yahrtzeit or an
  // overdue Ask) can be previewed against real staging data without
  // waiting for the calendar to reach it. Defaults to the real current
  // time -- this is what the scheduled send itself would generate today.
  const now = parseNow(url.searchParams.get("now"));
  const format = url.searchParams.get("format") ?? "html";

  let agenda;
  try {
    agenda = await generateAgenda(now);
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Failed to generate agenda" }, { status: 500 });
  }

  if (format === "text") {
    return new Response(renderAgendaText(agenda), { headers: { "content-type": "text/plain; charset=utf-8" } });
  }
  if (format === "json") {
    return Response.json({
      subject: agenda.subject,
      dateLabel: agenda.dateLabel,
      generatedAt: agenda.generatedAt,
      isEmpty: agenda.isEmpty,
      todayPriorities: agenda.todayPriorities,
      overdue: agenda.overdue,
      importantDates: agenda.importantDates,
      suggested: agenda.suggested,
      html: renderAgendaHtml(agenda),
      text: renderAgendaText(agenda),
    });
  }
  return new Response(renderAgendaHtml(agenda), { headers: { "content-type": "text/html; charset=utf-8" } });
}
