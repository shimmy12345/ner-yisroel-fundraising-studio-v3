"use client";

import { useState } from "react";

export type ResearchSourceView = { url: string; title: string; publisher: string | null; publishedAt: number | null; sourceTier: string };
export type ResearchFindingView = { id: string; category: string; claim: string; status: "current" | "unverified"; relatedDonorName?: string | null; sources: ResearchSourceView[] };
export type PendingEvidenceView = { id: string; url: string; title: string };
export type IdentityCandidateView = { id: string; label: string; status: "pending" | "confirmed" | "rejected" };

const CATEGORY_LABELS: Record<string, string> = {
  professional: "Professional",
  boards_affiliations: "Boards & Affiliations",
  public_philanthropy: "Public Philanthropy",
  recent_mentions: "Recent Mentions",
  possible_connections: "Shared Public Affiliations",
  notes_ambiguities: "Research Notes / Ambiguities",
};
const CATEGORY_ORDER = ["professional", "boards_affiliations", "public_philanthropy", "recent_mentions", "possible_connections", "notes_ambiguities"];
const TIER_LABELS: Record<string, string> = { primary_institutional: "Company/org's own page", press_release: "Press release / wire", reputable_news: "News article", event_program: "Event/program page", public_search_result: "Search result (e.g. LinkedIn)" };
const month = (epoch: number) => new Intl.DateTimeFormat("en-US", { month: "short", year: "numeric" }).format(new Date(epoch * 1000));

