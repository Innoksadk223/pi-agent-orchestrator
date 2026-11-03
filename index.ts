import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { confirmAgentTeam } from "./agent-team-confirm.ts";
import { PiCompatibilityAdapter } from "./compat.ts";
import { AgentTeamParams } from "./schema.ts";
import { WebDashboard, type DashboardLeaderState } from "./web-dashboard.ts";
import {
	STATE_ENTRY_TYPE,
	TeamRuntime,
	type MemberConfig,
	type RuntimeContext,
	type TeamState,
	type ToolParams,
	readAutoApproveDefault,
	writeAutoApproveDefault,
} from "./runtime.ts";

function runtimeContext(pi: ExtensionAPI, ctx: ExtensionContext): RuntimeContext {
	const sessionManager = ctx.sessionManager as unknown as Record<string, unknown>;
	return {
		cwd: ctx.cwd,
		mode: ctx.mode,
		model: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined,
		thinking: ctx.thinkingLevel as MemberConfig["thinking"] | undefined,
		trusted: ctx.isProjectTrusted(),
		hasUI: ctx.hasUI,
		parentPersisted: Boolean(ctx.sessionManager.getSessionFile()),
		capabilities: {
			appendEntry: typeof (pi as unknown as Record<string, unknown>).appendEntry === "function",
			getBranch: typeof sessionManager.getBranch === "function",
		},
		confirm: (title, message, options) => confirmAgentTeam(ctx.mode, ctx.ui, title, message, options),
		appendSnapshot: (snapshot: TeamState) => pi.appendEntry(STATE_ENTRY_TYPE, structuredClone(snapshot)),
		// Detached member completions report themselves back into the main Pi's
		// session: a custom message that participates in LLM context, delivered as
		// followUp (never steers an in-flight tool chain) with triggerTurn (starts
		// a new main-agent turn when idle). The Dashboard is not involved in this
		// path, so the main agent never depends on the viewer to learn a result.
		sendParentMessage: (message, options) => pi.sendMessage(message, options),
		// Model catalogue for the Dashboard switcher: the parent's registry snapshot
		// (public ExtensionContext.modelRegistry.getAvailable).
		listModels: () =>
			ctx.modelRegistry.getAvailable().map((model) => ({
				provider: model.provider,
				id: model.id,
				name: model.name,
				contextWindow: model.contextWindow,
			})),
	};
}

function errorText(error: unknown): string {
	if (error && typeof error === "object" && "report" in error) {
		const report = (error as { report?: { code?: string; message?: string } }).report;
		if (report) return `${report.code ?? "COMPATIBILITY_ERROR"}: ${report.message ?? String(error)}`;
	}
	return error instanceof Error ? error.message : String(error);
}

// 复用主 Pi 生命周期，只向网页发状态和有界工具名；不会访问消息/提示/参数/结果。
export function observeLeaderStatus(
	pi: Pick<ExtensionAPI, "on">,
	publish: (state: DashboardLeaderState) => void,
): () => DashboardLeaderState {
	let state: DashboardLeaderState = { status: "UNKNOWN", tools: [] };
	const activeTools = new Map<string, string>();
	const snapshot = (): DashboardLeaderState => ({ status: state.status, tools: [...state.tools] });
	const update = (status: DashboardLeaderState["status"]) => {
		state = { status, tools: status === "TOOL" ? [...new Set(activeTools.values())].slice(0, 3) : [] };
		publish(snapshot());
	};
	pi.on("session_start", (_event, ctx) => {
		activeTools.clear();
		update(ctx.isIdle() ? "IDLE" : "RUNNING");
	});
	pi.on("agent_start", () => {
		activeTools.clear();
		update("RUNNING");
	});
	pi.on("tool_execution_start", (event) => {
		activeTools.set(event.toolCallId, event.toolName.slice(0, 64));
		update("TOOL");
	});
	pi.on("tool_execution_end", (event) => {
		if (!activeTools.delete(event.toolCallId)) return;
		update(activeTools.size ? "TOOL" : "RUNNING");
	});
	// agent_end 后仍可能压缩、重试或继续；真正停止以 agent_settled 为准。
	pi.on("agent_settled", () => {
		activeTools.clear();
		update("IDLE");
	});
	pi.on("session_shutdown", () => {
		activeTools.clear();
		update("UNKNOWN");
	});
	return snapshot;
}

/**
 * 提示词分节表：五处提示词各自只有一处归属，生命周期与缓存前缀资格写在这里。
 * 测试据此锁住「能进缓存前缀的稳定段不得含易变 token」，避免提示词表面再次膨胀。
 * owner 用 <file>:<symbol>，测试会打开文件确认符号确实存在。
 */
