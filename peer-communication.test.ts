import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PiCompatibilityAdapter, type RpcClientLike, type RpcStats } from "./compat.ts";
import memberCommunication from "./member-communication.ts";
import { startPeerBridge } from "./peer-bridge.ts";
import {
	DEFAULT_PEER_INBOX,
	MAX_PEER_ANSWER_CHARS,
	PEER_EXTENSION_ENV,
	PEER_MARKER,
	PEER_TOKEN_ENV,
	PEER_TOKEN_HEADER,
	PEER_URL_ENV,
} from "./peer-protocol.ts";
import type { CompatibilityPort, PlanInput, RuntimeContext, TeamState } from "./runtime.ts";
import type { DashboardCommunication, DashboardCommunicationPhase, TeamDashboard } from "./web-dashboard.ts";
import { memberExtensionPath, TeamRuntime } from "./runtime.ts";

const NOW = "2026-08-01T00:00:00.000Z";
const MARKER = PEER_MARKER;

const PLAN: PlanInput = {
	members: [
		{ id: "coder-a", kind: "coder", role: "实现 A", instructions: "实现 A 任务。" },
		{ id: "coder-b", kind: "coder", role: "实现 B", instructions: "实现 B 任务。" },
		{ id: "reviewer", kind: "reviewer", role: "评审", instructions: "只读评审。", tools: ["read"] },
	],
	reviewerId: "reviewer",
	tasks: [
		{ id: "task-a", memberId: "coder-a", objective: "实现 A。", ownedPaths: ["src/a"], acceptance: ["A 完成"] },
		{ id: "task-b", memberId: "coder-b", objective: "实现 B。", ownedPaths: ["src/b"], acceptance: ["B 完成"] },
	],
	acceptance: ["整体验收"],
};

function stats(assistantMessages = 0): RpcStats {
	return {
		assistantMessages,
		tokens: { input: assistantMessages * 10, output: assistantMessages * 5, cacheRead: 0, cacheWrite: 0 },
		cost: 0,
	};
}

class FakeClient implements RpcClientLike {
	promptCalls: string[] = [];
	steerCalls: string[] = [];
	abortCalls = 0;
	stopCalls = 0;
	listeners = new Set<(event: any) => void>();
	output = "peer answer body";
	stateModel?: string;
	stateThinkingLevel = "medium";
	promptError?: Error;
	promptGate?: () => Promise<void>;
	preflightReject = false;
	skipPreflight = false;
	/** 追加的 assistant 回合数（用于验证一问一答的回合上限）。 */
	extraTurns = 0;
	/** 结算前置：即使在 gate 未释放时也能被 abort 结算。 */
	abortSettles = true;
	private turns = 0;
	readonly sessionId: string;

	constructor(sessionId: string) {
		this.sessionId = sessionId;
	}

	async start(): Promise<void> {}
	async stop(): Promise<void> {
		this.stopCalls++;
	}
	onEvent(listener: (event: any) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
	async prompt(message: string, options?: { preflightResult?: (success: boolean) => void }): Promise<void> {
		this.promptCalls.push(message);
		if (!this.skipPreflight) options?.preflightResult?.(!this.preflightReject);
		if (this.preflightReject) return;
		await this.promptGate?.();
		if (this.promptError) throw this.promptError;
		this.turns++;
		this.emitAnswer();
		this.emit({ type: "agent_settled" });
	}
	private emitAnswer(): void {
		const slash = this.stateModel?.indexOf("/") ?? -1;
		this.emit({
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: this.output }],
				...(this.stateModel && slash > 0
					? { provider: this.stateModel.slice(0, slash), model: this.stateModel.slice(slash + 1) }
					: {}),
				stopReason: "stop",
			},
		});
		for (let index = 0; index < this.extraTurns; index++) {
			this.turns++;
			this.emit({
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: `${this.output} #${index + 2}` }],
					...(this.stateModel && slash > 0
						? { provider: this.stateModel.slice(0, slash), model: this.stateModel.slice(slash + 1) }
						: {}),
					stopReason: "stop",
				},
			});
		}
	}
	async waitForIdle(): Promise<void> {}
	async abort(): Promise<void> {
		this.abortCalls++;
		// 中断后立即结算，避免自动化测试等待 idle timeout。
		if (this.abortSettles) this.emit({ type: "agent_settled" });
	}
	async steer(message: string): Promise<void> {
		this.steerCalls.push(message);
	}
	async setModel(): Promise<unknown> {
		return {};
	}
	async setThinkingLevel(): Promise<void> {}
	async getState(): Promise<{ sessionId: string; sessionName?: string; model?: string; thinkingLevel?: string }> {
		return {
			sessionId: this.sessionId,
			sessionName: `team:default/${this.sessionId}`,
			thinkingLevel: this.stateThinkingLevel,
			...(this.stateModel ? { model: this.stateModel } : {}),
		};
	}
	async setSessionName(): Promise<void> {}
	async getSessionStats(): Promise<RpcStats> {
		return stats(this.turns);
	}
	async getLastAssistantText(): Promise<string | null> {
		return this.turns > 0 ? this.output : null;
	}
	async compact(): Promise<any> {
		return { summary: "", firstKeptEntryId: "", tokensBefore: 0, estimatedTokensAfter: 0 };
	}
	async setAutoCompaction(): Promise<void> {}
	emit(event: any): void {
		for (const listener of this.listeners) listener(event);
	}
}

class FakeCompatibility implements CompatibilityPort {
	clients = new Map<string, FakeClient>();
	membersSeen: any[] = [];
	roundOutputsByMember: Record<string, string[]> = {};
	preflightRejectByMember: Record<string, boolean> = {};
	skipPreflightByMember: Record<string, boolean> = {};
	extraTurnsByMember: Record<string, number> = {};
	promptGatesByMember: Record<string, () => Promise<void>> = {};
	/** 所有测试 gate 的释放函数：失败路径的 finally 也必须释放，避免挂起异步操作。 */
	gates = new Map<string, () => void>();

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
		this.membersSeen.push(structuredClone({ ...member, instructions: member.instructions }));
		const client = new FakeClient(member.sessionId ?? `session-${member.id}`);
		client.stateModel = `${member.model.provider}/${member.model.id}`;
		client.stateThinkingLevel = member.thinking;
		client.output = this.roundOutputsByMember[member.id]?.[0] ?? client.output;
		client.preflightReject = this.preflightRejectByMember[member.id] ?? false;
		client.skipPreflight = this.skipPreflightByMember[member.id] ?? false;
		client.extraTurns = this.extraTurnsByMember[member.id] ?? 0;
		client.promptGate = this.promptGatesByMember[member.id];
		this.clients.set(member.id, client);
		return { client, cleanupPrompt: async () => undefined };
	}
}

