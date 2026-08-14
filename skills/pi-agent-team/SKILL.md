---
name: pi-agent-team
description: Use when the main Pi needs persistent multi-agent execution for a complex, multi-round, or cleanly decomposable task. Register one confirmed plan, then manually advance Coder, Reviewer, fix attempts, read-only experts, final verification, and human acceptance through agent_team. Do not use for simple tasks or treat runtime/Dashboard as an automatic scheduler.
---

# Pi Agent Team

主 Pi 是唯一 Leader 和业务决策者。runtime 只保存实时事实、传递 settled 结果并约束授权、依赖、成员忙闲与 owned-path 冲突；它不选专家、不创建任务、不自动派发下一节点。

## 渐进开卷

| 阶段 | 读取 |
| --- | --- |
| PLAN / USER_GATE | 本文 + `references/shared-plan-template.md` |
| DISPATCH / FIX | 本文“手动循环”与 TeamState compact status |
| AUDIT / VERIFY / EXPERT | 当前 TaskPacket、目标摘要/证据和对应 JSON contract |
| 恢复 / 交付 | `status`；确有必要才 `status full:true`；按需 handoff/output |

不要要求成员读取无关共享文件或完整历史正文。

## 注册一次计划

调用 `agent_team plan` 一次提交：

- 完整固定 roster；每个成员有 `kind`、`id`、`role`、`instructions`，模型/思考默认继承主 Pi；
- 唯一 `reviewerId`；
- ExecutionTask DAG：`id/memberId/dependsOn`；
- 具体 cwd 相对 `ownedPaths`，以及 objective、constraints、acceptance、relevantPaths、output contract；
- 全局 acceptance。

一次 confirmation 是 USER_GATE。拒绝/取消必须零 UUID、状态、文件、Dashboard、child 副作用。新增成员/任务或改变角色配置、ownership、acceptance 时，用完整新计划加实时 `expectedRevision` 再确认；过期 revision 不重试、不猜测。

未规划 team 可继续 ad-hoc `run/parallel`。注册 plan 后只用 planned 标识，不以 ad-hoc payload 扩大范围。

## 手动循环

Leader 按实时 TeamState 显式推进：

```text
plan -> run/parallel READY task -> SUBMITTED
     -> review batch -> VERIFIED | FIX_REQUIRED
     -> same task next attempt -> SUBMITTED -> review ...
     -> optional read-only expert -> FINAL_VERIFY -> HUMAN_ACCEPT
```

- `run {taskId}`：启动一个 READY、FIX_REQUIRED 或显式恢复节点。
- `parallel {taskIds}`：只派互异成员、依赖已 VERIFIED、owned paths 两两不冲突的批次。
- `review {reviewRoundId, taskIds}`：只审 SUBMITTED；计划 Reviewer 是唯一判定者。
- `expert {expertRoundId, expertId, taskIds, objective}`：仅预批准 debugger/product/optimizer；只读、不取 ownership、不写 verdict。optimizer 只接 VERIFIED。
- runtime 永不自动调用下一动作。Leader解释 Reviewer/专家意见并决定下一显式调用。

`FIX_REQUIRED` 保留 Reviewer 的 `fix_prompt` 原文。再次 `run` 是同一 task 的新 attempt，不创建“修复任务”，也不 amendment。ownership 从 RUNNING 保持到 VERIFIED/CANCELED；SUBMITTED、AUDITING、FIX_REQUIRED、BLOCKED、REPORT_INVALID 都不释放。

## Settled JSON Contract

成员可先写简短正文，但最后一个非空行必须是单行 JSON；不得用代码围栏。runtime 对字段、数量、长度和目标 ID 严格校验，不解析正文猜状态。

Execution：

```json
{"agent_team_report":{"type":"execution","taskId":"<id>","status":"SUBMITTED|BLOCKED","summary":"<short>","evidence":["<path/ref>"],"requests":[{"kind":"question|scope|dependency|human","text":"<request>"}]}}
```

Review：

```json
{"agent_team_report":{"type":"review","reviewRoundId":"<id>","summary":"<short>","evidence":[],"requests":[],"decisions":[{"taskId":"<id>","verdict":"VERIFIED|FIX_REQUIRED","fix_prompt":"<required only for FIX_REQUIRED>"}]}}
```

Expert：

```json
{"agent_team_report":{"type":"expert","expertRoundId":"<id>","summary":"<short>","evidence":[],"requests":[]}}
```

Execution 不能自报 VERIFIED。Envelope 缺失/损坏/越界进入 `REPORT_INVALID`，保留正文与锁，通知 Leader；不自然语言猜测、不自动重试。所有协作请求随 envelope 交 Leader，成员之间没有直接 RPC 或文件通信。

## 状态与恢复

- 默认 `status`：成员/任务计数、当前对象、阻塞、pendingRequests。
- `status full:true`：仅需完整 roster/DAG/TaskPacket 时使用。
- `wait`：显式收集完整结果；后台 planned completion 已自动发送精简 delta，不轮询。
- `stop`：软中断，保留 Session/授权，不重放。
- `kill`：终止 child；活动 execution attempt 取消，授权与 Session UUID 保留。
- `set-model {member:{id,model,thinking?}}`：模型与可选思考程度走同一后端；live child 切换后核对两字段，不一致保持旧持久配置，无 live child 则下次 run 生效。Dashboard 的唯一控制是两个选择器和一个应用按钮，一次提交 model+thinking。

TeamState 是唯一结构化事实源。恢复时先 `status`，行动前由 runtime 再校验实时状态；中断、provider 错误、REPORT_INVALID 或原生压缩/会话失败都表现为既有状态，由 Leader显式选择重试、修复、换成员（需 amendment）或停问用户。

## 文件与上下文

默认文件只有 `leader/plan.md`、identity，以及超长 output 等按需产物。不创建或依赖旧 brief、roster、notes、事件日志、snapshot、mailbox 或任务板。

成员启动时启用 Pi 原生 auto-compaction。orchestrator 不设自定义阈值、不在 settled 后主动调用 compact、不写压缩交接文件。原生压缩或会话失败表现为 `ERROR/INTERRUPTED`，绝不自动重放；Leader按 TeamState 和成员输出决定是否轮换接续。

## 验收门

Reviewer 的 `FINAL_VERIFY: VERIFIED` 不等于用户验收。完成 Expert/Optimizer gate 后，Leader提交完成标准、证据、限制和手工入口，等待 `HUMAN_ACCEPT`。用户提出合约外变化时先 plan amendment / USER_GATE。
