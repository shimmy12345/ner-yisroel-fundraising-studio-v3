"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { HEBREW_MONTHS, isPlausibleHebrewDate, nextYahrtzeitOccurrence, type HebrewMonthName } from "../../../lib/calendar/hebrew-date.ts";
import { isPlausibleGregorianDate, nextGregorianRecurrence, yearsSinceForOccurrence } from "../../../lib/calendar/gregorian-recurring-date.ts";

const GREGORIAN_MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export type YahrtzeitListItem = { id: string; kind: "yahrtzeit"; deceasedNameEnglish: string; deceasedNameHebrew: string | null; relationship: string; hebrewMonth: HebrewMonthName; hebrewDay: number; hebrewYear: number | null };
export type ImportantDateListItem = { id: string; kind: "birthday" | "anniversary"; personName: string | null; relationship: string | null; month: number; day: number; year: number | null; notes: string | null };
export type ManagedDateItem = YahrtzeitListItem | ImportantDateListItem;

type AddState = null | "choose" | "yahrtzeit" | "birthday" | "anniversary";

type YahrtzeitFormState = {
  deceasedNameEnglish: string;
  deceasedNameHebrew: string;
  relationship: string;
  hebrewMonth: HebrewMonthName | "";
  hebrewDay: string;
  hebrewYear: string;
};

type ImportantDateFormState = {
  personName: string;
  relationship: string;
  month: string;
  day: string;
  year: string;
  notes: string;
};

const EMPTY_YAHRTZEIT_FORM: YahrtzeitFormState = { deceasedNameEnglish: "", deceasedNameHebrew: "", relationship: "", hebrewMonth: "", hebrewDay: "", hebrewYear: "" };
const EMPTY_IMPORTANT_DATE_FORM: ImportantDateFormState = { personName: "", relationship: "", month: "", day: "", year: "", notes: "" };

function yahrtzeitToFormState(item: YahrtzeitListItem): YahrtzeitFormState {
  return {
    deceasedNameEnglish: item.deceasedNameEnglish,
    deceasedNameHebrew: item.deceasedNameHebrew ?? "",
    relationship: item.relationship,
    hebrewMonth: item.hebrewMonth,
    hebrewDay: String(item.hebrewDay),
    hebrewYear: item.hebrewYear ? String(item.hebrewYear) : "",
  };
}

function importantDateToFormState(item: ImportantDateListItem): ImportantDateFormState {
  return {
    personName: item.personName ?? "",
    relationship: item.relationship ?? "",
    month: String(item.month),
    day: String(item.day),
    year: item.year ? String(item.year) : "",
    notes: item.notes ?? "",
  };
}

function yahrtzeitOccurrenceLabel(month: HebrewMonthName, day: number, timezone: string) {
  if (!isPlausibleHebrewDate(month, day)) return null;
  try {
    const occurrence = nextYahrtzeitOccurrence(month, day, timezone, Math.floor(Date.now() / 1000));
    const formatted = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" }).format(new Date(occurrence.primary.gregorianEpoch * 1000));
    return { formatted, ambiguous: occurrence.ambiguous, note: occurrence.ambiguityNote, epoch: occurrence.primary.gregorianEpoch };
  } catch {
    return null;
  }
}

function gregorianOccurrenceLabel(month: number, day: number, year: number | null, timezone: string) {
  if (!isPlausibleGregorianDate(month, day)) return null;
  try {
    const occurrence = nextGregorianRecurrence(month, day, timezone, Math.floor(Date.now() / 1000));
    const formatted = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" }).format(new Date(occurrence.primary.gregorianEpoch * 1000));
    const derivedYears = year !== null ? yearsSinceForOccurrence(occurrence.primary.year, year) : null;
    return { formatted, ambiguous: occurrence.ambiguous, note: occurrence.ambiguityNote, epoch: occurrence.primary.gregorianEpoch, derivedYears };
  } catch {
    return null;
  }
}