function context(overrides: Partial<RuntimeContext> = {}): RuntimeContext & {
	snapshots: TeamState[];
	messages: Array<{ message: { customType: string; content: string; details?: unknown } }>;
} {
	const snapshots: TeamState[] = [];
	const messages: Array<{ message: { customType: string; content: string; details?: unknown } }> = [];
	return {
		cwd: join(tmpdir(), "pi-agent-team-peer"),
		mode: "json",
		model: { provider: "test", id: "model" },
		thinking: "medium",
		trusted: true,
		hasUI: false,
		parentPersisted: true,
		capabilities: { appendEntry: true, getBranch: true },
		confirm: async () => true,
		appendSnapshot: (snapshot) => snapshots.push(structuredClone(snapshot)),
		sendParentMessage: (message) => messages.push({ message }),
		snapshots,
		messages,
		...overrides,
	};
}

async function waitFor(predicate: () => boolean, label = "condition"): Promise<void> {
	for (let attempt = 0; attempt < 400; attempt++) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error(`Timed out waiting for ${label}.`);
}

function peerOf(compatibility: FakeCompatibility, memberId: string): { url: string; token: string; extension: string } {
	const seen = compatibility.membersSeen.filter((member) => member.id === memberId).at(-1);
	if (!seen?.peer?.url) throw new Error(`No peer channel was issued for ${memberId}.`);
	return seen.peer;
}

async function post(
	peer: { url: string; token: string },
	payload: Record<string, unknown>,
): Promise<{ status: number; body: any }> {
	const response = await fetch(peer.url, {
		method: "POST",
		headers: { "content-type": "application/json", [PEER_TOKEN_HEADER]: peer.token },
		body: JSON.stringify(payload),
	});
	return { status: response.status, body: (await response.json()) as any };
}

/** 在测试进程里显式打开互通通道（默认按绝对路径解析，测试里必须显式覆盖）。 */
function withPeerExtension<T>(run: () => Promise<T>): Promise<T> {
	const previous = process.env[PEER_EXTENSION_ENV];
	process.env[PEER_EXTENSION_ENV] = join(process.cwd(), "member-communication.ts");
	return run().finally(() => {
		if (previous === undefined) delete process.env[PEER_EXTENSION_ENV];
		else process.env[PEER_EXTENSION_ENV] = previous;
	});
}

async function registered(compatibility: FakeCompatibility, ctx: RuntimeContext, plan: PlanInput = PLAN, dashboard?: TeamDashboard): Promise<TeamRuntime> {
	const runtime = new TeamRuntime(compatibility, () => NOW, undefined, dashboard ? () => dashboard : undefined);
	await runtime.execute({ action: "set-auto", auto: true }, ctx);
	await runtime.execute({ action: "plan", plan }, ctx);
	return runtime;
}

/** 让某个成员的下一轮 prompt 卡住；释放函数登记在 gates 里，便于统一收尾。 */
function gateMember(compatibility: FakeCompatibility, memberId: string): void {
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	compatibility.promptGatesByMember[memberId] = () => gate;
	compatibility.gates.set(memberId, release);
}

function releaseAllGates(compatibility: FakeCompatibility): void {
	for (const release of compatibility.gates.values()) release();
}

/** 派发一个被 gate 卡住的成员：保持 RUNNING，同时已经持有本机互通的成员令牌。释放用返回的函数或 releaseAllGates。 */
async function runningMember(
	runtime: TeamRuntime,
	compatibility: FakeCompatibility,
	ctx: RuntimeContext,
	memberId: string,
	taskId: string,
): Promise<() => void> {
	gateMember(compatibility, memberId);
	void runtime.execute({ action: "run", taskId, background: false }, ctx).catch(() => undefined);
	await waitFor(
		() => compatibility.membersSeen.some((member) => member.id === memberId && member.peer?.url),
		`${memberId} peer token`,
	);
	return () => compatibility.gates.get(memberId)?.();
}

// ---------------------------------------------------------------------------
// 本机入口（传输层）
// ---------------------------------------------------------------------------

test("peer bridge authenticates tokens, restricts method/path/body, and releases the port on close", async () => {
	const seen: Array<{ team: string; member: string }> = [];
	const bridge = await startPeerBridge(async (identity, payload) => {
		seen.push(identity);
		return { status: 200, body: { ok: true, payload } };
	});
	const token = bridge.issue("default", "coder-a");
	assert.equal(new URL(bridge.url).hostname, "127.0.0.1");

	const ok = await fetch(bridge.url, {
		method: "POST",
		headers: { "content-type": "application/json", [PEER_TOKEN_HEADER]: token },
		body: JSON.stringify({ action: "members" }),
	});
	assert.equal(ok.status, 200);
	assert.deepEqual(seen, [{ team: "default", member: "coder-a" }]);

	assert.equal((await fetch(bridge.url, { method: "POST", body: "{}" })).status, 401);
	assert.equal(
		(
			await fetch(bridge.url.replace("/message", "/other"), {
				method: "POST",
				headers: { [PEER_TOKEN_HEADER]: token },
				body: "{}",
			})
		).status,
		404,
	);
	assert.equal((await fetch(bridge.url, { method: "GET", headers: { [PEER_TOKEN_HEADER]: token } })).status, 405);
	assert.equal(
		(
			await fetch(bridge.url, {
				method: "POST",
				headers: { "content-type": "application/json", [PEER_TOKEN_HEADER]: token },
				body: "not json",
			})
		).status,
		400,
	);
	assert.equal(
		(
			await fetch(bridge.url, {
				method: "POST",
				headers: { "content-type": "application/json", [PEER_TOKEN_HEADER]: token },
				body: JSON.stringify({ action: "send", text: "x".repeat(20 * 1024) }),
			})
		).status,
		413,
	);

	// 重新签发使旧令牌失效；close() 后端口不再接受连接。
	const rotated = bridge.issue("default", "coder-a");
	assert.equal((await fetch(bridge.url, { method: "POST", headers: { [PEER_TOKEN_HEADER]: token }, body: "{}" })).status, 401);
	assert.equal(
		(
			await fetch(bridge.url, {
				method: "POST",
				headers: { [PEER_TOKEN_HEADER]: rotated },
				body: JSON.stringify({ action: "members" }),
			})
		).status,
		200,
	);
	const url = bridge.url;
	await bridge.close();
	await assert.rejects(fetch(url, { method: "POST", headers: { [PEER_TOKEN_HEADER]: rotated }, body: "{}" }));
});

