import type { Metadata } from "next";
import { AppShell } from "../components/AppShell";
import { requireChatGPTUser } from "../chatgpt-auth";
import { ensureUserProfile } from "../../lib/auth/profile";
import { getDataMode } from "../../lib/workspace/mode";
import { computePortfolioFocus } from "../../lib/portfolio-focus/index";
import { buildDedicatedPortfolioFocusRows, type DedicatedPortfolioFocusRow } from "../../lib/portfolio-focus/dedicated-view";
import { PortfolioFocusExperience } from "./PortfolioFocusExperience";
import { logger } from "../../lib/logger";

export const metadata: Metadata = { title: "Portfolio Focus" };

export const dynamic = "force-dynamic";

export default async function PortfolioFocusPage() {
  const identity = await requireChatGPTUser("/portfolio-focus");
  const profile = await ensureUserProfile(identity);
  const mode = await getDataMode(profile.id);
  const now = Math.floor(Date.now() / 1000);

  // One call to the engine for the whole page -- the client
  // component (PortfolioFocusExperience) only filters/slices this same
  // already-scored result, never recomputes it. Same live-mode gate and
  // fail-soft behavior as the Phase 2A Today section: a computation
  // failure degrades to a restrained error state, never a broken shell,
  // never fake/stale rows, and is always logged.
  let rows: DedicatedPortfolioFocusRow[] = [];
  let failed = false;
  if (mode === "live") {
    try {
      const results = await computePortfolioFocus(profile.id, profile.timezone, now);
      rows = buildDedicatedPortfolioFocusRows(results);
    } catch (error) {
      failed = true;
      logger.error("portfolio_focus_dedicated_load_failed", error, { userId: profile.id });
    }
  }

  return <AppShell active="today">
    <header className="page-header portfolio-focus-header">
      <div>
        <p className="eyebrow">STRATEGIC FOCUS</p>
        <h1>Portfolio Focus</h1>
        <p className="subhead">Where your limited fundraising attention may matter most over the next 30 days, based on financial significance, opportunity, stewardship, momentum, relationship context, and current tactical signals.</p>
        <p className="portfolio-focus-tactical-distinction">Portfolio Focus tells you where to focus. <a href="/">Suggested Actions</a> tells you what to do next -- some relationships show up in both, and that's expected.</p>
      </div>
    </header>
    {failed
      ? <div className="pf-error"><strong>Portfolio Focus couldn&rsquo;t be computed right now.</strong><p>Nothing was changed and no data was affected. Try reloading the page.</p><a href="/portfolio-focus">Reload</a></div>
      : rows.length === 0
      ? <div className="pf-empty"><strong>Portfolio Focus doesn&rsquo;t have enough eligible data yet</strong><p>Once live donor, giving, and relationship data exists, ranked relationships worth your attention will appear here.</p></div>
      : <PortfolioFocusExperience rows={rows} />}
  </AppShell>;
}
