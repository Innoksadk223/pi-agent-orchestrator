import assert from "node:assert/strict";
import test from "node:test";
import {
	type ExecutionTask,
	type ExecutionTaskStatus,
	planConfirmation,
	resolveTaskCancellation,
	STATE_SCHEMA_VERSION,
	type TeamState,
	validateToolRequest,
} from "./runtime.ts";

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
