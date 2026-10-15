// Shared financial dashboard primitive (Payment-Plan Progress Dashboard +
// Trip Fundraising Results Dashboard, see docs/AI-HANDOFF.md). Pure
// presentation -- every figure is passed in already-formatted by the
// caller's own server-derived data, never computed here.
export function FinancialSummaryCard({ label, value, sublabel, tone = "default" }: { label: string; value: string; sublabel?: string; tone?: "default" | "muted" }) {
  return (
    <div className={`financial-summary-card${tone === "muted" ? " financial-summary-card-muted" : ""}`}>
      <p className="financial-summary-label">{label}</p>
      <p className="financial-summary-value">{value}</p>
      {sublabel && <p className="financial-summary-sublabel">{sublabel}</p>}
    </div>
  );
}

export function FinancialSummaryGrid({ children }: { children: React.ReactNode }) {
  return <div className="financial-summary-grid">{children}</div>;
}
