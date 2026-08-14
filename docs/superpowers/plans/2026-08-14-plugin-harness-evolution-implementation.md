# Plugin/Harness Evolution 实施计划

依据：`docs/superpowers/specs/2026-08-14-plugin-harness-evolution-v1.md`

状态：Completed（2026-08-14）

## Milestone E：Bundle 与安全供应链

1. 增加 Plugin Bundle/manifest/scanner contracts。
2. 支持 plugin/harness Candidate，并生成不可变解包目录和 provenance manifest。
3. 把 plugin/harness 加入隔离 Eval Suite，但禁止自动晋升。

退出标准：路径逃逸、危险 import、动态代码、能力声明不一致均确定性拒绝。

## Milestone F：隔离 Extension Host

1. 实现版本化子进程协议；Node Permission Model 只作为开发/纵深防御，production 要求运维配置 OS Sandbox Launcher。
2. 实现 activate/health/invoke/guard/deactivate deadlines 与输出上限。
3. 实现只读 capability broker，并复用 AgentToolRuntime 的 policy 与 Evidence 管线。

退出标准：未配置 OS Sandbox Launcher 时 canary/production fail closed；配置后插件无法直接读 Workspace、联网、写文件或创建进程；授权 broker read 可追溯。

## Milestone G：Runtime Mount 与治理

1. Runtime projection 校验并输出 plugins/harnesses。
2. Pi tool surface 挂载 plugin tools，并以 harness 包装工具调用。
3. runtime fingerprint 驱动 release/rollback 后 session 重建。
4. 增加 API/UI 状态与端到端验收。

退出标准：真实 Pi session 可执行 production plugin；canary 稳定分桶；rollback 下一轮卸载；全量验证通过。
