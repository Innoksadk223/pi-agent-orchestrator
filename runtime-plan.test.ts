import assert from "node:assert/strict";
import test from "node:test";
import {
	type ExecutionTask,
	type ExecutionTaskStatus,
	healthLevelFor,
	MAX_MEMBER_MESSAGE_CHARS,
	MAX_MEMBER_MESSAGE_QUEUE_PER_RECEIVER,
	MAX_REPORT_MESSAGES,
	MEMBER_HEALTH_THRESHOLDS,
	migrateState,
	parseReportEnvelope,
	planConfirmation,
	resolveTaskCancellation,
	STATE_SCHEMA_VERSION,
	type TeamState,
	validateToolRequest,
} from "./runtime.ts";
import { AgentTeamParams } from "./schema.ts";

function task(id: string, memberId: string, status: ExecutionTaskStatus, dependsOn: string[] = []): ExecutionTask {
	return {
		id,
		memberId,
		status,
		dependsOn,
		packet: {
			objective: `o-${id}`,
			constraints: [],
			dependencySummaries: {},
			ownedPaths: [`src/${id}`],
			acceptance: [`a-${id}`],
			relevantPaths: [],
			outputContract: "contract",
		},
		attempt: 0,
		updatedAt: "t",
	};
}

function member(id: string, role = `role-${id}`, instructions = `inst-${id}`) {
	return { id, kind: "coder" as const, role, instructions };
}

function stateWithPlan(tasks: Record<string, ExecutionTask> = {}): TeamState {
	return {
		schemaVersion: STATE_SCHEMA_VERSION,
		teams: {
			default: {
				id: "default",
				members: {},
				plan: {
					revision: 1,
					reviewerId: "rev",
					memberKinds: { rev: "reviewer" },
					acceptance: ["done"],
					registeredAt: "t0",
					updatedAt: "t0",
				},
				executionTasks: tasks,
				reviewRounds: {},
				expertRounds: {},
				pendingRequests: [],
			},
		},
		updatedAt: "t",
	};
}

test("cancel resolves every non-in-flight status directly", () => {
	const tasks = Object.fromEntries(
		(["PENDING", "READY", "BLOCKED", "REPORT_INVALID"] as ExecutionTaskStatus[]).map((status) => [status.toLowerCase(), task(status.toLowerCase(), "c", status)]),
	);
	const resolved = resolveTaskCancellation(tasks, ["pending", "ready", "blocked", "report_invalid"]);
	assert.deepEqual(
		resolved.map(({ id, direct }) => ({ id, direct })).sort((x, y) => x.id.localeCompare(y.id)),
		[
			{ id: "blocked", direct: true },
			{ id: "pending", direct: true },
			{ id: "ready", direct: true },
			{ id: "report_invalid", direct: true },
		],
	);
});

test("cancel rejects in-flight and review-loop statuses", () => {
	for (const status of ["RUNNING", "SUBMITTED", "FIX_REQUIRED", "VERIFIED", "CANCELED"] as ExecutionTaskStatus[]) {
		assert.throws(() => resolveTaskCancellation({ x: task("x", "c", status) }, ["x"]), /cannot be canceled from/u, status);
	}
});

test("cancel throws on unknown task ids", () => {
	assert.throws(() => resolveTaskCancellation({}, ["ghost"]), /Unknown execution task/u);
});

test("cancel cascades transitively through PENDING and READY dependents only", () => {
	const tasks = {
		a: task("a", "c1", "READY"),
		pendingChild: task("pendingChild", "c2", "PENDING", ["a"]),
		readyGrandchild: task("readyGrandchild", "c3", "PENDING", ["pendingChild"]),
		blockedSibling: task("blockedSibling", "c4", "BLOCKED", ["a"]),
		independent: task("independent", "c5", "PENDING"),
	};
	const resolved = resolveTaskCancellation(tasks, ["a"]);
	assert.deepEqual(
		resolved.map(({ id, direct }) => ({ id, direct })).sort((x, y) => x.id.localeCompare(y.id)),
		[
			{ id: "a", direct: true },
			{ id: "pendingChild", direct: false },
			{ id: "readyGrandchild", direct: false },
		],
	);
});