// ---------------------------------------------------------------------------
// 成员侧扩展：注册条件与只读通信模式
// ---------------------------------------------------------------------------

function fakeExtensionApi() {
	const handlers = new Map<string, (event: any) => any>();
	const tools: any[] = [];
	return {
		tools,
		handlers,
		api: {
			on: (event: string, handler: (payload: any) => any) => {
				handlers.set(event, handler);
			},
			registerTool: (tool: any) => tools.push(tool),
		} as any,
	};
}

test("member extension registers nothing without a peer channel and blocks mutations during a peer turn", () => {
	const urlBefore = process.env[PEER_URL_ENV];
	const tokenBefore = process.env[PEER_TOKEN_ENV];
	try {
		delete process.env[PEER_URL_ENV];
		delete process.env[PEER_TOKEN_ENV];
		const idle = fakeExtensionApi();
		memberCommunication(idle.api);
		assert.equal(idle.tools.length, 0, "没有通道时不注册任何能力");

		process.env[PEER_URL_ENV] = "http://127.0.0.1:1/message";
		process.env[PEER_TOKEN_ENV] = "token";
		const connected = fakeExtensionApi();
		memberCommunication(connected.api);
		assert.equal(connected.tools.length, 1);
		assert.equal(connected.tools[0].name, "team_message");

		const toolCall = connected.handlers.get("tool_call")!;
		const beforeAgentStart = connected.handlers.get("before_agent_start")!;
		// 成员身份块从 append 移到最后一个自定义分节，让技能与项目上下文留在共享前缀里。
		const options: any = { appendSystemPrompt: "Team: t | Member: x", sections: {} };
		beforeAgentStart({ type: "before_agent_start", prompt: "普通任务", systemPromptOptions: options });
		assert.equal(options.appendSystemPrompt, "");
		assert.equal(options.sections.member_identity, "Team: t | Member: x");
		assert.equal(toolCall({ type: "tool_call", toolName: "write" }), undefined, "普通回合不拦截写入");
		beforeAgentStart({ type: "before_agent_start", prompt: `${MARKER}\n只回答` });
		assert.equal(toolCall({ type: "tool_call", toolName: "read" }), undefined);
		for (const toolName of ["write", "edit", "bash", "team_message", "some_unknown_tool"]) {
			const block = toolCall({ type: "tool_call", toolName });
			assert.equal(block?.block, true, `${toolName} 必须在通信回合被拦截`);
			assert.match(block.reason, /只读/u);
		}
		beforeAgentStart({ type: "before_agent_start", prompt: "普通任务" });
		assert.equal(toolCall({ type: "tool_call", toolName: "write" }), undefined);
		beforeAgentStart({ type: "before_agent_start", prompt: `${MARKER} 只读` });
		connected.handlers.get("agent_settled")!({});
		assert.equal(toolCall({ type: "tool_call", toolName: "bash" }), undefined);
	} finally {
		if (urlBefore === undefined) delete process.env[PEER_URL_ENV];
		else process.env[PEER_URL_ENV] = urlBefore;
		if (tokenBefore === undefined) delete process.env[PEER_TOKEN_ENV];
		else process.env[PEER_TOKEN_ENV] = tokenBefore;
	}
});

// ---------------------------------------------------------------------------
// 启动契约：显式扩展、工具白名单、通道环境变量
// ---------------------------------------------------------------------------

test("createMemberClient loads only the member extension, appends the peer tool, and passes the channel env", async () => {
	const calls: Array<{ args: string[]; env: Record<string, string> }> = [];
	const adapter = new PiCompatibilityAdapter({
		version: "0.84.1",
		cliPath: "/fake/pi",
		capabilityOptions: { agentDir: "/nonexistent/pi-agent-team-test-agent-dir" },
		factory: (options) => {
			calls.push({ args: options.args ?? [], env: options.env ?? {} });
			return new FakeClient("session-1");
		},
		listSessions: async () => [],
	});
	const base = {
		team: "default",
		id: "reviewer",
		role: "Reviewer",
		instructions: "read only",
		sessionId: "session-1",
		model: { provider: "p", id: "m" },
		thinking: "medium",
		cwd: "/tmp/project",
		trusted: true,
	};
	const peer = {
		url: "http://127.0.0.1:1234/message",
		token: "peer-token",
		extension: "/abs/member-communication.ts",
		marker: MARKER,
	};
	const withChannel = await adapter.createMemberClient({ ...base, tools: ["read"], peer });
	const args = calls[0].args;
	const loadedExtensions = args.filter((value, index) => index > 0 && args[index - 1] === "--extension");
	assert.ok(loadedExtensions.includes(peer.extension));
	assert.equal(args[args.indexOf("--tools") + 1], "read,team_message");
	assert.equal(args.includes("--no-extensions"), true);
	assert.equal(args.includes("--no-skills"), false);
	assert.equal(calls[0].env[PEER_URL_ENV], peer.url);
	assert.equal(calls[0].env[PEER_TOKEN_ENV], "peer-token");
	assert.equal(calls[0].env.PI_AGENT_TEAM_MEMBER, "1");
	await withChannel.cleanupPrompt();

	const withoutChannel = await adapter.createMemberClient({ ...base, tools: ["read"] });
	const plainArgs = calls[1].args;
	assert.equal(plainArgs.includes("--extension"), false);
	assert.equal(plainArgs[plainArgs.indexOf("--tools") + 1], "read");
	assert.equal(calls[1].env[PEER_URL_ENV], undefined);
	await withoutChannel.cleanupPrompt();
});

