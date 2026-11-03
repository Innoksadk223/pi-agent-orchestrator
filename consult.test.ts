import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import type { RpcClientLike, RpcStats } from "./compat.ts";
import type { CompatibilityPort, PlanInput, RuntimeContext, TeamState } from "./runtime.ts";
import { TeamInputError, TeamRuntime, validateToolRequest } from "./runtime.ts";

const NOW = "2026-08-01T00:00:00.000Z";
const RUNTIME_SOURCE = readFileSync(new URL("./runtime.ts", import.meta.url), "utf8");

const PLAN: PlanInput = {
	members: [
		{ id: "coder-a", kind: "coder", role: "实现 A", instructions: "实现 A 任务。" },
		{ id: "reviewer", kind: "reviewer", role: "只读评审", instructions: "只读评审。", tools: ["read"] },
		{ id: "optimizer", kind: "optimizer", role: "只读优化", instructions: "只读优化。", tools: ["read"] },
	],
	reviewerId: "reviewer",
	tasks: [
		{ id: "task-a", memberId: "coder-a", objective: "实现 A。", ownedPaths: ["src/a"], acceptance: ["A 完成"] },
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

/** consult 复用 expert 信封：轮次 id 字段仍叫 expertRoundId。 */
function consultReport(roundId: string, summary = "cache miss 来自空表"): string {
	return `Consult body.\n${JSON.stringify({ agent_team_report: { type: "expert", expertRoundId: roundId, summary, evidence: [], requests: [] } })}`;
}

class FakeClient implements RpcClientLike {
	promptCalls: string[] = [];
	listeners = new Set<(event: any) => void>();
	stateThinkingLevel = "medium";
	readonly memberId: string;
	readonly sessionId: string;
	readonly stateModel: string;
	readonly compatibility: FakeCompatibility;
	private outputs: string[];
	private turns = 0;
	private lastText: string | null = null;
	private idleBlocked = false;

	constructor(memberId: string, sessionId: string, stateModel: string, outputs: string[], compatibility: FakeCompatibility) {
		this.memberId = memberId;
		this.sessionId = sessionId;
		this.stateModel = stateModel;
		this.compatibility = compatibility;
		this.outputs = [...outputs];
	}

	async start(): Promise<void> {}
	async stop(): Promise<void> {}
	onEvent(listener: (event: any) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
	async prompt(message: string, options?: { preflightResult?: (success: boolean) => void }): Promise<void> {
		this.promptCalls.push(message);
		options?.preflightResult?.(true);
		this.turns++;
		const text = this.outputs.length > 1 ? this.outputs.shift()! : (this.outputs[0] ?? "no report");
		this.lastText = text;
		const slash = this.stateModel.indexOf("/");
		this.emit({
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text }],
				provider: this.stateModel.slice(0, slash),
				model: this.stateModel.slice(slash + 1),
				stopReason: "stop",
			},
		});
		// prompt() 只代表提示已接受：挂住 settled 才能让成员停在 RUNNING。
		if (!this.idleBlocked) this.emit({ type: "agent_settled" });
	}
	async waitForIdle(): Promise<void> {}
	async abort(): Promise<void> {
		this.emit({ type: "agent_settled" });
	}
	async steer(): Promise<void> {}
	async setModel(): Promise<unknown> {
		return {};
	}
	async setThinkingLevel(): Promise<void> {}
	async getState(): Promise<{ sessionId: string; sessionName?: string; model?: string; thinkingLevel?: string }> {
		return {
			sessionId: this.sessionId,
			sessionName: `team:default/${this.sessionId}`,
			model: this.stateModel,
			thinkingLevel: this.stateThinkingLevel,
		};
	}
	async setSessionName(): Promise<void> {}
	async getSessionStats(): Promise<RpcStats> {
		return stats(this.turns);
	}
	async getLastAssistantText(): Promise<string | null> {
		return this.turns > 0 ? this.lastText : null;
	}
	/** 挂住本轮结算（成员保持 RUNNING），释放用 completeIdle()。 */
	blockUntilIdle(): void {
		this.idleBlocked = true;
	}
	completeIdle(): void {
		this.idleBlocked = false;
		this.emit({ type: "agent_settled" });
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
	outputsByMember: Record<string, string[]> = {};
	private blockOnCreate = new Set<string>();

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
		this.membersSeen.push(structuredClone({ ...member }));
		const client = new FakeClient(
			member.id,
			member.sessionId ?? `session-${member.id}`,
			`${member.model.provider}/${member.model.id}`,
			this.outputsByMember[member.id] ?? [],
			this,
		);
		if (this.blockOnCreate.delete(member.id)) client.blockUntilIdle();
		this.clients.set(member.id, client);
		return { client, cleanupPrompt: async () => undefined };
	}
	/** 让该成员本轮的 settled 被挂住（成员停在 RUNNING），直到调用 client.completeIdle()。 */
	blockNext(memberId: string): void {
		this.blockOnCreate.add(memberId);
	}
	client(memberId: string): FakeClient {
		const client = this.clients.get(memberId);
		if (!client) throw new Error(`No client was created for ${memberId}.`);
		return client;
	}
}

