"use client";

import { useState } from "react";
import { HEBREW_MONTHS, isPlausibleHebrewDate, nextYahrtzeitOccurrence, type HebrewMonthName } from "../../../lib/calendar/hebrew-date.ts";

export type YahrtzeitListItem = {
  id: string;
  deceasedNameEnglish: string;
  deceasedNameHebrew: string | null;
  relationship: string;
  hebrewMonth: HebrewMonthName;
  hebrewDay: number;
  hebrewYear: number | null;
};

type FormState = {
  deceasedNameEnglish: string;
  deceasedNameHebrew: string;
  relationship: string;
  hebrewMonth: HebrewMonthName | "";
  hebrewDay: string;
  hebrewYear: string;
};

const EMPTY_FORM: FormState = { deceasedNameEnglish: "", deceasedNameHebrew: "", relationship: "", hebrewMonth: "", hebrewDay: "", hebrewYear: "" };

function toFormState(item: YahrtzeitListItem): FormState {
  return {
    deceasedNameEnglish: item.deceasedNameEnglish,
    deceasedNameHebrew: item.deceasedNameHebrew ?? "",
    relationship: item.relationship,
    hebrewMonth: item.hebrewMonth,
    hebrewDay: String(item.hebrewDay),
    hebrewYear: item.hebrewYear ? String(item.hebrewYear) : "",
  };
}

function occurrenceLabel(month: HebrewMonthName, day: number, timezone: string) {
  if (!isPlausibleHebrewDate(month, day)) return null;
  try {
    const occurrence = nextYahrtzeitOccurrence(month, day, timezone, Math.floor(Date.now() / 1000));
    const formatted = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" }).format(new Date(occurrence.primary.gregorianEpoch * 1000));
    return { formatted, ambiguous: occurrence.ambiguous, note: occurrence.ambiguityNote };
  } catch {
    return null;
  }
}