// ---------------------------------------------------------------------------
// runtime 端到端：工作中注入、一问一答、边界、状态与恢复
// ---------------------------------------------------------------------------

test("a peer message steers a running member and never changes task facts", async () => {
	await withPeerExtension(async () => {
		const compatibility = new FakeCompatibility();
		const ctx = context();
		const runtime = await registered(compatibility, ctx);
		try {
			const releaseA = await runningMember(runtime, compatibility, ctx, "coder-a", "task-a");
			const releaseB = await runningMember(runtime, compatibility, ctx, "coder-b", "task-b");
			const sent = await post(peerOf(compatibility, "coder-b"), {
				action: "send",
				to: "coder-a",
				text: "你那边 A 的接口名是什么？",
			});
			assert.equal(sent.status, 200);
			assert.equal(sent.body.data.delivery, "steered");
			const injected = compatibility.clients.get("coder-a")!.steerCalls;
			assert.equal(injected.length, 1);
			assert.match(injected[0], /你那边 A 的接口名是什么/u);
			assert.match(injected[0], /不改变你的任务目标/u);
			assert.match(injected[0], new RegExp(`replyTo="${sent.body.data.messageId}"`, "u"));

			const after = runtime.getState().teams.default;
			const question = after.memberMessages!.find((message) => message.id === sent.body.data.messageId)!;
			assert.equal(question.status, "DELIVERED");
			assert.equal(question.fromPeer, "coder-b");
			assert.equal(question.fromTurn, "execution/task-b#1");
			assert.equal(after.executionTasks["task-a"].status, "RUNNING");
			assert.equal(after.executionTasks["task-a"].attempt, 1);
			assert.deepEqual(after.executionTasks["task-a"].packet.ownedPaths, ["src/a"]);
			assert.equal(after.executionTasks["task-b"].status, "RUNNING");
			releaseA();
			releaseB();
		} finally {
			releaseAllGates(compatibility);
			await runtime.shutdown(ctx);
		}
	});
});

test("an idle receiver answers once in a read-only turn and the answer returns to the asker", async () => {
	await withPeerExtension(async () => {
		const compatibility = new FakeCompatibility();
		compatibility.roundOutputsByMember["coder-a"] = ["A 的接口名是 readThing(path:line)。"];
		const ctx = context();
		const runtime = await registered(compatibility, ctx);
		try {
			const releaseB = await runningMember(runtime, compatibility, ctx, "coder-b", "task-b");
			const sent = await post(peerOf(compatibility, "coder-b"), { action: "send", to: "coder-a", text: "接口名？" });
			assert.equal(sent.status, 200);
			assert.equal(sent.body.data.delivery, "answer-started");

			await waitFor(
				() =>
					(runtime.getState().teams.default.memberMessages ?? []).some(
						(message) => message.replyTo === sent.body.data.messageId,
					),
				"answer record",
			);
			const messages = runtime.getState().teams.default.memberMessages!;
			const question = messages.find((message) => message.id === sent.body.data.messageId)!;
			const reply = messages.find((message) => message.replyTo === question.id)!;
			assert.equal(question.status, "ANSWERED");
			assert.equal(question.usage?.turns, 1);
			assert.equal(reply.to, "coder-b");
			assert.equal(reply.fromPeer, "coder-a");
			assert.match(reply.text, /readThing/u);
			assert.equal(reply.deliveredAt !== undefined, true, "运行中的提问者收到回答");
			assert.equal(compatibility.clients.get("coder-b")!.steerCalls.length, 1);
			// 只读回合不产生任务事实：无 attempt、无 ownership、无 output.md。
			const team = runtime.getState().teams.default;
			assert.equal(team.executionTasks["task-a"].status, "READY");
			assert.equal(team.executionTasks["task-a"].attempt, 0);
			assert.equal(team.executionTasks["task-a"].outputPath, undefined);
			assert.match(compatibility.clients.get("coder-a")!.promptCalls[0], /只读的同伴通信回合/u);
			// 一问一答：回答不再唤醒空闲成员，不产生第二层来回。
			await new Promise((resolve) => setTimeout(resolve, 30));
			assert.equal(messages.filter((message) => message.replyTo).length, 1, "回答不触发对方的自动回答");
			assert.equal(compatibility.clients.get("coder-a")!.promptCalls.length, 1);
			releaseB();
		} finally {
			releaseAllGates(compatibility);
			await runtime.shutdown(ctx);
		}
	});
});

test("peer requests are bounded, plan-scoped, blocked during a read-only turn, and never wake a stopped member", async () => {
	await withPeerExtension(async () => {
		const compatibility = new FakeCompatibility();
		const ctx = context();
		const runtime = await registered(compatibility, ctx);
		try {
			const releaseB = await runningMember(runtime, compatibility, ctx, "coder-b", "task-b");
			const peerB = peerOf(compatibility, "coder-b");
			assert.equal((await post(peerB, { action: "send", to: "coder-b", text: "自己" })).status, 400);
			assert.equal((await post(peerB, { action: "send", to: "ghost", text: "外部" })).status, 400);
			assert.equal((await post(peerB, { action: "send", to: "coder-a", text: "" })).status, 400);
			assert.equal((await post(peerB, { action: "send", to: "coder-a", text: "x".repeat(1001) })).status, 400);
			assert.equal((await post(peerB, { action: "send", to: "coder-a", text: "hi", replyTo: "not-a-message" })).status, 400);
			assert.equal((await post(peerB, { action: "frobnicate" })).status, 400);
			assert.equal((await post({ url: peerB.url, token: "forged" }, { action: "members" })).status, 401);

			// 只读通信回合内不允许再发送新消息：coder-a 的回答回合被 gate 卡住。
			gateMember(compatibility, "coder-a");
			await post(peerB, { action: "send", to: "coder-a", text: "卡住的问题" });
			await waitFor(() => compatibility.clients.get("coder-a")?.promptCalls.length === 1, "gated answer turn");
			const duringTurn = await post(peerOf(compatibility, "coder-a"), { action: "send", to: "coder-b", text: "回合内发送" });
			assert.equal(duringTurn.status, 400);
			assert.match(duringTurn.body.error, /read-only peer communication turn/u);
			compatibility.gates.get("coder-a")?.();
			delete compatibility.promptGatesByMember["coder-a"];
			await waitFor(
				() => (runtime.getState().teams.default.memberMessages ?? []).some((message) => message.status === "ANSWERED"),
				"gated answer settled",
			);

			// 已停止的成员不被唤醒；同一 attempt 的发送上限只拒绝，不静默丢弃。
			// 之前已发 1 条，所以还可发 4 条；第六条被拒绝。
			await runtime.execute({ action: "kill", member: { id: "reviewer" } }, ctx);
			assert.equal(runtime.getState().teams.default.members["reviewer"].status, "STOPPED");
			for (let index = 0; index < 4; index++) {
				const accepted = await post(peerB, { action: "send", to: "reviewer", text: `排队 ${index}` });
				assert.equal(accepted.status, 200, `第 ${index + 1} 条余量应被接受: ${JSON.stringify(accepted.body)}`);
				assert.equal(accepted.body.data.delivery, "queued");
			}
			const overflow = await post(peerB, { action: "send", to: "reviewer", text: "第六条" });
			assert.equal(overflow.status, 400);
			assert.match(overflow.body.error, /At most 5 peer messages per attempt/u);
			await new Promise((resolve) => setTimeout(resolve, 20));
			assert.equal(compatibility.clients.has("reviewer"), false, "STOPPED 成员不会被消息唤醒");
			assert.equal(runtime.getState().teams.default.members["reviewer"].status, "STOPPED");
			releaseB();
		} finally {
			releaseAllGates(compatibility);
			await runtime.shutdown(ctx);
		}
	});
});

