import type { Metadata } from "next";
import { AppShell } from "../components/AppShell";
import { requireChatGPTUser } from "../chatgpt-auth";
import { ensureUserProfile } from "../../lib/auth/profile";
import { getDataMode } from "../../lib/workspace/mode";
import { computeFundraisingIntelligenceBrief } from "../../lib/fundraising-intelligence/compute";
import { buildIntelligenceBriefRows, type IntelligenceBriefRow } from "../../lib/fundraising-intelligence/dedicated-view";
import { FundraisingIntelligenceExperience } from "./FundraisingIntelligenceExperience";
import { logger } from "../../lib/logger";

export const metadata: Metadata = { title: "Fundraising Intelligence" };

export const dynamic = "force-dynamic";

// One call to the engine for the whole page -- the client component
// only groups/expands this same already-computed result, never
// recomputes it. Same live-mode gate and fail-soft behavior as
// Portfolio Focus's own dedicated page: a computation failure degrades
// to a restrained error state, never a broken shell, never fake/stale
// rows, and is always logged.
export default async function FundraisingIntelligencePage() {
  const identity = await requireChatGPTUser("/fundraising-intelligence");
  const profile = await ensureUserProfile(identity);
  const mode = await getDataMode(profile.id);
  const now = Math.floor(Date.now() / 1000);

  let rows: IntelligenceBriefRow[] = [];
  let failed = false;
  if (mode === "live") {
    try {
      const brief = await computeFundraisingIntelligenceBrief(profile.id, profile.timezone, now);
      rows = buildIntelligenceBriefRows(brief.items);
    } catch (error) {
      failed = true;
      logger.error("fundraising_intelligence_dedicated_load_failed", error, { userId: profile.id });
    }
  }

  return <AppShell active="today">
    <header className="page-header fib-header">
      <div>
        <p className="eyebrow">FUNDRAISING INTELLIGENCE</p>
        <h1>Fundraising Intelligence</h1>
        <p className="subhead">What deserves your attention right now, drawn from your current giving, pledges, asks, and relationship history -- computed fresh from current Fundraising OS data.</p>
        <p className="fib-tactical-distinction"><a href="/portfolio-focus">Portfolio Focus</a> tells you which relationships matter most. Fundraising Intelligence tells you what's changed and what's worth knowing or doing about them right now -- some relationships show up in both, and that's expected.</p>
      </div>
    </header>
    {failed
      ? <div className="pf-error"><strong>Fundraising Intelligence couldn&rsquo;t be computed right now.</strong><p>Nothing was changed and no data was affected. Try reloading the page.</p><a href="/fundraising-intelligence">Reload</a></div>
      : rows.length === 0
      ? <div className="pf-empty"><strong>Nothing significant needs your attention right now.</strong><p>Once new gifts, pledges, asks, or relationship activity come in, anything worth knowing or doing will appear here.</p></div>
      : <FundraisingIntelligenceExperience rows={rows} />}
  </AppShell>;
}
