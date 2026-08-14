import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import type { CompactionResultLike, RpcClientLike, RpcStats } from "./compat.ts";
import type {
	CompatibilityPort,
	MemberState,
	PlanInput,
	RuntimeContext,
	TeamState,
} from "./runtime.ts";
import {
	configHash,
	emptyState,
	idleKeepAliveMs,
	IDLE_KEEP_ALIVE_ENV,
	IDLE_KEEP_ALIVE_MS,
	IDLE_TIMEOUT_ENV,
	IDLE_TIMEOUT_MAX_MS,
	IDLE_TIMEOUT_MIN_MS,
	idleTimeoutForMode,
	MAX_CONCURRENCY,
	MEMBER_IDLE_TIMEOUT_MS,
	migrateState,
	normalizeOwnedPath,
	parseReportEnvelope,
	pathsConflict,
	RPC_IDLE_TIMEOUT_MS,
	STATE_ENTRY_TYPE,
	STATE_SCHEMA_VERSION,
	THINKING_LEVELS,
	TeamRuntime,
	truncateMemberOutput,
	validateToolRequest,
	waitForSettledWithIdleTimeout,
} from "./runtime.ts";
import type {
	DashboardEvent,
	DashboardMemberHandle,
	DashboardMemberSpec,
	DashboardStatus,
	TeamDashboard,
} from "./web-dashboard.ts";
import {
	dashboardEventsFromRpc,
	DashboardUnavailableError,
	MAX_DASHBOARD_EVENT_BYTES,
	sanitizeDashboardText,
	WebDashboard,
} from "./web-dashboard.ts";

const NOW = "2026-08-01T00:00:00.000Z";
const HTML = '<!doctype html><style nonce="__CSP_NONCE__"></style><script nonce="__CSP_NONCE__"></script>';
const MEMBER = {
	id: "reviewer",
	role: "Reviewer",
	instructions: "Review the implementation.",
	model: "test/model",
	thinking: "medium" as const,
	tools: ["read"],
};
const PLAN: PlanInput = {
	members: [
		{ id: "coder-a", kind: "coder", role: "Coder A", instructions: "Implement task A." },
		{ id: "coder-b", kind: "coder", role: "Coder B", instructions: "Implement task B." },
		{ id: "reviewer", kind: "reviewer", role: "Reviewer", instructions: "Review only.", tools: ["read"] },
		{ id: "optimizer", kind: "optimizer", role: "Optimizer", instructions: "Optimize read-only.", tools: ["read"] },
	],
	reviewerId: "reviewer",
	tasks: [
		{
			id: "task-a",
			memberId: "coder-a",
			objective: "Implement task A objective.",
			constraints: ["Stay in scope."],
			dependsOn: [],
			ownedPaths: ["src/a"],
			acceptance: ["A is complete."],
			relevantPaths: ["src/a/index.ts"],
		},
		{
			id: "task-b",
			memberId: "coder-b",
			objective: "Implement task B objective.",
			constraints: [],
			dependsOn: ["task-a"],
			ownedPaths: ["src/b"],
			acceptance: ["B is complete."],
			relevantPaths: ["src/b/index.ts"],
		},
	],
	acceptance: ["Global acceptance marker."],
};

const SPECS: DashboardMemberSpec[] = [
	{ team: "default", id: "reviewer", role: "Reviewer", model: "test/model", thinking: "medium", sessionId: "session-1" },
	{ team: "default", id: "scout", role: "Scout", model: "test/model", thinking: "low", sessionId: "session-2" },
];

function stats(assistantMessages = 0): RpcStats {
	return {
		assistantMessages,
		tokens: { input: assistantMessages * 10, output: assistantMessages * 5, cacheRead: 0, cacheWrite: 0 },
		cost: assistantMessages * 0.01,
	};
}

class FakeClient implements RpcClientLike {
	startCalls = 0;
	stopCalls = 0;
	promptCalls: string[] = [];
	abortCalls = 0;
	setModelCalls: Array<{ provider: string; modelId: string }> = [];
	setThinkingLevelCalls: string[] = [];
	idleTimeouts: Array<number | undefined> = [];
	listeners = new Set<(event: any) => void>();
	output = "done";
	contextUsage?: RpcStats["contextUsage"];
	promptError?: Error;
	abortError?: Error;
	stateModel?: string;
	stateThinkingLevel = "medium";
	ignoreModelUpdates = false;
	ignoreThinkingUpdates = false;
	// Per-turn assistant text (S2-7 baseline): when set, turn N reports roundOutputs[N-1]
	// instead of the single `output` value, so multi-round tests can simulate new text.
	roundOutputs?: string[];
	private idleBlocked = false;
	private turns = 0;

	constructor(
		readonly sessionId: string,
		private readonly order: string[] = [],
	) {}

	async start(): Promise<void> {
		this.startCalls++;
		this.order.push(`start:${this.sessionId}`);
	}
	async stop(): Promise<void> {
		this.stopCalls++;
	}
	onEvent(listener: (event: any) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
	async prompt(message: string): Promise<void> {
		this.promptCalls.push(message);
		this.order.push(`prompt:${message}`);
		if (this.promptError) throw this.promptError;
		this.turns++;
		if (!this.idleBlocked) this.emit({ type: "agent_settled" });
	}
	async waitForIdle(timeout?: number): Promise<void> {
		this.idleTimeouts.push(timeout);
	}
	async abort(): Promise<void> {
		this.abortCalls++;
		if (this.abortError) throw this.abortError;
	}
	async setModel(provider: string, modelId: string): Promise<unknown> {
		this.setModelCalls.push({ provider, modelId });
		if (!this.ignoreModelUpdates) this.stateModel = `${provider}/${modelId}`;
		return { provider, id: modelId };
	}
	async setThinkingLevel(level: string): Promise<void> {
		this.setThinkingLevelCalls.push(level);
		if (!this.ignoreThinkingUpdates) this.stateThinkingLevel = level;
	}
	async getState(): Promise<{ sessionId: string; sessionName?: string; model?: string; thinkingLevel?: string }> {
		const state: { sessionId: string; sessionName?: string; model?: string; thinkingLevel?: string } = {
			sessionId: this.sessionId,
			sessionName: "team:default/reviewer",
			thinkingLevel: this.stateThinkingLevel,
		};
		if (this.stateModel) state.model = this.stateModel;
		return state;
	}
	async setSessionName(): Promise<void> {}
	async getSessionStats(): Promise<RpcStats> {
		return { ...stats(this.turns), contextUsage: this.contextUsage };
	}
	async getLastAssistantText(): Promise<string | null> {
		// S2-7 baseline semantics: before the first prompt turn there is no assistant
		// text, so the runtime can tell "this round produced no new text" apart from
		// a pre-existing baseline from an earlier round.
		return this.turns > 0 ? (this.roundOutputs?.[this.turns - 1] ?? this.output) : null;
	}
	manualCompactionCalls: string[] = [];
	setAutoCompactionCalls: boolean[] = [];
	async compact(customInstructions?: string): Promise<CompactionResultLike> {
		this.manualCompactionCalls.push(customInstructions ?? "");
		return { summary: customInstructions ?? "no-op", firstKeptEntryId: "test", tokensBefore: 0, estimatedTokensAfter: 0 };
	}
	async setAutoCompaction(enabled: boolean): Promise<void> {
		this.setAutoCompactionCalls.push(enabled);
	}
	emit(event: any): void {
		for (const listener of this.listeners) listener(event);
	}
	blockUntilIdle(): void {
		this.idleBlocked = true;
	}
	completeIdle(): void {
		this.idleBlocked = false;
		this.emit({ type: "agent_settled" });
	}
}

class FakeCompatibility implements CompatibilityPort {
	clients: FakeClient[] = [];
	createCalls = 0;
	blockIdle = false;
	workspaces: string[] = [];
	instructionsSeen: string[] = [];
	toolsSeen: string[][] = [];
	outputFor?: string;
	outputsByMember: Record<string, string> = {};
	roundOutputsByMember: Record<string, string[]> = {};
	contextUsage?: RpcStats["contextUsage"];
	promptError?: Error;
	stateModel?: string;
	stateThinkingLevel?: string;
	ignoreModelUpdates = false;
	ignoreThinkingUpdates = false;

	constructor(private readonly order: string[] = []) {}

	async featureCheck(): Promise<any> {
		return { ok: true, code: "COMPATIBLE", message: "ok", doctorRequired: false };
	}
	async ensureCompatible(): Promise<any> {
		return { ok: true, code: "COMPATIBLE", message: "ok", doctorRequired: false };
	}
	async doctor(): Promise<any> {
		return { ok: true, code: "DOCTOR_OK", message: "ok", doctorRequired: false };
	}
	async createMemberClient(member: any): Promise<any> {
		this.createCalls++;
		this.workspaces.push(member.workspace);
		this.instructionsSeen.push(member.instructions);
		this.toolsSeen.push([...member.tools]);
		const client = new FakeClient(member.sessionId, this.order);
		if (this.outputFor) client.output = this.outputFor;
		if (this.outputsByMember[member.id]) client.output = this.outputsByMember[member.id];
		if (this.roundOutputsByMember[member.id]) client.roundOutputs = [...this.roundOutputsByMember[member.id]];
		client.contextUsage = this.contextUsage;
		client.promptError = this.promptError;
		client.stateModel = this.stateModel ?? `${member.model.provider}/${member.model.id}`;
		client.stateThinkingLevel = this.stateThinkingLevel ?? member.thinking;
		client.ignoreModelUpdates = this.ignoreModelUpdates;
		client.ignoreThinkingUpdates = this.ignoreThinkingUpdates;
		if (this.blockIdle) client.blockUntilIdle();
		this.clients.push(client);
		return { client, cleanupPrompt: async () => undefined };
	}
}

class FakeView implements DashboardMemberHandle {
	readonly events: DashboardEvent[] = [];
	readonly closed: Promise<{ reason: string }>;
	private resolveClosed!: (loss: { reason: string }) => void;
	open = true;

	constructor() {
		this.closed = new Promise((resolve) => {
			this.resolveClosed = resolve;
		});
	}
	write(event: DashboardEvent): void {
		this.events.push(event);
	}
	isOpen(): boolean {
		return this.open;
	}
	lose(reason = "viewer closed"): void {
		if (!this.open) return;
		this.open = false;
		this.resolveClosed({ reason });
	}
}

class FakeDashboard implements TeamDashboard {
	prepareCalls: DashboardMemberSpec[][] = [];
	closeCalls: string[] = [];
	updateCalls: Array<{ team: string; id: string; spec: DashboardMemberSpec }> = [];
	shutdownCalls = 0;
	views = new Map<string, FakeView>();
	failPrepare?: Error;

	constructor(private readonly order: string[] = []) {}

	async prepare(members: readonly DashboardMemberSpec[]): Promise<Map<string, DashboardMemberHandle>> {
		this.prepareCalls.push([...members]);
		this.order.push(`prepare:${members.map((member) => member.id).join(",")}`);
		if (this.failPrepare) throw this.failPrepare;
		const result = new Map<string, DashboardMemberHandle>();
		for (const member of members) {
			const key = `${member.team}\u0000${member.id}`;
			let view = this.views.get(key);
			if (!view) {
				view = new FakeView();
				this.views.set(key, view);
			}
			result.set(key, view);
		}
		return result;
	}
	status(team: string, id: string, mode: string): DashboardStatus {
		const view = this.views.get(`${team}\u0000${id}`);
		return view?.open && mode === "tui"
			? { visibility: "VISIBLE" }
			: { visibility: mode === "tui" ? "DETACHED" : "UNAVAILABLE" };
	}
	async closeMember(team: string, id: string): Promise<void> {
		this.closeCalls.push(`${team}/${id}`);
		this.views.get(`${team}\u0000${id}`)?.lose("stopped");
		this.views.delete(`${team}\u0000${id}`);
	}
	updateMember(team: string, id: string, spec: DashboardMemberSpec): void {
		this.updateCalls.push({ team, id, spec });
	}
	async shutdown(): Promise<void> {
		this.shutdownCalls++;
		for (const view of this.views.values()) view.lose("shutdown");
		this.views.clear();
	}
}

interface ConnectedViewer {
	url: string;
	origin: string;
	controller: AbortController;
	response: Response;
	reader: ReadableStreamDefaultReader<Uint8Array>;
}

async function connectViewer(url: string, visible = true): Promise<ConnectedViewer> {
	const origin = new URL(url).origin;
	const controller = new AbortController();
	const response = await fetch(new URL("events", url), {
		headers: { Origin: origin },
		signal: controller.signal,
	});
	assert.equal(response.status, 200);
	const viewer = { url, origin, controller, response, reader: response.body!.getReader() };
	if (visible) await postViewerState(viewer, "visible");
	return viewer;
}

async function postViewerState(viewer: Pick<ConnectedViewer, "url" | "origin">, state: string): Promise<Response> {
	return fetch(new URL("viewer", viewer.url), {
		method: "POST",
		headers: { Origin: viewer.origin, "Content-Type": "text/plain;charset=UTF-8" },
		body: state,
	});
}

async function readSseUntil(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	predicate: (payloads: any[]) => boolean,
): Promise<any[]> {
	const decoder = new TextDecoder();
	let buffer = "";
	for (let attempt = 0; attempt < 12; attempt++) {
		const chunk = await Promise.race([
			reader.read(),
			new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("SSE read timed out")), 1000)),
		]);
		if (chunk.done) break;
		buffer += decoder.decode(chunk.value, { stream: true });
		const payloads = buffer
			.split("\n")
			.filter((line) => line.startsWith("data: "))
			.map((line) => JSON.parse(line.slice(6)));
		if (predicate(payloads)) return payloads;
	}
	throw new Error(`Expected SSE payload was not received: ${buffer}`);
}

// Every TeamRuntime test runs against an isolated temporary cwd so workspace writes
// (.pi/agent-team/<team>/leader/plan.md and members/) never touch the real extension directory.
let sharedTestCwd: string | undefined;
function isolatedCwd(): string {
	sharedTestCwd ??= mkdtempSync(join(tmpdir(), "pi-agent-team-test-"));
	return sharedTestCwd;
}
after(async () => {
	if (sharedTestCwd) await rm(sharedTestCwd, { recursive: true, force: true });
});