test("members, inbox, and status stay bounded and auditable", async () => {
	await withPeerExtension(async () => {
		const compatibility = new FakeCompatibility();
		const ctx = context();
		const runtime = await registered(compatibility, ctx);
		try {
			const releaseA = await runningMember(runtime, compatibility, ctx, "coder-a", "task-a");
			const releaseB = await runningMember(runtime, compatibility, ctx, "coder-b", "task-b");
			const peerB = peerOf(compatibility, "coder-b");
			const members = await post(peerB, { action: "members" });
			assert.equal(members.status, 200);
			assert.match(members.body.text, /coder-a \[coder · RUNNING\]/u);
			assert.match(members.body.text, /reviewer \[reviewer · APPROVED\]/u);
			assert.match((await post(peerB, { action: "inbox" })).body.text, /收件箱为空/u);

			await post(peerB, { action: "send", to: "coder-a", text: "第一条" });
			const inbox = await post(peerOf(compatibility, "coder-a"), { action: "inbox", limit: 1 });
			assert.equal(inbox.status, 200);
			assert.match(inbox.body.text, /第一条/u);
			assert.ok(inbox.body.text.split("\n").length <= 1 + DEFAULT_PEER_INBOX);
			assert.equal((await post(peerOf(compatibility, "coder-a"), { action: "inbox", limit: 999 })).status, 200);

			const status = await runtime.execute({ action: "status" }, ctx);
			assert.match(status.content[0].text, /Comms: queued=0 delivered=1 answered=0 failed=0/u);
			assert.equal(status.details.summary.peer.delivered, 1);
			releaseA();
			releaseB();
		} finally {
			releaseAllGates(compatibility);
			await runtime.shutdown(ctx);
		}
	});
});

test("report-origin messages keep their legacy dispatch-time delivery", async () => {
	await withPeerExtension(async () => {
		const compatibility = new FakeCompatibility();
		compatibility.roundOutputsByMember["coder-a"] = [
			`Body.\n${JSON.stringify({
				agent_team_report: {
					type: "execution",
					taskId: "task-a",
					status: "SUBMITTED",
					summary: "done",
					evidence: [],
					requests: [],
					messages: [{ to: "coder-b", text: "旧版报告留言" }],
				},
			})}`,
		];
		const ctx = context();
		const runtime = await registered(compatibility, ctx);
		try {
			await runtime.execute({ action: "run", taskId: "task-a", background: false }, ctx);
			const legacy = runtime.getState().teams.default.memberMessages!.find((message) => message.text === "旧版报告留言")!;
			assert.equal(legacy.fromPeer, undefined);
			assert.equal(legacy.status, undefined, "旧记录默认按 PENDING 处理");
			assert.equal(legacy.deliveredAt, undefined, "报告留言仍等待下一次显式派发");
			// 互通计数不把旧版报告留言算成同伴消息。
			assert.equal((await runtime.execute({ action: "status" }, ctx)).details.summary.peer, undefined);
			await runtime.execute({ action: "run", taskId: "task-b", background: false }, ctx);
			assert.match(compatibility.clients.get("coder-b")!.promptCalls[0], /旧版报告留言/u);
			assert.match(compatibility.clients.get("coder-b")!.promptCalls[0], /同伴消息（一次性注入/u);
			assert.equal(
				runtime.getState().teams.default.memberMessages!.find((message) => message.id === legacy.id)!.deliveredAt !== undefined,
				true,
			);
		} finally {
			releaseAllGates(compatibility);
			await runtime.shutdown(ctx);
		}
	});
});

test("a failed answer is recorded once, notified once, and never replayed", async () => {
	const compatibility = new FakeCompatibility();
	compatibility.preflightRejectByMember["coder-a"] = true;
	await withPeerExtension(async () => {
		const ctx = context();
		const runtime = await registered(compatibility, ctx);
		try {
			const releaseB = await runningMember(runtime, compatibility, ctx, "coder-b", "task-b");
			const sent = await post(peerOf(compatibility, "coder-b"), { action: "send", to: "coder-a", text: "会失败的问题" });
			assert.equal(sent.body.data.delivery, "answer-started");
			await waitFor(
				() => (runtime.getState().teams.default.memberMessages ?? []).some((message) => message.status === "FAILED"),
				"failed question",
			);
			const stored = runtime.getState().teams.default.memberMessages!;
			const question = stored.find((message) => message.id === sent.body.data.messageId)!;
			assert.equal(question.status, "FAILED");
			assert.match(question.error ?? "", /rejected before acceptance/u);
			assert.equal(stored.some((message) => message.replyTo === question.id), false, "失败不产生回答");
			assert.equal(runtime.getState().teams.default.executionTasks["task-a"].status, "READY");
			await waitFor(() => ctx.messages.length > 0, "parent failure notification");
			assert.match(ctx.messages[0].message.content, /同伴通信失败/u);
			const status = await runtime.execute({ action: "status" }, ctx);
			assert.match(status.content[0].text, /Comms: .*failed=1/u);
			assert.match(status.content[0].text, /Comms failure/u);
			releaseB();
		} finally {
			releaseAllGates(compatibility);
			await runtime.shutdown(ctx);
		}
	});
});

