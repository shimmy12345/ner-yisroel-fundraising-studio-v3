"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

type MoreProfile = { fullName: string; roleLabel: string; avatarUrl: string; initials: string };

// The sidebar's Help/Settings links and profile row are hidden entirely
// below 760px (see .sidebar-bottom) and there is no other way to reach
// them on mobile. This adds a 5th bottom-tab entry that opens a small
// sheet with those same destinations, instead of cramming them into the
// primary tab row.
export function MobileMoreMenu({ active, profile }: { active: "today" | "donors" | "import" | "assistant" | "help" | "settings"; profile: MoreProfile | null }) {
  const [open, setOpen] = useState(false);
  const highlighted = active === "help" || active === "settings";

  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent) { if (event.key === "Escape") setOpen(false); }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  return <>
    <button type="button" className={`nav-more ${highlighted ? "active" : ""}`} aria-haspopup="true" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
      <span className="nav-icon" aria-hidden="true">⋯</span>More
    </button>
    {open && <>
      <button type="button" className="nav-more-backdrop" aria-label="Close menu" onClick={() => setOpen(false)} />
      <nav className="nav-more-panel" aria-label="More navigation">
        <Link href="/help" onClick={() => setOpen(false)} className={active === "help" ? "active" : ""}><span>?</span>Help & resources</Link>
        <Link href="/settings" onClick={() => setOpen(false)} className={active === "settings" ? "active" : ""}><span>⚙</span>Settings</Link>
        {profile && <Link className="nav-more-profile" href="/settings" onClick={() => setOpen(false)}>
          <div className="profile-avatar">{profile.avatarUrl ? <img src={profile.avatarUrl} alt="" /> : profile.initials}</div>
          <div><strong>{profile.fullName}</strong><span>{profile.roleLabel}</span></div>
        </Link>}
      </nav>
    </>}
  </>;
}
