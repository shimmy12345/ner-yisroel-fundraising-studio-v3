import { AppShell } from "../components/AppShell";

export default function SettingsPage() {
  return <AppShell active="settings"><main className="support-page">
    <p className="eyebrow">SETTINGS</p><h1>Workspace settings</h1>
    <p className="support-lede">Keep your relationship workspace current without turning it into a CRM administration system.</p>
    <section className="support-card settings-import"><div><h2>Data import</h2><p>Import a household spreadsheet or refresh contact information from JL Solutions. Every import is previewed first.</p></div><a href="/onboarding/import">Open data import</a></section>
    <section className="support-card"><h2>Data safety</h2><p>Uploaded files are inspected in your browser and processed only inside the authenticated Cloudflare application. Household information is never sent to an external AI provider.</p><a href="/api/import/backup">Download current D1 backup</a></section>
  </main></AppShell>;
}
