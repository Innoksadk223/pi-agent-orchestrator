---
name: pi-agent-team
description: Use when the main Pi needs persistent multi-agent execution for a complex, multi-round, or cleanly decomposable task. Register one confirmed plan, then manually advance Coder, Reviewer, fix attempts, read-only experts, read-only consult of any planned member, final verification, and human acceptance through agent_team. Do not use for simple tasks or treat runtime/Dashboard as an automatic scheduler.
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
- **先复用、后新增**：名册只增不减。注册或修订前先判断已有成员的 `kind`、角色书与权限边界能否覆盖新工作——能覆盖就把新的 ExecutionTask 派给既有成员，不要新建。只有现有成员的专业方向、边界或独立性确实不匹配（例如需要另一个技术领域，或需要一份全新的独立评审来源）才新增成员：每次新增都多一个 session、一份角色书和一次 USER_GATE，且永远无法删减。
- `instructions` 经 `--append-system-prompt` 原样注入成员进程，是该成员唯一的人格来源；可选 `headPrompt` 用于长期人设/方法补充，成员可选 `tailPrompt` 用于长期收尾检查；修订已建会话成员的 instructions 会被旧历史压制，需换替补才干净生效（见 Settled JSON Contract 节末）；
- ExecutionTask 可选 `headPrompt`/`tailPrompt` 作为当前任务的一次性追加提示词。组装顺序为成员默认提示词、任务 headPrompt、当前 TaskPacket、成员 tailPrompt、任务 tailPrompt、Runtime 强制报告协议；用户提示词不能覆盖权限边界或最终 JSON envelope；
- 唯一 `reviewerId`；
- 计划载荷中面向用户的业务文本（role、instructions、objective、constraints、acceptance 等）一律用简体中文书写，便于用户审阅确认门；runtime 结构标签（Team/Roster/Tasks/depends/acceptance）保持英文不动。
- 每个 action 都有独立的严格参数形状：`run` 只传 `taskId`，`parallel` 只传 `taskIds`，`review` 传 `reviewRoundId` 与 `taskIds`，`expert` 传 `expertRoundId`、`expertId`、`taskIds`、`objective`；不要使用一个包含所有可选字段的扁平 payload；
- ExecutionTask DAG：`id/memberId/dependsOn`；
- 具体 cwd 相对 `ownedPaths`，以及 objective、constraints、acceptance、relevantPaths、output contract；
- 全局 acceptance。

initial 注册与名册增长（新增成员）各是一次 confirmation（USER_GATE）；同名册修订与既有成员的持续派发不再确认。拒绝/取消必须零 UUID、状态、文件、Dashboard、child 副作用。改变角色配置、ownership、acceptance 或新增成员时，用完整新计划加实时 `expectedRevision` 提交；过期 revision 不重试、不猜测。

用户明确要求自动授权时，**先** `set-auto {auto:true}` **再发 `plan`**：auto 只在当前 runtime/session 生效，新会话要重新开启，且它只是停止弹门——派工依旧必须由 Leader 显式发起。门已经弹出来之后才补 `set-auto`，那一次确认无法撤销，用户已经点过了。

所有新派工都必须先注册 plan；未规划 team 不接受 ad-hoc `run/parallel`。旧 TeamState 仅保留 `status`、`wait`、`stop`、`kill`、`set-model` 与恢复路径，不以 inline payload 扩大范围。

## 成员能力

成员保留技能发现，并由 `<agent-dir>/member-capabilities.json` 决定额外能力：MCP 全部 server（`mcp__*` 工具）与 `<agent-dir>/extensions/` 下按 `exclude` 过滤的本地插件（默认含生图、项目记忆注入与 prompt-prefix）。`list` 模式还可 include `npm:` 包，例如 `npm:@ff-labs/pi-fff`。

加载 `pi-fff` 后，成员的工具名是 `ffgrep`/`fffind` 而不是 `grep`/`find`，写 plan 时成员 `tools` 要用新名字；`fff-multi-grep` 需要 `PI_FFF_MULTIGREP=1`，默认不可用。npm 包扩展、项目扩展、TUI 渲染类、编排器自身与 `artifacts` 默认不进成员。