function context(overrides: Partial<RuntimeContext> = {}): RuntimeContext & {
	snapshots: TeamState[];
	messages: Array<{ message: { customType: string; content: string; display: boolean; details?: unknown }; options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" } }>;
} {
	const snapshots: TeamState[] = [];
	const messages: Array<{ message: { customType: string; content: string; display: boolean; details?: unknown }; options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" } }> = [];
	return {
		cwd: isolatedCwd(),
		mode: "tui",
		model: { provider: "test", id: "model" },
		thinking: "medium",
		trusted: true,
		hasUI: true,
		parentPersisted: true,
		capabilities: { appendEntry: true, getBranch: true },
		confirm: async () => true,
		appendSnapshot: (snapshot) => snapshots.push(snapshot),
		// Parent-session channel spy: mirrors pi.sendMessage wiring from index.ts.
		sendParentMessage: (message, options) => messages.push({ message, options }),
		snapshots,
		messages,
		...overrides,
	};
}

function existingMember(sessionId = "session-1"): MemberState {
	const member: MemberState = {
		id: "reviewer",
		role: "Reviewer",
		instructions: "Review the implementation.",
		model: { provider: "test", id: "model" },
		thinking: "medium",
		tools: ["read"],
		team: "default",
		configHash: "",
		approvedAt: NOW,
		sessionId,
		status: "APPROVED",
	};
	member.configHash = configHash(member);
	return member;
}

function stateWithMembers(members: Record<string, MemberState> = {}): TeamState {
	return {
		schemaVersion: STATE_SCHEMA_VERSION,
		updatedAt: NOW,
		teams: {
			default: {
				id: "default",
				members,
				executionTasks: {},
				reviewRounds: {},
				expertRounds: {},
				pendingRequests: [],
			},
		},
	};
}

function executionReport(taskId: string, status: "SUBMITTED" | "BLOCKED" = "SUBMITTED", summary = "execution summary"): string {
	return `Execution body that remains in the child session.\n${JSON.stringify({ agent_team_report: { type: "execution", taskId, status, summary, evidence: [`evidence/${taskId}`], requests: [] } })}`;
}

function reviewReport(
	roundId: string,
	decisions: Array<{ taskId: string; verdict: "VERIFIED" | "FIX_REQUIRED"; fix_prompt?: string }>,
	summary = "review summary",
): string {
	return `Review body.\n${JSON.stringify({ agent_team_report: { type: "review", reviewRoundId: roundId, summary, evidence: ["review/evidence"], requests: [], decisions } })}`;
}

function expertReport(roundId: string, summary = "NO_CANDIDATE"): string {
	return `Expert body.\n${JSON.stringify({ agent_team_report: { type: "expert", expertRoundId: roundId, summary, evidence: [], requests: [] } })}`;
}

async function registerPlan(runtime: TeamRuntime, ctx: RuntimeContext, plan: PlanInput = PLAN): Promise<void> {
	await runtime.execute({ action: "plan", plan }, ctx);
}

async function waitFor(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 200; attempt++) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	throw new Error("Condition was not reached.");
}

test("public thinking levels include Pi max", () => {
	assert.equal(THINKING_LEVELS.includes("max"), true);
});

test("dashboard sanitizer and RPC mapper expose only approved bounded event classes", () => {
	const dirty = "ok\r\x1b]2;owned\x07\x1b[31mred\x00\u202Etxt\u2066" + "界".repeat(10_000);
	const clean = sanitizeDashboardText(dirty);
	assert.equal(/[\x00-\x09\x0B-\x1F\x7F-\x9F\u202E\u2066\r]/u.test(clean), false);
	assert.ok(Buffer.byteLength(clean, "utf8") <= MAX_DASHBOARD_EVENT_BYTES);
	assert.match(clean, /truncated/u);
	assert.deepEqual(
		dashboardEventsFromRpc({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hello" } }),
		[{ type: "assistant_text", delta: "hello" }],
	);
	assert.deepEqual(
		dashboardEventsFromRpc({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "secret" } }),
		[],
	);
	assert.deepEqual(dashboardEventsFromRpc({ type: "message_start", message: { role: "system", content: "secret" } }), []);
	assert.deepEqual(
		dashboardEventsFromRpc({ type: "tool_execution_end", toolName: "write", result: "raw secret", isError: false }),
		[],
	);
	assert.deepEqual(dashboardEventsFromRpc({ type: "unknown", payload: "secret" }), []);
});

test("Workbench HTML is self-contained, observer-plus-model-thinking-switcher, semantic, and textContent-only for dynamic data", async () => {
	const html = await readFile(new URL("./web-dashboard.html", import.meta.url), "utf8");
	assert.match(html, /<header class="topbar">/u);
	assert.match(html, /<aside class="member-rail"/u);
	assert.match(html, /<main id="member-panel"/u);
	for (const label of ["团队摘要", "团队成员", "实时活动", "Assistant 输出", "累计用量", "技术详情", "成员模型与思考"]) {
		assert.match(html, new RegExp(label, "u"));
	}
	assert.match(html, /<details class="stream-section activity-section"/u);
	assert.doesNotMatch(html, /<details[^>]*activity-section[^>]*\sopen(?:\s|>)/u);
	assert.doesNotMatch(html, /工具活动|tool-list|tool_start|tool_end|工具开始|工具完成/u);
	assert.equal((html.match(/__CSP_NONCE__/gu) ?? []).length, 2);
	assert.doesNotMatch(html, /(?:src|href)=["']https?:/iu);
	// The only control surface is two labelled selects plus one apply button.
	assert.match(html, /<label class="sr-only" for="model-select">/u);
	assert.match(html, /<select id="model-select"/u);
	assert.match(html, /<label class="sr-only" for="thinking-select">/u);
	assert.match(html, /<select id="thinking-select"/u);
	assert.match(html, /<button id="model-apply"/u);
	assert.equal((html.match(/<select\b/gu) ?? []).length, 2);
	assert.equal((html.match(/<button\b/gu) ?? []).length, 1);
	assert.doesNotMatch(html, /<(?:form|input|textarea|iframe)\b|contenteditable/iu);
	assert.doesNotMatch(html, /innerHTML|insertAdjacentHTML|document\.write/iu);
	assert.match(html, /textContent/gu);
	assert.match(html, /prefers-reduced-motion/u);
	assert.match(html, /summaryTimer = setInterval/u);
	assert.match(html, /clearInterval\(summaryTimer\)/u);
	assert.match(html, /:focus-visible/u);
	assert.match(html, /aria-live=/u);
	assert.match(html, /role="tablist"/u);
	assert.doesNotMatch(html, /gradient|backdrop-filter|box-shadow|text-shadow|transition:\s*all|100vw/iu);
});

test("loopback server requires token, local Host and same Origin and sends security headers", async () => {
	let viewer: ConnectedViewer | undefined;
	const dashboard = new WebDashboard({
		readHtml: async () => HTML,
		randomToken: () => "a".repeat(64),
		readyTimeoutMs: 2_000,
		heartbeatTimeoutMs: 10_000,
		openBrowser: async (url) => {
			const parsed = new URL(url);
			assert.equal(parsed.hostname, "127.0.0.1");
			assert.ok(Number(parsed.port) > 0);
			const html = await fetch(url);
			assert.equal(html.status, 200);
			assert.match(html.headers.get("cache-control") ?? "", /no-store/u);
			assert.match(html.headers.get("content-security-policy") ?? "", /default-src 'none'/u);
			assert.match(html.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/u);
			assert.equal(html.headers.get("referrer-policy"), "no-referrer");
			assert.equal(html.headers.get("x-content-type-options"), "nosniff");
			assert.equal(html.headers.get("x-frame-options"), "DENY");
			assert.equal(html.headers.get("cross-origin-resource-policy"), "same-origin");
			assert.doesNotMatch(await html.text(), /__CSP_NONCE__/u);
			assert.equal((await fetch(`${parsed.origin}/events`)).status, 404);
			assert.equal((await fetch(`${parsed.origin}/${"b".repeat(64)}/events`)).status, 404);
			assert.equal((await fetch(new URL("events", url), { method: "POST", headers: { Origin: parsed.origin } })).status, 405);
			assert.equal((await fetch(new URL("events", url), { headers: { Origin: "https://attacker.invalid" } })).status, 403);
			assert.equal((await fetch(new URL("viewer", url), {
				method: "POST",
				headers: { Origin: "https://attacker.invalid", "Content-Type": "text/plain" },
				body: "visible",
			})).status, 403);
			const wrongHost = await new Promise<number | undefined>((resolve, reject) => {
				const req = request({
					host: "127.0.0.1",
					port: parsed.port,
					path: `${parsed.pathname}events`,
					headers: { Host: `localhost:${parsed.port}` },
				}, (response) => {
					response.resume();
					response.on("end", () => resolve(response.statusCode));
				});
				req.on("error", reject);
				req.end();
			});
			assert.equal(wrongHost, 403);
			viewer = await connectViewer(url);
		},
	});
	try {
		const handles = await dashboard.prepare([SPECS[0]]);
		assert.equal(handles.size, 1);
		assert.equal(dashboard.status("default", "reviewer", "tui").visibility, "VISIBLE");
	} finally {
		viewer?.controller.abort();
		await dashboard.shutdown();
	}
});

test("Dashboard model endpoint submits model and thinking together", async () => {
	let viewer!: ConnectedViewer;
	let submitted: { team: string; id: string; model: string; thinking: string } | undefined;
	const dashboard = new WebDashboard({
		readHtml: async () => HTML,
		randomToken: () => "c".repeat(64),
		readyTimeoutMs: 2_000,
		heartbeatTimeoutMs: 10_000,
		openBrowser: async (url) => {
			viewer = await connectViewer(url);
		},
		setMemberModel: async (team, id, model, thinking) => {
			submitted = { team, id, model, thinking };
			return { ok: true, text: "applied" };
		},
	});
	try {
		await dashboard.prepare([SPECS[0]]);
		const response = await fetch(new URL("model", viewer.url), {
			method: "POST",
			headers: { Origin: viewer.origin, "Content-Type": "application/json" },
			body: JSON.stringify({ team: "default", id: "reviewer", model: "test/other", thinking: "xhigh" }),
		});
		assert.equal(response.status, 200);
		assert.deepEqual(await response.json(), { ok: true, text: "applied" });
		assert.deepEqual(submitted, { team: "default", id: "reviewer", model: "test/other", thinking: "xhigh" });

		const missingThinking = await fetch(new URL("model", viewer.url), {
			method: "POST",
			headers: { Origin: viewer.origin, "Content-Type": "application/json" },
			body: JSON.stringify({ team: "default", id: "reviewer", model: "test/other" }),
		});
		assert.equal(missingThinking.status, 400);
		assert.match(JSON.stringify(await missingThinking.json()), /thinking are required/u);
	} finally {
		viewer?.controller.abort();
		await dashboard.shutdown();
	}
});

test("prepare waits for one SSE viewer and a visible heartbeat", async () => {
	let url = "";
	const dashboard = new WebDashboard({
		readHtml: async () => HTML,
		readyTimeoutMs: 2_000,
		heartbeatTimeoutMs: 10_000,
		openBrowser: async (value) => {
			url = value;
		},
	});
	const preparing = dashboard.prepare(SPECS);
	await waitFor(() => Boolean(url));
	let resolved = false;
	void preparing.then(() => {
		resolved = true;
	});
	await new Promise((resolve) => setTimeout(resolve, 10));
	assert.equal(resolved, false);
	const viewer = await connectViewer(url, false);
	await new Promise((resolve) => setTimeout(resolve, 10));
	assert.equal(resolved, false);
	assert.equal((await postViewerState(viewer, "visible")).status, 204);
	const handles = await preparing;
	assert.equal(handles.size, 2);
	assert.ok([...handles.values()].every((handle) => handle.isOpen()));
	viewer.controller.abort();
	await waitFor(() => dashboard.status("default", "reviewer", "tui").visibility === "DETACHED");
	assert.ok([...handles.values()].every((handle) => handle.isOpen()));
	await dashboard.shutdown();
	await Promise.all([...handles.values()].map((handle) => handle.closed));
});

test("one visible viewer is reused and member SSE events remain keyed and sanitized", async () => {
	const viewers: ConnectedViewer[] = [];
	let browserCalls = 0;
	const dashboard = new WebDashboard({
		readHtml: async () => HTML,
		readyTimeoutMs: 2_000,
		heartbeatTimeoutMs: 10_000,
		openBrowser: async (url) => {
			browserCalls++;
			viewers.push(await connectViewer(url));
		},
	});
	try {
		const handles = await dashboard.prepare(SPECS);
		const reused = await dashboard.prepare([SPECS[0]]);
		assert.equal(browserCalls, 1);
		assert.equal(reused.get("default\u0000reviewer"), handles.get("default\u0000reviewer"));
		const duplicate = await fetch(new URL("events", viewers[0].url), { headers: { Origin: viewers[0].origin } });
		assert.equal(duplicate.status, 409);
		handles.get("default\u0000reviewer")!.write({ type: "assistant_text", delta: "reviewer-only\u202E\x1b" });
		handles.get("default\u0000scout")!.write({ type: "status", status: "RUNNING\u202E\x1b" });
		const payloads = await readSseUntil(viewers[0].reader, (items) =>
			items.some((item) => item.kind === "event" && item.memberKey === "default\u0000reviewer") &&
			items.some((item) => item.kind === "event" && item.memberKey === "default\u0000scout"),
		);
		const bootstrap = payloads.find((item) => item.kind === "bootstrap");
		const reviewer = payloads.find((item) => item.kind === "event" && item.memberKey === "default\u0000reviewer");
		const scout = payloads.find((item) => item.kind === "event" && item.memberKey === "default\u0000scout");
		assert.equal(bootstrap.members.find((member: any) => member.id === "reviewer").thinking, "medium");
		assert.equal(reviewer.event.delta, "reviewer-only");
		assert.equal(scout.event.status, "RUNNING");
		assert.doesNotMatch(JSON.stringify(payloads), /\u202E|\x1b/u);
	} finally {
		viewers[0]?.controller.abort();
		await dashboard.shutdown();
	}
});

test("a destroyed stale SSE response cannot block a new viewer", async () => {
	let viewer!: ConnectedViewer;
	const dashboard = new WebDashboard({
		readHtml: async () => HTML,
		readyTimeoutMs: 2_000,
		heartbeatTimeoutMs: 10_000,
		openBrowser: async (url) => {
			viewer = await connectViewer(url);
		},
	});
	(dashboard as any).viewerResponse = { writableEnded: false, destroyed: true };
	const handles = await dashboard.prepare([SPECS[0]]);
	assert.equal(handles.get("default\u0000reviewer")!.isOpen(), true);
	viewer.controller.abort();
	await waitFor(() => dashboard.status("default", "reviewer", "tui").visibility === "DETACHED");
	assert.equal(handles.get("default\u0000reviewer")!.isOpen(), true);
	await dashboard.shutdown();
	await handles.get("default\u0000reviewer")!.closed;
});

test("viewer state changes detach without closing handles or opening another page", async (t) => {
	for (const state of ["hidden", "pagehide", "disconnected"] as const) {
		await t.test(state, async () => {
			let viewer!: ConnectedViewer;
			let browserCalls = 0;
			const dashboard = new WebDashboard({
				readHtml: async () => HTML,
				readyTimeoutMs: 2_000,
				heartbeatTimeoutMs: 10_000,
				openBrowser: async (url) => {
					browserCalls++;
					viewer = await connectViewer(url);
				},
			});
			const handles = await dashboard.prepare(SPECS);
			assert.equal((await postViewerState(viewer, state)).status, 204);
			assert.equal(dashboard.status("default", "reviewer", "tui").visibility, "DETACHED");
			assert.ok([...handles.values()].every((handle) => handle.isOpen()));
			assert.equal((await postViewerState(viewer, "visible")).status, 204);
			assert.equal(dashboard.status("default", "reviewer", "tui").visibility, "VISIBLE");
			const reused = await dashboard.prepare([SPECS[0]]);
			assert.equal(reused.get("default\u0000reviewer"), handles.get("default\u0000reviewer"));
			assert.equal(browserCalls, 1);
			viewer.controller.abort();
			await dashboard.shutdown();
		});
	}

	await t.test("SSE close reconnects in the same page", async () => {
		let url = "";
		let viewer!: ConnectedViewer;
		let browserCalls = 0;
		const dashboard = new WebDashboard({
			readHtml: async () => HTML,
			readyTimeoutMs: 2_000,
			heartbeatTimeoutMs: 10_000,
			openBrowser: async (value) => {
				browserCalls++;
				url = value;
				viewer = await connectViewer(value);
			},
		});
		const handles = await dashboard.prepare(SPECS);
		viewer.controller.abort();
		await waitFor(() => dashboard.status("default", "reviewer", "tui").visibility === "DETACHED");
		assert.ok([...handles.values()].every((handle) => handle.isOpen()));
		viewer = await connectViewer(url);
		assert.equal(dashboard.status("default", "reviewer", "tui").visibility, "VISIBLE");
		const reused = await dashboard.prepare([SPECS[0]]);
		assert.equal(reused.get("default\u0000reviewer"), handles.get("default\u0000reviewer"));
		assert.equal(browserCalls, 1);
		viewer.controller.abort();
		await dashboard.shutdown();
	});
});

test("heartbeat loss detaches while later prepares reuse the same runtime", async () => {
	let now = 0;
	const urls: string[] = [];
	const viewers: ConnectedViewer[] = [];
	const dashboard = new WebDashboard({
		readHtml: async () => HTML,
		now: () => now,
		heartbeatPollMs: 5,
		heartbeatTimeoutMs: 20,
		readyTimeoutMs: 2_000,
		openBrowser: async (url) => {
			urls.push(url);
			viewers.push(await connectViewer(url));
		},
	});
	const first = await dashboard.prepare([SPECS[0]]);
	now = 50;
	await waitFor(() => dashboard.status("default", "reviewer", "tui").visibility === "DETACHED");
	assert.equal(first.get("default\u0000reviewer")!.isOpen(), true);
	const second = await dashboard.prepare([SPECS[0]]);
	assert.equal(urls.length, 1);
	assert.equal(second.get("default\u0000reviewer"), first.get("default\u0000reviewer"));
	assert.equal((await postViewerState(viewers[0], "visible")).status, 204);
	assert.equal(dashboard.status("default", "reviewer", "tui").visibility, "VISIBLE");
	viewers[0].controller.abort();
	await dashboard.shutdown();
});

test("closeMember removes only its view and the last member releases the loopback runtime", async () => {
	let viewer!: ConnectedViewer;
	const dashboard = new WebDashboard({
		readHtml: async () => HTML,
		readyTimeoutMs: 2_000,
		heartbeatTimeoutMs: 10_000,
		openBrowser: async (url) => {
			viewer = await connectViewer(url);
		},
	});
	const handles = await dashboard.prepare(SPECS);
	await dashboard.closeMember("default", "reviewer");
	assert.equal((await handles.get("default\u0000reviewer")!.closed).reason, "member stopped");
	assert.equal(handles.get("default\u0000scout")!.isOpen(), true);
	assert.equal(dashboard.status("default", "reviewer", "tui").visibility, "UNAVAILABLE");
	await dashboard.closeMember("default", "scout");
	assert.equal((await handles.get("default\u0000scout")!.closed).reason, "member stopped");
	await assert.rejects(fetch(viewer.url));
	await dashboard.shutdown();
	await dashboard.shutdown();
});

test("browser launch and visibility timeout failures roll back the server", async (t) => {
	await t.test("browser launch", async () => {
		let url = "";
		const dashboard = new WebDashboard({
			readHtml: async () => HTML,
			readyTimeoutMs: 50,
			openBrowser: async (value) => {
				url = value;
				throw new Error("browser unavailable");
			},
		});
		await assert.rejects(
			dashboard.prepare([SPECS[0]]),
			(error: unknown) => error instanceof DashboardUnavailableError && error.code === "DASHBOARD_UNAVAILABLE",
		);
		await assert.rejects(fetch(url));
		assert.equal(dashboard.status("default", "reviewer", "tui").visibility, "UNAVAILABLE");
		await dashboard.shutdown();
	});
	await t.test("visible handshake", async () => {
		let url = "";
		const dashboard = new WebDashboard({
			readHtml: async () => HTML,
			readyTimeoutMs: 20,
			openBrowser: async (value) => {
				url = value;
			},
		});
		await assert.rejects(dashboard.prepare([SPECS[0]]), /browser viewer was not visible/u);
		await assert.rejects(fetch(url));
		await dashboard.shutdown();
	});
});

test("authorization rejection, cancellation, and no UI have zero UUID, persistence, dashboard, and child effects", async (t) => {
	for (const scenario of ["rejected", "cancelled", "no-ui"] as const) {
		await t.test(scenario, async () => {
			const compatibility = new FakeCompatibility();
			let dashboardFactories = 0;
			let uuidCalls = 0;
			const runtime = new TeamRuntime(
				compatibility,
				() => NOW,
				() => {
					uuidCalls++;
					return "session-1";
				},
				() => {
					dashboardFactories++;
					return new FakeDashboard();
				},
			);
			const ctx = context({
				hasUI: scenario !== "no-ui",
				confirm: async () => {
					if (scenario === "cancelled") throw new Error("confirmation aborted");
					return false;
				},
			});
			if (scenario === "cancelled") {
				await assert.rejects(runtime.execute({ action: "run", member: MEMBER, task: "task" }, ctx), /confirmation aborted/u);
			} else {
				const result = await runtime.execute({ action: "run", member: MEMBER, task: "task" }, ctx);
				assert.equal(result.details.cancelled, true);
			}
			assert.equal(dashboardFactories, 0);
			assert.equal(uuidCalls, 0);
			assert.equal(ctx.snapshots.length, 0);
			assert.equal(compatibility.createCalls, 0);
		});
	}
});

test("authorization text describes the observer-only Dashboard and UI state stays out of persistence", async () => {
	const compatibility = new FakeCompatibility();
	const dashboard = new FakeDashboard();
	let message = "";
	const ctx = context({
		confirm: async (_title, body) => {
			message = body;
			return true;
		},
	});
	const runtime = new TeamRuntime(compatibility, () => NOW, () => "session-1", () => dashboard);
	await runtime.execute({ action: "run", member: MEMBER, task: "task" }, ctx);
	assert.match(message, /本地只读 Web Dashboard/u);
	assert.match(message, /唯一操作:一起应用模型与思考程度/u);
	assert.match(message, /页面断线不影响 Agent/u);
	const persisted = JSON.stringify(ctx.snapshots);
	assert.doesNotMatch(persisted, /token|127\.0\.0\.1|VISIBLE|DETACHED|UNAVAILABLE|heartbeat/u);
	const status = await runtime.execute({ action: "status", member: { id: "reviewer" } }, ctx);
	assert.match(status.content[0].text, /viewer=VISIBLE/u);
	assert.doesNotMatch(status.content[0].text, /127\.0\.0\.1/u);
	assert.equal(status.details.dashboard?.members["default/reviewer"].visibility, "VISIBLE");
	assert.equal(runtime.getState().teams.default.members.reviewer.configHash.length, 64);
});

test("dashboard failure happens before child creation and prompt", async () => {
	const compatibility = new FakeCompatibility();
	const dashboard = new FakeDashboard();
	dashboard.failPrepare = new DashboardUnavailableError("DASHBOARD_UNAVAILABLE: fake failure");
	const runtime = new TeamRuntime(compatibility, () => NOW, () => "session-1", () => dashboard);
	await assert.rejects(
		runtime.execute({ action: "run", member: MEMBER, task: "task" }, context()),
		/DASHBOARD_UNAVAILABLE/u,
	);
	assert.equal(compatibility.createCalls, 0);
	assert.equal(dashboard.prepareCalls.length, 1);
});

test("actual browser launch failure creates no child client or prompt", async () => {
	const compatibility = new FakeCompatibility();
	const runtime = new TeamRuntime(compatibility, () => NOW, () => "session-1", () => new WebDashboard({
		readHtml: async () => HTML,
		openBrowser: async () => {
			throw new Error("browser unavailable");
		},
	}));
	await assert.rejects(
		runtime.execute({ action: "run", member: MEMBER, task: "task" }, context()),
		/DASHBOARD_UNAVAILABLE/u,
	);
	assert.equal(compatibility.createCalls, 0);
	assert.equal(compatibility.clients.length, 0);
});

test("parallel prepares every view before any client starts or prompts", async () => {
	const order: string[] = [];
	const compatibility = new FakeCompatibility(order);
	const dashboard = new FakeDashboard(order);
	let id = 0;
	const runtime = new TeamRuntime(compatibility, () => NOW, () => `session-${++id}`, () => dashboard);
	await runtime.execute(
		{
			action: "parallel",
			tasks: [
				{ member: MEMBER, task: "one" },
				{ member: { ...MEMBER, id: "scout", role: "Scout" }, task: "two" },
			],
		},
		context(),
	);
	assert.deepEqual(dashboard.prepareCalls[0].map((member) => member.id), ["reviewer", "scout"]);
	assert.equal(order[0], "prepare:reviewer,scout");
	assert.ok(order.slice(1).every((entry) => entry.startsWith("start:") || entry.startsWith("prompt:")));
});

test("runtime member event streams remain isolated", async () => {
	const compatibility = new FakeCompatibility();
	compatibility.blockIdle = true;
	const dashboard = new FakeDashboard();
	let id = 0;
	const runtime = new TeamRuntime(compatibility, () => NOW, () => `session-${++id}`, () => dashboard);
	const run = runtime.execute(
		{
			action: "parallel",
			tasks: [
				{ member: MEMBER, task: "one" },
				{ member: { ...MEMBER, id: "scout", role: "Scout" }, task: "two" },
			],
		},
		context(),
	);
	await waitFor(() => compatibility.clients.length === 2 && compatibility.clients.every((client) => client.promptCalls.length > 0));
	compatibility.clients[0].emit({
		type: "message_update",
		assistantMessageEvent: { type: "text_delta", delta: "only-reviewer" },
	});
	const reviewer = dashboard.views.get("default\u0000reviewer");
	const scout = dashboard.views.get("default\u0000scout");
	assert.ok(reviewer?.events.some((event) => event.type === "assistant_text" && event.delta === "only-reviewer"));
	assert.equal(scout?.events.some((event) => event.type === "assistant_text" && event.delta === "only-reviewer"), false);
	compatibility.clients.forEach((client) => client.completeIdle());
	await run;
});

test("legacy authorization, state, limits, truncation, and compatibility invariants remain intact", async () => {
	const member = existingMember("session-fixed");
	member.configHash = configHash(member);
	const state = {
		schemaVersion: 1 as const,
		teams: { default: { id: "default", members: { reviewer: { ...member, status: "RUNNING" as const } } } },
		updatedAt: NOW,
	};
	const restored = migrateState(state, NOW);
	assert.equal(restored.teams.default.members.reviewer.sessionId, "session-fixed");
	assert.equal(restored.teams.default.members.reviewer.status, "INTERRUPTED");
	assert.equal(configHash({ ...member, status: "STOPPED" } as MemberState), member.configHash);
	const truncated = truncateMemberOutput("界".repeat(30_000));
	assert.equal(truncated.truncated, true);
	assert.ok(Buffer.byteLength(truncated.output, "utf8") <= 50 * 1024);
	assert.match(truncated.output, /truncated/u);
	assert.equal(MAX_CONCURRENCY, 4);
	// parallel no longer restricts tool types; division of labor lives in tasks, not tool allowlists.
	validateToolRequest(
		{
			action: "parallel",
			tasks: [
				{ member: { id: "a", role: "A", instructions: "A", tools: ["write"] }, task: "a" },
				{ member: { id: "b", role: "B", instructions: "B" }, task: "b" },
			],
		},
		emptyState(NOW),
	);

	// runtime-level id validation guards path joins even if the schema layer is bypassed.
	assert.throws(
		() =>
			validateToolRequest(
				{ action: "run", team: "../evil", member: { id: "a", role: "A", instructions: "A" }, task: "t" },
				emptyState(NOW),
			),
		/Invalid team id/u,
	);
	assert.throws(
		() =>
			validateToolRequest(
				{ action: "run", member: { id: "a/b", role: "A", instructions: "A" }, task: "t" },
				emptyState(NOW),
			),
		/Invalid member id/u,
	);
	const compatibility = new FakeCompatibility();
	const runtime = new TeamRuntime(compatibility);
	assert.equal((await runtime.doctor(context())).code, "DOCTOR_OK");
});

test("same member reuses viewer, authorization, client, and child UUID without a total-duration wait", async () => {
	const compatibility = new FakeCompatibility();
	const dashboard = new FakeDashboard();
	let confirmations = 0;
	const ctx = context({
		confirm: async () => {
			confirmations++;
			return true;
		},
	});
	const runtime = new TeamRuntime(compatibility, () => NOW, () => "session-1", () => dashboard);
	await runtime.execute({ action: "run", member: MEMBER, task: "first" }, ctx);
	await runtime.execute({ action: "run", member: { id: "reviewer" }, task: "second" }, ctx);
	assert.equal(confirmations, 1);
	assert.equal(compatibility.createCalls, 1);
	assert.equal(compatibility.clients[0].startCalls, 1);
	assert.deepEqual(compatibility.clients[0].promptCalls, ["first", "second"]);
	// root-cause guard: the runtime no longer hands a total-duration cap to RpcClient.waitForIdle
	assert.deepEqual(compatibility.clients[0].idleTimeouts, []);
	assert.equal(MEMBER_IDLE_TIMEOUT_MS, 10 * 60_000);
	assert.ok(RPC_IDLE_TIMEOUT_MS > MEMBER_IDLE_TIMEOUT_MS);
	assert.equal(dashboard.views.size, 1);
	assert.equal(runtime.getState().teams.default.members.reviewer.sessionId, "session-1");
});

test("idle window: TUI/RPC defaults, env override, fallback, and bounds", async (t) => {
	const previous = process.env[IDLE_TIMEOUT_ENV];
	const setEnv = (value: string | undefined) => {
		if (value === undefined) delete process.env[IDLE_TIMEOUT_ENV];
		else process.env[IDLE_TIMEOUT_ENV] = value;
	};
	t.after(() => setEnv(previous));
	setEnv(undefined);
	assert.equal(idleTimeoutForMode("tui"), MEMBER_IDLE_TIMEOUT_MS);
	assert.equal(idleTimeoutForMode("rpc"), RPC_IDLE_TIMEOUT_MS);
	assert.equal(idleTimeoutForMode("json"), RPC_IDLE_TIMEOUT_MS);
	assert.equal(idleTimeoutForMode("print"), RPC_IDLE_TIMEOUT_MS);
	setEnv("900000"); // 15 minutes
	assert.equal(idleTimeoutForMode("tui"), 900_000);
	assert.equal(idleTimeoutForMode("rpc"), 900_000);
	for (const invalid of ["abc", "", "0", "-1", "1.5", "  ", "0x10", "+5"]) {
		setEnv(invalid);
		assert.equal(idleTimeoutForMode("tui"), MEMBER_IDLE_TIMEOUT_MS, `tui fallback for env ${JSON.stringify(invalid)}`);
		assert.equal(idleTimeoutForMode("rpc"), RPC_IDLE_TIMEOUT_MS, `rpc fallback for env ${JSON.stringify(invalid)}`);
	}
	setEnv(String(IDLE_TIMEOUT_MIN_MS - 1));
	assert.equal(idleTimeoutForMode("rpc"), IDLE_TIMEOUT_MIN_MS);
	setEnv(String(IDLE_TIMEOUT_MAX_MS + 1));
	assert.equal(idleTimeoutForMode("rpc"), IDLE_TIMEOUT_MAX_MS);
});

test("settle wait resolves on agent_settled and any RPC event resets the continuous-idle window", async () => {
	const client = new FakeClient("session-1");
	const wait = waitForSettledWithIdleTimeout((listener) => client.onEvent(listener), 100);
	wait.start();
	let resolved = false;
	void wait.promise.then(() => {
		resolved = true;
	});
	// activity every ~25ms for ~300ms: keeps crossing the 100ms window
	for (let i = 0; i < 12; i++) {
		client.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: `t${i}` } });
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	assert.equal(resolved, false, "plain activity must not resolve the settle wait");
	client.emit({ type: "agent_settled" });
	await wait.promise;
	assert.equal(resolved, true);
});

test("settle wait rejects when the agent is continuously inactive", async () => {
	const client = new FakeClient("session-1");
	const wait = waitForSettledWithIdleTimeout((listener) => client.onEvent(listener), 50);
	wait.start();
	await assert.rejects(wait.promise, /Idle timeout: no agent activity/u);
});

test("continuous activity across the idle window then settled completes IDLE without stopping the child", async () => {
	const compatibility = new FakeCompatibility();
	compatibility.blockIdle = true;
	const dashboard = new FakeDashboard();
	const runtime = new TeamRuntime(compatibility, () => NOW, () => "session-1", () => dashboard, () => 80);
	const run = runtime.execute({ action: "run", member: MEMBER, task: "long active task", background: false }, context());
	await waitFor(() => compatibility.clients[0]?.promptCalls.length > 0);
	const client = compatibility.clients[0];
	const activity = setInterval(() => {
		client.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "x" } });
	}, 20);
	try {
		// activity keeps going well past the 80ms window; the run must survive it
		await new Promise((resolve) => setTimeout(resolve, 250));
		assert.equal(client.stopCalls, 0, "activity must keep the member running across the window");
		client.completeIdle();
		const result = await run;
		assert.equal(result.details.results?.[0].status, "IDLE");
		assert.equal(client.stopCalls, 0);
		assert.equal(runtime.getState().teams.default.members.reviewer.lastError, undefined);
	} finally {
		clearInterval(activity);
	}
});

