import { describe, expect, it } from "vitest";
import { isRetryableProviderFailure } from "../../src/server/providers/provider-failure.js";

describe("provider failure classification", () => {
  it.each([
    "Connection error.",
    "fetch failed: ECONNRESET",
    "502 status code (no body)",
    "429 Too Many Requests",
    "request timed out",
    "Upstream HTTP/2 stream failed",
    "HTTP/2 stream reset by peer",
    "Upstream response stream was interrupted",
  ])("classifies transient transport failures as retryable: %s", (message) => {
    expect(isRetryableProviderFailure(message)).toBe(true);
  });

  it.each([
    "400 Bad Request",
    "401 Unauthorized",
    "402 Insufficient Balance",
    "403 Forbidden",
    "invalid model configuration",
  ])("keeps terminal provider failures operator-blocked: %s", (message) => {
    expect(isRetryableProviderFailure(message)).toBe(false);
  });
});
