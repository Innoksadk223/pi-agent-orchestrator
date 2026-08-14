# Pi Agent Orchestrator

`agent_team` 是主 Pi 的轻量协作控制面。主 Pi 始终是唯一 Leader；runtime 只持久化事实、传递 settled 结果，并执行成员授权、DAG 依赖、成员忙闲和 owned-path 冲突约束。它不自动选专家、创建任务或派发下一节点。

## Plan-first Loop

复杂任务先一次注册完整计划：

```ts
agent_team({
  action: "plan",
  team: "default",
  plan: {
    members: [
      { id: "coder", kind: "coder", role: "Coder", instructions: "只写授权路径。" },
      { id: "reviewer", kind: "reviewer", role: "Reviewer", instructions: "只读审查。", tools: ["read", "grep", "find", "ls"] },
      { id: "optimizer", kind: "optimizer", role: "Optimizer", instructions: "VERIFY 后只读提出候选。", tools: ["read", "grep", "find", "ls"] }
    ],
    reviewerId: "reviewer",
    tasks: [{
      id: "implementation",
      memberId: "coder",
      objective: "实现已批准改动",
      constraints: ["不扩大范围"],
      dependsOn: [],
      ownedPaths: ["src/control-plane"],
      acceptance: ["行为符合协议"],
      relevantPaths: ["src/control-plane/index.ts"]
    }],
    acceptance: ["Reviewer 最终验证后仍需 HUMAN_ACCEPT"]
  }
})
```

一次 USER_GATE 同时确认 roster、reviewer、ExecutionTask DAG、具体 cwd 相对 ownership、TaskPacket 和 acceptance。拒绝、取消或超时不会分配 UUID、追加 TeamState、创建文件、启动 Dashboard 或 child。

已有计划用同一动作 amendment，并要求实时 revision 精确匹配：

```ts
agent_team({ action: "plan", team: "default", expectedRevision: 1, plan: nextPlan })
```

计划不允许静默删除既有成员/任务；仍持有 ownership 的未完成任务不能改定义。新增成员、任务或变更成员配置、ownership、acceptance 都重新确认；已释放锁的任务定义变更会回到待执行状态并保留 attempt 计数。模型/思考切换共用既有 `set-model`/Dashboard 后端通道。

## 手动推进

runtime 不调度。Leader 每次显式启动：

```ts
agent_team({ action: "run", taskId: "implementation" })
agent_team({ action: "parallel", taskIds: ["a", "b"] })
agent_team({ action: "review", reviewRoundId: "review-1", taskIds: ["implementation"] })
agent_team({ action: "expert", expertRoundId: "opt-1", expertId: "optimizer", taskIds: ["implementation"], objective: "检查低风险优化候选" })
agent_team({ action: "set-model", member: { id: "coder", model: "provider/model", thinking: "high" } })
```

计划任务派发前会重新读取 TeamState，并在任何 workspace、Dashboard、client 或 prompt 副作用前完成 preflight：

- task 状态允许新 attempt；所有 `dependsOn` 均为 `VERIFIED`；
- owner 已授权且空闲；parallel 中成员互异；
- owned path 是规范化的 cwd 相对具体路径，不允许绝对路径、`..` 或 glob；
- 路径相等或存在父子前缀即冲突；从 `RUNNING` 到 `VERIFIED/CANCELED` 持锁；
- ReviewRound 只接收 `SUBMITTED`；optimizer 只附着 `VERIFIED`；专家不取写锁。

未注册 plan 的旧 team 仍可使用 ad-hoc `run/parallel`。一旦注册计划，执行必须使用 task/review/expert 标识，不能以 ad-hoc payload 绕过范围。

## 结构化 settled 报告

成员自然语言正文之后，最后一个非空行必须是单行 JSON。runtime 不从正文猜状态。

Execution：

```json
{"agent_team_report":{"type":"execution","taskId":"implementation","status":"SUBMITTED","summary":"实现完成","evidence":["src/control-plane/index.ts"],"requests":[]}}
```

Review：

