import { env } from "cloudflare:workers";
export type DataMode = "live" | "demo";
export async function getDataMode(userId: string): Promise<DataMode> {
  const row = await env.DB.prepare("SELECT data_mode FROM onboarding_preferences WHERE user_id = ?").bind(userId).first<{ data_mode: string }>();
  return row?.data_mode === "demo" ? "demo" : "live";
}