派工时可以点名这些工具（如用 `context7` 查库文档，配额不足时改用 `anysearch` 联网核实；用 `codex_image` 生图），但不要在角色书里复述工具参数；需要新增能力时先改配置，再把任务派给既有成员。

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
- `consult {member, objective, expertRoundId?}`：向任意已规划、空闲成员做一次只读提问；不绑任务、不改任何 ExecutionTask 状态，成员工具仍按 plan 下发（用法与返回形状见本节 consult 一段）。
- `steer {member, message}`：只对**正在运行**成员注入一次受控短消息（Pi 公开 steer RPC）；无公开 steer 能力的 client 显式拒绝，不伪造冻结 RPC。
- `pause {taskId}`：软中断（与 Esc/stop 同一 abort 语义），child/Session/Dashboard 全保留；成员 `INTERRUPTED`、任务 `BLOCKED` 且不重放。`resume` 由 Leader 显式重派**同一目标** attempt+1，且必须给出 `taskId`/`reviewRoundId`/`expertRoundId` 三者之一：执行任务走 `run` 全部 preflight；审查/专家只接 `BLOCKED` 的既有轮次，复用原 reviewer/expert 与原 targetTaskIds（专家还复用原 objective）并重新锁为 `AUDITING`。不新建轮次、不重放已接受的提示，非法状态拒绝。
- `answer-request {requestId, answer}` / `resolve-request {requestId}`：请求 `OPEN` → 答复后 `ANSWERED` → 发起成员下一次显式 dispatch 注入答案后消费为 `RESOLVED`（review/expert 换用新 roundId 也不影响），或显式关闭；已 `RESOLVED` 拒绝重复操作。旧快照丢失状态的请求一律回 `OPEN`。
- `close {team}`：HUMAN_ACCEPT 后整队收尾。成员走与 `kill` 相同的硬终止（child 会话中止、`STOPPED`、逐成员移出页面），名册与 Session UUID 保留，需要时仍可懒重建；任一本成员仍 `RUNNING` 时拒绝。若除本队外还有其他团队在跑，Dashboard 保持打开并说明原因；否则关闭 Dashboard，页面收到 shutdown 先自关，浏览器不允许时退回显示「已结束」。
- 受控消息：成员报告可用 `messages: [{to, text}]` 向同一已注册计划内成员发一次性消息（每报告 ≤ 5 条、单条 ≤ 1000 字符、每接收者未送达队列 ≤ 20 条）；仅在接收者下一次显式 dispatch 的 prompt 被接受后标记送达，未接受原样保留，不自动重放。
- 成员互通：成员可直接用各自 child 内的 `team_message`（members/send/inbox）互发短消息，同队、单条 ≤ 1000 字符、同一 attempt ≤ 5 条。runtime 只路由：运行中成员用 Pi 公开 `steer` 安全点注入；`APPROVED/IDLE` 且未被暂停的成员最多自动只读回答一次（该回合在 `tool_call` 处拦截 bash/edit/write/team_message 与未知工具，复用同一 Session 与模型核验，最多 3 个模型回合/120 秒）；其余（STARTING/INTERRUPTED/STOPPED/ERROR/人为暂停/并发满额）待投递，等接收者下一次显式派发注入。互通永不产生工作：不新建/修改任务、依赖、ownership、attempt、acceptance，不写 `output.md`、不进 `wait` 结果、不唤醒已停止/暂停成员；一问一答，回答不再唤醒空闲提问者。`status` 给 `Comms:` 计数、正在回答者与失败摘要，失败只告警不重试，`stop/kill` 同样能停通信回合且不伪造任务 BLOCKED。
- runtime 永不自动调用下一动作。Leader解释 Reviewer/专家意见并决定下一显式调用。

`FIX_REQUIRED` 保留 Reviewer 的 `fix_prompt` 原文。再次 `run` 是同一 task 的新 attempt，不创建“修复任务”，也不 amendment。ownership 从 RUNNING 保持到 VERIFIED/CANCELED；SUBMITTED、AUDITING、FIX_REQUIRED、BLOCKED、REPORT_INVALID 都不释放。