test("true inactivity interrupts the member, stops the child, and marks NOT REPLAYED", async () => {
	const compatibility = new FakeCompatibility();
	compatibility.blockIdle = true;
	const dashboard = new FakeDashboard();
	const runtime = new TeamRuntime(compatibility, () => NOW, () => "session-1", () => dashboard, () => 60);
	const run = runtime.execute({ action: "run", member: MEMBER, task: "stuck task", background: false }, context());
	await waitFor(() => compatibility.clients[0]?.promptCalls.length > 0);
	await assert.rejects(run, /Idle timeout: no agent activity/u);
	assert.equal(compatibility.clients[0].stopCalls, 1);
	const state = runtime.getState().teams.default.members.reviewer;
	assert.equal(state.status, "INTERRUPTED");
	assert.match(state.lastError ?? "", /Prompt accepted; not replayed.*Idle timeout/u);
	assert.ok(
		dashboard.views
			.get("default\u0000reviewer")
			?.events.some((event) => event.type === "status" && event.status === "INTERRUPTED · NOT REPLAYED"),
	);
});

test("prompt rejection before acceptance cleans up the settle listener without NOT REPLAYED", async () => {
	const compatibility = new FakeCompatibility();
	compatibility.promptError = new Error("prompt transport failed");
	const runtime = new TeamRuntime(compatibility, () => NOW, () => "session-1", () => new FakeDashboard(), () => 60);
	await assert.rejects(runtime.execute({ action: "run", member: MEMBER, task: "never accepted" }, context()), /prompt transport failed/u);
	const client = compatibility.clients[0];
	assert.equal(client.listeners.size, 0);
	assert.equal(client.stopCalls, 1);
	const state = runtime.getState().teams.default.members.reviewer;
	assert.equal(state.status, "INTERRUPTED");
	assert.doesNotMatch(state.lastError ?? "", /Prompt accepted/u);
});

test("assistant provider failure is surfaced and marks the member errored", async () => {
	const compatibility = new FakeCompatibility();
	compatibility.blockIdle = true;
	const dashboard = new FakeDashboard();
	const runtime = new TeamRuntime(compatibility, () => NOW, () => "session-1", () => dashboard);
	const run = runtime.execute({ action: "run", member: MEMBER, task: "audit", background: false }, context());
	await waitFor(() => compatibility.clients[0]?.promptCalls.length > 0);
	compatibility.clients[0].emit({
		type: "message_end",
		message: { role: "assistant", stopReason: "error", errorMessage: "503: no valid keys" },
	});
	compatibility.clients[0].completeIdle();
	await assert.rejects(run, /503: no valid keys/u);
	assert.equal(compatibility.clients[0].stopCalls, 1);
	const state = runtime.getState().teams.default.members.reviewer;
	assert.equal(state.status, "ERROR");
	assert.match(state.lastError ?? "", /Prompt accepted; not replayed.*503: no valid keys/u);
	assert.ok(dashboard.views.get("default\u0000reviewer")?.events.some((event) => event.type === "status" && event.status === "ERROR · NOT REPLAYED"));
});

test("a successful automatic retry clears the prior assistant error", async () => {
	const compatibility = new FakeCompatibility();
	compatibility.blockIdle = true;
	const dashboard = new FakeDashboard();
	const runtime = new TeamRuntime(compatibility, () => NOW, () => "session-1", () => dashboard);
	const run = runtime.execute({ action: "run", member: MEMBER, task: "audit", background: false }, context());
	await waitFor(() => compatibility.clients[0]?.promptCalls.length > 0);
	const client = compatibility.clients[0];
	client.emit({ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "temporary 503" } });
	client.emit({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "recovered" }] } });
	client.output = "recovered";
	client.completeIdle();
	const result = await run;
	assert.equal(result.details.results?.[0].status, "IDLE");
	assert.equal(result.details.results?.[0].output, "recovered");
	assert.equal(runtime.getState().teams.default.members.reviewer.lastError, undefined);
	assert.equal(client.stopCalls, 0);
});

test("viewer loss does not abort or replay an accepted prompt", async () => {
	const compatibility = new FakeCompatibility();
	compatibility.blockIdle = true;
	const dashboard = new FakeDashboard();
	const runtime = new TeamRuntime(compatibility, () => NOW, () => "session-1", () => dashboard);
	const run = runtime.execute({ action: "run", member: MEMBER, task: "dangerous", background: false }, context());
	await waitFor(() => compatibility.clients[0]?.promptCalls.length > 0);
	dashboard.views.get("default\u0000reviewer")?.lose();
	await new Promise((resolve) => setTimeout(resolve, 10));
	assert.equal(compatibility.clients[0].abortCalls, 0);
	assert.deepEqual(compatibility.clients[0].promptCalls, ["dangerous"]);
	compatibility.clients[0].completeIdle();
	const result = await run;
	assert.equal(result.details.results?.[0].status, "IDLE");
	assert.equal(runtime.getState().teams.default.members.reviewer.lastError, undefined);
});

test("kill removes only its member and shutdown is idempotent without changing UUID history", async () => {
	const compatibility = new FakeCompatibility();
	const dashboard = new FakeDashboard();
	let id = 0;
	const runtime = new TeamRuntime(compatibility, () => NOW, () => `session-${++id}`, () => dashboard);
	const ctx = context();
	await runtime.execute({
		action: "parallel",
		tasks: [
			{ member: MEMBER, task: "one" },
			{ member: { ...MEMBER, id: "scout", role: "Scout" }, task: "two" },
		],
	}, ctx);
	await runtime.execute({ action: "kill", member: { id: "reviewer" } }, ctx);
	assert.deepEqual(dashboard.closeCalls, ["default/reviewer"]);
	assert.equal(dashboard.views.has("default\u0000reviewer"), false);
	assert.equal(dashboard.views.get("default\u0000scout")?.open, true);
	assert.equal(compatibility.clients[0].stopCalls, 1);
	assert.equal(compatibility.clients[1].stopCalls, 0);
	await runtime.shutdown(ctx);
	await runtime.shutdown(ctx);
	assert.equal(dashboard.shutdownCalls, 1);
	const state = runtime.getState();
	assert.equal(state.teams.default.members.reviewer.sessionId, "session-1");
	assert.equal(state.teams.default.members.scout.sessionId, "session-2");
	assert.ok(state.teams.default.members.reviewer.approvedAt);
});

test("non-TUI mode never creates a Web server and kill remains idempotent", async () => {
	const compatibility = new FakeCompatibility();
	let dashboardFactories = 0;
	const runtime = new TeamRuntime(compatibility, () => NOW, () => "session-1", () => {
		dashboardFactories++;
		return new FakeDashboard();
	});
	const ctx = context({ mode: "print" });
	await runtime.execute({ action: "run", member: MEMBER, task: "headless" }, ctx);
	assert.equal(dashboardFactories, 0);
	const status = await runtime.execute({ action: "status", member: { id: "reviewer" } }, ctx);
	assert.match(status.content[0].text, /viewer=UNAVAILABLE/u);
	assert.match(status.details.dashboard?.members["default/reviewer"].note ?? "", /print mode/u);
	await runtime.execute({ action: "kill", member: { id: "reviewer" } }, ctx);
	await runtime.execute({ action: "kill", member: { id: "reviewer" } }, ctx);
	await runtime.shutdown(ctx);
	await runtime.shutdown(ctx);
	assert.ok(compatibility.clients[0].stopCalls >= 1);
});