async function waitFor(predicate: () => boolean, label = "condition"): Promise<void> {
	for (let attempt = 0; attempt < 400; attempt++) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error(`Timed out waiting for ${label}.`);
}

// 计划工作区写在 cwd 下（.pi/agent-team/<team>/...），测试结束统一删除。
let sharedCwd: string | undefined;
function isolatedCwd(): string {
	sharedCwd ??= mkdtempSync(join(tmpdir(), "pi-agent-team-consult-"));
	return sharedCwd;
}
after(async () => {
	if (sharedCwd) await rm(sharedCwd, { recursive: true, force: true });
});

async function context(overrides: Partial<RuntimeContext> = {}): Promise<RuntimeContext & { snapshots: TeamState[] }> {
	const snapshots: TeamState[] = [];
	return {
		cwd: isolatedCwd(),
		mode: "json",
		model: { provider: "test", id: "model" },
		thinking: "medium",
		trusted: true,
		hasUI: false,
		parentPersisted: true,
		capabilities: { appendEntry: true, getBranch: true },
		confirm: async () => true,
		appendSnapshot: (snapshot) => snapshots.push(structuredClone(snapshot)),
		snapshots,
		...overrides,
	};
}

async function registered(plan: PlanInput = PLAN): Promise<{
	runtime: TeamRuntime;
	compatibility: FakeCompatibility;
	ctx: RuntimeContext & { snapshots: TeamState[] };
}> {
	const compatibility = new FakeCompatibility();
	const runtime = new TeamRuntime(compatibility, () => NOW);
	const ctx = await context();
	await runtime.execute({ action: "set-auto", auto: true }, ctx);
	await runtime.execute({ action: "plan", plan }, ctx);
	return { runtime, compatibility, ctx };
}

function taskStatuses(runtime: TeamRuntime): Record<string, string> {
	const tasks = runtime.getState().teams.default.executionTasks;
	return Object.fromEntries(Object.entries(tasks).map(([id, task]) => [id, task.status]));
}

function consultRound(runtime: TeamRuntime, id: string) {
	return runtime.getState().teams.default.expertRounds[id];
}

// ---------------------------------------------------------------------------
// 校验：字段级错误，三种非法调用在产生副作用前被拒
// ---------------------------------------------------------------------------