### consult：只读提问

一次调用只给成员与问题，`expertRoundId` 可选作轮次 id（不给就生成 `consult-N`），`taskIds`/`taskId`/`expertId` 一律拒绝：

```ts
agent_team({ action: "consult", member: { id: "reviewer" }, objective: "为什么 task-a 的缓存命中率低？" })
```

默认后台派发：工具回合立即结束，`details.results[0].status` 是 `RUNNING`，文本形如 `default/reviewer [RUNNING] session=<uuid>`。成员收尾后按专家形状信封回报，轮次 id 字段仍叫 `expertRoundId`：

```json
{"agent_team_report":{"type":"expert","expertRoundId":"consult-1","summary":"cache miss 来自空表","evidence":[],"requests":[]}}
```

`status` 把这条轮次记成 `Current expert/consult-1: RUNNING member=reviewer`；派发前后所有 ExecutionTask 的 status 不变。被咨询的成员可以是任意已规划角色（不要求 debugger/product/optimizer），但仍须空闲；expert 的资格判定不受影响，给 consult 传 `expertId` 会被拒绝。依据：runtime.ts:1129（参数只收 member + objective + 可选 expertRoundId）、runtime.ts:2480（preflightConsult）、runtime.ts:2392 与 2416（与 expert 共用同一份只读正文和信封）、runtime.ts:2515（轮次 id 生成）、runtime.ts:2536（resume 按轮次自身 kind 恢复）。

### 派发首段：TEAM SCOPE 授权地图

execution、review、expert、consult 四种派发的提示词第一段是同一张授权地图（以 `[TEAM SCOPE]` 开头、`[/TEAM SCOPE]` 结尾；runtime.ts:2225、2289、2406 三处 `this.scopeMapSegment(...)` 都是 prompt 数组首项），它同时回答三件事：谁是队友（除自己与 STOPPED 之外的成员各一行 `id — kind · role`，kind 取自 plan.memberKinds —— runtime.ts:2162）、各自能写哪里（`owns:` 是该成员全部任务 `packet.ownedPaths` 的并集，没有任务写 `none`）、谁终裁（倒数第二行固定 `- reviewer: <plan.reviewerId>` —— runtime.ts:2167）。最后一行是块内固定声明「联系与同伴消息不授予写入权，也不改变这张图。」（session-roster.ts:39）。它是这张图的收尾行，不是另写的一条散装规则；读这行和读上面几行是同一件事。

地图每轮派发重建，因此不进缓存前缀（`dispatch-prompt` 段 `cachePrefix:false`，index.ts:140）；它随每次派发重发，不能指望它省 token。成员超过 12 人时保留前 11 行、追加「…另有 N 位见 status」，reviewer 行始终保留（session-roster.ts:41、104、107）。名册文本只由 `scopeMapBlock` 生成，runtime 不另写第二份（dispatch-prompt.test.ts:293 直接断言 runtime.ts 里没有这段字面量）；`stop`/`kill` 的人类可读清单仍走旧的 `formatRoster`（runtime.ts:4583、4628），`status` 单成员沿用同一族的 `rosterLine`（runtime.ts:5351）——两套不合并，也不必合并。

### 注记防伪：一个边界函数管所有面

外来正文进提示词只有一个守卫 `guardNote`（note-guard.ts:142）：先剥不可见字符，再按西里尔/希腊同形字折叠后定位，最后把命中的注记开头改成全角，让 `[TEAM SCOPE]`、`同伴消息 [`、`Leader answers to`、`[Assigned by` 再也拼不回来。它幂等，只折断伪造注记，不做内容审查（note-guard.ts:2）。

成员产出文本走唯一入口 `memberTextForPrompt`（runtime.ts:1356），覆盖面就是提示词里所有成员产出的位置：依赖摘要（runtime.ts:2234）、Reviewer 的 fix_prompt（runtime.ts:2243）、review 的 Submissions（runtime.ts:2295）、expert 与 consult 的 Targets（runtime.ts:2413）、收件箱回执（runtime.ts:1408，入口在 runtime.ts:2776）。三段外来正文在各自边界上引用同一个守卫：同伴正文（runtime.ts:1369）、只读提问（runtime.ts:1382）、Leader 答复（runtime.ts:1393）。