test("dashboard mirrors runtime state so a page refresh restores task, output, and cumulative usage", async () => {
	let viewer: ConnectedViewer | undefined;
	let dashboardUrl: string | undefined;
	const dashboard = new WebDashboard({
		readHtml: async () => HTML,
		randomToken: () => "a".repeat(64),
		readyTimeoutMs: 2_000,
		heartbeatTimeoutMs: 10_000,
		openBrowser: async (url) => {
			dashboardUrl = url;
			viewer = await connectViewer(url);
		},
	});
	try {
		const handles = await dashboard.prepare([SPECS[0]]);
		const handle = handles.get("default\u0000reviewer")!;
		handle.write({ type: "task", task: "第一轮" });
		handle.write({ type: "assistant_text", delta: "## 结论\n" });
		handle.write({ type: "assistant_text", delta: "- 通过" });
		handle.write({ type: "usage", usage: { input: 100, output: 50, cacheRead: 10, cacheWrite: 5, cost: 0.12, turns: 1 } });
		handle.write({ type: "status", status: "IDLE" });
		handle.write({ type: "task", task: "第二轮" });
		handle.write({ type: "assistant_text", delta: "继续" });
		handle.write({ type: "usage", usage: { input: 200, output: 80, cacheRead: 20, cacheWrite: 8, cost: 0.24, turns: 2, contextWindow: 200000, contextTokens: 84100, contextPercent: 42.05 } });
		handle.write({ type: "error", message: "boom" });

		// simulate a page refresh: drop the old SSE connection and reconnect
		viewer!.controller.abort();
		const url = dashboardUrl!;
		const origin = new URL(url).origin;
		let reconnected: ConnectedViewer | undefined;
		for (let attempt = 0; attempt < 12 && !reconnected; attempt++) {
			const response = await fetch(new URL("events", url), { headers: { Origin: origin } });
			if (response.status === 200) {
				reconnected = { url, origin, controller: new AbortController(), response, reader: response.body!.getReader() };
				await postViewerState(reconnected, "visible");
			} else {
				await new Promise((resolve) => setTimeout(resolve, 250));
			}
		}
		assert.ok(reconnected, "reconnect after refresh should succeed");
		viewer = reconnected;
		const payloads = await readSseUntil(viewer.reader, (found) => found.some((payload) => payload.kind === "bootstrap"));
		const bootstrap = payloads.find((payload) => payload.kind === "bootstrap");
		const state = bootstrap.members[0].state;
		assert.equal(state.task, "第二轮");
		assert.equal(state.assistant, "继续");
		assert.equal(state.usage.input, 300);
		assert.equal(state.usage.output, 130);
		assert.equal(state.usage.turns, 3);
		assert.ok(Math.abs(state.usage.cost - 0.36) < 1e-9);
		// context snapshot survives the refresh (latest usage event carries it)
		assert.equal(state.usage.contextWindow, 200000);
		assert.equal(state.usage.contextTokens, 84100);
		assert.equal(state.usage.contextPercent, 42.05);
		assert.equal(state.status, "IDLE");
		assert.equal(state.assistantStarted, true);
		assert.equal(state.activities.length, 1);
		assert.equal(state.activities[0].label, "运行错误");
	} finally {
		viewer?.controller.abort();
		await dashboard.shutdown();
	}
});

test("run creates the shared workspace, passes it to the member client, and spills oversized output", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pi-agent-team-ws-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const compatibility = new FakeCompatibility();
	const runtime = new TeamRuntime(compatibility);
	const ctx = context({ cwd: dir, mode: "json" });
	const result = await runtime.execute(
		{ action: "run", member: MEMBER, task: "workspace task", background: false },
		ctx,
	);
	const workspace = join(dir, ".pi", "agent-team", "default");

	// (a) minimal workspace contains only the recovery plan and member identity by default
	const plan = await readFile(join(workspace, "leader", "plan.md"), "utf8");
	assert.match(plan, /Mode: ad-hoc/u);
	assert.match(await readFile(join(workspace, "members", "reviewer", "identity.md"), "utf8"), /Reviewer/u);
	await assert.rejects(readFile(join(workspace, "brief.md")), /ENOENT/u);
	await assert.rejects(readFile(join(workspace, "leader", "roster.md")), /ENOENT/u);

	// (b) the workspace path reaches createMemberClient
	assert.deepEqual(compatibility.workspaces, [workspace]);

	// normal output passes through untruncated
	assert.equal((result.details as any).results[0].truncated, false);
	assert.equal((result.details as any).results[0].output, "done");


	// (c) oversized output spills to members/<id>/output.md and the result carries the path
	const big = new FakeCompatibility();
	big.outputFor = "x".repeat(60_000);
	const runtime2 = new TeamRuntime(big);
	const bigCtx = context({ cwd: dir, mode: "json" });
	const bigResult = await runtime2.execute(
		{ action: "run", member: MEMBER, task: "big output", background: false },
		bigCtx,
	);
	const spilled = await readFile(join(workspace, "members", "reviewer", "output.md"), "utf8");
	assert.match(spilled, /^# Output: default\/reviewer/u, "output.md carries the member header");
	assert.ok(spilled.endsWith("x".repeat(60_000) + "\n"), "full output is preserved under the header");
	const bigDetails = bigResult.details as any;
	assert.equal(bigDetails.results[0].truncated, true);
	assert.match(bigDetails.results[0].output, /\[Full output: .*members\/reviewer\/output\.md\]/u);
	assert.ok(
		Buffer.byteLength(bigDetails.results[0].output, "utf8") <= 50 * 1024,
		"result stays within the output budget including the path line",
	);
});

test("background dispatch returns immediately, settles in background, and ignores the main agent signal", async () => {
	const compatibility = new FakeCompatibility();
	compatibility.blockIdle = true;
	const runtime = new TeamRuntime(compatibility, () => NOW, () => "session-1", () => new FakeDashboard(), () => 60_000);
	const ctx = context({ mode: "rpc" });
	const abort = new AbortController();
	const dispatch = await runtime.execute(
		{ action: "run", member: MEMBER, task: "background task", background: true },
		ctx,
		abort.signal,
	);
	const client = compatibility.clients[0];
	await waitFor(() => client.promptCalls.length > 0);
	// the tool returned immediately with a dispatch confirmation, not the final result
	assert.equal(dispatch.details.results?.[0].status, "RUNNING");
	assert.match(dispatch.details.results?.[0].output ?? "", /background/u);
	assert.equal(runtime.getState().teams.default.members.reviewer.status, "RUNNING");
	// ISSUE-01: a later main-agent interrupt must NOT destroy the background member
	abort.abort();
	await new Promise((resolve) => setTimeout(resolve, 10));
	assert.equal(client.abortCalls, 0);
	assert.equal(runtime.getState().teams.default.members.reviewer.status, "RUNNING");
	// the member completes on its own; the result becomes collectable via wait
	client.completeIdle();
	await waitFor(() => runtime.getState().teams.default.members.reviewer.status === "IDLE");
	// the auto report lands after writeMemberOutput, so wait is guaranteed to collect
	await waitFor(() => ctx.messages.length === 1);
	const waited = await runtime.execute({ action: "wait", member: { id: "reviewer" } }, ctx);
	assert.equal(waited.details.results?.[0].status, "IDLE");
	assert.equal(waited.details.results?.[0].output, "done");
	// the active slot was released: the member can be dispatched again
	await runtime.execute({ action: "run", member: { id: "reviewer" }, task: "again" }, ctx);
	assert.equal(client.promptCalls.length, 2);
});

test("wait times out while the member runs and kill is the only interruption for background runs", async () => {
	const compatibility = new FakeCompatibility();
	compatibility.blockIdle = true;
	const runtime = new TeamRuntime(compatibility, () => NOW, () => "session-1", () => new FakeDashboard(), () => 60_000);
	const ctx = context({ mode: "rpc" });
	await runtime.execute({ action: "run", member: MEMBER, task: "slow", background: true }, ctx);
	await waitFor(() => compatibility.clients[0].promptCalls.length > 0);
	const timedOut = await runtime.execute({ action: "wait", member: { id: "reviewer" }, timeout: 50 }, ctx);
	assert.match(timedOut.content[0].text, /RUNNING.*timeout/u);
	assert.equal(timedOut.details.results, undefined);
	// waiting never aborts the member
	assert.equal(compatibility.clients[0].abortCalls, 0);
	// kill ends the background run promptly (its settle wait is cancelled, not hung)
	await runtime.execute({ action: "kill", member: { id: "reviewer" } }, ctx);
	assert.equal(runtime.getState().teams.default.members.reviewer.status, "STOPPED");
	assert.equal(compatibility.clients[0].stopCalls, 1);
	// a wait after kill reports the stopped state without a collected result
	const afterStop = await runtime.execute({ action: "wait", member: { id: "reviewer" } }, ctx);
	assert.match(afterStop.content[0].text, /STOPPED/u);
});

test("set-model switches live model and thinking and keeps configHash consistent", async () => {
	const compatibility = new FakeCompatibility();
	const dashboard = new FakeDashboard();
	const runtime = new TeamRuntime(compatibility, () => NOW, () => "session-1", () => dashboard);
	const ctx = context({ mode: "tui" });
	await runtime.execute({ action: "run", member: MEMBER, task: "warm up" }, ctx);
	const result = await runtime.execute({ action: "set-model", member: { id: "reviewer", model: "test/other", thinking: "high" } }, ctx);
	assert.match(result.content[0].text, /test\/model -> test\/other; thinking medium -> high/u);
	const member = runtime.getState().teams.default.members.reviewer;
	assert.deepEqual(member.model, { provider: "test", id: "other" });
	assert.equal(member.thinking, "high");
	assert.equal(member.configHash, configHash(member));
	assert.doesNotThrow(() => migrateState(runtime.getState()));
	assert.deepEqual(compatibility.clients[0].setModelCalls, [{ provider: "test", modelId: "other" }]);
	assert.deepEqual(compatibility.clients[0].setThinkingLevelCalls, ["high"]);
	assert.deepEqual(dashboard.updateCalls.map((call) => [call.spec.model, call.spec.thinking]), [["test/other", "high"]]);
	// Without a live client, both fields persist for the next run.
	await runtime.execute({ action: "kill", member: { id: "reviewer" } }, ctx);
	await runtime.execute({ action: "set-model", member: { id: "reviewer", model: "test/third", thinking: "low" } }, ctx);
	assert.deepEqual(runtime.getState().teams.default.members.reviewer.model, { provider: "test", id: "third" });
	assert.equal(runtime.getState().teams.default.members.reviewer.thinking, "low");
	// Invalid model strings and extra config fields are rejected.
	await assert.rejects(
		runtime.execute({ action: "set-model", member: { id: "reviewer", model: "nope" } }, ctx),
		/provider\/model/u,
	);
	await assert.rejects(
		runtime.execute({ action: "set-model", member: { id: "reviewer", model: "test/x", tools: ["read"] } }, ctx),
		/member id, model, and optional thinking only/u,
	);
});

test("wait/set-model request validation and background flag rules", () => {
	const state = stateWithMembers({ reviewer: existingMember() });
	// wait accepts member id only; timeout is allowed
	validateToolRequest({ action: "wait", member: { id: "reviewer" }, timeout: 5_000 }, state);
	assert.throws(() => validateToolRequest({ action: "wait", member: { id: "reviewer" }, task: "x" }, state), /forbids/u);
	assert.throws(() => validateToolRequest({ action: "wait", member: { id: "nobody" } }, state), /Unknown member/u);
	assert.throws(
		() => validateToolRequest({ action: "wait", member: { id: "reviewer", model: "a/b" } }, state),
		/id only/u,
	);
	// set-model requires an existing member plus a model, accepts optional thinking, and nothing else
	validateToolRequest({ action: "set-model", member: { id: "reviewer", model: "test/other" } }, state);
	validateToolRequest({ action: "set-model", member: { id: "reviewer", model: "test/other", thinking: "max" } }, state);
	assert.throws(
		() => validateToolRequest({ action: "set-model", member: { id: "reviewer", model: "test/other", thinking: "turbo" as any } }, state),
		/thinking must be one of/u,
	);
	assert.throws(
		() => validateToolRequest({ action: "set-model", member: { id: "reviewer" } }, state),
		/requires member with model/u,
	);
	assert.throws(
		() => validateToolRequest({ action: "set-model", member: { id: "nobody", model: "a/b" } }, state),
		/Unknown member/u,
	);
	assert.throws(
		() => validateToolRequest({ action: "set-model", member: { id: "reviewer", model: "a/b", role: "x" } }, state),
		/id, model, and optional thinking only/u,
	);
	// background is only meaningful for run/parallel
	assert.throws(
		() => validateToolRequest({ action: "status", member: { id: "reviewer" }, background: true }, state),
		/forbids/u,
	);
	assert.throws(
		() => validateToolRequest({ action: "wait", member: { id: "reviewer" }, background: true }, state),
		/forbids/u,
	);
	assert.throws(
		() => validateToolRequest({ action: "kill", member: { id: "reviewer" }, timeout: 5 }, state),
		/forbids/u,
	);
	// run accepts the background flag
	validateToolRequest({ action: "run", member: MEMBER, task: "x", background: true }, emptyState(NOW));
});

test("wait aborted by the main agent signal gives up without interrupting the member", async () => {
	const compatibility = new FakeCompatibility();
	compatibility.blockIdle = true;
	const runtime = new TeamRuntime(compatibility, () => NOW, () => "session-1", () => new FakeDashboard(), () => 60_000);
	const ctx = context({ mode: "rpc" });
	await runtime.execute({ action: "run", member: MEMBER, task: "slow", background: true }, ctx);
	await waitFor(() => compatibility.clients[0].promptCalls.length > 0);
	const abort = new AbortController();
	const waiting = runtime.execute({ action: "wait", member: { id: "reviewer" }, timeout: 60_000 }, ctx, abort.signal);
	await new Promise((resolve) => setTimeout(resolve, 10));
	abort.abort();
	const result = await waiting;
	assert.match(result.content[0].text, /aborted/u);
	// the member keeps running untouched
	assert.equal(compatibility.clients[0].abortCalls, 0);
	assert.equal(runtime.getState().teams.default.members.reviewer.status, "RUNNING");
	compatibility.clients[0].completeIdle();
	await waitFor(() => runtime.getState().teams.default.members.reviewer.status === "IDLE");
	// the auto report (and its collectable result) lands before wait is consulted
	await waitFor(() => ctx.messages.length === 1);
	const collected = await runtime.execute({ action: "wait", member: { id: "reviewer" } }, ctx);
	assert.equal(collected.details.results?.[0].output, "done");
});

// ---------------------------------------------------------------------------
// Round 1 regression probes. Each test pins an intended behavior; the former
// [EXPECTED-FAIL] markers were removed once the implementation fixed the defect.
// ---------------------------------------------------------------------------

test("TUI and UI-capable RPC prepare the dashboard; json/print never open a browser or build a server", async (t) => {
	for (const mode of ["tui", "rpc"] as const) {
		await t.test(`mode ${mode} with hasUI prepares the dashboard`, async () => {
			const compatibility = new FakeCompatibility();
			const dashboard = new FakeDashboard();
			const runtime = new TeamRuntime(compatibility, () => NOW, () => "session-1", () => dashboard);
			await runtime.execute({ action: "run", member: MEMBER, task: "dashboard task" }, context({ mode, hasUI: true }));
			assert.equal(dashboard.prepareCalls.length, 1);
			assert.deepEqual(dashboard.prepareCalls[0].map((member) => member.id), ["reviewer"]);
			assert.equal(compatibility.createCalls, 1);
		});
	}
	for (const mode of ["json", "print"] as const) {
		await t.test(`mode ${mode} never opens a browser`, async () => {
			const compatibility = new FakeCompatibility();
			let browserCalls = 0;
			const runtime = new TeamRuntime(
				compatibility,
				() => NOW,
				() => "session-1",
				() => new WebDashboard({ readHtml: async () => HTML, readyTimeoutMs: 200, openBrowser: async () => { browserCalls++; } }),
			);
			await runtime.execute({ action: "run", member: MEMBER, task: "headless task" }, context({ mode }));
			assert.equal(browserCalls, 0);
			assert.equal(compatibility.createCalls, 1);
		});
	}
});

test("no child client or prompt is created before the dashboard viewer becomes VISIBLE", async () => {
	const compatibility = new FakeCompatibility();
	const runtime = new TeamRuntime(
		compatibility,
		() => NOW,
		() => "session-1",
		() => new WebDashboard({ readHtml: async () => HTML, readyTimeoutMs: 60, openBrowser: async () => { /* never handshake */ } }),
	);
	await assert.rejects(
		runtime.execute({ action: "run", member: MEMBER, task: "viewer-gated task" }, context()),
		/DASHBOARD_UNAVAILABLE/u,
	);
	assert.equal(compatibility.createCalls, 0);
	assert.equal(compatibility.clients.length, 0);
});

test("a fully closed SSE viewer reopens the same runtime URL and re-handshakes on the next prepare", async () => {
	const urls: string[] = [];
	let viewer: ConnectedViewer | undefined;
	const dashboard = new WebDashboard({
		readHtml: async () => HTML,
		readyTimeoutMs: 400,
		heartbeatTimeoutMs: 10_000,
		openBrowser: async (url) => {
			urls.push(url);
			viewer = await connectViewer(url);
		},
	});
	try {
		const handles = await dashboard.prepare(SPECS);
		viewer!.controller.abort();
		await waitFor(() => dashboard.status("default", "reviewer", "tui").visibility === "DETACHED");
		assert.ok([...handles.values()].every((handle) => handle.isOpen()));
		// the viewer is truly gone: the next prepare must reopen the SAME runtime URL
		const reopened = await dashboard.prepare([SPECS[0]]);
		assert.equal(urls.length, 2, "closed viewer => prepare must reopen the browser");
		assert.equal(urls[1], urls[0], "reopen must reuse the same runtime URL");
		assert.equal(reopened.get("default\u0000reviewer"), handles.get("default\u0000reviewer"));
		assert.equal(dashboard.status("default", "reviewer", "tui").visibility, "VISIBLE");
	} finally {
		viewer?.controller.abort();
		await dashboard.shutdown();
	}
});

