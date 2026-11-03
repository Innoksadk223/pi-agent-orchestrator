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

一次注册同时固定 roster、reviewer、ExecutionTask DAG、具体 cwd 相对 ownership、局部 TaskPacket 和 acceptance。`agent_team` 的每个 action 使用独立的严格参数形状：`run` 只接 `taskId`，`parallel` 只接 `taskIds`，`review` 只接 `reviewRoundId`/`taskIds`，`expert` 只接对应 round、member、taskIds 和 objective；不要把其他 action 字段混入调用。成员可选 `headPrompt`/`tailPrompt` 作为长期提示词，任务可选同名字段作为一次性追加提示词；Runtime 的报告协议始终强制放在最终尾部。新成员省略 `model` 时继承主 Pi；只有用户明确要求覆盖时才填写真实可用目录中的精确 canonical `provider/model`，显式无效值会在任何持久化或 child 副作用前报错，绝不回退主模型。amendment 中既有成员省略 `model` 会保留其当前持久化选择，显式填写才切换。`set-auto` 默认关闭；关闭时 initial plan 与名册增长（新增成员）使用同一有界 TUI/RPC USER_GATE，同名册修订在授权面不变时（指令/任务/验收编辑）静默复用已批准授权；一旦放宽 `tools`/`kind`/`model`/`reviewerId`/`ownedPaths`，等同于扩大成员能做什么，会重新弹同一次门。拒绝、取消或中止不会分配 UUID、追加 TeamState、创建文件、启动 Dashboard 或 child；TUI 门倒计时结束且用户未操作时视为同意（RPC 原生对话框仍遵循 Pi 自身超时语义）。启用后只在当前 runtime/session 跳过这些 plan gate；Leader 仍须显式派工，Reviewer verdict 和最终 `HUMAN_ACCEPT` 均不会自动填写。

TUI 中该确认使用有界审阅视窗：`Approve` / `Reject` 固定可见，`↑` / `↓` / `PageUp` / `PageDown` 滚动正文，`←` / `→` 或 `Tab` 切换选项，`Enter` 确认当前选中项，`Esc` / `Ctrl+C` 始终拒绝，倒计时归零未操作则默认 Approve；正文为标准 Markdown（节标题/列表/加粗），TUI 端解析为主题色样式，IDE/RPC 端可直接渲染 MD，溢出时右缘显示滚动条。终端缩放后正文会重新换行并夹紧滚动位置。RPC 继续使用 Pi 原生 confirmation 协议。

已有计划用同一动作 amendment，并要求实时 revision 精确匹配：

```ts
agent_team({ action: "plan", team: "default", expectedRevision: 1, plan: nextPlan })
```

提交前可先 `validateOnly: true` 预检同一份草稿：跑全部语义校验（revision、DAG、owned paths、amendment 约束），但不触发 USER_GATE、不消耗 revision、不落盘。amendment 的确认门只显示增量 diff（新增/变更成员与任务、acceptance 增删、reviewer 变更高亮）；初始注册仍显示完整计划。

名册只增不减：新增成员前先判断既有成员的 `kind`、角色书与权限边界能否覆盖新工作——能覆盖就把任务派给既有成员，只有专业方向、边界或独立性确实不匹配时才新增。计划不允许静默删除既有成员/任务；仍持有 ownership 的未完成任务不能改定义。新增成员、任务或变更成员配置、ownership、acceptance 都必须经过同一 plan revision 验证，并在 auto 关闭时重新确认；已释放锁的任务定义变更会回到待执行状态并保留 attempt 计数。模型/思考切换共用既有 `set-model`/Dashboard 后端通道。

## 手动推进

runtime 不调度。Leader 每次显式启动：

