import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import type { RpcClientLike, RpcStats } from "./compat.ts";
import { PEER_EXTENSION_ENV, PEER_TOKEN_HEADER } from "./peer-protocol.ts";
import type { CompatibilityPort, PlanInput, RuntimeContext, TeamState } from "./runtime.ts";
import { mergeWorkspaceWarning, TeamRuntime } from "./runtime.ts";

const NOW = "2026-08-01T00:00:00.000Z";

const PLAN: PlanInput = {
	members: [
		{ id: "coder-a", kind: "coder", role: "实现 A", instructions: "实现 A 任务。" },
		{ id: "coder-b", kind: "coder", role: "实现 B", instructions: "实现 B 任务。" },
		{ id: "reviewer", kind: "reviewer", role: "只读评审", instructions: "只读评审。", tools: ["read"] },
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

function executionReport(taskId: string): string {
	return `Execution body.\n${JSON.stringify({ agent_team_report: { type: "execution", taskId, status: "SUBMITTED", summary: "execution summary", evidence: [], requests: [] } })}`;
}

class FakeClient implements RpcClientLike {
	promptCalls: string[] = [];
	steerCalls: string[] = [];
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
		// 模拟成员在回合内写盘：越界检测必须发生在 workspaceBefore 之后。
		this.compatibility.duringPrompt?.(this.memberId, message);
		this.turns++;
		const text = this.outputs.length > 1 ? this.outputs.shift()! : (this.outputs[0] ?? "peer answer body");
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
		if (!this.idleBlocked) this.emit({ type: "agent_settled" });
	}
	async waitForIdle(): Promise<void> {}
	async abort(): Promise<void> {
		this.emit({ type: "agent_settled" });
	}
	async steer(message: string): Promise<void> {
		this.steerCalls.push(message);
	}
	async setModel(): Promise<unknown> {
		return {};
	}
	async setThinkingLevel(): Promise<void> {}
	async getState(): Promise<{ sessionId: string; sessionName?: string; model?: string; thinkingLevel?: string }> {
		return { sessionId: this.sessionId, sessionName: `team:default/${this.sessionId}`, model: this.stateModel, thinkingLevel: this.stateThinkingLevel };
	}
	async setSessionName(): Promise<void> {}
	async getSessionStats(): Promise<RpcStats> {
		return stats(this.turns);
	}
	async getLastAssistantText(): Promise<string | null> {
		return this.turns > 0 ? this.lastText : null;
	}
	async compact(): Promise<any> {
		return { summary: "", firstKeptEntryId: "", tokensBefore: 0, estimatedTokensAfter: 0 };
	}
	async setAutoCompaction(): Promise<void> {}
	emit(event: any): void {
		for (const listener of this.listeners) listener(event);
	}
	/** 挂住本轮结算（成员保持 RUNNING），释放用 completeIdle()。 */
	blockUntilIdle(): void {
		this.idleBlocked = true;
	}
	completeIdle(): void {
		this.idleBlocked = false;
		this.emit({ type: "agent_settled" });
	}
}

class FakeCompatibility implements CompatibilityPort {
	clients = new Map<string, FakeClient>();
	membersSeen: any[] = [];
	outputsByMember: Record<string, string[]> = {};
	duringPrompt?: (memberId: string, prompt: string) => void;
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
	blockNext(memberId: string): void {
		this.blockOnCreate.add(memberId);
	}
	client(memberId: string): FakeClient {
		const client = this.clients.get(memberId);
		if (!client) throw new Error(`No client was created for ${memberId}.`);
		return client;
	}
}

// 成员侧互通扩展必须按绝对路径解析，runtime 才会签发令牌并启动本机入口。
function withPeerExtension<T>(run: () => Promise<T>): Promise<T> {
	const previous = process.env[PEER_EXTENSION_ENV];
	process.env[PEER_EXTENSION_ENV] = new URL("./member-communication.ts", import.meta.url).pathname;
	return run().finally(() => {
		if (previous === undefined) delete process.env[PEER_EXTENSION_ENV];
		else process.env[PEER_EXTENSION_ENV] = previous;
	});
}

function peerOf(compatibility: FakeCompatibility, memberId: string): { url: string; token: string } {
	const seen = compatibility.membersSeen.filter((member) => member.id === memberId).at(-1);
	if (!seen?.peer?.url) throw new Error(`No peer channel was issued for ${memberId}.`);
	return seen.peer;
}

async function post(peer: { url: string; token: string }, payload: Record<string, unknown>): Promise<{ status: number; body: any }> {
	const response = await fetch(peer.url, {
		method: "POST",
		headers: { "content-type": "application/json", [PEER_TOKEN_HEADER]: peer.token },
		body: JSON.stringify(payload),
	});
	return { status: response.status, body: (await response.json()) as any };
}

async function waitFor(predicate: () => boolean, label = "condition"): Promise<void> {
	for (let attempt = 0; attempt < 600; attempt++) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error(`Timed out waiting for ${label}.`);
}

// 计划工作区写在 cwd 下（.pi/agent-team/...），测试结束统一删除。
let sharedCwd: string | undefined;
function isolatedCwd(): string {
	sharedCwd ??= mkdtempSync(join(tmpdir(), "pi-agent-team-peer-answer-"));
	return sharedCwd;
}
after(async () => {
	if (sharedCwd) await rm(sharedCwd, { recursive: true, force: true });
});

function context(): RuntimeContext & { snapshots: TeamState[] } {
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
	};
}