test("a failed browser launch rolls back and a later prepare retries successfully", async () => {
	let attempts = 0;
	const dashboard = new WebDashboard({
		readHtml: async () => HTML,
		readyTimeoutMs: 2_000,
		heartbeatTimeoutMs: 10_000,
		openBrowser: async (url) => {
			attempts++;
			if (attempts === 1) throw new Error("browser unavailable");
			await connectViewer(url);
		},
	});
	try {
		await assert.rejects(dashboard.prepare([SPECS[0]]), /DASHBOARD_UNAVAILABLE/u);
		const handles = await dashboard.prepare([SPECS[0]]);
		assert.equal(attempts, 2);
		assert.equal(handles.get("default\u0000reviewer")!.isOpen(), true);
		assert.equal(dashboard.status("default", "reviewer", "tui").visibility, "VISIBLE");
	} finally {
		await dashboard.shutdown();
	}
});

test("a failed browser relaunch after viewer loss cleans up and a later prepare retries", async () => {
	let attempts = 0;
	let viewer: ConnectedViewer | undefined;
	const dashboard = new WebDashboard({
		readHtml: async () => HTML,
		readyTimeoutMs: 400,
		heartbeatTimeoutMs: 10_000,
		openBrowser: async (url) => {
			attempts++;
			if (attempts === 1) viewer = await connectViewer(url);
			else if (attempts === 2) throw new Error("browser relaunch failed");
			else await connectViewer(url);
		},
	});
	try {
		const handles = await dashboard.prepare([SPECS[0]]);
		viewer!.controller.abort();
		await waitFor(() => dashboard.status("default", "reviewer", "tui").visibility === "DETACHED");
		await assert.rejects(dashboard.prepare([SPECS[0]]), /DASHBOARD_UNAVAILABLE/u);
		const retried = await dashboard.prepare([SPECS[0]]);
		assert.equal(attempts, 3);
		assert.equal(retried.get("default\u0000reviewer"), handles.get("default\u0000reviewer"));
		assert.equal(dashboard.status("default", "reviewer", "tui").visibility, "VISIBLE");
	} finally {
		viewer?.controller.abort();
		await dashboard.shutdown();
	}
});

test("run without an explicit background flag dispatches immediately as RUNNING", async () => {
	const compatibility = new FakeCompatibility();
	const runtime = new TeamRuntime(compatibility, () => NOW, () => "session-1", () => new FakeDashboard(), () => 60_000);
	const dispatch = await runtime.execute({ action: "run", member: MEMBER, task: "async task" }, context({ mode: "rpc" }));
	assert.equal(dispatch.details.results?.[0].status, "RUNNING");
	assert.equal(runtime.getState().teams.default.members.reviewer.status, "RUNNING");
});

test("parallel without an explicit background flag dispatches immediately as RUNNING", async () => {
	const compatibility = new FakeCompatibility();
	let id = 0;
	const runtime = new TeamRuntime(compatibility, () => NOW, () => `session-${++id}`, () => new FakeDashboard(), () => 60_000);
	const dispatch = await runtime.execute(
		{
			action: "parallel",
			tasks: [
				{ member: MEMBER, task: "one" },
				{ member: { ...MEMBER, id: "scout", role: "Scout" }, task: "two" },
			],
		},
		context({ mode: "rpc" }),
	);
	assert.ok(dispatch.details.results?.every((result) => result.status === "RUNNING"));
});

test("explicit background:false runs synchronously to a settled result", async () => {
	const compatibility = new FakeCompatibility();
	const runtime = new TeamRuntime(compatibility, () => NOW, () => "session-1", () => new FakeDashboard(), () => 60_000);
	const result = await runtime.execute(
		{ action: "run", member: MEMBER, task: "sync task", background: false },
		context({ mode: "rpc" }),
	);
	assert.equal(result.details.results?.[0].status, "IDLE");
});

test("new members inherit the parent model when model is omitted and explicit models are not overwritten", async () => {
	const compatibility = new FakeCompatibility();
	const runtime = new TeamRuntime(compatibility, () => NOW, () => "session-1", () => new FakeDashboard());
	const ctx = context({ mode: "rpc" }); // parent model = { provider: "test", id: "model" }
	await runtime.execute(
		{ action: "run", member: { id: "inheritor", role: "Scout", instructions: "Inherit the model." }, task: "inherited model" },
		ctx,
	);
	assert.deepEqual(runtime.getState().teams.default.members.inheritor.model, { provider: "test", id: "model" });
	await runtime.execute(
		{ action: "run", member: { ...MEMBER, id: "scout", role: "Scout", model: "other/provider" }, task: "explicit model" },
		ctx,
	);
	assert.deepEqual(runtime.getState().teams.default.members.scout.model, { provider: "other", id: "provider" });
});

test("a child whose reported model mismatches the member config fails explicitly", async () => {
	const compatibility = new FakeCompatibility();
	compatibility.stateModel = "rogue/other";
	const runtime = new TeamRuntime(compatibility, () => NOW, () => "session-1", () => new FakeDashboard());
	await assert.rejects(
		runtime.execute({ action: "run", member: MEMBER, task: "model audit" }, context({ mode: "rpc" })),
		/mismatch/i,
	);
	const member = runtime.getState().teams.default.members.reviewer;
	assert.equal(member.status, "ERROR");
	assert.match(member.lastError ?? "", /mismatch/i);
});

test("legacy brief, roster, and notes are neither read nor overwritten nor deleted", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pi-agent-team-legacy-files-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const compatibility = new FakeCompatibility();
	const runtime = new TeamRuntime(compatibility, () => NOW, () => "session-1", () => new FakeDashboard());
	const ctx = context({ cwd: dir, mode: "rpc" });
	await runtime.execute({ action: "run", member: MEMBER, task: "round one" }, ctx);
	const workspace = join(dir, ".pi", "agent-team", "default");
	await mkdir(join(workspace, "notes"), { recursive: true });
	await writeFile(join(workspace, "brief.md"), "legacy brief\n", "utf8");
	await writeFile(join(workspace, "leader", "roster.md"), "legacy roster\n", "utf8");
	await writeFile(join(workspace, "notes", "user.md"), "legacy note\n", "utf8");
	await runtime.execute({ action: "run", member: { id: "reviewer" }, task: "round two" }, ctx);
	assert.equal(await readFile(join(workspace, "brief.md"), "utf8"), "legacy brief\n");
	assert.equal(await readFile(join(workspace, "leader", "roster.md"), "utf8"), "legacy roster\n");
	assert.equal(await readFile(join(workspace, "notes", "user.md"), "utf8"), "legacy note\n");
});

test("wait never returns a stale background result from a previous round", async () => {
	const compatibility = new FakeCompatibility();
	compatibility.blockIdle = true;
	compatibility.outputFor = "first round";
	const runtime = new TeamRuntime(compatibility, () => NOW, () => "session-1", () => new FakeDashboard(), () => 60_000);
	const ctx = context({ mode: "rpc" });
	await runtime.execute({ action: "run", member: MEMBER, task: "round one", background: true }, ctx);
	const client = compatibility.clients[0];
	await waitFor(() => client.promptCalls.length > 0);
	client.completeIdle();
	await waitFor(() => runtime.getState().teams.default.members.reviewer.status === "IDLE");
	// second round on the same member: still running when wait is called
	client.output = "second round";
	client.blockUntilIdle();
	await runtime.execute({ action: "run", member: { id: "reviewer" }, task: "round two", background: true }, ctx);
	await waitFor(() => client.promptCalls.length === 2);
	assert.equal(runtime.getState().teams.default.members.reviewer.status, "RUNNING");
	const waited = await runtime.execute({ action: "wait", member: { id: "reviewer" }, timeout: 300 }, ctx);
	assert.notEqual(waited.details.results?.[0]?.output, "first round", "wait returned the previous round's result");
	assert.equal(runtime.getState().teams.default.members.reviewer.status, "RUNNING");
	client.completeIdle();
	await waitFor(() => runtime.getState().teams.default.members.reviewer.status === "IDLE");
});

test("repeated waits do not leak event listeners on the child client", async () => {
	const compatibility = new FakeCompatibility();
	compatibility.blockIdle = true;
	const runtime = new TeamRuntime(compatibility, () => NOW, () => "session-1", () => new FakeDashboard(), () => 60_000);
	const ctx = context({ mode: "rpc" });
	await runtime.execute({ action: "run", member: MEMBER, task: "slow", background: true }, ctx);
	const client = compatibility.clients[0];
	await waitFor(() => client.promptCalls.length > 0);
	const baseline = client.listeners.size;
	for (let i = 0; i < 3; i++) {
		await runtime.execute({ action: "wait", member: { id: "reviewer" }, timeout: 60 }, ctx);
	}
	assert.equal(client.listeners.size, baseline, "waits must unsubscribe their polling listeners");
	client.completeIdle();
});

test("a wait issued with an already-aborted signal returns aborted immediately", async () => {
	const compatibility = new FakeCompatibility();
	compatibility.blockIdle = true;
	const runtime = new TeamRuntime(compatibility, () => NOW, () => "session-1", () => new FakeDashboard(), () => 60_000);
	const ctx = context({ mode: "rpc" });
	await runtime.execute({ action: "run", member: MEMBER, task: "slow", background: true }, ctx);
	const client = compatibility.clients[0];
	await waitFor(() => client.promptCalls.length > 0);
	const abort = new AbortController();
	abort.abort();
	const result = await runtime.execute(
		{ action: "wait", member: { id: "reviewer" }, timeout: 150 },
		ctx,
		abort.signal,
	);
	assert.match(result.content[0].text, /aborted/u);
	assert.equal(client.abortCalls, 0);
	assert.equal(runtime.getState().teams.default.members.reviewer.status, "RUNNING");
	client.completeIdle();
});

test("kill racing background settlement leaves no resurrected collectable result", async () => {
	const compatibility = new FakeCompatibility();
	compatibility.blockIdle = true;
	const runtime = new TeamRuntime(compatibility, () => NOW, () => "session-1", () => new FakeDashboard(), () => 60_000);
	const ctx = context({ mode: "rpc" });
	await runtime.execute({ action: "run", member: MEMBER, task: "slow", background: true }, ctx);
	const client = compatibility.clients[0];
	await waitFor(() => client.promptCalls.length > 0);
	const killing = runtime.execute({ action: "kill", member: { id: "reviewer" } }, ctx);
	client.completeIdle();
	await killing;
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(runtime.getState().teams.default.members.reviewer.status, "STOPPED");
	const waited = await runtime.execute({ action: "wait", member: { id: "reviewer" } }, ctx);
	assert.equal(waited.details.results, undefined, "stopped members must not expose a stale collectable result");
});

test("shutdown during a background run leaves no resurrected result and ends STOPPED", async () => {
	const compatibility = new FakeCompatibility();
	compatibility.blockIdle = true;
	const runtime = new TeamRuntime(compatibility, () => NOW, () => "session-1", () => new FakeDashboard(), () => 60_000);
	const ctx = context({ mode: "rpc" });
	await runtime.execute({ action: "run", member: MEMBER, task: "slow", background: true }, ctx);
	const client = compatibility.clients[0];
	await waitFor(() => client.promptCalls.length > 0);
	await runtime.shutdown(ctx);
	client.completeIdle();
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(runtime.getState().teams.default.members.reviewer.status, "STOPPED");
	const waited = await runtime.execute({ action: "wait", member: { id: "reviewer" } }, ctx);
	assert.equal(waited.details.results, undefined, "shutdown must not leave a stale collectable background result");
});

// ---------------------------------------------------------------------------
// Round 2 regression probes: detached Dashboard event flow, final-text
// calibration, listener/active-slot ownership, and the S2-7 output baseline.
// ---------------------------------------------------------------------------

test("a detached dispatch keeps the RPC-to-Dashboard listener alive so streaming reaches the page", async () => {
	const compatibility = new FakeCompatibility();
	compatibility.blockIdle = true;
	const dashboard = new FakeDashboard();
	const runtime = new TeamRuntime(compatibility, () => NOW, () => "session-1", () => dashboard, () => 60_000);
	const ctx = context({ mode: "rpc" });
	const dispatch = await runtime.execute({ action: "run", member: MEMBER, task: "streamy" }, ctx);
	assert.equal(dispatch.details.results?.[0].status, "RUNNING");
	const client = compatibility.clients[0];
	await waitFor(() => client.promptCalls.length > 0);
	// the tool has returned; the listener must still be attached (ownership moved
	// to background finalization) so the Dashboard keeps receiving streaming text
	assert.ok(client.listeners.size > 0, "RPC-to-Dashboard listener must survive the dispatch return");
	client.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "streamed text" } });
	const view = dashboard.views.get("default\u0000reviewer");
	assert.ok(view?.events.some((event) => event.type === "assistant_text" && event.delta === "streamed text"));
	client.completeIdle();
	await waitFor(() => runtime.getState().teams.default.members.reviewer.status === "IDLE");
	// after settlement the listener is released: no leak on the child client
	assert.equal(client.listeners.size, 0);
});

test("the Dashboard final text is calibrated to exactly what wait returns", async () => {
	const compatibility = new FakeCompatibility();
	compatibility.blockIdle = true;
	compatibility.outputFor = "最终报告：全部通过";
	const dashboard = new FakeDashboard();
	const runtime = new TeamRuntime(compatibility, () => NOW, () => "session-1", () => dashboard, () => 60_000);
	const ctx = context({ mode: "rpc" });
	await runtime.execute({ action: "run", member: MEMBER, task: "report" }, ctx);
	const client = compatibility.clients[0];
	await waitFor(() => client.promptCalls.length > 0);
	client.completeIdle();
	await waitFor(() => runtime.getState().teams.default.members.reviewer.status === "IDLE");
	// the collectable result (and its auto report) lands after writeMemberOutput
	await waitFor(() => ctx.messages.length === 1);
	const waited = await runtime.execute({ action: "wait", member: { id: "reviewer" } }, ctx);
	const result = waited.details.results?.[0];
	assert.ok(result, "wait must collect the settled result");
	assert.equal(result.output, "最终报告：全部通过");
	// the runtime calibrated the Dashboard mirror with the exact same final text
	const finalEvent = dashboard.views
		.get("default\u0000reviewer")
		?.events.find((event) => event.type === "assistant_final");
	assert.ok(finalEvent, "settleAndFinish must emit an assistant_final calibration event");
	assert.equal(finalEvent.type === "assistant_final" ? finalEvent.text : undefined, result.output);
});

test("a detached dispatch whose prompt fails releases the active slot and its listeners", async () => {
	const compatibility = new FakeCompatibility();
	compatibility.promptError = new Error("prompt transport failed");
	const runtime = new TeamRuntime(compatibility, () => NOW, () => "session-1", () => new FakeDashboard(), () => 60_000);
	const ctx = context({ mode: "rpc" });
	await assert.rejects(
		runtime.execute({ action: "run", member: MEMBER, task: "never accepted" }, ctx),
		/prompt transport failed/u,
	);
	const failed = compatibility.clients[0];
	assert.equal(failed.listeners.size, 0, "failed detached dispatch must not leak listeners");
	assert.equal(failed.stopCalls, 1);
	// the active slot was released: the same member can be dispatched again
	compatibility.promptError = undefined;
	const retry = await runtime.execute({ action: "run", member: { id: "reviewer" }, task: "again" }, ctx);
	assert.equal(retry.details.results?.[0].status, "RUNNING");
	assert.equal(compatibility.clients.length, 2);
});

test("a quiet round never misreports the previous round's assistant text", async () => {
	const compatibility = new FakeCompatibility();
	compatibility.blockIdle = true;
	compatibility.outputFor = "first round text";
	const runtime = new TeamRuntime(compatibility, () => NOW, () => "session-1", () => new FakeDashboard(), () => 60_000);
	const ctx = context({ mode: "rpc" });
	// first round produces text
	await runtime.execute({ action: "run", member: MEMBER, task: "round one", background: true }, ctx);
	const client = compatibility.clients[0];
	await waitFor(() => client.promptCalls.length > 0);
	client.completeIdle();
	await waitFor(() => runtime.getState().teams.default.members.reviewer.status === "IDLE");
	// second round settles with no new assistant text: the runtime must not
	// report the previous round's text as this round's output (S2-7 baseline)
	client.blockUntilIdle();
	await runtime.execute({ action: "run", member: { id: "reviewer" }, task: "round two", background: true }, ctx);
	await waitFor(() => client.promptCalls.length === 2);
	client.completeIdle();
	await waitFor(() => runtime.getState().teams.default.members.reviewer.status === "IDLE");
	const waited = await runtime.execute({ action: "wait", member: { id: "reviewer" } }, ctx);
	assert.notEqual(waited.details.results?.[0]?.output, "first round text");
});

// ---------------------------------------------------------------------------
// Round 3 regression probes: detached completion auto-reports to the main Pi
// via the parent-session message channel (pi.sendMessage followUp + triggerTurn).
// ---------------------------------------------------------------------------

test("a background success reports itself to the main Pi exactly once with the final output", async () => {
	const compatibility = new FakeCompatibility();
	compatibility.blockIdle = true;
	compatibility.outputFor = "final report: all green";
	const runtime = new TeamRuntime(compatibility, () => NOW, () => "session-1", () => new FakeDashboard(), () => 60_000);
	const ctx = context({ mode: "rpc" });
	await runtime.execute({ action: "run", member: MEMBER, task: "report", background: true }, ctx);
	const client = compatibility.clients[0];
	await waitFor(() => client.promptCalls.length > 0);
	client.completeIdle();
	await waitFor(() => runtime.getState().teams.default.members.reviewer.status === "IDLE");
	// exactly one completion message, carrying team/member, status, and final output
	await waitFor(() => ctx.messages.length === 1);
	const sent = ctx.messages[0];
	assert.equal(sent.message.customType, "agent-team-completion");
	assert.equal(sent.message.display, true);
	assert.match(sent.message.content, /default\/reviewer/u);
	assert.match(sent.message.content, /IDLE/u);
	assert.match(sent.message.content, /final report: all green/u);
	assert.equal(sent.options?.triggerTurn, true);
	assert.equal(sent.options?.deliverAs, "followUp");
	// the auto report never replaces the collectable result: wait still returns it
	const waited = await runtime.execute({ action: "wait", member: { id: "reviewer" } }, ctx);
	assert.equal(waited.details.results?.[0].status, "IDLE");
	assert.equal(waited.details.results?.[0].output, "final report: all green");
});

