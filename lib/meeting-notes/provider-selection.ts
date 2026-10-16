// AI Meeting Notes provider selection (docs/AI-HANDOFF.md, "Implement
// Cloudflare AI Meeting Notes on Staging"). Pulled out of
// app/api/meeting-notes/organize/route.ts as its own pure function so this
// decision is unit-testable without mocking cloudflare:workers -- route.ts
// files otherwise stay thin/untested at the unit level by this project's
// own convention, verified live on Staging instead.

export type MeetingNotesProvider = "workers-ai" | "anthropic";

// Cloudflare Workers AI is the default -- used whenever AI_PROVIDER is
// absent or set to anything other than exactly "anthropic". Switching
// providers is a `vars` config change only; no code change or redeploy of
// this function is required.
export function selectMeetingNotesProvider(aiProviderVar: string | undefined): MeetingNotesProvider {
  return aiProviderVar === "anthropic" ? "anthropic" : "workers-ai";
}
