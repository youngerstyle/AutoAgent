import type { ModelConfig, ProviderName } from "../shared/types";

type ModelTarget = {
  provider: ProviderName;
  model: string;
};

export interface ModelSelectionOption extends ModelTarget {
  value: string;
  label: string;
}

const PROVIDER_LABELS: Record<ProviderName, string> = {
  mock: "模拟服务",
  openai: "OpenAI",
  anthropic: "Anthropic"
};

export function modelSelectionOptions(target: ModelTarget, configs: ModelConfig[]): ModelSelectionOption[] {
  const options = configs.map((config) => ({
    value: `config:${config.id}`,
    label: `${config.name}（${config.model}）`,
    provider: config.provider,
    model: config.model
  }));
  const hasMatchingConfig = configs.some((config) => config.provider === target.provider && config.model === target.model);
  const custom = target.provider !== "mock" && target.model && !hasMatchingConfig
    ? [{
        value: customModelValue(target),
        label: `${PROVIDER_LABELS[target.provider]}：${target.model}（未匹配配置）`,
        provider: target.provider,
        model: target.model
      }]
    : [];
  return [
    ...custom,
    { value: "mock", label: "模拟服务", provider: "mock", model: target.provider === "mock" ? target.model : "" },
    ...options
  ];
}

export function modelSelectionValue(target: ModelTarget, configs: ModelConfig[]): string {
  if (target.provider === "mock") return "mock";
  const match = configs.find((config) => config.provider === target.provider && config.model === target.model);
  return match ? `config:${match.id}` : customModelValue(target);
}

export function applyModelSelection(value: string, configs: ModelConfig[], current: ModelTarget): ModelTarget {
  if (value === "mock") return { provider: "mock", model: current.provider === "mock" ? current.model : "mock" };
  if (value.startsWith("config:")) {
    const configId = value.slice("config:".length);
    const config = configs.find((item) => item.id === configId);
    if (config) return { provider: config.provider, model: config.model };
  }
  return current;
}

function customModelValue(target: ModelTarget): string {
  return `custom:${target.provider}:${target.model}`;
}
