"use client";
import { useState } from "react";
import type { CalendarConnectionStatus } from "../../lib/relationships/trip-calendar-sync";

// Google Calendar sync section (Minimal controls, 2026-10-19 -- see
// docs/AI-HANDOFF.md): "verified connected account, enable/disable, and
// clear one-way-sync disclosure." Status is re-fetched from the server on
// every toggle (never assumed locally) since it reflects a live Google
// identity check, not merely this account's own saved preference.
export function CalendarSyncSettings({ initialStatus }: { initialStatus: CalendarConnectionStatus }) {
  const [status, setStatus] = useState(initialStatus);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggle(enabled: boolean) {
    setSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/calendar-sync", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled }) });
      const payload = await response.json().catch(() => ({})) as CalendarConnectionStatus & { error?: string };
      if (!response.ok) throw new Error((payload as { error?: string }).error ?? "Could not update Google Calendar sync.");
      setStatus(payload);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not update Google Calendar sync.");
    } finally {
      setSaving(false);
    }
  }

  const connectionLabel = !status.credentialsConfigured
    ? "Not connected -- the one-time Google setup has not been completed yet."
    : status.verifiedEmail
      ? (status.allowed ? `Connected -- syncing to ${status.verifiedEmail}'s ${status.calendarId === "primary" ? "primary" : "test"} calendar.` : `Connected, but sync is refused: ${status.reason ?? "account/calendar mismatch"}.`)
      : "Connected, but the account could not be verified.";

  return <section className="support-card" id="calendar-sync">
    <h2>Google Calendar sync</h2>
    <p>{connectionLabel}</p>
    <label className="cleanup-confirm">
      <input type="checkbox" checked={status.enabled} disabled={saving} onChange={(event) => toggle(event.target.checked)} />
      {" "}Sync confirmed, timed Trip Planning meetings to this Google Calendar
    </label>
    <p className="payment-plan-note-inline">
      One-way only: Fundraising OS creates, updates, and removes calendar events for your confirmed Trip Planning meetings. Google Calendar itself is never read -- an edit made directly in Google does not update Fundraising OS, and a later change made here will overwrite it. Turning this off (Disconnect) stops every future sync immediately; meetings already on your calendar are left exactly as they are.
    </p>
    {error && <p className="capture-error" role="alert">{error}</p>}
  </section>;
}
