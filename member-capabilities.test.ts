import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	DEFAULT_MEMBER_CAPABILITIES,
	MEMBER_CAPABILITIES_FILE,
	loadMemberCapabilities,
} from "./member-capabilities.ts";

async function tempAgentDir(): Promise<string> {
	return mkdtemp(join(tmpdir(), "pi-agent-team-capabilities-"));
}

async function addExtension(agentDir: string, name: string): Promise<string> {
	const dir = join(agentDir, "extensions", name);
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, "index.ts"), "export default () => undefined;\n", "utf8");
	return dir;
}

test("default policy loads discovered local extensions minus the deny list", async () => {
	const agentDir = await tempAgentDir();
	try {
		const kept = [
			await addExtension(agentDir, "gotcha-recall"),
			await addExtension(agentDir, "agent-image"),
		];
		await addExtension(agentDir, "styled-outputs");
		await addExtension(agentDir, "footer");
		await addExtension(agentDir, "pi-agent-orchestrator");
		await addExtension(agentDir, "message-sound");
		await addExtension(agentDir, "artifacts");
		// Non-extension noise: an asset directory without an entry file, a dotfile, and a stray file.
		await mkdir(join(agentDir, "extensions", "assets"), { recursive: true });
		await writeFile(join(agentDir, "extensions", ".DS_Store"), "", "utf8");
		await writeFile(join(agentDir, "extensions", "notes.md"), "x", "utf8");

		const capabilities = await loadMemberCapabilities({ agentDir });
		assert.equal(capabilities.mcp, true);
		assert.deepEqual(capabilities.extensions, [...kept].sort());
		assert.deepEqual(capabilities.diagnostics, []);
	} finally {
		await rm(agentDir, { recursive: true, force: true });
	}
});

test("auto mode also loads top-level extension files and skips the deny list", async () => {
	const agentDir = await tempAgentDir();
	try {
		const extensions = join(agentDir, "extensions");
		await mkdir(extensions, { recursive: true });
		const kept = join(extensions, "prompt-prefix.ts");
		await writeFile(kept, "export default () => undefined;\n", "utf8");
		await writeFile(join(extensions, "message-sound.ts"), "export default () => undefined;\n", "utf8");

		const capabilities = await loadMemberCapabilities({ agentDir });
		assert.deepEqual(capabilities.extensions, [kept]);
	} finally {
		await rm(agentDir, { recursive: true, force: true });
	}
});

test("list mode loads only include entries and reports missing ones", async () => {
	const agentDir = await tempAgentDir();
	try {
		const gotcha = await addExtension(agentDir, "gotcha-recall");
		const agentImage = await addExtension(agentDir, "agent-image");
		await writeFile(
			join(agentDir, MEMBER_CAPABILITIES_FILE),
			JSON.stringify({
				mcp: false,
				plugins: {
					mode: "list",
					include: ["gotcha-recall", "npm:@example/pi-tools", agentImage, "/abs/missing.ts", "missing-one"],
				},
			}),
			"utf8",
		);

		const capabilities = await loadMemberCapabilities({ agentDir });
		assert.equal(capabilities.mcp, false);
		// 不存在的绝对路径不再传给 -e（否则 pi 退出、成员起不来），降级为诊断 + 跳过。
		assert.deepEqual(capabilities.extensions, [gotcha, "npm:@example/pi-tools", agentImage]);
		assert.equal(capabilities.diagnostics.length, 2);
		assert.ok(capabilities.diagnostics.some((line) => line.includes("missing-one")));
		assert.ok(capabilities.diagnostics.some((line) => line.includes("/abs/missing.ts")));
	} finally {
		await rm(agentDir, { recursive: true, force: true });
	}
});

