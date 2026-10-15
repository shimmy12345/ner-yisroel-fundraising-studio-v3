import { PAYMENT_PLAN_DISPLAY_STATUS_LABELS, type PaymentPlanDisplayStatus } from "../../lib/relationships/payment-plan-display";

// Shared status pill for the Payment-Plan Progress Dashboard. The label
// and the six possible states both come from
// lib/relationships/payment-plan-display.ts -- this component only maps
// a status to a color, it never decides what the status is.
const TONE: Record<PaymentPlanDisplayStatus, "good" | "info" | "warning" | "danger" | "neutral"> = {
  on_track: "good",
  upcoming_payment: "info",
  payment_due: "warning",
  overdue: "danger",
  completed: "neutral",
  needs_review: "danger",
};

export function StatusBadge({ status }: { status: PaymentPlanDisplayStatus }) {
  return <span className={`status-badge status-badge-${TONE[status]}`}>{PAYMENT_PLAN_DISPLAY_STATUS_LABELS[status]}</span>;
}