```ts
agent_team({ action: "run", taskId: "implementation" })
agent_team({ action: "parallel", taskIds: ["a", "b"] })
agent_team({ action: "review", reviewRoundId: "review-1", taskIds: ["implementation"] })
agent_team({ action: "expert", expertRoundId: "opt-1", expertId: "optimizer", taskIds: ["implementation"], objective: "检查低风险优化候选" })
agent_team({ action: "consult", member: { id: "reviewer" }, objective: "为什么 task-a 的缓存命中率低？" })
agent_team({ action: "steer", member: { id: "coder" }, message: "只处理本次批准范围" })
agent_team({ action: "pause", taskId: "implementation" })
agent_team({ action: "resume", taskId: "implementation" })
agent_team({ action: "resume", reviewRoundId: "review-1" })  // 审查/专家同理：resume {reviewRoundId|expertRoundId}
agent_team({ action: "answer-request", requestId: "execution:implementation:1", answer: "包含迁移脚本" })
agent_team({ action: "resolve-request", requestId: "execution:implementation:1" })
agent_team({ action: "set-model", member: { id: "coder", model: "provider/model", thinking: "high" } })
agent_team({ action: "cancel", taskIds: ["dropped"] })
```

计划派工先对整批完成 schema、revision、DAG、成员可用性、owned-path 与冲突 preflight；随后创建 workspace、准备 Dashboard 并启动整批 client，最后才激活并发送 prompt。Dashboard 或 client 启动失败不会发送任何 prompt；parallel prompt 任一失败会中断同批其余 attempt 并等待它们离开 `RUNNING`。默认后台 `run` / `parallel` / `review` / `expert` 成功接受任务后，会结束 Leader 当前自动工具回合并立即恢复主 Pi 输入；成员继续在后台运行，settled 后仍通过既有 `followUp + triggerTurn` 异步回报。显式 `background:false` 保持前台等待行为。

- task 状态允许新 attempt；所有 `dependsOn` 均为 `VERIFIED`；
- owner 已授权且空闲；parallel 中成员互异；
- owned path 是规范化的 cwd 相对具体路径，不允许绝对路径、`..` 或 glob；规范化在绝对路径判定之前完成，`.//src` 这类写法折叠后仍是项目内相对路径；冲突比较按小写进行，兼容大小写不敏感的文件系统。
- ownedPaths 是授权声明而不是沙箱：成员以同一账号运行、自带 bash，越界写在模型层拦不住。因此每轮结束会用 `git status` 前后差异做一次只读审计，把 ownedPaths 之外的改动记成「Workspace warning」带回 Leader（只告警、不回滚、不阻断）；非 git 工作区不检测，这一点是已知边界。
- 路径相等或存在父子前缀即冲突；从 `RUNNING` 到 `VERIFIED/CANCELED` 持锁；
- `cancel {taskIds}` 显式放弃 PENDING/READY/BLOCKED/REPORT_INVALID 任务并释放路径锁，依赖它的 PENDING/READY 任务级联取消（在途的 BLOCKED 修复与 SUBMITTED/FIX_REQUIRED review 循环不级联，由 Leader 单独决定）；
- ReviewRound 只接收 `SUBMITTED`；optimizer 只附着 `VERIFIED`；专家不取写锁。

所有新派工都要求已注册 plan。旧 TeamState/成员/Session 仍可通过 `status`、`wait`、`stop`、`kill`、`set-model` 和恢复路径读取使用，但 inline `member + task`、inline `tasks[]` 以及无计划 `run/parallel` 会明确拒绝；runtime 不删除或覆盖旧 workspace 与 Session。

上游 provider 间歇故障（`network_error` / HTTP 400 `invalid_encrypted_content`）不属于成员过错：串行重派同一任务，不并行轰炸、不擅自换模型或换 provider；连续重派仍失败才停问用户。

### 派发提示词：分节表与授权地图

五段提示词各自只有一处生成处，生命周期与能否进缓存前缀由 `PROMPT_SECTION_TABLE` 固定（index.ts:117），测试按这张表核对稳定段不得含易变 token（dispatch-prompt.test.ts:429）：

