import type { InstallmentTimelineEntry } from "../../lib/relationships/payment-plan-display";

// timeZone: "UTC" is required -- these are date-only epochs (UTC
// midnight), the same convention every other financial date display in
// this app uses (see app/donors/[id]/PledgePaymentPlanManagement.tsx's
// own dateLabel).
const dateLabel = (epoch: number) => new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(new Date(epoch * 1000));

const STATE_CLASS: Record<InstallmentTimelineEntry["state"], string> = {
  paid: "installment-tick-paid",
  overdue: "installment-tick-overdue",
  upcoming: "installment-tick-upcoming",
  future: "installment-tick-future",
};
const STATE_LABEL: Record<InstallmentTimelineEntry["state"], string> = {
  paid: "Paid",
  overdue: "Overdue",
  upcoming: "Next expected",
  future: "Scheduled",
};

// Caller (lib/relationships/payment-plan-display.ts's buildInstallmentTimeline)
// already caps how many PAID cycles are included -- this component only
// renders what it's given, plus the trimmed-count labels, so a plan with
// years of history never grows the strip unbounded.
export function InstallmentTimeline({ entries, hiddenBeforeCount }: { entries: InstallmentTimelineEntry[]; hiddenBeforeCount: number }) {
  if (entries.length === 0) return null;
  return (
    <div className="installment-timeline">
      {hiddenBeforeCount > 0 && <span className="installment-tick-hidden-count" title={`${hiddenBeforeCount} earlier paid installment${hiddenBeforeCount === 1 ? "" : "s"} not shown`}>+{hiddenBeforeCount} earlier</span>}
      {entries.map((entry) => (
        <span key={entry.dueAt} className={`installment-tick ${STATE_CLASS[entry.state]}`} title={`${STATE_LABEL[entry.state]} · ${dateLabel(entry.dueAt)}`} />
      ))}
    </div>
  );
}
