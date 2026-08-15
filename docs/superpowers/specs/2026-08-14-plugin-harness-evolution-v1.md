# AutoAgent Plugin/Harness Extension Host V1

日期：2026-08-14
状态：In progress；Local Plugin 是 Evol V1 的一种本地资产

## 1. 目标与非目标

本规范定义 Local Plugin 如何作为版本化 Evol 资产被扫描、评测、批准，并在下一 session 装载。一次性运行脚本不构成进化；只有 Bundle 被写入本地 release store、active pointer 改变、下一 session 实际挂载并留下 inheritance proof，才构成 Plugin 进化结果。

默认实现必须在 Windows、macOS 和 Linux 上直接使用 AutoAgent 内置的本地子进程 Host，不要求 WSL、PowerShell、Docker、Kubernetes 或外部 Sandbox Provider。多租户 SaaS 若要运行不受信代码，可以额外接入 container、gVisor、Firecracker 等隔离器；这是部署加固，不是 Local Plugin 的定义、加载边界或完成前提。

首个可生产版本支持两种贡献：

1. `plugin`：注册命名空间隔离的函数工具；
2. `harness`：注册工具调用前后的确定性 guardrail。

扩展代码不进入 AutoAgent 主进程，只通过版本化逐行 JSON 协议与内置子进程 Host 通信。默认 Host 使用最小环境、执行期限、输入输出上限和 Node Permission Model，并通过 broker 提供显式能力。它足以作为受控本地 Bundle 的跨平台默认执行方式，但不宣称能安全运行任意恶意代码。V1 不开放网络、子进程、Worker、原生扩展、任意环境变量或直接 Workspace 写入；因此 release rollback 只需撤销能力挂载，不需要猜测外部副作用。

## 2. 设计依据

- Node Permission Model：作为额外安全带默认拒绝文件、网络、子进程、Worker、原生扩展和 inspector，但不宣称是恶意代码安全边界；
- VS Code Extension Host：扩展与主进程分离、声明 activation/lifecycle；
- OpenAI Agents SDK Tool Guardrails：每次函数工具调用都经过输入/输出 guardrail；
- DeepSeek Harness：capability seam、typed protocol、可逆 mount/unmount 与 telemetry；
- AutoAgent Evol V1：不可变 Candidate、独立 Eval、shadow/canary/production、pointer generation 与 rollback ledger。

## 3. Bundle 契约

Candidate 的 `artifactContent` 是 UTF-8 JSON：

```json
{
  "schemaVersion": 1,
  "manifest": {
    "id": "release-review",
    "version": "1.0.0",
    "kind": "plugin",
    "apiVersion": "autoagent.plugin/v1",
    "entrypoint": "index.mjs",
    "description": "...",
    "permissions": { "workspaceRead": ["docs/**"] },
    "contributions": {
      "tools": [{
        "name": "summarize_release",
        "description": "...",
        "inputSchema": { "type": "object", "additionalProperties": false }
      }],
      "guardrails": []
    },
    "lifecycle": { "activation": "onDemand", "invokeTimeoutMs": 5000 }
  },
  "files": [{ "path": "index.mjs", "content": "..." }]
}
```

约束：

- manifest id 必须等于 Candidate target，kind 必须等于 Candidate kind；
- entrypoint 与所有文件必须是规范化相对路径，不允许 symlink、绝对路径或 `..`；
- 文件数不超过 32，总解包大小不超过 512 KiB，单文件不超过 256 KiB；
- 工具本地名不直接暴露；Runtime 使用 `evo_<plugin>_<tool>` 生成全局唯一名；
- plugin 至少声明一个 tool，harness 至少声明一个 guardrail；
- plugin/harness 一律为 `critical` 风险；Agent 可以提案，但 canary/production 必须由 human 批准；Coordinator 不自动晋升；
- manifest、文件清单、scanner 版本和每个文件 SHA-256 均进入内容寻址 provenance。

## 4. 执行协议

Entrypoint 导出：

```js
export default {
  async activate(context) {},
  async invokeTool({ name, input, context }) {},
  async guard({ name, phase, tool, input, output, context }) {},
  async health() { return { ok: true }; },
  async deactivate() {}
}
```

可选外部 Host adapter 可以支持 Python entrypoint（`.py`），对应导出 `activate(context)`、`health(context)`、`invoke_tool(name, input, context)`、`guard(name, phase, tool, input, output, context)` 与 `deactivate(context)`；函数均可为同步或 async。V1 默认内置 Host 以 Node ESM Bundle 为权威跨平台路径。

