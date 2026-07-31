import type { Metadata } from "next";
import { ImportExperience } from "./ImportExperience";

export const metadata: Metadata = { title: "Import donor data" };

export default function ImportPage() {
  return <ImportExperience />;
}
