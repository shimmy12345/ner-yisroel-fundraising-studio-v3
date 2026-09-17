// Fundraising Intelligence Brief -- UI vocabulary, centralized (see
// docs/FUNDRAISING-INTELLIGENCE-BRIEF-DESIGN.md's own "no raw enum
// strings in end-user UX" principle, applied here the same way
// lib/portfolio-focus/today-view.ts's ATTENTION_TYPE_DISPLAY_LABELS
// already does for Portfolio Focus). Every internal enum this module
// produces (SituationType, BriefDisposition, ConfidenceLevel) is
// translated to plain language exactly once, here -- no component ever
// renders a raw enum string or a raw score.
import type { BriefDisposition, ConfidenceLevel, SituationType } from "./types.ts";

export const SITUATION_TYPE_LABELS: Record<SituationType, string> = {
  explicit_follow_up: "Follow-up",
  stewardship_moment: "Stewardship",
  commitment_progress: "Commitment progress",
  pledge_follow_up: "Pledge follow-up",
  financial_change: "Giving change",
  relationship_visibility: "Relationship visibility",
  ask_resolution: "Ask update",
  upcoming_moment: "Upcoming moment",
};

// Disposition labels describe DIFFERENT PURPOSES, never a priority
// ranking -- a KNOW item is not "less important" than a DO item, it is
// a different kind of intelligence (see the design doc's "Know does not
// always mean Do" principle).
export const DISPOSITION_LABELS: Record<BriefDisposition, string> = {
  DO: "Needs action",
  KNOW: "Worth knowing",
  KNOW_DO: "Worth knowing & doing",
};

export const CONFIDENCE_LABELS: Record<ConfidenceLevel, string> = {
  high: "Strong evidence",
  medium: "Some evidence",
  limited: "Limited evidence",
};

// One fixed, non-item-specific sentence per level -- confidence
// describes FOS's KNOWLEDGE, never the relationship (rule E) -- never
// "this relationship is weak," always framed as what FOS does or
// doesn't have on file.
export const CONFIDENCE_EXPLANATIONS: Record<ConfidenceLevel, string> = {
  high: "Based on clear, directly recorded evidence.",
  medium: "Based on reasonable but incomplete evidence.",
  limited: "FOS has limited information here -- a starting point, not a certainty.",
};
