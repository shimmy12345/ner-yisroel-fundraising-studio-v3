import { env } from "cloudflare:workers";
import { getChatGPTUser } from "../../app/chatgpt-auth";

type PreferenceRow = { sample_data_acknowledged: number };
type ImportCountRow = { count: number };

export async function shouldShowOnboarding() {
  const user = await getChatGPTUser();
  if (!user) return false;
  const userId = `user_${user.email.toLowerCase()}`;

  try {
    const [preference, importCount] = await Promise.all([
      env.DB.prepare("SELECT sample_data_acknowledged FROM onboarding_preferences WHERE user_id = ?")
        .bind(userId).first<PreferenceRow>(),
      env.DB.prepare("SELECT COUNT(*) AS count FROM data_imports WHERE user_id = ? AND status = 'completed'")
        .bind(userId).first<ImportCountRow>(),
    ]);
    return !preference?.sample_data_acknowledged && !(importCount?.count ?? 0);
  } catch {
    return true;
  }
}
