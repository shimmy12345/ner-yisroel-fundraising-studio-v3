"use client";

import { useMemo, useState } from "react";
import { searchDonors, type DonorSearchRecord } from "../../lib/relationships/donor-search";

export function DonorAutocomplete({ donors, selectedId, onSelect }: {
  donors: DonorSearchRecord[];
  selectedId: string;
  onSelect: (id: string) => void;
}) {
  const selected = donors.find((donor) => donor.id === selectedId);
  const [query, setQuery] = useState(selected?.name ?? "");
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const matches = useMemo(() => searchDonors(donors, query), [donors, query]);
  const listId = "capture-donor-options";

  function choose(donor: DonorSearchRecord) {
    onSelect(donor.id);
    setQuery(donor.name);
    setOpen(false);
    setActiveIndex(0);
  }

  return <div className="donor-autocomplete">
    <label htmlFor="capture-donor-search">Donor</label>
    <input
      id="capture-donor-search"
      role="combobox"
      aria-autocomplete="list"
      aria-expanded={open}
      aria-controls={listId}
      aria-activedescendant={open && matches[activeIndex] ? `capture-donor-${matches[activeIndex].id}` : undefined}
      autoComplete="off"
      value={query}
      placeholder="Search name, JL code, email, or phone"
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
      onChange={(event) => {
        setQuery(event.target.value);
        onSelect("");
        setOpen(true);
        setActiveIndex(0);
      }}
      onKeyDown={(event) => {
        if (event.key === "ArrowDown") {
          event.preventDefault();
          setOpen(true);
          setActiveIndex((current) => Math.min(current + 1, matches.length - 1));
        } else if (event.key === "ArrowUp") {
          event.preventDefault();
          setActiveIndex((current) => Math.max(current - 1, 0));
        } else if (event.key === "Enter" && open && matches[activeIndex]) {
          event.preventDefault();
          choose(matches[activeIndex]);
        } else if (event.key === "Escape") {
          setOpen(false);
        }
      }}
    />
    {open && <div className="donor-autocomplete-results" id={listId} role="listbox">
      {matches.length ? matches.map((donor, index) => <button
        type="button"
        role="option"
        aria-selected={donor.id === selectedId}
        id={`capture-donor-${donor.id}`}
        className={index === activeIndex ? "active" : ""}
        key={donor.id}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => choose(donor)}
      >
        <strong>{donor.name}</strong>
        <span>{[donor.spouse, donor.code && `JL code ${donor.code}`, donor.email, donor.phone].filter(Boolean).join(" · ")}</span>
      </button>) : <p>No matching donors</p>}
    </div>}
  </div>;
}