export interface PromptSection {
	/** 稳定标识，测试与报告都引用它。 */
	id: "tool-description" | "tool-guidelines" | "member-identity" | "dispatch-prompt" | "report-envelope";
	/** 唯一生成处。 */
	owner: string;
	/** global：扩展常量；client-start：每个成员 child 启动写一次；dispatch：每次派发整块重建；attempt：每个 attempt 的轮次 id。 */
	lifecycle: "global" | "client-start" | "dispatch" | "attempt";
	/** true = 同一成员跨 attempt 完全不变，可进缓存前缀；false = 每次派发都变。 */
	cachePrefix: boolean;
	/** 谁消费这一段，以及它为什么存在。 */
	consumer: string;
}

export const PROMPT_SECTION_TABLE: readonly PromptSection[] = [
	{
		id: "tool-description",
		owner: "index.ts:AGENT_TEAM_DESCRIPTION",
		lifecycle: "global",
		cachePrefix: true,
		consumer: "主 Pi 看到的 agent_team 工具描述",
	},
	{
		id: "tool-guidelines",
		owner: "index.ts:AGENT_TEAM_GUIDELINES",
		lifecycle: "global",
		cachePrefix: true,
		consumer: "主 Pi 的 promptGuidelines（操作指引）",
	},
	{
		id: "member-identity",
		owner: "compat.ts:MEMBER_IDENTITY_RULE",
		lifecycle: "client-start",
		cachePrefix: true,
		consumer: "成员 child 的系统提示词，每个 client 启动写一次",
	},
	{
		id: "dispatch-prompt",
		owner: "runtime.ts:preflightExecutionDispatch",
		lifecycle: "dispatch",
		cachePrefix: false,
		consumer: "三条派发构造器：preflightExecutionDispatch / reviewDispatchTask / expertDispatchTask",
	},
	{
		id: "report-envelope",
		owner: "runtime.ts:envelopeContract",
		lifecycle: "attempt",
		cachePrefix: false,
		consumer: "成员回报外壳，每次尝试都带真实轮次 id",
	},
];

/**
 * 稳定段：跨会话不变，可进缓存前缀。只写 schema 表达不了、且运行时确实强制的语义；
 * UI 细节（面板、协作图、动画、浏览器关闭）不属于工具契约，不进提示词。
 */
export const AGENT_TEAM_DESCRIPTION =
	"Agent Team control plane. plan fixes the roster, Reviewer, task DAG, owned paths and acceptance; amendments need expectedRevision; validateOnly checks a draft. With auto off, the first plan, new members and authorization-widening amendments need USER_GATE; set-auto is persisted. Only the Leader advances run/parallel/review/expert/consult/cancel; the runtime never selects or dispatches on its own. steer reaches a running member; pause/resume act on exactly one target without replay; answer-request/resolve-request advance member questions. Members reach each other only through team_message; each message is delivered once (steer, one read-only answer turn when idle, else queued) and never becomes work, ownership or acceptance. Only the Reviewer decides verified or fix-required; experts are read-only, and consult is read-only by contract and state. Reports end with the dispatch's JSON envelope. Background dispatches return before results; status stays compact, wait returns full output, and deltas arrive later. close ends the team after human acceptance. Legacy team state is readable but cannot dispatch; members get local context only, never agent_team.";

/** 工具列表里的一行摘要，不与 description 重复同一句话。 */
export const AGENT_TEAM_PROMPT_SNIPPET =
	"Register a plan, then dispatch tasks, reviews, read-only experts or consult questions; inspect status, wait, steer, pause or resume, answer requests, and close a finished team.";

/**
 * 稳定段：操作指引。预算 ≤ 2600 字符（见 dispatch-prompt.test.ts）。
 * 每条只讲一件运行时强制的事；重复的「主 Pi 是唯一 Leader」只留在 Dispatch 一条里。
 */
export const AGENT_TEAM_GUIDELINES: readonly string[] = [
	"**Fields.** plan takes members/reviewerId/tasks/acceptance; run taskId; parallel taskIds; review reviewRoundId+taskIds; expert expertRoundId+expertId+taskIds+objective; consult member+objective plus an optional expertRoundId, never taskIds. expectedRevision belongs to amendments and validateOnly to plan. Amendments need the user's consent on scope first, use the current revision, and never remove tasks. Auto off gates the first plan, new members and authorization-widening edits; set-auto is persisted, so call it before plan only while it is off. consult is read-only by contract and state, not at the tool layer: the consulted member keeps its own write tools.",
	"**Charter and roster.** Every member gets a five-part charter injected verbatim as their only persona, so a changed charter needs a replacement member. Plan the whole job up front: fixed roster, one Reviewer, a DAG with cwd-relative ownedPaths and per-task acceptance; reuse a member whose kind, charter and boundaries already fit before adding one. Write business text in the user's language and keep structural labels English.",
	"**Dispatch.** The main Pi is the only Leader: dispatch one whole runnable batch per call and queue the rest. Parallelize only distinct members with verified dependencies and non-overlapping paths. Rerun fix-required work as the same task with the reviewer's fix prompt, and cancel dropped tasks that have not started. Dispatches carry only local task context; use compact status after persistence instead of polling, and wait only for a full result.",
	"**Review.** Only submitted tasks are reviewed, and only the planned Reviewer decides verified or fix-required; execution reports never verify. Replies end with the exact single-line envelope from the dispatch; an invalid report, an interruption or a provider failure is a recovery state, never a verdict, and an accepted prompt is never replayed. Final verification is an evidence gate, not acceptance: present criteria, evidence and limits, then wait for the human decision.",
	"**Messaging and model.** Members reach each other only through team_message: a steer reaches a running member, and an answer is injected once. Omitted model/thinking inherits for a new member and is preserved by amendments; explicit values must match the canonical catalogue exactly. Keep Pi native auto-compaction on, with no custom thresholds or handoff files.",
];