| 段 | 生成处 | 生命周期 | 可进缓存前缀 |
| --- | --- | --- | --- |
| tool-description | index.ts 的 `AGENT_TEAM_DESCRIPTION` | global | 是 |
| tool-guidelines | index.ts 的 `AGENT_TEAM_GUIDELINES` | global | 是 |
| member-identity | compat.ts 的 `MEMBER_IDENTITY_RULE` | client-start | 是 |
| dispatch-prompt | runtime.ts 的 `preflightExecutionDispatch` / `reviewDispatchTask` / `expertDispatchTask` | dispatch | 否 |
| report-envelope | runtime.ts 的 `envelopeContract` | attempt | 否 |

派发提示词的第一段是全队授权地图：runtime.ts:2156 的 `scopeMapSegment` 把成员、任务与 plan 交给 session-roster.ts:95 的 `scopeMapBlock`，一次回答三件事——谁是队友（除自己与 STOPPED 外的成员各一行 `id — kind · role`，kind 取自 plan.memberKinds，runtime.ts:2162）、各自能写到哪里（`owns:` 为该成员全部任务 ownedPaths 的并集）、谁终裁（`- reviewer:` 行取 plan.reviewerId，runtime.ts:2167）。块末固定一行「联系与同伴消息不授予写入权，也不改变这张图。」（session-roster.ts:39），把「能联系」与「能写」在同一个块里切开。地图每轮重发，没有缓存前缀资格；名册文本只在 `scopeMapBlock` 里生成，runtime 不留第二份（dispatch-prompt.test.ts:293），而 `stop`/`kill` 的人类可读清单仍是旧的 `formatRoster`（runtime.ts:4583、4628），两套数据源不合并。

consult 是「Leader 需要一个判断，但不需要一轮评审」的通道：向任意已规划、空闲成员提一个只读问题，复用 expert 的只读派发构造（runtime.ts:2392）与信封（runtime.ts:2416），所以轮次 id 字段仍叫 `expertRoundId`；不绑 taskIds、不改任何 ExecutionTask 状态（runtime.ts:2480），未给轮次 id 时生成 `consult-N`（runtime.ts:2515）。只读限定只到契约与状态层：consult is read-only by contract and state, not at the tool layer: the consulted member keeps its own write tools.（index.ts:171；工具描述里是同一限定的短句，index.ts:160）

## 控制面与健康告警

新动作只作用于 Leader 显式指定的对象，全部在副作用前完成校验，绝不自动唤醒、自动派工或自动熔断：

- `steer {member, message}`：对**正在运行**成员注入一条受控短消息（Pi 公开 steer RPC）。不创建任务、不改 owned paths、不触发任何自动 dispatch；client 没有公开 steer 能力时显式拒绝，不伪造冻结 RPC；空闲或不存在成员直接报错。
- `pause {taskId}`：执行期软中断（与前台 Esc/`stop` 同一 abort 语义）。child client、Session UUID、授权与 Dashboard 全部保留；成员收尾为 `INTERRUPTED`，任务进入 `BLOCKED` 且标注「不重放」。
- `resume {taskId | reviewRoundId | expertRoundId}`：Leader 显式重新派发**同一目标**的下一 attempt，三者只能给一个。执行任务复用 `run` 的全部 preflight（依赖、owned-path 锁、成员可用性与非法状态拒绝）；审查/专家轮次只接受 `BLOCKED`，复用原 reviewer/expert 与原 targetTaskIds（专家还复用原 objective），复核目标仍可审查后重新锁为 `AUDITING`。绝不新建轮次、越权验证或重放已接受的提示。
- `answer-request {requestId, answer}` / `resolve-request {requestId}`：推进成员随报告提交的请求生命周期。请求由成员回报产生 `OPEN`；`answer-request` 只接受 `OPEN`，记录答案后进入 `ANSWERED`，并在**发起成员自身**下一次显式 dispatch 时注入（即使 review/expert 使用了新的 roundId，注入后仍消费为 `RESOLVED`）；`resolve-request` 显式关闭 `OPEN/ANSWERED`，已 `RESOLVED` 拒绝重复操作。旧快照恢复时丢失状态的请求一律回 `OPEN`，绝不凭空判定已答复。
- 受控消息：成员报告可按 `messages: [{to, text}]` 向**同一已注册计划内**的目标成员发送一次性受控消息，单条 ≤ 1000 字符、每报告 ≤ 5 条、每接收者未送达队列 ≤ 20 条、全局 ≤ 100 条。消息在接收者下一次显式 dispatch 的 prompt 中一次性注入，prompt 被接受才标记 `deliveredAt`；未接受原样保留待下一位 Leader 显式 dispatch，不自动重放；超限与计划外目标被拒绝并保留来源报告供核对。
- 健康快照：每次成员最终化一次性持久化三层模型证据（配置模型 / child RPC 报告模型 / 首条真实 assistant 回复模型）、最后事件与工具、本轮用量与 Context 占用。固定阈值（连续工具错误、重复同一工具次数、auto-retry 次数）只评估 `NORMAL → ELEVATED → DEGRADED → CRITICAL` 等级并留下原因，在同一成员的历史快照间只升不降、**只告警**——绝不自动 steer/stop/kill，也不触发派发。流式事件不逐条追加 TeamState 快照。

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

