import type { Metadata } from "next";
import { AppShell } from "../../components/AppShell";
import { requireChatGPTUser } from "../../chatgpt-auth";
import { ContactForm } from "../ContactForm";

export const metadata: Metadata = { title: "New donor" };
export const dynamic = "force-dynamic";

export default async function NewDonorPage() {
  await requireChatGPTUser("/donors/new");
  return <AppShell active="donors"><ContactForm /></AppShell>;
}