async function registered(): Promise<{
	runtime: TeamRuntime;
	compatibility: FakeCompatibility;
	ctx: RuntimeContext & { snapshots: TeamState[] };
}> {
	const compatibility = new FakeCompatibility();
	const runtime = new TeamRuntime(compatibility, () => NOW);
	const ctx = context();
	execFileSync("git", ["init", "-q"], { cwd: ctx.cwd });
	await runtime.execute({ action: "set-auto", auto: true }, ctx);
	await runtime.execute({ action: "plan", plan: PLAN }, ctx);
	return { runtime, compatibility, ctx };
}

function warningOf(runtime: TeamRuntime, memberId: string): string | undefined {
	return runtime.getState().teams.default.members[memberId].workspaceWarning;
}

// ---------------------------------------------------------------------------
// (1) 回答回合：前后快照 + 越界检测 + 与既有告警合并
// ---------------------------------------------------------------------------

test("a peer answer turn takes a workspace snapshot and reports out-of-scope writes", async () => {
	await withPeerExtension(async () => {
		const { runtime, compatibility, ctx } = await registered();
		compatibility.outputsByMember["coder-a"] = [executionReport("task-a")];
		compatibility.outputsByMember["coder-b"] = [executionReport("task-b")];
		compatibility.duringPrompt = (memberId, prompt) => {
			if (memberId === "coder-a" && prompt.includes("只读的同伴通信回合")) {
				writeFileSync(join(ctx.cwd, "answer-write.txt"), "answer turn wrote outside owned paths\n", "utf8");
			}
		};
		try {
			await runtime.execute({ action: "run", taskId: "task-a", background: false }, ctx);
			await runtime.execute({ action: "run", taskId: "task-b", background: false }, ctx);
			assert.equal(warningOf(runtime, "coder-a"), undefined, "干净的工作回合不产生告警");

			const sent = await post(peerOf(compatibility, "coder-b"), { action: "send", to: "coder-a", text: "为什么构建慢？" });
			assert.equal(sent.status, 200);
			assert.equal(sent.body.data.delivery, "answer-started", "空闲成员应开始一轮只读回答");

			await waitFor(() => warningOf(runtime, "coder-a")?.includes("answer-write.txt") ?? false, "answer turn workspace warning");
			const warning = warningOf(runtime, "coder-a")!;
			assert.match(warning, /changed outside ownedPaths: answer-write\.txt/u);

			// status 单成员视图直接可见。
			const status = await runtime.execute({ action: "status", member: { id: "coder-a" } }, ctx);
			assert.match(status.content[0].text, /workspace=.*answer-write\.txt/u);
		} finally {
			await runtime.shutdown(ctx);
		}
	});
});

