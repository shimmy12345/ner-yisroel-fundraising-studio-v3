import { env } from "cloudflare:workers";
import {
  buildMeetingBrief,
  type MeetingBrief,
  type MeetingBriefDonor,
  type MeetingBriefGift,
  type MeetingBriefInteraction,
  type MeetingBriefReminder,
} from "./meeting-brief-model";

type DonorRow = {
  id: string;
  display_name: string;
  donor_code: string | null;
  external_id: string | null;
  primary_first_name: string | null;
  spouse_first_name: string | null;
  primary_title: string | null;
  spouse_title: string | null;
  email: string | null;
  phone: string | null;
  home_phone: string | null;
  address_line_1: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  country: string | null;
};

type GivingRow = { id: string; activity_date: number | null; paid_cents: number | null; balance_cents: number | null; description: string | null; item_type: string | null };
type LegacyGiftRow = { id: string; received_at: number; amount_cents: number; fund: string };
type InteractionRow = { id: string; type: string; occurred_at: number; summary: string };
type ReminderRow = { id: string; action: string; reason: string; due_at: number | null };

function titled(title: string | null, name: string | null) {
  return name ? [title, name].filter(Boolean).join(" ") : null;
}

export async function loadMeetingBrief(userId: string, donorId: string, now = Math.floor(Date.now() / 1000)): Promise<MeetingBrief | null> {
  const donor = await env.DB.prepare(`SELECT id, display_name, donor_code, external_id, primary_first_name, spouse_first_name, primary_title, spouse_title, email, phone, home_phone, address_line_1, city, state, postal_code, country
    FROM donors WHERE id = ? AND owner_user_id = ? AND data_source = 'live' LIMIT 1`).bind(donorId, userId).first<DonorRow>();
  if (!donor) return null;

  const [giving, legacyGifts, interactions, reminders] = await Promise.all([
    env.DB.prepare(`SELECT id, activity_date, paid_cents, balance_cents, description, item_type
      FROM giving_activities
      WHERE donor_id = ? AND owner_user_id = ? AND record_origin = 'live'
        AND category NOT IN ('needs_review','nonfinancial_entry')
      ORDER BY activity_date DESC LIMIT 1000`).bind(donorId, userId).all<GivingRow>(),
    env.DB.prepare(`SELECT g.id, g.received_at, g.amount_cents, g.fund
      FROM gifts g JOIN donors d ON d.id = g.donor_id
      WHERE g.donor_id = ? AND d.owner_user_id = ? AND d.data_source = 'live'
      ORDER BY g.received_at DESC LIMIT 1000`).bind(donorId, userId).all<LegacyGiftRow>(),
    env.DB.prepare(`SELECT i.id, i.type, i.occurred_at, i.summary
      FROM interactions i JOIN donors d ON d.id = i.donor_id
      WHERE i.donor_id = ? AND i.user_id = ? AND d.owner_user_id = ? AND d.data_source = 'live'
        AND i.occurred_at <= ?
      ORDER BY i.occurred_at DESC LIMIT 5`).bind(donorId, userId, userId, now).all<InteractionRow>(),
    env.DB.prepare(`SELECT r.id, r.action, r.reason, r.due_at
      FROM recommendations r JOIN donors d ON d.id = r.donor_id
      WHERE r.donor_id = ? AND r.user_id = ? AND d.owner_user_id = ? AND d.data_source = 'live'
        AND r.status = 'open'
      ORDER BY CASE WHEN r.due_at IS NULL THEN 1 ELSE 0 END, r.due_at LIMIT 5`).bind(donorId, userId, userId).all<ReminderRow>(),
  ]);

  const address = [
    donor.address_line_1,
    [donor.city, donor.state, donor.postal_code].filter(Boolean).join(" "),
    donor.country,
  ].filter((line): line is string => Boolean(line));
  const identity: MeetingBriefDonor = {
    id: donor.id,
    displayName: donor.display_name,
    donorCode: donor.donor_code,
    externalId: donor.external_id,
    primaryName: titled(donor.primary_title, donor.primary_first_name),
    spouseName: titled(donor.spouse_title, donor.spouse_first_name),
    email: donor.email,
    phone: donor.phone,
    homePhone: donor.home_phone,
    address,
  };
  const gifts: MeetingBriefGift[] = [
    ...giving.results.map((gift) => ({
      id: gift.id,
      occurredAt: gift.activity_date,
      paidCents: gift.paid_cents ?? 0,
      balanceCents: gift.balance_cents ?? 0,
      description: gift.description || gift.item_type,
    })),
    ...legacyGifts.results.map((gift) => ({
      id: gift.id,
      occurredAt: gift.received_at,
      paidCents: gift.amount_cents,
      balanceCents: 0,
      description: gift.fund || null,
    })),
  ];
  const interactionData: MeetingBriefInteraction[] = interactions.results.map((item) => ({ id: item.id, type: item.type, occurredAt: item.occurred_at, summary: item.summary }));
  const reminderData: MeetingBriefReminder[] = reminders.results.map((item) => ({ id: item.id, action: item.action, reason: item.reason, dueAt: item.due_at }));
  return buildMeetingBrief(identity, gifts, interactionData, reminderData);
}
