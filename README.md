# Pi Agent Orchestrator

`agent_team` 是主 Pi 的轻量协作控制面。主 Pi 始终是唯一 Leader；runtime 只持久化事实、传递 settled 结果，并执行成员授权、DAG 依赖、成员忙闲和 owned-path 冲突约束。它不自动选专家、创建任务或派发下一节点。

## Planned-only Loop

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

一次注册同时固定 roster、reviewer、ExecutionTask DAG、具体 cwd 相对 ownership、局部 TaskPacket 和 acceptance。`set-auto` 默认关闭；关闭时 initial plan 与名册增长（新增成员）使用同一有界 TUI/RPC USER_GATE，同名册修订（指令/任务/验收编辑）与既有成员的持续派发静默复用已批准授权。拒绝、取消或中止不会分配 UUID、追加 TeamState、创建文件、启动 Dashboard 或 child；TUI 门倒计时结束且用户未操作时视为同意（RPC 原生对话框仍遵循 Pi 自身超时语义）。启用后只在当前 runtime/session 跳过这些 plan gate；Leader 仍须显式派工，Reviewer verdict 和最终 `HUMAN_ACCEPT` 均不会自动填写。

TUI 中该确认使用有界审阅视窗：`Approve` / `Reject` 固定可见，`↑` / `↓` / `PageUp` / `PageDown` 滚动正文，`←` / `→` 或 `Tab` 切换选项，`Enter` 确认当前选中项，`Esc` / `Ctrl+C` 始终拒绝，倒计时归零未操作则默认 Approve；正文为标准 Markdown（节标题/列表/加粗），TUI 端解析为主题色样式，IDE/RPC 端可直接渲染 MD，溢出时右缘显示滚动条。终端缩放后正文会重新换行并夹紧滚动位置。RPC 继续使用 Pi 原生 confirmation 协议。

已有计划用同一动作 amendment，并要求实时 revision 精确匹配：

```ts
agent_team({ action: "plan", team: "default", expectedRevision: 1, plan: nextPlan })
```

提交前可先 `validateOnly: true` 预检同一份草稿：跑全部语义校验（revision、DAG、owned paths、amendment 约束），但不触发 USER_GATE、不消耗 revision、不落盘。amendment 的确认门只显示增量 diff（新增/变更成员与任务、acceptance 增删、reviewer 变更高亮）；初始注册仍显示完整计划。

计划不允许静默删除既有成员/任务；仍持有 ownership 的未完成任务不能改定义。新增成员、任务或变更成员配置、ownership、acceptance 都必须经过同一 plan revision 验证，并在 auto 关闭时重新确认；已释放锁的任务定义变更会回到待执行状态并保留 attempt 计数。模型/思考切换共用既有 `set-model`/Dashboard 后端通道。

## 手动推进

runtime 不调度。Leader 每次显式启动：

```ts
agent_team({ action: "run", taskId: "implementation" })
agent_team({ action: "parallel", taskIds: ["a", "b"] })
agent_team({ action: "review", reviewRoundId: "review-1", taskIds: ["implementation"] })
agent_team({ action: "expert", expertRoundId: "opt-1", expertId: "optimizer", taskIds: ["implementation"], objective: "检查低风险优化候选" })
agent_team({ action: "set-model", member: { id: "coder", model: "provider/model", thinking: "high" } })
agent_team({ action: "cancel", taskIds: ["dropped"] })
```

计划派工先对整批完成 schema、revision、DAG、成员可用性、owned-path 与冲突 preflight；随后创建 workspace、准备 Dashboard 并启动整批 client，最后才激活并发送 prompt。Dashboard 或 client 启动失败不会发送任何 prompt；parallel prompt 任一失败会中断同批其余 attempt 并等待它们离开 `RUNNING`。默认后台 `run` / `parallel` / `review` / `expert` 成功接受任务后，会结束 Leader 当前自动工具回合并立即恢复主 Pi 输入；成员继续在后台运行，settled 后仍通过既有 `followUp + triggerTurn` 异步回报。显式 `background:false` 保持前台等待行为。