test("plan confirmation for initial registration renders the full view", () => {
	const text = planConfirmation(
		"t1",
		{
			configs: { coder: { ...member("coder"), model: { provider: "p", id: "m" }, thinking: "medium", tools: [] } },
			memberKinds: { coder: "coder" },
			tasks: { impl: task("impl", "coder", "READY") },
			acceptance: ["done"],
			reviewerId: "rev",
		},
		1,
	);
	assert.match(text, /## Roster \(1\)/u);
	assert.match(text, /## Execution DAG \(1 tasks\)/u);
	assert.match(text, /## Global acceptance \(1\)/u);
	assert.doesNotMatch(text, /Changes vs approved/u);
});

function memberState(id: string, instructions: string): import("./runtime.ts").MemberState {
	const config = {
		...member(id, `role-${id}`, instructions),
		model: { provider: "p", id: "m" },
		thinking: "medium" as const,
		tools: ["read"],
	};
	return {
		...config,
		team: "t1",
		configHash: "hash-" + instructions,
		approvedAt: "t0",
		sessionId: "s-" + id,
		status: "APPROVED" as const,
	};
}

function amendedPlan() {
	return {
		configs: {
			coder: { ...member("coder", undefined, "inst-coder-v2"), model: { provider: "p", id: "m" }, thinking: "medium", tools: ["read"] },
			fixer: { ...member("fixer"), model: { provider: "p", id: "m" }, thinking: "medium", tools: [] },
		},
		memberKinds: { coder: "coder", fixer: "coder" } as Record<string, import("./runtime.ts").PlanMemberKind>,
		tasks: {
			impl: task("impl", "coder", "SUBMITTED"),
			rework: task("rework", "fixer", "PENDING", ["impl"]),
		},
		acceptance: ["done", "extra"],
		reviewerId: "rev-b",
	};
}

function approvedTeam(): import("./runtime.ts").TeamRecord {
	return {
		id: "t1",
		members: { coder: memberState("coder", "inst-coder-v1") },
		plan: {
			revision: 2,
			reviewerId: "rev-a",
			memberKinds: { coder: "coder" },
			acceptance: ["done", "obsolete"],
			registeredAt: "t0",
			updatedAt: "t0",
		},
		executionTasks: { impl: task("impl", "coder", "SUBMITTED") },
		reviewRounds: {},
		expertRounds: {},
		pendingRequests: [],
	};
}

// planConfirmation is called with the prepared plan and the approved team record.
test("amendment confirmation renders a delta view with reviewer highlight", () => {
	const text = planConfirmation("t1", amendedPlan(), 3, approvedTeam());
	assert.match(text, /⚠ Reviewer changed: rev-a → rev-b/u);
	assert.match(text, /## Changes vs approved revision 2/u);
	assert.match(text, /### Roster \(\+1 \/ ~1\)/u); // fixer added, coder edited
	assert.match(text, /- \+ \*\*fixer\*\*/u);
	assert.match(text, /~ \*\*coder\*\* — instructions changed/u);
	assert.match(text, /### Tasks \(\+1 \/ ~0 \/ =1 unchanged\)/u);
	assert.match(text, /- \+ \*\*rework\*\* → fixer/u);
	assert.doesNotMatch(text, /impl.*changed/u); // unchanged task definition stays silent
	assert.match(text, /### Global acceptance \(-1 \/ \+1\)/u);
	assert.match(text, /- − obsolete/u);
	assert.match(text, /- \+ extra/u);
});

test("validateToolRequest accepts cancel on planned teams and rejects bad payloads", () => {
	validateToolRequest({ action: "cancel", taskIds: ["a", "b"] }, stateWithPlan({ a: task("a", "c", "PENDING"), b: task("b", "d", "READY") }));
	const unplanned: TeamState = { schemaVersion: STATE_SCHEMA_VERSION, teams: {}, updatedAt: "t" };
	assert.throws(() => validateToolRequest({ action: "cancel", taskIds: ["a"] }, unplanned), /requires a registered plan/u);
	assert.throws(() => validateToolRequest({ action: "cancel", taskIds: [] }, stateWithPlan()), /unique taskIds/u);
	assert.throws(() => validateToolRequest({ action: "cancel", taskIds: ["a", "a"] }, stateWithPlan()), /unique taskIds/u);
	assert.throws(() => validateToolRequest({ action: "cancel", taskIds: ["a"], background: true }, stateWithPlan()), /forbids/u);
});

test("validateOnly is only valid with action plan", () => {
	assert.throws(() => validateToolRequest({ action: "run", taskId: "a", validateOnly: true }, stateWithPlan()), /only valid with action plan/u);
	assert.throws(() => validateToolRequest({ action: "status", validateOnly: false }, stateWithPlan()), /only valid with action plan/u);
	// plan itself accepts the flag; the amendment revision rule still applies underneath.
	const draft = {
		members: [member("a"), member("b")],
		reviewerId: "b",
		tasks: [{ id: "x", memberId: "a", objective: "o", ownedPaths: ["src/x"], acceptance: ["ok"] }],
		acceptance: ["done"],
	};
	validateToolRequest({ action: "plan", plan: draft, expectedRevision: 1, validateOnly: true }, stateWithPlan());
	assert.throws(
		() => validateToolRequest({ action: "plan", plan: draft, validateOnly: true }, stateWithPlan()),
		/amendment requires expectedRevision/u,
	);
});

test("public requestId schema accepts runtime-generated source tuple ids", () => {
	const requestIdSchema = AgentTeamParams.properties.requestId as { pattern: string; maxLength: number };
	assert.equal(requestIdSchema.maxLength, 200);
	assert.match("execution:task-a:1", new RegExp(requestIdSchema.pattern, "u"));
	assert.match("review:review-1:99", new RegExp(requestIdSchema.pattern, "u"));
	assert.doesNotMatch("review id with spaces", new RegExp(requestIdSchema.pattern, "u"));
});

test("steer validates member id and message and forbids cross-action control fields", () => {
	const planned = stateWithPlan({ a: task("a", "c", "READY") });
	planned.teams.default.members.c = memberState("c", "inst-c");
	assert.throws(() => validateToolRequest({ action: "steer", member: { id: "c" } }, planned), /steer requires member\.id and message/u);
	assert.throws(() => validateToolRequest({ action: "steer", message: "hi" }, planned), /steer requires member\.id and message/u);
	assert.throws(
		() => validateToolRequest({ action: "steer", member: { id: "ghost" }, message: "hi" }, planned),
		/Unknown member/u,
	);
	assert.throws(
		() => validateToolRequest(
			{ action: "steer", member: { id: "c" }, message: "hi", taskId: "a" },
			planned,
		),
		/steer forbids .*taskId/u,
	);
	assert.throws(
		() => validateToolRequest({ action: "steer", member: { id: "c" }, message: "hi", answer: "x" }, planned),
		/steer forbids .*answer/u,
	);
	assert.throws(
		() => validateToolRequest({ action: "steer", member: { id: "c" }, message: "hi", background: true }, planned),
		/steer forbids .*background/u,
	);
	// member id only: extra member config is rejected by the shared assertMemberIdOnly path.
	assert.throws(
		() => validateToolRequest({ action: "steer", member: { id: "c", role: "x" }, message: "hi" }, planned),
		/accepts member id only/u,
	);
});

test("pause and resume share the task contract; only pause forbids background", () => {
	const unplanned: TeamState = { schemaVersion: STATE_SCHEMA_VERSION, teams: {}, updatedAt: "t" };
	assert.throws(() => validateToolRequest({ action: "pause", taskId: "a" }, unplanned), /pause requires a registered plan/u);
	assert.throws(() => validateToolRequest({ action: "resume", taskId: "a" }, unplanned), /resume requires a registered plan/u);
	assert.throws(() => validateToolRequest({ action: "pause" }, stateWithPlan()), /pause requires taskId/u);
	assert.throws(() => validateToolRequest({ action: "resume" }, stateWithPlan()), /resume requires taskId/u);
	assert.throws(
		() => validateToolRequest({ action: "pause", taskId: "a", background: true }, stateWithPlan()),
		/pause forbids background/u,
	);
	// resume keeps run's explicit dispatch semantics: background is allowed.
	validateToolRequest({ action: "resume", taskId: "a", background: false }, stateWithPlan());
	assert.throws(
		() => validateToolRequest({ action: "pause", taskId: "a", requestId: "r" }, stateWithPlan()),
		/pause forbids .*requestId/u,
	);
	assert.throws(
		() => validateToolRequest({ action: "resume", taskId: "a", member: { id: "c" } }, stateWithPlan()),
		/resume forbids .*member/u,
	);
});

test("answer-request and resolve-request accept only their own lifecycle fields", () => {
	assert.throws(
		() => validateToolRequest({ action: "answer-request", answer: "x" }, stateWithPlan()),
		/answer-request requires requestId/u,
	);
	assert.throws(
		() => validateToolRequest({ action: "answer-request", requestId: "r" }, stateWithPlan()),
		/answer-request requires answer/u,
	);
	validateToolRequest({ action: "answer-request", requestId: "r", answer: "x" }, stateWithPlan());
	validateToolRequest({ action: "resolve-request", requestId: "r" }, stateWithPlan());
	assert.throws(
		() => validateToolRequest({ action: "resolve-request", requestId: "r", answer: "x" }, stateWithPlan()),
		/resolve-request forbids .*answer/u,
	);
	assert.throws(
		() => validateToolRequest({ action: "answer-request", requestId: "r", answer: "x", message: "steer text" }, stateWithPlan()),
		/answer-request forbids .*message/u,
	);
	// Control fields stay confined: no other action may smuggle message/requestId/answer.
	assert.throws(() => validateToolRequest({ action: "run", taskId: "a", message: "x" }, stateWithPlan()), /run forbids .*message/u);
	assert.throws(() => validateToolRequest({ action: "status", requestId: "r" }, stateWithPlan()), /status forbids .*requestId/u);
});

test("legacy snapshots default missing requests to OPEN and keep pending messages undelivered", () => {
	const versionTwo = structuredClone(stateWithPlan());
	versionTwo.schemaVersion = 2 as unknown as typeof STATE_SCHEMA_VERSION;
	delete (versionTwo.teams.default as unknown as { memberMessages?: unknown }).memberMessages;
	assert.equal(migrateState(versionTwo, "t0").schemaVersion, STATE_SCHEMA_VERSION, "the immediately previous schema remains readable");

	const legacy = structuredClone(stateWithPlan());
	legacy.schemaVersion = 1 as unknown as typeof STATE_SCHEMA_VERSION;
	const team = legacy.teams.default;
	delete (team as unknown as { pendingRequests?: unknown }).pendingRequests;
	delete (team as unknown as { memberMessages?: unknown }).memberMessages;
	const recovered = migrateState(legacy, "t0");
	assert.deepEqual(recovered.teams.default.pendingRequests, []);
	assert.deepEqual(recovered.teams.default.memberMessages, []);

	const withState = structuredClone(stateWithPlan());
	withState.schemaVersion = 1 as unknown as typeof STATE_SCHEMA_VERSION;
	withState.teams.default.pendingRequests = [
		// 无 status 的旧请求:默认 OPEN,绝不凭空判定已答复/已解决。
		{ id: "r1", fromType: "execution", fromId: "t1", kind: "question", text: "旧问题", createdAt: "t0" },
		{ id: "r2", fromType: "execution", fromId: "t1", kind: "scope", text: "已答复", createdAt: "t0", status: "ANSWERED", answer: "a", answeredAt: "t0" },
		{ id: "r3", fromType: "execution", fromId: "t1", kind: "dependency", text: "已关闭", createdAt: "t0", status: "RESOLVED", resolvedAt: "t0" },
	];
	withState.teams.default.memberMessages = [
		{ id: "m1", to: "c", fromType: "review", fromId: "r1", text: "待投递", createdAt: "t0" },
		{ id: "m2", to: "c", fromType: "review", fromId: "r1", text: "已投递", createdAt: "t0", deliveredAt: "t0" },
	];
	const migrated = migrateState(withState, "t0").teams.default;
	assert.equal(migrated.pendingRequests[0].status, "OPEN");
	assert.equal(migrated.pendingRequests[1].status, "ANSWERED");
	assert.equal(migrated.pendingRequests[1].answer, "a");
	assert.equal(migrated.pendingRequests[2].status, "RESOLVED");
	assert.equal(migrated.memberMessages[0].deliveredAt, undefined, "missing deliveredAt keeps the message pending");
	assert.equal(migrated.memberMessages[1].deliveredAt, "t0");
});

test("healthLevelFor applies fixed thresholds with the highest level and an alert-only reason", () => {
	const base = { toolErrors: 0, repeatedToolRuns: 0, autoRetries: 0 };
	const normal = healthLevelFor(base);
	assert.equal(normal.level, "NORMAL");
	assert.equal(normal.reason, undefined);
	const elevated = healthLevelFor({ ...base, toolErrors: MEMBER_HEALTH_THRESHOLDS.toolErrorElevated });
	assert.equal(elevated.level, "ELEVATED");
	assert.match(elevated.reason ?? "", /consecutive tool errors.*no auto steer\/stop\/kill/u);
	assert.equal(healthLevelFor({ ...base, toolErrors: MEMBER_HEALTH_THRESHOLDS.toolErrorDegraded }).level, "DEGRADED");
	assert.equal(healthLevelFor({ ...base, toolErrors: MEMBER_HEALTH_THRESHOLDS.toolErrorCritical }).level, "CRITICAL");
	const repeated = healthLevelFor({ ...base, repeatedTool: "edit", repeatedToolRuns: MEMBER_HEALTH_THRESHOLDS.repeatedToolDegraded });
	assert.equal(repeated.level, "DEGRADED");
	assert.match(repeated.reason ?? "", /tool edit ran .*x in the round/u);
	const retried = healthLevelFor({ ...base, autoRetries: MEMBER_HEALTH_THRESHOLDS.autoRetryCritical });
	assert.equal(retried.level, "CRITICAL");
	assert.match(retried.reason ?? "", /auto-retries.*no auto steer\/stop\/kill/u);
	// 多维度归一为最严重等级,reason 保留最高成因。
	const worst = healthLevelFor({
		...base,
		toolErrors: MEMBER_HEALTH_THRESHOLDS.toolErrorCritical + 1,
		repeatedTool: "read",
		repeatedToolRuns: MEMBER_HEALTH_THRESHOLDS.repeatedToolElevated,
	});
	assert.equal(worst.level, "CRITICAL");
	assert.match(worst.reason ?? "", /consecutive tool errors/u);
	// 低于阈值的噪音不抬级。
	assert.equal(healthLevelFor({ ...base, repeatedTool: "read", repeatedToolRuns: 2 }).level, "NORMAL");
});

test("report envelopes bound controlled messages by count, member id shape, and length", () => {
	const envelope = `body\n${JSON.stringify({ agent_team_report: { type: "execution", taskId: "a", status: "SUBMITTED", summary: "s", evidence: [], requests: [], messages: [{ to: "coder", text: "hi" }] } })}`;
	assert.deepEqual(parseReportEnvelope(envelope, "execution").messages, [{ to: "coder", text: "hi" }]);
	const tooMany = `body\n${JSON.stringify({ agent_team_report: { type: "execution", taskId: "a", status: "SUBMITTED", summary: "s", evidence: [], requests: [], messages: Array.from({ length: MAX_REPORT_MESSAGES + 1 }, (_, i) => ({ to: "coder", text: `m${i}` })) } })}`;
	assert.throws(() => parseReportEnvelope(tooMany, "execution"), /messages must contain at most/u);
	const badTarget = `body\n${JSON.stringify({ agent_team_report: { type: "execution", taskId: "a", status: "SUBMITTED", summary: "s", evidence: [], requests: [], messages: [{ to: "not an id", text: "hi" }] } })}`;
	assert.throws(() => parseReportEnvelope(badTarget, "execution"), /not a valid member id/u);
	const oversized = `body\n${JSON.stringify({ agent_team_report: { type: "execution", taskId: "a", status: "SUBMITTED", summary: "s", evidence: [], requests: [], messages: [{ to: "coder", text: "x".repeat(MAX_MEMBER_MESSAGE_CHARS + 1) }] } })}`;
	assert.throws(() => parseReportEnvelope(oversized, "execution"), new RegExp(`1-${MAX_MEMBER_MESSAGE_CHARS}`, "u"));
	// 每条消息有独立上限；接收者队列上限由运行时入队路径维护(runtime 集成测试)。
	assert.equal(MAX_MEMBER_MESSAGE_QUEUE_PER_RECEIVER, 20);
});