test("an async provider failure reports ERROR with the error text to the main Pi", async () => {
	const compatibility = new FakeCompatibility();
	compatibility.blockIdle = true;
	const runtime = new TeamRuntime(compatibility, () => NOW, () => "session-1", () => new FakeDashboard(), () => 60_000);
	const ctx = context({ mode: "rpc" });
	await runtime.execute({ action: "run", member: MEMBER, task: "audit", background: true }, ctx);
	const client = compatibility.clients[0];
	await waitFor(() => client.promptCalls.length > 0);
	client.emit({ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "503: no valid keys" } });
	client.completeIdle();
	await waitFor(() => runtime.getState().teams.default.members.reviewer.status === "ERROR");
	assert.equal(ctx.messages.length, 1);
	assert.equal(ctx.messages[0].message.customType, "agent-team-completion");
	assert.match(ctx.messages[0].message.content, /default\/reviewer/u);
	assert.match(ctx.messages[0].message.content, /ERROR/u);
	assert.match(ctx.messages[0].message.content, /503: no valid keys/u);
});

test("an async idle-timeout failure reports INTERRUPTED to the main Pi", async () => {
	const compatibility = new FakeCompatibility();
	compatibility.blockIdle = true;
	const runtime = new TeamRuntime(compatibility, () => NOW, () => "session-1", () => new FakeDashboard(), () => 50);
	const ctx = context({ mode: "rpc" });
	await runtime.execute({ action: "run", member: MEMBER, task: "stuck", background: true }, ctx);
	await waitFor(() => compatibility.clients[0].promptCalls.length > 0);
	await waitFor(() => runtime.getState().teams.default.members.reviewer.status === "INTERRUPTED");
	await waitFor(() => ctx.messages.length === 1);
	assert.match(ctx.messages[0].message.content, /INTERRUPTED/u);
	assert.match(ctx.messages[0].message.content, /Idle timeout/u);
});

test("an explicit synchronous run reports only through the tool result, never an auto parent message", async () => {
	const compatibility = new FakeCompatibility();
	const runtime = new TeamRuntime(compatibility, () => NOW, () => "session-1", () => new FakeDashboard(), () => 60_000);
	const ctx = context({ mode: "rpc" });
	const result = await runtime.execute({ action: "run", member: MEMBER, task: "sync", background: false }, ctx);
	assert.equal(result.details.results?.[0].status, "IDLE");
	assert.equal(ctx.messages.length, 0, "synchronous runs must not emit an auto completion message");
});

test("kill racing a background settle never sends a completion report", async () => {
	const compatibility = new FakeCompatibility();
	compatibility.blockIdle = true;
	const runtime = new TeamRuntime(compatibility, () => NOW, () => "session-1", () => new FakeDashboard(), () => 60_000);
	const ctx = context({ mode: "rpc" });
	await runtime.execute({ action: "run", member: MEMBER, task: "slow", background: true }, ctx);
	const client = compatibility.clients[0];
	await waitFor(() => client.promptCalls.length > 0);
	const killing = runtime.execute({ action: "kill", member: { id: "reviewer" } }, ctx);
	client.completeIdle();
	await killing;
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(runtime.getState().teams.default.members.reviewer.status, "STOPPED");
	assert.equal(ctx.messages.length, 0, "a stopped member must not be reported as completed");
});

test("shutdown during a background run never sends a completion report", async () => {
	const compatibility = new FakeCompatibility();
	compatibility.blockIdle = true;
	const runtime = new TeamRuntime(compatibility, () => NOW, () => "session-1", () => new FakeDashboard(), () => 60_000);
	const ctx = context({ mode: "rpc" });
	await runtime.execute({ action: "run", member: MEMBER, task: "slow", background: true }, ctx);
	const client = compatibility.clients[0];
	await waitFor(() => client.promptCalls.length > 0);
	await runtime.shutdown(ctx);
	client.completeIdle();
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(runtime.getState().teams.default.members.reviewer.status, "STOPPED");
	assert.equal(ctx.messages.length, 0, "shutdown must not emit a completion report");
});

test("parallel members each report their own completion without overwriting each other", async () => {
	const compatibility = new FakeCompatibility();
	compatibility.blockIdle = true;
	const runtime = new TeamRuntime(compatibility, () => NOW, () => "session-1", () => new FakeDashboard(), () => 60_000);
	const ctx = context({ mode: "rpc" });
	await runtime.execute(
		{
			action: "parallel",
			tasks: [
				{ member: MEMBER, task: "one" },
				{ member: { ...MEMBER, id: "scout", role: "Scout" }, task: "two" },
			],
		},
		ctx,
	);
	await waitFor(() => compatibility.clients.length === 2);
	compatibility.clients.forEach((client) => client.completeIdle());
	await waitFor(
		() =>
			runtime.getState().teams.default.members.reviewer.status === "IDLE" &&
			runtime.getState().teams.default.members.scout.status === "IDLE",
	);
	await waitFor(() => ctx.messages.length === 2);
	const texts = ctx.messages.map((entry) => entry.message.content);
	assert.ok(texts.some((text) => /default\/reviewer/u.test(text)), "reviewer report missing");
	assert.ok(texts.some((text) => /default\/scout/u.test(text)), "scout report missing");
});

// ---------------------------------------------------------------------------
// Round 4 regression probes: soft stop (Esc semantics) vs kill, set-model
// registry validation + child verification, and the shared workspace contract
// (identity.md / on-demand output.md / minimal leader plan.md).
// ---------------------------------------------------------------------------

test("stop softly interrupts a running member and reuses the same client on the next run", async () => {
	const compatibility = new FakeCompatibility();
	compatibility.blockIdle = true;
	const dashboard = new FakeDashboard();
	const runtime = new TeamRuntime(compatibility, () => NOW, () => "session-1", () => dashboard, () => 60_000);
	const ctx = context({ mode: "rpc" });
	await runtime.execute({ action: "run", member: MEMBER, task: "slow", background: true }, ctx);
	const client = compatibility.clients[0];
	await waitFor(() => client.promptCalls.length > 0);
	await runtime.execute({ action: "stop", member: { id: "reviewer" } }, ctx);
	const member = runtime.getState().teams.default.members.reviewer;
	assert.equal(client.abortCalls, 1, "stop aborts the live prompt");
	assert.equal(client.stopCalls, 0, "soft stop keeps the child client");
	assert.equal(dashboard.closeCalls.length, 0, "soft stop never closes the Dashboard view");
	assert.equal(dashboard.views.get("default\u0000reviewer")?.open, true);
	assert.equal(member.status, "INTERRUPTED");
	assert.equal(member.sessionId, "session-1", "session is preserved across a soft stop");
	// the active slot was released: the same client runs a fresh task, no replay
	await runtime.execute({ action: "run", member: { id: "reviewer" }, task: "fresh" }, ctx);
	assert.equal(compatibility.clients.length, 1, "the same child client is reused");
	assert.deepEqual(client.promptCalls, ["slow", "fresh"], "the interrupted task is never replayed");
	client.completeIdle();
	await waitFor(() => runtime.getState().teams.default.members.reviewer.status === "IDLE");
});

test("stop falls back to a hard stop when abort fails", async () => {
	const compatibility = new FakeCompatibility();
	compatibility.blockIdle = true;
	const runtime = new TeamRuntime(compatibility, () => NOW, () => "session-1", () => new FakeDashboard(), () => 60_000);
	const ctx = context({ mode: "rpc" });
	await runtime.execute({ action: "run", member: MEMBER, task: "slow", background: true }, ctx);
	const client = compatibility.clients[0];
	await waitFor(() => client.promptCalls.length > 0);
	client.abortError = new Error("abort transport failed");
	await runtime.execute({ action: "stop", member: { id: "reviewer" } }, ctx);
	await waitFor(() => client.stopCalls === 1);
	const member = runtime.getState().teams.default.members.reviewer;
	assert.equal(member.status, "INTERRUPTED");
	assert.match(member.lastError ?? "", /Stop abort failed/u);
	// the unusable client was dropped: the next run creates a fresh one
	await runtime.execute({ action: "run", member: { id: "reviewer" }, task: "after fallback" }, ctx);
	assert.equal(compatibility.clients.length, 2, "the failed client is replaced on the next run");
});

test("stop with no live run is a no-op that keeps the member state", async () => {
	const compatibility = new FakeCompatibility();
	const runtime = new TeamRuntime(compatibility, () => NOW, () => "session-1", () => new FakeDashboard(), () => 60_000);
	const ctx = context({ mode: "rpc" });
	await runtime.execute({ action: "run", member: MEMBER, task: "sync", background: true }, ctx);
	const client = compatibility.clients[0];
	await waitFor(() => runtime.getState().teams.default.members.reviewer.status === "IDLE");
	// wait for full finalization (auto report fires after the run control is released)
	await waitFor(() => ctx.messages.length === 1);
	await runtime.execute({ action: "stop", member: { id: "reviewer" } }, ctx);
	assert.equal(runtime.getState().teams.default.members.reviewer.status, "IDLE", "no live run: status unchanged");
	assert.equal(client.abortCalls, 0);
	assert.equal(client.stopCalls, 0);
});

test("stop/kill validation accepts only member id and rejects unknown members and extra fields", () => {
	const state = stateWithMembers({ reviewer: existingMember() });
	validateToolRequest({ action: "stop", member: { id: "reviewer" } }, state);
	validateToolRequest({ action: "kill", member: { id: "reviewer" } }, state);
	assert.throws(() => validateToolRequest({ action: "stop", member: { id: "nobody" } }, state), /Unknown member/u);
	assert.throws(() => validateToolRequest({ action: "kill", member: { id: "nobody" } }, state), /Unknown member/u);
	assert.throws(() => validateToolRequest({ action: "stop", member: { id: "reviewer", role: "x" } }, state), /member id only/u);
	assert.throws(() => validateToolRequest({ action: "kill", member: { id: "reviewer", model: "a/b" } }, state), /member id only/u);
	// task/tasks/background/timeout are rejected for stop/kill (neither takes a payload)
	for (const action of ["stop", "kill"] as const) {
		assert.throws(() => validateToolRequest({ action, member: { id: "reviewer" }, task: "x" }, state), /forbids/u);
		assert.throws(() => validateToolRequest({ action, member: { id: "reviewer" }, tasks: [] }, state), /forbids/u);
		assert.throws(() => validateToolRequest({ action, member: { id: "reviewer" }, background: true }, state), /forbids/u);
		assert.throws(() => validateToolRequest({ action, member: { id: "reviewer" }, timeout: 5 }, state), /forbids/u);
	}
});

test("set-model rejects a model outside the parent registry without touching persisted config", async () => {
	const compatibility = new FakeCompatibility();
	const runtime = new TeamRuntime(compatibility, () => NOW, () => "session-1", () => new FakeDashboard());
	const ctx = context({
		mode: "rpc",
		listModels: () => [
			{ provider: "test", id: "model", name: "Test Model", contextWindow: 200_000 },
			{ provider: "test", id: "other", name: "Other", contextWindow: 200_000 },
		],
	});
	await runtime.execute({ action: "run", member: MEMBER, task: "warm up", background: true }, ctx);
	await waitFor(() => compatibility.clients[0]?.promptCalls.length > 0);
	await assert.rejects(
		runtime.execute({ action: "set-model", member: { id: "reviewer", model: "test/other", thinking: "turbo" as any } }, ctx),
		/thinking must be one of/u,
	);
	await assert.rejects(
		runtime.execute({ action: "set-model", member: { id: "reviewer", model: "test/ghost" } }, ctx),
		{ code: "INVALID_AGENT_TEAM_REQUEST" },
	);
	const member = runtime.getState().teams.default.members.reviewer;
	assert.deepEqual(member.model, { provider: "test", id: "model" }, "persisted model unchanged");
	assert.equal(member.configHash, configHash(member));
	assert.equal(compatibility.clients[0].setModelCalls.length, 0, "rejected switch never reaches the RPC child");
});

test("set-model verifies the child reports the new model and thinking after the switch", async () => {
	const compatibility = new FakeCompatibility();
	const runtime = new TeamRuntime(compatibility, () => NOW, () => "session-1", () => new FakeDashboard());
	const ctx = context({ mode: "rpc" });
	await runtime.execute({ action: "run", member: MEMBER, task: "warm up", background: true }, ctx);
	const client = compatibility.clients[0];
	await waitFor(() => client.promptCalls.length > 0);
	const result = await runtime.execute({ action: "set-model", member: { id: "reviewer", model: "test/other", thinking: "xhigh" } }, ctx);
	assert.match(result.content[0].text, /test\/model -> test\/other; thinking medium -> xhigh/u);
	const member = runtime.getState().teams.default.members.reviewer;
	assert.deepEqual(member.model, { provider: "test", id: "other" });
	assert.equal(member.thinking, "xhigh");
	assert.equal(member.configHash, configHash(member));
	assert.deepEqual(client.setModelCalls, [{ provider: "test", modelId: "other" }]);
	assert.deepEqual(client.setThinkingLevelCalls, ["xhigh"]);
});

test("set-model keeps both persisted fields unchanged when child model verification fails", async () => {
	const compatibility = new FakeCompatibility();
	const runtime = new TeamRuntime(compatibility, () => NOW, () => "session-1", () => new FakeDashboard());
	const ctx = context({ mode: "rpc" });
	await runtime.execute({ action: "run", member: MEMBER, task: "warm up", background: true }, ctx);
	const client = compatibility.clients[0];
	await waitFor(() => client.promptCalls.length > 0);
	client.ignoreModelUpdates = true;
	await assert.rejects(
		runtime.execute({ action: "set-model", member: { id: "reviewer", model: "test/other", thinking: "high" } }, ctx),
		/child reports model test\/model and thinking high/u,
	);
	const member = runtime.getState().teams.default.members.reviewer;
	assert.deepEqual(member.model, { provider: "test", id: "model" });
	assert.equal(member.thinking, "medium");
	assert.equal(member.configHash, configHash(member));
	assert.deepEqual(client.setThinkingLevelCalls, ["high", "medium"], "child thinking is rolled back too");
});

test("set-model rolls child and persisted model/thinking back when thinking verification fails", async () => {
	const compatibility = new FakeCompatibility();
	const runtime = new TeamRuntime(compatibility, () => NOW, () => "session-1", () => new FakeDashboard());
	const ctx = context({ mode: "rpc" });
	await runtime.execute({ action: "run", member: MEMBER, task: "warm up", background: true }, ctx);
	const client = compatibility.clients[0];
	await waitFor(() => client.promptCalls.length > 0);
	client.ignoreThinkingUpdates = true;
	await assert.rejects(
		runtime.execute({ action: "set-model", member: { id: "reviewer", model: "test/other", thinking: "high" } }, ctx),
		/child reports model test\/other and thinking medium/u,
	);
	const member = runtime.getState().teams.default.members.reviewer;
	assert.deepEqual(member.model, { provider: "test", id: "model" });
	assert.equal(member.thinking, "medium");
	assert.equal(member.configHash, configHash(member));
	assert.equal(client.stateModel, "test/model", "child model is rolled back after thinking mismatch");
	assert.deepEqual(client.setModelCalls, [
		{ provider: "test", modelId: "other" },
		{ provider: "test", modelId: "model" },
	]);
});

test("set-model without a live client persists and states when it takes effect", async () => {
	const compatibility = new FakeCompatibility();
	const runtime = new TeamRuntime(compatibility, () => NOW, () => "session-1", () => new FakeDashboard());
	const ctx = context({ mode: "rpc" });
	await runtime.execute({ action: "run", member: MEMBER, task: "warm up", background: true }, ctx);
	const client = compatibility.clients[0];
	await waitFor(() => client.promptCalls.length > 0);
	await runtime.execute({ action: "kill", member: { id: "reviewer" } }, ctx);
	const result = await runtime.execute({ action: "set-model", member: { id: "reviewer", model: "test/third", thinking: "max" } }, ctx);
	const member = runtime.getState().teams.default.members.reviewer;
	assert.deepEqual(member.model, { provider: "test", id: "third" });
	assert.equal(member.thinking, "max");
	assert.equal(member.configHash, configHash(member));
	assert.match(result.content[0].text, /no live member client/u);
	assert.match(result.content[0].text, /next run/u);
	assert.equal(client.setModelCalls.length, 0, "no live client: no RPC setModel");
	assert.equal(client.setThinkingLevelCalls.length, 0, "no live client: no RPC setThinkingLevel");
});

test("creating a member with an unavailable model falls back to the parent model with a warning", async () => {
	const compatibility = new FakeCompatibility();
	const runtime = new TeamRuntime(compatibility, () => NOW, () => "session-1", () => new FakeDashboard());
	const ctx = context({
		mode: "rpc",
		listModels: () => [{ provider: "test", id: "model", name: "Test Model", contextWindow: 200_000 }],
	});
	const result = await runtime.execute(
		{ action: "run", member: { ...MEMBER, id: "scout", role: "Scout", model: "claude/sonnet" }, task: "fallback" },
		ctx,
	);
	assert.match(
		result.content[0].text,
		/requested model "claude\/sonnet" is not in the main Pi's available models; fell back to test\/model/u,
	);
	assert.deepEqual(runtime.getState().teams.default.members.scout.model, { provider: "test", id: "model" });
});

test("member identity.md is generated on authorization and leader edits apply on the next run", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pi-agent-team-identity-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const compatibility = new FakeCompatibility();
	const runtime = new TeamRuntime(compatibility, () => NOW, () => "session-1", () => new FakeDashboard());
	const ctx = context({ cwd: dir, mode: "rpc" });
	await runtime.execute({ action: "run", member: MEMBER, task: "first" }, ctx);
	const identityPath = join(dir, ".pi", "agent-team", "default", "members", "reviewer", "identity.md");
	const identity = await readFile(identityPath, "utf8");
	assert.match(identity, /# Member Identity: reviewer/u);
	assert.match(identity, /- Role: Reviewer/u);
	assert.match(identity, /- Model: test\/model/u);
	assert.match(identity, /Review the implementation\./u);
	// the leader edits the Instructions section; the next run (fresh client) must pick it up
	await writeFile(identityPath, identity.replace("Review the implementation.", "Follow the updated plan."), "utf8");
	await runtime.execute({ action: "kill", member: { id: "reviewer" } }, ctx);
	await runtime.execute({ action: "run", member: { id: "reviewer" }, task: "second" }, ctx);
	assert.equal(compatibility.instructionsSeen.length, 2);
	assert.match(compatibility.instructionsSeen[1], /Follow the updated plan\./u);
});

