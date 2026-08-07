/**
 * Keep schema-repair guidance generic. The Agent Engine may explain the
 * shape error, but it must not infer a domain result or rewrite the payload.
 */
export function schemaValidationRecoveryHint(validation: string): string {
  const normalized = validation.toLowerCase();
  if (normalized.includes("must be object") && /(?:array|\/\d+|\.\d+)/i.test(validation)) {
    return [
      "结构化参数提示：错误路径指向数组项，数组中的每一项都必须是完整对象。",
      "请按当前工具定义重新提交完整参数：重新生成完整参数，不要在被拒绝的参数上局部追加字段；先完整结束当前对象，再结束数组，数组外字段必须放回父对象。",
      "只修复参数结构，保留你已经根据事实作出的结论、证据和风险判断；平台不会替你推断缺失字段、修改证据或替换结论。",
    ].join("\n");
  }
  if (normalized.includes("must be array")) {
    return [
      "结构化参数提示：该字段必须是数组。请重新生成完整参数，并确保数组中的每一项符合当前工具定义。",
      "不要把对象字段、说明文字或父对象字段作为数组项；平台不会替你推断缺失字段、修改证据或替换结论。",
    ].join("\n");
  }
  return "请按当前工具定义重新提交完整参数：重新生成完整参数，不要在被拒绝的参数上局部追加字段；平台不会替你推断缺失字段、修改证据或替换结论。";
}

/**
 * Domain adapters own business output contracts. The Agent Engine only tells
 * the model that the submitted result needs another complete attempt; it must
 * not reinterpret the domain decision or manufacture a replacement payload.
 */
export function domainContractRecoveryHint(): string {
  return [
    "领域输出契约校验未通过：这表示提交的 domainOutcome 结构不符合当前任务契约，不代表工作结论已经改变。",
    "请在同一个 Goal/Thread 的下一轮基于已有事实，重新生成完整 domainOutcome；保留已经得到的结论、证据和风险判断。",
    "平台不会替你选择业务结论、补造证据或改写字段，只负责把校验原因传回给你。",
  ].join("\n");
}
