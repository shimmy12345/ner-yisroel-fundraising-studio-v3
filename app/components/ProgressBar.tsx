// Shared horizontal progress bar (Payment-Plan Progress Dashboard + Trip
// Fundraising Results Dashboard). `percent` is a raw ratio (0.75 = 75%),
// never pre-clamped by the caller -- clamped here only for the VISUAL
// fill width (a plan/trip that exceeds its target still renders a full
// bar rather than overflowing), while the displayed label always shows
// the real, unclamped percentage so exceeding a goal is visible.
export function ProgressBar({ label, percent, caption, tone = "default" }: { label?: string; percent: number; caption?: string; tone?: "default" | "warning" | "danger" }) {
  const clampedPercent = Math.max(0, Math.min(1, percent));
  return (
    <div className="progress-bar-block">
      {label && <div className="progress-bar-heading"><span>{label}</span><span className="progress-bar-percent">{Math.round(percent * 100)}%</span></div>}
      <div className="progress-bar-track">
        <div className={`progress-bar-fill progress-bar-fill-${tone}`} style={{ width: `${clampedPercent * 100}%` }} />
      </div>
      {caption && <p className="progress-bar-caption">{caption}</p>}
    </div>
  );
}
