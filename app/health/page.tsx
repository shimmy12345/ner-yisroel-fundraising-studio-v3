import { requireChatGPTUser } from "../chatgpt-auth";
import { DataHealthDashboard } from "../settings/DataHealthDashboard";
import { userIdForEmail } from "../../lib/auth/profile";
import { loadDataHealth } from "../../lib/data-health/read";

export const dynamic = "force-dynamic";

export default async function OperationalHealthPage() {
  const identity = await requireChatGPTUser("/health");
  const report = await loadDataHealth(userIdForEmail(identity.email));

  return <main className="settings-page health-operations-page">
    <header className="page-header">
      <div>
        <p className="eyebrow">OWNER-ONLY OPERATIONS</p>
        <h1>Environment health</h1>
        <p className="subhead">A read-only check of database access, schema readiness, baseline identity, and relationship-data integrity.</p>
      </div>
      <a className="secondary-button" href="/">Return to workspace</a>
    </header>
    <DataHealthDashboard initialReport={report} />
  </main>;
}