持久化的 TeamState 存的是原文，只有渲染进 prompt 的那份副本过守卫（runtime.ts:1354），所以不要在入口之外再洗一遍同一段文本。成员自己的 objective、constraints、charter 不走这条管道——守卫会剥掉 ZWJ 与组合符，测试按码点证明只有成员正文逐字保留（dispatch-prompt.test.ts:353）。

### 联系不授予写入权

同伴消息只交换信息，不动授权面：注入末尾的 `reachNotice`（member-reach.ts:140）以「仅表示可以发消息 (message allowed)，不授予写入权 (contact ≠ write authority)」开头（member-reach.ts:149），然后列出接收方此刻真实可写路径；没有任务授权时直接写「接收方本次没有可写路径」。派发注入（runtime.ts:1372）与 steer（runtime.ts:2896）都挂同一段通知，所以「能发消息」不会被读成「能写对方路径」。可达性只回答会话问题：自己发给自己、任一端不在名册、任一端已 STOPPED 都返回 false（member-reach.ts:87）。

### 五种投递与保管

每种把外来文本送进成员上下文的投递，都只有一个保管处；「谁在等」与「是否改变授权」逐行写明：

| 投递 | 谁在等 | 是否改变授权 |
| --- | --- | --- |
| execution 派发（run/parallel/resume） | Leader 等 execution 信封（SUBMITTED/BLOCKED），成员执行本 attempt | 不改变：ownedPaths 从 RUNNING 锁到 VERIFIED/CANCELED |
| review 轮次 | Leader 等 review 信封，verdict 只有计划指定的 Reviewer 能写 | 不改变：reviewer 只读，不取写权 |
| expert 轮次 | Leader 等 expert 信封（debugger/product/optimizer 的只读结论） | 不改变：不取 ownership、不写 verdict |
| consult 轮次 | Leader 等一个 expert 形状的信封（轮次 id 仍叫 expertRoundId）；不绑任务 | 只读只到契约与状态层（派发正文要求只读、轮次不绑 taskIds、任务状态前后不变，runtime.ts:2407、2480），写工具没有收回：consult is read-only by contract and state, not at the tool layer: the consulted member keeps its own write tools. |
| 同伴消息：steer / 只读回答 / 待投递 | 运行中→成员当前回合的安全点；空闲→提问者的收件箱（一问一答）；其余→下一次显式派发 | 不改变：每条注入都带 reachNotice，逐条重述接收方真实可写路径 |

表外两条边界：只读回答回合的白名单是 `read/grep/find/ls/ffgrep/fffind/glob`，其余工具在 `tool_call` 处硬拦截（member-communication.ts:105），上限 3 个模型回合/120 秒（peer-protocol.ts:27、28）；回合类型由 `isPeerCommTurn` 只看首个非空行判定（member-communication.ts:36、:43），普通材料里引用该标记不会把回合翻成只读；consult 那句只读限定与 Fields 指引逐字一致（index.ts:171），工具描述里是同一限定的短句（index.ts:160）。

### 本轮删掉的提示词

删的都是重复或越界的内容，删完的落点都能在代码里核对：

