import type { AttributionComponent, ExperienceEpisode, MetricExpectation } from "../../shared/contracts/evolution.js";
import type { ProviderRegistry } from "../providers/provider-registry.js";
import type { EvolutionReflectionFact } from "./observation-port.js";
import type { AgentModelHistoryItem } from "../providers/types.js";
import { EVOLUTION_METRIC_NAMES, isSafeEvolutionMetricDirection, isSupportedEvolutionMetric } from "./metric-gate.js";

export interface ReflectedPracticeHypothesis {
  statement: string; conceptKey?: string; trigger: string; procedure: string; expectedOutcome: MetricExpectation[];
  observedComponents: AttributionComponent[]; guardrails?: string[]; contraindications: string[];
}
export interface PracticeReflector { available(): Promise<boolean>; reflect(episode: ExperienceEpisode, sourceFacts: EvolutionReflectionFact[]): Promise<ReflectedPracticeHypothesis[]> }

export class ProviderPracticeReflector implements PracticeReflector {
  constructor(private readonly providers: ProviderRegistry) {}
  async available(): Promise<boolean> { const status = await this.providers.status(); return status.openai.configured || status.anthropic.configured; }
  async reflect(episode: ExperienceEpisode, sourceFacts: EvolutionReflectionFact[]): Promise<ReflectedPracticeHypothesis[]> {
    const configs = await this.providers.modelConfigs(); const selected = configs.find((item) => item.isDefault) ?? configs[0];
    if (!selected) return [];
    const history: AgentModelHistoryItem[] = [{ type: "user_message", content: JSON.stringify({ episode, sourceFacts }) }];
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await this.providers.runModelTurnWithRetry({ provider: selected.provider, model: selected.model, tools: [], instructions: instructions(), history });
      const text = result.items.filter((item): item is Extract<typeof item, { type: "assistant_message" }> => item.type === "assistant_message").map((item) => item.content).join("\n").trim();
      try {
        const parsed = JSON.parse(extractJson(text)) as unknown;
        if (!Array.isArray(parsed)) throw new Error("Practice reflector must return a JSON array");
        return parsed.map(validateHypothesis);
      } catch (error) {
        lastError = error;
        if (attempt > 0) break;
        history.push({ type: "assistant_message", content: text.slice(0, 12_000) });
        history.push({ type: "user_message", content: `The JSON failed validation: ${error instanceof Error ? error.message : String(error)}. Return a corrected JSON array only, using the exact allowed enums and field shapes from the instructions.` });
      }
    }
    throw lastError;
  }
}

function validateHypothesis(value: unknown): ReflectedPracticeHypothesis {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Practice hypothesis is invalid"); const item = value as Record<string, unknown>;
  const components = ["memory", "prompt", "skill", "agent_profile", "workflow", "runtime_config", "tool", "provider", "plan", "policy", "environment", "unknown"];
  if (![item.statement, item.trigger, item.procedure].every((field) => typeof field === "string" && field.trim()) || (item.conceptKey !== undefined && (typeof item.conceptKey !== "string" || !item.conceptKey.trim())) || !Array.isArray(item.expectedOutcome) || !item.expectedOutcome.length
    || !Array.isArray(item.observedComponents) || !item.observedComponents.length || item.observedComponents.some((component) => !components.includes(String(component)))
    || (item.guardrails !== undefined && (!Array.isArray(item.guardrails) || item.guardrails.some((value) => typeof value !== "string")))
    || !Array.isArray(item.contraindications) || item.contraindications.some((value) => typeof value !== "string")) throw new Error("Practice hypothesis fields are invalid");
  for (const expectation of item.expectedOutcome) {
    if (!expectation || typeof expectation !== "object" || Array.isArray(expectation)) throw new Error("expectedOutcome entries must be objects");
    const metric = expectation as Record<string, unknown>;
    if (typeof metric.metric !== "string" || !isSupportedEvolutionMetric(metric.metric) || !["increase", "decrease", "maintain"].includes(String(metric.direction))) throw new Error("expectedOutcome requires a registered measurable metric and direction increase|decrease|maintain");
    if (!isSafeEvolutionMetricDirection(metric as unknown as MetricExpectation)) throw new Error("expectedOutcome cannot reward increasing cost, latency, failure, intervention, or violation metrics");
    if (metric.minimumDelta !== undefined && (typeof metric.minimumDelta !== "number" || !Number.isFinite(metric.minimumDelta))) throw new Error("expectedOutcome minimumDelta must be numeric");
  }
  return { statement: String(item.statement).trim(), ...(item.conceptKey ? { conceptKey: String(item.conceptKey).trim() } : {}), trigger: String(item.trigger).trim(), procedure: String(item.procedure).trim(),
    expectedOutcome: item.expectedOutcome as MetricExpectation[], observedComponents: item.observedComponents as AttributionComponent[], guardrails: (item.guardrails ?? []) as string[], contraindications: item.contraindications.map(String) };
}
function extractJson(value: string): string { const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(value); if (fenced) return fenced[1]!; const start = value.indexOf("["); const end = value.lastIndexOf("]"); if (start < 0 || end < start) throw new Error("Practice reflector returned no JSON array"); return value.slice(start, end + 1); }
function instructions(): string { return `Return only a JSON array. Derive zero or more open-ended operational Practice hypotheses strictly from the supplied authoritative Episode and chronological sourceFacts. Return [] when evidence does not reveal an observed action or method. Never select from a rule catalog and never invent missing behavior. Pay special attention to a sequence of errors or stalled execution, a later human_intervention, and a subsequent successful outcome. Treat that ordering as a candidate recovery method, not proof of causality; state a narrow trigger and require verification. Separate provider/environment reliability failures from workflow or agent behavior. Each item must contain: statement:string; conceptKey?:string (a short stable semantic family such as workflow.pre_implementation_briefing); trigger:string; procedure:string; expectedOutcome: a non-empty array of {metric:string,direction:"increase"|"decrease"|"maintain",minimumDelta?:number}, where metric must be one of ${EVOLUTION_METRIC_NAMES.join("|")}; observedComponents: a non-empty array using only "memory"|"prompt"|"skill"|"agent_profile"|"workflow"|"runtime_config"|"tool"|"provider"|"plan"|"policy"|"environment"|"unknown"; guardrails:string[] for cautious applicability notes; contraindications:string[] only for actual counter-evidence or conditions that make the method unsafe. Describe the concrete observed method, not a generic instruction to fix the cause. Do not widen scope or include secrets.`; }
