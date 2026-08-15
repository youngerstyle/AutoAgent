# Evolution Delivery Provider Gateway V1

> **范围声明：可选团队/SaaS 软件交付 adapter，明确不属于 Evol 本地资产自进化 V1。** 未配置本 Gateway 不影响 Memory、Prompt、Skill 或 Local Plugin 的生成、激活、回滚和健康状态。本文件只描述另行启用 Source Patch/应用部署能力时的协议。

该协议把 AutoAgent Evol 控制面与具体 GitHub/GitLab、CI、镜像仓库、Kubernetes 或 SaaS 部署平台隔离。Gateway 是受信生产组件；它负责调用平台 API、等待平台事实并返回 attestation，不能根据请求方声明伪造 check、review、deployment 或 Runtime 状态。

## 传输与认证

- Base URL 必须使用 HTTPS；仓库测试仅显式允许 HTTP loopback。
- 每个请求使用 `POST`、`Content-Type: application/json` 和 `Authorization: Bearer <token>`。
- `X-AutoAgent-Idempotency-Key` 是 operation 与规范请求体的 SHA-256。同一 key 必须返回同一结果，不得创建第二个 PR、build 或 deployment。
- Gateway 不得把 Bearer token 写入响应、日志 evidence URL 或下游 build 参数。
- AutoAgent 禁止 redirect，单响应上限 1 MiB，默认超时 30 秒；429/502/503/504 使用同一幂等键重试一次。

## 公共类型

```ts
interface VersionedRef {
  id: string;
  version: string;
  contentHash: string;
}

interface Attestation {
  provider: string;
  subject: string;
  revision: string;
  status: "pending" | "passed" | "failed";
  observedAt: string; // ISO-8601
  evidenceRef: string; // 平台中可审计的 run/check/review/deployment 引用
}
```

Source Patch 主链只接受 `status="passed"`。`pending` 与 `failed` 都不会推进 delivery ledger 或 active pointer。

## SCM endpoints

| Endpoint | Request | Response |
| --- | --- | --- |
| `/v1/scm/current-revision` | `{ repositoryId }` | `{ revision }` |
| `/v1/scm/changes` | `{ candidateId, contentHash, artifact }` | `ScmPreparedChange` |
| `/v1/scm/checks` | `{ change, names }` | `{ attestations: Attestation[] }` |
| `/v1/scm/review` | `{ change }` | `{ attestation }` |
| `/v1/scm/merge` | `{ change }` | `{ mergeCommit, attestation }` |

`artifact` 含精确 `repositoryId`、`baseCommit`、`targetBranch`、文件白名单、unified diff 与 required checks。Gateway 必须在独立 branch/worktree 应用 patch，确认实际变更文件与白名单完全相同。`review` 必须来自独立 reviewer 或受保护分支规则；proposer 自报不能转写为 passed。

```ts
interface ScmPreparedChange {
  provider: string;
  repositoryId: string;
  baseCommit: string;
  changeRef: string;
  candidateCommit: string;
  webUrl?: string;
}
```

## Build endpoint

`POST /v1/builds`

```json
{
  "sourceCommit": "<merged commit>",
  "candidateRef": { "id": "...", "version": "...", "contentHash": "..." }
}
```

返回 `{ artifactRef: VersionedRef, attestation: Attestation }`。`artifactRef.contentHash` 必须标识不可变 artifact/image，而不是 mutable tag。

## Deployment endpoints

| Endpoint | Request | Response |
| --- | --- | --- |
| `/v1/deployments/current-production` | `{}` | `{ deploymentRef: VersionedRef | null }` |
| `/v1/deployments/canary` | `{ artifactRef, previousDeployment? }` | `{ deploymentRef, attestation }` |
| `/v1/deployments/production` | `{ deploymentRef }` | `{ attestation }` |
| `/v1/deployments/actual-revision` | `{ deploymentRef }` | `{ sourceCommit, runtimeSnapshotHash, attestation }` |
| `/v1/deployments/rollback` | `{ previousDeployment }` | `{ attestation }` |

`actual-revision` 必须读取目标运行实例报告的 source commit 和 boot/runtime snapshot，不能回显部署请求。只有它与合并 commit 一致后 AutoAgent 才写入 `activation.inherited`。回滚后 AutoAgent 再次调用 `actual-revision(previousDeployment)`，并为恢复版本创建新的 `rollback_restore` generation 和 inheritance proof。

## 失败语义

- Base commit 漂移、check 缺失、review 非独立、merge 竞争、build 非不可变、deployment 未就绪或 actual commit 不一致：返回非 2xx 或 failed attestation。
- 无法确认的状态不得返回 passed；可返回 409/425/503，让调用方保留可恢复 delivery 状态。
- Gateway 操作失败不能修改 AutoAgent active pointer。Production deployment 已发生但 Runtime 未报告 actual revision 时，UI 保持 deploying/waiting，不显示 activated。

## 生产验收

协议测试只验证 adapter。生产完成证明必须包含：真实托管 branch/PR、required check run、独立 review、merge commit、不可变 build artifact、canary 与 production deployment、Runtime actual report，以及 previous deployment 回滚后的第二份 actual report。所有 evidenceRef 应可由运维审计。
