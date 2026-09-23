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
			"Persistent Agent Team control plane. plan registers a fixed roster, Reviewer, DAG, owned paths, TaskPackets, and acceptance; expectedRevision is required for amendments; validateOnly:true validates without gates or persistence. With auto off, only the initial plan and new members need USER_GATE; set-auto is session-only. The Leader explicitly advances run/parallel/review/expert/cancel; cancel releases locks and cascades PENDING/READY dependents; runtime never creates or dispatches work automatically. steer only targets RUNNING members through real Pi steer RPC; pause blocks without replay, resume starts the next attempt; answer-request/resolve-request manage queued answers. Reports may carry bounded requests and one-line peer messages delivered once after prompt acceptance; health is alert-only. New members inherit omitted models, amendments preserve them, explicit provider/model must be canonical, and idle-only switching needs RPC plus first-reply evidence. Members return strict JSON; only the Reviewer decides VERIFIED/FIX_REQUIRED; experts are read-only. Background completion sends compact deltas; status is compact by default, wait returns full results. Legacy TeamState is readable for recovery but cannot dispatch. Members receive only local context and never agent_team. Dashboard model changes also set thinking; pixel-office UI is deferred. Session reuse, stop/kill, native auto-compaction, and HUMAN_ACCEPT are explicit.",
		promptSnippet: "Register a plan, manually run READY tasks/reviews/read-only experts, inspect compact status, wait for full results, steer active members, pause/resume tasks, answer member requests, stop/kill members, or switch member model/thinking settings.",
		promptGuidelines: [
			"Use only fields for the action. Plan requires members/reviewerId/tasks/acceptance; tasks require id/memberId/objective/ownedPaths/acceptance. Initial plan omits expectedRevision; amendments require it. Never put member config/objective in run/parallel/review; validateOnly only belongs to plan.",
			"Give every member a professional charter covering expertise, boundaries, working style, output, and peer relation. It is injected verbatim as the sole persona via --append-system-prompt. Write business text in the user's language (Simplified Chinese here); keep structural labels English. A changed charter needs a replacement member for a clean session.",
			"Write plan business text (roles, instructions, objectives, constraints, acceptance, expert goals) in the user's language; keep structural labels English.",
			"Plan complex work with a fixed roster, Reviewer, DAG, cwd-relative owned paths, TaskPackets, and acceptance. With auto off, only initial registration and roster growth gate; same-roster amendments are silent. Discuss amendment scope/impact first and submit only after explicit consent; use validateOnly first. Amendments use current expectedRevision and cannot remove tasks. set-auto is session-only.",
			"Prefer reusing the approved roster over growing it: check whether an existing member's kind, charter, and boundaries already cover the new work and dispatch the new task to that member instead of adding one; add a member only when no existing one fits the specialty, boundaries, or an independent-review need. The roster can never shrink, and each addition costs a new session, a new charter, and (unless set-auto) a fresh USER_GATE.",
			"The main Pi is the only Leader. Manually run READY tasks, reviews, and experts; runtime validates authorization, dependencies, availability, and locks but never selects, creates, or dispatches successors. Parallelize only distinct members with VERIFIED dependencies and non-overlapping paths. Rerun FIX_REQUIRED as the same task with the reviewer's fix_prompt. Use cancel for dropped non-running tasks.",
			"Review only SUBMITTED tasks. The planned Reviewer alone decides VERIFIED/FIX_REQUIRED; execution reports never verify. Debugger/product/optimizer experts are read-only and never change verdicts.",
			"Members must end with the TaskPacket's exact single-line JSON envelope. REPORT_INVALID, interruption, and provider failure are explicit recovery states; never infer verdicts from prose or replay an accepted prompt.",
			"Use compact status and background deltas after persistence; do not poll. Use status full:true only for the complete roster/DAG/packets, and wait only to collect a full result. Dispatches receive only the current task, dependency summaries, local acceptance/paths, and fix_prompt; final review may also receive global acceptance.",
			"Use steer only on an active RUNNING member via real Pi steer RPC. pause blocks without replay; resume starts attempt+1. answer-request injects its answer into the source member's next dispatch, then consumes it; resolve-request closes it. Messages are bounded and delivered once after acceptance. Health alerts never auto-steer/stop/kill/dispatch.",
			"Never grant members agent_team or create recursive teams. Omitted model/thinking inherits for new members and preserves existing values in amendments. Explicit models must exactly match the canonical provider/model list. set-model is idle-only and trusted only after RPC state plus the next real assistant reply match. Dashboard switches model and thinking together.",
			"Enable Pi native auto-compaction at member start. Do not set custom thresholds, compact after settlement, or create handoff files; failures are ERROR/INTERRUPTED and never replayed.",
			"FINAL_VERIFY is an Agent evidence gate, not acceptance. Present criteria, evidence, limits, and the manual entry point; wait for HUMAN_ACCEPT. Contract changes require an amended plan and a new USER_GATE.",
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
