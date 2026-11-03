import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { observeLeaderStatus } from "./index.ts";
import type { DashboardLeaderState } from "./web-dashboard.ts";

function fixture(idle = true) {
	const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
	const sent: DashboardLeaderState[] = [];
	const pi = { on(name: string, handler: (event: any, ctx: any) => unknown) {
		const list = handlers.get(name) ?? [];
		list.push(handler);
		handlers.set(name, list);
	} } as unknown as Pick<ExtensionAPI, "on">;
	const snapshot = observeLeaderStatus(pi, (state) => sent.push(state));
	return {
		snapshot, sent,
		async emit(type: string, data = {}, isIdle = idle) {
			for (const handler of handlers.get(type) ?? []) await handler({ type, ...data }, { isIdle: () => isIdle });
		},
	};
}

test("主会话仅由真实生命周期切换，agent_end 不提前报空闲", async () => {
	const f = fixture();
	assert.deepEqual(f.snapshot(), { status: "UNKNOWN", tools: [] });
	await f.emit("session_start");
	assert.equal(f.snapshot().status, "IDLE");
	await f.emit("agent_start");
	assert.equal(f.snapshot().status, "RUNNING");
	await f.emit("agent_end", { messages: [{ content: "private message" }] });
	assert.equal(f.snapshot().status, "RUNNING");
	await f.emit("agent_settled");
	assert.deepEqual(f.snapshot(), { status: "IDLE", tools: [] });
	await f.emit("session_shutdown");
	assert.deepEqual(f.snapshot(), { status: "UNKNOWN", tools: [] });
	assert.ok(!JSON.stringify(f.sent).includes("private message"));
});

test("并行工具按 callId 跟踪，单个结束不中途报空闲，不发送参数或结果", async () => {
	const f = fixture();
	await f.emit("agent_start");
	for (const id of ["a", "b"]) await f.emit("tool_execution_start", { toolCallId: id, toolName: "read", args: { secret: "private args" } });
	assert.deepEqual(f.snapshot(), { status: "TOOL", tools: ["read"] });
	await f.emit("tool_execution_end", { toolCallId: "a", result: "private result", isError: true });
	assert.deepEqual(f.snapshot(), { status: "TOOL", tools: ["read"] });
	await f.emit("tool_execution_start", { toolCallId: "c", toolName: "bash" });
	await f.emit("tool_execution_end", { toolCallId: "b" });
	assert.deepEqual(f.snapshot(), { status: "TOOL", tools: ["bash"] });
	await f.emit("tool_execution_end", { toolCallId: "unknown" });
	assert.equal(f.snapshot().status, "TOOL");
	await f.emit("tool_execution_end", { toolCallId: "c" });
	assert.deepEqual(f.snapshot(), { status: "RUNNING", tools: [] });
	await f.emit("agent_end");
	assert.equal(f.snapshot().status, "RUNNING");
	await f.emit("agent_settled");
	assert.equal(f.snapshot().status, "IDLE");
	assert.ok(!JSON.stringify(f.sent).includes("private"));
});

test("重载/替换会话清空旧工具，启动非空闲不误报空闲，工具名有界且快照不共享", async () => {
	const f = fixture();
	await f.emit("tool_execution_start", { toolCallId: "old", toolName: "old-tool" });
	await f.emit("session_start", { reason: "reload" }, false);
	assert.deepEqual(f.snapshot(), { status: "RUNNING", tools: [] });
	await f.emit("tool_execution_end", { toolCallId: "old" });
	assert.deepEqual(f.snapshot(), { status: "RUNNING", tools: [] });
	for (let i = 0; i < 5; i++) await f.emit("tool_execution_start", { toolCallId: String(i), toolName: String(i).repeat(100) });
	assert.equal(f.snapshot().tools.length, 3);
	assert.ok(f.snapshot().tools.every((name) => name.length <= 64));
	const external = f.snapshot();
	external.tools.push("mutated");
	external.status = "IDLE";
	assert.equal(f.snapshot().status, "TOOL");
	assert.equal(f.snapshot().tools.length, 3);
	await f.emit("session_shutdown");
	await f.emit("session_start", { reason: "resume" });
	assert.deepEqual(f.snapshot(), { status: "IDLE", tools: [] });
	await f.emit("tool_execution_end", { toolCallId: "1" });
	assert.deepEqual(f.snapshot(), { status: "IDLE", tools: [] });
});