export default function agentOrchestrator(pi: ExtensionAPI) {
	// Code-level recursion guard: child team members do not register orchestration entry points.
	if (process.env.PI_AGENT_TEAM_MEMBER === "1") return;

	const compatibility = new PiCompatibilityAdapter();
	let dashboard: WebDashboard | undefined;
	const leaderState = observeLeaderStatus(pi, (state) => dashboard?.setLeaderState(state));
	const runtime: TeamRuntime = new TeamRuntime(compatibility, undefined, undefined, (ctx) => {
		dashboard = new WebDashboard({
			openBrowser: async (url) => {
				if (process.platform !== "darwin") throw new Error("Automatic browser launch is currently supported on macOS.");
				const result = await pi.exec("/usr/bin/open", [url], { timeout: 10_000 });
				if (result.code !== 0) throw new Error("Default browser could not be opened.");
			},
			setMemberModel: async (team, id, model, thinking) => {
				try {
					const result = await runtime.setModelFromDashboard(team, id, model, thinking, ctx);
					return { ok: true, text: result.content[0]?.text };
				} catch (error) {
					return { ok: false, error: errorText(error) };
				}
			},
			// 网页停/续：只提交 team/id/action，真实目标由运行时解析并二次校验；
			// 成功且已落盘后运行时会向 Leader 发一条简短的「用户手动操作」通知。
			controlMember: async (team, id, action) => {
				try {
					const result =
						action === "stop"
							? await runtime.stopFromDashboard(team, id, ctx)
							: await runtime.resumeFromDashboard(team, id, ctx);
					return { ok: true, text: result.content[0]?.text };
				} catch (error) {
					return { ok: false, error: errorText(error) };
				}
			},
			// 每次序列化成员快照时都重算停/续能力，页面刷新/SSE 重连不会看到过期按钮状态。
			controlLookup: (team, id) => runtime.dashboardControlFor(team, id),
		});
		dashboard.setLeaderState(leaderState());
		return dashboard;
	}, undefined, readAutoApproveDefault(), writeAutoApproveDefault);

	pi.on("session_start", async (_event, ctx) => {
		const context = runtimeContext(pi, ctx);
		runtime.restoreFromBranch(ctx.sessionManager.getBranch());
		try {
			await runtime.featureCheck(context);
		} catch {
			// Status and doctor expose the structured failure; startup never spawns a child or calls a model.
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		await runtime.shutdown(runtimeContext(pi, ctx));
		dashboard = undefined;
	});

	pi.registerTool({
		name: "agent_team",
		label: "Agent Team",
		description: AGENT_TEAM_DESCRIPTION,
		promptSnippet: AGENT_TEAM_PROMPT_SNIPPET,
		promptGuidelines: [...AGENT_TEAM_GUIDELINES],
		parameters: AgentTeamParams,
		executionMode: "sequential",
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			return runtime.execute(params as ToolParams, runtimeContext(pi, ctx), signal, onUpdate);
		},
	});

	pi.registerCommand("team-status", {
		description: "Show persistent Agent Team members and child session UUIDs",
		handler: async (args, ctx) => {
			const [team = "default", member] = args.trim().split(/\s+/, 2).filter(Boolean);
			const result = await runtime.execute(
				{ action: "status", team, member: member ? { id: member } : undefined },
				runtimeContext(pi, ctx),
			);
			ctx.ui.notify(result.content[0]?.text ?? "No team state.", "info");
		},
	});

	pi.registerCommand("team-doctor", {
		description: "Verify Pi RPC and exact child-session recovery without calling a model",
		handler: async (_args, ctx) => {
			try {
				const report = await runtime.doctor(runtimeContext(pi, ctx));
				ctx.ui.notify(`${report.code}: ${report.message}`, "info");
			} catch (error) {
				ctx.ui.notify(errorText(error), "error");
			}
		},
	});
}