字段、条数和长度有上限。缺失、损坏、越界、类型/ID 不匹配时进入 `REPORT_INVALID`；execution ownership 不释放，不自动重试。正文保留在 child Session，超过 50KB 才写 `members/<id>/output.md`。`evidence` 数组元素只写纯中文路径/行号描述，必须用 `path:line` 冒号格式（如 `src/a.ts:42`，正斜杠），禁止散文式「第 N 行」、反斜杠、代码片段与示例照抄；envelope 必须是最后一个非空行、裸单行 JSON，禁止代码围栏。

Coder 只能令任务进入 `SUBMITTED/BLOCKED/REPORT_INVALID`。只有计划指定 Reviewer 的合法 ReviewRound 能写 `VERIFIED/FIX_REQUIRED`。`FIX_REQUIRED` 保存原 `fix_prompt`，下一次 `run(taskId)` 是同一 ExecutionTask 的新 attempt；不创建修复任务，不做 plan amendment。只有 `VERIFIED/CANCELED` 释放 ownership，`VERIFIED` 会使依赖节点转为 `READY`。

## 成员互通

成员之间可以直接短消息沟通（各自受控 child 内的 `team_message` 工具）。互通只传递信息，永远不产生工作。

- **通道**：runtime 懒启动一个只监听 `127.0.0.1` 随机端口的小型入口（Node 标准库，不依赖 Dashboard、浏览器或 UI 模式），每个 child 单独签发临时令牌；令牌、端口只经环境变量注入，不写进 TeamState、提示词或工具结果。child 除下方「成员能力」放行的白名单外，只额外加载 `member-communication.ts` 这一个互通扩展，`--no-extensions` 继续隔离用户与项目扩展。
- **路由**：接收者正在执行任务 → 用 Pi 公开 `steer` 在当前回合安全点注入；接收者 `APPROVED/IDLE` 且无人工暂停 → 启动一轮只读回答（复用同一 Session、模型与思考程度）；其余（`STARTING`/`INTERRUPTED`/`STOPPED`/`ERROR`、人工暂停、并发满额）→ 留在待投递队列，由接收者下一次显式派发注入。接口未接受则保持待投递并记录原因，不自动重放。
- **一问一答**：一个新问题最多触发一次空闲自动回答；回答不再唤醒空闲提问者（只进其收件箱/下一次派发）。工作中的成员仍可继续追问。
- **只读回答回合**：该回合由派发提示中的通信标记判定，只放行 `read/grep/find/ls/ffgrep/fffind/glob`；`bash`/`edit`/`write`/`team_message` 与任何未知工具都在 `tool_call` 处硬拦截（只靠提示词禁止写入不算通过）。该回合不产生任何报告信封，不写 `members/<id>/output.md`，不改任务状态、attempt、ownership 与审核结论，也不进入 `wait` 结果。
- **上限**：单条 ≤ 1000 字符；同一 attempt 最多 5 条；每接收者未送达队列 ≤ 20、团队消息记录 ≤ 100；自动回答最多 3 个模型回合、总时限 120 秒，超限中断并记录，不追加回答、不自动重试；回答正文上限 2000 字符。
- **失败与恢复**：回答失败记 `FAILED` + 原因，并向 Leader 发一条简短通知（只告警，不自动重试或调度）；`stop/kill` 与网页停止同样能停止通信回合，且不会伪造任务 `BLOCKED`。父会话恢复或分支切换会作废旧令牌且不自动唤醒成员；`shutdown` 关闭入口并释放端口。旧快照（无互通字段）照常读取，报告里的 `messages` 仍沿用「下一次显式派发读取」的旧语义。
- **可见性**：`status` 增加 `Comms:` 计数、正在回答的成员与失败摘要；完整消息体只在 `status full:true` 或成员自己的 `team_message action=inbox` 中出现。

