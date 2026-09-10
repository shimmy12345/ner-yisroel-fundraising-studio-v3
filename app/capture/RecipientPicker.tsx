"use client";

import { useMemo, useState } from "react";
import { DIRECTORY_ALPHABET, DIRECTORY_OTHER_LETTER, donorDirectoryNonEmptyLetters, filterDonorDirectory, type DonorSearchRecord } from "../../lib/relationships/donor-search";
import { donorInitials, numericDonorCode } from "../../lib/relationships/donor-identity";

// Multi-donor recipient/participant picker for shared activities. A
// browseable donor directory (All / A-Z letter filters / a compact
// checkbox list), with search as an optional filter layered on top --
// reuses the exact same already-loaded `donors` array every other donor
// picker in this app uses (see lib/relationships/donor-search.ts), so there
// is no second donor-loading path and no per-keystroke server call: filtering
// 254 real donors (Independent Staging, see docs/AI-HANDOFF.md) is a
// synchronous in-memory operation. Results render inline (not an
// absolutely-positioned dropdown) so this stays a simple, full-width
// stacked panel on small screens rather than a desktop-style floating menu.
export function RecipientPicker({ donors, selectedIds, onChange, maxRecipients, inputId = "recipient-picker-search" }: {
  donors: DonorSearchRecord[];
  selectedIds: string[];
  onChange: (ids: string[]) => void;
  maxRecipients: number;
  inputId?: string;
}) {
  const [query, setQuery] = useState("");
  // null means "All" -- kept distinct from the string "all" purely so the
  // very first render (nothing clicked yet) and an explicit click on "All"
  // are indistinguishable to every consumer of this state, which is exactly
  // the desired default per docs/AI-HANDOFF.md.
  const [letter, setLetter] = useState<string | null>(null);
  const activeLetter = letter ?? "all";
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const selectedDonors = useMemo(() => selectedIds.map((id) => donors.find((donor) => donor.id === id)).filter((donor): donor is DonorSearchRecord => Boolean(donor)), [selectedIds, donors]);
  const nonEmptyLetters = useMemo(() => donorDirectoryNonEmptyLetters(donors), [donors]);
  // Filtering (letter, search) only ever changes what's VISIBLE -- selection
  // state (selectedIds, owned by the parent) is never touched by a filter
  // change, so switching letters, searching, or clearing search can never
  // silently drop an already-selected donor.
  const results = useMemo(() => filterDonorDirectory(donors, activeLetter, query), [donors, activeLetter, query]);
  const atCap = selectedIds.length >= maxRecipients;

  function toggle(donorId: string) {
    if (selectedSet.has(donorId)) {
      onChange(selectedIds.filter((id) => id !== donorId));
    } else if (!atCap) {
      onChange([...selectedIds, donorId]);
    }
  }

  function remove(donorId: string) {
    onChange(selectedIds.filter((id) => id !== donorId));
  }

  return <div className="recipient-picker">
    <div className="recipient-picker-search">
      <label htmlFor={inputId}>Search donors</label>
      <input
        id={inputId}
        autoComplete="off"
        value={query}
        placeholder="Search name, spouse, JL code, email, or phone"
        onChange={(event) => setQuery(event.target.value)}
        aria-describedby={`${inputId}-count`}
      />
      {query && <button type="button" className="recipient-picker-search-clear" aria-label="Clear search" onClick={() => setQuery("")}>&#x2715;</button>}
    </div>

    <div className="recipient-picker-alphabet" role="group" aria-label="Filter donors by last name">
      <button type="button" className={activeLetter === "all" ? "active" : ""} aria-pressed={activeLetter === "all"} onClick={() => setLetter("all")}>All</button>
      {DIRECTORY_ALPHABET.map((option) => (
        <button
          type="button"
          key={option}
          className={activeLetter === option ? "active" : ""}
          aria-pressed={activeLetter === option}
          disabled={!nonEmptyLetters.has(option)}
          onClick={() => setLetter(option)}
        >
          {option}
        </button>
      ))}
      <button
        type="button"
        className={activeLetter === DIRECTORY_OTHER_LETTER ? "active" : ""}
        aria-pressed={activeLetter === DIRECTORY_OTHER_LETTER}
        disabled={!nonEmptyLetters.has(DIRECTORY_OTHER_LETTER)}
        onClick={() => setLetter(DIRECTORY_OTHER_LETTER)}
      >
        {DIRECTORY_OTHER_LETTER}
      </button>
    </div>

    <div className="recipient-picker-results" role="group" aria-label="Donor directory">
      {results.length ? results.map((donor) => {
        const checked = selectedSet.has(donor.id);
        const disabled = !checked && atCap;
        return <label
          key={donor.id}
          className={`recipient-picker-result${checked ? " selected" : ""}${disabled ? " disabled" : ""}`}
        >
          <input type="checkbox" className="recipient-picker-check" checked={checked} disabled={!checked && atCap} onChange={() => toggle(donor.id)} aria-label={`Select ${donor.name}`} />
          <span className="autocomplete-avatar">{donorInitials({ displayName: donor.name, primaryFirstName: donor.primaryFirstName, lastName: donor.lastName })}</span>
          {/* One restrained secondary line (code + email-or-phone, not
              spouse/email/phone all joined) that truncates instead of
              wrapping -- multi-line metadata was colliding with the row
              below it on narrow screens (see .recipient-picker-result's
              grid-auto-rows fix below for the other half of that bug). */}
          <span className="autocomplete-identity"><strong>{donor.name}</strong><small>{[numericDonorCode({ donorCode: donor.code }), donor.email || donor.phone].filter(Boolean).join(" · ")}</small></span>
        </label>;
      }) : <p className="recipient-picker-empty">No matching donors</p>}
    </div>

    <div className="recipient-picker-selected">
      <div className="recipient-picker-selected-header">
        <p id={`${inputId}-count`} className="recipient-picker-count">
          {selectedIds.length === 0 ? "No donors selected yet" : `${selectedIds.length} selected` + (selectedIds.length === 1 ? " donor" : " donors")}
          {atCap && <span className="recipient-picker-cap-note"> · maximum of {maxRecipients} reached</span>}
        </p>
        {selectedIds.length > 0 && <button type="button" className="recipient-picker-clear-selection" onClick={() => onChange([])}>Clear selection</button>}
      </div>
      {selectedDonors.length > 0 && <ul className="recipient-picker-chips">
        {selectedDonors.map((donor) => <li key={donor.id} className="recipient-picker-chip">
          <span>{donor.name}{numericDonorCode({ donorCode: donor.code }) && <small> · {numericDonorCode({ donorCode: donor.code })}</small>}</span>
          <button type="button" aria-label={`Remove ${donor.name}`} onClick={() => remove(donor.id)}>×</button>
        </li>)}
      </ul>}
    </div>
  </div>;
}