```json
{"agent_team_report":{"type":"review","reviewRoundId":"review-1","summary":"发现一项问题","evidence":["src/control-plane/index.ts:42"],"requests":[],"decisions":[{"taskId":"implementation","verdict":"FIX_REQUIRED","fix_prompt":"原样修复说明"}]}}
```

Expert：

```json
{"agent_team_report":{"type":"expert","expertRoundId":"opt-1","summary":"无低风险候选","evidence":[],"requests":[]}}
```

字段、条数和长度有上限。缺失、损坏、越界、类型/ID 不匹配时进入 `REPORT_INVALID`；execution ownership 不释放，不自动重试。正文保留在 child Session，超过 50KB 才写 `members/<id>/output.md`。

Coder 只能令任务进入 `SUBMITTED/BLOCKED/REPORT_INVALID`。只有计划指定 Reviewer 的合法 ReviewRound 能写 `VERIFIED/FIX_REQUIRED`。`FIX_REQUIRED` 保存原 `fix_prompt`，下一次 `run(taskId)` 是同一 ExecutionTask 的新 attempt；不创建修复任务，不做 plan amendment。只有 `VERIFIED/CANCELED` 释放 ownership，`VERIFIED` 会使依赖节点转为 `READY`。

## TeamState 与通知

`TeamState` 通过 Pi 公共 `appendEntry` custom entry 跟随父 session branch 持久化，不进入 LLM 上下文。它包含当前 plan、executionTasks、reviewRounds、expertRounds、pendingRequests 和成员/Session 事实，不保存完整历史正文。

后台 settled 先持久化，再用 `followUp + triggerTurn` 向 Leader 发送计数、变化对象、短摘要、请求和必要 outputPath。planned completion 不注入完整 TeamState 或完整成员输出。

- `status`：默认仅返回成员/任务计数、当前对象、阻塞和请求。
- `status full:true`：显式返回完整 roster、DAG、TaskPacket 和 rounds。
- `wait`：显式等待或重新收集完整 `MemberRunResult`。
- `stop`：Esc 风格软中断，不重放；planned attempt 进入显式阻塞恢复。
- `kill`：停止 child 并取消活动 execution attempt；保留成员授权和 Session UUID。

## 最小 Workspace

新代码只维护：

- `leader/plan.md`：TeamState 的精简恢复视图；
- `members/<id>/identity.md`：首次授权生成，既有内容不覆盖；
- `members/<id>/output.md`：仅超长输出。

不再创建、同步或读取旧 `brief.md`、`leader/roster.md`、`notes/`。已有旧文件和用户过程文件不会被删除。

## Session、Dashboard 与压缩

既有行为保持：固定成员复用 Session UUID；后台 completion、`stop/kill`、`set-model`、idle client cleanup 可用。`set-model` 接受可选 `thinking`；live child 依次应用并核对 model/thinking，无 live child 时持久化到下次 run。Dashboard 仍绑定 loopback、只读观察，唯一控制是两个选择器加一个应用按钮，一次提交成员模型与思考程度；plan 注册不启动 Dashboard，实际派工才沿用原准备流程。

成员启动时调用 `setAutoCompaction(true)` 启用 Pi 原生 auto-compaction。orchestrator 不设自定义阈值，不在 settled 后主动调用 compact，也不写压缩交接文件。原生压缩或成员会话失败表现为既有 `ERROR/INTERRUPTED` 状态，不自动重放；由 Leader依据 TeamState 和成员输出决定是否轮换接续。

Reviewer 的 `FINAL_VERIFY: VERIFIED` 只代表 Agent 证据完整。Optimizer gate 结束后仍由 Leader提交完成标准、证据、限制和手工入口，等待用户 `HUMAN_ACCEPT`。

## 兼容边界

扩展只使用 Pi 公共 `appendEntry`、Session branch、RpcClient、confirmation 和 `sendMessage` API；不解析 Session JSONL。没有新增依赖、数据库、事件日志、snapshot 文件、mailbox、轮询器、通知批处理器或自动调度器。