export function DonorResearch({ donorId, lastResearchedAt, openRun, findings }: {
  donorId: string;
  lastResearchedAt: number | null;
  openRun: { id: string; pendingEvidence: PendingEvidenceView[]; candidates: IdentityCandidateView[] } | null;
  findings: ResearchFindingView[];
}) {
  const [status, setStatus] = useState<"idle" | "saving" | "error">("idle");
  const [message, setMessage] = useState("");
  const [starting, setStarting] = useState(Boolean(openRun));
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const [snippet, setSnippet] = useState("");
  const [publishedAt, setPublishedAt] = useState("");
  const [tierChoices, setTierChoices] = useState<Record<string, string>>({});
  const [orgChoices, setOrgChoices] = useState<Record<string, string>>({});

  async function post(body: Record<string, unknown>) {
    setStatus("saving"); setMessage("");
    try {
      const response = await fetch(`/api/research/${encodeURIComponent(donorId)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error || "The research action could not be completed.");
      window.setTimeout(() => window.location.reload(), 400);
    } catch (error) {
      setStatus("error"); setMessage(error instanceof Error ? error.message : "The research action could not be completed.");
    }
  }

  const pendingCandidate = openRun?.candidates.find((candidate) => candidate.status === "pending");
  const grouped = CATEGORY_ORDER.map((category) => ({ category, items: findings.filter((finding) => finding.category === category) })).filter((group) => group.items.length > 0);

  return <section className="story-card donor-research-card" aria-labelledby="donor-research-title">
    <div className="card-heading"><div><p className="eyebrow">PUBLIC RESEARCH</p><h2 id="donor-research-title">Donor Research</h2>{lastResearchedAt && <span className="updated">Last researched {month(lastResearchedAt)}</span>}</div></div>

    {!starting && grouped.length === 0 && <>
      <p className="summary">Build a source-backed research brief from publicly available information -- company pages, board listings, press releases, reputable news, and public search results. Nothing is fetched automatically; you add what you find.</p>
      <button type="button" className="research-start-button" onClick={() => setStarting(true)}>Research this donor</button>
    </>}

    {starting && !pendingCandidate && <div className="research-evidence-entry">
      <p className="field-help">Add each public source you found. A URL and title are required.</p>
      {openRun && openRun.pendingEvidence.length > 0 && <ul className="research-pending-list">{openRun.pendingEvidence.map((item) => <li key={item.id}><strong>{item.title}</strong><span>{item.url}</span></li>)}</ul>}
      <div className="research-evidence-form">
        <label>Source URL<input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://example.org/leadership" /></label>
        <label>Title<input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Page or article title" /></label>
        <label>Snippet <span>optional</span><textarea value={snippet} onChange={(event) => setSnippet(event.target.value)} maxLength={500} /></label>
        <label>Published date <span>optional</span><input type="date" value={publishedAt} onChange={(event) => setPublishedAt(event.target.value)} /></label>
        <button type="button" disabled={!url || !title || status === "saving"} onClick={() => void post({ action: "add_evidence", runId: openRun?.id, url, title, snippet, publishedAt: publishedAt || undefined }).then(() => { setUrl(""); setTitle(""); setSnippet(""); setPublishedAt(""); })}>Add source</button>
      </div>
      {openRun && openRun.pendingEvidence.length > 0 && <button type="button" className="research-propose-button" disabled={status === "saving"} onClick={() => void post({ action: "propose_identity", runId: openRun.id })}>I've added everything -- review identity</button>}
      {openRun && <button type="button" className="text-button" disabled={status === "saving"} onClick={() => void post({ action: "discard_run", runId: openRun.id })}>Discard this research attempt</button>}
    </div>}

    {pendingCandidate && openRun && <div className="research-identity-confirm">
      <p className="eyebrow">CONFIRM IDENTITY</p>
      <p className="summary">{pendingCandidate.label}</p>
      <p className="field-help">Confirm this is the right person before any finding is recorded. Choose where each source came from -- Professional and Boards & Affiliations claims need more than a search-result-only source to be shown as confirmed.</p>
      {openRun.pendingEvidence.map((item) => <div className="research-tier-row" key={item.id}>
        <strong>{item.title}</strong>
        <select value={tierChoices[item.id] ?? ""} onChange={(event) => setTierChoices((current) => ({ ...current, [item.id]: event.target.value }))}>
          <option value="">Where did you find this?</option>
          {Object.entries(TIER_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
        <input placeholder="Organization (optional)" value={orgChoices[item.id] ?? ""} onChange={(event) => setOrgChoices((current) => ({ ...current, [item.id]: event.target.value }))} />
      </div>)}
      <div className="research-identity-actions">
        <button type="button" disabled={status === "saving"} onClick={() => void post({ action: "decide_identity", runId: openRun.id, candidateId: pendingCandidate.id, decision: "rejected" })}>Not the right person</button>
        <button type="button" className="research-confirm-button" disabled={status === "saving" || openRun.pendingEvidence.some((item) => !tierChoices[item.id])} onClick={() => void post({ action: "decide_identity", runId: openRun.id, candidateId: pendingCandidate.id, decision: "confirmed", evidence: openRun.pendingEvidence.map((item) => ({ pendingEvidenceId: item.id, sourceTier: tierChoices[item.id], organization: orgChoices[item.id] })) })}>Confirm identity</button>
      </div>
    </div>}

    {grouped.length > 0 && <div className="research-findings">
      {grouped.map(({ category, items }) => <div className="research-section" key={category}>
        <h3>{CATEGORY_LABELS[category]}</h3>
        {items.map((finding) => <article className="research-finding" key={finding.id}>
          <p className="research-claim">{finding.claim}{finding.status === "unverified" && <span className="research-unverified-tag">Unverified</span>}{finding.relatedDonorName && <span> ({finding.relatedDonorName})</span>}</p>
          {finding.sources.map((source, index) => <p className="research-source" key={index}><a href={source.url} target="_blank" rel="noreferrer">Source: {source.publisher || source.title}</a>{source.publishedAt && <span> · {month(source.publishedAt)}</span>}</p>)}
        </article>)}
      </div>)}
      {!starting && <button type="button" className="research-start-button" onClick={() => setStarting(true)}>Refresh research</button>}
    </div>}

    {message && <p className={status === "error" ? "research-error" : "research-message"} role="status">{message}</p>}
  </section>;
}
