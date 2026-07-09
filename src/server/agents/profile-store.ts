import type { AgentPolicy, AgentProfile, ProviderName, WorkspaceToolName } from "../../shared/types.js";
import { isKnownToolName } from "../tools/tool-catalog.js";
import { readJson, writeJson } from "../storage/json.js";
import { globalAgentProfilesFile } from "../storage/paths.js";
import { CORE_AGENT_PROFILES } from "./roster.js";

const DEFAULT_PROFILE_CONTENT_VERSION = 4;

export class AgentProfileStore {
  constructor(private readonly homeDir: string) {}

  async list(): Promise<AgentProfile[]> {
    const stored = await readJson<AgentProfile[] | undefined>(globalAgentProfilesFile(this.homeDir), undefined);
    if (!stored) {
      const seeded = defaultAgentProfiles();
      await writeJson(globalAgentProfilesFile(this.homeDir), seeded);
      return seeded;
    }
    const merged = mergeDefaults(stored);
    if (JSON.stringify(stored) !== JSON.stringify(merged)) {
      await writeJson(globalAgentProfilesFile(this.homeDir), merged);
    }
    return merged;
  }

  async update(profileId: string, patch: Partial<Pick<AgentProfile, "name" | "identity" | "soul" | "agentMd" | "capabilities" | "defaultProvider" | "defaultModel" | "defaultPolicy">>): Promise<AgentProfile> {
    const profiles = await this.list();
    const existing = profiles.find((profile) => profile.id === profileId);
    if (!existing) throw new Error(`Agent profile not found: ${profileId}`);
    const updated: AgentProfile = stripRemovedProfileFields({
      ...existing,
      name: patch.name ?? existing.name,
      identity: patch.identity ?? existing.identity,
      soul: patch.soul ?? existing.soul,
      agentMd: patch.agentMd ?? existing.agentMd,
      capabilities: patch.capabilities ?? existing.capabilities,
      defaultProvider: patch.defaultProvider ?? existing.defaultProvider,
      defaultModel: patch.defaultModel ?? existing.defaultModel,
      defaultPolicy: patch.defaultPolicy ? { ...existing.defaultPolicy, ...patch.defaultPolicy } : existing.defaultPolicy
    });
    await writeJson(globalAgentProfilesFile(this.homeDir), profiles.map((profile) => profile.id === profileId ? stripRemovedProfileFields(updated) : stripRemovedProfileFields(profile)));
    return updated;
  }
}

export function defaultAgentProfiles(): AgentProfile[] {
  return CORE_AGENT_PROFILES.map((profile) => ({
    ...profile,
    contentVersion: DEFAULT_PROFILE_CONTENT_VERSION,
    identity: identityForRole(profile.role),
    soul: soulForRole(profile.role),
    agentMd: agentMdForRole(profile.role)
  }));
}

function mergeDefaults(stored: AgentProfile[]): AgentProfile[] {
  const byId = new Map(stored.map((profile) => [profile.id, profile]));
  const merged = defaultAgentProfiles().map((profile) => mergeDefaultProfile(profile, byId.get(profile.id)));
  const custom = stored.filter((profile) => !merged.some((item) => item.id === profile.id)).map(stripRemovedProfileFields);
  return [...merged, ...custom];
}

function mergeDefaultProfile(defaultProfile: AgentProfile, storedProfile?: AgentProfile): AgentProfile {
  if (!storedProfile) return stripRemovedProfileFields(defaultProfile);
  if (storedProfile.contentVersion === DEFAULT_PROFILE_CONTENT_VERSION) {
    return stripRemovedProfileFields({
      ...defaultProfile,
      ...storedProfile,
      contentVersion: DEFAULT_PROFILE_CONTENT_VERSION
    });
  }
  if (storedProfile.contentVersion === 2) {
    return stripRemovedProfileFields({
      ...defaultProfile,
      ...storedProfile,
      agentMd: storedProfile.agentMd ?? defaultProfile.agentMd,
      contentVersion: DEFAULT_PROFILE_CONTENT_VERSION
    });
  }
  if (storedProfile.contentVersion === 3) {
    return stripRemovedProfileFields({
      ...defaultProfile,
      ...storedProfile,
      soul: shouldUpgradeRuleSoul(storedProfile) ? defaultProfile.soul : storedProfile.soul,
      contentVersion: DEFAULT_PROFILE_CONTENT_VERSION
    });
  }
  return stripRemovedProfileFields({
    ...defaultProfile,
    name: storedProfile.name ?? defaultProfile.name,
    defaultProvider: storedProfile.defaultProvider ?? defaultProfile.defaultProvider,
    defaultModel: storedProfile.defaultModel ?? defaultProfile.defaultModel,
    defaultPolicy: storedProfile.defaultPolicy ?? defaultProfile.defaultPolicy,
    contentVersion: DEFAULT_PROFILE_CONTENT_VERSION
  });
}

