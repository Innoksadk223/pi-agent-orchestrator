import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { confirmAgentTeam } from "./agent-team-confirm.ts";
import { PiCompatibilityAdapter } from "./compat.ts";
import { AgentTeamParams } from "./schema.ts";
import { WebDashboard } from "./web-dashboard.ts";
import {
	STATE_ENTRY_TYPE,
	TeamRuntime,
	type MemberConfig,
	type RuntimeContext,
	type TeamState,
	type ToolParams,
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

export default function agentOrchestrator(pi: ExtensionAPI) {
	// Code-level recursion guard: child team members do not register orchestration entry points.
	if (process.env.PI_AGENT_TEAM_MEMBER === "1") return;

	const compatibility = new PiCompatibilityAdapter();
	const runtime: TeamRuntime = new TeamRuntime(compatibility, undefined, undefined, (ctx) =>
		new WebDashboard({
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
		}),
	);

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
	});

	pi.registerTool({
		name: "agent_team",
		label: "Agent Team",
		description:
			"Persistent Agent Team planned execution control plane. Register a fixed roster, reviewer, execution DAG, owned paths, local TaskPackets, and acceptance with plan; repeat plan with expectedRevision for amendments; validateOnly:true dry-runs every semantic check without a gate or persistence. With auto off, only the initial registration and roster growth (adding a member) are USER_GATEs; same-roster amendments and re-dispatching existing members need no consent. set-auto is session-scoped authorization that skips those gates. A registered plan is advanced only by explicit Leader calls: run(taskId), parallel(taskIds), review(reviewRoundId+taskIds), expert(expertRoundId+expertId+taskIds+objective), and cancel(taskIds) to abandon non-running tasks (releasing their path locks and cascading to PENDING/READY dependents). Live control: steer injects a short message only into an active RUNNING member via Pi's public steer RPC (a client without the public surface is refused loudly, never faked); pause(taskId) reuses the soft abort interrupt so the child/session stay alive while the task becomes BLOCKED (never replayed); resume(taskId) explicitly re-dispatches the same task as its next attempt; answer-request/resolve-request advance the pending-request lifecycle (OPEN -> ANSWERED -> injected into the source member's next explicit dispatch, even under a new review/expert round id -> RESOLVED, or explicitly closed). Members may attach bounded requests (question/scope/dependency/human) and controlled one-line messages for planned peers to their report; messages are capped per receiver and delivered exactly once after prompt acceptance, and unaccepted prompts keep them pending. Member health snapshots record three-layer model evidence, last event/tool, usage, and fixed-threshold alerts (tool errors, repeated tools, auto-retries) as alerts only - no automatic steer/stop/kill/dispatch. Runtime validates authorization, dependencies, member availability, and path locks but never creates or dispatches the next node automatically. New members inherit the main model only when model is omitted; explicit canonical provider/model values must exactly match the available catalogue and never fall back, while amendment omission preserves an existing member's model. Model switching is idle-only and is trusted only after both RPC state and the first real assistant reply match. Members finish with a strict single-line JSON envelope; execution can only SUBMIT/BLOCK, the planned Reviewer alone decides VERIFIED/FIX_REQUIRED, and read-only experts never alter verdicts. Background completion sends a compact delta; status is compact unless full:true, while wait explicitly returns the complete result. Legacy TeamState remains readable for status, stop/kill, and recovery but cannot dispatch new work. Members receive only their current local dispatch context and never receive agent_team. The existing Dashboard remains a required UI dispatch observer whose only control applies a member model and thinking level together; a pixel-office/visual panel stays deferred until the user confirms the design. Session reuse, stop/kill, Pi native auto-compaction, and HUMAN_ACCEPT remain explicit.",
		promptSnippet: "Register a plan, manually run READY tasks/reviews/read-only experts, inspect compact status, wait for full results, steer active members, pause/resume tasks, answer member requests, stop/kill members, or switch member model/thinking settings.",
		promptGuidelines: [
			"Each action has a strict, separate parameter shape; send only fields listed for that action. Minimal dispatches: {\"action\":\"run\",\"team\":\"default\",\"taskId\":\"task-1\"}; {\"action\":\"parallel\",\"team\":\"default\",\"taskIds\":[\"task-1\",\"task-2\"]}; {\"action\":\"review\",\"team\":\"default\",\"reviewRoundId\":\"review-1\",\"taskIds\":[\"task-1\"]}. A plan needs members/reviewerId/tasks/acceptance; task entries need id/memberId/objective/ownedPaths/acceptance. Initial plan must not include expectedRevision; amendments must include it. Member headPrompt/tailPrompt are optional persistent additions; task headPrompt/tailPrompt are optional one-task additions. Never put member config or objective into run/parallel/review. Use validateOnly:true only with plan.",
			"Write a dedicated professional role charter as every member's instructions — never a bare one-liner. Cover: core responsibilities and expertise, boundaries (what the member must not touch or decide), working style, output expectations, and how it relates to other members. Instructions are injected verbatim as the member's fixed identity via --append-system-prompt (their only persona source); write them in the user's language. Amending instructions on an already-created member session is dominated by old history — add a replacement member (new sessionId) when a clean persona change is needed.",
			"Plan content language: all user-facing business text in a plan payload — member roles, instructions, task objectives, constraints, acceptance criteria, expert objectives — is written in the user's language (Simplified Chinese for this project) so plan confirmations render readable prose; runtime structural labels (## Team:, Roster, Tasks, depends:, acceptance:) stay English as-is.",
			"Use agent_team plan for complex Loop work: register the complete fixed roster, reviewerId, execution DAG, concrete cwd-relative owned paths, local TaskPackets, and acceptance. With auto off, initial registration and roster growth are USER_GATEs; same-roster amendments (instruction/task/acceptance edits) are silent. set-auto may authorize them for only the current runtime session. Amend only with the current expectedRevision.",
			"After plan registration, the main Pi remains the only Leader and manually starts each READY task, review batch, or read-only expert round. agent_team validates facts and safety constraints but never selects experts, creates tasks, or auto-dispatches a successor.",
			"Treat plan amendments as a conversation, not a reflex: when the user requests changes, first discuss the change set (what/why/impact on tasks and owned paths) until aligned, then ask whether to produce the amended plan; call plan only after explicit consent. Validate drafts cheaply with validateOnly:true first. Never submit an amendment in the same turn the change was requested unless the user explicitly asked for immediate submission. Use cancel {taskIds} to abandon non-running planned tasks when the discussion drops them.",
			"Use run with taskId and parallel with taskIds for planned execution. Parallelize only distinct members whose dependencies are VERIFIED and whose concrete owned paths do not overlap; a FIX_REQUIRED task is rerun as the same task's next attempt with the reviewer's fix_prompt unchanged.",
			"Create review rounds only for SUBMITTED tasks. The planned Reviewer is the only role that may decide VERIFIED or FIX_REQUIRED; execution self-reports never count as verification. Debugger, product, and optimizer expert rounds are read-only and never alter task verdicts.",
			"Members end with the exact single-line JSON envelope supplied in their TaskPacket. Treat REPORT_INVALID, interruption, and provider failure as explicit recovery states; never infer a verdict from prose and never replay an accepted prompt automatically.",
			"Background planned completions deliver a compact delta after TeamState persistence. Do not poll; use compact status for routine decisions, status full:true only when the complete roster/DAG/TaskPackets are needed, and wait only to explicitly collect the full member result.",
			"Members receive only the current task, dependency summaries, local acceptance/relevant paths, and fix_prompt. Final review may receive global acceptance; no dispatch receives the full roster, global plan, legacy coordination files, or parent conversation history.",
			"Lead live runs deliberately: steer {member:{id}, message} injects a short correction only into an active RUNNING member through Pi's public steer RPC - never call it on idle members and never assume steering replaces a task; a client without the public steer surface refuses explicitly. pause {taskId} soft-interrupts an active attempt (member INTERRUPTED, task BLOCKED, child/session kept, nothing replayed); resume {taskId} explicitly re-dispatches the same task as attempt+1 after its preflight. Answer member-raised requests with answer-request {requestId, answer} - the answer is injected only into the source member's next explicit dispatch (including a new review/expert round id) and then consumed; resolve-request closes requests you no longer need. Controlled member messages are capped per receiver and delivered exactly once per accepted prompt; an unaccepted prompt keeps them pending. Member health levels are alert-only observations (tool errors, repeated tools, auto-retries) with fixed thresholds; treat them as signals for a manual decision - they never auto-steer, auto-stop, auto-kill, or auto-dispatch.",
			"Never grant members agent_team or create recursive teams. Leave a new member's model/thinking empty unless the user chose overrides; an omitted model inherits the main Pi only for a new member, while omission in an amendment preserves that existing member's persisted model. Explicit model values must be exact available canonical provider/model references and are never replaced by the main model. set-model accepts optional thinking only while the member is idle; STARTING/RUNNING members must be stopped first. The Dashboard uses the same path, and a switch is trusted only after RPC state plus the next run's first real assistant reply both match.",
			"Enable Pi native auto-compaction when each member starts. Do not set custom thresholds, invoke compact after settlement, or create compaction handoff files; native compaction or session failures surface through ERROR/INTERRUPTED and are never replayed automatically.",
			"FINAL_VERIFY VERIFIED remains an Agent evidence gate, not user acceptance. Present criteria, evidence, limits, and the manual entry point, then wait for HUMAN_ACCEPT; contract changes require plan amendment and a new USER_GATE.",
		],
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
