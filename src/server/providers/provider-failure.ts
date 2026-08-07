const TRANSIENT_NETWORK_ERRORS = [
  "connection error",
  "connection reset",
  "connection refused",
  "socket hang up",
  "network error",
  "fetch failed",
  "timed out",
  "timeout",
  "econnreset",
  "econnrefused",
  "etimedout",
  "eai_again",
  "tls connection",
  "http/2 stream",
  "stream reset",
  "stream failed",
  "response stream was interrupted",
  "connection terminated",
];

export function isRetryableProviderFailure(message: string): boolean {
  const normalized = message.trim().toLowerCase();
  const status = providerStatusCode(normalized);
  if (status !== undefined) return status === 408 || status === 409 || status === 429 || status >= 500;
  return TRANSIENT_NETWORK_ERRORS.some((fragment) => normalized.includes(fragment));
}

function providerStatusCode(message: string): number | undefined {
  const match = message.match(/\b([1-5]\d{2})\b(?:\s+status(?:\s+code)?)?/);
  if (!match) return undefined;
  const status = Number(match[1]);
  return Number.isInteger(status) ? status : undefined;
}
