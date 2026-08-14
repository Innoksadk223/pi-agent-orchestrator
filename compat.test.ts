import assert from "node:assert/strict";
import test from "node:test";
import { PiCompatibilityAdapter, type AdapterOverrides, type RpcClientLike } from "./compat.ts";

function fakeClient(): RpcClientLike {
	return {
		start: async () => undefined,
		stop: async () => undefined,
		onEvent: () => () => undefined,
		prompt: async () => undefined,
		waitForIdle: async () => undefined,
		abort: async () => undefined,
		setModel: async () => undefined,
		setThinkingLevel: async () => undefined,
		getState: async () => ({ sessionId: "child-session" }),
		setSessionName: async () => undefined,
		getSessionStats: async () => ({ assistantMessages: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0 }),
		getLastAssistantText: async () => null,
		compact: async () => ({ summary: "", firstKeptEntryId: "", tokensBefore: 0 }),
		setAutoCompaction: async () => undefined,
	};
}

const BASE_MEMBER = {
	team: "default",
	id: "coder",
	role: "Coder",
	instructions: "write only",
	model: { provider: "p", id: "m" },
	thinking: "high",
	tools: [],
	cwd: "/tmp/project",
	trusted: true,
	workspace: "/tmp/project/.team",
};

test("createMemberClient passes --session-id only when that session file already exists", async () => {
	const calls: Array<{ args: string[] }> = [];
	const overrides: AdapterOverrides = {
		version: "0.84.1",
		cliPath: "/fake/pi",
		factory: (options) => {
			calls.push({ args: options.args ?? [] });
			return fakeClient();
		},
		listSessions: async () => [{ id: "existing-id" }],
	};
	const adapter = new PiCompatibilityAdapter(overrides);

	// Session file exists -> resumed: --session-id is passed, restored is true.
	const resumed = await adapter.createMemberClient({ ...BASE_MEMBER, sessionId: "existing-id" });
	assert.equal(resumed.restored, true);
	assert.ok(calls[0].args.includes("--session-id"));
	assert.equal(calls[0].args[calls[0].args.indexOf("--session-id") + 1], "existing-id");

	// Fresh id -> first launch: no --session-id, restored is false.
	const first = await adapter.createMemberClient({ ...BASE_MEMBER, sessionId: "fresh-id" });
	assert.equal(first.restored, false);
	assert.ok(!calls[1].args.includes("--session-id"));
});

test("createMemberClient probe failure falls back to first launch (no warning path)", async () => {
	const calls: Array<{ args: string[] }> = [];
	const overrides: AdapterOverrides = {
		version: "0.84.1",
		cliPath: "/fake/pi",
		factory: (options) => {
			calls.push({ args: options.args ?? [] });
			return fakeClient();
		},
		listSessions: async () => {
			throw new Error("probe failed");
		},
	};
	const adapter = new PiCompatibilityAdapter(overrides);
	const handle = await adapter.createMemberClient({ ...BASE_MEMBER, sessionId: "any-id" });
	assert.equal(handle.restored, false);
	assert.ok(!calls[0].args.includes("--session-id"));
});
