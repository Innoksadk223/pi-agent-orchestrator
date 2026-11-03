import assert from "node:assert/strict";
import test from "node:test";
import { PiCompatibilityAdapter, type RpcClientLike, type RpcStats } from "./compat.ts";
import {
	STATE_SCHEMA_VERSION,
	TeamRuntime,
	validateToolRequest,
	type CompatibilityPort,
	type PlanInput,
	type RuntimeContext,
	type TeamState,
} from "./runtime.ts";
import type { DashboardMemberSpec, TeamDashboard } from "./web-dashboard.ts";
import { AgentTeamParams } from "./schema.ts";
import { Value } from "typebox/value";

const parseParams = (value: unknown): any => Value.Parse(AgentTeamParams, value) as any;

const NOW = "2026-08-01T00:00:00.000Z";

function stats(): RpcStats {
	return { assistantMessages: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0 };
}

class FakeClient implements RpcClientLike {
	stopCalls = 0;
	abortCalls = 0;
	promptCalls: string[] = [];
	listeners = new Set<(event: any) => void>();
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
		options?.preflightResult?.(true);
		this.emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" } });
		this.emit({ type: "agent_settled" });
	}
	async waitForIdle(): Promise<void> {}
	private emit(event: any): void {
		for (const listener of this.listeners) listener(event);
	}
	async waitForIdle(): Promise<void> {}
	async abort(): Promise<void> {
		this.abortCalls++;
		this.emit({ type: "agent_settled" });
	}
	async stats(): Promise<RpcStats> {
		return stats();
	}
}

class FakeCompatibility extends PiCompatibilityAdapter {
	override async featureCheck() {
		return { ok: true, version: "test", code: "OK", message: "ok" };
	}
	override async createChildClient(options: { sessionId: string }): Promise<RpcClientLike> {
		return new FakeClient(options.sessionId);
	}
	override async ensureCompatible(): Promise<void> {}
}

class FakeDashboard implements TeamDashboard {
	shutdownCalls = 0;
	closed: string[] = [];
	async prepare(members: readonly DashboardMemberSpec[]): Promise<Map<string, never>> {
		return new Map(members.map((member) => [`${member.team}\u0000${member.id}`, undefined as never]));
	}
	status(): any {
		return { status: "APPROVED" };
	}
	async closeMember(team: string, id: string): Promise<void> {
		this.closed.push(`${team}/${id}`);
	}
	updateMember(): void {}
	async shutdown(): Promise<void> {
		this.shutdownCalls++;
	}
}

const PLAN: PlanInput = {
	members: [
		{ id: "coder", kind: "coder", role: "实现", instructions: "实现任务。" },
		{ id: "reviewer", kind: "reviewer", role: "评审", instructions: "只读评审。", tools: ["read"] },
	],
	reviewerId: "reviewer",
	tasks: [{ id: "task", memberId: "coder", objective: "实现。", ownedPaths: ["src/a"], acceptance: ["完成"] }],
	acceptance: ["整体验收"],
};

function context(options: { dashboard?: TeamDashboard; mode?: string } = {}): RuntimeContext {
	return {
		cwd: process.cwd(),
		mode: options.mode ?? "rpc",
		hasUI: true,
		parentPersisted: true,
		model: { provider: "test", id: "model" },
		thinking: "medium",
		trusted: true,
		capabilities: { appendEntry: true, getBranch: true },
		confirm: async () => true,
		appendSnapshot: () => {},
		sendParentMessage: () => {},
	} as unknown as RuntimeContext;
}

function teamState(teamId = "default"): TeamState {
	return {
		schemaVersion: STATE_SCHEMA_VERSION,
		teams: {
			[teamId]: {
				id: teamId,
				members: { coder: { id: "coder", team: teamId, status: "APPROVED" } as any, reviewer: { id: "reviewer", team: teamId, status: "APPROVED" } as any },
				plan: { revision: 1, reviewerId: "reviewer", memberKinds: { coder: "coder", reviewer: "reviewer" }, acceptance: ["整体验收"], registeredAt: NOW, updatedAt: NOW },
				executionTasks: {},
				reviewRounds: {},
				expertRounds: {},
				pendingRequests: [],
			},
		},
		updatedAt: NOW,
	} as unknown as TeamState;
}

