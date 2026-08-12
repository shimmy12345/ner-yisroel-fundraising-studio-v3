// Shared types for lightweight gift acknowledgment tracking (db/schema.ts's
// giftAcknowledgments table). Deliberately not an interaction: marking a
// gift acknowledged never counts as a completed relationship interaction,
// never changes last-contact, and never generates relationship_summary/
// institutional_memory content. If a fundraiser actually calls or has a
// substantive conversation, that's still logged as a real interaction
// separately -- this only tracks the routine "sent the thank-you" fact.

export type GiftSource = "giving_activity" | "gift";
export type GiftAcknowledgmentStatus = "thank_you_sent" | "thank_you_call" | "no_acknowledgment_needed";

export const GIFT_ACKNOWLEDGMENT_STATUSES: readonly GiftAcknowledgmentStatus[] = ["thank_you_sent", "thank_you_call", "no_acknowledgment_needed"];
export const GIFT_SOURCES: readonly GiftSource[] = ["giving_activity", "gift"];

export const GIFT_ACKNOWLEDGMENT_LABELS: Record<GiftAcknowledgmentStatus, string> = {
  thank_you_sent: "Thank-you sent",
  thank_you_call: "Thank-you call made",
  no_acknowledgment_needed: "No thank-you needed",
};

export const GIFT_ACKNOWLEDGMENT_ACTION_LABELS: Record<GiftAcknowledgmentStatus, string> = {
  thank_you_sent: "Mark thank-you sent",
  thank_you_call: "Mark thank-you call",
  no_acknowledgment_needed: "No thank-you needed",
};

export function isGiftAcknowledgmentStatus(value: unknown): value is GiftAcknowledgmentStatus {
  return typeof value === "string" && (GIFT_ACKNOWLEDGMENT_STATUSES as readonly string[]).includes(value);
}

export function isGiftSource(value: unknown): value is GiftSource {
  return typeof value === "string" && (GIFT_SOURCES as readonly string[]).includes(value);
}