- task 状态允许新 attempt；所有 `dependsOn` 均为 `VERIFIED`；
- owner 已授权且空闲；parallel 中成员互异；
- owned path 是规范化的 cwd 相对具体路径，不允许绝对路径、`..` 或 glob；
- 路径相等或存在父子前缀即冲突；从 `RUNNING` 到 `VERIFIED/CANCELED` 持锁；
- `cancel {taskIds}` 显式放弃 PENDING/READY/BLOCKED/REPORT_INVALID 任务并释放路径锁，依赖它的 PENDING/READY 任务级联取消（在途的 BLOCKED 修复与 SUBMITTED/FIX_REQUIRED review 循环不级联，由 Leader 单独决定）；
- ReviewRound 只接收 `SUBMITTED`；optimizer 只附着 `VERIFIED`；专家不取写锁。

所有新派工都要求已注册 plan。旧 TeamState/成员/Session 仍可通过 `status`、`wait`、`stop`、`kill`、`set-model` 和恢复路径读取使用，但 inline `member + task`、inline `tasks[]` 以及无计划 `run/parallel` 会明确拒绝；runtime 不删除或覆盖旧 workspace 与 Session。

上游 provider 间歇故障（`network_error` / HTTP 400 `invalid_encrypted_content`）不属于成员过错：串行重派同一任务，不并行轰炸、不擅自换模型或换 provider；连续重派仍失败才停问用户。

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

字段、条数和长度有上限。缺失、损坏、越界、类型/ID 不匹配时进入 `REPORT_INVALID`；execution ownership 不释放，不自动重试。正文保留在 child Session，超过 50KB 才写 `members/<id>/output.md`。`evidence` 数组元素只写纯中文路径/行号描述（如 `src/a.ts:42`，正斜杠），禁止反斜杠、代码片段与示例照抄。

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

每个 Coder dispatch 只携带当前任务的 objective、constraints、dependency summaries、ownedPaths、局部 acceptance/relevantPaths、output contract 与必要的原样 `fix_prompt`。普通 task review/expert 同样只收到目标任务局部事实；只有覆盖全部尚未最终处理任务的 final review 才附带全局 acceptance。runtime 不自动复制 roster、全局 plan、父会话历史或旧 `brief/roster/notes/peer output`。

Workspace 只维护：

- `leader/plan.md`：TeamState 的精简恢复视图；
- `members/<id>/identity.md`：plan 首次注册生成，既有文件不覆盖也不作为新派工配置来源；
- `members/<id>/output.md`：仅超长输出。

不再创建、同步或读取旧 `brief.md`、`leader/roster.md`、`notes/`。已有旧文件和用户过程文件不会被删除。

## Session、Dashboard 与压缩

既有行为保持：固定成员复用 Session UUID；后台 completion、`stop/kill`、`set-model`、idle client cleanup 可用。`set-model` 接受可选 `thinking`；live child 依次应用并核对 model/thinking，无 live child 时持久化到下次 run。Dashboard 仍绑定 loopback、只读观察，唯一控制是两个选择器加一个应用按钮，一次提交成员模型与思考程度；plan 注册不启动 Dashboard，实际派工才沿用原准备流程。

成员启动时调用 `setAutoCompaction(true)` 启用 Pi 原生 auto-compaction。orchestrator 不设自定义阈值，不在 settled 后主动调用 compact，也不写压缩交接文件。原生压缩或成员会话失败表现为既有 `ERROR/INTERRUPTED` 状态，不自动重放；由 Leader依据 TeamState 和成员输出决定是否轮换接续。

Reviewer 的 `FINAL_VERIFY: VERIFIED` 只代表 Agent 证据完整。Optimizer gate 结束后仍由 Leader提交完成标准、证据、限制和手工入口，等待用户 `HUMAN_ACCEPT`。

## 兼容边界

扩展只使用 Pi 公共 `appendEntry`、Session branch、RpcClient、confirmation 和 `sendMessage` API；不解析 Session JSONL。没有新增依赖、数据库、事件日志、snapshot 文件、mailbox、轮询器、通知批处理器或自动调度器。
