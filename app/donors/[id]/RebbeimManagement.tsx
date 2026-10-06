"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";

export type DonorRebbiItem = { id: string; displayName: string };
export type CanonicalRebbi = { id: string; displayName: string };

// Compact donor-page section: zero, one, or many chips, each removable,
// plus a search-to-add control restricted to the canonical directory (see
// docs/AI-HANDOFF.md's "Donor Rebbeim" entry for why V1 does not support
// creating a new canonical Rebbi inline here). No status/notes/strength
// fields -- the relationship is binary, matching the product boundary.
export function RebbeimManagement({ donorId, items, canonical }: { donorId: string; items: DonorRebbiItem[]; canonical: CanonicalRebbi[] }) {
  const router = useRouter();
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState("");
  const [saving, setSaving] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [error, setError] = useState("");

  const connectedIds = useMemo(() => new Set(items.map((item) => item.id)), [items]);
  const matches = useMemo(() => {
    const trimmed = query.trim().toLowerCase();
    const available = canonical.filter((rebbi) => !connectedIds.has(rebbi.id));
    if (!trimmed) return available.slice(0, 8);
    return available.filter((rebbi) => rebbi.displayName.toLowerCase().includes(trimmed)).slice(0, 8);
  }, [query, canonical, connectedIds]);

  async function add(rebbiId: string) {
    setSaving(true); setError("");
    try {
      const response = await fetch(`/api/donors/${encodeURIComponent(donorId)}/rebbeim`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ rebbiId }) });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error || "The Rebbi could not be added.");
      setQuery(""); setAdding(false);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The Rebbi could not be added.");
    } finally {
      setSaving(false);
    }
  }

  async function remove(item: DonorRebbiItem) {
    if (!window.confirm(`Remove ${item.displayName} from this donor's Rebbeim? This only removes the relationship -- ${item.displayName} remains in the directory.`)) return;
    setRemovingId(item.id); setError("");
    try {
      const response = await fetch(`/api/donors/${encodeURIComponent(donorId)}/rebbeim/${encodeURIComponent(item.id)}`, { method: "DELETE" });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error || "The relationship could not be removed.");
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The relationship could not be removed.");
    } finally {
      setRemovingId(null);
    }
  }

  return <div className="rebbeim-management">
    {items.length === 0 && !adding && <p className="rebbeim-empty">No Rebbeim recorded for this donor yet.</p>}
    {items.length > 0 && <div className="rebbeim-chips">
      {items.map((item) => <span key={item.id} className="rebbeim-chip">
        {item.displayName}
        <button type="button" aria-label={`Remove ${item.displayName}`} disabled={removingId === item.id} onClick={() => void remove(item)}>{removingId === item.id ? "…" : "×"}</button>
      </span>)}
    </div>}
    {error && <p className="capture-error" role="alert">{error}</p>}
    {!adding && <button type="button" className="secondary-button add-rebbi-button" onClick={() => setAdding(true)}>+ Add Rebbi</button>}
    {adding && <div className="rebbeim-add">
      <input type="text" autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search the Rebbeim directory…" onKeyDown={(event) => { if (event.key === "Escape") { setAdding(false); setQuery(""); } }} />
      <div className="rebbeim-add-results">
        {matches.length === 0 && <p className="rebbeim-add-empty">No match in the directory.</p>}
        {matches.map((rebbi) => <button type="button" key={rebbi.id} disabled={saving} onClick={() => void add(rebbi.id)}>{rebbi.displayName}</button>)}
      </div>
      <button type="button" className="rebbeim-add-cancel" onClick={() => { setAdding(false); setQuery(""); setError(""); }}>Cancel</button>
    </div>}
  </div>;
}
