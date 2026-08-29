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

- 完整固定 roster；每个成员有 `kind`、`id`、`role`、`instructions`。新成员省略模型时继承主 Pi；只在用户明确指定时填写真实可用目录中的精确 canonical `provider/model`，显式无效值会报错且绝不回退。amendment 中既有成员省略模型会保留其当前持久化选择；
- **每个成员的 `instructions` 必须是一份专门的专业角色书**，禁止一句话敷衍。写清五要素：职责与专长、边界（不碰什么/不决策什么）、行事风格、输出要求、与其他成员的协作关系；用用户的语言书写；
- `instructions` 经 `--append-system-prompt` 原样注入成员进程，是该成员唯一的人格来源；修订已建会话成员的 instructions 会被旧历史压制，需换替补才干净生效（见 Settled JSON Contract 节末）；
- 唯一 `reviewerId`；
- 计划载荷中面向用户的业务文本（role、instructions、objective、constraints、acceptance 等）一律用简体中文书写，便于用户审阅确认门；runtime 结构标签（Team/Roster/Tasks/depends/acceptance）保持英文不动。
- ExecutionTask DAG：`id/memberId/dependsOn`；
- 具体 cwd 相对 `ownedPaths`，以及 objective、constraints、acceptance、relevantPaths、output contract；
- 全局 acceptance。

initial 注册与名册增长（新增成员）各是一次 confirmation（USER_GATE）；同名册修订与既有成员的持续派发不再确认。拒绝/取消必须零 UUID、状态、文件、Dashboard、child 副作用。改变角色配置、ownership、acceptance 或新增成员时，用完整新计划加实时 `expectedRevision` 提交；过期 revision 不重试、不猜测。

未规划 team 可继续 ad-hoc `run/parallel`。注册 plan 后只用 planned 标识，不以 ad-hoc payload 扩大范围。

## 修订先商量

收到修改诉求不要立刻提交 amendment。顺序固定：

1. 与用户讨论变更集：改什么、为什么、影响哪些任务与 owned paths；
2. 双方达成一致后，询问是否输出修订计划；
3. 明确同意后才调用 `agent_team plan`。可先用 `validateOnly:true` 预检草稿（跑全部语义校验但不触发确认门、不消耗 revision、不落盘）；
4. 提交后确认门对 amendment 只显示增量 diff（新增/变更成员与任务、acceptance 增删、reviewer 变更高亮）。

禁止在同一回合内「听改动 → 直接提交」。讨论中确定不要的任务用 `cancel {taskIds}` 显式放弃（释放 owned-path 锁，PENDING/READY 传递依赖自动级联取消）；RUNNING 用 stop/kill，SUBMITTED/FIX_REQUIRED 先走完 review 循环。

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
- `cancel {taskIds}`：放弃 PENDING/READY/BLOCKED/REPORT_INVALID 任务并释放其路径锁；依赖它的 PENDING/READY 任务级联取消。RUNNING 用 stop/kill，SUBMITTED/FIX_REQUIRED 先走 review 循环。
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

Evidence 内容规范（写入每个 dispatch prompt 的硬约束）：`evidence` 数组元素只写纯中文的路径/行号描述，必须用 `path:line` 冒号格式（如 `src/a.ts:42`，一律用正斜杠 `/`），禁止散文式「第 N 行」写法；禁止反斜杠、禁止贴 Swift 或其他代码片段、禁止照抄示例内容。envelope 必须是最后一个非空行、裸的单行 JSON：禁止代码围栏/```，禁止 Markdown 包裹，正文后不留空行或注释。flash 类小模型会复制示例代码或围栏，违反即 `REPORT_INVALID`。

成员会话按 sessionId 复用：修订 instructions 后旧历史仍主导输出，重发同样 prompt 大概率复现同一错误。标准恢复流程：连续 REPORT_INVALID（或明显被旧上下文污染）时 kill 舍弃该成员，amendment 新增替补（新 sessionId + 新指令）并把 reviewerId/任务派发切过去；旧成员保留名册闲置。不要反复重试同一成员。

## 状态与恢复

- 默认 `status`：成员/任务计数、当前对象、阻塞、pendingRequests。
- `status full:true`：仅需完整 roster/DAG/TaskPacket 时使用。
- `wait`：显式收集完整结果；后台 planned completion 已自动发送精简 delta，不轮询。
- `stop`：软中断，保留 Session/授权，不重放。
- `kill`：终止 child；活动 execution attempt 取消，授权与 Session UUID 保留。
- `set-model {member:{id,model,thinking?}}`：只允许空闲成员调用；`STARTING/RUNNING` 必须先 `stop`。模型与可选思考程度走同一后端；live child 切换后核对两字段，不一致保持旧持久配置，无 live child 则下次 run 生效。下一轮首个真实 assistant 回复的 `provider/model` 还必须完全匹配，否则本轮失败、停止不可信 child、绝不自动重放。Dashboard 的唯一控制是两个选择器和一个应用按钮，一次提交 model+thinking，并遵循同一限制。

TeamState 是唯一结构化事实源。恢复时先 `status`，行动前由 runtime 再校验实时状态；中断、provider 错误、REPORT_INVALID 或原生压缩/会话失败都表现为既有状态，由 Leader显式选择重试、修复、换成员（需 amendment）或停问用户。`REPORT_INVALID` 一律按原任务重派核对（`run` 同一 taskId，新 attempt），不得从正文推断成功或跳过核对。

上游 provider 间歇故障（opencode-go 等上游的 `network_error` / HTTP 400 `invalid_encrypted_content`）不属于成员过错：串行重派同一任务逐个尝试，不并行轰炸、不擅自换模型、不换 provider 绕路；连续重派仍失败才停问用户。

成员固定 400 先查 maxTokens：`~/.pi/agent/models.json` 的 provider `modelOverrides` 里 maxTokens 超过上游限额（如 384000 > 131072）会固定 400；不要直接改 `models-store.json` 缓存（每 4 小时被上游刷新覆盖），持久修法是写 `models.json` 覆盖。

## 文件与上下文

默认文件只有 `leader/plan.md`、identity，以及超长 output 等按需产物。不创建或依赖旧 brief、roster、notes、事件日志、snapshot、mailbox 或任务板。

成员启动时启用 Pi 原生 auto-compaction。orchestrator 不设自定义阈值、不在 settled 后主动调用 compact、不写压缩交接文件。原生压缩或会话失败表现为 `ERROR/INTERRUPTED`，绝不自动重放；Leader按 TeamState 和成员输出决定是否轮换接续。

## 验收门

Reviewer 的 `FINAL_VERIFY: VERIFIED` 不等于用户验收。完成 Expert/Optimizer gate 后，Leader提交完成标准、证据、限制和手工入口，等待 `HUMAN_ACCEPT`。用户提出合约外变化时先 plan amendment / USER_GATE。
