import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { PiCompatibilityAdapter, type CompactionResultLike, type RpcClientLike, type RpcStats } from "./compat.ts";
import { AgentTeamParams } from "./schema.ts";
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
	MAX_CONCURRENCY,
	migrateState,
	normalizeOwnedPath,
	parseReportEnvelope,
	pathsConflict,
	STATE_ENTRY_TYPE,
	STATE_SCHEMA_VERSION,
	THINKING_LEVELS,
	TeamRuntime,
	validateToolRequest,
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
	startError?: Error;
	promptError?: Error;
	promptGate?: () => Promise<void>;
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
	readonly order: string[];

	readonly sessionId: string;
	readonly order: string[];

	constructor(sessionId: string, order: string[] = []) {
		this.sessionId = sessionId;
		this.order = order;
	}

	async start(): Promise<void> {
		this.startCalls++;
		this.order.push(`start:${this.sessionId}`);
		if (this.startError) throw this.startError;
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
		await this.promptGate?.();
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
	instructionsSeen: string[] = [];
	toolsSeen: string[][] = [];
	outputFor?: string;
	outputsByMember: Record<string, string> = {};
	roundOutputsByMember: Record<string, string[]> = {};
	contextUsage?: RpcStats["contextUsage"];
	startErrorsByMember: Record<string, Error> = {};
	promptErrorsByMember: Record<string, Error> = {};
	promptGatesByMember: Record<string, () => Promise<void>> = {};
	promptError?: Error;
	stateModel?: string;
	stateThinkingLevel?: string;
	ignoreModelUpdates = false;
	ignoreThinkingUpdates = false;

	readonly order: string[];

	constructor(order: string[] = []) {
		this.order = order;
	}

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
		this.instructionsSeen.push(member.instructions);
		this.toolsSeen.push([...member.tools]);
		const client = new FakeClient(member.sessionId, this.order);
		if (this.outputFor) client.output = this.outputFor;
		if (this.outputsByMember[member.id]) client.output = this.outputsByMember[member.id];
		if (this.roundOutputsByMember[member.id]) client.roundOutputs = [...this.roundOutputsByMember[member.id]];
		client.contextUsage = this.contextUsage;
		client.startError = this.startErrorsByMember[member.id];
		client.promptError = this.promptErrorsByMember[member.id] ?? this.promptError;
		client.promptGate = this.promptGatesByMember[member.id];
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

	readonly order: string[];

	constructor(order: string[] = []) {
		this.order = order;
	}

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
	assert.match(html, /\.status-badge\s*\{[^}]*border-radius:\s*999px/u);
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

// ---------------------------------------------------------------------------
// Planned-only control-plane regression code. The legacy payload appears only
// in an explicit rejection fixture; no test creates or dispatches ad-hoc work.
// ---------------------------------------------------------------------------

test("set-auto authorizes only plan gates for the current runtime session", async () => {
	const compatibility = new FakeCompatibility();
	let confirmations = 0;
	let uuid = 0;
	const runtime = new TeamRuntime(compatibility, () => NOW, () => `session-${++uuid}`, () => new FakeDashboard());
	const headless = context({
		mode: "json",
		hasUI: false,
		confirm: async () => { confirmations++; return true; },
	});
	await runtime.execute({ action: "set-auto", auto: true }, headless);
	await runtime.execute({ action: "plan", plan: PLAN }, headless);
	const amended = structuredClone(PLAN);
	amended.tasks.push({
		id: "task-c",
		memberId: "coder-a",
		objective: "Implement task C.",
		dependsOn: ["task-a"],
		ownedPaths: ["src/c"],
		acceptance: ["C is complete."],
	});
	await runtime.execute({ action: "plan", expectedRevision: 1, plan: amended }, headless);
	assert.equal(confirmations, 0, "auto skips initial and amendment USER_GATEs");
	assert.equal(compatibility.createCalls, 0, "auto never dispatches a member");
	assert.equal(runtime.getState().teams.default.plan?.revision, 2);
	assert.equal(runtime.getState().teams.default.executionTasks["task-c"].status, "PENDING");

	await runtime.execute({ action: "set-auto", auto: false }, headless);
	const next = structuredClone(amended);
	next.acceptance.push("Human acceptance remains external.");
	// Same-roster amendment: re-dispatching existing members needs no fresh consent.
	const silent = context({ mode: "rpc", hasUI: true, confirm: async () => { confirmations++; return true; } });
	await runtime.execute({ action: "plan", expectedRevision: 2, plan: next }, silent);
	assert.equal(confirmations, 0, "same-roster amendments skip the USER_GATE");
	// Roster growth (new member) still requires explicit consent with auto off.
	const grown = structuredClone(next);
	grown.members.push({ id: "auditor", kind: "reviewer", role: "Audit only.", instructions: "Read-only audit.", tools: ["read"] });
	const gated = context({ mode: "rpc", hasUI: true, confirm: async () => { confirmations++; return true; } });
	await runtime.execute({ action: "plan", expectedRevision: 3, plan: grown }, gated);
	assert.equal(confirmations, 1, "roster growth keeps its USER_GATE with auto off");

	const restored = new TeamRuntime(new FakeCompatibility(), () => NOW, () => "unused", () => new FakeDashboard());
	restored.restoreFromBranch([{ type: "custom", customType: STATE_ENTRY_TYPE, data: runtime.getState() }]);
	const status = await restored.execute({ action: "status" }, context({ mode: "json", hasUI: false }));
	assert.doesNotMatch(status.content[0].text, /Automatic plan authorization: ON/u);
	// Authorization never persists; a further roster growth without set-auto is refused headlessly.
	const grownPlus = structuredClone(grown);
	grownPlus.members.push({ id: "auditor2", kind: "reviewer", role: "Second audit.", instructions: "Read-only audit.", tools: ["read"] });
	const noGate = await restored.execute(
		{ action: "plan", expectedRevision: 4, plan: grownPlus },
		context({ mode: "json", hasUI: false }),
	);
	assert.equal(noGate.details.cancelled, true, "authorization does not survive runtime restore");
	assert.equal(restored.getState().teams.default.plan?.revision, 4);
});

test("legacy inline payloads are absent from schema and rejected while old state remains operable", async () => {
	assert.equal("task" in AgentTeamParams.properties, false);
	assert.equal("tasks" in AgentTeamParams.properties, false);
	const legacyState = stateWithMembers({ reviewer: existingMember("legacy-session") });
	assert.throws(
		() => validateToolRequest(
			{ action: "run", member: { id: "reviewer" }, task: "legacy" } as unknown as Parameters<typeof validateToolRequest>[0],
			legacyState,
		),
		/Legacy inline member\/task\/tasks dispatch/u,
	);
	assert.throws(
		() => validateToolRequest(
			{ action: "parallel", tasks: [] } as unknown as Parameters<typeof validateToolRequest>[0],
			legacyState,
		),
		/Legacy inline member\/task\/tasks dispatch/u,
	);
	assert.throws(() => validateToolRequest({ action: "run", taskId: "x" }, legacyState), /requires a registered plan/u);

	const runtime = new TeamRuntime(new FakeCompatibility(), () => NOW, () => "unused", () => new FakeDashboard());
	runtime.restoreFromBranch([{ type: "custom", customType: STATE_ENTRY_TYPE, data: legacyState }]);
	assert.match((await runtime.execute({ action: "status" }, context())).content[0].text, /legacy-state \(dispatch disabled\)/u);
	const idleStop = await runtime.execute({ action: "stop", member: { id: "reviewer" } }, context());
	assert.match(idleStop.content[0].text, /No active run to stop: reviewer/u, "stopping an idle member says so explicitly");
	await runtime.execute({ action: "kill", member: { id: "reviewer" } }, context());
	const member = runtime.getState().teams.default.members.reviewer;
	assert.equal(member.sessionId, "legacy-session");
	assert.equal(member.status, "STOPPED");
	assert.equal(runtime.getState().teams.default.plan, undefined);
});

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
				assert.equal(result.terminate, undefined);
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

test("plan confirmation lists every task in full now that detail truncation is removed", async () => {
	const manyTasks = structuredClone(PLAN);
	manyTasks.tasks = Array.from({ length: 55 }, (_, index) => ({
		id: `task-${index}`,
		memberId: "coder-a",
		objective: `Objective ${index}`,
		dependsOn: [],
		ownedPaths: [`src/task-${index}`],
		acceptance: [`Task ${index} accepted.`],
	}));
	let confirmation = "";
	const runtime = new TeamRuntime(new FakeCompatibility(), () => NOW, () => "session-1", () => new FakeDashboard());
	await runtime.execute(
		{ action: "plan", plan: manyTasks },
		context({ confirm: async (_title, message) => { confirmation = message; return true; } }),
	);
	assert.match(confirmation, /## Execution DAG \(55 tasks\)/u);
	assert.match(confirmation, /- \*\*task-0\*\* → coder-a\n  Objective 0\n  depends: none · owns: src\/task-0\n  acceptance: Task 0 accepted\./u);
	assert.match(confirmation, /- \*\*task-54\*\* → coder-a\n  Objective 54/u);
	assert.doesNotMatch(confirmation, /more tasks/u);
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

test("planned batches leave no partial RUNNING state on Dashboard, client, or prompt failure", async (t) => {
	const independent = structuredClone(PLAN);
	independent.tasks[1].dependsOn = [];

	await t.test("Dashboard", async () => {
		const compatibility = new FakeCompatibility();
		const dashboard = new FakeDashboard();
		const runtime = new TeamRuntime(compatibility, () => NOW, undefined, () => dashboard);
		const ctx = context({ mode: "rpc" });
		await registerPlan(runtime, ctx, independent);
		dashboard.failPrepare = new DashboardUnavailableError("DASHBOARD_UNAVAILABLE: test failure");
		await assert.rejects(runtime.execute({ action: "parallel", taskIds: ["task-a", "task-b"] }, ctx), /DASHBOARD_UNAVAILABLE/u);
		assert.equal(compatibility.createCalls, 0);
		assert.deepEqual(Object.values(runtime.getState().teams.default.executionTasks).map((task) => task.status), ["READY", "READY"]);
	});

	await t.test("client startup", async () => {
		const compatibility = new FakeCompatibility();
		compatibility.startErrorsByMember["coder-b"] = new Error("client start failed");
		const runtime = new TeamRuntime(compatibility, () => NOW, undefined, () => new FakeDashboard());
		const ctx = context({ mode: "rpc" });
		await registerPlan(runtime, ctx, independent);
		await assert.rejects(runtime.execute({ action: "parallel", taskIds: ["task-a", "task-b"] }, ctx), /client start failed/u);
		assert.equal(compatibility.clients.flatMap((client) => client.promptCalls).length, 0);
		assert.equal(Object.values(runtime.getState().teams.default.executionTasks).some((task) => task.status === "RUNNING"), false);
		assert.equal(Object.values(runtime.getState().teams.default.members).some((member) => member.status === "RUNNING"), false);
	});

	await t.test("prompt acceptance", async () => {
		const compatibility = new FakeCompatibility();
		compatibility.blockIdle = true;
		compatibility.promptErrorsByMember["coder-b"] = new Error("prompt transport failed");
		const runtime = new TeamRuntime(compatibility, () => NOW, undefined, () => new FakeDashboard(), () => 60_000);
		const ctx = context({ mode: "rpc" });
		await registerPlan(runtime, ctx, independent);
		await assert.rejects(runtime.execute({ action: "parallel", taskIds: ["task-a", "task-b"] }, ctx), /prompt transport failed/u);
		const team = runtime.getState().teams.default;
		assert.equal(Object.values(team.executionTasks).some((task) => task.status === "RUNNING"), false);
		assert.equal(Object.values(team.members).some((member) => member.status === "RUNNING"), false);
		assert.deepEqual(Object.values(team.executionTasks).map((task) => task.status), ["BLOCKED", "BLOCKED"]);
		assert.equal(compatibility.clients[0].abortCalls, 1, "accepted peer is interrupted before batch failure returns");
	});

	await t.test("an 8-task prompt failure stops the first wave and blocks every activated target", async () => {
		const plan: PlanInput = {
			members: [
				...Array.from({ length: 8 }, (_, index) => ({
					id: `coder-${index}`,
					kind: "coder" as const,
					role: `Coder ${index}`,
					instructions: `Implement task ${index}.`,
				})),
				{ id: "reviewer", kind: "reviewer", role: "Reviewer", instructions: "Review only.", tools: ["read"] },
			],
			reviewerId: "reviewer",
			tasks: Array.from({ length: 8 }, (_, index) => ({
				id: `task-${index}`,
				memberId: `coder-${index}`,
				objective: `Implement task ${index}.`,
				constraints: [],
				dependsOn: [],
				ownedPaths: [`src/task-${index}`],
				acceptance: [`Task ${index} is complete.`],
				relevantPaths: [`src/task-${index}/index.ts`],
			})),
			acceptance: ["All tasks are verified."],
		};
		const compatibility = new FakeCompatibility();
		compatibility.blockIdle = true;
		compatibility.promptErrorsByMember["coder-1"] = new Error("first wave prompt failed");
		let arrivals = 0;
		let release: () => void = () => undefined;
		const firstWave = new Promise<void>((resolve) => {
			release = resolve;
		});
		for (let index = 0; index < MAX_CONCURRENCY; index++) {
			compatibility.promptGatesByMember[`coder-${index}`] = async () => {
				arrivals++;
				if (arrivals === MAX_CONCURRENCY) release();
				await firstWave;
			};
		}
		const runtime = new TeamRuntime(compatibility, () => NOW, undefined, () => new FakeDashboard(), () => 60_000);
		const ctx = context({ mode: "rpc" });
		await registerPlan(runtime, ctx, plan);
		await assert.rejects(
			runtime.execute({ action: "parallel", taskIds: plan.tasks.map((task) => task.id) }, ctx),
			/first wave prompt failed/u,
		);
		assert.equal(arrivals, MAX_CONCURRENCY);
		assert.deepEqual(compatibility.clients.slice(0, MAX_CONCURRENCY).map((client) => client.promptCalls.length), [1, 1, 1, 1]);
		assert.deepEqual(compatibility.clients.slice(MAX_CONCURRENCY).map((client) => client.promptCalls.length), [0, 0, 0, 0]);
		assert.equal(
			compatibility.clients.slice(0, MAX_CONCURRENCY).filter((_, index) => index !== 1).every((client) => client.abortCalls === 1),
			true,
			"accepted peers are interrupted before execute rejects",
		);
		const team = runtime.getState().teams.default;
		assert.equal(Object.values(team.members).some((member) => member.status === "RUNNING" || member.status === "STARTING"), false);
		assert.equal(Object.values(team.executionTasks).every((task) => task.status === "BLOCKED"), true);
		assert.equal(
			[...Object.values(team.reviewRounds), ...Object.values(team.expertRounds)].some((round) => round.status === "RUNNING"),
			false,
		);
	});
});

test("planned stop and kill preserve the Session while moving the active task to explicit recovery", async () => {
	const compatibility = new FakeCompatibility();
	compatibility.blockIdle = true;
	let uuid = 0;
	const runtime = new TeamRuntime(compatibility, () => NOW, () => `session-${++uuid}`, () => new FakeDashboard(), () => 60_000);
	const ctx = context({ mode: "json" });
	await registerPlan(runtime, ctx, { ...PLAN, members: PLAN.members.slice(0, 3) });
	const sessionId = runtime.getState().teams.default.members["coder-a"].sessionId;
	await runtime.execute({ action: "run", taskId: "task-a" }, ctx);
	await runtime.execute({ action: "stop", member: { id: "coder-a" } }, ctx);
	let state = runtime.getState();
	assert.equal(state.teams.default.members["coder-a"].sessionId, sessionId);
	assert.equal(state.teams.default.members["coder-a"].status, "INTERRUPTED");
	assert.equal(state.teams.default.executionTasks["task-a"].status, "BLOCKED");

	await runtime.execute({ action: "run", taskId: "task-a" }, ctx);
	await runtime.execute({ action: "kill", member: { id: "coder-a" } }, ctx);
	state = runtime.getState();
	assert.equal(state.teams.default.members["coder-a"].sessionId, sessionId);
	assert.equal(state.teams.default.members["coder-a"].status, "STOPPED");
	assert.equal(state.teams.default.executionTasks["task-a"].status, "CANCELED");
});

test("member system prompt contains fixed local instructions but no legacy or global coordination context", async () => {
	let options: any;
	const adapter = new PiCompatibilityAdapter({
		version: "0.82.1",
		cliPath: "/tmp/pi-test-cli",
		listSessions: async () => [],
		factory: (value) => {
			options = value;
			return new FakeClient("session-1");
		},
	});
	const handle = await adapter.createMemberClient({
		team: "default",
		id: "coder-a",
		role: "Coder",
		instructions: "Only implement the dispatched local task.",
		sessionId: "session-1",
		model: { provider: "test", id: "model" },
		thinking: "medium",
		tools: ["read", "edit"],
		cwd: isolatedCwd(),
		trusted: true,
	});
	try {
		const promptPath = options.args[options.args.indexOf("--append-system-prompt") + 1];
		const prompt = await readFile(promptPath, "utf8");
		assert.match(prompt, /Only implement the dispatched local task/u);
		assert.match(prompt, /current runtime dispatch and its local TaskPacket/u);
		assert.doesNotMatch(prompt, /brief\.md|roster\.md|notes\/|peer|global acceptance|parent conversation history:/u);
	} finally {
		await handle.cleanupPrompt();
	}
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

test("only a final review receives global acceptance", async () => {
	const plan = structuredClone(PLAN);
	plan.tasks = [plan.tasks[0]];
	const compatibility = new FakeCompatibility();
	compatibility.outputsByMember["coder-a"] = executionReport("task-a");
	compatibility.outputsByMember.reviewer = reviewReport("final-review", [{ taskId: "task-a", verdict: "VERIFIED" }]);
	const runtime = new TeamRuntime(compatibility, () => NOW, undefined, () => new FakeDashboard());
	const ctx = context({ mode: "json" });
	await registerPlan(runtime, ctx, plan);
	await runtime.execute({ action: "run", taskId: "task-a", background: false }, ctx);
	assert.doesNotMatch(compatibility.clients[0].promptCalls[0], /Global acceptance marker/u);
	await runtime.execute({ action: "review", reviewRoundId: "final-review", taskIds: ["task-a"], background: false }, ctx);
	assert.match(compatibility.clients[1].promptCalls[0], /"globalAcceptance"/u);
	assert.match(compatibility.clients[1].promptCalls[0], /Global acceptance marker/u);
	assert.deepEqual(runtime.getState().teams.default.plan?.acceptance, ["Global acceptance marker."]);
});

test("background planned review and expert dispatches terminate while their members remain RUNNING", async () => {
	const compatibility = new FakeCompatibility();
	compatibility.outputsByMember["coder-a"] = executionReport("task-a");
	compatibility.outputsByMember.reviewer = reviewReport("review-1", [{ taskId: "task-a", verdict: "VERIFIED" }]);
	compatibility.outputsByMember.optimizer = expertReport("expert-1");
	let uuid = 0;
	const runtime = new TeamRuntime(compatibility, () => NOW, () => `session-${++uuid}`, () => new FakeDashboard(), () => 60_000);
	const ctx = context({ mode: "json" });
	await registerPlan(runtime, ctx);
	await runtime.execute({ action: "run", taskId: "task-a", background: false }, ctx);

	compatibility.blockIdle = true;
	const review = await runtime.execute({ action: "review", reviewRoundId: "review-1", taskIds: ["task-a"] }, ctx);
	assert.equal(review.terminate, true);
	assert.equal(review.details.results?.[0].status, "RUNNING");
	assert.equal(runtime.getState().teams.default.members.reviewer.status, "RUNNING");
	compatibility.clients[1].completeIdle();
	await waitFor(() => runtime.getState().teams.default.executionTasks["task-a"].status === "VERIFIED");

	const expert = await runtime.execute({
		action: "expert",
		expertRoundId: "expert-1",
		expertId: "optimizer",
		taskIds: ["task-a"],
		objective: "Inspect verified evidence.",
	}, ctx);
	assert.equal(expert.terminate, true);
	assert.equal(expert.details.results?.[0].status, "RUNNING");
	assert.equal(runtime.getState().teams.default.members.optimizer.status, "RUNNING");
	compatibility.clients[2].completeIdle();
	await waitFor(() => runtime.getState().teams.default.expertRounds["expert-1"].status === "COMPLETED");
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
	assert.doesNotMatch(compatibility.clients[1].promptCalls[0], /globalAcceptance|Global acceptance marker/u);
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
	const dispatch = await runtime.execute({ action: "run", taskId: "task-a", background: true }, ctx);
	assert.equal(dispatch.terminate, true);
	await waitFor(() => ctx.messages.length === 1);
	assert.deepEqual(ctx.messages[0].options, { triggerTurn: true, deliverAs: "followUp" });
	assert.equal(ctx.snapshots.at(-1)?.teams.default.executionTasks["task-a"].status, "SUBMITTED", "completion is persisted before notification");
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
	assert.equal(waited.terminate, undefined);
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

test("inline markdown renderer keeps fences, envelopes, list numbering, and quotes", async () => {
	const html = await readFile(new URL("./web-dashboard.html", import.meta.url), "utf8");
	const extractSource = (name: string): string => {
		const at = html.indexOf(`const ${name} = `);
		assert.ok(at >= 0, `extracts ${name} from inline script`);
		let depth = 0;
		let end = -1;
		for (let i = html.indexOf("{", at); i < html.length; i += 1) {
			if (html[i] === "{") depth += 1;
			else if (html[i] === "}") {
				depth -= 1;
				if (depth === 0) {
					end = i;
					break;
				}
			}
		}
		assert.ok(end > at, `closes ${name}`);
		return html.slice(at, end + 1);
	};
	const shimText = (value: string): any => ({
		nodeType: 3,
		text: value,
		childNodes: [],
		append: () => {},
		get textContent() {
			return this.text;
		},
	});
	const shimElement = (tagName: string): any => {
		const el: any = {
			tagName: tagName.toUpperCase(),
			className: "",
			childNodes: [],
			append(...kids: any[]) {
				el.childNodes.push(...kids);
			},
		};
		Object.defineProperty(el, "lastChild", { get: () => el.childNodes.at(-1) ?? null });
		Object.defineProperty(el, "textContent", {
			get: () => el.childNodes.map((child: any) => child.textContent).join(""),
			set: (value: string) => {
				el.childNodes.push(shimText(value));
			},
		});
		return el;
	};
	const shimDocument = {
		createElement: (tag: string) => shimElement(tag),
		createTextNode: (value: string) => shimText(value),
	};
	const loadRenderer = () => {
		const source = ["splitInline", "appendInline", "renderMarkdown"].map(extractSource).join("\n");
		return new Function("document", `"use strict";\n${source}\nreturn { splitInline, appendInline, renderMarkdown };`)(shimDocument);
	};
	const render = (input: string) => loadRenderer().renderMarkdown(input).childNodes;

	// (a) fenced json block becomes pre>code.lang-json with indentation preserved verbatim
	const fenced = render("before\n```json\n{\n  \"kept\": \"  indent\"\n}\n```\nafter");
	assert.equal(fenced.length, 3);
	assert.equal(fenced[0].tagName, "P");
	assert.equal(fenced[1].tagName, "PRE");
	assert.equal(fenced[1].childNodes[0].tagName, "CODE");
	assert.equal(fenced[1].childNodes[0].className, "lang-json");
	assert.equal(fenced[1].childNodes[0].textContent, '{\n  "kept": "  indent"\n}\n');
	assert.equal(fenced[2].tagName, "P");

	// (b) single-line agent_team_report envelope becomes pre>code.lang-json; unparseable lookalike stays prose
	const envelopeLine = '{"agent_team_report":{"type":"execution","taskId":"task-a","status":"SUBMITTED","summary":"s","evidence":[],"requests":[]}}';
	const enveloped = render(`body line\n${envelopeLine}`);
	assert.equal(enveloped.length, 2);
	assert.equal(enveloped[1].tagName, "PRE");
	assert.equal(enveloped[1].childNodes[0].className, "lang-json");
	assert.equal(enveloped[1].childNodes[0].textContent, envelopeLine);
	const malformed = render('{"agent_team_report": definitely not json}');
	assert.equal(malformed.length, 1);
	assert.equal(malformed[0].tagName, "P");

	// (c) ordered lists keep source numbering via start; plain prose terminates the list
	const ordered = render("intro\n3. third\n4. fourth\nprose breaks it\n9. ninth");
	assert.equal(ordered.length, 4);
	assert.equal(ordered[0].tagName, "P");
	assert.equal(ordered[1].tagName, "OL");
	assert.equal(ordered[1].start, 3);
	assert.deepEqual(ordered[1].childNodes.map((li: any) => li.textContent), ["third", "fourth"]);
	assert.equal(ordered[2].tagName, "P");
	assert.equal(ordered[3].tagName, "OL");
	assert.equal(ordered[3].start, 9);

	// (d) consecutive "> " lines merge into a single blockquote
	const quoted = render("> first quoted\n> second quoted");
	assert.equal(quoted.length, 1);
	assert.equal(quoted[0].tagName, "BLOCKQUOTE");
	assert.equal(quoted[0].textContent, "first quoted\nsecond quoted");
});