| 删掉 | 理由 | 现在在哪 |
| --- | --- | --- |
| 成员身份块里的六句旧限制（Do not consult legacy team files / Follow only the current runtime dispatch / You may exchange short messages / When a dispatch is marked as a peer communication turn / Do not create or coordinate agents / legacy shared coordination files） | 这些约束要么由本次派发自己给出，要么由通信回合的提示自己给出；留在身份块只是每轮重复（清单与计数见 dispatch-prompt.test.ts:495） | 身份块只剩 persona 加一行规则（compat.ts:19，装配在 compat.ts:395） |
| 工具描述里的 UI 细节（dashboard、协作图、动画、节点相位、浏览器关闭 fallback / window.close、browser） | 描述属于可进缓存前缀的稳定段，UI 细节不是工具契约（index.ts:157）；违禁词逐个断言（dispatch-prompt.test.ts:484） | 描述与指引只留运行时强制的语义（index.ts:160、171） |
| 派发首段里重复的 legacy/身份句 | 同一句话在提示词里出现两次，只浪费预算（dispatch-prompt.test.ts:493 断言 runtime.ts 不再含这句） | execution 首句现在只有 `Execute planned task <id>, attempt <n>.`（runtime.ts:2226）；legacy 边界只剩工具描述一句（index.ts:160）与身份块的 leader/agent_team 一句（compat.ts:19） |
| guidelines 里重复的「主 Pi 是唯一 Leader」 | 每条只讲一件运行时强制的事，重复的 Leader 句只留在 Dispatch 一节（index.ts:168） | index.ts:173 |

分节表把这条锁死：五段提示词各自只有一处生成处，只有 tool-description、tool-guidelines、member-identity 可进缓存前缀（index.ts:117），dispatch-prompt 与 report-envelope 每轮重建（index.ts:140、147）；稳定段不得含易变 token（dispatch-prompt.test.ts:429），description 与 guidelines 的预算分别是 1200 与 2600 字符（dispatch-prompt.test.ts:451）。

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

Execution 不能自报 VERIFIED。Envelope 缺失/损坏/越界进入 `REPORT_INVALID`，保留正文与锁，通知 Leader；不自然语言猜测、不自动重试。所有协作请求随 envelope 交 Leader；成员之间只有 runtime 代管的受控短消息通道（`team_message`），没有自由 RPC、文件信箱或任务协商。

上面的外壳由 runtime 在每次派发时追加在提示词最末尾，是权威文本（报纸上只会多一段“Authoritative report envelope”）。plan 里的 `outputContract` 只写额外约束（篇幅、不得粘贴全文等），不要重写或改写外壳，也不要给成员另一套字段形状。