## 成员能力

成员仍以 `--no-extensions` 启动，只放行显式 `-e` 路径：

- **技能**：照常发现（不传 `--no-skills`），系统提示带 `<available_skills>`，成员可 `read` 技能文件并用其中命令。
- **MCP**：追加 `-e builtin:mcp`，成员读取 `<agent-dir>/mcp.json` 的 server。只有 `coder` 角色会自动追加 `mcp__*`；只读角色（reviewer/debugger/product/optimizer）默认拿不到 MCP，除非在计划里显式写出具体的 `mcp__<server>__<tool>`。这样「只读」不会因为默认能力而被静默扩大。Pi < 0.99.0 不支持 `builtin:` 前缀时自动跳过该参数。
- **本地插件**：扫描 `<agent-dir>/extensions/`，按 `<agent-dir>/member-capabilities.json` 的 `plugins.mode` 处理。`auto`（默认）加载全部发现项再减去 `exclude`；`list` 只加载 `include`（可写扩展名、绝对路径或 `npm:包名`）；`exclude` 在两种模式下都作为最终否决，比较时忽略大小写与首尾空格；`include` 中不存在的绝对路径会被跳过并写诊断，不会交给 `-e` 导致成员启动失败。新增或删除目录下的插件无需改代码。
- **隔离**：npm 包形式的扩展、项目扩展与默认排除项（TUI 渲染类、`pi-agent-orchestrator`、`message-sound`、`artifacts`）默认不进成员；`list` 模式可显式 `include` `npm:包名`。实际例子：`npm:@ff-labs/pi-fff` 会把内置 `grep`/`find` 换成 `ffgrep`/`fffind`，此时 plan 里的成员 `tools` 必须写新名字，写 `grep`/`find` 会让成员没有搜索工具；`fff-multi-grep` 需环境变量 `PI_FFF_MULTIGREP=1`，默认不注册。
- **失败**：配置文件缺失时静默回退默认；JSON 损坏、字段非法或目录不可读进 diagnostics 并回退默认，不阻塞成员启动。

## TeamState 与通知

`TeamState` 通过 Pi 公共 `appendEntry` custom entry 跟随父 session branch 持久化，不进入 LLM 上下文。它包含当前 plan、executionTasks、reviewRounds、expertRounds、pendingRequests 和成员/Session 事实，不保存完整历史正文。

后台 settled 先持久化，再用 `followUp + triggerTurn` 向 Leader 发送计数、变化对象、短摘要、请求和必要 outputPath。planned completion 不注入完整 TeamState 或完整成员输出。

- `status`：默认仅返回成员/任务计数、当前对象、阻塞和请求。
- `status full:true`：显式返回完整 roster、DAG、TaskPacket 和 rounds。
- `wait`：显式等待或重新收集完整 `MemberRunResult`。
- `stop`：Esc 风格软中断，不重放；planned attempt 进入显式阻塞恢复。
- `kill`：停止 child 并取消活动 execution attempt；保留成员授权和 Session UUID。

## 最小 Workspace