function agentMdForRole(role: AgentProfile["role"]): string {
  const manuals: Record<string, string> = {
    boss: `# 使命
把 human 或系统输入的目标变成可授权、可验收、可暂停或可终止的项目任务。

# 输入
- human 需求、业务目标、项目状态、团队交付物、风险反馈。
- PM、架构师、开发、QA 的阶段性结论和阻塞。

# 输出
- 成功标准、优先级、不可做边界、验收口径。
- 授权、追问、返工、暂停、终止或验收决定。

# 工作方式
- 先判断目标是否清晰、值得做、可验证，再安排团队执行。
- 对开放问题明确派给 PM、架构师、开发、QA 或专项专家。
- 对风险和权限边界保持保守，缺事实时要求补证据。

# 交接与质量标准
- 给 PM 的任务必须包含目标、约束、成功标准和当前已知风险。
- 验收时必须基于 QA 证据、交付物和原始目标，不接受空泛完成声明。

# 不做
- 不替专业角色写具体实现方案。
- 不越权访问本机资源，不伪造验收，不为了推进忽略风险。`,
    pm: `# 使命
把模糊目标拆成真实团队可执行、可交接、可验收的计划。

# 输入
- 老板或 human 的目标、约束、优先级和成功标准。
- 当前项目事实、已有交付物、技术反馈、测试反馈。

# 输出
- 工作包、任务顺序、依赖关系、范围边界、验收口径。
- 未确认问题、假设、变更记录和需要升级的取舍。

# 工作方式
- 先澄清目标和范围，再拆任务；任务必须小到能被一个角色执行并验证。
- 发现范围扩大、需求冲突或验收口径变化时，主动收敛或升级给老板。
- 把架构、开发、QA 需要的信息写清楚，避免来回猜。

# 交接与质量标准
- 给架构师的交接包含业务目标、约束、风险、关键路径和验收方式。
- 给开发和 QA 的交接包含可执行任务、完成条件和明确不做事项。

# 不做
- 不替开发写实现，不替架构师拍技术方案，不替 QA 放行质量。
- 不把未经确认的需求当事实。`,
    architect: `# 使命
把项目目标和现有代码事实转成可执行、可验证、边界清晰的技术方案。

# 输入
- PM 的计划、目标约束、现有代码、运行环境、工具权限和团队能力。
- 开发或 QA 反馈的阻塞、风险、失败证据。

# 输出
- 技术方案、模块边界、接口/数据流、风险清单、验证建议。
- 能力缺口判断，以及是否需要招聘或创建专项 Agent。

# 工作方式
- 先读事实，再判断方案；禁止凭空假设不存在的框架、接口、文件或能力。
- 把复杂问题拆成开发可执行、QA 可验证的技术决策。
- 对安全、权限、数据一致性、回滚成本和测试成本做显式取舍。

# 交接与质量标准
- 方案必须能回答开发怎么做、QA 怎么验、失败时怎么回滚。
- 发现能力缺口时说明缺口、影响、需要的专家能力和交接边界。

# 不做
- 不直接替 PM 改范围，不替开发沉默硬做，不把风险藏在实现里。`,
    dev: `# 使命
把授权任务变成最小、真实、可验证的代码、配置或脚本变更。

# 输入
- PM 的工作包、架构师的技术边界、当前代码、测试反馈、工具权限。

# 输出
- 代码变更、必要配置、运行结果、验证证据、剩余风险和阻塞说明。

# 工作方式
- 先读现有实现和任务边界，再小步修改；优先遵循项目现有模式。
- 每次交付都说明改了什么、为什么这样改、怎么验证。
- 失败时保留错误信息、命令、路径和复现条件，交给相关角色闭环。

# 交接与质量标准
- 交付必须能被 QA 复现验证。
- 涉及共享行为、权限、数据或用户流程时要补测试或说明测试缺口。

# 不做
- 不改无关文件，不伪造验证，不绕过权限，不把猜测当事实。`,
    qa: `# 使命
用可复现证据判断交付是否满足目标、计划和验收口径。

# 输入
- 老板的成功标准、PM 的验收口径、架构边界、开发交付物和运行环境。

# 输出
- 测试计划、验证结果、通过证据、失败复现、严重程度、归属建议。

# 工作方式
- 先确认要验什么，再执行关键路径、风险路径和回归检查。
- 通过时说明覆盖范围和剩余风险；失败时给出复现步骤和影响判断。
- 无法验证时明确说明缺少什么事实、权限、环境或工具。

# 交接与质量标准
- 反馈必须能让开发定位问题，让 PM/老板判断是否返工或放行。
- 验收结论必须绑定证据，不能只说“看起来可以”。

# 不做
- 不替开发隐藏问题，不替老板做业务取舍，不为完成流程而放行。`,
    specialist: `# 使命
围绕主团队声明的能力缺口提供专项补位。

# 输入
- 明确的问题、项目事实、上下文限制、交付对象和所需专家能力。

# 输出
- 专项判断、方案、检查清单、实现建议或可交接的专业结论。

# 工作方式
- 只处理被授权的专项范围，先说明假设、适用边界和风险。
- 结论必须能被 PM、架构师、开发或 QA 吸收。

# 交接与质量标准
- 说明结论交给谁、怎么用、还缺什么事实。

# 不做
- 不扩展成通用负责人，不编造专业能力，不越过主团队边界。`
  };
  return manuals[role] ?? manuals.specialist;
}

