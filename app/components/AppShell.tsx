import Link from "next/link";
import type { ReactNode } from "react";
import { getChatGPTUser } from "../chatgpt-auth";
import { ensureUserProfile, initials } from "../../lib/auth/profile";
import { MobileMoreMenu } from "./MobileMoreMenu";

export async function AppShell({ children, active }: { children: ReactNode; active: "today" | "donors" | "import" | "assistant" | "help" | "settings" }) {
  const identity = await getChatGPTUser();
  const profile = identity ? await ensureUserProfile(identity) : null;
  return <div className="app-shell">
    <aside className="sidebar">
      <Link className="brand" href="/"><span className="brand-mark">F</span><span>Fundraising OS</span></Link>
      <nav className="nav" aria-label="Primary navigation">
        <Link className={active === "today" ? "active" : ""} href="/"><span className="nav-icon">☀</span>Today</Link>
        <a className={active === "donors" ? "active" : ""} href="/donors"><span className="nav-icon">◉</span>Donors</a>
        <Link className={active === "import" ? "active" : ""} href="/onboarding/import"><span className="nav-icon">⇧</span>Import</Link>
        <Link className={active === "assistant" ? "active" : ""} href="/assistant"><span className="nav-icon">✦</span>Assistant</Link>
        <MobileMoreMenu active={active} profile={profile ? { fullName: profile.fullName, roleLabel: profile.jobTitle || profile.organizationName || profile.email, avatarUrl: profile.avatarUrl, initials: initials(profile.fullName) } : null} />
      </nav>
      <div className="sidebar-bottom">
        <Link className={`secondary-link ${active === "help" ? "active" : ""}`} href="/help"><span>?</span>Help & resources</Link>
        <Link className={`secondary-link ${active === "settings" ? "active" : ""}`} href="/settings"><span>⚙</span>Settings</Link>
        {profile && <Link className="profile" href="/settings"><div className="profile-avatar">{profile.avatarUrl ? <img src={profile.avatarUrl} alt="" /> : initials(profile.fullName)}</div><div><strong>{profile.fullName}</strong><span>{profile.jobTitle || profile.organizationName || profile.email}</span></div><span aria-hidden="true">→</span></Link>}
      </div>
    </aside>
    <div className="content">{children}</div>
  </div>;
}