test("answer text is bounded and a stopped sender is never resumed for a reply", async () => {
	await withPeerExtension(async () => {
		const compatibility = new FakeCompatibility();
		compatibility.roundOutputsByMember["coder-a"] = ["答".repeat(MAX_PEER_ANSWER_CHARS + 500)];
		const ctx = context();
		const runtime = await registered(compatibility, ctx);
		try {
			const releaseB = await runningMember(runtime, compatibility, ctx, "coder-b", "task-b");
			const sent = await post(peerOf(compatibility, "coder-b"), { action: "send", to: "coder-a", text: "长回答" });
			await waitFor(
				() =>
					(runtime.getState().teams.default.memberMessages ?? []).some(
						(message) => message.replyTo === sent.body.data.messageId,
					),
				"long answer record",
			);
			const reply = runtime.getState().teams.default.memberMessages!.find(
				(message) => message.replyTo === sent.body.data.messageId,
			)!;
			assert.ok(reply.text.length <= MAX_PEER_ANSWER_CHARS + 1);
			releaseB();
		} finally {
			releaseAllGates(compatibility);
			await runtime.shutdown(ctx);
		}
	});
});

test("a full concurrency budget defers the answer and a real settlement drains it", async () => {
	await withPeerExtension(async () => {
		const ids = ["c1", "c2", "c3", "c4", "c5"];
		const bigPlan: PlanInput = {
			members: [
				...ids.map((id) => ({ id, kind: "coder" as const, role: `实现 ${id}`, instructions: `实现 ${id} 的任务。` })),
				{ id: "reviewer", kind: "reviewer" as const, role: "评审", instructions: "只读评审。", tools: ["read"] },
			],
			reviewerId: "reviewer",
			tasks: ids.map((id) => ({
				id: `task-${id}`,
				memberId: id,
				objective: `实现 ${id}。`,
				ownedPaths: [`src/${id}`],
				acceptance: [`${id} 完成`],
			})),
			acceptance: ["整体验收"],
		};
		const compatibility = new FakeCompatibility();
		const ctx = context();
		const runtime = await registered(compatibility, ctx, bigPlan);
		try {
			const release = new Map<string, () => void>();
			for (const id of ids.slice(0, 4)) release.set(id, await runningMember(runtime, compatibility, ctx, id, `task-${id}`));
			assert.equal(compatibility.membersSeen.filter((member) => member.peer?.url).length, 4);
			const deferred = await post(peerOf(compatibility, "c1"), { action: "send", to: "c5", text: "满了再问" });
			assert.equal(deferred.status, 200);
			assert.equal(deferred.body.data.delivery, "queued", "并发满额时排队，不启动额外会话");
			assert.equal(compatibility.clients.has("c5"), false);
			// 真实收尾事件释放槽位后，排队的提问才被回答（不轮询、不自动派发任务）。
			release.get("c1")!();
			await waitFor(() => compatibility.clients.get("c5")?.promptCalls.length === 1, "deferred answer turn");
			await waitFor(
				() =>
					(runtime.getState().teams.default.memberMessages ?? []).some(
						(message) => message.id === deferred.body.data.messageId && message.status === "ANSWERED",
					),
				"deferred question answered",
			);
			assert.equal(runtime.getState().teams.default.executionTasks["task-c5"].status, "READY", "回答不派发任务");
			for (const id of ids.slice(1, 4)) release.get(id)!();
		} finally {
			releaseAllGates(compatibility);
			await runtime.shutdown(ctx);
		}
	});
});

test("two questions arriving together answer once and leave the second for the next dispatch", async () => {
	await withPeerExtension(async () => {
		const compatibility = new FakeCompatibility();
		compatibility.roundOutputsByMember["coder-a"] = ["第一条回答"];
		const ctx = context();
		const runtime = await registered(compatibility, ctx);
		try {
			const releaseB = await runningMember(runtime, compatibility, ctx, "coder-b", "task-b");
			const peerB = peerOf(compatibility, "coder-b");
			gateMember(compatibility, "coder-a");
			const first = await post(peerB, { action: "send", to: "coder-a", text: "问题一" });
			assert.equal(first.body.data.delivery, "answer-started");
			await waitFor(() => compatibility.clients.get("coder-a")?.promptCalls.length === 1, "gated first answer");
			const second = await post(peerB, { action: "send", to: "coder-a", text: "问题二" });
			assert.equal(second.body.data.delivery, "queued", "同一时刻只开一轮回答，第二条等下一次派发");
			releaseAllGates(compatibility);
			await waitFor(
				() =>
					(runtime.getState().teams.default.memberMessages ?? []).some(
						(message) => message.id === first.body.data.messageId && message.status === "ANSWERED",
					),
				"first answer",
			);
			await new Promise((resolve) => setTimeout(resolve, 30));
			const messages = runtime.getState().teams.default.memberMessages!;
			assert.equal(messages.filter((message) => message.replyTo).length, 1, "只产生一条回答");
			const leftover = messages.find((message) => message.id === second.body.data.messageId)!;
			assert.equal(leftover.status, "PENDING");
			assert.equal(leftover.deliveredAt, undefined, "第二条仍等下一次显式派发");
			assert.equal(compatibility.clients.get("coder-a")!.promptCalls.length, 1);
			releaseB();
		} finally {
			releaseAllGates(compatibility);
			await runtime.shutdown(ctx);
		}
	});
});

