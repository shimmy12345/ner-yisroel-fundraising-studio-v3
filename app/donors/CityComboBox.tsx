"use client";

import { useMemo, useRef, useState } from "react";
import { ALL_CITIES, searchCityOptions, type CityOption } from "../../lib/relationships/donor-geo-filter";

// Searchable City selector (owner feedback on the Phase 2 geographic
// filtering deployment, 2026-10-14): replaces the plain <select> with
// an accessible combobox so typing a partial city name narrows a long,
// flat list immediately, instead of scrolling a native dropdown.
//
// Deliberately a small, standalone component rather than a generalized
// or reused copy of app/capture/DonorAutocomplete.tsx: the interaction
// pattern (combobox role, listbox, arrow/Enter/Escape handling,
// mousedown-preventDefault so a click registers before blur closes the
// list) is modeled directly on that component, but this is a different
// data domain (cities, not donors) with a much smaller, already-sorted
// option list and no donor identity/avatar rendering -- sharing the
// exact component would mean threading donor-shaped props through a
// city selector, or vice versa, for no real benefit. This is NOT a
// second donor-search engine: `options` is always built elsewhere
// (lib/relationships/donor-geo-filter.ts's `cityOptionsForRegion`) from
// the SAME donor data the directory already has, never a new index.
//
// `draft` is null whenever the field is not actively being typed into
// -- the input then simply displays whatever `value` (the committed
// selection) resolves to, which is what keeps this correct when the
// PARENT changes `value` externally (e.g. selecting a new Travel
// Region resets City back to "All Cities") with no extra sync effect
// needed: the displayed text is derived fresh from props every render
// whenever the user isn't mid-type.
export function CityComboBox({ options, value, onChange, inputId = "directory-city-filter", label = "City" }: {
  options: CityOption[];
  value: string;
  onChange: (cityKey: string) => void;
  inputId?: string;
  label?: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);

  const selectedOption = options.find((option) => option.key === value) ?? null;
  const selectedLabel = value === ALL_CITIES || !selectedOption ? "All Cities" : `${selectedOption.label} (${selectedOption.count})`;
  const displayValue = draft ?? selectedLabel;

  // "All Cities" is always the first row, regardless of the typed
  // query -- it is the reset action as much as it is an option, so it
  // must always stay reachable without first clearing the search text.
  const filteredOptions = useMemo(() => searchCityOptions(options, draft ?? ""), [options, draft]);
  const rows: Array<{ key: string; label: string }> = [{ key: ALL_CITIES, label: "All Cities" }, ...filteredOptions.map((option) => ({ key: option.key, label: `${option.label} (${option.count})` }))];

  const listId = `${inputId}-listbox`;
  const activeRow = open ? rows[activeIndex] : undefined;

  function commit(cityKey: string) {
    onChange(cityKey);
    setDraft(null);
    setOpen(false);
    setActiveIndex(-1);
  }

  function revert() {
    setDraft(null);
    setOpen(false);
    setActiveIndex(-1);
  }

  function clearToAll() {
    onChange(ALL_CITIES);
    setDraft(null);
    setOpen(false);
    setActiveIndex(-1);
    inputRef.current?.focus();
  }

  return <div className="directory-filter city-combobox">
    <label htmlFor={inputId}>{label}</label>
    <div className={`city-combobox-field${value !== ALL_CITIES ? " has-clear" : ""}`}>
      <input
        ref={inputRef}
        id={inputId}
        type="text"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={activeRow ? `${inputId}-${activeRow.key}` : undefined}
        autoComplete="off"
        value={displayValue}
        onFocus={() => { setDraft(""); setOpen(true); setActiveIndex(-1); }}
        onBlur={revert}
        onChange={(event) => { setDraft(event.target.value); setOpen(true); setActiveIndex(-1); }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setOpen(true);
            setActiveIndex((current) => Math.min(current + 1, rows.length - 1));
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            setActiveIndex((current) => (current < 0 ? 0 : Math.max(current - 1, 0)));
          } else if (event.key === "Enter") {
            if (open && activeIndex >= 0 && rows[activeIndex]) {
              event.preventDefault();
              commit(rows[activeIndex].key);
            }
          } else if (event.key === "Escape") {
            if (event.nativeEvent.isComposing) return;
            event.preventDefault();
            revert();
          }
        }}
      />
      {value !== ALL_CITIES && <button className="city-combobox-clear" type="button" aria-label="Clear city filter" title="Clear city filter" onMouseDown={(event) => event.preventDefault()} onClick={clearToAll}>&#x2715;</button>}
    </div>
    {open && <div className="city-combobox-results" id={listId} role="listbox" aria-label="City options">
      {rows.map((row, index) => <button
        type="button"
        role="option"
        aria-selected={row.key === value}
        id={`${inputId}-${row.key}`}
        key={row.key}
        className={index === activeIndex ? "active" : ""}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => commit(row.key)}
      >{row.label}</button>)}
      {filteredOptions.length === 0 && <p>No matching cities</p>}
    </div>}
  </div>;
}