宿主按调用启动一次本地 Host，完成 `activate -> health -> invoke/guard -> deactivate` 后退出。完整生命周期受统一硬 deadline、协议上限和进程资源上限约束；stdout 使用有界逐行协议，stderr 有界采集，非零退出、超时、畸形消息和超限输出全部 fail closed。未配置外部 Launcher 时自动使用内置 Host，不能阻止 canary、production 或 active Runtime 投影。

插件只能通过 `context.requestCapability()` 请求 broker。V1 broker 仅支持 `workspace.read`，并同时满足：

1. manifest 路径 allowlist；
2. Candidate scope 要求 `readFile`；
3. 当前 Agent policy 实际启用 `readFile`；
4. AutoAgent 原有路径边界、隐藏目录限制和 Evidence capture。

插件进程继承最小环境，不继承 Provider key、凭据或业务配置。

### 4.1 可选的外部隔离 Host

当部署方显式配置 `AUTOAGENT_EVOLUTION_PLUGIN_SANDBOX_PROGRAM` 时，它必须是服务启动时存在的绝对路径，并实现同一逐行 JSON 协议。该 adapter 可以建立独立 OS 用户、容器命名空间、只读 Bundle mount、无网络和 CPU/内存/PID 限额。它只替换 Bundle 的执行位置，不拥有 Candidate、promotion、active pointer、session 重建或 rollback 状态。

AutoAgent 能验证外部 Host 的配置存在性和协议行为，但不能从进程内部证明外层 OS 隔离正确。需要强隔离的多租户部署应单独完成部署 attestation；本地或单租户环境未配置该 adapter 时继续使用内置 Host。

仓库中的 WSL/bubblewrap 脚本仅是可选部署示例，不进入默认路径、跨平台契约、UI 健康状态或 V1 验收。

## 5. Mount、Canary 与 Rollback

- Runtime 只从 active pointer 和不可变 release manifest 投影扩展；未配置外部 Host 时选择内置 Host；
- 每次建 Pi session 都重新校验 release、bundle manifest、scanner provenance、文件 hash、scope 与 policy；
- production 与被稳定分桶选中的 canary 才会挂载；shadow 永不进入 Agent tool surface；
- 同一全局工具名出现多个 release 时 fail closed，不按目录顺序覆盖；
- active pointer generation 或内容变化会改变 runtime fingerprint，使旧 Pi session 在下一轮销毁并重建；
- rollback 先写 ledger/pointer，再由 session fingerprint 触发卸载；新 session 不再暴露该工具或 guardrail；
- harness guardrail 的 reject 会阻止底层工具执行，post guardrail 不能篡改权威 Evidence，只能拒绝向模型返回结果。

## 6. Scanner 与治理

静态 Scanner 拒绝：

- `child_process`、`worker_threads`、network/TLS/DNS、WASI、native addon；
- `eval`、`new Function`、WebAssembly、`process.binding`、inspector；
- 非相对第三方 import、动态非字面量 import、CommonJS `require`；
- 凭据、治理绕过、危险删除命令和绝对路径；
- 未声明 broker capability 或 scope/tool 不一致。

Scanner 通过不等于效果通过；候选仍须经过 target/regression/safety Eval Suite。内置 Host 提供进程隔离、最小环境、Permission Model 和 broker 边界，但不构成任意恶意代码的强安全边界。若威胁模型包含不受信租户代码，部署方应启用经过认证的外部隔离 Host；这项部署选择不改变 Evol 生命周期语义。

## 7. 验收标准

只有同时满足以下条件才可称为完成：

- 安全 bundle 可被确定性解析、扫描、解包和重新验 hash；
- 非法路径、依赖、网络、进程、动态代码和凭据 fixture 均被拒绝；
- 不配置任何外部 Launcher 时，production plugin 工具可被下一真实 Pi session 看见并执行；
- broker read 同时受 manifest、scope 和 Agent policy 三重约束并生成 Evidence；
- harness pre-tool reject 确实阻止底层工具执行；
- canary 仅对稳定选中 cohort 挂载；
- production promotion 不热插入当前 session；下一 session 才挂载并留下 inheritance proof；
- rollback 后同一个 Pi thread 的下一 session 重建，工具/guardrail 消失或恢复 previous release；
- 子进程超时、崩溃、协议污染和超限输出 fail closed，不拖垮主进程；
- Agent 不能批准 plugin/harness，系统 Coordinator 不能自动推到 canary/production；
- 重启、promotion replay 和 rollback replay 不产生重复挂载；
- 全量测试、类型检查和生产构建通过。
