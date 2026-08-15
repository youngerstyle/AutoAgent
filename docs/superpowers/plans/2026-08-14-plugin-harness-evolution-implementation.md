# Local Plugin Evolution 实施计划

依据：`docs/superpowers/specs/2026-08-14-plugin-harness-evolution-v1.md`

状态：V1 completed（2026-08-15）

说明：Local Plugin 是 Evol V1 的第四类本地资产。完成标准不是“执行了一次插件脚本”，而是“本地版本化 Bundle 被批准，active pointer 改变，下一 session 实际挂载，rollback 后再下一 session 卸载或恢复”。

## Milestone A：Bundle 与供应链

- [x] Plugin Bundle、manifest、scanner 和 content-addressed provenance。
- [x] 路径、文件数、大小、entrypoint、工具名和权限声明校验。
- [x] 危险 import、动态代码、网络、子进程、凭据与能力不一致拒绝。
- [x] Plugin 设为 critical，要求独立评测和 human approval。

退出标准：只有与 Candidate、manifest 和文件 hash 完全一致的不可变 Bundle 能进入 release store。

## Milestone B：跨平台内置 Local Host

- [x] Node ESM 子进程协议与 `activate -> health -> invoke/guard -> deactivate` 生命周期。
- [x] 最小环境、deadline、输出上限、协议校验和异常 fail closed。
- [x] 只读 capability broker，并复用 AgentToolRuntime policy 与 Evidence 管线。
- [x] 清空 `AUTOAGENT_EVOLUTION_PLUGIN_SANDBOX_PROGRAM` 后完成 scanner、canary、production 和调用回归。
- [x] 默认路径只调用当前 Node executable 并使用参数数组，不依赖 WSL、PowerShell 或 shell command；平台专用隔离器仅由显式 adapter 配置进入。

退出标准：不安装、不配置任何外部隔离器时，受控本地 Plugin 能在内置 Host 中运行；超时、崩溃、协议污染和越权请求仍确定性失败。

## Milestone C：next-session Mount 与 Rollback

- [x] Runtime projection 输出 active plugins/harnesses。
- [x] Pi tool surface 使用 `evo_<plugin>_<tool>` 命名空间挂载工具。
- [x] runtime fingerprint 感知 Plugin generation。
- [x] 证明 promotion 不修改已创建 session，下一 session 才出现工具与 inheritance proof。
- [x] 证明 rollback 后同一 Thread 的下一 session 不再看到坏工具，或恢复 previous known-good release。

退出标准：真实 Pi session 完成“未加载 -> 下一 session 加载并调用 -> rollback -> 下一 session 卸载/恢复”的整条链。

## Milestone D：可选外部隔离 adapter

- [x] 保留与内置 Host 相同的协议 seam。
- [x] 允许部署方显式配置 container/gVisor/Firecracker/WSL 等 adapter。
- [x] 文档和 UI 不得把外部 adapter 未配置显示为 Plugin 或 Evol 失败。

退出标准：外部 adapter 只替换执行位置，不参与 Candidate、promotion、active pointer、session lifecycle 或本地 V1 完成判断。

## 最终验收

- [x] 无外部 Launcher 的 Local Plugin 端到端测试通过。
- [x] rollback 的新 session 证据通过。
- [x] 全量测试、类型检查与生产构建通过（93 files / 714 tests）。
- [x] 主 Evol 完成审计只引用本地 Plugin 的实际生命周期证据。
