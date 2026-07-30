import type { Metadata } from "next";
import { AppShell } from "../components/AppShell";
import { CaptureExperience } from "./CaptureExperience";

export const metadata: Metadata = { title: "Log an interaction" };

export default function CapturePage() {
  return <AppShell active="donors"><CaptureExperience /></AppShell>;
}
