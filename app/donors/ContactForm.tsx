"use client";

import { useState } from "react";
import type { DonorContactInput } from "../../lib/donors/contact";

type ContactValues = Required<DonorContactInput>;
type FieldErrors = Record<string, string>;

const emptyValues: ContactValues = { householdName: "", primaryFirstName: "", spouseName: "", email: "", mobilePhone: "", homePhone: "", address: "", city: "", state: "", postalCode: "", country: "", note: "" };

export function ContactForm({ donorId = null, initial = emptyValues, jlCode = null, source = "Manual" }: { donorId?: string | null; initial?: ContactValues; jlCode?: string | null; source?: string }) {
  const editing = Boolean(donorId);
  const [values, setValues] = useState<ContactValues>(initial);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [message, setMessage] = useState("");
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [savedHref, setSavedHref] = useState("");

  function set(field: keyof ContactValues, value: string) {
    setValues((current) => ({ ...current, [field]: value }));
    setFieldErrors((current) => ({ ...current, [field]: "" }));
    setStatus("idle");
  }

  async function save() {
    if (status === "saving") return;
    setStatus("saving"); setMessage(""); setFieldErrors({});
    try {
      const response = await fetch(editing ? `/api/donors/${encodeURIComponent(donorId!)}` : "/api/donors", { method: editing ? "PATCH" : "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(values) });
      const data = await response.json() as { error?: string; fieldErrors?: FieldErrors; href?: string; message?: string };
      if (!response.ok) { setFieldErrors(data.fieldErrors ?? {}); throw new Error(data.error ?? "The donor could not be saved."); }
      setSavedHref(data.href ?? (donorId ? `/donors/${encodeURIComponent(donorId)}` : "/donors"));
      setMessage(data.message ?? "Contact details saved.");
      setStatus("saved");
    } catch (error) { setMessage(error instanceof Error ? error.message : "The donor could not be saved."); setStatus("error"); }
  }

  if (status === "saved") return <main className="donor-contact-page"><section className="contact-form-card contact-success" role="status"><div className="import-success-mark">✓</div><p className="eyebrow">CONTACT SAVED</p><h1>{message}</h1><p>The donor is available in search, interactions, meetings, reminders, Today, and Assistant data.</p><div className="contact-form-actions"><a className="onboarding-primary" href={savedHref}>Open donor</a><a href="/donors">View all donors</a></div></section></main>;

  const fields: Array<{ key: keyof ContactValues; label: string; type?: string; wide?: boolean; placeholder?: string }> = [
    { key: "householdName", label: "Household or donor name", wide: true },
    { key: "primaryFirstName", label: "Primary first name" },
    { key: "spouseName", label: "Spouse name" },
    { key: "email", label: "Email", type: "email" },
    { key: "mobilePhone", label: "Mobile phone", type: "tel" },
    { key: "homePhone", label: "Home phone", type: "tel" },
    { key: "address", label: "Address", wide: true },
    { key: "city", label: "City" },
    { key: "state", label: "State" },
    { key: "postalCode", label: "ZIP / postal code" },
    { key: "country", label: "Country" },
  ];
  return <main className="donor-contact-page"><section className="contact-form-card"><header><p className="eyebrow">{editing ? "EDIT CONTACT DETAILS" : "NEW DONOR"}</p><h1>{editing ? `Update ${initial.householdName}` : "Add a donor relationship"}</h1><p>Keep only the contact information needed to support the relationship workspace.</p></header>
    <div className="contact-source-summary"><span className={source === "Manual" ? "manual" : "jl"}>{source === "Manual" ? "Manual" : "JL Solutions"}</span>{jlCode ? <label>JL Code<input value={jlCode} readOnly aria-readonly="true" /></label> : <p>JL Code is blank for manual donors and cannot be entered here.</p>}</div>
    <div className="donor-contact-fields">{fields.map((field) => <label className={field.wide ? "wide" : ""} key={field.key}>{field.label}{field.key !== "householdName" && <span>Optional</span>}<input type={field.type ?? "text"} value={values[field.key]} onChange={(event) => set(field.key, event.target.value)} aria-invalid={Boolean(fieldErrors[field.key])} aria-describedby={fieldErrors[field.key] ? `${field.key}-error` : undefined} />{fieldErrors[field.key] && <small id={`${field.key}-error`} role="alert">{fieldErrors[field.key]}</small>}</label>)}</div>
    <label className="contact-note-field">Note <span>Optional</span><textarea value={values.note} onChange={(event) => set("note", event.target.value)} maxLength={2000} /><small>{fieldErrors.note || "Keep a concise contact note; giving information is managed elsewhere."}</small></label>
    {status === "error" && <p className="capture-error" role="alert">{message}</p>}
    <div className="contact-form-actions"><a href={donorId ? `/donors/${encodeURIComponent(donorId)}` : "/donors"}>Cancel</a><button className="onboarding-primary" type="button" disabled={status === "saving"} onClick={save}>{status === "saving" ? "Saving…" : editing ? "Save contact details" : "Create donor"}</button></div>
  </section></main>;
}
