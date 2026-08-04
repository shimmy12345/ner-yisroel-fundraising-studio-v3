"use client";
import { useMemo, useState } from "react";
import { MERGE_FIELD_GROUPS, type MergeFieldGroup } from "../../../../lib/donors/merge";

type DonorOption = { id: string; name: string; code: string | null };
type MergeView = DonorOption & { fields: Record<MergeFieldGroup, string>; counts: Record<string, number> };
const labels: Record<MergeFieldGroup, string> = { name: "Name", spouse: "Spouse", jlCode: "JL Code", email: "Email", phones: "Phones", address: "Address", notes: "Notes" };

export function MergeExperience({ current, other, donors }: { current: MergeView; other: MergeView | null; donors: DonorOption[] }) {
  const [selectedOther, setSelectedOther] = useState(other?.id ?? "");
  const [survivorId, setSurvivorId] = useState(current.id);
  const [choices, setChoices] = useState<Record<MergeFieldGroup, string>>(() => Object.fromEntries(MERGE_FIELD_GROUPS.map((field) => [field, field === "jlCode" && !current.fields.jlCode && other?.fields.jlCode ? other.id : current.id])) as Record<MergeFieldGroup, string>);
  const [confirmed, setConfirmed] = useState(false); const [loading, setLoading] = useState(false); const [error, setError] = useState("");
  const duplicateId = other ? (survivorId === current.id ? other.id : current.id) : "";
  const totalMoving = useMemo(() => other ? Object.values((duplicateId === current.id ? current : other).counts).reduce((sum, value) => sum + value, 0) : 0, [current, other, duplicateId]);
  function openComparison() { if (selectedOther) window.location.href = `/donors/${encodeURIComponent(current.id)}/resolve-duplicate?otherId=${encodeURIComponent(selectedOther)}`; }
  async function merge() {
    if (!other || loading || !confirmed) return; setLoading(true); setError("");
    try {
      const response = await fetch("/api/donors/merge", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ survivingDonorId: survivorId, duplicateDonorId: duplicateId, fieldChoices: choices, source: "donor_page" }) });
      const result = await response.json() as { error?: string; href?: string };
      if (!response.ok || !result.href) throw new Error(result.error || "The merge could not be completed.");
      window.location.href = result.href;
    } catch (problem) { setError(problem instanceof Error ? problem.message : "The merge could not be completed."); setLoading(false); }
  }
  return <main className="merge-workspace">
    <header><p className="eyebrow">DUPLICATE RESOLUTION</p><h1>Resolve duplicate donor</h1><p>Compare two records, choose the surviving donor, and keep every piece of relationship history.</p></header>
    <section className="merge-picker"><label><span>Compare with</span><select value={selectedOther} onChange={(event) => setSelectedOther(event.target.value)}><option value="">Choose another donor</option>{donors.map((donor) => <option value={donor.id} key={donor.id}>{donor.name}{donor.code ? ` · JL ${donor.code}` : ""}</option>)}</select></label><button type="button" disabled={!selectedOther} onClick={openComparison}>Compare records</button></section>
    {other && <>
      <section className="merge-survivor"><h2>Which donor should survive?</h2>{[current, other].map((donor) => <label key={donor.id}><input type="radio" name="survivor" checked={survivorId === donor.id} onChange={() => { setSurvivorId(donor.id); setConfirmed(false); }} /><span><strong>{donor.name}</strong><small>{donor.code ? `JL ${donor.code}` : "Manual donor"}</small></span></label>)}</section>
      <section className="merge-comparison"><div className="merge-table-heading"><h2>Choose the value to keep</h2><p>Every field remains editable until you confirm.</p></div>{MERGE_FIELD_GROUPS.map((field) => <fieldset key={field}><legend>{labels[field]}</legend>{[current, other].map((donor) => { const unavailableCode = field === "jlCode" && !donor.fields.jlCode && Boolean((donor.id === current.id ? other : current).fields.jlCode); return <label key={donor.id}><input type="radio" name={field} disabled={unavailableCode} checked={choices[field] === donor.id} onChange={() => setChoices((value) => ({ ...value, [field]: donor.id }))} /><span><strong>{donor.name}</strong><small>{donor.fields[field] || (unavailableCode ? "No JL Code — the existing code must be preserved" : "Not supplied")}</small></span></label>; })}</fieldset>)}</section>
      <section className="merge-history"><h2>History that will be preserved</h2><div>{[current, other].map((donor) => <article key={donor.id}><strong>{donor.name}</strong>{Object.entries(donor.counts).map(([label, count]) => <span key={label}>{label}: {count}</span>)}</article>)}</div><p>All gifts, pledges, interactions, meetings, reminders, notes, and audit records will move to the survivor. The duplicate will be archived and old links will redirect.</p></section>
      <section className="merge-confirm"><label><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /> I reviewed the survivor and every field choice. Archive the duplicate after moving its history.</label><button className="danger" type="button" disabled={!confirmed || loading} onClick={() => void merge()}>{loading ? "Merging records…" : `Merge records · move ${totalMoving} linked item${totalMoving === 1 ? "" : "s"}`}</button>{error && <p className="onboarding-error" role="alert">{error}</p>}</section>
    </>}
  </main>;
}
