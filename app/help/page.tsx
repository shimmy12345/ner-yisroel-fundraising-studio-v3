import { AppShell } from "../components/AppShell";

export default function HelpPage() {
  return <AppShell active="help"><main className="support-page">
    <p className="eyebrow">HELP & RESOURCES</p><h1>Bring your relationships into Fundraising OS</h1>
    <p className="support-lede">Start with the household export you already use. Fundraising OS recognizes useful relationship details and shows a preview before saving anything.</p>
    <section className="support-card"><h2>Import a JL Solutions household export</h2><ol><li>In JL Solutions, export the household file as CSV.</li><li>Open <a href="/onboarding/import">Import donor data</a> and choose the CSV.</li><li>Confirm that “JL Solutions household export detected” appears.</li><li>Review new, matched, updated, conflicting, and rejected records.</li><li>Download a D1 backup, then confirm only when you are ready.</li></ol></section>
    <section className="support-grid"><article><h2>What is imported</h2><p>Household name, JL Code, husband and wife names and titles, preferred email, mobile and home phones, and mailing address.</p></article><article><h2>What is not imported</h2><p>CRM ownership, territories, pipelines, ratings, campaigns, and giving history not present in this household export.</p></article><article><h2>Future JL refreshes</h2><p>Refreshes match by JL Code, add new households, and preview changed contact details. Fundraising OS notes, reminders, summaries, and relationship history are preserved.</p></article><article><h2>Giving history</h2><p>Giving history requires a separate JL Solutions donation export. Household uploads never invent gifts or activity.</p></article></section>
  </main></AppShell>;
}
