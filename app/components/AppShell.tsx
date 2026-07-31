import Link from "next/link";
import type { ReactNode } from "react";

export function AppShell({ children, active }: { children: ReactNode; active: "today" | "donors" | "assistant" | "help" | "settings" }) {
  return <div className="app-shell">
    <aside className="sidebar">
      <Link className="brand" href="/"><span className="brand-mark">F</span><span>Fundraising OS</span></Link>
      <nav className="nav" aria-label="Primary navigation">
        <Link className={active === "today" ? "active" : ""} href="/"><span className="nav-icon">☀</span>Today</Link>
        <Link className={active === "donors" ? "active" : ""} href="/donors"><span className="nav-icon">◉</span>Donors</Link>
        <Link className={active === "assistant" ? "active" : ""} href="/assistant"><span className="nav-icon">✦</span>Assistant</Link>
      </nav>
      <div className="sidebar-bottom">
        <Link className={`secondary-link ${active === "help" ? "active" : ""}`} href="/help"><span>?</span>Help & resources</Link>
        <Link className={`secondary-link ${active === "settings" ? "active" : ""}`} href="/settings"><span>⚙</span>Settings</Link>
        <div className="profile"><div className="profile-avatar">SM</div><div><strong>Sarah Mitchell</strong><span>Development Director</span></div><button aria-label="Open profile menu">•••</button></div>
      </div>
    </aside>
    <div className="content">{children}</div>
  </div>;
}