每个 Coder dispatch 只携带当前任务的 objective、constraints、dependency summaries、ownedPaths、局部 acceptance/relevantPaths、output contract 与必要的原样 `fix_prompt`。普通 task review/expert 同样只收到目标任务局部事实；只有覆盖全部尚未最终处理任务的 final review 才附带全局 acceptance。runtime 不自动复制 roster、全局 plan、父会话历史或旧 `brief/roster/notes/peer output`。唯一例外是派发首段的授权地图：它带的是队友的 id/kind/role 与 owns 并集，不含其他人任务的目标、约束与验收（runtime.ts:2156）。

Workspace 只维护：

- `leader/plan.md`：TeamState 的精简恢复视图；
- `members/<id>/identity.md`：plan 首次注册生成，既有文件不覆盖也不作为新派工配置来源；
- `members/<id>/output.md`：仅超长输出。

不再创建、同步或读取旧 `brief.md`、`leader/roster.md`、`notes/`。已有旧文件和用户过程文件不会被删除。

## Session、Dashboard 与压缩

既有行为保持：固定成员复用 Session UUID；后台 completion、`stop/kill`、`set-model`、idle client cleanup 可用。`set-model` 接受可选 `thinking`，但只允许成员空闲时调用；非 `set-auto` 会话里，由 Leader 发起的换模型会先要一次确认（网页上的切换本身是用户操作，不重复问）；`STARTING/RUNNING`（包括 Dashboard 请求）会明确拒绝并要求先 `stop`。空闲 live child 依次应用并核对 model/thinking，任一步失败都回滚且不改持久配置；无 live child 时先持久化，到下次 run 启动核对。每轮首个真实 assistant `message_end` 的 `provider/model` 还必须与目标完全匹配；缺失或不同会停止不可信 child，让任务进入可恢复失败路径，且不自动重放。Dashboard 仍绑定 loopback（随机端口 + 不可猜路径令牌 + 同源 POST）且不启动服务端调度。可写控制只有三类：两个选择器加一个应用按钮提交成员模型与思考程度（运行中禁用，需先停止）；每成员「停止／继续」；以及 `/control` 用来提交 `stop|resume`。停止是软中断（目标进入 `BLOCKED`，child 与 Session 保留）；继续只对「由网页手动停止且目标仍 `BLOCKED`」的同一任务/轮次开新 attempt，服务端按真实 RunTarget 二次校验，同一成员的请求串行化，绝不新建轮次、不重放提示、不跨成员误触发。成功停／续在落盘后向 Leader 发一条标注「用户手动操作：不要自动调度／重试／重复派发」的简短通知。进度事件（`thinking_start`、`tool_execution_start/end`、压缩与重试阶段，白名单字段，只含阶段名与工具名，**绝不含工具参数、部分结果与思考正文**）只用于无输出时的当前阶段占位；刷新或 SSE 重连由服务端镜像恢复。plan 注册在持久化成功后只在 UI 模式（TUI 或带 UI 的 RPC）以只读方式同步显示完整名册、不启动任何模型；validateOnly、被拒绝/校验失败与无 UI 模式不打开页面。实际派工才沿用原准备流程。**协作图为默认视图**：浅色原生分层图，左侧主 Agent、右侧按团队稳定排列的成员，图内滚动；`collaboration-graph.js` 经唯一固定白名单路径以 nonce 经典脚本加载，无图形框架依赖。顶部可切回「工作面板」。点击成员展开原详情（任务、完整回复、上下文、用量/费用、耗时、模型/思考程度、模型切换、停止/继续）；关闭或 Esc 收起并恢复全图，窄屏为覆盖式详情。输出面板只在换人、文本变化且没有进行中的选中时重建，事件密集时渲染合并到每帧一次（所以流式输出期间仍能选中复制）；完整回复按编辑式层级排版：标题分级并带暖橙短条、行内重点用暖橙荧光底、行内代码为等宽芯片、引用带主色竖条、代码块为下沉的浅色凹面并在右上角标注语言；标题与重点之外不加底色，主 Agent 仍是页面上唯一的实心深色面。节点显示真实状态和当前阶段；STOPPED 席位默认不画在图上（已终止、不可继续执行），图例右侧显示「已隐藏 N 位已停止成员」，成员计数仍按名册口径；重新派发进入 STARTING/RUNNING 后自动回到图上。成员卡左侧竖条按状态着色，主 Agent 是页面上唯一实心深色面并显示成员/进行中/排队三个计数；主 Agent 状态独立来自主会话，未知不冒充空闲。同伴正文一律按引用块注入（逐行 `> `、剥离控制字符并中和通信回合标记），对方原话只能作为被引用的信息出现，不会被当成本轮的指令；同伴只读回答另有通信阶段，不清空任务/输出，网页可停止回答但不创建可继续的工作目标。主 Agent 卡右缘按成员顺序均分锚点：每名成员各有自己的交点，并行成员因此是几条并排的弧线，而不是汇到一个点再散开。归属线是曲线丝带：三次贝塞尔替掉直角，宽度从源头 2.8px 收到末端 1px，只表示归属、不带箭头。主 Agent 到各成员共用一条主干并按成员分车道（最多 5 条，活跃成员优先占互不相同的车道），成员处于启动/运行/工具/重试或只读回答时，该丝带加亮并沿箭头方向涌动——涌动按固定空间周期（dasharray 42+198px）与统一时长驱动，相位由脚本写入的负 animation-delay 对齐到同一时钟，因此并行中的几名成员步调一致、主干上的亮带严格对齐，分岔后才各自散开；纯 CSS、不走逐帧循环，空闲时整图静止。派发/引导/回报/提问/回答/留言只显示类型与状态，不显示通信正文或 child 凭据；同伴之间按方向各占一条弧（提问与回答、两个方向不会合并成一条），同一对关系用按对固定的车道，箭头按曲线切线绘制，标签按竖直带自动避让、不压住成员卡。一次投递仅在真实接受/投递/提交后叠三波更亮的脉冲，不证明模型已阅读或任务 VERIFIED；排队虚线与失败静态保留且不涌动，近期成功关系约 30 秒后淡出；运行中的成员优先获得图焦点，空闲后回到手选成员，聚焦会突出其收发关系。并行脉冲最多 8 条、通信展示缓存最多 200 条；隐藏、断连、工作面板或减少动画时停止并清理，不补播历史。刷新/SSE 重连恢复服务端有界镜像，未开工耗时显示「尚未开始」，未知上下文字段不伪造。