test("consult validation names the missing field and rejects taskIds before any dispatch", async () => {
	const { runtime, compatibility } = await registered();
	const state = runtime.getState();
	const isInputError = (pattern: RegExp) => (error: unknown) =>
		error instanceof TeamInputError && pattern.test(error.message);

	assert.throws(
		() => validateToolRequest({ action: "consult", objective: "为什么 task-a 的测试很慢？" }, state),
		isInputError(/consult requires member\.id/u),
		"缺 memberId 时报 member.id 字段级错误",
	);
	assert.throws(
		() => validateToolRequest({ action: "consult", member: { id: "reviewer" } }, state),
		isInputError(/consult requires objective/u),
		"缺 objective 时报 objective 字段级错误",
	);
	assert.throws(
		() =>
			validateToolRequest(
				{ action: "consult", member: { id: "reviewer" }, objective: "看一下 task-a", taskIds: ["task-a"] },
				state,
			),
		isInputError(/consult forbids taskIds/u),
		"consult 不绑定任务，带 taskIds 直接拒绝",
	);
	// 被拒的调用不产生轮次、不启动成员。
	assert.deepEqual(Object.keys(runtime.getState().teams.default.expertRounds), []);
	assert.equal(compatibility.clients.size, 0);
});

// ---------------------------------------------------------------------------
// 派发：任意已规划成员、只读轮次、不改任何 ExecutionTask 状态
// ---------------------------------------------------------------------------

test("consult dispatches a read-only round to any planned member and leaves every task status untouched", async () => {
	const { runtime, compatibility, ctx } = await registered();
	compatibility.outputsByMember.reviewer = [consultReport("consult-1")];
	const before = taskStatuses(runtime);
	compatibility.blockNext("reviewer");

	const result = await runtime.execute(
		{ action: "consult", member: { id: "reviewer" }, objective: "为什么 task-a 的缓存命中率低？" },
		ctx,
	);
	assert.equal(result.terminate, true, "默认后台派发：接受 prompt 后立即结束工具回合，不等待结果");
	assert.equal(result.details.results?.[0]?.status, "RUNNING");

	let round = consultRound(runtime, "consult-1");
	assert.equal(round.kind, "consult", "轮次种类是 consult，不是 debugger/product/optimizer");
	assert.equal(round.expertId, "reviewer", "任意已规划成员都能被咨询，不要求是只读专家");
	assert.deepEqual(round.targetTaskIds, [], "consult 不绑定任务");
	assert.equal(round.objective, "为什么 task-a 的缓存命中率低？");
	assert.equal(round.status, "RUNNING");
	assert.equal(round.attempt, 1);
	assert.deepEqual(taskStatuses(runtime), before, "派发前后所有 ExecutionTask 的 status 不变");

	const prompt = compatibility.clients.get("reviewer")!.promptCalls[0];
	assert.match(prompt, /Perform read-only consult round consult-1/u);
	assert.match(prompt, /为什么 task-a 的缓存命中率低？/u);
	assert.match(prompt, /"type":"expert","expertRoundId":"consult-1"/u, "复用 expert 的报告信封");
	assert.match(prompt, /Do not modify deliverables and do not change task verification state\./u);

	// 成员的只读工具清单来自 plan，consult 不额外放宽。
	assert.deepEqual(
		compatibility.membersSeen.find((member) => member.id === "reviewer")?.tools,
		["read"],
	);

	// status 读出这个 consult 轮次。
	const status = await runtime.execute({ action: "status" }, ctx);
	const current = status.details.summary?.current ?? [];
	assert.deepEqual(
		current.find((item) => item.id === "consult-1"),
		{ type: "expert", id: "consult-1", memberId: "reviewer", status: "RUNNING" },
	);
	assert.match(status.content[0].text, /Current expert\/consult-1: RUNNING member=reviewer/u);
	assert.equal(status.details.summary?.taskCounts.READY, 1, "consult 不消耗任务，task-a 仍是 READY");

	compatibility.client("reviewer").completeIdle();
	await waitFor(() => consultRound(runtime, "consult-1").status === "COMPLETED", "consult round completion");
	assert.equal(runtime.getState().teams.default.members.reviewer.status, "IDLE");
	assert.equal(consultRound(runtime, "consult-1").summary, "cache miss 来自空表");
	assert.deepEqual(taskStatuses(runtime), before, "只读轮次完成后任务状态仍然不变");
});