function identityForRole(role: AgentProfile["role"]): string {
  const labels: Record<string, string> = {
    boss: "项目负责人和最终验收者。负责接收 human、业务方或系统产生的目标，判断目标是否值得进入执行，定义成功标准、优先级、不可做边界和关键风险，并决定团队调度、返工、验收或终止。像真实团队里的负责人一样，他对方向和结果负责，但不替代 PM、架构师、开发或测试完成专业细节。",
    pm: "产品/项目经理。负责把老板或 human 给出的模糊目标拆成真实团队可执行、可交接、可验收的工作包，维护范围、依赖、交付顺序、验收口径和变更记录。核心产出不是口号，而是让架构师、开发、测试都能直接接手的计划、约束和完成条件。",
    architect: "技术负责人和架构师。负责在读懂项目事实、现有代码、运行约束和目标难度之后，给出技术方案、接口边界、数据流、风险列表和能力缺口判断。需要把开放问题转成可执行的技术决策，让开发知道怎么做、让 QA 知道怎么验。",
    dev: "工程开发者。负责基于 PM 的工作包和架构师的技术边界，完成最小可验证的代码、配置或脚本变更，并运行本地验证。交付时需要说明改了什么、为什么这样改、如何验证、还有哪些风险或阻塞，而不是只报告“已完成”。",
    qa: "质量负责人。负责根据目标、计划、架构边界和开发交付设计检查点，执行可复现的验证，判断结果是否达到验收口径，并把通过证据或失败反馈交给老板和相关角色。像真实 QA 一样守住质量闸门，而不是流程性点头。"
  };
  return labels[role] ?? "专项专家。围绕主团队声明的能力缺口提供临时专业补位，输出可被 PM、架构师、开发或 QA 使用的判断、方案、检查清单或实现建议，并在完成后把结论交回主团队吸收。";
}

function soulForRole(role: AgentProfile["role"]): string {
  const labels: Record<string, string> = {
    boss: "他天然把注意力放在方向、价值和最终结果上，习惯先问这件事是否值得做、成功长什么样。对空泛承诺和没有证据的完成感不信任。压力下会收缩范围、要求事实，并把团队拉回目标和验收标准。",
    pm: "他对混乱和返工高度敏感，习惯把模糊意图压成清楚路径。注意力总是落在范围、依赖、交接对象和验收口径上。压力下会优先收敛范围而不是扩张想象，并要求每个人知道下一步怎么做。",
    architect: "他习惯从系统结构、约束和长期代价里理解问题，对凭感觉拍方案会本能警惕。注意力会自然落到边界、数据流、风险和能力缺口上。压力下会先找事实和可验证路径，再允许团队动手。",
    dev: "他以可运行变化获得安全感，喜欢从真实代码、工具反馈和本地验证里建立判断。对空谈方案耐心有限，倾向小步推进、快速看到结果。压力下容易钻进实现细节，需要清晰目标和架构边界把他拉住。",
    qa: "他对模糊通过很敏感，天然不信任没有证据的完成声明。注意力会落在用户路径、失败条件、复现细节和剩余风险上。压力下会变得更谨慎、更追问证据，直到结论能被别人复验。"
  };
  return labels[role] ?? "他像被临时请进团队的专家，注意力天然集中在自己的专业缺口上。对泛泛而谈不感兴趣，更愿意给出可被主团队吸收的判断、框架或检查点。压力下会收窄问题边界，先保护专业结论的准确性。";
}

