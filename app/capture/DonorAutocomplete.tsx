"use client";

import { useMemo, useRef, useState } from "react";
import { searchDonors, type DonorSearchRecord } from "../../lib/relationships/donor-search";
import { donorInitials, numericDonorCode } from "../../lib/relationships/donor-identity";

export function DonorAutocomplete({ donors, selectedId, onSelect, inputId = "capture-donor-search", label = "Donor", placeholder = "Search name, spouse, JL code, email, or phone", initialQuery, onQueryChange, clearable = false, showResults = true }: {
  donors: DonorSearchRecord[];
  selectedId: string;
  onSelect: (id: string) => void;
  inputId?: string;
  label?: string;
  placeholder?: string;
  initialQuery?: string;
  onQueryChange?: (query: string) => void;
  clearable?: boolean;
  // A results area elsewhere on the page (e.g. the donor directory list)
  // can already show live-filtered matches as the user types. In that
  // case this dropdown would just be a second copy of the same results,
  // so callers with their own results surface set this to false and keep
  // only the input and its clear/keyboard behavior.
  showResults?: boolean;
}) {
  const selected = donors.find((donor) => donor.id === selectedId);
  const [query, setQuery] = useState(initialQuery ?? selected?.name ?? "");
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const matches = useMemo(() => searchDonors(donors, query), [donors, query]);
  const listId = `${inputId}-options`;
  const showDropdown = showResults && open;

  function choose(donor: DonorSearchRecord) {
    onSelect(donor.id);
    setQuery(donor.name);
    setOpen(false);
    setActiveIndex(-1);
  }

  function clearQuery() {
    setQuery("");
    onQueryChange?.("");
    onSelect("");
    setOpen(false);
    setActiveIndex(-1);
    inputRef.current?.focus();
  }

  return <div className={`donor-autocomplete${clearable && query ? " has-clear" : ""}`}>
    <label htmlFor={inputId}>{label}</label>
    <input
      ref={inputRef}
      id={inputId}
      role={showResults ? "combobox" : undefined}
      aria-autocomplete={showResults ? "list" : undefined}
      aria-expanded={showResults ? open : undefined}
      aria-controls={showResults ? listId : undefined}
      aria-activedescendant={showDropdown && matches[activeIndex] ? `${inputId}-${matches[activeIndex].id}` : undefined}
      autoComplete="off"
      value={query}
      placeholder={placeholder}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
      onChange={(event) => {
        setQuery(event.target.value);
        onQueryChange?.(event.target.value);
        onSelect("");
        setOpen(true);
        setActiveIndex(-1);
      }}
      onKeyDown={(event) => {
        if (!showResults) {
          if (event.key === "Escape" && !event.nativeEvent.isComposing && clearable && query) { event.preventDefault(); clearQuery(); }
          return;
        }
        if (event.key === "ArrowDown") {
          event.preventDefault();
          setOpen(true);
          setActiveIndex((current) => Math.min(current + 1, matches.length - 1));
        } else if (event.key === "ArrowUp") {
          event.preventDefault();
          setActiveIndex((current) => current < 0 ? 0 : Math.max(current - 1, 0));
        } else if (event.key === "Enter" && open && activeIndex >= 0 && matches[activeIndex]) {
          event.preventDefault();
          choose(matches[activeIndex]);
        } else if (event.key === "Escape") {
          if (event.nativeEvent.isComposing) return;
          event.preventDefault();
          if (clearable && query) clearQuery(); else setOpen(false);
        }
      }}
    />
    {clearable && query && <button className="donor-search-clear" type="button" aria-label="Clear donor search" title="Clear search" onMouseDown={(event) => event.preventDefault()} onClick={clearQuery}>&#x2715;</button>}
    {showDropdown && <div className="donor-autocomplete-results" id={listId} role="listbox">
      {matches.length ? matches.map((donor, index) => <button
        type="button"
        role="option"
        aria-selected={donor.id === selectedId}
        id={`${inputId}-${donor.id}`}
        className={index === activeIndex ? "active" : ""}
        key={donor.id}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => choose(donor)}
      >
        <span className="autocomplete-avatar">{donorInitials({ displayName: donor.name, primaryFirstName: donor.primaryFirstName, lastName: donor.lastName })}</span>
        <span className="autocomplete-identity"><strong>{donor.name}</strong>{numericDonorCode({ donorCode: donor.code }) && <span className="donor-code">{numericDonorCode({ donorCode: donor.code })}</span>}<small>{[donor.spouse, donor.email, donor.phone].filter(Boolean).join(" · ")}</small></span>
      </button>) : <p>No matching donors</p>}
    </div>}
  </div>;
}