// ---------------------------------------------------------------------------
// 轮次 id：显式 expertRoundId 与自动 consult-N
// ---------------------------------------------------------------------------

test("consult accepts an explicit expertRoundId and otherwise generates consult-N", async () => {
	const { runtime, compatibility, ctx } = await registered();
	compatibility.outputsByMember["coder-a"] = [consultReport("q-explicit")];
	compatibility.outputsByMember.optimizer = [consultReport("consult-1")];
	const before = taskStatuses(runtime);

	const explicit = await runtime.execute(
		{ action: "consult", expertRoundId: "q-explicit", member: { id: "coder-a" }, objective: "解释 A 的实现取舍", background: false },
		ctx,
	);
	assert.equal(explicit.details.results?.[0]?.status, "IDLE", "background:false 时同步等到成员结束");
	assert.equal(consultRound(runtime, "q-explicit").status, "COMPLETED");
	assert.equal(consultRound(runtime, "q-explicit").kind, "consult");
	assert.equal(runtime.getState().teams.default.members["coder-a"].status, "IDLE");

	const generated = await runtime.execute(
		{ action: "consult", member: { id: "optimizer" }, objective: "有没有低风险优化点？", background: false },
		ctx,
	);
	assert.equal(generated.details.results?.[0]?.status, "IDLE");
	assert.equal(consultRound(runtime, "consult-1").status, "COMPLETED", "省略轮次 id 时生成 consult-1");
	assert.deepEqual(consultRound(runtime, "consult-1").targetTaskIds, []);
	assert.deepEqual(taskStatuses(runtime), before);

	// 重复轮次 id 被拒，不会静默覆盖既有轮次。
	await assert.rejects(
		runtime.execute({ action: "consult", expertRoundId: "q-explicit", member: { id: "optimizer" }, objective: "再看一次" }, ctx),
		/Consult round q-explicit already exists/u,
	);
});

// ---------------------------------------------------------------------------
// 边界：expert 判定与 consult 参数形状都不放宽
// ---------------------------------------------------------------------------

test("consult does not loosen expert eligibility or accept expert-only fields", async () => {
	const { runtime, compatibility, ctx } = await registered();
	// reviewer 不是只读专家，consult 可以问，expert 仍然拒绝。
	compatibility.outputsByMember.reviewer = [consultReport("consult-1")];
	await runtime.execute({ action: "consult", member: { id: "reviewer" }, objective: "只读回答即可", background: false }, ctx);
	assert.equal(consultRound(runtime, "consult-1").status, "COMPLETED");

	await assert.rejects(
		runtime.execute({ action: "expert", expertRoundId: "expert-1", expertId: "reviewer", taskIds: ["task-a"], objective: "x" }, ctx),
		/is not a planned read-only expert/u,
	);
	assert.throws(
		() =>
			validateToolRequest(
				{ action: "consult", expertId: "reviewer", member: { id: "reviewer" }, objective: "x" },
				runtime.getState(),
			),
		/consult forbids .*expertId/u,
	);
	assert.throws(
		() =>
			validateToolRequest(
				{ action: "consult", member: { id: "reviewer", role: "注入角色" }, objective: "x" },
				runtime.getState(),
			),
		/consult accepts member id only/u,
	);
	assert.throws(
		() => validateToolRequest({ action: "consult", member: { id: "ghost" }, objective: "x" }, runtime.getState()),
		/Unknown member default\/ghost/u,
	);
});

// ---------------------------------------------------------------------------
// 实现约束：只读派发的 prompt 只有一份构造
// ---------------------------------------------------------------------------

