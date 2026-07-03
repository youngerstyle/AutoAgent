export function agentProfileCardSummary(profile: { capabilities: string[]; soul?: string }): string {
  if (profile.capabilities.length) return profile.capabilities.slice(0, 4).join("、");
  return profile.soul?.slice(0, 48) ?? "";
}
