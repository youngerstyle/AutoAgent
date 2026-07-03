import { describe, expect, it } from "vitest";
import { applyModelSelection, modelSelectionOptions, modelSelectionValue } from "../../src/client/model-selection";
import type { ModelConfig } from "../../src/shared/types";

describe("model selection helpers", () => {
  const deepSeek: ModelConfig = {
    id: "mc_openai",
    name: "DeepSeek",
    provider: "openai",
    model: "deepseek-v4-flash",
    isDefault: true,
    createdAt: "2026-06-30T00:00:00.000Z",
    updatedAt: "2026-06-30T00:00:00.000Z"
  };

  it("uses the configured model name when provider and model match a saved config", () => {
    const options = modelSelectionOptions({ provider: "openai", model: "deepseek-v4-flash" }, [deepSeek]);

    expect(modelSelectionValue({ provider: "openai", model: "deepseek-v4-flash" }, [deepSeek])).toBe("config:mc_openai");
    expect(options).toEqual(expect.arrayContaining([
      expect.objectContaining({
        value: "config:mc_openai",
        label: "DeepSeek（deepseek-v4-flash）",
        provider: "openai",
        model: "deepseek-v4-flash"
      })
    ]));
  });

  it("keeps an unmatched provider/model visible as an explicit custom option", () => {
    const options = modelSelectionOptions({ provider: "openai", model: "gpt-custom" }, [deepSeek]);

    expect(modelSelectionValue({ provider: "openai", model: "gpt-custom" }, [deepSeek])).toBe("custom:openai:gpt-custom");
    expect(options[0]).toMatchObject({
      value: "custom:openai:gpt-custom",
      label: "OpenAI：gpt-custom（未匹配配置）"
    });
  });

  it("maps a selected config back to provider and model fields used by the runtime", () => {
    expect(applyModelSelection("config:mc_openai", [deepSeek], { provider: "mock", model: "mock-boss" })).toEqual({
      provider: "openai",
      model: "deepseek-v4-flash"
    });
  });
});
