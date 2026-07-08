function positiveIntegerFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export const RUNTIME_LIMITS = {
  maxToolFollowUps: positiveIntegerFromEnv("AUTOAGENT_MAX_TOOL_FOLLOW_UPS", 200),
  ticketLeaseMs: positiveIntegerFromEnv("AUTOAGENT_TICKET_LEASE_MS", 60_000),
  sseHeartbeatMs: positiveIntegerFromEnv("AUTOAGENT_SSE_HEARTBEAT_MS", 15_000)
};
