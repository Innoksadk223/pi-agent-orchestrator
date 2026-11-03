import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PiCompatibilityAdapter, type AdapterOverrides, type RpcClientLike } from "./compat.ts";

// 能力发现默认读真实 agent 目录；契约测试指向不存在的目录以保持确定性。
const NO_CAPABILITIES = { agentDir: "/nonexistent/pi-agent-team-test-agent-dir" };

function fakeClient(): RpcClientLike {
	return {
		start: async () => undefined,
		stop: async () => undefined,
		onEvent: () => () => undefined,
		prompt: async () => undefined,
		waitForIdle: async () => undefined,
		abort: async () => undefined,
		// 原生 steer passthrough:Pi 公开 RpcClient.steer 的可选透传,供 runtime 对活动成员注入。
		steer: async () => undefined,
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

test("createMemberClient assembles an optional member head prompt before fixed instructions", async () => {
	let promptPath = "";
	let args: string[] = [];
	const adapter = new PiCompatibilityAdapter({
		version: "0.84.1",
		cliPath: "/fake/pi",
		capabilityOptions: NO_CAPABILITIES,
		factory: (options) => {
			args = options.args ?? [];
			promptPath = args[args.indexOf("--append-system-prompt") + 1] ?? "";
			return fakeClient();
		},
		listSessions: async () => [],
	});
	const handle = await adapter.createMemberClient({ ...BASE_MEMBER, headPrompt: "成员头部规则" });
	const prompt = await readFile(promptPath, "utf8");
	assert.ok(prompt.indexOf("成员头部规则") < prompt.indexOf("write only"));
	// 成员保留技能发现：只隔离扩展，不传 --no-skills。
	assert.equal(args.includes("--no-skills"), false);
	await handle.cleanupPrompt();
});

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
		capabilityOptions: NO_CAPABILITIES,
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
		capabilityOptions: NO_CAPABILITIES,
	};
	const adapter = new PiCompatibilityAdapter(overrides);
	const handle = await adapter.createMemberClient({ ...BASE_MEMBER, sessionId: "any-id" });
	assert.equal(handle.restored, false);
	assert.ok(!calls[0].args.includes("--session-id"));
});

test("createMemberClient passes the optional public steer surface through untouched", async () => {
	const steered: string[] = [];
	let created = 0;
	const adapter = new PiCompatibilityAdapter({
		version: "0.84.1",
		cliPath: "/fake/pi",
		capabilityOptions: NO_CAPABILITIES,
		factory: () => {
			created++;
			return { ...fakeClient(), steer: async (message: string) => { steered.push(message); } };
		},
		listSessions: async () => [],
	});
	const handle = await adapter.createMemberClient({ ...BASE_MEMBER, sessionId: "steer-session" });
	assert.equal(typeof handle.client.steer, "function");
	await handle.client.steer?.("优先处理契约测试");
	assert.deepEqual(steered, ["优先处理契约测试"]);
	assert.equal(created, 1);

	// 缺省 client(旧/内嵌适配器无公开 steer)保持可选,runtime 会显式拒绝而不是伪造冻结 RPC。
	const bare = new PiCompatibilityAdapter({
		version: "0.82.1",
		cliPath: "/fake/pi",
		capabilityOptions: NO_CAPABILITIES,
		factory: () => {
			const client = fakeClient();
			delete (client as unknown as { steer?: unknown }).steer;
			return client;
		},
		listSessions: async () => [],
	});
	const bareHandle = await bare.createMemberClient({ ...BASE_MEMBER, sessionId: "bare-session" });
	assert.equal(bareHandle.client.steer, undefined);
});

async function withExtensionFixture(
	version: string,
	run: (args: string[], extensionDir: string) => Promise<void>,
	memberOverrides: Partial<typeof BASE_MEMBER> = {},
): Promise<void> {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-agent-team-compat-"));
	const extensionDir = join(agentDir, "extensions", "gotcha-recall");
	await mkdir(extensionDir, { recursive: true });
	await writeFile(join(extensionDir, "index.ts"), "export default () => undefined;\n", "utf8");
	try {
		let args: string[] = [];
		const adapter = new PiCompatibilityAdapter({
			version,
			cliPath: "/fake/pi",
			capabilityOptions: { agentDir },
			factory: (options) => {
				args = options.args ?? [];
				return fakeClient();
			},
			listSessions: async () => [],
		});
		const handle = await adapter.createMemberClient({ ...BASE_MEMBER, sessionId: "caps-session", ...memberOverrides });
		await run(args, extensionDir);
		await handle.cleanupPrompt();
	} finally {
		await rm(agentDir, { recursive: true, force: true });
	}
}

function loadedExtensions(args: string[]): string[] {
	const loaded: string[] = [];
	for (let index = 0; index < args.length; index++) {
		if (args[index] === "--extension" && args[index + 1]) loaded.push(args[index + 1]);
	}
	return loaded;
}

test("createMemberClient loads allowlisted local extensions and builtin:mcp on current Pi", async () => {
	await withExtensionFixture("1.4.0", async (args, extensionDir) => {
		assert.ok(args.includes("--no-extensions"));
		assert.deepEqual(loadedExtensions(args), [extensionDir, "builtin:mcp"]);
	});
});

test("createMemberClient skips builtin:mcp below Pi 0.99.0 but keeps local extensions", async () => {
	await withExtensionFixture("0.98.0", async (args, extensionDir) => {
		assert.deepEqual(loadedExtensions(args), [extensionDir]);
	});
});

test("createMemberClient includes builtin:mcp at the 0.99.0 boundary", async () => {
	await withExtensionFixture("0.99.0", async (args, extensionDir) => {
		assert.deepEqual(loadedExtensions(args), [extensionDir, "builtin:mcp"]);
	});
});

test("createMemberClient exposes MCP tools through an explicit allowlist with mcp__*", async () => {
	await withExtensionFixture(
		"1.4.0",
		async (args) => {
			const tools = (args[args.indexOf("--tools") + 1] ?? "").split(",");
			assert.ok(tools.includes("read"));
			// 传了 --tools 时 Pi 只声明匹配条目的 MCP 工具，必须显式给通配。
			assert.ok(tools.includes("mcp__*"));
		},
		{ tools: ["read", "bash"], allowMcpTools: true },
	);
});

test("createMemberClient keeps MCP closed for read-only members unless they ask explicitly", async () => {
	await withExtensionFixture(
		"1.4.0",
		async (args) => {
			const tools = (args[args.indexOf("--tools") + 1] ?? "").split(",");
			assert.equal(tools.includes("mcp__*"), false, "只读角色不自动扩到 MCP");
		},
		{ tools: ["read", "bash"] },
	);
	await withExtensionFixture(
		"1.4.0",
		async (args) => {
			const tools = (args[args.indexOf("--tools") + 1] ?? "").split(",");
			assert.ok(tools.includes("mcp__docs"), "显式列出的 MCP 工具照常可用");
		},
		{ tools: ["read", "mcp__docs"] },
	);
});

test("createMemberClient omits mcp__* when builtin:mcp is skipped", async () => {
	await withExtensionFixture(
		"0.98.0",
		async (args) => {
			const tools = (args[args.indexOf("--tools") + 1] ?? "").split(",");
			assert.equal(tools.includes("mcp__*"), false);
		},
		{ tools: ["read", "bash"] },
	);
});