Evidence 内容规范（写入每个 dispatch prompt 的硬约束）：`evidence` 数组元素只写纯中文的路径/行号描述，必须用 `path:line` 冒号格式（如 `src/a.ts:42`，一律用正斜杠 `/`），禁止散文式「第 N 行」写法；禁止反斜杠、禁止贴 Swift 或其他代码片段、禁止照抄示例内容。envelope 必须是最后一个非空行、裸的单行 JSON：禁止代码围栏/```，禁止 Markdown 包裹，正文后不留空行或注释。flash 类小模型会复制示例代码或围栏，违反即 `REPORT_INVALID`。

成员会话按 sessionId 复用：修订 instructions 后旧历史仍主导输出，重发同样 prompt 大概率复现同一错误。标准恢复流程：连续 REPORT_INVALID（或明显被旧上下文污染）时 kill 舍弃该成员，amendment 新增替补（新 sessionId + 新指令）并把 reviewerId/任务派发切过去；旧成员保留名册闲置。不要反复重试同一成员。

## 状态与恢复

- 默认 `status`：成员/任务计数、当前对象、阻塞、pendingRequests。
- `status full:true`：仅需完整 roster/DAG/TaskPacket 时使用。
- `wait`：显式收集完整结果；后台 planned completion 已自动发送精简 delta，不轮询。
- `stop`：软中断，保留 Session/授权，不重放。
- `kill`：终止 child；活动 execution attempt 取消，授权与 Session UUID 保留。
- `set-model {member:{id,model,thinking?}}`：只允许空闲成员调用；`STARTING/RUNNING` 必须先 `stop`。模型与可选思考程度走同一后端；live child 切换后核对两字段，不一致保持旧持久配置，无 live child 则下次 run 生效。下一轮首个真实 assistant 回复的 `provider/model` 还必须完全匹配，否则本轮失败、停止不可信 child、绝不自动重放。Dashboard 除两个选择器加一个应用按钮（一次提交 model+thinking，同一限制）外，还提供每成员「停止／继续」：停止是软中断（目标 `BLOCKED`、child/Session 保留），继续只对「网页手动停过且仍 `BLOCKED`」的同一任务/轮次开新 attempt，服务端按真实 RunTarget 二次校验。停／续成功后 Leader 会收到一条标注「用户手动操作」的通知——收到后**不得**据此自动调度、重试或重复派发，由用户/Leader 显式推进后续节点。无输出时的阶段占位只显示阶段名与工具名（不含参数、结果、思考正文）。**协作图为默认视图**：`collaboration-graph.js`（唯一固定白名单、nonce 经典脚本）渲染主 Agent 与按团队稳定分层的成员，图内滚动，顶部可切回工作面板。点击节点展开原详情，关闭或 Esc 恢复全图（窄屏为覆盖式详情）。主节点是全图唯一深色卡片，带成员/进行中/排队计数且独立消费主会话状态；成员卡左侧竖条按状态着色，显示真实状态和白名单当前动作，未知不冒充空闲。通信线只显示类型/状态：派发、引导、回报、同伴提问/关联回答、旧报告留言与请求应答。活动成员的归属线沿箭头方向缓慢涌动（纯 CSS），一次投递叠三波脉冲，表示运行时已接受/投递/提交，不证明对方已阅读，更不等于 VERIFIED；排队与失败静态显示且不涌动，近期成功关系淡出；运行中的成员优先获得图焦点，空闲后回到手选成员，聚焦会突出其收发关系。只读回答用独立阶段，不覆盖任务/输出；网页可停止回答但不制造可继续工作目标。图不连调度，不显示正文/凭据；隐藏/断连/切回面板/减少动画清理动效，重连/刷新不重播历史，未开工耗时显示「尚未开始」。Dashboard 不提供自由聊天、自动唤醒、自动派工或自动熔断控件。
- 健康告警：`status` 可查看成员 `health=` 等级与原因。三层模型证据、最后事件/工具、用量与 Context 由 runtime 在成员最终化时一次性记录；连续工具错误、重复工具、auto-retry 的固定阈值只升告警等级并留言原因，**仅告警不干预**——不自动 steer/stop/kill、不自动派发，由 Leader 依据状态决定人工动作。

TeamState 是唯一结构化事实源。恢复时先 `status`，行动前由 runtime 再校验实时状态；中断、provider 错误、REPORT_INVALID 或原生压缩/会话失败都表现为既有状态，由 Leader显式选择重试、修复、换成员（需 amendment）或停问用户。`REPORT_INVALID` 一律按原任务重派核对（`run` 同一 taskId，新 attempt），不得从正文推断成功或跳过核对。

上游 provider 间歇故障（opencode-go 等上游的 `network_error` / HTTP 400 `invalid_encrypted_content`）不属于成员过错：串行重派同一任务逐个尝试，不并行轰炸、不擅自换模型、不换 provider 绕路；连续重派仍失败才停问用户。

成员固定 400 先查 maxTokens：`~/.pi/agent/models.json` 的 provider `modelOverrides` 里 maxTokens 超过上游限额（如 384000 > 131072）会固定 400；不要直接改 `models-store.json` 缓存（每 4 小时被上游刷新覆盖），持久修法是写 `models.json` 覆盖。

## 文件与上下文

默认文件只有 `leader/plan.md`、identity，以及超长 output 等按需产物。不创建或依赖旧 brief、roster、notes、事件日志、snapshot、mailbox 或任务板。

成员启动时启用 Pi 原生 auto-compaction。orchestrator 不设自定义阈值、不在 settled 后主动调用 compact、不写压缩交接文件。原生压缩或会话失败表现为 `ERROR/INTERRUPTED`，绝不自动重放；Leader按 TeamState 和成员输出决定是否轮换接续。

## 验收门

Reviewer 的 `FINAL_VERIFY: VERIFIED` 不等于用户验收。完成 Expert/Optimizer gate 后，Leader提交完成标准、证据、限制和手工入口，等待 `HUMAN_ACCEPT`。用户提出合约外变化时先 plan amendment / USER_GATE。用户验收后调一次 `close {team}`：成员会话结束、页面退场，收尾不是自动动作。
