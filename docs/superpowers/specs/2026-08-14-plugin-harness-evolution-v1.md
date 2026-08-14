# AutoAgent Plugin/Harness Extension Host V1

日期：2026-08-14
状态：Implemented prototype；独立扩展基础设施，不是 Evol 自进化定义

## 1. 目标与非目标

本规范定义可执行扩展如何被扫描、评测、灰度和装载。它解决的是 extension execution，不是 Evol 自进化本体；临时执行扩展不构成进化，只有版本化资产被激活并由后续运行继承才构成进化结果。

跨平台 SaaS 的生产实现必须把 Extension Host 抽象为平台无关 Sandbox Provider/Data Plane。本规范中的 WSL/PowerShell Launcher 只是本地开发适配器，不是生产架构要求。

首个可生产版本支持两种贡献：

1. `plugin`：注册命名空间隔离的函数工具；
2. `harness`：注册工具调用前后的确定性 guardrail。

扩展代码永不进入 AutoAgent 主进程。它只能通过版本化 JSON-RPC 协议与宿主通信。内置 Node Permission Model 子进程用于开发、协议测试和纵深防御；Node 官方明确说明它不能抵御恶意代码，因此 canary/production 必须配置 `AUTOAGENT_EVOLUTION_PLUGIN_SANDBOX_PROGRAM`，由运维提供真正的 OS 级隔离 Launcher（独立用户/container/gVisor/Firecracker 等）。V1 不开放网络、子进程、Worker、原生扩展、任意环境变量或直接 Workspace 写入；因此 release rollback 只需撤销能力挂载，不需要猜测外部副作用。

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
-工具本地名不直接暴露；Runtime 使用 `evo_<plugin>_<tool>` 生成全局唯一名；
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

生产 Launcher 也支持 Python entrypoint（`.py`），对应导出 `activate(context)`、`health(context)`、`invoke_tool(name, input, context)`、`guard(name, phase, tool, input, output, context)` 与 `deactivate(context)`；函数均可为同步或 async。两种语言使用同一份 manifest、能力代理和生命周期语义。

宿主按调用请求一次 Sandbox Launcher，完成 `activate -> health -> invoke/guard -> deactivate` 后退出。完整生命周期受统一硬 deadline、协议上限和 Launcher 的 OS 资源限制约束；stdout 使用有界逐行协议，stderr 有界采集，非零退出、超时、畸形消息和超限输出全部 fail closed。未配置 Launcher 时，shadow 仍可保存但 canary/production 晋升和 active Runtime 投影都确定性拒绝。

插件只能通过 `context.requestCapability()` 请求 broker。V1 broker 仅支持 `workspace.read`，并同时满足：

1. manifest 路径 allowlist；
2. Candidate scope 要求 `readFile`；
3. 当前 Agent policy 实际启用 `readFile`；
4. AutoAgent 原有路径边界、隐藏目录限制和 Evidence capture。

插件进程继承最小环境，不继承 Provider key、凭据或业务配置。

### 4.1 OS Sandbox Launcher 部署契约

`AUTOAGENT_EVOLUTION_PLUGIN_SANDBOX_PROGRAM` 必须是绝对路径且在服务启动时已存在。AutoAgent 以 `<launcher> <entrypoint>` 启动原生 Launcher；若路径是 `.js/.mjs/.cjs`，则使用当前 Node 执行该 Launcher。Launcher 必须实现本节逐行 JSON 协议，并在加载 entrypoint 前建立独立 OS 用户/容器命名空间、只读 Bundle mount、无网络、无宿主进程可见性、CPU/内存/PID/deadline 限额。仅仅再启动一个同用户 Node 进程不满足生产安全要求；仓库中的 JavaScript fixture 只用于协议测试。

AutoAgent 能验证 Launcher 的配置存在性和协议行为，但不能从进程内部证明外层 OS 隔离正确；这是部署 attestation。未完成该 attestation 的环境必须保持变量未配置，从而让 canary/production fail closed。

仓库提供 `scripts/evolution-plugin-sandbox-wsl.ps1` 作为 Windows/WSL2 的具体参考实现：它通过 bubblewrap 创建新的 user/PID/network 等命名空间、清空环境与 capabilities，只读挂载不可变 Bundle 和可信 Python protocol shim，并设置进程资源上限。启用方式是把 `AUTOAGENT_EVOLUTION_PLUGIN_SANDBOX_PROGRAM` 指向该脚本的绝对路径；目标 WSL distribution（默认 `Ubuntu`）必须安装 `bwrap` 和 `python3`，也可用 `AUTOAGENT_EVOLUTION_PLUGIN_WSL_DISTRO` 显式指定。

## 5. Mount、Canary 与 Rollback

- Runtime 只从 active pointer 和不可变 release manifest 投影扩展，并再次确认 OS Sandbox Launcher 已配置；
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
-凭据、治理绕过、危险删除命令和绝对路径；
- 未声明 broker capability 或 scope/tool 不一致。

即使 Scanner 漏报，production 仍由经过部署认证的 OS Sandbox Launcher 提供独立运行时边界；Node Permission Model 只提供纵深防御，不构成恶意代码隔离。Scanner 通过不等于效果通过；候选仍须经过 target/regression/safety Eval Suite。

## 7. 验收标准

只有同时满足以下条件才可称为完成：

- 安全 bundle 可被确定性解析、扫描、解包和重新验 hash；
- 非法路径、依赖、网络、进程、动态代码和凭据 fixture 均被拒绝；
- 配置受信 OS Sandbox Launcher 后，production plugin 工具可被真实 Pi session 看见并执行；未配置时晋升与投影均 fail closed；
- broker read 同时受 manifest、scope 和 Agent policy 三重约束并生成 Evidence；
- harness pre-tool reject 确实阻止底层工具执行；
- canary 仅对稳定选中 cohort 挂载；
- rollback 后同一个 Pi thread 下一轮重建，工具/guardrail 消失；
- 子进程超时、崩溃、协议污染和超限输出 fail closed，不拖垮主进程；
- Agent 不能批准 plugin/harness，系统 Coordinator 不能自动推到 canary/production；
- 重启、promotion replay 和 rollback replay 不产生重复挂载；
- 全量测试、类型检查和生产构建通过。
