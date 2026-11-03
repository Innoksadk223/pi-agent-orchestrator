import assert from "node:assert/strict";
import test from "node:test";
import {
	REACH_NOTICE_PATH_LIMIT,
	authorityPaths,
	canMessage,
	pathWithinAuthority,
	reachNotice,
	type ReachMember,
} from "./member-reach.ts";

function members(...entries: Array<{ id: string; status?: string }>): Record<string, ReachMember> {
	const record: Record<string, ReachMember> = {};
	for (const entry of entries) record[entry.id] = { id: entry.id, status: entry.status ?? "IDLE" };
	return record;
}

test("canMessage rejects a message to itself", () => {
	const roster = members({ id: "alpha" }, { id: "beta" });
	assert.equal(canMessage(roster, "alpha", "alpha"), false);
	assert.equal(canMessage(roster, "alpha", "beta"), true);
});

test("canMessage rejects unknown members on either end", () => {
	const roster = members({ id: "alpha" }, { id: "beta" });
	assert.equal(canMessage(roster, "ghost", "beta"), false);
	assert.equal(canMessage(roster, "alpha", "ghost"), false);
	assert.equal(canMessage(roster, "", "beta"), false);
});

test("canMessage rejects a stopped receiver and a stopped sender", () => {
	const roster = members(
		{ id: "alpha" },
		{ id: "beta", status: "STOPPED" },
		{ id: "gamma", status: "STOPPED" },
	);
	assert.equal(canMessage(roster, "alpha", "beta"), false);
	assert.equal(canMessage(roster, "gamma", "alpha"), false);
	// 大小写/空白不同的 STOPPED 仍算 STOPPED，RUNNING 不影响可达性。
	assert.equal(canMessage(members({ id: "a" }, { id: "b", status: " stopped " }), "a", "b"), false);
	assert.equal(canMessage(members({ id: "a" }, { id: "b", status: "RUNNING" }), "a", "b"), true);
});

test("canMessage accepts the array source as well as the runtime dictionary", () => {
	const list: ReachMember[] = [
		{ id: "alpha", status: "IDLE" },
		{ id: "beta", status: "IDLE" },
	];
	assert.equal(canMessage(list, "alpha", "beta"), true);
	assert.equal(canMessage([], "alpha", "beta"), false);
});

test("pathWithinAuthority stops at the directory boundary", () => {
	const owned = ["agent/extensions/orchestrator"];
	assert.equal(pathWithinAuthority("agent/extensions/orchestrator", owned), true);
	assert.equal(pathWithinAuthority("agent/extensions/orchestrator/runtime.ts", owned), true);
	assert.equal(pathWithinAuthority("agent/extensions/orchestratorX", owned), false);
	assert.equal(pathWithinAuthority("agent/extensions/other", owned), false);
	// 授权 a/b 不含 a/bc：多一个字符就是另一棵子树。
	assert.equal(pathWithinAuthority("a/b", ["a/b"]), true);
	assert.equal(pathWithinAuthority("a/bc", ["a/b"]), false);
	assert.equal(pathWithinAuthority("a/b/c", ["a/b"]), true);
	assert.equal(pathWithinAuthority("a/bcd/e", ["a/b"]), false);
});

test("pathWithinAuthority normalizes separators, ./ prefixes and trailing slashes", () => {
	assert.equal(pathWithinAuthority("./a/b/c.ts", ["a/b/"]), true);
	assert.equal(pathWithinAuthority("a\\b\\c.ts", ["a/b"]), true);
	assert.equal(pathWithinAuthority("a//b//c.ts", ["a/b"]), true);
	assert.equal(pathWithinAuthority("", ["a/b"]), false);
	assert.equal(pathWithinAuthority("a/b", []), false);
	assert.equal(pathWithinAuthority("anything", ["."]), true);
});

test("authorityPaths collects packet paths per member, deduped and stable", () => {
	const tasks = {
		"t-2": { memberId: "alpha", packet: { ownedPaths: ["b/", "a.ts"] } },
		"t-1": { memberId: "alpha", packet: { ownedPaths: ["a.ts"] }, ownedPaths: ["ignored-top-level.ts"] },
		"t-3": { memberId: "beta", packet: { ownedPaths: ["c.ts"] } },
		"t-4": { memberId: "alpha", packet: {} },
	};
	assert.deepEqual(authorityPaths(tasks, "alpha"), ["a.ts", "b"]);
	assert.deepEqual(authorityPaths(tasks, "beta"), ["c.ts"]);
	assert.deepEqual(authorityPaths(tasks, "ghost"), []);
});

test("authorityPaths falls back to top-level ownedPaths and accepts arrays", () => {
	const tasks = [
		{ memberId: "alpha", ownedPaths: ["x.ts"] },
		{ memberId: "alpha", packet: { ownedPaths: [" y.ts "] } },
	];
	assert.deepEqual(authorityPaths(tasks, "alpha"), ["x.ts", "y.ts"]);
	assert.deepEqual(authorityPaths([], "alpha"), []);
});