test("consult reuses the single expert read-only dispatch construction", () => {
	assert.equal(
		(RUNTIME_SOURCE.match(/private expertDispatchTask\(/gu) ?? []).length,
		1,
		"只读派发构造只有 expertDispatchTask 一处",
	);
	assert.equal(
		(RUNTIME_SOURCE.match(/envelopeContract\("expert", roundId\)/gu) ?? []).length,
		1,
		"只读信封只在一处生成",
	);
	assert.equal(
		(RUNTIME_SOURCE.match(/this\.expertDispatchTask\(/gu) ?? []).length,
		3,
		"expert 首次派发、expert resume 与 consult 调用同一个构造",
	);
	const consult = RUNTIME_SOURCE.slice(
		RUNTIME_SOURCE.indexOf("private preflightConsult("),
		RUNTIME_SOURCE.indexOf("private nextConsultRoundId("),
	);
	assert.ok(consult.length > 0, "preflightConsult 存在");
	assert.equal(consult.includes("envelopeContract"), false, "consult 不自己拼信封");
	assert.equal(consult.includes("markdownFields"), false, "consult 不自己拼 prompt 正文");
	assert.match(consult, /this\.expertDispatchTask\(team, id, "consult", objective, member, \[\]\)/u);
});

// ---------------------------------------------------------------------------
// 生命周期：BLOCKED 的 consult 轮次按同一目标续跑
// ---------------------------------------------------------------------------

test("a stopped consult round resumes as the next attempt without touching task state", async () => {
	const { runtime, compatibility, ctx } = await registered();
	compatibility.outputsByMember.reviewer = [consultReport("consult-1", "恢复后的回答")];
	const before = taskStatuses(runtime);
	compatibility.blockNext("reviewer");
	await runtime.execute({ action: "consult", member: { id: "reviewer" }, objective: "为什么构建慢？" }, ctx);
	assert.equal(consultRound(runtime, "consult-1").status, "RUNNING");

	await runtime.execute({ action: "stop", member: { id: "reviewer" } }, ctx);
	assert.equal(consultRound(runtime, "consult-1").status, "BLOCKED");
	assert.deepEqual(taskStatuses(runtime), before, "中断只读轮次同样不改任务状态");

	// 软停保留 child 与挂住的 settled：续跑后仍停在 RUNNING，直到显式 completeIdle。
	const resumed = await runtime.execute({ action: "resume", expertRoundId: "consult-1" }, ctx);
	assert.equal(resumed.details.results?.[0]?.status, "RUNNING");
	assert.equal(consultRound(runtime, "consult-1").attempt, 2);
	assert.equal(consultRound(runtime, "consult-1").objective, "为什么构建慢？", "续跑复用原 objective");
	assert.equal(consultRound(runtime, "consult-1").kind, "consult");
	assert.match(compatibility.clients.get("reviewer")!.promptCalls.at(-1)!, /Perform read-only consult round consult-1/u);

	compatibility.client("reviewer").completeIdle();
	await waitFor(() => consultRound(runtime, "consult-1").status === "COMPLETED", "resumed consult completion");
	assert.equal(consultRound(runtime, "consult-1").summary, "恢复后的回答");
	assert.deepEqual(taskStatuses(runtime), before);
});

// ---------------------------------------------------------------------------
// 状态兼容：consult 轮次只复用既有结构，不提升 schema 版本
// ---------------------------------------------------------------------------

test("consult rounds persist inside the existing expertRounds structure without a schema bump", async () => {
	const { runtime, compatibility, ctx } = await registered();
	compatibility.outputsByMember.reviewer = [consultReport("consult-1")];
	await runtime.execute({ action: "consult", member: { id: "reviewer" }, objective: "只读问题", background: false }, ctx);
	const state = runtime.getState();
	assert.equal(state.schemaVersion, 3, "既有 STATE_SCHEMA_VERSION 不变");
	assert.deepEqual(Object.keys(state.teams.default.expertRounds), ["consult-1"]);
	assert.equal(state.teams.default.executionTasks["task-a"]?.status, "READY");
});
