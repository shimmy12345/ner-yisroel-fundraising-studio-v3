import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { env } from "cloudflare:workers";
import { AppShell } from "../../../components/AppShell";
import { requireChatGPTUser } from "../../../chatgpt-auth";
import { ensureUserProfile } from "../../../../lib/auth/profile";
import { ContactForm } from "../../ContactForm";

export const metadata: Metadata = { title: "Edit donor contact" };
export const dynamic = "force-dynamic";
type Row = { id: string; display_name: string; primary_first_name: string | null; spouse: string | null; email: string | null; phone: string | null; home_phone: string | null; address_line_1: string | null; city: string | null; state: string | null; postal_code: string | null; country: string | null; contact_note: string | null; external_source: string | null; external_id: string | null; donor_code: string | null };

export default async function EditDonorPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const identity = await requireChatGPTUser(`/donors/${encodeURIComponent(id)}/edit`);
  const profile = await ensureUserProfile(identity);
  const donor = await env.DB.prepare(`SELECT id,display_name,primary_first_name,spouse,email,phone,home_phone,address_line_1,city,state,postal_code,country,contact_note,external_source,external_id,donor_code FROM donors WHERE id=? AND owner_user_id=? AND data_source='live' LIMIT 1`).bind(id, profile.id).first<Row>();
  if (!donor) notFound();
  return <AppShell active="donors"><ContactForm donorId={id} source={donor.external_source === "JL Solutions" ? "JL Solutions" : "Manual"} jlCode={donor.external_id || donor.donor_code} initial={{ householdName: donor.display_name, primaryFirstName: donor.primary_first_name ?? "", spouseName: donor.spouse ?? "", email: donor.email ?? "", mobilePhone: donor.phone ?? "", homePhone: donor.home_phone ?? "", address: donor.address_line_1 ?? "", city: donor.city ?? "", state: donor.state ?? "", postalCode: donor.postal_code ?? "", country: donor.country ?? "", note: donor.contact_note ?? "" }} /></AppShell>;
}