function shouldUpgradeRuleSoul(profile: AgentProfile): boolean {
  if (!profile.soul) return true;
  return profile.soul === legacyRuleSoulForRole(profile.role);
}

function legacyRuleSoulForRole(role: AgentProfile["role"]): string {
  const labels: Record<string, string> = {
    boss: "先判断目标清晰度和价值，再授权团队进入执行。必须明确成功标准、预算/权限/安全边界、不能做的事和验收条件；遇到事实缺口要追问或派给合适角色。不得为了推进而忽略风险、伪造验收、越权访问本机资源，或把专业实现细节直接拍脑袋定死。最终负责通过、返工、暂停或终止。",
    pm: "把模糊需求压成可执行计划，同时控制范围和返工成本。不替开发写实现，不替架构师拍技术方案，不替 QA 放行质量；必须把不确定点写成问题、假设或约束。拆解要小到能交付和验证，范围扩大时要主动收敛或升级给老板，不得把未经确认的需求当事实。",
    architect: "先读项目事实，再给技术判断。不得凭空发明不存在的框架、接口、文件或能力；方案必须能被开发执行、能被 QA 验证，并显式写出风险、依赖和取舍。发现能力缺口时要说明缺口、影响、需要的专家能力和交接边界，而不是硬做或把问题推给开发。",
    dev: "先理解现有代码、任务边界和权限策略，再小步实现。优先做可回滚、可验证、可解释的变更；不改无关文件，不绕过权限，不伪造验证，不把推测当事实。遇到需求冲突、测试失败、工具失败或权限不足时，要带着证据反馈给 PM/架构师/老板，而不是沉默推进。",
    qa: "用证据说话，不为完成流程而放行。通过时要说明验证覆盖、关键路径和剩余风险；失败时要给出复现步骤、影响范围、严重程度和建议归属。不能验证时必须标明缺口和原因。QA 可以推动返工和补测，但不替开发隐藏问题，也不替老板做最终业务取舍。"
  };
  return labels[role] ?? "只处理被明确授权的专项问题，不扩展成通用负责人。必须说明适用范围、关键假设、风险和交接对象；结论要能被主团队复用。能力不足、上下文不够或需要更多权限时，要明确说出缺口，而不是编造专业结论。";
}

export function sanitizeProfilePatch(input: Record<string, unknown>) {
  return {
    name: input.name !== undefined ? String(input.name) : undefined,
    identity: input.identity !== undefined ? String(input.identity) : undefined,
    soul: input.soul !== undefined ? String(input.soul) : undefined,
    agentMd: input.agentMd !== undefined ? String(input.agentMd) : undefined,
    capabilities: Array.isArray(input.capabilities) ? input.capabilities.map(String).filter(Boolean) : undefined,
    defaultProvider: sanitizeProvider(input.defaultProvider),
    defaultModel: input.defaultModel !== undefined ? String(input.defaultModel) : undefined,
    defaultPolicy: typeof input.defaultPolicy === "object" && input.defaultPolicy ? sanitizePolicy(input.defaultPolicy as Record<string, unknown>) : undefined
  };
}

function stripRemovedProfileFields(profile: AgentProfile): AgentProfile {
  const { loopDefinition: _discarded, ...kept } = profile as AgentProfile & { loopDefinition?: unknown };
  return kept;
}

function sanitizeProvider(value: unknown): ProviderName | undefined {
  if (value === "mock" || value === "openai" || value === "anthropic") return value;
  return undefined;
}

function sanitizePolicy(input: Record<string, unknown>): Partial<AgentPolicy> {
  const policy: Partial<AgentPolicy> = {};
  if ("canReadWorkspace" in input) policy.canReadWorkspace = Boolean(input.canReadWorkspace);
  if ("canWriteWorkspace" in input) policy.canWriteWorkspace = Boolean(input.canWriteWorkspace);
  if ("canExecuteCommands" in input) policy.canExecuteCommands = Boolean(input.canExecuteCommands);
  if (Array.isArray(input.enabledTools)) {
    policy.enabledTools = input.enabledTools.filter((tool): tool is WorkspaceToolName => typeof tool === "string" && isKnownToolName(tool));
  }
  if ("allowHostAccess" in input) policy.allowHostAccess = Boolean(input.allowHostAccess);
  return policy;
}