test("output.md is written only when output is truncated; short runs leave no file", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pi-agent-team-output-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const workspace = join(dir, ".pi", "agent-team", "default");
	const outputPath = join(workspace, "members", "reviewer", "output.md");
	// a short run never writes output.md: no file, no outputPath, no path in the report
	const compatibility = new FakeCompatibility();
	compatibility.blockIdle = true;
	const runtime = new TeamRuntime(compatibility, () => NOW, () => "session-1", () => new FakeDashboard(), () => 60_000);
	const ctx = context({ cwd: dir, mode: "rpc" });
	await runtime.execute({ action: "run", member: MEMBER, task: "round one", background: true }, ctx);
	const client = compatibility.clients[0];
	await waitFor(() => client.promptCalls.length > 0);
	client.completeIdle();
	await waitFor(() => runtime.getState().teams.default.members.reviewer.status === "IDLE");
	// the auto report lands after finalization: if the file existed it would be settled
	await waitFor(() => ctx.messages.length === 1);
	await assert.rejects(readFile(outputPath), /ENOENT/u, "short output must not create output.md");
	assert.doesNotMatch(ctx.messages[0].message.content, /Output file:/u, "no output path in the auto report");
	const waited = await runtime.execute({ action: "wait", member: { id: "reviewer" } }, ctx);
	assert.equal(waited.details.results?.[0].outputPath, undefined);
	assert.equal(waited.details.results?.[0].output, "done");
	// an oversized run spills the full output to members/<id>/output.md and reports the path
	const big = new FakeCompatibility();
	big.outputFor = "x".repeat(60_000);
	const runtime2 = new TeamRuntime(big, () => NOW, () => "session-1", () => new FakeDashboard(), () => 60_000);
	const bigCtx = context({ cwd: dir, mode: "rpc" });
	await runtime2.execute({ action: "run", member: MEMBER, task: "big", background: true }, bigCtx);
	const bigClient = big.clients[0];
	await waitFor(() => bigClient.promptCalls.length > 0);
	bigClient.completeIdle();
	await waitFor(() => runtime2.getState().teams.default.members.reviewer.status === "IDLE");
	await waitFor(() => bigCtx.messages.length === 1);
	const spilled = await readFile(outputPath, "utf8");
	assert.match(spilled, /^# Output: default\/reviewer/u, "oversized output carries the member header");
	assert.ok(spilled.endsWith("x".repeat(60_000) + "\n"), "full output is preserved under the header");
	assert.match(bigCtx.messages[0].message.content, /Output file: .*members\/reviewer\/output\.md/u);
	const bigWaited = await runtime2.execute({ action: "wait", member: { id: "reviewer" } }, bigCtx);
	const bigResult = bigWaited.details.results?.[0];
	assert.ok(bigResult, "wait must collect the oversized result");
	assert.equal(bigResult.outputPath, outputPath);
	assert.equal(bigResult.truncated, true);
	assert.match(bigResult.output ?? "", /\[Full output: .*members\/reviewer\/output\.md\]/u);
});

test("run, status, and set-model do not create a roster mirror", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pi-agent-team-no-roster-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const compatibility = new FakeCompatibility();
	const runtime = new TeamRuntime(compatibility, () => NOW, () => "session-1", () => new FakeDashboard());
	const ctx = context({ cwd: dir, mode: "rpc" });
	await runtime.execute({ action: "run", member: MEMBER, task: "first" }, ctx);
	await runtime.execute({ action: "status", member: { id: "reviewer" } }, ctx);
	await runtime.execute({ action: "set-model", member: { id: "reviewer", model: "test/other" } }, ctx);
	await assert.rejects(readFile(join(dir, ".pi", "agent-team", "default", "leader", "roster.md")), /ENOENT/u);
});

test("leader plan.md is generated once and never overwritten", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pi-agent-team-plan-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const compatibility = new FakeCompatibility();
	const runtime = new TeamRuntime(compatibility, () => NOW, () => "session-1", () => new FakeDashboard());
	const ctx = context({ cwd: dir, mode: "rpc" });
	await runtime.execute({ action: "run", member: MEMBER, task: "first" }, ctx);
	const planPath = join(dir, ".pi", "agent-team", "default", "leader", "plan.md");
	const plan = await readFile(planPath, "utf8");
	assert.match(plan, /# Agent Team Plan: default/u);
	assert.match(plan, /Mode: ad-hoc/u);
	assert.match(plan, /Source of truth: runtime TeamState/u);
	// the leader edits the plan; a later run must not overwrite it
	await writeFile(planPath, plan + "\n- [ ] Round 2: verify\n", "utf8");
	await runtime.execute({ action: "run", member: { id: "reviewer" }, task: "second" }, ctx);
	const plan2 = await readFile(planPath, "utf8");
	assert.equal(plan2, plan + "\n- [ ] Round 2: verify\n", "plan.md is preserved across runs");
});

test("minimal workspace omits legacy brief, roster, notes, and output directory", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pi-agent-team-ws2-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const compatibility = new FakeCompatibility();
	const runtime = new TeamRuntime(compatibility, () => NOW, () => "session-1", () => new FakeDashboard());
	const ctx = context({ cwd: dir, mode: "rpc" });
	await runtime.execute({ action: "run", member: MEMBER, task: "workspace check" }, ctx);
	const workspace = join(dir, ".pi", "agent-team", "default");
	assert.ok((await stat(join(workspace, "leader", "plan.md"))).isFile());
	assert.ok((await stat(join(workspace, "members", "reviewer", "identity.md"))).isFile());
	await assert.rejects(stat(join(workspace, "notes")), /ENOENT/u);
	await assert.rejects(readFile(join(workspace, "brief.md")), /ENOENT/u);
	await assert.rejects(readFile(join(workspace, "leader", "roster.md")), /ENOENT/u);
	await assert.rejects(readFile(join(workspace, "output", "reviewer.md")), /ENOENT/u);
});

test("new members without tools get an empty tool list and identity shows all", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pi-agent-team-tools-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const compatibility = new FakeCompatibility();
	const runtime = new TeamRuntime(compatibility, () => NOW, () => "session-1", () => new FakeDashboard());
	const ctx = context({ cwd: dir, mode: "rpc" });
	let approvalText = "";
	ctx.confirm = async (_title, message) => {
		approvalText = message;
		return true;
	};
	await runtime.execute(
		{ action: "run", member: { id: "scout", role: "Scout", instructions: "Scan the workspace." }, task: "scan" },
		ctx,
	);
	// empty tool list reaches createMemberClient: compat.ts omits --tools so Pi grants all tools
	assert.deepEqual(compatibility.toolsSeen[0], [], "no tools specified: empty list (all tools)");
	assert.deepEqual(runtime.getState().teams.default.members.scout.tools, []);
	assert.match(approvalText, /Tools: all/u, "approval message shows 'all'");
	const workspace = join(dir, ".pi", "agent-team", "default");
	const identity = await readFile(join(workspace, "members", "scout", "identity.md"), "utf8");
	assert.match(identity, /- Tools: all/u);
	await assert.rejects(readFile(join(workspace, "brief.md")), /ENOENT/u);
});

test("explicit member tools reach createMemberClient unchanged", async () => {
	const compatibility = new FakeCompatibility();
	const runtime = new TeamRuntime(compatibility, () => NOW, () => "session-1", () => new FakeDashboard());
	const ctx = context({ mode: "rpc" });
	await runtime.execute(
		{ action: "run", member: { id: "scout", role: "Scout", instructions: "Scan.", tools: ["write", "read"] }, task: "scan" },
		ctx,
	);
	assert.deepEqual(compatibility.toolsSeen[0], ["write", "read"], "explicit tools pass through in order");
	assert.deepEqual(runtime.getState().teams.default.members.scout.tools, ["write", "read"]);
});

test("previously authorized members keep their historical tool list", async () => {
	const compatibility = new FakeCompatibility();
	const runtime = new TeamRuntime(compatibility, () => NOW, () => "session-1", () => new FakeDashboard());
	const ctx = context({ mode: "rpc" });
	// MEMBER carries tools: ["read"] (an old-snapshot member); the tool list must not be reset
	await runtime.execute({ action: "run", member: MEMBER, task: "warm up", background: true }, ctx);
	await waitFor(() => compatibility.clients[0]?.promptCalls.length > 0);
	assert.deepEqual(compatibility.toolsSeen[0], ["read"], "historical snapshot tools are preserved");
	assert.deepEqual(runtime.getState().teams.default.members.reviewer.tools, ["read"]);
});

test("idle members past the keep-alive window are swept on the next execute", async () => {
	const compatibility = new FakeCompatibility();
	compatibility.blockIdle = true;
	const runtime = new TeamRuntime(compatibility, () => NOW, () => "session-1", () => new FakeDashboard(), () => 60_000);
	const ctx = context({ mode: "rpc" });
	await runtime.execute({ action: "run", member: MEMBER, task: "round one", background: true }, ctx);
	const client = compatibility.clients[0];
	await waitFor(() => client.promptCalls.length > 0);
	client.completeIdle();
	await waitFor(() => runtime.getState().teams.default.members.reviewer.status === "IDLE");
	// age the idle member past the 30-minute keep-alive window
	(runtime as any).state.teams.default.members.reviewer.idleSinceMs = Date.now() - 31 * 60_000;
	await runtime.execute({ action: "status", member: { id: "reviewer" } }, ctx);
	assert.equal(client.stopCalls, 1, "the idle child process is stopped by the sweep");
	// the next run restarts the child lazily with the same session
	await runtime.execute({ action: "run", member: { id: "reviewer" }, task: "round two", background: true }, ctx);
	assert.equal(compatibility.clients.length, 2, "a fresh client is created after the sweep");
	assert.equal(compatibility.clients[1].sessionId, "session-1", "the member session is reused");
	await waitFor(() => compatibility.clients[1].promptCalls.length > 0);
});

test("idle members within the keep-alive window keep their client", async () => {
	const compatibility = new FakeCompatibility();
	compatibility.blockIdle = true;
	const runtime = new TeamRuntime(compatibility, () => NOW, () => "session-1", () => new FakeDashboard(), () => 60_000);
	const ctx = context({ mode: "rpc" });
	await runtime.execute({ action: "run", member: MEMBER, task: "round one", background: true }, ctx);
	const client = compatibility.clients[0];
	await waitFor(() => client.promptCalls.length > 0);
	client.completeIdle();
	await waitFor(() => runtime.getState().teams.default.members.reviewer.status === "IDLE");
	// idleSinceMs was just set by settlement: far inside the keep-alive window
	await runtime.execute({ action: "status", member: { id: "reviewer" } }, ctx);
	assert.equal(client.stopCalls, 0, "recently idle members keep their process");
	assert.equal(compatibility.clients.length, 1);
});

test("running members are never swept", async () => {
	const compatibility = new FakeCompatibility();
	compatibility.blockIdle = true;
	const runtime = new TeamRuntime(compatibility, () => NOW, () => "session-1", () => new FakeDashboard(), () => 60_000);
	const ctx = context({ mode: "rpc" });
	await runtime.execute({ action: "run", member: MEMBER, task: "slow", background: true }, ctx);
	const client = compatibility.clients[0];
	await waitFor(() => client.promptCalls.length > 0);
	assert.equal(runtime.getState().teams.default.members.reviewer.status, "RUNNING");
	// even with a stale idleSinceMs, a running member must not be swept
	(runtime as any).state.teams.default.members.reviewer.idleSinceMs = Date.now() - 31 * 60_000;
	await runtime.execute({ action: "status", member: { id: "reviewer" } }, ctx);
	assert.equal(client.stopCalls, 0, "running members keep their process");
	assert.equal(compatibility.clients.length, 1);
	client.completeIdle();
	await waitFor(() => runtime.getState().teams.default.members.reviewer.status === "IDLE");
});

test("idleKeepAliveMs falls back to default for invalid env values and clamps valid ones", (t) => {
	const env = IDLE_KEEP_ALIVE_ENV;
	t.after(() => {
		delete process.env[env];
	});
	process.env[env] = "abc";
	assert.equal(idleKeepAliveMs(), IDLE_KEEP_ALIVE_MS, "non-numeric env falls back to the default");
	process.env[env] = "0";
	assert.equal(idleKeepAliveMs(), IDLE_KEEP_ALIVE_MS, "zero env falls back to the default");
	process.env[env] = "1.5";
	assert.equal(idleKeepAliveMs(), IDLE_KEEP_ALIVE_MS, "fractional env falls back to the default");
	process.env[env] = "60000";
	assert.equal(idleKeepAliveMs(), 60_000, "valid env value is honored");
	process.env[env] = "1000";
	assert.equal(idleKeepAliveMs(), 60_000, "values below the 1m floor are clamped up");
	process.env[env] = "99999999999";
	assert.equal(idleKeepAliveMs(), 24 * 60 * 60_000, "values above the 24h ceiling are clamped down");
});

test("set-auto on creates new members without confirmation and notes it in the result", async () => {
	const compatibility = new FakeCompatibility();
	const runtime = new TeamRuntime(compatibility, () => NOW, () => "session-1", () => new FakeDashboard());
	const ctx = context({ mode: "rpc" });
	let confirmCalls = 0;
	ctx.confirm = async () => {
		confirmCalls++;
		return true;
	};
	await runtime.execute({ action: "set-auto", auto: true }, ctx);
	const result = await runtime.execute(
		{ action: "run", member: { id: "scout", role: "Scout", instructions: "Scan." }, task: "scan" },
		ctx,
	);
	assert.equal(confirmCalls, 0, "auto mode skips the confirmation dialog");
	assert.ok(runtime.getState().teams.default.members.scout, "member is created");
	assert.ok(runtime.getState().teams.default.members.scout.approvedAt, "member is approved/persisted");
	assert.match(result.content[0].text, /auto-approve mode is ON/u);
	assert.match(result.content[0].text, /created without confirmation/u);
});

test("set-auto off restores confirmation for new members", async () => {
	const compatibility = new FakeCompatibility();
	const runtime = new TeamRuntime(compatibility, () => NOW, () => "session-1", () => new FakeDashboard());
	const ctx = context({ mode: "rpc" });
	let confirmCalls = 0;
	ctx.confirm = async () => {
		confirmCalls++;
		return true;
	};
	await runtime.execute({ action: "set-auto", auto: true }, ctx);
	await runtime.execute(
		{ action: "run", member: { id: "scout", role: "Scout", instructions: "Scan." }, task: "scan" },
		ctx,
	);
	assert.equal(confirmCalls, 0);
	await runtime.execute({ action: "set-auto", auto: false }, ctx);
	await runtime.execute(
		{ action: "run", member: { id: "editor", role: "Editor", instructions: "Edit." }, task: "edit" },
		ctx,
	);
	assert.equal(confirmCalls, 1, "confirmations resume after auto mode is switched off");
});

test("headless contexts can create members in auto mode; otherwise they are cancelled with a hint", async () => {
	const compatibility = new FakeCompatibility();
	const runtime = new TeamRuntime(compatibility, () => NOW, () => "session-1", () => new FakeDashboard());
	const ctx = context({ mode: "json", hasUI: false });
	// auto off: creation is cancelled with a set-auto hint
	const cancelled = await runtime.execute(
		{ action: "run", member: { id: "scout", role: "Scout", instructions: "Scan." }, task: "scan" },
		ctx,
	);
	assert.equal(cancelled.details.cancelled, true);
	assert.match(cancelled.content[0].text, /set-auto/u);
	assert.equal(runtime.getState().teams.default?.members?.scout, undefined);
	assert.equal(compatibility.clients.length, 0);
	// auto on: headless creation succeeds without confirmation
	await runtime.execute({ action: "set-auto", auto: true }, ctx);
	await runtime.execute(
		{ action: "run", member: { id: "editor", role: "Editor", instructions: "Edit." }, task: "edit" },
		ctx,
	);
	assert.ok(runtime.getState().teams.default.members.editor, "headless member is created in auto mode");
});

test("set-auto validation requires auto and rejects extra fields", () => {
	const state = emptyState(NOW);
	validateToolRequest({ action: "set-auto", auto: true }, state);
	validateToolRequest({ action: "set-auto", auto: false }, state);
	assert.throws(() => validateToolRequest({ action: "set-auto" }, state), /requires auto/u);
	assert.throws(() => validateToolRequest({ action: "set-auto", auto: true, member: { id: "x" } }, state), /set-auto forbids/u);
	assert.throws(() => validateToolRequest({ action: "set-auto", auto: true, task: "x" }, state), /set-auto forbids/u);
	assert.throws(() => validateToolRequest({ action: "set-auto", auto: true, tasks: [] }, state), /set-auto forbids/u);
	assert.throws(() => validateToolRequest({ action: "set-auto", auto: true, background: true }, state), /set-auto forbids/u);
	assert.throws(() => validateToolRequest({ action: "set-auto", auto: true, timeout: 5 }, state), /set-auto forbids/u);
});

test("status reports auto-approve mode only while it is on", async () => {
	const compatibility = new FakeCompatibility();
	const runtime = new TeamRuntime(compatibility, () => NOW, () => "session-1", () => new FakeDashboard());
	const ctx = context({ mode: "rpc" });
	let status = await runtime.execute({ action: "status" }, ctx);
	assert.doesNotMatch(status.content[0].text, /Auto-approve mode/u);
	await runtime.execute({ action: "set-auto", auto: true }, ctx);
	status = await runtime.execute({ action: "status" }, ctx);
	assert.match(status.content[0].text, /Auto-approve mode: ON/u);
	await runtime.execute({ action: "set-auto", auto: false }, ctx);
	status = await runtime.execute({ action: "status" }, ctx);
	assert.doesNotMatch(status.content[0].text, /Auto-approve mode/u);
});

test("auto-approve mode is session-scoped and does not survive branch restore", async () => {
	const compatibility = new FakeCompatibility();
	const runtime = new TeamRuntime(compatibility, () => NOW, () => "session-1", () => new FakeDashboard());
	const ctx = context({ mode: "rpc" });
	await runtime.execute({ action: "set-auto", auto: true }, ctx);
	await runtime.execute(
		{ action: "run", member: { id: "scout", role: "Scout", instructions: "Scan." }, task: "scan" },
		ctx,
	);
	// a restored runtime keeps the member state but starts with auto mode off
	const runtime2 = new TeamRuntime(compatibility, () => NOW, () => "session-1", () => new FakeDashboard());
	runtime2.restoreFromBranch([{ type: "custom", customType: STATE_ENTRY_TYPE, data: runtime.getState() }]);
	assert.ok(runtime2.getState().teams.default.members.scout, "member state is restored");
	const ctx2 = context({ mode: "rpc" });
	const status = await runtime2.execute({ action: "status" }, ctx2);
	assert.doesNotMatch(status.content[0].text, /Auto-approve mode/u, "auto mode is not restored");
});