function YahrtzeitForm({ donorId, timezone, initial, itemId, onDone, onCancel }: { donorId: string; timezone: string; initial: YahrtzeitFormState; itemId?: string; onDone: () => void; onCancel: () => void }) {
  const [form, setForm] = useState<YahrtzeitFormState>(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const day = Number(form.hebrewDay);
  const preview = form.hebrewMonth && Number.isInteger(day) && day > 0 ? yahrtzeitOccurrenceLabel(form.hebrewMonth, day, timezone) : null;

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
      const url = itemId ? `/api/yahrtzeits/${encodeURIComponent(itemId)}` : `/api/donors/${encodeURIComponent(donorId)}/yahrtzeits`;
      const response = await fetch(url, { method: itemId ? "PATCH" : "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
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
      <button type="button" className="onboarding-primary" disabled={saving} onClick={() => void save()}>{saving ? "Saving…" : itemId ? "Save changes" : "Add yahrtzeit"}</button>
      <button type="button" onClick={onCancel} disabled={saving}>Cancel</button>
    </div>
  </div>;
}

function ImportantDateForm({ donorId, timezone, type, initial, itemId, onDone, onCancel }: { donorId: string; timezone: string; type: "birthday" | "anniversary"; initial: ImportantDateFormState; itemId?: string; onDone: () => void; onCancel: () => void }) {
  const [form, setForm] = useState<ImportantDateFormState>(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const month = Number(form.month);
  const day = Number(form.day);
  const year = form.year ? Number(form.year) : null;
  const preview = Number.isInteger(month) && month > 0 && Number.isInteger(day) && day > 0 ? gregorianOccurrenceLabel(month, day, year, timezone) : null;

  async function save() {
    if (saving) return;
    setSaving(true); setError("");
    try {
      const body = {
        type,
        personName: type === "birthday" ? form.personName : undefined,
        relationship: form.relationship || undefined,
        month: Number.isInteger(month) ? month : undefined,
        day: Number.isInteger(day) ? day : undefined,
        year,
        notes: form.notes || undefined,
      };
      const url = itemId ? `/api/important-dates/${encodeURIComponent(itemId)}` : `/api/donors/${encodeURIComponent(donorId)}/important-dates`;
      const response = await fetch(url, { method: itemId ? "PATCH" : "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error || `The ${type} could not be saved.`);
      onDone();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : `The ${type} could not be saved.`);
    } finally {
      setSaving(false);
    }
  }

  return <div className="yahrtzeit-form">
    {type === "birthday" && <label>Whose birthday<input type="text" value={form.personName} onChange={(event) => setForm({ ...form, personName: event.target.value })} placeholder="e.g. the donor, a spouse, a child" /></label>}
    <label>Relationship to donor (optional)<input type="text" value={form.relationship} onChange={(event) => setForm({ ...form, relationship: event.target.value })} placeholder={type === "birthday" ? "e.g. Donor, Spouse, Child" : "optional context"} /></label>
    <div className="yahrtzeit-form-date">
      <label>Month
        <select value={form.month} onChange={(event) => setForm({ ...form, month: event.target.value })}>
          <option value="">Choose…</option>
          {GREGORIAN_MONTHS.map((label, index) => <option key={label} value={index + 1}>{label}</option>)}
        </select>
      </label>
      <label>Day<input type="number" min={1} max={31} value={form.day} onChange={(event) => setForm({ ...form, day: event.target.value })} /></label>
      <label>Year (optional)<input type="number" value={form.year} onChange={(event) => setForm({ ...form, year: event.target.value })} placeholder={type === "birthday" ? "e.g. 1985" : "e.g. 2010"} /></label>
    </div>
    {preview && <p className="yahrtzeit-form-preview">
      Next occurrence: <strong>{preview.formatted}</strong>
      {preview.derivedYears !== null && <> ({type === "birthday" ? `turning ${preview.derivedYears}` : `${preview.derivedYears} year${preview.derivedYears === 1 ? "" : "s"} married`})</>}
      {preview.ambiguous && <span className="capture-error"> — {preview.note}</span>}
    </p>}
    {error && <p className="capture-error" role="alert">{error}</p>}
    <div className="yahrtzeit-form-actions">
      <button type="button" className="onboarding-primary" disabled={saving} onClick={() => void save()}>{saving ? "Saving…" : itemId ? "Save changes" : `Add ${type}`}</button>
      <button type="button" onClick={onCancel} disabled={saving}>Cancel</button>
    </div>
  </div>;
}

function itemOccurrence(item: ManagedDateItem, timezone: string) {
  return item.kind === "yahrtzeit" ? yahrtzeitOccurrenceLabel(item.hebrewMonth, item.hebrewDay, timezone) : gregorianOccurrenceLabel(item.month, item.day, item.year, timezone);
}

type ItemOccurrence = ReturnType<typeof itemOccurrence>;

function ManagedDateRow({ item, occurrence, onEdit, onDelete, deleting }: { item: ManagedDateItem; occurrence: ItemOccurrence; onEdit: () => void; onDelete: () => void; deleting: boolean }) {
  const eyebrow = item.kind === "yahrtzeit" ? item.relationship : item.kind === "birthday" ? "Birthday" : "Anniversary";
  const name = item.kind === "yahrtzeit"
    ? `${item.deceasedNameEnglish}${item.deceasedNameHebrew ? ` · ${item.deceasedNameHebrew}` : ""}`
    : item.kind === "birthday"
      ? `${item.personName || "Unnamed"}${item.relationship ? ` · ${item.relationship}` : ""}`
      : "Wedding anniversary";
  const recordedLabel = item.kind === "yahrtzeit" ? `${item.hebrewDay} ${item.hebrewMonth}${item.hebrewYear ? ` ${item.hebrewYear}` : ""}` : `${GREGORIAN_MONTHS[item.month - 1]} ${item.day}${item.year ? `, ${item.year}` : ""}`;
  const derivedYearsSuffix = occurrence && "derivedYears" in occurrence && occurrence.derivedYears !== null
    ? ` (${item.kind === "birthday" ? `turning ${occurrence.derivedYears}` : `${occurrence.derivedYears} year${occurrence.derivedYears === 1 ? "" : "s"} married`})`
    : "";
  const deleteConfirmName = item.kind === "yahrtzeit" ? item.deceasedNameEnglish : item.kind === "birthday" ? (item.personName || "this person") : "this anniversary";
  return <article className="yahrtzeit-item">
    <div className="yahrtzeit-item-main">
      <p className="yahrtzeit-item-relationship">{eyebrow}</p>
      <p className="yahrtzeit-item-name">{name}</p>
      <p className="yahrtzeit-item-date">{recordedLabel}{occurrence && <> · Next occurrence: <strong>{occurrence.formatted}</strong>{derivedYearsSuffix}</>}</p>
      {occurrence?.ambiguous && <p className="capture-error">{occurrence.note}</p>}
    </div>
    <div className="yahrtzeit-item-actions">
      <button type="button" onClick={onEdit}>Edit</button>
      <button type="button" disabled={deleting} onClick={() => { if (window.confirm(`Delete this record for ${deleteConfirmName}? This cannot be undone from here, though the change is kept in the audit history.`)) onDelete(); }}>{deleting ? "Deleting…" : "Delete"}</button>
    </div>
  </article>;
}

export function ImportantDatesManagement({ donorId, timezone, items }: { donorId: string; timezone: string; items: ManagedDateItem[] }) {
  const router = useRouter();
  const [adding, setAdding] = useState<AddState>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [error, setError] = useState("");

  // UX cleanup, independent of the Error 1102 investigation: a scoped
  // router.refresh() re-renders this route's server data in place (no
  // full document navigation, no re-fetch/re-parse of already-loaded JS/
  // CSS, no scroll-position or unrelated-disclosure-state reset elsewhere
  // on the page) instead of window.location.reload()'s full hard reload.
  // It triggers the exact same server-side render (same D1 queries, same
  // recommendation-evidence computation) as a reload's GET would -- this
  // is not a resource-limit fix, only a lighter browser-side navigation.
  // Local form/list state that a full reload used to reset for free by
  // remounting everything must be reset explicitly here instead.
  function doneEditing() {
    setEditingId(null);
    router.refresh();
  }
  function doneAdding() {
    setAdding(null);
    router.refresh();
  }

  // Each item's occurrence is calculated exactly once per item here, then
  // reused for both sorting and rendering below -- never recomputed inside
  // the sort comparator (which would run it O(N log N) times) or a second
  // time per row. Recalculated fresh whenever items/timezone actually
  // change (useMemo's dependency array), never a stale cross-render cache.
  const sorted = useMemo(() => {
    const withOccurrence = items.map((item) => ({ item, occurrence: itemOccurrence(item, timezone) }));
    return withOccurrence.sort((a, b) => (a.occurrence?.epoch ?? Number.MAX_SAFE_INTEGER) - (b.occurrence?.epoch ?? Number.MAX_SAFE_INTEGER));
  }, [items, timezone]);

  async function remove(item: ManagedDateItem) {
    setDeletingId(item.id); setError("");
    try {
      const url = item.kind === "yahrtzeit" ? `/api/yahrtzeits/${encodeURIComponent(item.id)}` : `/api/important-dates/${encodeURIComponent(item.id)}`;
      const response = await fetch(url, { method: "DELETE" });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error || "The record could not be deleted.");
      setDeletingId(null);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The record could not be deleted.");
      setDeletingId(null);
    }
  }

  return <div className="yahrtzeit-management">
    {sorted.length === 0 && adding === null && <p className="yahrtzeit-empty">No important dates recorded for this donor yet.</p>}
    {sorted.map(({ item, occurrence }) => {
      if (editingId === item.id) {
        return item.kind === "yahrtzeit"
          ? <YahrtzeitForm key={item.id} donorId={donorId} timezone={timezone} initial={yahrtzeitToFormState(item)} itemId={item.id} onDone={doneEditing} onCancel={() => setEditingId(null)} />
          : <ImportantDateForm key={item.id} donorId={donorId} timezone={timezone} type={item.kind} initial={importantDateToFormState(item)} itemId={item.id} onDone={doneEditing} onCancel={() => setEditingId(null)} />;
      }
      return <ManagedDateRow key={item.id} item={item} occurrence={occurrence} onEdit={() => setEditingId(item.id)} onDelete={() => void remove(item)} deleting={deletingId === item.id} />;
    })}
    {error && <p className="capture-error" role="alert">{error}</p>}
    {adding === null && <button type="button" className="secondary-button add-important-date-button" onClick={() => setAdding("choose")}>+ Add important date</button>}
    {adding === "choose" && <div className="yahrtzeit-form">
      <p>What kind of date?</p>
      <div className="yahrtzeit-form-actions">
        <button type="button" className="onboarding-primary" onClick={() => setAdding("birthday")}>Birthday</button>
        <button type="button" className="onboarding-primary" onClick={() => setAdding("anniversary")}>Anniversary</button>
        <button type="button" className="onboarding-primary" onClick={() => setAdding("yahrtzeit")}>Yahrtzeit</button>
        <button type="button" onClick={() => setAdding(null)}>Cancel</button>
      </div>
    </div>}
    {adding === "yahrtzeit" && <YahrtzeitForm donorId={donorId} timezone={timezone} initial={EMPTY_YAHRTZEIT_FORM} onDone={doneAdding} onCancel={() => setAdding(null)} />}
    {(adding === "birthday" || adding === "anniversary") && <ImportantDateForm donorId={donorId} timezone={timezone} type={adding} initial={EMPTY_IMPORTANT_DATE_FORM} onDone={doneAdding} onCancel={() => setAdding(null)} />}
  </div>;
}
