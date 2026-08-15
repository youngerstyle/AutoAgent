import type { AttributionComponent, ExperienceEpisode, MetricExpectation } from "../../shared/contracts/evolution.js";
import type { ProviderRegistry } from "../providers/provider-registry.js";

export interface ReflectedPracticeHypothesis {
  statement: string; trigger: string; procedure: string; expectedOutcome: MetricExpectation[];
  observedComponents: AttributionComponent[]; contraindications: string[];
}
export interface PracticeReflector { available(): Promise<boolean>; reflect(episode: ExperienceEpisode, sourceFacts: unknown[]): Promise<ReflectedPracticeHypothesis[]> }

export class ProviderPracticeReflector implements PracticeReflector {
  constructor(private readonly providers: ProviderRegistry) {}
  async available(): Promise<boolean> { const status = await this.providers.status(); return status.openai.configured || status.anthropic.configured; }
  async reflect(episode: ExperienceEpisode, sourceFacts: unknown[]): Promise<ReflectedPracticeHypothesis[]> {
    const configs = await this.providers.modelConfigs(); const selected = configs.find((item) => item.isDefault) ?? configs[0];
    if (!selected) return [];
    const result = await this.providers.runModelTurnWithRetry({ provider: selected.provider, model: selected.model, tools: [], instructions: instructions(),
      history: [{ type: "user_message", content: JSON.stringify({ episode, sourceFacts }) }] });
    const text = result.items.filter((item): item is Extract<typeof item, { type: "assistant_message" }> => item.type === "assistant_message").map((item) => item.content).join("\n").trim();
    const parsed = JSON.parse(extractJson(text)) as unknown; if (!Array.isArray(parsed)) throw new Error("Practice reflector must return a JSON array");
    return parsed.map(validateHypothesis);
  }
}

function validateHypothesis(value: unknown): ReflectedPracticeHypothesis {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Practice hypothesis is invalid"); const item = value as Record<string, unknown>;
  const components = ["memory", "prompt", "skill", "agent_profile", "workflow", "runtime_config", "tool", "provider", "plan", "policy", "environment", "unknown"];
  if (![item.statement, item.trigger, item.procedure].every((field) => typeof field === "string" && field.trim()) || !Array.isArray(item.expectedOutcome) || !item.expectedOutcome.length
    || !Array.isArray(item.observedComponents) || !item.observedComponents.length || item.observedComponents.some((component) => !components.includes(String(component))) || !Array.isArray(item.contraindications)) throw new Error("Practice hypothesis fields are invalid");
  return { statement: String(item.statement).trim(), trigger: String(item.trigger).trim(), procedure: String(item.procedure).trim(),
    expectedOutcome: item.expectedOutcome as MetricExpectation[], observedComponents: item.observedComponents as AttributionComponent[], contraindications: item.contraindications.map(String) };
}
function extractJson(value: string): string { const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(value); if (fenced) return fenced[1]!; const start = value.indexOf("["); const end = value.lastIndexOf("]"); if (start < 0 || end < start) throw new Error("Practice reflector returned no JSON array"); return value.slice(start, end + 1); }
function instructions(): string { return `Return only a JSON array. Derive zero or more open-ended operational Practice hypotheses strictly from the supplied authoritative Episode and source facts. Return [] when evidence does not reveal an observed action or method. Never select from a rule catalog and never invent missing behavior. Each item must contain non-empty statement, trigger, procedure, expectedOutcome [{metric,direction,minimumDelta?}], observedComponents, and contraindications. Describe the actual observed method (for example a briefing or review sequence), not a generic instruction to fix the cause. Do not widen scope or include secrets.`; }