test("a peer answer turn merges into the existing warning instead of clearing it", async () => {
	await withPeerExtension(async () => {
		const { runtime, compatibility, ctx } = await registered();
		compatibility.outputsByMember["coder-a"] = [executionReport("task-a")];
		compatibility.outputsByMember["coder-b"] = [executionReport("task-b")];
		compatibility.duringPrompt = (memberId, prompt) => {
			if (memberId !== "coder-a") return;
			if (prompt.includes("Execute planned task")) {
				writeFileSync(join(ctx.cwd, "merge-attempt.txt"), "attempt wrote outside owned paths\n", "utf8");
			}
			if (prompt.includes("只读的同伴通信回合")) {
				writeFileSync(join(ctx.cwd, "merge-answer.txt"), "answer turn wrote outside owned paths\n", "utf8");
			}
		};
		try {
			await runtime.execute({ action: "run", taskId: "task-a", background: false }, ctx);
			await runtime.execute({ action: "run", taskId: "task-b", background: false }, ctx);
			const first = warningOf(runtime, "coder-a");
			assert.match(first ?? "", /merge-attempt\.txt/u);

			await post(peerOf(compatibility, "coder-b"), { action: "send", to: "coder-a", text: "再确认一下构建耗时" });
			await waitFor(() => (warningOf(runtime, "coder-a")?.includes("merge-answer.txt") ?? false), "merged answer warning");

			const merged = warningOf(runtime, "coder-a")!;
			assert.match(merged, /merge-attempt\.txt/u, "旧告警不得被清空");
			assert.match(merged, /merge-answer\.txt/u);
			assert.ok(merged.indexOf("merge-attempt.txt") < merged.indexOf("merge-answer.txt"), "新告警追加在旧告警之后");

			// 合并函数本身：无新告警时保留旧值，有新告警时用分隔符追加。
			assert.equal(mergeWorkspaceWarning("old", undefined), "old");
			assert.equal(mergeWorkspaceWarning(undefined, "new"), "new");
			assert.equal(mergeWorkspaceWarning("old", "new"), "old | new");
		} finally {
			await runtime.shutdown(ctx);
		}
	});
});

// ---------------------------------------------------------------------------
// (2) steer 注入的消息 id 进入归因
// ---------------------------------------------------------------------------

test("steer-injected peer message ids appear in the drift attribution", async () => {
	await withPeerExtension(async () => {
		const { runtime, compatibility, ctx } = await registered();
		compatibility.outputsByMember["coder-a"] = [executionReport("task-a")];
		compatibility.outputsByMember["coder-b"] = [executionReport("task-b")];
		compatibility.duringPrompt = (memberId, prompt) => {
			if (memberId === "coder-a" && prompt.includes("Execute planned task")) {
				writeFileSync(join(ctx.cwd, "steer-write.txt"), "wrote after a steered peer message\n", "utf8");
			}
		};
		try {
			await runtime.execute({ action: "run", taskId: "task-b", background: false }, ctx);
			// coder-a 停在 RUNNING，steer 通道才成立。
			compatibility.blockNext("coder-a");
			await runtime.execute({ action: "run", taskId: "task-a", background: true }, ctx);
			await waitFor(() => runtime.getState().teams.default.members["coder-a"].status === "RUNNING", "coder-a running");

			const sent = await post(peerOf(compatibility, "coder-b"), { action: "send", to: "coder-a", text: "顺手改一下无关文件" });
			assert.equal(sent.status, 200);
			assert.equal(sent.body.data.delivery, "steered", "运行中的成员应通过 steer 注入");
			const steeredId = sent.body.data.messageId as string;
			assert.ok(steeredId);

			compatibility.client("coder-a").completeIdle();
			await waitFor(() => warningOf(runtime, "coder-a")?.includes("steer-write.txt") ?? false, "steer attribution warning");
			const warning = warningOf(runtime, "coder-a")!;
			assert.match(warning, /changed outside ownedPaths: steer-write\.txt/u);
			assert.match(warning, /this attempt injected peer messages: [^\n]*/u);
			assert.ok(warning.includes(steeredId), "steer 注入的消息 id 必须出现在归因里");
		} finally {
			await runtime.shutdown(ctx);
		}
	});
});

test("the Leader steer id is attributed too", async () => {
	const { runtime, compatibility, ctx } = await registered();
	compatibility.outputsByMember["coder-a"] = [executionReport("task-a")];
	compatibility.duringPrompt = (memberId, prompt) => {
		if (memberId === "coder-a" && prompt.includes("Execute planned task")) {
			writeFileSync(join(ctx.cwd, "leader-steer-write.txt"), "wrote after a leader steer\n", "utf8");
		}
	};
	try {
		compatibility.blockNext("coder-a");
		await runtime.execute({ action: "run", taskId: "task-a", background: true }, ctx);
		await waitFor(() => runtime.getState().teams.default.members["coder-a"].status === "RUNNING", "coder-a running");
		await runtime.execute({ action: "steer", member: { id: "coder-a" }, message: "顺手清理无关文件" }, ctx);

		compatibility.client("coder-a").completeIdle();
		await waitFor(() => warningOf(runtime, "coder-a")?.includes("leader-steer-write.txt") ?? false, "leader steer attribution");
		assert.match(warningOf(runtime, "coder-a")!, /injected peer messages: steer:/u, "Leader steer 用 steer:<id> 记账");
	} finally {
		await runtime.shutdown(ctx);
	}
});