test("stopping a communication turn ends it as INTERRUPTED without touching the task or waking anyone again", async () => {
	await withPeerExtension(async () => {
		const compatibility = new FakeCompatibility();
		const ctx = context();
		const runtime = await registered(compatibility, ctx);
		try {
			const releaseB = await runningMember(runtime, compatibility, ctx, "coder-b", "task-b");
			gateMember(compatibility, "coder-a");
			const sent = await post(peerOf(compatibility, "coder-b"), { action: "send", to: "coder-a", text: "会被停止的问题" });
			await waitFor(() => compatibility.clients.get("coder-a")?.promptCalls.length === 1, "gated answer turn");
			const stopped = await runtime.execute({ action: "stop", member: { id: "coder-a" } }, ctx);
			assert.doesNotMatch(stopped.content[0].text, /No active run to stop/u);
			assert.equal(runtime.getState().teams.default.members["coder-a"].status, "INTERRUPTED");
			// 停止通信回合不会伪造任务阻塞，也不影响其他任务。
			assert.equal(runtime.getState().teams.default.executionTasks["task-a"].status, "READY");
			releaseAllGates(compatibility);
			await waitFor(
				() =>
					(runtime.getState().teams.default.memberMessages ?? []).some(
						(message) => message.id === sent.body.data.messageId && message.status !== "PENDING",
					),
				"interrupted question settled",
			);
			const stoppedQuestion = runtime.getState().teams.default.memberMessages!.find(
				(message) => message.id === sent.body.data.messageId,
			)!;
			assert.equal(stoppedQuestion.status, "FAILED");
			assert.match(stoppedQuestion.error ?? "", /stopped before it completed/u);
			// 人为停止不当作通信故障上报，也不产生回答。
			assert.equal(ctx.messages.length, 0);
			assert.equal(runtime.getState().teams.default.memberMessages!.some((message) => message.replyTo), false);
			// 中断后不会再自动唤醒该成员：新问题只进入待投递队列。
			const promptsBefore = compatibility.clients.get("coder-a")!.promptCalls.length;
			const again = await post(peerOf(compatibility, "coder-b"), { action: "send", to: "coder-a", text: "再问一次" });
			assert.equal(again.body.data.delivery, "queued");
			await new Promise((resolve) => setTimeout(resolve, 20));
			assert.equal(compatibility.clients.get("coder-a")!.promptCalls.length, promptsBefore);
			releaseB();
		} finally {
			releaseAllGates(compatibility);
			await runtime.shutdown(ctx);
		}
	});
});

test("an unknown prompt acceptance and an over-limit answer are recorded without replay", async () => {
	const unknown = new FakeCompatibility();
	unknown.skipPreflightByMember["coder-a"] = true;
	await withPeerExtension(async () => {
		const ctx = context();
		const runtime = await registered(unknown, ctx);
		try {
			const releaseB = await runningMember(runtime, unknown, ctx, "coder-b", "task-b");
			const sent = await post(peerOf(unknown, "coder-b"), { action: "send", to: "coder-a", text: "接受状态未知" });
			await waitFor(
				() =>
					(runtime.getState().teams.default.memberMessages ?? []).some(
						(message) => message.id === sent.body.data.messageId && message.status === "FAILED",
					),
				"unknown acceptance recorded",
			);
			const question = runtime.getState().teams.default.memberMessages!.find(
				(message) => message.id === sent.body.data.messageId,
			)!;
			assert.match(question.error ?? "", /acceptance is unknown/u);
			assert.equal(unknown.clients.get("coder-a")!.promptCalls.length, 1, "接受状态未知时不重放");
			releaseB();
		} finally {
			releaseAllGates(unknown);
			await runtime.shutdown(ctx);
		}
	});

	// 超过一问一答的回合上限：中断并记录，不追加回答。
	const chatty = new FakeCompatibility();
	chatty.roundOutputsByMember["coder-a"] = ["啰嗦回答"];
	chatty.extraTurnsByMember["coder-a"] = 5;
	await withPeerExtension(async () => {
		const ctx = context();
		const runtime = await registered(chatty, ctx);
		try {
			const releaseB = await runningMember(runtime, chatty, ctx, "coder-b", "task-b");
			const sent = await post(peerOf(chatty, "coder-b"), { action: "send", to: "coder-a", text: "回合上限" });
			await waitFor(
				() =>
					(runtime.getState().teams.default.memberMessages ?? []).some(
						(message) => message.id === sent.body.data.messageId && message.status !== "PENDING",
					),
				"over-limit question settled",
			);
			const question = runtime.getState().teams.default.memberMessages!.find(
				(message) => message.id === sent.body.data.messageId,
			)!;
			assert.match(question.error ?? "", /exceeded 3 model turns/u);
			assert.equal(question.status, "ANSWERED");
			assert.equal(chatty.clients.get("coder-a")!.abortCalls, 1, "超限只中断一次");
			assert.equal(runtime.getState().teams.default.memberMessages!.filter((m) => m.replyTo).length, 1);
			releaseB();
		} finally {
			releaseAllGates(chatty);
			await runtime.shutdown(ctx);
		}
	});
});

test("shutdown closes the peer bridge and invalidates member tokens", async () => {
	await withPeerExtension(async () => {
		const compatibility = new FakeCompatibility();
		const ctx = context();
		const runtime = await registered(compatibility, ctx);
		try {
			const release = await runningMember(runtime, compatibility, ctx, "coder-a", "task-a");
			const peer = peerOf(compatibility, "coder-a");
			assert.equal((await post(peer, { action: "members" })).status, 200);
			release();
			await runtime.shutdown(ctx);
			await assert.rejects(post(peer, { action: "members" }));
		} finally {
			releaseAllGates(compatibility);
			await runtime.shutdown(ctx);
		}
	});
});

test("an unresolvable member extension keeps the member working without a peer channel", async () => {
	const previous = process.env[PEER_EXTENSION_ENV];
	process.env[PEER_EXTENSION_ENV] = join(tmpdir(), "missing-member-extension.ts");
	try {
		const compatibility = new FakeCompatibility();
		const ctx = context();
		const runtime = await registered(compatibility, ctx);
		try {
			compatibility.roundOutputsByMember["coder-a"] = [
				`Body.\n${JSON.stringify({
					agent_team_report: {
						type: "execution",
						taskId: "task-a",
						status: "SUBMITTED",
						summary: "done",
						evidence: [],
						requests: [],
					},
				})}`,
			];
			await runtime.execute({ action: "run", taskId: "task-a", background: false }, ctx);
			assert.equal(compatibility.membersSeen[0].peer, undefined);
			assert.equal(runtime.getState().teams.default.executionTasks["task-a"].status, "SUBMITTED");
			assert.match((await runtime.execute({ action: "status" }, ctx)).content[0].text, /peer channel unavailable/u);
		} finally {
			releaseAllGates(compatibility);
			await runtime.shutdown(ctx);
		}
	} finally {
		if (previous === undefined) delete process.env[PEER_EXTENSION_ENV];
		else process.env[PEER_EXTENSION_ENV] = previous;
	}
});