test("deny list matches case-insensitively and still applies in list mode", async () => {
	const agentDir = await tempAgentDir();
	const outside = await mkdtemp(join(tmpdir(), "pi-agent-team-outside-"));
	try {
		const kept = await addExtension(agentDir, "gotcha-recall");
		// macOS 上目录名大小写不同、带尾随空格，都不应绕过 deny list。
		await addExtension(agentDir, "Artifacts");
		await addExtension(agentDir, "message-sound ");

		const auto = await loadMemberCapabilities({ agentDir });
		assert.deepEqual(auto.extensions, [kept]);

		await writeFile(
			join(agentDir, MEMBER_CAPABILITIES_FILE),
			JSON.stringify({
				mcp: true,
				plugins: { mode: "list", include: ["gotcha-recall", "Artifacts"], exclude: ["artifacts"] },
			}),
			"utf8",
		);
		const listed = await loadMemberCapabilities({ agentDir });
		assert.deepEqual(listed.extensions, [kept]);
		assert.ok(listed.diagnostics.some((line) => line.includes("is excluded")));

		// 绝对路径与 npm: 条目不能只比 basename：Artifacts/index.ts 的 basename 是 index.ts。
		await mkdir(join(outside, "Artifacts"), { recursive: true });
		await writeFile(join(outside, "Artifacts", "index.ts"), "export default () => undefined;\n", "utf8");
		await writeFile(join(outside, "artifacts.ts"), "export default () => undefined;\n", "utf8");
		await writeFile(
			join(agentDir, MEMBER_CAPABILITIES_FILE),
			JSON.stringify({
				mcp: true,
				plugins: {
					mode: "list",
					include: [
						join(outside, "Artifacts", "index.ts"),
						join(outside, "artifacts.ts"),
						"npm:@scope/artifacts",
					],
					exclude: ["artifacts"],
				},
			}),
			"utf8",
		);
		const absolute = await loadMemberCapabilities({ agentDir });
		assert.deepEqual(absolute.extensions, []);
		assert.equal(absolute.diagnostics.length, 3);
		assert.ok(absolute.diagnostics.every((line) => line.includes("is excluded")));

		// 软链把被排除目录包装成无害名字，也要按真实路径拦截。
		const link = join(agentDir, "harmless-ext");
		await symlink(join(outside, "Artifacts", "index.ts"), link);
		await writeFile(
			join(agentDir, MEMBER_CAPABILITIES_FILE),
			JSON.stringify({ plugins: { mode: "list", include: [link], exclude: ["artifacts"] } }),
			"utf8",
		);
		const linked = await loadMemberCapabilities({ agentDir });
		assert.deepEqual(linked.extensions, []);
		assert.ok(linked.diagnostics.some((line) => line.includes("is excluded")));
	} finally {
		await rm(agentDir, { recursive: true, force: true });
		await rm(outside, { recursive: true, force: true });
	}
});

test("invalid JSON and invalid fields fall back to defaults without throwing", async () => {
	const agentDir = await tempAgentDir();
	try {
		await writeFile(join(agentDir, MEMBER_CAPABILITIES_FILE), "{ not json", "utf8");
		const broken = await loadMemberCapabilities({ agentDir });
		assert.equal(broken.mcp, DEFAULT_MEMBER_CAPABILITIES.mcp);
		assert.equal(broken.diagnostics.length, 1);

		await writeFile(
			join(agentDir, MEMBER_CAPABILITIES_FILE),
			JSON.stringify({ mcp: "yes", plugins: { mode: "sometimes", include: "one" } }),
			"utf8",
		);
		const normalized = await loadMemberCapabilities({ agentDir });
		assert.equal(normalized.mcp, DEFAULT_MEMBER_CAPABILITIES.mcp);
		assert.deepEqual(normalized.extensions, []);
		assert.equal(normalized.diagnostics.length, 3);

		// Root and plugins of the wrong shape fall back instead of throwing.
		await writeFile(join(agentDir, MEMBER_CAPABILITIES_FILE), JSON.stringify([]), "utf8");
		const rootArray = await loadMemberCapabilities({ agentDir });
		assert.equal(rootArray.mcp, DEFAULT_MEMBER_CAPABILITIES.mcp);
		assert.equal(rootArray.diagnostics.length, 1);

		await writeFile(
			join(agentDir, MEMBER_CAPABILITIES_FILE),
			JSON.stringify({ plugins: "all" }),
			"utf8",
		);
		const pluginsString = await loadMemberCapabilities({ agentDir });
		assert.equal(pluginsString.mcp, DEFAULT_MEMBER_CAPABILITIES.mcp);
		assert.equal(pluginsString.diagnostics.length, 1);
	} finally {
		await rm(agentDir, { recursive: true, force: true });
	}
});
