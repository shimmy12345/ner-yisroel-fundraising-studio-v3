"use client";

import { useMemo, useState } from "react";
import { searchDonors, type DonorSearchRecord } from "../../lib/relationships/donor-search";
import { donorInitials, numericDonorCode } from "../../lib/relationships/donor-identity";

// Multi-donor recipient/participant picker for shared activities. Reuses
// searchDonors -- the exact same client-side search over the already-loaded
// `donors` array that DonorAutocomplete uses everywhere else in this app --
// so results match single-donor search conventions exactly, and there is no
// per-keystroke server call to debounce: searching 1000 pre-loaded donors is
// a synchronous in-memory filter. Results render inline (not an absolutely-
// positioned dropdown) so this stays a simple, full-width stacked panel on
// small screens rather than a desktop-style floating menu.
export function RecipientPicker({ donors, selectedIds, onChange, maxRecipients, inputId = "recipient-picker-search" }: {
  donors: DonorSearchRecord[];
  selectedIds: string[];
  onChange: (ids: string[]) => void;
  maxRecipients: number;
  inputId?: string;
}) {
  const [query, setQuery] = useState("");
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const selectedDonors = useMemo(() => selectedIds.map((id) => donors.find((donor) => donor.id === id)).filter((donor): donor is DonorSearchRecord => Boolean(donor)), [selectedIds, donors]);
  // A higher limit than DonorAutocomplete's default (8): there is no
  // "replace the one selection" flow here, so showing more matches per
  // keystroke helps someone building a large list keep moving without
  // re-typing a narrower query. Still bounded -- never unbounded rendering.
  const matches = useMemo(() => searchDonors(donors, query, 20), [donors, query]);
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
    <label htmlFor={inputId}>Search donors</label>
    <input
      id={inputId}
      autoComplete="off"
      value={query}
      placeholder="Search name, spouse, JL code, email, or phone"
      onChange={(event) => setQuery(event.target.value)}
      aria-describedby={`${inputId}-count`}
    />
    {query.trim() && <div className="recipient-picker-results" role="listbox" aria-multiselectable="true">
      {matches.length ? matches.map((donor) => {
        const checked = selectedSet.has(donor.id);
        return <button
          type="button"
          key={donor.id}
          role="option"
          aria-selected={checked}
          className={`recipient-picker-result${checked ? " selected" : ""}`}
          disabled={!checked && atCap}
          onClick={() => toggle(donor.id)}
        >
          <span className="recipient-picker-check" aria-hidden="true">{checked ? "✓" : ""}</span>
          <span className="autocomplete-avatar">{donorInitials({ displayName: donor.name, primaryFirstName: donor.primaryFirstName, lastName: donor.lastName })}</span>
          {/* One restrained secondary line (code + email-or-phone, not
              spouse/email/phone all joined) that truncates instead of
              wrapping -- multi-line metadata was colliding with the row
              below it on narrow screens (see .recipient-picker-result's
              grid-auto-rows fix below for the other half of that bug). */}
          <span className="autocomplete-identity"><strong>{donor.name}</strong><small>{[numericDonorCode({ donorCode: donor.code }), donor.email || donor.phone].filter(Boolean).join(" · ")}</small></span>
        </button>;
      }) : <p>No matching donors</p>}
    </div>}

    <div className="recipient-picker-selected">
      <p id={`${inputId}-count`} className="recipient-picker-count">
        {selectedIds.length === 0 ? "No donors selected yet" : `${selectedIds.length} selected`}
        {atCap && <span className="recipient-picker-cap-note"> · maximum of {maxRecipients} reached</span>}
      </p>
      {selectedDonors.length > 0 && <ul className="recipient-picker-chips">
        {selectedDonors.map((donor) => <li key={donor.id} className="recipient-picker-chip">
          <span>{donor.name}{numericDonorCode({ donorCode: donor.code }) && <small> · {numericDonorCode({ donorCode: donor.code })}</small>}</span>
          <button type="button" aria-label={`Remove ${donor.name}`} onClick={() => remove(donor.id)}>×</button>
        </li>)}
      </ul>}
    </div>
  </div>;
}
