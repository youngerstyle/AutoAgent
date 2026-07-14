export const DEFAULT_MODEL_CONTEXT_WINDOW_TOKENS = 128_000;
export const MODEL_CONTEXT_INPUT_RATIO = 0.9;

export function effectiveInputTokenBudget(contextWindowTokens: number): number {
  return Math.max(1, Math.floor(contextWindowTokens * MODEL_CONTEXT_INPUT_RATIO));
}