成员启动时调用 `setAutoCompaction(true)` 启用 Pi 原生 auto-compaction。orchestrator 不设自定义阈值，不在 settled 后主动调用 compact，也不写压缩交接文件。原生压缩或成员会话失败表现为既有 `ERROR/INTERRUPTED` 状态，不自动重放；由 Leader依据 TeamState 和成员输出决定是否轮换接续。

Reviewer 的 `FINAL_VERIFY: VERIFIED` 只代表 Agent 证据完整。Optimizer gate 结束后仍由 Leader提交完成标准、证据、限制和手工入口，等待用户 `HUMAN_ACCEPT`。验收后调一次 `close {team}` 收尾（非自动授权会话会再弹一次 HUMAN_ACCEPT 确认，且这次**不设超时倒计时**（等不出来，只能明确点同意或拒绝），无 UI 时直接拒绝；`set-auto` 会话按全自动处理）：成员会话硬终止（状态 `STOPPED`，名册与 Session UUID 保留）、逐成员移出页面；除本队外无其他团队活动时关闭 Dashboard，页面收到 shutdown 先尝试自关，浏览器不允许时退回显示「已结束」；其他团队仍在跑时保留页面并说明原因。`close` 不自动触发，不代替验收。

## 兼容边界

扩展只使用 Pi 公共 `appendEntry`、Session branch、RpcClient、confirmation 和 `sendMessage` API；不解析 Session JSONL。没有新增依赖、数据库、事件日志、snapshot 文件、轮询器、通知批处理器或自动调度器；成员互通只用 Node 标准库的 loopback 入口与显式加载的成员扩展，也不新增文件信箱。