// ---------------------------------------------------------------------------
// Plan-first control-plane regression code. These tests are intentionally kept
// in the existing runtime/dashboard suite so no second test harness or state
// machine is introduced.
// ---------------------------------------------------------------------------

test("plan USER_GATE rejection, cancellation, and no UI have zero side effects", async (t) => {
	for (const scenario of ["rejected", "cancelled", "no-ui"] as const) {
		await t.test(scenario, async () => {
			const dir = await mkdtemp(join(tmpdir(), `pi-agent-team-plan-gate-${scenario}-`));
			t.after(() => rm(dir, { recursive: true, force: true }));
			const compatibility = new FakeCompatibility();
			let uuidCalls = 0;
			let dashboardCalls = 0;
			const runtime = new TeamRuntime(
				compatibility,
				() => NOW,
				() => `session-${++uuidCalls}`,
				() => {
					dashboardCalls++;
					return new FakeDashboard();
				},
			);
			const ctx = context({
				cwd: dir,
				mode: "rpc",
				hasUI: scenario !== "no-ui",
				confirm: async () => {
					if (scenario === "cancelled") throw new Error("plan confirmation aborted");
					return false;
				},
			});
			if (scenario === "cancelled") {
				await assert.rejects(runtime.execute({ action: "plan", plan: PLAN }, ctx), /confirmation aborted/u);
			} else {
				const result = await runtime.execute({ action: "plan", plan: PLAN }, ctx);
				assert.equal(result.details.cancelled, true);
			}
			assert.equal(uuidCalls, 0);
			assert.equal(ctx.snapshots.length, 0);
			assert.equal(dashboardCalls, 0);
			assert.equal(compatibility.createCalls, 0);
			assert.deepEqual(runtime.getState(), emptyState(NOW));
			await assert.rejects(stat(join(dir, ".pi", "agent-team", "default")), /ENOENT/u);
		});
	}
});

test("plan registration is one snapshot and amendment requires the exact revision", async () => {
	const compatibility = new FakeCompatibility();
	let uuid = 0;
	const runtime = new TeamRuntime(compatibility, () => NOW, () => `session-${++uuid}`, () => new FakeDashboard());
	const ctx = context({ mode: "rpc" });
	await registerPlan(runtime, ctx);
	assert.equal(ctx.snapshots.length, 1, "roster, DAG, ownership, and acceptance persist atomically");
	assert.equal(uuid, PLAN.members.length);
	assert.equal(runtime.getState().teams.default.plan?.revision, 1);
	assert.equal(compatibility.createCalls, 0, "plan never creates a child");
	await assert.rejects(
		runtime.execute({ action: "plan", expectedRevision: 99, plan: PLAN }, ctx),
		/revision mismatch/u,
	);
	assert.equal(ctx.snapshots.length, 1, "stale amendment has no persistence side effect");
	const amended = structuredClone(PLAN);
	amended.tasks.push({
		id: "task-c",
		memberId: "coder-a",
		objective: "New confirmed task C.",
		dependsOn: ["task-a"],
		ownedPaths: ["src/c"],
		acceptance: ["C is complete."],
	});
	await runtime.execute({ action: "plan", expectedRevision: 1, plan: amended }, ctx);
	assert.equal(runtime.getState().teams.default.plan?.revision, 2);
	assert.equal(ctx.snapshots.length, 2, "amendment appends one new complete snapshot");
	assert.equal(runtime.getState().teams.default.executionTasks["task-c"].status, "PENDING");
});

test("plan validation rejects unsafe paths, cycles, and unordered ownership conflicts before confirmation", async () => {
	assert.equal(normalizeOwnedPath("./src/a/"), "src/a");
	assert.equal(pathsConflict("src/a", "src/a/file.ts"), true);
	assert.equal(pathsConflict("src/a", "src/ab"), false);
	assert.throws(() => normalizeOwnedPath("../outside"), /cwd-relative|escapes cwd/u);
	assert.throws(() => normalizeOwnedPath("/absolute"), /cwd-relative/u);

	const cases: Array<{ name: string; plan: PlanInput; pattern: RegExp }> = [];
	const absolute = structuredClone(PLAN);
	absolute.tasks[0].ownedPaths = ["/tmp/escape"];
	cases.push({ name: "absolute", plan: absolute, pattern: /cwd-relative/u });
	const cycle = structuredClone(PLAN);
	cycle.tasks[0].dependsOn = ["task-b"];
	cases.push({ name: "cycle", plan: cycle, pattern: /cycle/u });
	const conflict = structuredClone(PLAN);
	conflict.tasks[1].dependsOn = [];
	conflict.tasks[1].ownedPaths = ["src/a/nested"];
	cases.push({ name: "conflict", plan: conflict, pattern: /conflicting owned paths/u });

	for (const item of cases) {
		const compatibility = new FakeCompatibility();
		const runtime = new TeamRuntime(compatibility);
		let confirmations = 0;
		const ctx = context({ confirm: async () => { confirmations++; return true; } });
		await assert.rejects(runtime.execute({ action: "plan", plan: item.plan }, ctx), item.pattern, item.name);
		assert.equal(confirmations, 0, `${item.name} must fail before USER_GATE`);
		assert.equal(ctx.snapshots.length, 0);
		assert.equal(compatibility.createCalls, 0);
	}
});

test("v2 migration preserves authorization and converts active task and rounds to explicit recovery", () => {
	const source = stateWithMembers({ reviewer: { ...existingMember(), status: "RUNNING" } });
	const team = source.teams.default;
	team.executionTasks["task-a"] = {
		id: "task-a",
		memberId: "reviewer",
		status: "RUNNING",
		dependsOn: [],
		packet: { objective: "x", constraints: [], dependencySummaries: {}, ownedPaths: ["src/a"], acceptance: ["x"], relevantPaths: [], outputContract: "x" },
		attempt: 1,
		updatedAt: NOW,
	};
	team.executionTasks["task-b"] = {
		...team.executionTasks["task-a"],
		id: "task-b",
		status: "AUDITING",
	};
	team.reviewRounds["review-1"] = { id: "review-1", reviewerId: "reviewer", targetTaskIds: ["task-b"], status: "RUNNING", attempt: 1, updatedAt: NOW };
	team.expertRounds["expert-1"] = { id: "expert-1", expertId: "reviewer", kind: "product", targetTaskIds: ["task-a"], objective: "x", status: "RUNNING", attempt: 1, updatedAt: NOW };
	const recovered = migrateState(source, NOW).teams.default;
	assert.equal(recovered.members.reviewer.sessionId, "session-1");
	assert.equal(recovered.members.reviewer.configHash, source.teams.default.members.reviewer.configHash);
	assert.equal(recovered.members.reviewer.status, "INTERRUPTED");
	assert.equal(recovered.executionTasks["task-a"].status, "BLOCKED");
	assert.equal(recovered.executionTasks["task-b"].status, "SUBMITTED");
	assert.equal(recovered.reviewRounds["review-1"].status, "BLOCKED");
	assert.equal(recovered.expertRounds["expert-1"].status, "BLOCKED");
});

test("planned dependency and parallel preflight fail before Dashboard or child side effects", async () => {
	const compatibility = new FakeCompatibility();
	const dashboard = new FakeDashboard();
	let uuid = 0;
	const runtime = new TeamRuntime(compatibility, () => NOW, () => `session-${++uuid}`, () => dashboard);
	const ctx = context({ mode: "rpc" });
	await registerPlan(runtime, ctx);
	await assert.rejects(runtime.execute({ action: "run", taskId: "task-b" }, ctx), /unverified dependencies/u);
	await assert.rejects(runtime.execute({ action: "parallel", taskIds: ["task-a", "task-b"] }, ctx), /unverified dependencies/u);
	assert.equal(dashboard.prepareCalls.length, 0);
	assert.equal(compatibility.createCalls, 0);
	assert.equal(runtime.getState().teams.default.executionTasks["task-a"].status, "READY");
	assert.equal(runtime.getState().teams.default.executionTasks["task-b"].status, "PENDING");
});

test("planned TaskPacket is minimal and Coder cannot self-verify", async () => {
	const compatibility = new FakeCompatibility();
	compatibility.outputsByMember["coder-a"] = executionReport("task-a");
	let uuid = 0;
	const runtime = new TeamRuntime(compatibility, () => NOW, () => `session-${++uuid}`, () => new FakeDashboard());
	const ctx = context({ mode: "json" });
	await registerPlan(runtime, ctx);
	const result = await runtime.execute({ action: "run", taskId: "task-a", background: false }, ctx);
	const prompt = compatibility.clients[0].promptCalls[0];
	assert.match(prompt, /Implement task A objective/u);
	assert.match(prompt, /"ownedPaths": \[/u);
	assert.match(prompt, /"dependencySummaries": \{\}/u);
	assert.doesNotMatch(prompt, /Global acceptance marker/u);
	assert.doesNotMatch(prompt, /Implement task B objective/u);
	assert.doesNotMatch(prompt, /Coder B|Reviewer.*Optimizer/u);
	assert.equal(result.details.results?.[0].delta?.changed.status, "SUBMITTED");
	assert.equal(runtime.getState().teams.default.executionTasks["task-a"].status, "SUBMITTED");
	await assert.rejects(runtime.execute({ action: "run", taskId: "task-a" }, ctx), /cannot start from SUBMITTED/u);
});

test("strict tail parser accepts three envelopes and rejects missing, extra, and oversized reports", () => {
	assert.equal(parseReportEnvelope(executionReport("task-a"), "execution").type, "execution");
	assert.equal(parseReportEnvelope(reviewReport("review-1", [{ taskId: "task-a", verdict: "VERIFIED" }]), "review").type, "review");
	assert.equal(parseReportEnvelope(expertReport("expert-1"), "expert").type, "expert");
	assert.throws(() => parseReportEnvelope("prose only", "execution"), /Final non-empty line/u);
	assert.throws(
		() => parseReportEnvelope(JSON.stringify({ agent_team_report: { type: "execution", taskId: "task-a", status: "VERIFIED", summary: "x", evidence: [], requests: [] } }), "execution"),
		/SUBMITTED or BLOCKED/u,
	);
	assert.throws(
		() => parseReportEnvelope(JSON.stringify({ agent_team_report: { type: "expert", expertRoundId: "x", summary: "x", evidence: [], requests: [], extra: true } }), "expert"),
		/unsupported fields/u,
	);
	assert.throws(
		() => parseReportEnvelope(JSON.stringify({ agent_team_report: { type: "expert", expertRoundId: "x", summary: "x".repeat(2001), evidence: [], requests: [] } }), "expert"),
		/1-2000/u,
	);
});

test("Loop uses same-task fix attempts and only Reviewer verifies and unlocks dependencies", async () => {
	const fixPrompt = "Fix only task-a boundary; keep API stable; report evidence.";
	const compatibility = new FakeCompatibility();
	compatibility.roundOutputsByMember["coder-a"] = [
		executionReport("task-a", "SUBMITTED", "attempt one"),
		executionReport("task-a", "SUBMITTED", "attempt two"),
	];
	compatibility.roundOutputsByMember.reviewer = [
		reviewReport("review-1", [{ taskId: "task-a", verdict: "FIX_REQUIRED", fix_prompt: fixPrompt }]),
		reviewReport("review-2", [{ taskId: "task-a", verdict: "VERIFIED" }]),
	];
	let uuid = 0;
	const runtime = new TeamRuntime(compatibility, () => NOW, () => `session-${++uuid}`, () => new FakeDashboard());
	const ctx = context({ mode: "json" });
	await registerPlan(runtime, ctx);
	await runtime.execute({ action: "run", taskId: "task-a", background: false }, ctx);
	await runtime.execute({ action: "review", reviewRoundId: "review-1", taskIds: ["task-a"], background: false }, ctx);
	let task = runtime.getState().teams.default.executionTasks["task-a"];
	assert.equal(task.status, "FIX_REQUIRED");
	assert.equal(task.fixPrompt, fixPrompt);
	assert.equal(task.attempt, 1);
	await runtime.execute({ action: "run", taskId: "task-a", background: false }, ctx);
	assert.match(compatibility.clients[0].promptCalls[1], new RegExp(fixPrompt.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "u"));
	await runtime.execute({ action: "review", reviewRoundId: "review-2", taskIds: ["task-a"], background: false }, ctx);
	task = runtime.getState().teams.default.executionTasks["task-a"];
	assert.equal(task.status, "VERIFIED");
	assert.equal(task.attempt, 2, "fix is an attempt on the original task");
	assert.equal(runtime.getState().teams.default.executionTasks["task-b"].status, "READY");
	assert.equal(Object.keys(runtime.getState().teams.default.executionTasks).length, PLAN.tasks.length);
});

test("invalid execution report holds ownership and requires explicit recovery", async () => {
	const compatibility = new FakeCompatibility();
	compatibility.outputsByMember["coder-a"] = "Implementation prose without an envelope.";
	let uuid = 0;
	const runtime = new TeamRuntime(compatibility, () => NOW, () => `session-${++uuid}`, () => new FakeDashboard());
	const ctx = context({ mode: "json" });
	await registerPlan(runtime, ctx);
	const result = await runtime.execute({ action: "run", taskId: "task-a", background: false }, ctx);
	assert.equal(runtime.getState().teams.default.executionTasks["task-a"].status, "REPORT_INVALID");
	assert.equal(result.details.results?.[0].delta?.changed.status, "REPORT_INVALID");
	assert.match(runtime.getState().teams.default.executionTasks["task-a"].lastIssue ?? "", /Final non-empty line/u);
	assert.equal(runtime.getState().teams.default.executionTasks["task-b"].status, "PENDING");
});

test("read-only ExpertRound records evidence without ownership or verdict changes", async () => {
	const compatibility = new FakeCompatibility();
	compatibility.outputsByMember["coder-a"] = executionReport("task-a");
	compatibility.outputsByMember.reviewer = reviewReport("review-1", [{ taskId: "task-a", verdict: "VERIFIED" }]);
	compatibility.outputsByMember.optimizer = expertReport("opt-1", "NO_CANDIDATE after scanning src/a");
	let uuid = 0;
	const runtime = new TeamRuntime(compatibility, () => NOW, () => `session-${++uuid}`, () => new FakeDashboard());
	const ctx = context({ mode: "json" });
	await registerPlan(runtime, ctx);
	await runtime.execute({ action: "run", taskId: "task-a", background: false }, ctx);
	await runtime.execute({ action: "review", reviewRoundId: "review-1", taskIds: ["task-a"], background: false }, ctx);
	await runtime.execute({ action: "expert", expertRoundId: "opt-1", expertId: "optimizer", taskIds: ["task-a"], objective: "Find low-risk candidates.", background: false }, ctx);
	const team = runtime.getState().teams.default;
	assert.equal(team.expertRounds["opt-1"].status, "COMPLETED");
	assert.equal(team.expertRounds["opt-1"].summary, "NO_CANDIDATE after scanning src/a");
	assert.equal(team.executionTasks["task-a"].status, "VERIFIED");
});

test("planned background completion sends compact delta and compact/full status split", async () => {
	const compatibility = new FakeCompatibility();
	compatibility.outputsByMember["coder-a"] = `PRIVATE BODY MUST NOT BE IN DELTA\n${JSON.stringify({ agent_team_report: { type: "execution", taskId: "task-a", status: "SUBMITTED", summary: "short public summary", evidence: [], requests: [{ kind: "question", text: "Leader choose next review batch." }] } })}`;
	let uuid = 0;
	const runtime = new TeamRuntime(compatibility, () => NOW, () => `session-${++uuid}`, () => new FakeDashboard());
	const ctx = context({ mode: "json" });
	await registerPlan(runtime, ctx);
	await runtime.execute({ action: "run", taskId: "task-a", background: true }, ctx);
	await waitFor(() => ctx.messages.length === 1);
	assert.match(ctx.messages[0].message.content, /execution\/task-a -> SUBMITTED/u);
	assert.match(ctx.messages[0].message.content, /short public summary/u);
	assert.match(ctx.messages[0].message.content, /Leader choose next review batch/u);
	assert.doesNotMatch(ctx.messages[0].message.content, /PRIVATE BODY/u);
	assert.deepEqual(Object.keys(ctx.messages[0].message.details as object), ["delta"]);
	const compact = await runtime.execute({ action: "status" }, ctx);
	assert.equal(compact.details.state, undefined);
	assert.match(compact.content[0].text, /Task counts/u);
	assert.doesNotMatch(compact.content[0].text, /Implement task A objective/u);
	const full = await runtime.execute({ action: "status", full: true }, ctx);
	assert.ok(full.details.state);
	assert.match(full.content[0].text, /Implement task A objective/u);
	assert.match(full.content[0].text, /ownedPaths/u);
	const waited = await runtime.execute({ action: "wait", member: { id: "coder-a" } }, ctx);
	assert.match(waited.details.results?.[0].output ?? "", /PRIVATE BODY/u, "wait explicitly collects the full result");
});

test("planned workspace is minimal and only Pi native auto-compaction remains wired", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pi-agent-team-planned-workspace-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const compatibility = new FakeCompatibility();
	compatibility.outputsByMember["coder-a"] = executionReport("task-a");
	compatibility.contextUsage = { tokens: 9_000, contextWindow: 10_000, percent: 90 };
	let uuid = 0;
	const runtime = new TeamRuntime(compatibility, () => NOW, () => `session-${++uuid}`, () => new FakeDashboard());
	const ctx = context({ cwd: dir, mode: "json" });
	await registerPlan(runtime, ctx);
	const workspace = join(dir, ".pi", "agent-team", "default");
	assert.match(await readFile(join(workspace, "leader", "plan.md"), "utf8"), /Revision: 1/u);
	for (const member of PLAN.members) assert.ok((await stat(join(workspace, "members", member.id, "identity.md"))).isFile());
	await assert.rejects(readFile(join(workspace, "brief.md")), /ENOENT/u);
	await assert.rejects(readFile(join(workspace, "leader", "roster.md")), /ENOENT/u);
	await assert.rejects(stat(join(workspace, "notes")), /ENOENT/u);
	await runtime.execute({ action: "run", taskId: "task-a", background: false }, ctx);
	const client = compatibility.clients[0];
	assert.deepEqual(client.setAutoCompactionCalls, [true]);
	assert.equal(client.manualCompactionCalls.length, 0, "settled runs never invoke orchestrator-side compaction");
	assert.deepEqual(await readdir(join(workspace, "members", "coder-a")), ["identity.md"]);
});
