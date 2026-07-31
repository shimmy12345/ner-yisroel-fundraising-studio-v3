import { env } from "cloudflare:workers";
import type { InteractionKind } from "../capture/interaction";

export type RelationshipUpdates = {
  summary: string | null;
  memory: string | null;
  nextAction: string | null;
  interaction: {
    id: string;
    subject: string;
    note: string;
    kind: InteractionKind;
    occurredAt: Date;
  } | null;
};

type DonorRow = { relationship_summary: string | null; institutional_memory: string | null };
type InteractionRow = { id: string; summary: string; source: string; occurred_at: number };
type RecommendationRow = { action: string };

export async function getRelationshipUpdates(donorId: string, userId: string): Promise<RelationshipUpdates> {
  try {
    const [donor, interaction, recommendation] = await Promise.all([
      env.DB.prepare("SELECT relationship_summary, institutional_memory FROM donors WHERE id = ? AND owner_user_id = ? AND data_source = 'live'")
        .bind(donorId, userId).first<DonorRow>(),
      env.DB.prepare("SELECT id, summary, source, occurred_at FROM interactions WHERE donor_id = ? AND user_id = ? ORDER BY occurred_at DESC LIMIT 1")
        .bind(donorId, userId).first<InteractionRow>(),
      env.DB.prepare("SELECT action FROM recommendations WHERE donor_id = ? AND user_id = ? AND status = 'open' ORDER BY created_at DESC LIMIT 1")
        .bind(donorId, userId).first<RecommendationRow>(),
    ]);

    const [subject = "Interaction", ...noteParts] = interaction?.summary.split("\n") ?? [];
    const sourceKind = interaction?.source.startsWith("capture:")
      ? interaction.source.slice("capture:".length)
      : "note";
    const allowedKinds = new Set(["call", "email", "meeting", "note", "personal"]);
    const kind = (allowedKinds.has(sourceKind) ? sourceKind : "note") as InteractionKind;

    return {
      summary: donor?.relationship_summary ?? null,
      memory: donor?.institutional_memory ?? null,
      nextAction: recommendation?.action ?? null,
      interaction: interaction ? {
        id: interaction.id,
        subject,
        note: noteParts.join("\n"),
        kind,
        occurredAt: new Date(interaction.occurred_at * 1000),
      } : null,
    };
  } catch {
    return { summary: null, memory: null, nextAction: null, interaction: null };
  }
}