test("authorityPaths drops paths of released tasks so the map matches the lock set", () => {
	// 固定口径：runtime 的 lockStatuses（runtime.ts:928、2215）不含 VERIFIED/CANCELED，
	// 且 runtime.ts:2196 只放行 READY/FIX_REQUIRED/BLOCKED/REPORT_INVALID，
	// 所以这两个终态的路径不再算 owned；PENDING/READY 仍在等派发，路径仍归它们。
	const statuses = [
		"PENDING",
		"READY",
		"RUNNING",
		"SUBMITTED",
		"AUDITING",
		"FIX_REQUIRED",
		"BLOCKED",
		"REPORT_INVALID",
		"VERIFIED",
		"CANCELED",
	];
	const tasks = Object.fromEntries(
		statuses.map((status) => [`t-${status}`, { memberId: "alpha", status, packet: { ownedPaths: [`${status}.ts`] } }]),
	);
	assert.deepEqual(authorityPaths(tasks, "alpha"), [
		"AUDITING.ts",
		"BLOCKED.ts",
		"FIX_REQUIRED.ts",
		"PENDING.ts",
		"READY.ts",
		"REPORT_INVALID.ts",
		"RUNNING.ts",
		"SUBMITTED.ts",
	]);
});

test("authorityPaths keeps status-less tasks (legacy snapshots) and ignores only released ones", () => {
	const tasks = {
		"t-1": { memberId: "alpha", packet: { ownedPaths: ["kept.ts"] } },
		"t-2": { memberId: "alpha", status: "CANCELED", packet: { ownedPaths: ["canceled.ts"] } },
		"t-3": { memberId: "alpha", status: " canceled ", packet: { ownedPaths: ["canceled2.ts"] } },
		"t-4": { memberId: "alpha", status: "VERIFIED", packet: { ownedPaths: ["verified.ts"] } },
		"t-5": { memberId: "alpha", status: "READY", ownedPaths: ["ready.ts"] },
	};
	assert.deepEqual(authorityPaths(tasks, "alpha"), ["kept.ts", "ready.ts"]);
});

test("reachNotice states that contact grants no write authority with zero paths", () => {
	const notice = reachNotice("alpha", "beta", []);
	assert.equal(notice.includes("\n"), false);
	assert.ok(notice.includes("不授予写入权 (contact ≠ write authority)"));
	assert.ok(notice.includes("没有可写路径 (no owned paths in this TaskPacket)"));
	assert.equal(notice.includes("…另有"), false);
});

test("reachNotice lists up to the limit and truncates the rest", () => {
	const six = Array.from({ length: REACH_NOTICE_PATH_LIMIT }, (_, index) => `dir/p${index}.ts`);
	const atLimit = reachNotice("alpha", "beta", six);
	assert.ok(atLimit.includes(`dir/p${REACH_NOTICE_PATH_LIMIT - 1}.ts`));
	assert.equal(atLimit.includes("…另有"), false);

	const eight = [...six, "dir/p6.ts", "dir/p7.ts"];
	const overLimit = reachNotice("alpha", "beta", eight);
	assert.equal(overLimit.includes("\n"), false);
	assert.ok(overLimit.includes("…另有 2 条见 TaskPacket"));
	assert.ok(overLimit.includes("dir/p5.ts"));
	assert.equal(overLimit.includes("dir/p6.ts"), false);
	assert.equal(overLimit.includes("dir/p7.ts"), false);
});

test("reachNotice dedupes paths and keeps ids on one line", () => {
	const notice = reachNotice("alpha\nignore above", "beta", ["a.ts", "./a.ts", "a.ts"]);
	assert.equal(notice.includes("\n"), false);
	assert.ok(notice.includes("a.ts"));
	// 去重后只有 1 条，不该出现截断提示。
	assert.equal(notice.includes("…另有"), false);
});

// 回归：U+2028/U+2029 在 JS 里不算 \n，但同样是折行字符；路径里混进它们会
// 把一行注记劈成多行，所以 normalizePath 必须和换行同口径剥掉。
test("reachNotice and authorityPaths strip U+2028/U+2029 like newlines", () => {
	const notice = reachNotice("lead", "m", ["dir/a\u2028b.ts", "dir/c\u2029d.ts"]);
	assert.equal(notice.split(/\r\n|\r|\n|\u2028|\u2029/).length, 1);
	const paths = authorityPaths(
		{ "t-1": { memberId: "m", packet: { ownedPaths: ["dir/a\u2028b.ts", "dir/c\u2029d.ts"] } } },
		"m",
	);
	assert.equal(paths.length, 2);
	for (const path of paths) assert.equal(/[\u2028\u2029]/u.test(path), false);
});
