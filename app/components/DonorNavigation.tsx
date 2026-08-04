"use client";

import { useEffect } from "react";
import type { MouseEvent, ReactNode } from "react";

const STORAGE_PREFIX = "fundraising-os:donor-return:";
const MAX_AGE_MS = 6 * 60 * 60 * 1_000;

function currentRelativeUrl() {
  return `${window.location.pathname}${window.location.search}${window.location.hash}`;
}

export function rememberDonorOrigin(returnTo = currentRelativeUrl()) {
  try {
    sessionStorage.setItem(`${STORAGE_PREFIX}${returnTo}`, JSON.stringify({ scrollY: window.scrollY, savedAt: Date.now() }));
  } catch {
    // Navigation remains usable when storage is unavailable.
  }
}

export function DonorOriginLink({ href, className, children }: { href: string; className?: string; children: ReactNode }) {
  function remember(event: MouseEvent<HTMLAnchorElement>) {
    if (event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) rememberDonorOrigin();
  }
  return <a className={className} href={href} onClick={remember}>{children}</a>;
}

export function DonorDirectoryPosition({ returnPath }: { returnPath: string }) {
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(`${STORAGE_PREFIX}${returnPath}`);
      if (!raw) return;
      const saved = JSON.parse(raw) as { scrollY?: number; savedAt?: number };
      if (typeof saved.scrollY !== "number" || typeof saved.savedAt !== "number" || Date.now() - saved.savedAt > MAX_AGE_MS) {
        sessionStorage.removeItem(`${STORAGE_PREFIX}${returnPath}`);
        return;
      }
      requestAnimationFrame(() => window.scrollTo({ top: saved.scrollY, behavior: "auto" }));
    } catch {
      // The browser's native restoration remains the fallback.
    }
  }, [returnPath]);
  return null;
}

export function DonorBackNavigation({ returnTo, label }: { returnTo: string; label: string }) {
  function goBack(event: MouseEvent<HTMLAnchorElement>) {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    try {
      const referrer = document.referrer ? new URL(document.referrer) : null;
      const target = new URL(returnTo, window.location.origin);
      if (referrer?.origin === window.location.origin && referrer.pathname === target.pathname && referrer.search === target.search) {
        event.preventDefault();
        window.history.back();
      }
    } catch {
      // The anchor href provides a safe fallback.
    }
  }

  return <nav className="donor-page-navigation" aria-label="Donor page navigation">
    <a className="donor-back-button" href={returnTo} onClick={goBack}>← {label}</a>
    <a className="donor-home-link" href="/" aria-label="Today's Workspace"><span aria-hidden="true">⌂</span><span>Workspace</span></a>
  </nav>;
}