// 刻意不提供活动句柄：通信投影仍必须覆盖名册节点，不制造普通工作事件。
class ProjectionDashboard implements TeamDashboard {
	messages = new Map<string, DashboardCommunication>();
	live: string[] = [];
	phases: Array<{ id: string; phase: DashboardCommunicationPhase }> = [];
	fail = false;
	async prepare(): Promise<Map<string, never>> { return new Map(); }
	status(): any { return { visibility: "VISIBLE" }; }
	async closeMember(): Promise<void> {}
	updateMember(): void {}
	async shutdown(): Promise<void> {}
	publishCommunication(message: DashboardCommunication): void {
		if (this.fail) throw new Error("viewer unavailable");
		this.messages.set(message.id, structuredClone(message)); this.live.push(message.id);
	}
	syncCommunications(_team: string, messages: DashboardCommunication[], ids: readonly string[] = []): void {
		if (this.fail) throw new Error("viewer unavailable");
		for (const message of messages) this.messages.set(message.id, structuredClone(message));
		this.live.push(...ids);
	}
	setCommunicationPhase(_team: string, id: string, phase: DashboardCommunicationPhase): void {
		if (this.fail) throw new Error("viewer unavailable");
		this.phases.push({ id, phase: structuredClone(phase) });
	}
}

test("real peer lifecycle projects metadata and separate phases without active dashboard handles", async () => {
	await withPeerExtension(async () => {
		const compatibility = new FakeCompatibility(), dashboard = new ProjectionDashboard();
		const ctx = context({ mode: "tui", hasUI: true });
		const runtime = await registered(compatibility, ctx, PLAN, dashboard);
		try {
			await runningMember(runtime, compatibility, ctx, "coder-a", "task-a");
			gateMember(compatibility, "coder-b");
			const sent = await post(peerOf(compatibility, "coder-a"), { action: "send", to: "coder-b", text: "secret-question-body" });
			const id = sent.body.data.messageId;
			await waitFor(() => dashboard.live.includes(id), "accepted peer delivery");
			compatibility.clients.get("coder-b")!.emit({ type: "tool_execution_start", toolName: "read", args: { secret: "secret-tool-argument" } });
			assert.equal(dashboard.messages.get(id)!.status, "DELIVERED");
			assert.equal(dashboard.messages.get(id)!.from, "coder-a");
			assert.equal(dashboard.phases.at(-1)!.phase.label, "执行工具");
			assert.equal(dashboard.phases.at(-1)!.phase.detail, "read");
			assert.doesNotMatch(JSON.stringify([...dashboard.messages.values(), ...dashboard.phases]), /secret-question-body|secret-tool-argument/);
			await runtime.stopFromDashboard("default", "coder-b", ctx);
			assert.equal(runtime.getState().teams.default.manualPauses?.["coder-b"], undefined, "同伴回答没有可继续的工作目标");
			assert.equal(dashboard.phases.at(-1)!.phase.active, false);
			assert.equal(dashboard.messages.get(id)!.status, "FAILED");
			assert.equal(dashboard.messages.get(id)!.reason, "answer");
			assert.equal(runtime.getState().teams.default.executionTasks["task-b"].attempt, 0);
			assert.equal(dashboard.live.filter((value) => value === id).length, 1);
			dashboard.fail = true;
			const second = await post(peerOf(compatibility, "coder-a"), { action: "send", to: "coder-b", text: "still queues after viewer failure" });
			assert.equal(second.status, 200, "display failure cannot fail peer send");
		} finally { releaseAllGates(compatibility); await runtime.shutdown(ctx); }
	});
});

test("report-origin messages and rejected prompts project honest queued/invalid states", async () => {
	await withPeerExtension(async () => {
		const compatibility = new FakeCompatibility(), dashboard = new ProjectionDashboard();
		const ctx = context({ mode: "tui", hasUI: true });
		const runtime = await registered(compatibility, ctx, PLAN, dashboard);
		try {
			compatibility.roundOutputsByMember["coder-a"] = [JSON.stringify({ agent_team_report: { type: "execution", taskId: "task-a", status: "SUBMITTED", summary: "done", evidence: [], requests: [], messages: [{ to: "coder-b", text: "secret-legacy-body" }] } })];
			await runtime.execute({ action: "run", taskId: "task-a", background: false }, ctx);
			const message = [...dashboard.messages.values()].find((m) => m.kind === "message")!;
			assert.equal(message.from, "coder-a"); assert.equal(message.to, "coder-b"); assert.equal(message.status, "QUEUED");
			assert.doesNotMatch(JSON.stringify(message), /secret-legacy-body/);
			assert.equal([...dashboard.messages.values()].find((m) => m.kind === "report")!.status, "SUBMITTED");
			compatibility.preflightRejectByMember["coder-b"] = true;
			await assert.rejects(runtime.execute({ action: "run", taskId: "task-b" }, ctx));
			assert.equal(dashboard.messages.get(message.id)!.status, "QUEUED");
			assert.equal(dashboard.live.includes(message.id), false);
		} finally { releaseAllGates(compatibility); await runtime.shutdown(ctx); }
	});
});

test("member extension resolution only trusts an existing explicit path or an absolute __filename", () => {
	const previous = process.env[PEER_EXTENSION_ENV];
	try {
		const real = join(process.cwd(), "member-communication.ts");
		process.env[PEER_EXTENSION_ENV] = real;
		assert.equal(memberExtensionPath(), real);
		process.env[PEER_EXTENSION_ENV] = join(tmpdir(), "absent-member-communication.ts");
		assert.equal(memberExtensionPath(), undefined, "不存在的覆盖路径不被信任");
		delete process.env[PEER_EXTENSION_ENV];
		// 测试进程里 __filename 是相对路径：必须拒绝，避免误启互通或误报路径。
		assert.equal(memberExtensionPath(), undefined);
	} finally {
		delete process.env[PEER_EXTENSION_ENV];
		if (previous !== undefined) process.env[PEER_EXTENSION_ENV] = previous;
	}
});