function YahrtzeitForm({ donorId, timezone, initial, yahrtzeitId, onDone, onCancel }: { donorId: string; timezone: string; initial: FormState; yahrtzeitId?: string; onDone: () => void; onCancel: () => void }) {
  const [form, setForm] = useState<FormState>(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const day = Number(form.hebrewDay);
  const preview = form.hebrewMonth && Number.isInteger(day) && day > 0 ? occurrenceLabel(form.hebrewMonth, day, timezone) : null;

  async function save() {
    if (saving) return;
    setSaving(true); setError("");
    try {
      const body = {
        deceasedNameEnglish: form.deceasedNameEnglish,
        deceasedNameHebrew: form.deceasedNameHebrew || undefined,
        relationship: form.relationship,
        hebrewMonth: form.hebrewMonth || undefined,
        hebrewDay: Number.isInteger(day) ? day : undefined,
        hebrewYear: form.hebrewYear ? Number(form.hebrewYear) : null,
      };
      const url = yahrtzeitId ? `/api/yahrtzeits/${encodeURIComponent(yahrtzeitId)}` : `/api/donors/${encodeURIComponent(donorId)}/yahrtzeits`;
      const response = await fetch(url, { method: yahrtzeitId ? "PATCH" : "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error || "The yahrtzeit could not be saved.");
      onDone();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The yahrtzeit could not be saved.");
    } finally {
      setSaving(false);
    }
  }

  return <div className="yahrtzeit-form">
    <label>Deceased's English name<input type="text" value={form.deceasedNameEnglish} onChange={(event) => setForm({ ...form, deceasedNameEnglish: event.target.value })} /></label>
    <label>Deceased's Hebrew name (optional)<input type="text" value={form.deceasedNameHebrew} onChange={(event) => setForm({ ...form, deceasedNameHebrew: event.target.value })} /></label>
    <label>Relationship to donor<input type="text" value={form.relationship} onChange={(event) => setForm({ ...form, relationship: event.target.value })} placeholder="e.g. Mother, Father, Brother" /></label>
    <div className="yahrtzeit-form-date">
      <label>Hebrew month
        <select value={form.hebrewMonth} onChange={(event) => setForm({ ...form, hebrewMonth: event.target.value as HebrewMonthName })}>
          <option value="">Choose…</option>
          {HEBREW_MONTHS.map((month) => <option key={month} value={month}>{month}</option>)}
        </select>
      </label>
      <label>Hebrew day<input type="number" min={1} max={30} value={form.hebrewDay} onChange={(event) => setForm({ ...form, hebrewDay: event.target.value })} /></label>
      <label>Hebrew year (optional)<input type="number" value={form.hebrewYear} onChange={(event) => setForm({ ...form, hebrewYear: event.target.value })} placeholder="e.g. 5785" /></label>
    </div>
    {preview && <p className="yahrtzeit-form-preview">Next occurrence: <strong>{preview.formatted}</strong>{preview.ambiguous && <span className="capture-error"> — {preview.note}</span>}</p>}
    {error && <p className="capture-error" role="alert">{error}</p>}
    <div className="yahrtzeit-form-actions">
      <button type="button" className="onboarding-primary" disabled={saving} onClick={() => void save()}>{saving ? "Saving…" : yahrtzeitId ? "Save changes" : "Add yahrtzeit"}</button>
      <button type="button" onClick={onCancel} disabled={saving}>Cancel</button>
    </div>
  </div>;
}

export function YahrtzeitManagement({ donorId, timezone, items }: { donorId: string; timezone: string; items: YahrtzeitListItem[] }) {
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [error, setError] = useState("");

  async function remove(id: string, name: string) {
    if (!window.confirm(`Delete the yahrtzeit record for ${name}? This cannot be undone from here, though the change is kept in the audit history.`)) return;
    setDeletingId(id); setError("");
    try {
      const response = await fetch(`/api/yahrtzeits/${encodeURIComponent(id)}`, { method: "DELETE" });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error || "The yahrtzeit could not be deleted.");
      window.location.reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The yahrtzeit could not be deleted.");
      setDeletingId(null);
    }
  }

  return <div className="yahrtzeit-management">
    {items.length === 0 && !adding && <p className="yahrtzeit-empty">No yahrtzeits recorded for this donor's family yet.</p>}
    {items.map((item) => {
      const occurrence = occurrenceLabel(item.hebrewMonth, item.hebrewDay, timezone);
      if (editingId === item.id) {
        return <YahrtzeitForm key={item.id} donorId={donorId} timezone={timezone} initial={toFormState(item)} yahrtzeitId={item.id} onDone={() => window.location.reload()} onCancel={() => setEditingId(null)} />;
      }
      return <article key={item.id} className="yahrtzeit-item">
        <div className="yahrtzeit-item-main">
          <p className="yahrtzeit-item-relationship">{item.relationship}</p>
          <p className="yahrtzeit-item-name">{item.deceasedNameEnglish}{item.deceasedNameHebrew ? ` · ${item.deceasedNameHebrew}` : ""}</p>
          <p className="yahrtzeit-item-date">{item.hebrewDay} {item.hebrewMonth}{item.hebrewYear ? ` ${item.hebrewYear}` : ""}{occurrence && <> · Next occurrence: <strong>{occurrence.formatted}</strong></>}</p>
          {occurrence?.ambiguous && <p className="capture-error">{occurrence.note}</p>}
        </div>
        <div className="yahrtzeit-item-actions">
          <button type="button" onClick={() => setEditingId(item.id)}>Edit</button>
          <button type="button" disabled={deletingId === item.id} onClick={() => void remove(item.id, item.deceasedNameEnglish)}>{deletingId === item.id ? "Deleting…" : "Delete"}</button>
        </div>
      </article>;
    })}
    {error && <p className="capture-error" role="alert">{error}</p>}
    {adding
      ? <YahrtzeitForm donorId={donorId} timezone={timezone} initial={EMPTY_FORM} onDone={() => window.location.reload()} onCancel={() => setAdding(false)} />
      : <button type="button" onClick={() => setAdding(true)}>+ Add a yahrtzeit</button>}
  </div>;
}