async function registered(dashboard?: FakeDashboard): Promise<{ runtime: TeamRuntime; ctx: RuntimeContext }> {
	const ctx = context({ dashboard });
	const runtime = new TeamRuntime(new FakeCompatibility() as unknown as CompatibilityPort, () => NOW, undefined, dashboard ? () => dashboard : undefined);
	await runtime.execute({ action: "set-auto", auto: true }, ctx);
	await runtime.execute({ action: "plan", plan: PLAN }, ctx);
	return { runtime, ctx };
}

test("set-auto persists the global default so new sessions start authorized", async () => {
	const written: boolean[] = [];
	const runtime = new TeamRuntime(new FakeCompatibility() as unknown as CompatibilityPort, () => NOW, undefined, undefined, undefined, false, (value) => written.push(value));
	await runtime.execute({ action: "set-auto", auto: true }, context());
	await runtime.execute({ action: "set-auto", auto: false }, context());
	assert.deepEqual(written, [true, false], "开关写回配置文件，关掉也是全局的");
});

test("close 收尾：成员全部 STOPPED、逐成员移出页面，且无其他团队时关掉 Dashboard", async () => {
	const dashboard = new FakeDashboard();
	const { runtime, ctx } = await registered(dashboard);
	const result = await runtime.execute({ action: "close" }, ctx);
	assert.match(result.content[0]!.text, /2 members STOPPED/);
	assert.equal((result.details as any).dashboard, "closed");
	assert.equal(dashboard.shutdownCalls, 1);
	assert.deepEqual(dashboard.closed.sort(), ["default/coder", "default/reviewer"]);
	const status = await runtime.execute({ action: "status", full: true }, ctx);
	const members = (status.details as any).members ?? {};
	for (const key of Object.keys(members)) assert.equal(members[key].status, "STOPPED", key);
});

test("close 在有 RUNNING 成员时拒绝，不 terminate 任何会话", async () => {
	const { runtime, ctx } = await registered();
	const state = (runtime as any).state as TeamState;
	state.teams.default!.members.coder!.status = "RUNNING";
	await assert.rejects(() => runtime.execute({ action: "close" }, ctx), /RUNNING members \(coder\)/);
	state.teams.default!.members.coder!.status = "APPROVED";
});

test("close 保留 Dashboard：还有别的团队在跑", async () => {
	const dashboard = new FakeDashboard();
	const { runtime, ctx } = await registered(dashboard);
	const state = (runtime as any).state as TeamState;
	state.teams.other = {
		id: "other",
		members: { "coder-x": { id: "coder-x", team: "other", status: "RUNNING" } as any },
		executionTasks: {},
		reviewRounds: {},
		expertRounds: {},
		pendingRequests: [],
	} as any;
	const result = await runtime.execute({ action: "close" }, ctx);
	assert.equal((result.details as any).dashboard, "kept");
	assert.equal(dashboard.shutdownCalls, 0);
	assert.match(result.content[0]!.text, /Dashboard left open: other teams still have active work \(other\)/);
});

test("close 的入参校验：未知团队、member、plan 字段与小开关一律拒绝", () => {
	assert.throws(() => validateToolRequest(parseParams({ action: "close", team: "missing" }) as any, teamState()), /nothing to close/);
	assert.throws(() => validateToolRequest(parseParams({ action: "close", member: { id: "coder" } }) as any, teamState()), /close forbids member/);
	assert.throws(() => validateToolRequest(parseParams({ action: "close", background: true }) as any, teamState()), /close forbids/);
	assert.throws(
		() => validateToolRequest(parseParams({ action: "close", expectedRevision: 1 }) as any, teamState()),
		/close forbids/,
	);
	validateToolRequest(parseParams({ action: "close" }) as any, teamState());
});

test("页面收到 shutdown 后尝试自关，浏览器拦下时保留已结束", async () => {
	const { readFile } = await import("node:fs/promises");
	const html = await readFile(new URL("./web-dashboard.html", import.meta.url), "utf8");
	assert.match(html, /kind === "shutdown"[\s\S]{0,200}window\.close\(\)/);
});
