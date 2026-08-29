import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, posix } from "node:path";
import type {
	DashboardMemberHandle,
	DashboardMemberSpec,
	DashboardStatus,
	TeamDashboard,
} from "./web-dashboard.ts";
import { dashboardEventsFromRpc } from "./web-dashboard.ts";
import type {
	CompatibilityReport,
	MemberClientHandle,
	PersistentMemberOptions,
	RpcClientLike,
	RpcStats,
} from "./compat.ts";
import type { DashboardModelRef } from "./web-dashboard.ts";

export const STATE_SCHEMA_VERSION = 2;
export const MAX_PARALLEL_TASKS = 8;
export const MAX_CONCURRENCY = 4;
export const MAX_MEMBER_OUTPUT_BYTES = 50 * 1024;
export const MEMBER_IDLE_TIMEOUT_MS = 10 * 60_000;
// Wider default continuous no-activity window for non-TUI (AionUI/RPC, JSON, print) parents.
export const RPC_IDLE_TIMEOUT_MS = 30 * 60_000;
export const IDLE_TIMEOUT_MIN_MS = 60_000;
export const IDLE_TIMEOUT_MAX_MS = 24 * 60 * 60_000;
export const IDLE_TIMEOUT_ENV = "PI_AGENT_TEAM_IDLE_TIMEOUT_MS";
// 成员空闲进程保持时间:IDLE/INTERRUPTED 后超过该值自动停 child 进程(记录保留,下次 run 懒重启)。
export const IDLE_KEEP_ALIVE_MS = 30 * 60_000;
export const IDLE_KEEP_ALIVE_ENV = "PI_AGENT_TEAM_IDLE_KEEP_ALIVE_MS";
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export const STATE_ENTRY_TYPE = "pi-agent-orchestrator";
// Custom session message type used to report detached member completions back
// to the main Pi (success or async failure). Delivered as followUp + triggerTurn
// so an idle main agent starts a continuation turn without steering a live chain.
export const AGENT_TEAM_COMPLETION_TYPE = "agent-team-completion";

export const MEMBER_STATUSES = [
	"APPROVED",
	"STARTING",
	"IDLE",
	"RUNNING",
	"INTERRUPTED",
	"STOPPED",
	"ERROR",
] as const;
export type MemberStatus = (typeof MEMBER_STATUSES)[number];

export interface ModelRef {
	provider: string;
	id: string;
}

export interface MemberConfig {
	id: string;
	role: string;
	instructions: string;
	model: ModelRef;
	thinking: (typeof THINKING_LEVELS)[number];
	tools: string[];
}

export interface MemberState extends MemberConfig {
	team: string;
	configHash: string;
	approvedAt: string;
	sessionId: string;
	status: MemberStatus;
	lastRunAt?: string;
	lastError?: string;
	idleSinceMs?: number;
	// Pi native auto-compaction enablement failure, persisted for status visibility.
	// This operational note does not affect roster authorization or configHash.
	contextNote?: string;
}

export const EXECUTION_TASK_STATUSES = [
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
] as const;
export type ExecutionTaskStatus = (typeof EXECUTION_TASK_STATUSES)[number];
export type PlanMemberKind = "coder" | "reviewer" | "debugger" | "product" | "optimizer";
export type ExpertKind = Extract<PlanMemberKind, "debugger" | "product" | "optimizer">;

export interface PendingRequest {
	id: string;
	fromType: "execution" | "review" | "expert";
	fromId: string;
	kind: "question" | "scope" | "dependency" | "human";
	text: string;
	createdAt: string;
}

export interface TaskPacket {
	objective: string;
	constraints: string[];
	dependencySummaries: Record<string, string>;
	ownedPaths: string[];
	acceptance: string[];
	relevantPaths: string[];
	outputContract: string;
}

export interface ExecutionTask {
	id: string;
	memberId: string;
	status: ExecutionTaskStatus;
	dependsOn: string[];
	packet: TaskPacket;
	attempt: number;
	lastSummary?: string;
	lastEvidence?: string[];
	lastIssue?: string;
	fixPrompt?: string;
	outputPath?: string;
	updatedAt: string;
}

export interface ReviewRound {
	id: string;
	reviewerId: string;
	targetTaskIds: string[];
	status: "RUNNING" | "COMPLETED" | "BLOCKED" | "REPORT_INVALID";
	attempt: number;
	summary?: string;
	evidence?: string[];
	lastIssue?: string;
	outputPath?: string;
	updatedAt: string;
}

export interface ExpertRound {
	id: string;
	expertId: string;
	kind: ExpertKind;
	targetTaskIds: string[];
	objective: string;
	status: "RUNNING" | "COMPLETED" | "BLOCKED" | "REPORT_INVALID";
	attempt: number;
	summary?: string;
	evidence?: string[];
	lastIssue?: string;
	outputPath?: string;
	updatedAt: string;
}

export interface RegisteredPlan {
	revision: number;
	reviewerId: string;
	memberKinds: Record<string, PlanMemberKind>;
	acceptance: string[];
	registeredAt: string;
	updatedAt: string;
}

export interface TeamRecord {
	id: string;
	members: Record<string, MemberState>;
	plan?: RegisteredPlan;
	executionTasks: Record<string, ExecutionTask>;
	reviewRounds: Record<string, ReviewRound>;
	expertRounds: Record<string, ExpertRound>;
	pendingRequests: PendingRequest[];
}

export interface TeamState {
	schemaVersion: typeof STATE_SCHEMA_VERSION;
	teams: Record<string, TeamRecord>;
	updatedAt: string;
}

export interface UsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	turns: number;
}

export interface CompletionDelta {
	team: string;
	counts: Record<string, number>;
	changed: { type: "execution" | "review" | "expert"; id: string; status: string };
	summary?: string;
	requests: PendingRequest[];
	outputPath?: string;
}

export interface MemberRunResult {
	team: string;
	member: string;
	status: MemberStatus;
	sessionId: string;
	approvedAt: string;
	output: string;
	truncated: boolean;
	outputPath?: string;
	delta?: CompletionDelta;
	usage: UsageTotals;
}

export interface TeamStatusSummary {
	team: string;
	planRevision?: number;
	memberCounts: Record<string, number>;
	taskCounts: Record<string, number>;
	current: Array<{ type: "execution" | "review" | "expert"; id: string; memberId: string; status: string }>;
	blocked: Array<{ id: string; status: string; issue?: string }>;
	requests: PendingRequest[];
}

export interface ToolResultDetails {
	action: ToolParams["action"];
	results?: MemberRunResult[];
	summary?: TeamStatusSummary;
	state?: TeamState;
	compatibility?: unknown;
	dashboard?: {
		mode: string;
		members: Record<string, DashboardStatus>;
	};
	cancelled?: boolean;
	warning?: string;
}

export interface MemberInput {
	id: string;
	role?: string;
	instructions?: string;
	model?: string;
	thinking?: MemberConfig["thinking"];
	tools?: string[];
}

export interface PlanMemberInput extends Omit<MemberInput, "role" | "instructions"> {
	kind: PlanMemberKind;
	role: string;
	instructions: string;
}

export interface PlannedTaskInput {
	id: string;
	memberId: string;
	objective: string;
	constraints?: string[];
	dependsOn?: string[];
	ownedPaths: string[];
	acceptance: string[];
	relevantPaths?: string[];
	outputContract?: string;
}

export interface PlanInput {
	members: PlanMemberInput[];
	reviewerId: string;
	tasks: PlannedTaskInput[];
	acceptance: string[];
}

export interface RunTarget {
	team: string;
	type: "execution" | "review" | "expert";
	id: string;
}

interface DispatchTask {
	member: Pick<MemberInput, "id">;
	task: string;
	target: RunTarget;
}

export interface ToolParams {
	action: "plan" | "run" | "parallel" | "review" | "expert" | "wait" | "status" | "stop" | "kill" | "cancel" | "set-model" | "set-auto";
	team?: string;
	member?: MemberInput;
	plan?: PlanInput;
	expectedRevision?: number;
	// plan-only draft check: run every semantic validation without USER_GATE,
	// persistence, revision consumption, or workspace writes.
	validateOnly?: boolean;
	taskId?: string;
	taskIds?: string[];
	reviewRoundId?: string;
	expertRoundId?: string;
	expertId?: string;
	objective?: string;
	full?: boolean;
	background?: boolean;
	timeout?: number;
	auto?: boolean;
}

export class TeamInputError extends Error {
	readonly code = "INVALID_AGENT_TEAM_REQUEST";
}

export class TeamStateError extends Error {
	readonly code = "INVALID_AGENT_TEAM_STATE";
}

class MemberResponseError extends Error {}

// runMember 竞态 guard 的统一消息(guard 窗口不可合并,仅统一文本)
const KILLED_WHILE_STARTING = "Member was killed while starting; task not dispatched.";
const KILLED_BEFORE_PROMPT = "Member was killed before the prompt was sent.";
const KILLED_WHILE_ACCEPTING = "Member was killed while the prompt was being accepted; task not replayed.";
const STOPPED_BEFORE_PROMPT = "Member was stopped before the prompt was sent.";

export function emptyState(now = new Date().toISOString()): TeamState {
	return { schemaVersion: STATE_SCHEMA_VERSION, teams: {}, updatedAt: now };
}

function emptyTeam(id: string): TeamRecord {
	return {
		id,
		members: {},
		executionTasks: {},
		reviewRounds: {},
		expertRounds: {},
		pendingRequests: [],
	};
}

export function parseModel(value: string | undefined, fallback?: ModelRef): ModelRef {
	if (!value) {
		if (!fallback) throw new TeamInputError("New members require a model or an active parent model.");
		return fallback;
	}
	const slash = value.indexOf("/");
	if (slash <= 0 || slash === value.length - 1) {
		throw new TeamInputError('model must use the "provider/model" form.');
	}
	return { provider: value.slice(0, slash), id: value.slice(slash + 1) };
}

export function normalizeNewMember(
	input: MemberInput,
	defaults: RuntimeContext,
	currentModel?: ModelRef,
): MemberConfig {
	if (!input.role || !input.instructions) {
		throw new TeamInputError("A new member requires id, role, and instructions.");
	}
	const tools = input.tools ? [...input.tools] : []; // 空数组 = 未限制(全部工具)
	if (tools.includes("agent_team")) throw new TeamInputError("Members may not receive the agent_team tool.");
	return {
		id: input.id,
		role: input.role,
		instructions: input.instructions,
		// New members inherit the parent model only when model is omitted. Existing
		// members keep their persisted model across unrelated plan amendments.
		model: pickMemberModel(input.model, defaults, input.id, currentModel),
		// 思考等级：未填 → 继承主 PI 当前思考等级（defaults.thinking）。
		thinking: input.thinking ?? defaults.thinking ?? "medium",
		tools,
	};
}

function pickMemberModel(
	value: string | undefined,
	ctx: RuntimeContext,
	memberId: string,
	currentModel?: ModelRef,
): ModelRef {
	if (!value) return parseModel(undefined, currentModel ?? ctx.model);
	let requested: ModelRef;
	try {
		requested = parseModel(value);
	} catch (error) {
		throw new TeamInputError(
			`Member ${memberId} requested model ${JSON.stringify(value)}, but it is not a canonical provider/model: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	const reason = modelUnavailableReason(requested, ctx);
	if (reason) {
		throw new TeamInputError(`Member ${memberId} requested unavailable model ${value}: ${reason}. Explicit models are never replaced by the parent model.`);
	}
	return requested;
}

function modelUnavailableReason(model: ModelRef, ctx: RuntimeContext): string | undefined {
	const available = ctx.listModels?.();
	if (!available) return "the main Pi available-model catalogue is unavailable";
	if (available.some((candidate) => candidate.provider === model.provider && candidate.id === model.id)) return undefined;
	return available.length === 0
		? "the main Pi available-model catalogue is empty"
		: "no exact canonical provider/model match exists in the main Pi available-model catalogue";
}

export function configHash(config: MemberConfig): string {
	return createHash("sha256")
		.update(
			JSON.stringify({
				id: config.id,
				role: config.role,
				instructions: config.instructions,
				model: config.model,
				thinking: config.thinking,
				tools: [...config.tools].sort(),
			}),
		)
		.digest("hex");
}

function hasConfig(input: MemberInput): boolean {
	return [input.role, input.instructions, input.model, input.thinking, input.tools].some((value) => value !== undefined);
}

const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const EVIDENCE_GUIDELINE =
	'envelope 必须是回复的最后一个非空行，裸的单行 JSON 对象；禁止代码围栏/```、禁止 Markdown 包裹、禁止正文后留空行或注释。evidence 元素只写纯中文的路径/行号描述，必须用 path:line 冒号格式（如 src/a.ts:42，用正斜杠 /），禁止散文式「第 N 行」写法、禁止反斜杠、禁止贴代码片段、禁止照抄示例内容（flash 会复制示例代码或围栏导致 REPORT_INVALID）。';
const DEFAULT_EXECUTION_OUTPUT_CONTRACT =
	'End the final response with one single-line JSON object: {"agent_team_report":{"type":"execution","taskId":"<id>","status":"SUBMITTED|BLOCKED","summary":"...","evidence":["..."],"requests":[{"kind":"question|scope|dependency|human","text":"..."}]}}';

export function normalizeOwnedPath(value: string): string {
	const trimmed = value.trim();
	if (!trimmed || isAbsolute(trimmed) || trimmed.includes("\\") || trimmed.split("/").includes("..") || /[*?\[\]{}]/u.test(trimmed)) {
		throw new TeamInputError(`Owned path must be a cwd-relative POSIX path: ${value}`);
	}
	const normalized = posix.normalize(trimmed.replace(/^\.\//u, "")).replace(/\/$/u, "");
	if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../")) {
		throw new TeamInputError(`Owned path escapes cwd or is not concrete: ${value}`);
	}
	return normalized;
}

export function pathsConflict(left: string, right: string): boolean {
	return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

/**
 * Resolve a cancel request against live task states. Requested tasks must sit in
 * a non-in-flight status (RUNNING belongs to stop/kill, SUBMITTED/FIX_REQUIRED
 * to the review loop); PENDING/READY transitive dependents of any canceled task
 * cascade so no never-dispatched task is left waiting on an unsatisfiable
 * dependency. In-flight blocked/fix states keep their explicit recovery paths:
 * the Leader must decide on those individually instead of being cascaded away.
 */
export function resolveTaskCancellation(
	tasks: Record<string, ExecutionTask>,
	requestedIds: string[],
): Array<{ id: string; direct: boolean }> {
	const CANCELABLE: ExecutionTaskStatus[] = ["PENDING", "READY", "BLOCKED", "REPORT_INVALID"];
	for (const id of requestedIds) {
		const task = tasks[id];
		if (!task) throw new TeamInputError(`Unknown execution task ${id}.`);
		if (!CANCELABLE.includes(task.status)) {
			throw new TeamInputError(
				`Task ${id} cannot be canceled from ${task.status}; use stop/kill while RUNNING and resolve its review loop when SUBMITTED or FIX_REQUIRED.`,
			);
		}
	}
	const canceled = new Set(requestedIds);
	let grew = true;
	while (grew) {
		grew = false;
		for (const task of Object.values(tasks)) {
			if ((task.status !== "PENDING" && task.status !== "READY") || canceled.has(task.id)) continue;
			if (task.dependsOn.some((dependency) => canceled.has(dependency))) {
				canceled.add(task.id);
				grew = true;
			}
		}
	}
	return [...canceled].map((id) => ({ id, direct: requestedIds.includes(id) }));
}

export interface PreparedPlan {
	configs: Record<string, MemberConfig>;
	memberKinds: Record<string, PlanMemberKind>;
	tasks: Record<string, ExecutionTask>;
	acceptance: string[];
	reviewerId: string;
}

function preparePlan(
	input: PlanInput,
	ctx: RuntimeContext,
	now: string,
	currentMembers: Record<string, MemberState> = {},
): PreparedPlan {
	const configs: Record<string, MemberConfig> = {};
	const memberKinds: Record<string, PlanMemberKind> = {};
	for (const member of input.members) {
		if (!ID_PATTERN.test(member.id)) throw new TeamInputError(`Invalid member id: ${member.id}`);
		if (configs[member.id]) throw new TeamInputError(`Duplicate plan member id: ${member.id}`);
		if (member.kind !== "coder" && (!member.tools?.length || member.tools.some((tool) => tool === "edit" || tool === "write" || tool === "agent_team"))) {
			throw new TeamInputError(`Planned ${member.kind} member ${member.id} requires an explicit tool list without edit/write/agent_team.`);
		}
		configs[member.id] = normalizeNewMember(member, ctx, currentMembers[member.id]?.model);
		memberKinds[member.id] = member.kind;
	}
	if (!configs[input.reviewerId] || memberKinds[input.reviewerId] !== "reviewer") {
		throw new TeamInputError(`reviewerId ${input.reviewerId} must name a planned reviewer member.`);
	}
	const tasks: Record<string, ExecutionTask> = {};
	for (const source of input.tasks) {
		if (!ID_PATTERN.test(source.id)) throw new TeamInputError(`Invalid task id: ${source.id}`);
		if (tasks[source.id]) throw new TeamInputError(`Duplicate task id: ${source.id}`);
		if (!configs[source.memberId] || memberKinds[source.memberId] !== "coder") {
			throw new TeamInputError(`Execution task ${source.id} must name a planned coder member.`);
		}
		const ownedPaths = source.ownedPaths.map(normalizeOwnedPath);
		if (new Set(ownedPaths).size !== ownedPaths.length) {
			throw new TeamInputError(`Task ${source.id} has duplicate normalized owned paths.`);
		}
		const relevantPaths = (source.relevantPaths ?? []).map(normalizeOwnedPath);
		tasks[source.id] = {
			id: source.id,
			memberId: source.memberId,
			status: (source.dependsOn?.length ?? 0) === 0 ? "READY" : "PENDING",
			dependsOn: [...(source.dependsOn ?? [])],
			packet: {
				objective: source.objective,
				constraints: [...(source.constraints ?? [])],
				dependencySummaries: {},
				ownedPaths,
				acceptance: [...source.acceptance],
				relevantPaths,
				outputContract: source.outputContract
					? `${source.outputContract}\n${DEFAULT_EXECUTION_OUTPUT_CONTRACT}`
					: DEFAULT_EXECUTION_OUTPUT_CONTRACT,
			},
			attempt: 0,
			updatedAt: now,
		};
	}
	for (const task of Object.values(tasks)) {
		for (const dependency of task.dependsOn) {
			if (!tasks[dependency]) throw new TeamInputError(`Task ${task.id} depends on unknown task ${dependency}.`);
			if (dependency === task.id) throw new TeamInputError(`Task ${task.id} may not depend on itself.`);
		}
	}
	const visiting = new Set<string>();
	const visited = new Set<string>();
	const visit = (id: string) => {
		if (visiting.has(id)) throw new TeamInputError(`Task DAG contains a cycle at ${id}.`);
		if (visited.has(id)) return;
		visiting.add(id);
		for (const dependency of tasks[id].dependsOn) visit(dependency);
		visiting.delete(id);
		visited.add(id);
	};
	for (const id of Object.keys(tasks)) visit(id);
	const dependsTransitively = (id: string, target: string, seen = new Set<string>()): boolean => {
		if (seen.has(id)) return false;
		seen.add(id);
		return tasks[id].dependsOn.some((dependency) => dependency === target || dependsTransitively(dependency, target, seen));
	};
	const taskList = Object.values(tasks);
	for (let left = 0; left < taskList.length; left++) {
		for (let right = left + 1; right < taskList.length; right++) {
			const a = taskList[left];
			const b = taskList[right];
			const conflict = a.packet.ownedPaths.some((one) => b.packet.ownedPaths.some((two) => pathsConflict(one, two)));
			if (conflict && !dependsTransitively(a.id, b.id) && !dependsTransitively(b.id, a.id)) {
				throw new TeamInputError(`Unordered tasks ${a.id} and ${b.id} have conflicting owned paths.`);
			}
		}
	}
	return {
		configs,
		memberKinds,
		tasks,
		acceptance: [...input.acceptance],
		reviewerId: input.reviewerId,
	};
}

function taskDefinition(task: ExecutionTask): string {
	return JSON.stringify({ id: task.id, memberId: task.memberId, dependsOn: task.dependsOn, packet: { ...task.packet, dependencySummaries: {} } });
}

function changedConfigFields(existing: MemberState, next: MemberConfig): string[] {
	const fields: string[] = [];
	if (existing.role !== next.role) fields.push("role");
	if (existing.instructions !== next.instructions) fields.push("instructions");
	if (existing.model.provider !== next.model.provider || existing.model.id !== next.model.id) fields.push("model");
	if (existing.thinking !== next.thinking) fields.push("thinking");
	if (JSON.stringify([...existing.tools].sort()) !== JSON.stringify([...next.tools].sort())) fields.push("tools");
	return fields;
}

function changedTaskFields(existing: ExecutionTask, replacement: ExecutionTask): string[] {
	const fields: string[] = [];
	if (existing.memberId !== replacement.memberId) fields.push("memberId");
	if (JSON.stringify(existing.dependsOn) !== JSON.stringify(replacement.dependsOn)) fields.push("dependsOn");
	for (const key of ["objective", "constraints", "ownedPaths", "acceptance", "relevantPaths", "outputContract"] as const) {
		if (JSON.stringify(existing.packet[key]) !== JSON.stringify(replacement.packet[key])) fields.push(key);
	}
	return fields;
}

function memberLine(kind: PlanMemberKind, member: MemberConfig): string {
	const tools = member.tools.length > 0 ? ` · tools=${member.tools.join(",")}` : "";
	return `**${member.id}** — ${kind} · ${member.role} · ${member.model.provider}/${member.model.id}${tools}`;
}

function taskBlock(task: ExecutionTask): string[] {
	return [
		`**${task.id}** → ${task.memberId}`,
		`  ${task.packet.objective}`,
		`  depends: ${task.dependsOn.join(", ") || "none"} · owns: ${task.packet.ownedPaths.join(", ")}`,
		...(task.packet.acceptance.length > 0 ? [`  acceptance: ${task.packet.acceptance.join(" | ")}`] : []),
	];
}

function fullPlanSections(plan: PreparedPlan): string[] {
	const roster = Object.values(plan.configs)
		.sort((a, b) => a.id.localeCompare(b.id))
		.map((member) => `- ${memberLine(plan.memberKinds[member.id], member)}`);
	const allTasks = Object.values(plan.tasks).sort((a, b) => a.id.localeCompare(b.id));
	return [
		`## Roster (${roster.length})`,
		...roster,
		"",
		`## Execution DAG (${allTasks.length} tasks)`,
		...allTasks.flatMap((task) => taskBlock(task).map((line, index) => (index === 0 ? `- ${line}` : line))),
		"",
		`## Global acceptance (${plan.acceptance.length})`,
		...plan.acceptance.map((item) => `- ${item}`),
	];
}

function amendmentSections(current: TeamRecord, plan: PreparedPlan): string[] {
	const approved = current.plan!;
	const lines = [`## Changes vs approved revision ${approved.revision}`, ""];
	// Roster: additions get the full member line; edits list only what changed.
	const addedMembers = Object.keys(plan.configs).filter((id) => !current.members[id]).sort();
	const changedMembers = Object.keys(plan.configs)
		.filter((id) => current.members[id] && (plan.memberKinds[id] !== approved.memberKinds[id] || configHash(plan.configs[id]) !== current.members[id].configHash))
		.sort();
	const unchangedMembers = Object.keys(plan.configs).length - addedMembers.length - changedMembers.length;
	lines.push(`### Roster (+${addedMembers.length} / ~${changedMembers.length}${unchangedMembers ? ` / =${unchangedMembers} unchanged` : ""})`);
	for (const id of addedMembers) lines.push(`- + ${memberLine(plan.memberKinds[id], plan.configs[id])}`);
	for (const id of changedMembers) {
		const changes = [
			...(plan.memberKinds[id] !== approved.memberKinds[id] ? [`kind → ${plan.memberKinds[id]}`] : []),
			...changedConfigFields(current.members[id], plan.configs[id]),
		];
		// Hash-based detection can disagree with field-level diff on hand-built
		// states; never render an empty "— changed" line.
		lines.push(`- ~ **${id}** — ${changes.length > 0 ? `${changes.join(", ")} changed` : "config updated"}`);
	}
	if (addedMembers.length === 0 && changedMembers.length === 0) lines.push("- no roster changes");
	lines.push("");
	// Tasks: additions get the full task block; edits list only what changed.
	const addedTasks = Object.keys(plan.tasks).filter((id) => !current.executionTasks[id]).sort();
	const changedTasks = Object.keys(plan.tasks)
		.filter((id) => current.executionTasks[id] && taskDefinition(current.executionTasks[id]) !== taskDefinition(plan.tasks[id]))
		.sort();
	const unchangedTasks = Object.keys(plan.tasks).length - addedTasks.length - changedTasks.length;
	lines.push(`### Tasks (+${addedTasks.length} / ~${changedTasks.length}${unchangedTasks ? ` / =${unchangedTasks} unchanged` : ""})`);
	for (const id of addedTasks) lines.push(...taskBlock(plan.tasks[id]).map((line, index) => (index === 0 ? `- + ${line}` : line)));
	for (const id of changedTasks) lines.push(`- ~ **${id}** — ${changedTaskFields(current.executionTasks[id], plan.tasks[id]).join(", ")} changed`);
	if (addedTasks.length === 0 && changedTasks.length === 0) lines.push("- no task changes");
	lines.push("");
	const previousAcceptance = new Set(approved.acceptance);
	const nextAcceptance = new Set(plan.acceptance);
	const removedAcceptance = approved.acceptance.filter((item) => !nextAcceptance.has(item));
	const addedAcceptance = plan.acceptance.filter((item) => !previousAcceptance.has(item));
	if (removedAcceptance.length === 0 && addedAcceptance.length === 0) {
		lines.push(`### Global acceptance (= unchanged, ${plan.acceptance.length} items)`);
	} else {
		lines.push(`### Global acceptance (-${removedAcceptance.length} / +${addedAcceptance.length})`);
		for (const item of removedAcceptance) lines.push(`- − ${item}`);
		for (const item of addedAcceptance) lines.push(`- + ${item}`);
	}
	return lines;
}

export function planConfirmation(teamId: string, plan: PreparedPlan, revision: number, current?: TeamRecord): string {
	// Canonical Markdown so every surface renders it well: IDE/RPC dialogs render
	// MD natively, and the TUI confirm component parses the same structure into
	// themed ANSI (headings/bold/bullets). No truncation - scrolling handles size.
	const header = [
		`## Team: ${teamId}`,
		`**Revision:** ${revision} · **Reviewer:** ${plan.reviewerId}`,
	];
	// Verdict-authority change is always surfaced, even in silent same-roster amendments.
	if (current?.plan && current.plan.reviewerId !== plan.reviewerId) {
		header.push(`⚠ Reviewer changed: ${current.plan.reviewerId} → ${plan.reviewerId}`);
	}
	const footer =
		"Approval atomically fixes this roster, DAG, ownership, TaskPackets, and acceptance. Runtime will not dispatch any node automatically.";
	const body = current?.plan ? amendmentSections(current, plan) : fullPlanSections(plan);
	return [...header, "", ...body, "", footer].join("\n");
}

export function validateToolRequest(params: ToolParams, state: TeamState): void {
	const teamId = params.team ?? "default";
	if (!ID_PATTERN.test(teamId)) throw new TeamInputError(`Invalid team id: ${teamId}`);
	if ("task" in params || "tasks" in params) {
		throw new TeamInputError("Legacy inline member/task/tasks dispatch is no longer supported; register a plan and use taskId/taskIds.");
	}
	if (params.validateOnly !== undefined && params.action !== "plan") {
		throw new TeamInputError("validateOnly is only valid with action plan.");
	}
	const team = state.teams[teamId];
	const existing = team?.members ?? {};
	const supplied = (...names: Array<keyof ToolParams>) => names.some((name) => params[name] !== undefined);
	const forbid = (...names: Array<keyof ToolParams>) => {
		if (supplied(...names)) throw new TeamInputError(`${params.action} forbids ${names.join("/")}.`);
	};
	const assertMemberIdOnly = (input: MemberInput | undefined) => {
		if (!input) throw new TeamInputError(`${params.action} requires member.`);
		if (!ID_PATTERN.test(input.id)) throw new TeamInputError(`Invalid member id: ${input.id}`);
		if (!existing[input.id]) throw new TeamInputError(`Unknown member ${teamId}/${input.id}.`);
		if (hasConfig(input)) throw new TeamInputError(`${params.action} accepts member id only.`);
	};
	const planFields: Array<keyof ToolParams> = [
		"plan", "expectedRevision", "taskId", "taskIds", "reviewRoundId", "expertRoundId", "expertId", "objective",
	];

	if (params.action === "plan") {
		if (!params.plan) throw new TeamInputError("plan requires plan.");
		forbid("member", "taskId", "taskIds", "reviewRoundId", "expertRoundId", "expertId", "objective", "background", "timeout", "auto", "full");
		if (team?.plan && params.expectedRevision === undefined) throw new TeamInputError("Plan amendment requires expectedRevision.");
		if (!team?.plan && params.expectedRevision !== undefined) throw new TeamInputError("Initial plan forbids expectedRevision.");
		return;
	}
	if (params.action === "run") {
		if (!team?.plan) throw new TeamInputError(`Planned run requires a registered plan for team ${teamId}.`);
		if (!params.taskId) throw new TeamInputError("Planned run requires taskId.");
		forbid("member", "taskIds", "reviewRoundId", "expertRoundId", "expertId", "objective", "plan", "expectedRevision", "timeout", "auto", "full");
		return;
	}
	if (params.action === "parallel") {
		if (!team?.plan) throw new TeamInputError(`Planned parallel requires a registered plan for team ${teamId}.`);
		if (!params.taskIds || params.taskIds.length < 2 || params.taskIds.length > MAX_PARALLEL_TASKS) {
			throw new TeamInputError(`Planned parallel requires 2-${MAX_PARALLEL_TASKS} taskIds.`);
		}
		forbid("member", "taskId", "reviewRoundId", "expertRoundId", "expertId", "objective", "plan", "expectedRevision", "timeout", "auto", "full");
		return;
	}
	if (params.action === "cancel") {
		if (!team?.plan) throw new TeamInputError(`cancel requires a registered plan for team ${teamId}.`);
		if (!params.taskIds?.length || params.taskIds.length > MAX_PARALLEL_TASKS || new Set(params.taskIds).size !== params.taskIds.length) {
			throw new TeamInputError(`cancel requires 1-${MAX_PARALLEL_TASKS} unique taskIds.`);
		}
		forbid("member", "taskId", "reviewRoundId", "expertRoundId", "expertId", "objective", "plan", "expectedRevision", "background", "timeout", "auto", "full");
		return;
	}
	if (params.action === "review") {
		if (!team?.plan) throw new TeamInputError("review requires a registered plan.");
		if (!params.reviewRoundId || !params.taskIds?.length || params.taskIds.length > MAX_PARALLEL_TASKS || new Set(params.taskIds).size !== params.taskIds.length) {
			throw new TeamInputError(`review requires reviewRoundId and 1-${MAX_PARALLEL_TASKS} unique taskIds.`);
		}
		forbid("member", "taskId", "expertRoundId", "expertId", "objective", "plan", "expectedRevision", "timeout", "auto", "full");
		return;
	}
	if (params.action === "expert") {
		if (!team?.plan) throw new TeamInputError("expert requires a registered plan.");
		if (!params.expertRoundId || !params.expertId || !params.taskIds?.length || params.taskIds.length > MAX_PARALLEL_TASKS || new Set(params.taskIds).size !== params.taskIds.length || !params.objective) {
			throw new TeamInputError(`expert requires expertRoundId, expertId, 1-${MAX_PARALLEL_TASKS} unique taskIds, and objective.`);
		}
		forbid("member", "taskId", "reviewRoundId", "plan", "expectedRevision", "timeout", "auto", "full");
		return;
	}
	if (params.action === "wait") {
		assertMemberIdOnly(params.member);
		forbid(...planFields, "background", "auto", "full");
		return;
	}
	if (params.action === "stop" || params.action === "kill") {
		if (params.member) assertMemberIdOnly(params.member);
		forbid(...planFields, "background", "timeout", "auto", "full");
		return;
	}
	if (params.action === "set-model") {
		if (!params.member?.model) throw new TeamInputError("set-model requires member with model.");
		if (!ID_PATTERN.test(params.member.id)) throw new TeamInputError(`Invalid member id: ${params.member.id}`);
		if (!existing[params.member.id]) throw new TeamInputError(`Unknown member ${teamId}/${params.member.id}.`);
		if (params.member.thinking !== undefined && !THINKING_LEVELS.includes(params.member.thinking)) {
			throw new TeamInputError(`set-model thinking must be one of: ${THINKING_LEVELS.join(", ")}.`);
		}
		if (params.member.role !== undefined || params.member.instructions !== undefined || params.member.tools !== undefined) {
			throw new TeamInputError("set-model accepts member id, model, and optional thinking only.");
		}
		forbid(...planFields, "background", "timeout", "auto", "full");
		return;
	}
	if (params.action === "set-auto") {
		if (params.auto === undefined) throw new TeamInputError("set-auto requires auto: true|false.");
		forbid("member", ...planFields, "background", "timeout", "full");
		return;
	}
	if (params.action === "status") {
		if (params.member) assertMemberIdOnly(params.member);
		forbid(...planFields, "background", "timeout", "auto");
	}
}

export function migrateState(value: unknown, now = new Date().toISOString()): TeamState {
	if (!value || typeof value !== "object") throw new TeamStateError("State snapshot is not an object.");
	const source = value as Record<string, unknown>;
	const version = source.schemaVersion ?? 0;
	if (version !== 0 && version !== 1 && version !== STATE_SCHEMA_VERSION) {
		throw new TeamStateError(`Unsupported future state schema ${String(version)}; state is read-only.`);
	}
	if (!source.teams || typeof source.teams !== "object") throw new TeamStateError("State snapshot has no teams map.");
	const state = structuredClone(source) as unknown as TeamState;
	state.schemaVersion = STATE_SCHEMA_VERSION;
	state.updatedAt = typeof source.updatedAt === "string" ? source.updatedAt : now;
	for (const [teamId, team] of Object.entries(state.teams)) {
		if (!team || typeof team !== "object" || !team.members || typeof team.members !== "object") {
			throw new TeamStateError("State snapshot contains an invalid team.");
		}
		team.id = team.id || teamId;
		team.executionTasks ??= {};
		team.reviewRounds ??= {};
		team.expertRounds ??= {};
		team.pendingRequests ??= [];
		for (const member of Object.values(team.members)) {
			if (!member || typeof member !== "object" || !member.sessionId || !member.configHash) {
				throw new TeamStateError("State snapshot contains an invalid member.");
			}
			if (member.configHash !== configHash(member)) {
				throw new TeamStateError(`Stored configuration hash mismatch for ${member.team}/${member.id}.`);
			}
			if (member.status === "RUNNING" || member.status === "STARTING") {
				member.status = "INTERRUPTED";
				member.lastError = "Recovered after an interrupted parent session; no prompt was replayed.";
			}
		}
		for (const task of Object.values(team.executionTasks)) {
			if (task.status === "RUNNING") {
				task.status = "BLOCKED";
				task.lastIssue = "Recovered after an interrupted execution attempt; prompt not replayed.";
				task.updatedAt = now;
			}
			if (task.status === "AUDITING") task.status = "SUBMITTED";
		}
		for (const round of Object.values(team.reviewRounds)) {
			if (round.status === "RUNNING") {
				round.status = "BLOCKED";
				round.lastIssue = "Recovered after an interrupted review round; prompt not replayed.";
				round.updatedAt = now;
			}
		}
		for (const round of Object.values(team.expertRounds)) {
			if (round.status === "RUNNING") {
				round.status = "BLOCKED";
				round.lastIssue = "Recovered after an interrupted expert round; prompt not replayed.";
				round.updatedAt = now;
			}
		}
	}
	return state;
}

export function createApprovedMember(
	team: string,
	config: MemberConfig,
	approvedAt: string,
	sessionId: string = randomUUID(),
): MemberState {
	return {
		...config,
		team,
		configHash: configHash(config),
		approvedAt,
		sessionId,
		status: "APPROVED",
	};
}

export interface CompatibilityPort {
	featureCheck(capabilities: { appendEntry: boolean; getBranch: boolean }): Promise<CompatibilityReport>;
	ensureCompatible(
		cwd: string,
		capabilities: { appendEntry: boolean; getBranch: boolean },
	): Promise<CompatibilityReport>;
	doctor(cwd: string, capabilities: { appendEntry: boolean; getBranch: boolean }): Promise<CompatibilityReport>;
	createMemberClient(member: PersistentMemberOptions): Promise<MemberClientHandle>;
}

export interface RuntimeContext {
	cwd: string;
	mode: "tui" | "rpc" | "json" | "print";
	model?: ModelRef;
	thinking?: MemberConfig["thinking"];
	trusted: boolean;
	hasUI: boolean;
	parentPersisted: boolean;
	capabilities: { appendEntry: boolean; getBranch: boolean };
	confirm(title: string, message: string, options?: { signal?: AbortSignal; timeout?: number }): Promise<boolean>;
	appendSnapshot(snapshot: TeamState): void;
	// Models available to the parent Pi (registry snapshot); the Dashboard lists these
	// for per-member model switching. Optional so headless contexts can omit it.
	listModels?: () => DashboardModelRef[];
	// Optional parent-session channel: detached member runs report their final
	// outcome (success or async failure) back into the main Pi's conversation.
	// Wired to pi.sendMessage in index.ts (customType + display + followUp + triggerTurn).
	sendParentMessage?: (
		message: { customType: string; content: string; display: boolean; details?: unknown },
		options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
	) => void;
}

export type DashboardFactory = (ctx: RuntimeContext) => TeamDashboard;

export type ProgressCallback = (result: {
	content: Array<{ type: "text"; text: string }>;
	details: ToolResultDetails;
}) => void;

export interface RuntimeToolResult {
	content: Array<{ type: "text"; text: string }>;
	details: ToolResultDetails;
	terminate?: boolean;
	usage?: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		totalTokens: number;
		cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
	};
}

function memberKey(team: string, id: string): string {
	return `${team}\u0000${id}`;
}

function assistantMessageModel(message: unknown): string | undefined {
	if (!message || typeof message !== "object") return undefined;
	const record = message as Record<string, unknown>;
	return record.role === "assistant" && typeof record.provider === "string" && typeof record.model === "string"
		? `${record.provider}/${record.model}`
		: undefined;
}

function assistantFailure(event: any): string | undefined {
	const message = event?.type === "message_end" ? event.message : undefined;
	if (message?.role !== "assistant" || (message.stopReason !== "error" && message.stopReason !== "aborted")) {
		return undefined;
	}
	return message.errorMessage || `Assistant stopped with ${message.stopReason}.`;
}

function zeroUsage(): UsageTotals {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
}

function usageDelta(before: RpcStats, after: RpcStats): UsageTotals {
	return {
		input: Math.max(0, after.tokens.input - before.tokens.input),
		output: Math.max(0, after.tokens.output - before.tokens.output),
		cacheRead: Math.max(0, after.tokens.cacheRead - before.tokens.cacheRead),
		cacheWrite: Math.max(0, after.tokens.cacheWrite - before.tokens.cacheWrite),
		cost: Math.max(0, after.cost - before.cost),
		turns: Math.max(0, after.assistantMessages - before.assistantMessages),
	};
}

function aggregateUsage(results: MemberRunResult[]): UsageTotals {
	return results.reduce((total, result) => {
		for (const key of ["input", "output", "cacheRead", "cacheWrite", "cost", "turns"] as const) {
			total[key] += result.usage[key];
		}
		return total;
	}, zeroUsage());
}

/**
 * Resolve the continuous no-activity window for a parent mode.
 * TUI keeps the historical 10-minute default; AionUI/RPC (and JSON/print) default wider.
 * PI_AGENT_TEAM_IDLE_TIMEOUT_MS overrides with a positive integer (ms); invalid values
 * fall back to the mode default, and valid values are clamped to [IDLE_TIMEOUT_MIN_MS, IDLE_TIMEOUT_MAX_MS].
 */
export function idleTimeoutForMode(mode: RuntimeContext["mode"]): number {
	const fallback = mode === "tui" ? MEMBER_IDLE_TIMEOUT_MS : RPC_IDLE_TIMEOUT_MS;
	const raw = process.env[IDLE_TIMEOUT_ENV];
	if (!raw) return fallback;
	const match = /^[1-9]\d*$/.exec(raw.trim());
	if (!match) return fallback;
	const value = Number(match[0]);
	return Math.min(IDLE_TIMEOUT_MAX_MS, Math.max(IDLE_TIMEOUT_MIN_MS, value));
}

/**
 * Resolve the idle keep-alive window: after a member settles (IDLE/INTERRUPTED),
 * its child process is stopped automatically once it stays idle longer than this
 * window (the member record and session are kept; the next run restarts it lazily).
 * PI_AGENT_TEAM_IDLE_KEEP_ALIVE_MS overrides with a positive integer (ms); invalid
 * values fall back to the default, and valid values are clamped to
 * [IDLE_TIMEOUT_MIN_MS, IDLE_TIMEOUT_MAX_MS].
 */
export function idleKeepAliveMs(): number {
	const raw = process.env[IDLE_KEEP_ALIVE_ENV];
	if (!raw) return IDLE_KEEP_ALIVE_MS;
	const match = /^[1-9]\d*$/.exec(raw.trim());
	if (!match) return IDLE_KEEP_ALIVE_MS;
	const value = Number(match[0]);
	return Math.min(IDLE_TIMEOUT_MAX_MS, Math.max(IDLE_TIMEOUT_MIN_MS, value));
}

export interface SettledIdleWait {
	promise: Promise<void>;
	start(): void;
	cancel(): void;
}

/**
 * Subscribe before prompting so an early agent_settled event cannot be missed.
 * start() begins the continuous no-activity window after prompt acceptance;
 * cancel() removes the timer/listener on every exit path.
 */
export function waitForSettledWithIdleTimeout(
	onEvent: (listener: (event: any) => void) => () => void,
	timeoutMs: number,
): SettledIdleWait {
	let unsubscribe: () => void = () => undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let started = false;
	let finished = false;
	let resolvePromise!: () => void;
	let rejectPromise!: (error: Error) => void;
	const promise = new Promise<void>((resolve, reject) => {
		resolvePromise = resolve;
		rejectPromise = reject;
	});
	const cleanup = () => {
		clearTimeout(timer);
		unsubscribe();
	};
	const schedule = () => {
		clearTimeout(timer);
		timer = setTimeout(() => {
			if (finished) return;
			finished = true;
			cleanup();
			rejectPromise(new Error(`Idle timeout: no agent activity for ${timeoutMs}ms.`));
		}, timeoutMs);
	};
	const detach = onEvent((event) => {
		if (finished) return;
		if (event?.type === "agent_settled") {
			finished = true;
			cleanup();
			resolvePromise();
		} else if (started) {
			schedule();
		}
	});
	unsubscribe = detach;
	if (finished) detach();
	return {
		promise,
		start() {
			if (started || finished) return;
			started = true;
			schedule();
		},
		cancel() {
			if (finished) return;
			finished = true;
			cleanup();
			resolvePromise();
		},
	};
}

export function truncateMemberOutput(text: string, reserveBytes = 0): { output: string; truncated: boolean } {
	if (Buffer.byteLength(text, "utf8") + reserveBytes <= MAX_MEMBER_OUTPUT_BYTES) return { output: text, truncated: false };
	const suffix = "… [truncated]";
	const budget = MAX_MEMBER_OUTPUT_BYTES - reserveBytes - Buffer.byteLength(suffix, "utf8");
	let output = Buffer.from(text, "utf8").subarray(0, budget).toString("utf8").replace(/\uFFFD$/u, "");
	while (Buffer.byteLength(output + suffix, "utf8") > MAX_MEMBER_OUTPUT_BYTES - reserveBytes) output = output.slice(0, -1);
	return { output: output + suffix, truncated: true };
}

export interface ReportRequest {
	kind: PendingRequest["kind"];
	text: string;
}
export interface ExecutionEnvelope {
	type: "execution";
	taskId: string;
	status: "SUBMITTED" | "BLOCKED";
	summary: string;
	evidence: string[];
	requests: ReportRequest[];
}
export interface ReviewEnvelope {
	type: "review";
	reviewRoundId: string;
	summary: string;
	evidence: string[];
	requests: ReportRequest[];
	decisions: Array<{ taskId: string; verdict: "VERIFIED" | "FIX_REQUIRED"; fix_prompt?: string }>;
}
export interface ExpertEnvelope {
	type: "expert";
	expertRoundId: string;
	summary: string;
	evidence: string[];
	requests: ReportRequest[];
}
export type ReportEnvelope = ExecutionEnvelope | ReviewEnvelope | ExpertEnvelope;

export class ReportEnvelopeError extends Error {}

function reportRecord(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new ReportEnvelopeError(`${label} must be an object.`);
	return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: string[], label: string): void {
	const extras = Object.keys(value).filter((key) => !allowed.includes(key));
	if (extras.length) throw new ReportEnvelopeError(`${label} has unsupported fields: ${extras.join(", ")}.`);
}

function boundedString(value: unknown, label: string, max: number): string {
	if (typeof value !== "string" || value.length < 1 || value.length > max) {
		throw new ReportEnvelopeError(`${label} must be 1-${max} characters.`);
	}
	return value;
}

function boundedStrings(value: unknown, label: string, maxItems: number, maxLength: number): string[] {
	if (!Array.isArray(value) || value.length > maxItems) throw new ReportEnvelopeError(`${label} must contain at most ${maxItems} items.`);
	return value.map((item, index) => boundedString(item, `${label}[${index}]`, maxLength));
}

function parseRequests(value: unknown): ReportRequest[] {
	if (!Array.isArray(value) || value.length > 10) throw new ReportEnvelopeError("requests must contain at most 10 items.");
	return value.map((item, index) => {
		const request = reportRecord(item, `requests[${index}]`);
		exactKeys(request, ["kind", "text"], `requests[${index}]`);
		if (!["question", "scope", "dependency", "human"].includes(String(request.kind))) {
			throw new ReportEnvelopeError(`requests[${index}].kind is invalid.`);
		}
		return { kind: request.kind as ReportRequest["kind"], text: boundedString(request.text, `requests[${index}].text`, 1000) };
	});
}

export function parseReportEnvelope(output: string, expectedType: ReportEnvelope["type"]): ReportEnvelope {
	const lines = output.trimEnd().split(/\r?\n/u);
	const tail = lines.at(-1)?.trim();
	if (!tail?.startsWith("{") || !tail.endsWith("}")) {
		throw new ReportEnvelopeError("Final non-empty line must be the JSON report envelope.");
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(tail);
	} catch (error) {
		throw new ReportEnvelopeError(`Final JSON envelope is invalid: ${error instanceof Error ? error.message : String(error)}`);
	}
	const root = reportRecord(parsed, "report root");
	exactKeys(root, ["agent_team_report"], "report root");
	const report = reportRecord(root.agent_team_report, "agent_team_report");
	if (report.type !== expectedType) throw new ReportEnvelopeError(`Expected ${expectedType} report, got ${String(report.type)}.`);
	const summary = boundedString(report.summary, "summary", 2000);
	const evidence = boundedStrings(report.evidence, "evidence", 20, 1000);
	const requests = parseRequests(report.requests);
	if (expectedType === "execution") {
		exactKeys(report, ["type", "taskId", "status", "summary", "evidence", "requests"], "execution report");
		if (report.status !== "SUBMITTED" && report.status !== "BLOCKED") throw new ReportEnvelopeError("Execution status must be SUBMITTED or BLOCKED.");
		return {
			type: "execution",
			taskId: boundedString(report.taskId, "taskId", 64),
			status: report.status,
			summary,
			evidence,
			requests,
		};
	}
	if (expectedType === "expert") {
		exactKeys(report, ["type", "expertRoundId", "summary", "evidence", "requests"], "expert report");
		return {
			type: "expert",
			expertRoundId: boundedString(report.expertRoundId, "expertRoundId", 64),
			summary,
			evidence,
			requests,
		};
	}
	exactKeys(report, ["type", "reviewRoundId", "summary", "evidence", "requests", "decisions"], "review report");
	if (!Array.isArray(report.decisions) || report.decisions.length < 1 || report.decisions.length > MAX_PARALLEL_TASKS) {
		throw new ReportEnvelopeError(`decisions must contain 1-${MAX_PARALLEL_TASKS} items.`);
	}
	const decisions = report.decisions.map((item, index) => {
		const decision = reportRecord(item, `decisions[${index}]`);
		exactKeys(decision, ["taskId", "verdict", "fix_prompt"], `decisions[${index}]`);
		const taskId = boundedString(decision.taskId, `decisions[${index}].taskId`, 64);
		if (decision.verdict !== "VERIFIED" && decision.verdict !== "FIX_REQUIRED") {
			throw new ReportEnvelopeError(`decisions[${index}].verdict is invalid.`);
		}
		if (decision.verdict === "FIX_REQUIRED") {
			return { taskId, verdict: decision.verdict, fix_prompt: boundedString(decision.fix_prompt, `decisions[${index}].fix_prompt`, 8000) };
		}
		if (decision.fix_prompt !== undefined) throw new ReportEnvelopeError(`VERIFIED decision ${taskId} must not include fix_prompt.`);
		return { taskId, verdict: decision.verdict };
	});
	return {
		type: "review",
		reviewRoundId: boundedString(report.reviewRoundId, "reviewRoundId", 64),
		summary,
		evidence,
		requests,
		decisions,
	};
}

/** Normalize a child-reported model ("provider/id" or { provider, id }) to "provider/id". */
function reportedModel(value: unknown): string | undefined {
	if (!value) return undefined;
	if (typeof value === "string") return value;
	if (typeof value === "object") {
		const record = value as Record<string, unknown>;
		if (typeof record.provider === "string" && typeof record.id === "string") return `${record.provider}/${record.id}`;
	}
	return undefined;
}

function rosterLine(member: MemberState): string {
	return `${member.team}/${member.id} role=${member.role} model=${member.model.provider}/${member.model.id} status=${member.status} session=${member.sessionId}`;
}

/**
 * Format the complete roster of an approved team: member count plus one line per
 * member (stable id order). Used by explicit stop/kill results.
 */
function formatRoster(teamId: string, members: Record<string, MemberState>): string[] {
	const all = Object.values(members)
		.slice()
		.sort((a, b) => a.id.localeCompare(b.id));
	return all.length
		? [`Team ${teamId} has ${all.length} member${all.length === 1 ? "" : "s"}:`, ...all.map(rosterLine)]
		: [`Team ${teamId} has no members.`];
}

function dashboardSpec(member: MemberState): DashboardMemberSpec {
	return {
		team: member.team,
		id: member.id,
		role: member.role,
		model: `${member.model.provider}/${member.model.id}`,
		thinking: member.thinking,
		sessionId: member.sessionId,
	};
}

/**
 * In-memory control record for one accepted member run (created after the prompt
 * is accepted, cleared by every exit path). stop() aborts the live prompt and
 * marks the run as an intentional interrupt so finalization reports INTERRUPTED
 * without touching the child client; kill() performs the full hard-termination
 * (client.stop, dashboard close, STOPPED status). settleWaits/backgroundResults
 * keys live alongside, and completed is resolved exactly once so stop/kill can
 * await finalization (active slot release) before returning.
 */
export interface RunControl {
	stop(): void;
	kill(): void;
	completed: Promise<void>;
}

export class TeamRuntime {
	private state: TeamState;
	// Session-scoped authorization for initial-plan and roster-growth USER_GATEs.
	// It never dispatches work or records HUMAN_ACCEPT.
	private autoApprove = false;
	private readonly clients = new Map<string, RpcClientLike>();
	private readonly active = new Set<string>();
	// Active run controls for accepted runs, keyed by memberKey; created after
	// prompt acceptance, removed by finalization (and by shutdown). stop/kill
	// consult these to interrupt the live run and await its finalization.
	private readonly runControls = new Map<string, RunControl>();
	private readonly runTargets = new Map<string, RunTarget>();
	// Results of background (detached) runs, keyed by memberKey, written when the run settles.
	// wait reads these; stop/shutdown clear them alongside their client lifecycle.
	private readonly backgroundResults = new Map<string, MemberRunResult>();
	// Active settle waits for background runs, keyed by memberKey; stop/shutdown cancel
	// these so a stopped member's background finalization does not hang until idle timeout.
	private readonly settleWaits = new Map<string, SettledIdleWait>();
	private readonly compatibility: CompatibilityPort;
	private readonly now: () => string;
	private readonly uuid: () => string;
	private readonly dashboardFactory?: DashboardFactory;
	private readonly idleTimeoutMs: (mode: RuntimeContext["mode"]) => number;
	private dashboard?: TeamDashboard;
	private readOnlyError?: string;
	private lastCompatibility?: CompatibilityReport;

	constructor(
		compatibility: CompatibilityPort,
		now: () => string = () => new Date().toISOString(),
		uuid: () => string = randomUUID,
		dashboardFactory?: DashboardFactory,
		idleTimeoutMs: (mode: RuntimeContext["mode"]) => number = idleTimeoutForMode,
	) {
		this.compatibility = compatibility;
		this.now = now;
		this.state = emptyState(this.now());
		this.uuid = uuid;
		this.dashboardFactory = dashboardFactory;
		this.idleTimeoutMs = idleTimeoutMs;
	}

	getState(): TeamState {
		return structuredClone(this.state);
	}

	getReadOnlyError(): string | undefined {
		return this.readOnlyError;
	}

	restoreFromBranch(entries: readonly any[]): void {
		const entry = [...entries]
			.reverse()
			.find((candidate) => candidate?.type === "custom" && candidate.customType === STATE_ENTRY_TYPE);
		this.readOnlyError = undefined;
		this.state = emptyState(this.now());
		if (!entry) return;
		try {
			this.state = migrateState(entry.data, this.now());
		} catch (error) {
			this.readOnlyError = error instanceof Error ? error.message : String(error);
		}
	}

	async featureCheck(ctx: RuntimeContext): Promise<CompatibilityReport> {
		this.lastCompatibility = await this.compatibility.featureCheck(ctx.capabilities);
		return this.lastCompatibility;
	}

	async doctor(ctx: RuntimeContext): Promise<CompatibilityReport> {
		this.lastCompatibility = await this.compatibility.doctor(ctx.cwd, ctx.capabilities);
		return this.lastCompatibility;
	}

	async execute(
		params: ToolParams,
		ctx: RuntimeContext,
		signal?: AbortSignal,
		onUpdate?: ProgressCallback,
	): Promise<RuntimeToolResult> {
		validateToolRequest(params, this.state);
		const teamId = params.team ?? "default";
		if (params.action === "plan") {
			if (this.readOnlyError) throw new TeamStateError(this.readOnlyError);
			return this.planResult(teamId, params.plan as PlanInput, params.expectedRevision, ctx, signal, params.validateOnly === true);
		}
		await this.sweepIdleClients();
		if (params.action === "status") return this.statusResult(teamId, params.member?.id, params.full === true, ctx);
		if (params.action === "stop") return this.stopResult(teamId, params.member?.id, ctx);
		if (params.action === "kill") return this.killResult(teamId, params.member?.id, ctx);
		if (params.action === "cancel") return this.cancelResult(teamId, params.taskIds as string[], ctx);
		if (this.readOnlyError) throw new TeamStateError(this.readOnlyError);
		this.lastCompatibility = await this.compatibility.featureCheck(ctx.capabilities);
		if (!this.lastCompatibility.ok) {
			await this.compatibility.ensureCompatible(ctx.cwd, ctx.capabilities);
		}
		if (params.action === "set-auto") {
			this.autoApprove = params.auto === true;
			return {
				content: [
					{
						type: "text",
						text: `Automatic plan authorization ${this.autoApprove ? "ON" : "OFF"} (session-scoped; initial plans and amendments ${this.autoApprove ? "skip USER_GATE" : "require USER_GATE"}).`,
					},
				],
				details: { action: "set-auto", warning: this.persistenceWarning(ctx) },
			};
		}
		if (params.action === "set-model") {
			return this.setModelResult(teamId, params.member as MemberInput, ctx);
		}
		if (params.action === "wait") {
			return this.waitResult(teamId, (params.member as MemberInput).id, params.timeout, ctx, signal);
		}
		const detached = params.background !== false;
		const dispatch = params.action === "run" || params.action === "parallel"
			? this.preflightExecutionDispatch(teamId, params.action === "run" ? [params.taskId as string] : params.taskIds as string[], ctx)
			: params.action === "review"
				? this.preflightReviewDispatch(teamId, params.reviewRoundId as string, params.taskIds as string[], ctx)
				: this.preflightExpertDispatch(
					teamId,
					params.expertRoundId as string,
					params.expertId as string,
					params.taskIds as string[],
					params.objective as string,
					ctx,
				);
		const tasks = dispatch.tasks;

		this.lastCompatibility = await this.compatibility.ensureCompatible(ctx.cwd, ctx.capabilities);
		const workspace = await this.writePlanWorkspace(teamId, ctx);
		const views = await this.prepareDashboard(teamId, tasks, ctx);
		const preparedKeys: string[] = [];
		try {
			const prepared = await Promise.allSettled(tasks.map(async (task) => {
				const member = this.state.teams[teamId].members[task.member.id];
				await this.ensureClient(member, ctx);
				preparedKeys.push(memberKey(teamId, member.id));
			}));
			const failure = prepared.find((result) => result.status === "rejected");
			if (failure?.status === "rejected") throw failure.reason;
		} catch (error) {
			await Promise.allSettled(preparedKeys.map(async (key) => {
				await this.clients.get(key)?.stop();
				this.clients.delete(key);
			}));
			throw error;
		}
		const beforeActivation = this.getState();
		try {
			dispatch.activate();
		} catch (error) {
			this.state = beforeActivation;
			await Promise.allSettled(preparedKeys.map(async (key) => {
				await this.clients.get(key)?.stop();
				this.clients.delete(key);
			}));
			throw error;
		}
		const results =
			params.action === "run"
				? [
						await this.runMember(
							teamId,
							tasks[0],
							ctx,
							workspace,
							views.get(memberKey(teamId, tasks[0].member.id)),
							signal,
							onUpdate,
							detached,
						),
				  ]
				: await this.runParallel(teamId, tasks, ctx, workspace, views, signal, onUpdate, detached);
		const response = this.resultsResponse(params.action, results, ctx);
		if (
			detached &&
			["run", "parallel", "review", "expert"].includes(params.action) &&
			results.length > 0 &&
			results.every((result) => result.status === "RUNNING")
		) {
			response.terminate = true;
		}
		return response;
	}

	private assertPlannedMemberAvailable(team: TeamRecord, memberId: string): MemberState {
		const member = team.members[memberId];
		if (!member) throw new TeamInputError(`Unknown planned member ${team.id}/${memberId}.`);
		const key = memberKey(team.id, memberId);
		if (this.active.has(key) || member.status === "RUNNING" || member.status === "STARTING") {
			throw new TeamInputError(`Planned member ${team.id}/${memberId} is busy.`);
		}
		return member;
	}

	private preflightExecutionDispatch(
		teamId: string,
		taskIds: string[],
		ctx: RuntimeContext,
	): { tasks: DispatchTask[]; activate: () => void } {
		const team = this.state.teams[teamId];
		if (!team?.plan) throw new TeamInputError(`Team ${teamId} has no registered plan.`);
		const selected = taskIds.map((id) => {
			const task = team.executionTasks[id];
			if (!task) throw new TeamInputError(`Unknown execution task ${teamId}/${id}.`);
			if (task.dependsOn.some((dependency) => team.executionTasks[dependency]?.status !== "VERIFIED")) {
				throw new TeamInputError(`Task ${id} has unverified dependencies.`);
			}
			if (!["READY", "FIX_REQUIRED", "BLOCKED", "REPORT_INVALID"].includes(task.status)) {
				throw new TeamInputError(`Task ${id} cannot start from ${task.status}.`);
			}
			if (team.plan!.memberKinds[task.memberId] !== "coder") {
				throw new TeamInputError(`Task ${id} owner ${task.memberId} is not a planned coder.`);
			}
			this.assertPlannedMemberAvailable(team, task.memberId);
			return task;
		});
		if (new Set(selected.map((task) => task.memberId)).size !== selected.length) {
			throw new TeamInputError("Planned parallel requires distinct member ids.");
		}
		for (let left = 0; left < selected.length; left++) {
			for (let right = left + 1; right < selected.length; right++) {
				if (selected[left].packet.ownedPaths.some((a) => selected[right].packet.ownedPaths.some((b) => pathsConflict(a, b)))) {
					throw new TeamInputError(`Planned batch tasks ${selected[left].id} and ${selected[right].id} conflict on owned paths.`);
				}
			}
		}
		const lockStatuses: ExecutionTaskStatus[] = ["RUNNING", "SUBMITTED", "AUDITING", "FIX_REQUIRED", "BLOCKED", "REPORT_INVALID"];
		for (const task of selected) {
			for (const other of Object.values(team.executionTasks)) {
				if (task.id === other.id || !lockStatuses.includes(other.status)) continue;
				if (task.packet.ownedPaths.some((a) => other.packet.ownedPaths.some((b) => pathsConflict(a, b)))) {
					throw new TeamInputError(`Task ${task.id} conflicts with unreleased ownership held by ${other.id} (${other.status}).`);
				}
			}
		}
		const packets = new Map<string, TaskPacket>();
		const tasks = selected.map((task): DispatchTask => {
			const dependencySummaries = Object.fromEntries(task.dependsOn.map((id) => [id, team.executionTasks[id].lastSummary ?? "Verified dependency; no summary recorded."]));
			const packet = { ...task.packet, dependencySummaries };
			packets.set(task.id, packet);
			const prompt = [
				`Execute planned task ${task.id}, attempt ${task.attempt + 1}. The runtime TeamState and this TaskPacket are authoritative; do not consult legacy shared coordination files.`,
				"```json\n" + JSON.stringify({ taskId: task.id, attempt: task.attempt + 1, taskPacket: packet }, null, 2) + "\n```",
				task.status === "FIX_REQUIRED" ? `Reviewer fix_prompt (execute verbatim, do not broaden scope):\n${task.fixPrompt ?? ""}` : "",
				packet.outputContract,
				EVIDENCE_GUIDELINE,
			].filter(Boolean).join("\n\n");
			return { member: { id: task.memberId }, task: prompt, target: { team: teamId, type: "execution", id: task.id } };
		});
		return {
			tasks,
			activate: () => {
				for (const task of selected) {
					task.packet.dependencySummaries = packets.get(task.id)!.dependencySummaries;
					task.status = "RUNNING";
					task.attempt++;
					task.updatedAt = this.now();
					delete task.lastIssue;
				}
				this.persist(ctx);
			},
		};
	}

	private preflightReviewDispatch(
		teamId: string,
		roundId: string,
		taskIds: string[],
		ctx: RuntimeContext,
	): { tasks: DispatchTask[]; activate: () => void } {
		const team = this.state.teams[teamId];
		if (!team?.plan) throw new TeamInputError(`Team ${teamId} has no registered plan.`);
		if (team.reviewRounds[roundId]) throw new TeamInputError(`ReviewRound ${roundId} already exists; use a new round id.`);
		const reviewer = this.assertPlannedMemberAvailable(team, team.plan.reviewerId);
		if (team.plan.memberKinds[reviewer.id] !== "reviewer") throw new TeamInputError(`Plan reviewer ${reviewer.id} is not authorized as reviewer.`);
		const targets = taskIds.map((id) => {
			const task = team.executionTasks[id];
			if (!task) throw new TeamInputError(`Unknown review target ${id}.`);
			if (task.status !== "SUBMITTED") throw new TeamInputError(`Review target ${id} must be SUBMITTED, got ${task.status}.`);
			return task;
		});
		const finalAcceptance = Object.values(team.executionTasks).every(
			(task) => taskIds.includes(task.id) || task.status === "VERIFIED" || task.status === "CANCELED",
		)
			? team.plan.acceptance
			: undefined;
		const prompt = [
			`Review planned tasks in ReviewRound ${roundId}. You are the only role authorized to decide VERIFIED or FIX_REQUIRED. Do not modify deliverables.`,
			"```json\n" + JSON.stringify({
				reviewRoundId: roundId,
				targets: targets.map((task) => ({
					taskId: task.id,
					attempt: task.attempt,
					packet: task.packet,
					submission: { summary: task.lastSummary, evidence: task.lastEvidence, outputPath: task.outputPath },
				})),
				...(finalAcceptance ? { globalAcceptance: finalAcceptance } : {}),
			}, null, 2) + "\n```",
			'End with one single-line JSON object: {"agent_team_report":{"type":"review","reviewRoundId":"<id>","summary":"...","evidence":["..."],"requests":[],"decisions":[{"taskId":"<id>","verdict":"VERIFIED|FIX_REQUIRED","fix_prompt":"required only for FIX_REQUIRED"}]}}',
			EVIDENCE_GUIDELINE,
		].join("\n\n");
		return {
			tasks: [{ member: { id: reviewer.id }, task: prompt, target: { team: teamId, type: "review", id: roundId } }],
			activate: () => {
				team.reviewRounds[roundId] = {
					id: roundId,
					reviewerId: reviewer.id,
					targetTaskIds: [...taskIds],
					status: "RUNNING",
					attempt: 1,
					updatedAt: this.now(),
				};
				for (const task of targets) {
					task.status = "AUDITING";
					task.updatedAt = this.now();
				}
				this.persist(ctx);
			},
		};
	}

	private preflightExpertDispatch(
		teamId: string,
		roundId: string,
		expertId: string,
		taskIds: string[],
		objective: string,
		ctx: RuntimeContext,
	): { tasks: DispatchTask[]; activate: () => void } {
		const team = this.state.teams[teamId];
		if (!team?.plan) throw new TeamInputError(`Team ${teamId} has no registered plan.`);
		if (team.expertRounds[roundId]) throw new TeamInputError(`ExpertRound ${roundId} already exists; use a new round id.`);
		const kind = team.plan.memberKinds[expertId];
		if (kind !== "debugger" && kind !== "product" && kind !== "optimizer") {
			throw new TeamInputError(`Member ${expertId} is not a planned read-only expert.`);
		}
		const expert = this.assertPlannedMemberAvailable(team, expertId);
		const targets = taskIds.map((id) => {
			const task = team.executionTasks[id];
			if (!task) throw new TeamInputError(`Unknown expert target ${id}.`);
			if (task.status === "CANCELED") throw new TeamInputError(`Expert target ${id} is canceled.`);
			if (kind === "optimizer" && task.status !== "VERIFIED") {
				throw new TeamInputError(`Optimizer target ${id} must be VERIFIED, got ${task.status}.`);
			}
			return task;
		});
		const prompt = [
			`Perform read-only ${kind} ExpertRound ${roundId}. Do not modify deliverables and do not change task verification state.`,
			"```json\n" + JSON.stringify({ expertRoundId: roundId, objective, targets: targets.map((task) => ({ taskId: task.id, status: task.status, packet: task.packet, summary: task.lastSummary, evidence: task.lastEvidence })) }, null, 2) + "\n```",
			'End with one single-line JSON object: {"agent_team_report":{"type":"expert","expertRoundId":"<id>","summary":"...","evidence":["..."],"requests":[]}}',
			EVIDENCE_GUIDELINE,
		].join("\n\n");
		return {
			tasks: [{ member: { id: expert.id }, task: prompt, target: { team: teamId, type: "expert", id: roundId } }],
			activate: () => {
				team.expertRounds[roundId] = {
					id: roundId,
					expertId,
					kind,
					targetTaskIds: [...taskIds],
					objective,
					status: "RUNNING",
					attempt: 1,
					updatedAt: this.now(),
				};
				this.persist(ctx);
			},
		};
	}

	private replacePendingRequests(
		team: TeamRecord,
		fromType: PendingRequest["fromType"],
		fromId: string,
		requests: ReportRequest[],
	): PendingRequest[] {
		team.pendingRequests = team.pendingRequests.filter((request) => request.fromType !== fromType || request.fromId !== fromId);
		const added = requests.map((request, index): PendingRequest => ({
			id: `${fromType}:${fromId}:${index + 1}`,
			fromType,
			fromId,
			kind: request.kind,
			text: request.text,
			createdAt: this.now(),
		}));
		team.pendingRequests.push(...added);
		return added;
	}

	private refreshReadyTasks(team: TeamRecord): void {
		for (const task of Object.values(team.executionTasks)) {
			if (task.status === "PENDING" && task.dependsOn.every((id) => team.executionTasks[id]?.status === "VERIFIED")) {
				task.status = "READY";
				task.updatedAt = this.now();
			}
		}
	}

	private taskCounts(team: TeamRecord): Record<string, number> {
		const counts: Record<string, number> = {};
		for (const task of Object.values(team.executionTasks)) counts[task.status] = (counts[task.status] ?? 0) + 1;
		return counts;
	}

	private deltaFor(
		team: TeamRecord,
		changed: CompletionDelta["changed"],
		summary: string | undefined,
		requests: PendingRequest[],
		outputPath?: string,
	): CompletionDelta {
		const counts: Record<string, number> = {
			"members.total": Object.keys(team.members).length,
			"tasks.total": Object.keys(team.executionTasks).length,
		};
		for (const member of Object.values(team.members)) counts[`members.${member.status}`] = (counts[`members.${member.status}`] ?? 0) + 1;
		for (const [status, count] of Object.entries(this.taskCounts(team))) counts[`tasks.${status}`] = count;
		return { team: team.id, counts, changed, summary, requests, outputPath };
	}

	private applyPlannedReport(
		target: RunTarget,
		output: string,
		outputPath?: string,
	): CompletionDelta {
		const team = this.state.teams[target.team];
		if (!team) throw new TeamStateError(`No planned target ${target.team}/${target.type}/${target.id}.`);
		try {
			const report = parseReportEnvelope(output, target.type);
			if (target.type === "execution") {
				const task = team.executionTasks[target.id];
				const envelope = report as ExecutionEnvelope;
				if (envelope.taskId !== task.id) throw new ReportEnvelopeError(`Execution report taskId ${envelope.taskId} does not match ${task.id}.`);
				if (task.status !== "RUNNING") throw new ReportEnvelopeError(`Execution task ${task.id} is ${task.status}, expected RUNNING.`);
				task.status = envelope.status;
				task.lastSummary = envelope.summary;
				task.lastEvidence = envelope.evidence;
				task.outputPath = outputPath;
				task.updatedAt = this.now();
				if (envelope.status === "BLOCKED") task.lastIssue = envelope.summary;
				else {
					delete task.lastIssue;
					delete task.fixPrompt;
				}
				const requests = this.replacePendingRequests(team, "execution", task.id, envelope.requests);
				return this.deltaFor(team, { type: "execution", id: task.id, status: task.status }, envelope.summary, requests, outputPath);
			}
			if (target.type === "review") {
				const round = team.reviewRounds[target.id];
				const envelope = report as ReviewEnvelope;
				if (envelope.reviewRoundId !== round.id) throw new ReportEnvelopeError(`Review report id ${envelope.reviewRoundId} does not match ${round.id}.`);
				const decisionIds = envelope.decisions.map((decision) => decision.taskId);
				if (new Set(decisionIds).size !== decisionIds.length || decisionIds.length !== round.targetTaskIds.length || round.targetTaskIds.some((id) => !decisionIds.includes(id))) {
					throw new ReportEnvelopeError("Review decisions must cover each target task exactly once.");
				}
				for (const decision of envelope.decisions) {
					const task = team.executionTasks[decision.taskId];
					if (task.status !== "AUDITING") throw new ReportEnvelopeError(`Review target ${task.id} is ${task.status}, expected AUDITING.`);
					task.status = decision.verdict;
					task.updatedAt = this.now();
					if (decision.verdict === "FIX_REQUIRED") {
						task.fixPrompt = decision.fix_prompt;
						task.lastIssue = decision.fix_prompt;
					} else {
						delete task.fixPrompt;
						delete task.lastIssue;
					}
				}
				round.status = "COMPLETED";
				round.summary = envelope.summary;
				round.evidence = envelope.evidence;
				round.outputPath = outputPath;
				round.updatedAt = this.now();
				delete round.lastIssue;
				this.refreshReadyTasks(team);
				const requests = this.replacePendingRequests(team, "review", round.id, envelope.requests);
				return this.deltaFor(team, { type: "review", id: round.id, status: round.status }, envelope.summary, requests, outputPath);
			}
			const round = team.expertRounds[target.id];
			const envelope = report as ExpertEnvelope;
			if (envelope.expertRoundId !== round.id) throw new ReportEnvelopeError(`Expert report id ${envelope.expertRoundId} does not match ${round.id}.`);
			round.status = "COMPLETED";
			round.summary = envelope.summary;
			round.evidence = envelope.evidence;
			round.outputPath = outputPath;
			round.updatedAt = this.now();
			delete round.lastIssue;
			const requests = this.replacePendingRequests(team, "expert", round.id, envelope.requests);
			return this.deltaFor(team, { type: "expert", id: round.id, status: round.status }, envelope.summary, requests, outputPath);
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			if (target.type === "execution") {
				const task = team.executionTasks[target.id];
				task.status = "REPORT_INVALID";
				task.lastIssue = reason;
				task.outputPath = outputPath;
				task.updatedAt = this.now();
				return this.deltaFor(team, { type: "execution", id: task.id, status: task.status }, reason, [], outputPath);
			}
			if (target.type === "review") {
				const round = team.reviewRounds[target.id];
				round.status = "REPORT_INVALID";
				round.lastIssue = reason;
				round.outputPath = outputPath;
				round.updatedAt = this.now();
				for (const id of round.targetTaskIds) {
					const task = team.executionTasks[id];
					if (task.status === "AUDITING") task.status = "SUBMITTED";
				}
				return this.deltaFor(team, { type: "review", id: round.id, status: round.status }, reason, [], outputPath);
			}
			const round = team.expertRounds[target.id];
			round.status = "REPORT_INVALID";
			round.lastIssue = reason;
			round.outputPath = outputPath;
			round.updatedAt = this.now();
			return this.deltaFor(team, { type: "expert", id: round.id, status: round.status }, reason, [], outputPath);
		}
	}

	private interruptPlannedTarget(target: RunTarget, canceled: boolean, reason: string): CompletionDelta | undefined {
		const team = this.state.teams[target.team];
		if (!team) return undefined;
		if (target.type === "execution") {
			const task = team.executionTasks[target.id];
			if (task.status !== "RUNNING") return undefined;
			task.status = canceled ? "CANCELED" : "BLOCKED";
			task.lastIssue = reason;
			task.updatedAt = this.now();
			if (canceled) this.refreshReadyTasks(team);
			return this.deltaFor(team, { type: "execution", id: task.id, status: task.status }, reason, []);
		}
		if (target.type === "review") {
			const round = team.reviewRounds[target.id];
			if (round.status !== "RUNNING") return undefined;
			round.status = "BLOCKED";
			round.lastIssue = reason;
			round.updatedAt = this.now();
			for (const id of round.targetTaskIds) if (team.executionTasks[id].status === "AUDITING") team.executionTasks[id].status = "SUBMITTED";
			return this.deltaFor(team, { type: "review", id: round.id, status: round.status }, reason, []);
		}
		const round = team.expertRounds[target.id];
		if (round.status !== "RUNNING") return undefined;
		round.status = "BLOCKED";
		round.lastIssue = reason;
		round.updatedAt = this.now();
		return this.deltaFor(team, { type: "expert", id: round.id, status: round.status }, reason, []);
	}

	private async planResult(
		teamId: string,
		input: PlanInput,
		expectedRevision: number | undefined,
		ctx: RuntimeContext,
		signal?: AbortSignal,
		validateOnly = false,
	): Promise<RuntimeToolResult> {
		const current = this.state.teams[teamId];
		const currentRevision = current?.plan?.revision;
		if (currentRevision !== undefined && expectedRevision !== currentRevision) {
			throw new TeamInputError(`Plan revision mismatch: expected ${expectedRevision}, current ${currentRevision}.`);
		}
		if ([...this.active].some((key) => key.startsWith(`${teamId}\u0000`))) {
			throw new TeamInputError(`Team ${teamId} has active members; plan changes require an idle team.`);
		}
		const now = this.now();
		const prepared = preparePlan(input, ctx, now, current?.members);
		if (current) {
			for (const id of Object.keys(current.members)) {
				if (!prepared.configs[id]) throw new TeamInputError(`Plan registration/amendment may not remove existing member ${id}.`);
			}
		}
		if (current?.plan) {
			for (const [id, task] of Object.entries(current.executionTasks)) {
				const replacement = prepared.tasks[id];
				if (!replacement) throw new TeamInputError(`Plan amendment may not remove existing task ${id}.`);
				if (
					taskDefinition(task) !== taskDefinition(replacement) &&
					["RUNNING", "SUBMITTED", "AUDITING", "FIX_REQUIRED", "BLOCKED", "REPORT_INVALID"].includes(task.status)
				) {
					throw new TeamInputError(`Task ${id} holds ownership in ${task.status}; cancel or complete it before changing its definition.`);
				}
			}
		}
		const revision = (currentRevision ?? 0) + 1;
		// Dry-run: every validation above already ran (revision match, idle team,
		// preparePlan, member/task amendment constraints). Stop here without USER_GATE,
		// persistence, revision consumption, or workspace writes so the Leader can
		// iterate on a draft plan cheaply before the real submission.
		if (validateOnly) {
			return {
				content: [{
					type: "text",
					text: `Plan validation passed for team ${teamId}: revision ${revision} would ${current ? "amend to" : "register"} ${Object.keys(prepared.configs).length} members and ${Object.keys(prepared.tasks).length} tasks. Nothing was persisted and no gate was shown; submit with action plan when ready.`,
				}],
				details: { action: "plan" },
			};
		}
		// USER_GATE granularity: initial registration and roster growth require explicit
		// consent; amendments within the already-approved roster (instruction/task/
		// acceptance edits, re-dispatching existing members) reuse that consent silently.
		// The roster can only grow - preparePlan forbids removing existing members.
		const rosterGrew = current !== undefined && Object.keys(prepared.configs).some((id) => !current.members[id]);
		if (!this.autoApprove && (current === undefined || rosterGrew)) {
			if (!ctx.hasUI) return this.cancelledResult("plan", "Plan registration/roster growth requires a TUI/RPC USER_GATE confirmation or session-scoped set-auto authorization.");
			const approved = await ctx.confirm(
				currentRevision === undefined ? "Register Agent Team plan" : "Amend Agent Team plan",
				planConfirmation(teamId, prepared, revision, current),
				{ signal, timeout: 120_000 },
			);
			if (!approved) return this.cancelledResult("plan", `User declined plan revision ${revision} for ${teamId}.`);
		}
		// Re-check the live revision after a possible asynchronous USER_GATE. A stale or
		// concurrent amendment must fail closed before UUID allocation or persistence.
		if (this.state.teams[teamId]?.plan?.revision !== currentRevision) {
			throw new TeamInputError(`Plan revision changed during confirmation; retry from current status.`);
		}
		const next = current ? structuredClone(current) : emptyTeam(teamId);
		const changedClients: string[] = [];
		for (const [id, config] of Object.entries(prepared.configs)) {
			const existing = next.members[id];
			if (!existing) {
				next.members[id] = createApprovedMember(teamId, config, now, this.uuid());
				continue;
			}
			if (configHash(config) !== existing.configHash) {
				changedClients.push(memberKey(teamId, id));
				next.members[id] = {
					...existing,
					...config,
					team: teamId,
					configHash: configHash(config),
					approvedAt: now,
					status: existing.status === "STOPPED" ? "STOPPED" : "APPROVED",
				};
			}
		}
		for (const [id, task] of Object.entries(prepared.tasks)) {
			const existing = next.executionTasks[id];
			if (existing && taskDefinition(existing) === taskDefinition(task)) {
				next.executionTasks[id] = existing;
			} else {
				next.executionTasks[id] = { ...task, attempt: existing?.attempt ?? 0 };
			}
		}
		next.plan = {
			revision,
			reviewerId: prepared.reviewerId,
			memberKinds: prepared.memberKinds,
			acceptance: prepared.acceptance,
			registeredAt: current?.plan?.registeredAt ?? now,
			updatedAt: now,
		};
		this.refreshReadyTasks(next);
		// Stop stale idle clients only after approval. No child or Dashboard is
		// created by plan; changed configurations restart lazily on a later dispatch.
		await Promise.allSettled(changedClients.map(async (key) => {
			try {
				await this.clients.get(key)?.stop();
			} finally {
				this.clients.delete(key);
			}
		}));
		const before = this.state;
		this.state = { ...this.state, teams: { ...this.state.teams, [teamId]: next } };
		try {
			this.persist(ctx);
		} catch (error) {
			this.state = before;
			throw error;
		}
		let warning = this.persistenceWarning(ctx);
		try {
			await this.writePlanWorkspace(teamId, ctx);
		} catch (error) {
			const workspaceWarning = `Plan persisted, but recovery workspace update failed: ${error instanceof Error ? error.message : String(error)}`;
			warning = warning ? `${warning} ${workspaceWarning}` : workspaceWarning;
		}
		return {
			content: [{
				type: "text",
				text: `Registered team ${teamId} plan revision ${revision}: ${Object.keys(next.members).length} members, ${Object.keys(next.executionTasks).length} execution tasks. No task was dispatched.${warning ? `\n${warning}` : ""}`,
			}],
			details: { action: "plan", warning },
		};
	}

	async shutdown(ctx: RuntimeContext): Promise<void> {
		const keys = [
			...new Set([
				...this.clients.keys(),
				...this.active,
				...this.runControls.keys(),
				...this.settleWaits.keys(),
			]),
		];
		// Mark STOPPED before cancelling the settle waits (and before awaiting client
		// stops) so a racing background finalization observes the stopped status and
		// never resurrects a collectable result.
		for (const key of keys) {
			const [team, id] = key.split("\u0000");
			const member = this.state.teams[team]?.members[id];
			if (member && member.status !== "STOPPED") member.status = "STOPPED";
		}
		// Hard-terminate every live run (kill-level) regardless of dispatch mode; a
		// parent-session shutdown is never a soft interrupt. finalization is NOT
		// awaited here: its client calls (getSessionStats etc.) could hang on a stuck
		// child and block shutdown; the STOPPED status + interrupted marker suppress
		// any resurrected result or completion report from the racing finalization.
		for (const [key, control] of this.runControls) {
			const target = this.runTargets.get(key);
			if (target) this.interruptPlannedTarget(target, false, "Parent session shut down; prompt not replayed.");
			control.kill();
		}
		await Promise.allSettled([...this.clients.values()].map((client) => client.stop()));
		this.clients.clear();
		this.backgroundResults.clear();
		this.runControls.clear();
		this.runTargets.clear();
		for (const wait of this.settleWaits.values()) wait.cancel();
		this.settleWaits.clear();
		await this.dashboard?.shutdown();
		this.dashboard = undefined;
		let changed = keys.length > 0;
		for (const key of keys) {
			const [team, id] = key.split("\u0000");
			const member = this.state.teams[team]?.members[id];
			if (member && member.status !== "STOPPED") {
				member.status = "STOPPED";
				changed = true;
			}
		}
		if (changed && !this.readOnlyError) this.persist(ctx);
	}

	private async writePlanWorkspace(teamId: string, ctx: RuntimeContext): Promise<string> {
		const team = this.state.teams[teamId];
		if (!team?.plan) throw new TeamStateError(`Team ${teamId} has no registered plan.`);
		const dir = join(ctx.cwd, ".pi", "agent-team", teamId);
		await mkdir(join(dir, "leader"), { recursive: true });
		for (const member of Object.values(team.members)) await this.ensureMemberIdentity(member, dir);
		const memberLines = Object.values(team.members)
			.sort((a, b) => a.id.localeCompare(b.id))
			.map((member) => `- ${member.id}: ${team.plan!.memberKinds[member.id]} / ${member.role} / ${member.model.provider}/${member.model.id} / ${member.status}`);
		const taskLines = Object.values(team.executionTasks)
			.sort((a, b) => a.id.localeCompare(b.id))
			.map((task) => `- ${task.id}: ${task.status}; owner=${task.memberId}; depends=${task.dependsOn.join(",") || "none"}; owns=${task.packet.ownedPaths.join(",")}`);
		const content = [
			`# Agent Team Plan: ${teamId}`,
			"",
			`- Revision: ${team.plan.revision}`,
			`- Reviewer: ${team.plan.reviewerId}`,
			`- Updated: ${team.plan.updatedAt}`,
			"- Source of truth: runtime TeamState; this file is a compact recovery view.",
			"",
			"## Roster",
			...memberLines,
			"",
			"## Execution DAG",
			...taskLines,
			"",
			"## Acceptance",
			...team.plan.acceptance.map((item) => `- ${item}`),
			"",
			"## Resume",
			"Leader explicitly starts READY task/review/expert nodes. Runtime never auto-dispatches.",
			"",
		].join("\n");
		await writeFile(join(dir, "leader", "plan.md"), content, "utf8");
		return dir;
	}

	private async ensureMemberIdentity(member: MemberState, dir: string): Promise<void> {
		const identityDir = join(dir, "members", member.id);
		const identityPath = join(identityDir, "identity.md");
		try {
			await readFile(identityPath, "utf8");
			return; // 已存在:leader 编辑内容保留,下次 run 生效(决策 3)
		} catch {
			// first generation
		}
		await mkdir(identityDir, { recursive: true });
		const content = [
			`# Member Identity: ${member.id}`,
			"",
			`- Team: ${member.team}`,
			`- Role: ${member.role}`,
			`- Model: ${member.model.provider}/${member.model.id}`,
			`- Thinking: ${member.thinking}`,
			`- Tools: ${member.tools.join(", ") || "all"}`,
			`- Approved: ${member.approvedAt}`,
			"",
			"## Instructions",
			"",
			member.instructions,
			"",
		].join("\n");
		await writeFile(identityPath, content, "utf8");
	}


	private async writeMemberOutput(member: MemberState, output: string, workspace: string): Promise<string | undefined> {
		const dir = join(workspace, "members", member.id);
		const path = join(dir, "output.md");
		try {
			await mkdir(dir, { recursive: true });
			const header = [
				`# Output: ${member.team}/${member.id}`,
				`- Time: ${this.now()}`,
				`- Status: ${member.status}`,
				`- Model: ${member.model.provider}/${member.model.id}`,
				"",
				"",
			].join("\n");
			await writeFile(path, `${header}${output || "(no assistant output)"}\n`, "utf8");
			return path;
		} catch {
			return undefined; // 落盘失败不阻断成员收尾
		}
	}

	private async prepareDashboard(
		teamId: string,
		tasks: DispatchTask[],
		ctx: RuntimeContext,
	): Promise<Map<string, DashboardMemberHandle>> {
		// TUI always prepares the dashboard; UI-capable RPC (e.g. AionUI) prepares it too.
		// Headless RPC, JSON, and print never create a server or open a browser.
		if (!ctx.hasUI || (ctx.mode !== "tui" && ctx.mode !== "rpc")) return new Map();
		if (!this.dashboardFactory) throw new Error("DASHBOARD_UNAVAILABLE: dashboard factory is missing.");
		this.dashboard ??= this.dashboardFactory(ctx);
		this.dashboard?.setModels?.(ctx.listModels?.() ?? []);
		const members = tasks.map((task) => {
			const member = this.state.teams[teamId]?.members[task.member.id];
			if (!member) throw new TeamInputError(`Unknown member ${teamId}/${task.member.id}.`);
			return dashboardSpec(member);
		});
		return this.dashboard.prepare(members);
	}

	private async runParallel(
		teamId: string,
		tasks: DispatchTask[],
		ctx: RuntimeContext,
		workspace: string,
		views: Map<string, DashboardMemberHandle>,
		signal?: AbortSignal,
		onUpdate?: ProgressCallback,
		detached = false,
	): Promise<MemberRunResult[]> {
		const results = new Array<MemberRunResult>(tasks.length);
		let next = 0;
		let failed = false;
		let failureReason: unknown;
		let rollback: Promise<PromiseSettledResult<RuntimeToolResult>[]> | undefined;
		let cohort: { pending: number; promise: Promise<void>; release: () => void } | undefined;
		const markFailed = (error: unknown) => {
			if (failed) return;
			failed = true;
			failureReason = error;
			rollback = Promise.allSettled(tasks.map((task) => this.stopResult(teamId, task.member.id, ctx)));
		};
		const worker = async () => {
			while (!failed) {
				const index = next++;
				if (index >= tasks.length) return;
				if (!cohort || cohort.pending === 0) {
					let release: () => void = () => undefined;
					const promise = new Promise<void>((resolve) => {
						release = resolve;
					});
					cohort = { pending: 0, promise, release };
				}
				const current = cohort;
				current.pending++;
				let promptReported = false;
				const promptSettled = async (accepted: boolean, error?: unknown) => {
					if (promptReported) return;
					promptReported = true;
					if (!accepted) markFailed(error);
					current.pending--;
					if (current.pending === 0) current.release();
					await current.promise;
				};
				try {
					results[index] = await this.runMember(
						teamId,
						tasks[index],
						ctx,
						workspace,
						views.get(memberKey(teamId, tasks[index].member.id)),
						signal,
						onUpdate,
						detached,
						promptSettled,
					);
				} catch (error) {
					await promptSettled(false, error);
					markFailed(error);
					throw error;
				}
			}
		};
		await Promise.allSettled(Array.from({ length: Math.min(MAX_CONCURRENCY, tasks.length) }, worker));
		if (failed) {
			await rollback;
			const reason = `Parallel dispatch failed; prompt not replayed: ${failureReason instanceof Error ? failureReason.message : String(failureReason)}`;
			for (const task of tasks) if (task.target) this.interruptPlannedTarget(task.target, false, reason);
			this.persist(ctx);
			throw failureReason;
		}
		return results;
	}

	private async runMember(
		teamId: string,
		item: DispatchTask,
		ctx: RuntimeContext,
		workspace: string,
		view?: DashboardMemberHandle,
		signal?: AbortSignal,
		onUpdate?: ProgressCallback,
		detached = false,
		onPromptSettled?: (accepted: boolean, error?: unknown) => Promise<void>,
	): Promise<MemberRunResult> {
		const member = this.state.teams[teamId]?.members[item.member.id];
		if (!member) throw new TeamInputError(`Unknown member ${teamId}/${item.member.id}.`);
		const key = memberKey(teamId, member.id);
		if (this.active.has(key)) throw new TeamInputError(`Member ${teamId}/${member.id} is already running.`);
		this.active.add(key);
		if (item.target) this.runTargets.set(key, item.target);
		// A fresh run after kill resumes the member from its historical STOPPED
		// state; re-arm it so only a kill racing THIS run (which sets STOPPED
		// afterwards) can abort the dispatch.
		if (member.status === "STOPPED") member.status = "STARTING";
		let client: RpcClientLike | undefined;
		let accepted = false;
		let responseError: string | undefined;
		let firstAssistantChecked = false;
		let unsubscribe: (() => void) | undefined;
		let abortListener: (() => void) | undefined;
		let settleWait: SettledIdleWait | undefined;
		// Intentional-interrupt marker and the run's completion promise: stop/kill
		// (and the foreground Esc signal) share this so finalization reports
		// INTERRUPTED exactly once, and stop/kill can await the active-slot release.
		let interrupted = false;
		let resolveCompleted!: () => void;
		const reportProgress = (text: string) => {
			// Progress reporting must never break member execution; the tool may already
			// have returned (detached runs) and the caller's onUpdate can be invalidated.
			try {
				onUpdate?.({ content: [{ type: "text", text }], details: { action: "run" } });
			} catch {
				// ignore progress reporting failures
			}
		};
		try {
			const completed = new Promise<void>((resolve) => {
				resolveCompleted = resolve;
			});
			view?.write({
				type: "session",
				model: `${member.model.provider}/${member.model.id}`,
				sessionId: member.sessionId,
			});
			view?.write({ type: "task", task: item.task });
			view?.write({ type: "status", status: "STARTING" });
			// Register the run control before starting the child so stop/kill can
			// interrupt and await this run from its earliest window (child startup
			// included). The client is looked up at interrupt time: it may not exist
			// yet while ensureClient is in flight.
			const runControl: RunControl = {
				stop: () => {
					interrupted = true;
					settleWait?.cancel();
					const live = this.clients.get(key);
					if (!live) return;
					void live.abort().catch(() => {
						// Abort failed: the child may keep generating. Fall back to the safe
						// hard-stop so it never runs on silently, drop the now-unusable
						// client from the map, and record the degraded state.
						member.lastError = "Stop abort failed; child was stopped. Prompt not replayed.";
						try {
							this.persist(ctx);
						} catch {
							// read-only state: lastError still documents the failure
						}
						void live.stop().catch(() => undefined);
						this.clients.delete(key);
					});
				},
				kill: () => {
					interrupted = true;
					settleWait?.cancel();
				},
				completed,
			};
			this.runControls.set(key, runControl);
			// The foreground Esc path shares the same soft-interrupt handling as the
			// public stop action (reusing the run control, fallback included); detached
			// runs have no listener - stop is their only interruption channel.
			if (signal && !detached) {
				abortListener = () => runControl.stop();
				signal.addEventListener("abort", abortListener, { once: true });
			}
			client = await this.ensureClient(member, ctx);
			// A kill/shutdown that raced ensureClient marks the member STOPPED; abort
			// this run before it sends a prompt or rewrites the terminal status.
			if ((member.status as MemberStatus) === "STOPPED") {
				throw new MemberResponseError(KILLED_WHILE_STARTING);
			}
			// A soft stop that raced startup (no prompt to abort yet) cancels the
			// dispatch; the member stays INTERRUPTED with its client kept.
			if (interrupted) {
				throw new MemberResponseError(STOPPED_BEFORE_PROMPT);
			}
			const before = await client.getSessionStats();
			// S2-7 baseline: the last assistant text BEFORE this prompt. After settle,
			// output is only adopted when this round produced a new assistant message
			// with text; a quiet round must never misreport the previous round's text.
			const baselineText = await client.getLastAssistantText();
			member.status = "RUNNING";
			member.lastRunAt = this.now();
			delete member.lastError;
			this.persist(ctx);
			view?.write({ type: "status", status: "RUNNING" });
			unsubscribe = client.onEvent((event) => {
				if (event?.type === "message_end" && event.message?.role === "assistant") {
					if (!firstAssistantChecked) {
						firstAssistantChecked = true;
						const expected = `${member.model.provider}/${member.model.id}`;
						const actual = assistantMessageModel(event.message);
						if (actual !== expected) {
							responseError = `First assistant response model mismatch: expected ${expected}, got ${actual ?? "<missing>"}.`;
						}
					}
					responseError ??= assistantFailure(event);
				}
				for (const dashboardEvent of dashboardEventsFromRpc(event)) view?.write(dashboardEvent);
				const progress =
					event?.type === "tool_execution_start"
						? `${teamId}/${member.id}: tool ${event.toolName ?? "running"}`
						: event?.type === "agent_settled"
							? `${teamId}/${member.id}: settled`
							: undefined;
				if (progress) reportProgress(progress);
			});
			// Detached runs are deliberately decoupled from the main agent's tool signal:
			// the tool returns immediately and the same signal stays alive for the agent's
			// next turns (agent.abort() aborts the current run's signal), so a later user
			// Esc would destroy a background member. stop is the only interruption channel
			// for detached runs; foreground runs keep the historical abort behavior
			// (the listener is registered after the run control below).
			if (signal?.aborted) throw new Error("Agent task aborted before prompt acceptance.");
			const memberClient = client;
			settleWait = waitForSettledWithIdleTimeout(
				(listener) => memberClient.onEvent(listener),
				this.idleTimeoutMs(ctx.mode),
			);
			// A kill that raced the pre-prompt window marks the member STOPPED and a
			// soft stop marks the run interrupted; never send a prompt in either case.
			if ((member.status as MemberStatus) === "STOPPED") {
				throw new MemberResponseError(KILLED_BEFORE_PROMPT);
			}
			if (interrupted) {
				throw new MemberResponseError(STOPPED_BEFORE_PROMPT);
			}
			await client.prompt(item.task);
			accepted = true;
			await onPromptSettled?.(true);
			// A kill racing prompt acceptance marks the member STOPPED; never let this
			// run proceed (no settle wait, no replay) once the kill is visible.
			if ((member.status as MemberStatus) === "STOPPED") {
				throw new MemberResponseError(KILLED_WHILE_ACCEPTING);
			}
			settleWait.start();
			const finish = () =>
				this.settleAndFinish(
					key,
					member,
					memberClient,
					before,
					baselineText,
					workspace,
					ctx,
					view,
					// Detached runs are fully decoupled from the main agent's signal: not only
					// is no abort listener registered, finalization must not read it either.
					detached ? undefined : signal,
					settleWait!,
					() => interrupted,
					() => responseError ?? (firstAssistantChecked ? undefined : "First assistant response model metadata was not observed."),
					item.target,
					() => {
						this.runControls.delete(key);
						this.runTargets.delete(key);
						resolveCompleted();
						this.settleWaits.delete(key);
						this.active.delete(key);
						// Listener ownership: detached runs hand the RPC->Dashboard listener to
						// settleAndFinish; it is released here, after settlement, so streaming
						// events keep flowing while the member runs (and errors still surface).
						unsubscribe?.();
					},
				);
			if (detached) {
				// Background dispatch: return immediately; the member keeps running in its
				// RPC child and the settle/finalize work continues in the background.
				// Drop any collectable result from a previous round so wait never observes
				// a stale outcome of an earlier dispatch on the same member.
				this.backgroundResults.delete(key);
				this.settleWaits.set(key, settleWait);
				void finish()
					.then((result) => {
						// A stop/shutdown racing settlement marks the member STOPPED and a
						// soft stop marks the run INTERRUPTED; neither may become collectable
						// again (no resurrection) nor be reported as a completion to the
						// main Pi.
						if (result.status !== "STOPPED" && !(interrupted && result.status === "INTERRUPTED")) {
							// Keep the collectable result first, then notify the main Pi: wait
							// must observe the same structured result after the auto report.
							this.backgroundResults.set(key, result);
							this.reportParentCompletion(ctx, result);
						}
					})
					.catch((error) => {
						// state/lastError/dashboard events are already recorded inside
						// settleAndFinish; the main Pi still gets the failure report.
						// A soft stop that raced finalization suppresses the report: the
						// interruption is the observable outcome, not a member failure.
						if (!interrupted) this.reportParentFailure(ctx, member, error, item.target);
					});
				return {
					team: teamId,
					member: member.id,
					status: "RUNNING",
					sessionId: member.sessionId,
					approvedAt: member.approvedAt,
					output: `Dispatched ${teamId}/${member.id} in the background. Use agent_team {action:"wait", member:{id:"${member.id}"}} to collect the result, or {action:"stop", member:{id:"${member.id}"}} to interrupt.`,
					truncated: false,
					usage: zeroUsage(),
				};
			}
			await settleWait.promise;
			return finish();
		} catch (error) {
			await onPromptSettled?.(false, error);
			// A kill racing this run marks the member STOPPED; never overwrite that
			// terminal status with INTERRUPTED/ERROR, and never replay the prompt.
			// ensureClient failure already marks the member ERROR and persists; keep
			// that status instead of downgrading a client-start failure to INTERRUPTED.
			if ((member.status as MemberStatus) !== "STOPPED") {
				if (member.status !== "ERROR") {
					member.status = interrupted
						? "INTERRUPTED"
						: error instanceof MemberResponseError
							? "ERROR"
							: "INTERRUPTED";
				}
				member.lastError = `${accepted ? "Prompt accepted; not replayed. " : ""}${
					error instanceof Error ? error.message : String(error)
				}`;
				member.idleSinceMs = Date.now();
				if (item.target) this.interruptPlannedTarget(item.target, false, member.lastError);
				this.persist(ctx);
				view?.write({ type: "error", message: member.lastError });
				view?.write({ type: "status", status: `${member.status}${accepted ? " · NOT REPLAYED" : ""}` });
			}
			if (client) {
				// A soft stop (or a kill, whose own bookkeeping already stopped the
				// child) is an intentional interrupt: keep the child client alive for
				// the next run (Esc semantics). Only hard failures stop the child here.
				if (!interrupted) {
					await client.stop().catch(() => undefined);
					this.clients.delete(key);
				}
			}
			throw error;
		} finally {
			// Ownership of the settle wait, the RPC->Dashboard listener, the run
			// control, and the active slot: foreground runs clean up here; a
			// successfully dispatched detached run hands all of them to settleAndFinish
			// (released in its finally). A run that failed before dispatch
			// (ensureClient/prompt error or a kill racing prompt acceptance) never
			// handed off - settleWaits has no entry - so clean up here too instead of
			// leaking the active slot, the event listener, or the stop/kill completion
			// promise.
			const handedOff = detached && this.settleWaits.has(key);
			if (!handedOff) {
				settleWait?.cancel();
				unsubscribe?.();
				this.runControls.delete(key);
				this.runTargets.delete(key);
				resolveCompleted();
				this.active.delete(key);
			}
			if (signal && abortListener) signal.removeEventListener("abort", abortListener);
		}
	}

	/**
	 * Await settlement, collect output/usage, and persist the final member state.
	 * Shared by foreground (awaited) and detached (background) runs.
	 */
	private async settleAndFinish(
		key: string,
		member: MemberState,
		client: RpcClientLike,
		before: RpcStats,
		baselineText: string | null,
		workspace: string,
		ctx: RuntimeContext,
		view: DashboardMemberHandle | undefined,
		signal: AbortSignal | undefined,
		settleWait: SettledIdleWait,
		interrupted: () => boolean,
		getResponseError: () => string | undefined,
		target: RunTarget | undefined,
		onComplete: () => void,
	): Promise<MemberRunResult> {
		const teamId = member.team;
		try {
			await settleWait.promise;
			// A kill (or shutdown) while settling cancels this wait; respect the STOPPED
			// status and skip finalization - the client is already gone.
			if (member.status === "STOPPED") {
				return {
					team: member.team,
					member: member.id,
					status: "STOPPED",
					sessionId: member.sessionId,
					approvedAt: member.approvedAt,
					output: "(stopped)",
					truncated: false,
					usage: zeroUsage(),
				};
			}
			// A soft stop (or a foreground Esc) is an intentional interrupt: its
			// message_end may carry stopReason "aborted", which must never be treated
			// as an assistant error.
			if (!interrupted() && !signal?.aborted && getResponseError()) throw new MemberResponseError(getResponseError()!);
			const [after, fullOutput] = await Promise.all([client.getSessionStats(), client.getLastAssistantText()]);
			// S2-7: only adopt the final text when this round produced a new assistant
			// message whose text differs from the pre-prompt baseline. A quiet round
			// (no assistant message, or one without text) must not misreport the
			// previous round's output as this round's result.
			const hasNewText = after.assistantMessages > before.assistantMessages && fullOutput !== baselineText;
			let output = hasNewText ? (fullOutput ?? "") : "";
			let truncated = false;
			const usage = usageDelta(before, after);
			member.status = interrupted() || signal?.aborted ? "INTERRUPTED" : "IDLE";
			member.idleSinceMs = Date.now();
			// 仅超长时落盘(用户确认):输出超过限制被截断时,完整版写入 members/<id>/output.md
			let outputPath: string | undefined;
			if (Buffer.byteLength(output, "utf8") > MAX_MEMBER_OUTPUT_BYTES) {
				outputPath =
					(await this.writeMemberOutput(member, output, workspace)) ?? join(workspace, "members", member.id, "output.md");
				const pathLine = `[Full output: ${outputPath}]`;
				const cut = truncateMemberOutput(output, Buffer.byteLength(pathLine, "utf8") + 1);
				output = `${cut.output}\n${pathLine}`;
				truncated = true;
			}
			const delta = target
				? member.status === "INTERRUPTED"
					? this.interruptPlannedTarget(target, false, "Member attempt was interrupted; prompt not replayed.")
					: this.applyPlannedReport(target, hasNewText ? (fullOutput ?? "") : "", outputPath)
				: undefined;
			this.persist(ctx);
			if (target) await this.writePlanWorkspace(member.team, ctx).catch(() => undefined);
			// Calibrate the Dashboard mirror with the final assistant text (replace
			// semantics): after a reconnect or when streaming deltas were sparse, the
			// page's accumulated text is made identical to what wait will return.
			if (output) view?.write({ type: "assistant_final", text: output });
			// contextUsage is a current snapshot (not a delta): merge it into the usage event
			view?.write({
				type: "usage",
				usage: {
					...usage,
					contextWindow: after.contextUsage?.contextWindow,
					contextTokens: after.contextUsage?.tokens ?? null,
					contextPercent: after.contextUsage?.percent ?? null,
				},
			});
			view?.write({ type: "status", status: member.status });
			return {
				team: teamId,
				member: member.id,
				status: member.status,
				sessionId: member.sessionId,
				approvedAt: member.approvedAt,
				output,
				truncated,
				outputPath,
				delta,
				usage,
			};
		} catch (error) {
			// A soft stop is an intentional interrupt: never downgrade it to ERROR,
			// and keep the child client alive for the next run (Esc semantics).
			member.status = !interrupted() && error instanceof MemberResponseError ? "ERROR" : "INTERRUPTED";
			member.idleSinceMs = Date.now();
			// settleAndFinish only runs after the prompt was accepted, so these failures
			// always carry the "not replayed" marker, matching the historical message.
			member.lastError = `Prompt accepted; not replayed. ${
				error instanceof Error ? error.message : String(error)
			}`;
			if (target) this.interruptPlannedTarget(target, false, member.lastError);
			this.persist(ctx);
			view?.write({ type: "error", message: member.lastError });
			view?.write({ type: "status", status: `${member.status} · NOT REPLAYED` });
			if (!interrupted()) {
				await client.stop().catch(() => undefined);
				this.clients.delete(key);
			}
			throw error;
		} finally {
			settleWait.cancel();
			onComplete();
		}
	}

	/**
	 * Report a settled background member result back into the main Pi's session.
	 * Called only for detached runs after the result is already collectable via
	 * wait; STOPPED results (stop/shutdown races) are never reported. Failures to
	 * deliver must never break member finalization - the parent session may be
	 * tearing down.
	 */
	private reportParentCompletion(ctx: RuntimeContext, result: MemberRunResult): void {
		if (!ctx.sendParentMessage || result.status === "STOPPED") return;
		try {
			const delta = result.delta;
			ctx.sendParentMessage(
				{
					customType: AGENT_TEAM_COMPLETION_TYPE,
					content: delta
						? [
							`Agent Team delta ${delta.team}: ${delta.changed.type}/${delta.changed.id} -> ${delta.changed.status}`,
							`Team counts: ${Object.entries(delta.counts).map(([status, count]) => `${status}=${count}`).join(", ")}`,
							delta.summary ? `Summary: ${delta.summary}` : undefined,
							delta.requests.length ? `Requests: ${delta.requests.map((request) => `${request.kind}: ${request.text}`).join(" | ")}` : undefined,
							delta.outputPath ? `Output file: ${delta.outputPath}` : undefined,
						].filter(Boolean).join("\n")
						: [
							`Agent Team member ${result.team}/${result.member} [${result.status}] done.`,
							result.outputPath ? `Output file: ${result.outputPath}` : undefined,
							result.output ? `Summary: ${result.output.slice(0, 1000)}${result.output.length > 1000 ? "...[truncated; use wait for full result]" : ""}` : "(no assistant text)",
						].filter(Boolean).join("\n"),
					display: true,
					details: delta
						? { delta }
						: { member: { team: result.team, id: result.member, status: result.status, sessionId: result.sessionId, outputPath: result.outputPath } },
				},
				{ triggerTurn: true, deliverAs: "followUp" },
			);
		} catch {
			// never break member finalization
		}
	}

	/**
	 * Report an async background failure (provider error, idle timeout, or settle
	 * finalization error) back into the main Pi's session. The member status is
	 * already ERROR/INTERRUPTED here (set by settleAndFinish); a STOPPED member is
	 * never reported.
	 */
	private reportParentFailure(ctx: RuntimeContext, member: MemberState, error: unknown, target?: RunTarget): void {
		if (!ctx.sendParentMessage || member.status === "STOPPED") return;
		const message = error instanceof Error ? error.message : String(error);
		try {
			const label = target ? `${target.type}/${target.id}` : `member ${member.team}/${member.id}`;
			const team = target ? this.state.teams[target.team] : undefined;
			const changedStatus = target && team
				? target.type === "execution"
					? team.executionTasks[target.id]?.status
					: target.type === "review"
						? team.reviewRounds[target.id]?.status
						: team.expertRounds[target.id]?.status
				: undefined;
			const delta = target && team && changedStatus
				? this.deltaFor(team, { type: target.type, id: target.id, status: changedStatus }, message, [])
				: undefined;
			ctx.sendParentMessage(
				{
					customType: AGENT_TEAM_COMPLETION_TYPE,
					content: [
						`Agent Team delta ${member.team}: ${label} failed; state=${changedStatus ?? member.status}; recovery is explicit and the prompt was not replayed.`,
						delta ? `Team counts: ${Object.entries(delta.counts).map(([status, count]) => `${status}=${count}`).join(", ")}` : undefined,
						`Error: ${message}`,
					].filter(Boolean).join("\n"),
					display: true,
					details: delta ? { delta, error: message } : { target, error: message },
				},
				{ triggerTurn: true, deliverAs: "followUp" },
			);
		} catch {
			// never break member finalization
		}
	}

	private async ensureClient(member: MemberState, ctx: RuntimeContext): Promise<RpcClientLike> {
		const key = memberKey(member.team, member.id);
		const current = this.clients.get(key);
		if (current) return current;
		// A kill/shutdown racing startup keeps the member STOPPED (the run control
		// will finalize it); never overwrite that terminal status.
		if (member.status !== "STOPPED") member.status = "STARTING";
		this.persist(ctx);
		let handle: MemberClientHandle | undefined;
		try {
			handle = await this.compatibility.createMemberClient({
				...member,
				instructions: member.instructions,
				cwd: ctx.cwd,
				trusted: ctx.trusted,
			});
			await handle.client.start();
			// 成员启动时启用 Pi 原生 auto-compaction；orchestrator 不设自定义阈值，
			// 也不在 settled 后主动调用 compact。启用失败只记录事实，不自动重放。
			try {
				await handle.client.setAutoCompaction(true);
			} catch (error) {
				member.contextNote = `Auto-compaction could not be enabled: ${
					error instanceof Error ? error.message : String(error)
				}`;
			}
			const childState = await handle.client.getState();
			if (childState.sessionId !== member.sessionId) {
				// First launch (no existing session file, so --session-id was omitted): pi
				// assigned a fresh id; adopt it so later runs resume the same session.
				// A mismatch on a restored session is a real failure, not an adoption.
				if (handle.restored) {
					throw new Error(`Child session mismatch: expected ${member.sessionId}, got ${childState.sessionId}.`);
				}
				member.sessionId = childState.sessionId;
			}
			const expectedName = `team:${member.team}/${member.id}`;
			if (childState.sessionName !== expectedName) await handle.client.setSessionName(expectedName);
			// Audit the child's reported model against the persisted member config so a
			// stale/rogue provider selection fails explicitly instead of silently running
			// on a different model than the one the leader approved.
			const reported = reportedModel(childState.model);
			const expected = `${member.model.provider}/${member.model.id}`;
			if (reported !== expected) {
				throw new Error(`Child model mismatch: expected ${expected}, got ${reported ?? "<missing>"}.`);
			}
			this.clients.set(key, handle.client);
			// Same race guard: keep STOPPED so runMember's post-start check aborts the
			// dispatch instead of resuming a killed member.
			if (member.status !== "STOPPED") member.status = "IDLE";
			this.persist(ctx);
			return handle.client;
		} catch (error) {
			// Keep STOPPED when a kill/shutdown raced startup: the kill owns the final
			// status and this run is already being finalized.
			if (member.status !== "STOPPED") {
				member.status = "ERROR";
				member.lastError = error instanceof Error ? error.message : String(error);
			}
			if (handle) await handle.client.stop().catch(() => undefined);
			this.persist(ctx);
			throw error;
		} finally {
			await handle?.cleanupPrompt();
		}
	}

	/**
	 * Soft interrupt (Esc semantics): abort the member's current prompt only.
	 * The child client, session, authorization, and Dashboard view are all kept,
	 * and the member ends INTERRUPTED; a later run sends a fresh task (the
	 * interrupted task is never replayed). Waits for the racing run's finalization
	 * so the active slot is released before returning. If abort itself fails the
	 * run control falls back to the safe hard-stop so the child never keeps
	 * generating silently.
	 */
	private async stopResult(teamId: string, id: string | undefined, ctx: RuntimeContext): Promise<RuntimeToolResult> {
		const members = this.state.teams[teamId]?.members ?? {};
		const targets = id ? [members[id]].filter(Boolean) : Object.values(members);
		const idle: string[] = [];
		await Promise.allSettled(
			targets.map(async (member) => {
				const key = memberKey(teamId, member.id);
				// Only an accepted run has a control to interrupt; a member with no live
				// run keeps its current status (a prompt-less member cannot be aborted).
				const control = this.runControls.get(key);
				if (control) {
					control.stop();
					// Await the racing finalization: it releases the active slot, drops any
					// collectable result, and resolves the control's completion promise.
					await control.completed;
				} else {
					idle.push(member.id);
				}
			}),
		);
		if (targets.length > 0 && !this.readOnlyError) this.persist(ctx);
		const lines = targets.length ? formatRoster(teamId, members) : [`Team ${teamId} has no members.`];
		if (idle.length > 0) lines.push(`No active run to stop: ${idle.join(", ")} (member${idle.length > 1 ? "s" : ""} idle).`);
		return {
			content: [{ type: "text", text: lines.join("\n") }],
			details: { action: "stop", warning: this.persistenceWarning(ctx) },
		};
	}

	/**
	 * Hard termination (the historical stop semantics): stop the member's child
	 * RPC, release its runtime resources, remove its Dashboard view, and mark it
	 * STOPPED. The approved member record and session UUID are kept for a later
	 * lazy re-run. Waits for the racing run's finalization so the active slot is
	 * released before returning.
	 */
	private async killResult(teamId: string, id: string | undefined, ctx: RuntimeContext): Promise<RuntimeToolResult> {
		const members = this.state.teams[teamId]?.members ?? {};
		const targets = id ? [members[id]].filter(Boolean) : Object.values(members);
		await Promise.allSettled(
			targets.map(async (member) => {
				const key = memberKey(teamId, member.id);
				const target = this.runTargets.get(key);
				// Mark STOPPED before interrupting so a racing finalization observes the
				// terminal status (and skips rewrites/resurrection); re-asserted after
				// awaiting finalization in case a racing settle rewrote the status.
				member.status = "STOPPED";
				const control = this.runControls.get(key);
				if (control) {
					control.kill();
					// Await the racing finalization so the active slot is released before
					// returning; finalization also drops any collectable result.
					await control.completed;
				}
				member.status = "STOPPED";
				if (target) this.interruptPlannedTarget(target, true, "Leader canceled the active attempt with kill.");
				const client = this.clients.get(key);
				if (client) await client.stop();
				this.clients.delete(key);
				this.backgroundResults.delete(key);
				this.settleWaits.get(key)?.cancel();
				this.settleWaits.delete(key);
				await this.dashboard?.closeMember(teamId, member.id);
			}),
		);
		if (targets.length > 0 && !this.readOnlyError) this.persist(ctx);
		const lines = targets.length ? formatRoster(teamId, members) : [`Team ${teamId} has no members.`];
		return {
			content: [{ type: "text", text: lines.join("\n") }],
			details: { action: "kill", warning: this.persistenceWarning(ctx) },
		};
	}

	/**
	 * Explicitly abandon planned tasks that are not in flight: release their
	 * owned-path locks and cascade cancellation to their PENDING/READY dependents.
	 */
	private cancelResult(teamId: string, taskIds: string[], ctx: RuntimeContext): RuntimeToolResult {
		const team = this.state.teams[teamId];
		if (!team?.plan) throw new TeamStateError(`Team ${teamId} has no registered plan.`);
		const resolved = resolveTaskCancellation(team.executionTasks, taskIds).sort((a, b) => a.id.localeCompare(b.id));
		const now = this.now();
		const lines: string[] = [];
		for (const { id, direct } of resolved) {
			const task = team.executionTasks[id];
			task.status = "CANCELED";
			task.lastIssue = direct ? "Leader canceled the task." : "Upstream task canceled; dependency unsatisfiable.";
			delete task.fixPrompt;
			task.updatedAt = now;
			lines.push(`${id}: CANCELED${direct ? "" : " (cascaded)"}`);
		}
		if (!this.readOnlyError) this.persist(ctx);
		return {
			content: [{ type: "text", text: [`Team ${teamId} canceled ${resolved.length} task(s):`, ...lines].join("\n") }],
			details: { action: "cancel", warning: this.persistenceWarning(ctx) },
		};
	}

	/**
	 * Wait for a background (detached) member run to settle and collect its result.
	 * Returns immediately when the member is not running; otherwise polls the member
	 * state (event-accelerated) until it settles, the timeout expires, or the caller's
	 * signal aborts (waiting itself never aborts the member - use stop for that).
	 */
	private async waitResult(
		teamId: string,
		id: string,
		timeoutMs: number | undefined,
		ctx: RuntimeContext,
		signal?: AbortSignal,
	): Promise<RuntimeToolResult> {
		const member = this.state.teams[teamId]?.members[id];
		if (!member) throw new TeamInputError(`Unknown member ${teamId}/${id}.`);
		const key = memberKey(teamId, id);
		const collect = () => this.backgroundResults.get(key);
		const fast = collect();
		if (fast) return this.waitResponse(teamId, id, fast, ctx);
		if (signal?.aborted) return this.waitResponse(teamId, id, null, ctx, "aborted");
		if (member.status !== "RUNNING" && member.status !== "STARTING") {
			return this.waitResponse(teamId, id, null, ctx, "not running");
		}
		const client = this.clients.get(key);
		if (!client) return this.waitResponse(teamId, id, null, ctx, "client unavailable");
		const timeout = Math.min(IDLE_TIMEOUT_MAX_MS, Math.max(1000, timeoutMs ?? this.idleTimeoutMs(ctx.mode)));
		const deadline = Date.now() + timeout;
		let aborted = false;
		const onAbort = () => {
			aborted = true;
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		try {
			while (Date.now() < deadline && !aborted) {
				const result = collect();
				if (result) return this.waitResponse(teamId, id, result, ctx);
				if (member.status !== "RUNNING" && member.status !== "STARTING") {
					return this.waitResponse(teamId, id, null, ctx, "settled without result");
				}
				let unsubscribe: (() => void) | undefined;
				await Promise.race([
					new Promise<void>((resolve) => {
						unsubscribe = client.onEvent((event) => {
							if (event?.type === "agent_settled") resolve();
						});
					}),
					new Promise((resolve) => setTimeout(resolve, 250)),
				]);
				// unsubscribe regardless of which side won the race: a polling listener that
				// survives the timeout would leak on the child client across repeated waits
				unsubscribe?.();
			}
			return this.waitResponse(teamId, id, collect() ?? null, ctx, aborted ? "aborted" : "timeout");
		} finally {
			signal?.removeEventListener("abort", onAbort);
		}
	}

	private waitResponse(
		teamId: string,
		id: string,
		result: MemberRunResult | null,
		ctx: RuntimeContext,
		note?: string,
	): RuntimeToolResult {
		if (result) return this.resultsResponse("wait", [result], ctx);
		const member = this.state.teams[teamId]?.members[id];
		const text = member
			? `${teamId}/${id} ${member.status}${note ? ` (${note})` : ""} session=${member.sessionId}${
					member.lastError ? ` error=${member.lastError}` : ""
				}`
			: `Team ${teamId} has no member ${id}.`;
		return {
			content: [{ type: "text", text }],
			details: { action: "wait", warning: this.persistenceWarning(ctx) },
		};
	}

	/**
	 * Dashboard and agent_team share one model/thinking switch path. Live children
	 * are updated and verified through public RPC before the configuration is persisted.
	 */
	async setModelFromDashboard(
		teamId: string,
		id: string,
		model: string,
		thinking: string,
		ctx: RuntimeContext,
	): Promise<RuntimeToolResult> {
		return this.setModelResult(teamId, { id, model, thinking: thinking as MemberConfig["thinking"] }, ctx);
	}

	private async setModelResult(teamId: string, input: MemberInput, ctx: RuntimeContext): Promise<RuntimeToolResult> {
		const member = this.state.teams[teamId]?.members[input.id];
		if (!member) throw new TeamInputError(`Unknown member ${teamId}/${input.id}.`);
		const key = memberKey(teamId, member.id);
		if (this.active.has(key) || member.status === "STARTING" || member.status === "RUNNING") {
			throw new TeamInputError(`Cannot switch model for active member ${teamId}/${member.id}; call stop first and wait for the member to become idle.`);
		}
		const model = parseModel(input.model);
		const thinking = input.thinking ?? member.thinking;
		if (!THINKING_LEVELS.includes(thinking)) {
			throw new TeamInputError(`set-model thinking must be one of: ${THINKING_LEVELS.join(", ")}.`);
		}
		const unavailable = modelUnavailableReason(model, ctx);
		if (unavailable) {
			throw new TeamInputError(
				`Model ${model.provider}/${model.id} is unavailable: ${unavailable}; set-model rejected. Use an exact canonical model from the main Pi registry.`,
			);
		}
		const beforeModel = { ...member.model };
		const beforeThinking = member.thinking;
		const client = this.clients.get(key);
		const rollbackChild = async (): Promise<string | undefined> => {
			if (!client) return undefined;
			const failures: string[] = [];
			try {
				await client.setModel(beforeModel.provider, beforeModel.id);
			} catch (error) {
				failures.push(`model rollback failed: ${error instanceof Error ? error.message : String(error)}`);
			}
			try {
				await client.setThinkingLevel(beforeThinking);
			} catch (error) {
				failures.push(`thinking rollback failed: ${error instanceof Error ? error.message : String(error)}`);
			}
			try {
				const restored = await client.getState();
				const restoredModel = reportedModel(restored.model);
				const expectedModel = `${beforeModel.provider}/${beforeModel.id}`;
				if (restoredModel !== expectedModel || restored.thinkingLevel !== beforeThinking) {
					failures.push(
						`child rollback verification failed: model ${restoredModel ?? "<missing>"}, thinking ${restored.thinkingLevel ?? "<missing>"}`,
					);
				}
			} catch (error) {
				failures.push(`child rollback verification failed: ${error instanceof Error ? error.message : String(error)}`);
			}
			return failures.length ? failures.join("; ") : undefined;
		};

		if (client) {
			try {
				await client.setModel(model.provider, model.id);
				await client.setThinkingLevel(thinking);
			} catch (error) {
				const rollbackError = await rollbackChild();
				throw new TeamInputError(
					`Model/thinking switch failed for ${teamId}/${member.id}: ${error instanceof Error ? error.message : String(error)}${rollbackError ? `; ${rollbackError}` : "; child configuration rolled back"}.`,
				);
			}
			let childState: Awaited<ReturnType<RpcClientLike["getState"]>>;
			try {
				childState = await client.getState();
			} catch (error) {
				const rollbackError = await rollbackChild();
				throw new TeamInputError(
					`Model/thinking switch verification failed for ${teamId}/${member.id}: ${error instanceof Error ? error.message : String(error)}${rollbackError ? `; ${rollbackError}` : "; child configuration rolled back"}.`,
				);
			}
			const reportedModelId = reportedModel(childState.model);
			const expectedModelId = `${model.provider}/${model.id}`;
			if (reportedModelId !== expectedModelId || childState.thinkingLevel !== thinking) {
				const rollbackError = await rollbackChild();
				throw new TeamInputError(
					`Model/thinking switch verification failed for ${teamId}/${member.id}: child reports model ${reportedModelId ?? "<missing>"} and thinking ${childState.thinkingLevel ?? "<missing>"}; expected model ${expectedModelId} and thinking ${thinking}. Persisted configuration remains ${beforeModel.provider}/${beforeModel.id} with thinking ${beforeThinking}${rollbackError ? `; ${rollbackError}` : "; child configuration rolled back"}.`,
				);
			}
		}

		member.model = model;
		member.thinking = thinking;
		member.configHash = configHash(member);
		try {
			this.persist(ctx);
		} catch (error) {
			member.model = beforeModel;
			member.thinking = beforeThinking;
			member.configHash = configHash(member);
			await rollbackChild();
			throw error;
		}
		await this.dashboard?.updateMember(teamId, member.id, dashboardSpec(member));
		const timing = client
			? "applies to the member's next LLM call"
			: "no live member client; persisted and takes effect on the member's next run";
		return {
			content: [{
				type: "text",
				text: `${teamId}/${member.id} model ${beforeModel.provider}/${beforeModel.id} -> ${model.provider}/${model.id}; thinking ${beforeThinking} -> ${thinking} (${timing})`,
			}],
			details: { action: "set-model", warning: this.persistenceWarning(ctx) },
		};
	}

	/**
	 * Lazy idle sweep: after a member settles (IDLE/INTERRUPTED), stop its child
	 * process once it stays idle longer than the keep-alive window, releasing the
	 * RPC client. The member record/session/authorization are kept; the next run
	 * restarts the child lazily via ensureClient (same sessionId restore).
	 */
	private async sweepIdleClients(): Promise<void> {
		const keepAlive = idleKeepAliveMs();
		const now = Date.now();
		for (const [key, client] of this.clients) {
			const [team, id] = key.split("\u0000");
			const member = this.state.teams[team]?.members[id];
			if (!member) continue;
			if (member.status === "RUNNING" || member.status === "STARTING") continue;
			if (!member.idleSinceMs || now - member.idleSinceMs < keepAlive) continue;
			await client.stop().catch(() => undefined);
			this.clients.delete(key);
		}
	}

	private dashboardDetails(
		targets: MemberState[],
		ctx: RuntimeContext,
	): { mode: string; members: Record<string, DashboardStatus> } {
		const members: Record<string, DashboardStatus> = {};
		for (const member of targets) {
			members[`${member.team}/${member.id}`] = this.dashboard?.status(member.team, member.id, ctx.mode) ?? {
				visibility: "UNAVAILABLE",
				note: ctx.mode === "tui" ? "Web Dashboard not started" : `Web Dashboard not used in ${ctx.mode} mode`,
			};
		}
		return { mode: ctx.mode, members };
	}

	private async statusResult(
		teamId: string,
		id: string | undefined,
		full: boolean,
		ctx: RuntimeContext,
	): Promise<RuntimeToolResult> {
		const team = this.state.teams[teamId];
		if (!team) {
			return { content: [{ type: "text", text: `Team ${teamId}: not registered in this session (no plan or members).` }], details: { action: "status", team: teamId } };
		}
		const members = team?.members ?? {};
		const targets = id ? [members[id]].filter(Boolean) : Object.values(members);
		const dashboard = this.dashboardDetails(targets, ctx);
		const memberCounts: Record<string, number> = {};
		for (const member of Object.values(members)) memberCounts[member.status] = (memberCounts[member.status] ?? 0) + 1;
		const current: TeamStatusSummary["current"] = [];
		const blocked: TeamStatusSummary["blocked"] = [];
		if (team) {
			for (const task of Object.values(team.executionTasks)) {
				if (!["PENDING", "READY", "VERIFIED", "CANCELED"].includes(task.status)) {
					current.push({ type: "execution", id: task.id, memberId: task.memberId, status: task.status });
				}
				if (["BLOCKED", "FIX_REQUIRED", "REPORT_INVALID"].includes(task.status)) blocked.push({ id: task.id, status: task.status, issue: task.lastIssue });
			}
			for (const round of Object.values(team.reviewRounds)) {
				if (round.status !== "COMPLETED") current.push({ type: "review", id: round.id, memberId: round.reviewerId, status: round.status });
				if (round.status === "BLOCKED" || round.status === "REPORT_INVALID") blocked.push({ id: round.id, status: round.status, issue: round.lastIssue });
			}
			for (const round of Object.values(team.expertRounds)) {
				if (round.status !== "COMPLETED") current.push({ type: "expert", id: round.id, memberId: round.expertId, status: round.status });
				if (round.status === "BLOCKED" || round.status === "REPORT_INVALID") blocked.push({ id: round.id, status: round.status, issue: round.lastIssue });
			}
		}
		const summary: TeamStatusSummary = {
			team: teamId,
			planRevision: team?.plan?.revision,
			memberCounts,
			taskCounts: team ? this.taskCounts(team) : {},
			current,
			blocked,
			requests: team?.pendingRequests ?? [],
		};
		const lines = [
			`Team ${teamId}: members=${Object.keys(members).length}${summary.planRevision ? ` planRevision=${summary.planRevision}` : " legacy-state (dispatch disabled)"}`,
			`Member counts: ${Object.entries(memberCounts).map(([status, count]) => `${status}=${count}`).join(", ") || "none"}`,
			`Task counts: ${Object.entries(summary.taskCounts).map(([status, count]) => `${status}=${count}`).join(", ") || "none"}`,
			...current.map((item) => `Current ${item.type}/${item.id}: ${item.status} member=${item.memberId}`),
			...blocked.map((item) => `Blocked ${item.id}: ${item.status}${item.issue ? ` - ${item.issue}` : ""}`),
			...summary.requests.map((request) => `Request ${request.id}: ${request.kind} - ${request.text}`),
		];
		if (full && team) {
			lines.push("Full planned state:", JSON.stringify(team, null, 2));
		} else if (id && targets[0]) {
			const member = targets[0];
			const view = dashboard.members[`${member.team}/${member.id}`];
			lines.push(`${rosterLine(member)} viewer=${view.visibility}${member.contextNote ? ` context=${member.contextNote}` : ""}`);
		}
		if (this.autoApprove) lines.push("Automatic plan authorization: ON (session-scoped; USER_GATE skipped, dispatch remains explicit)");
		if (this.readOnlyError) lines.push(`STATE ERROR: ${this.readOnlyError}`);
		if (this.lastCompatibility) lines.push(`Pi compatibility: ${this.lastCompatibility.code}`);
		const warning = this.persistenceWarning(ctx);
		if (warning) lines.push(warning);
		const fullState = full && team
			? { schemaVersion: STATE_SCHEMA_VERSION, teams: { [teamId]: structuredClone(team) }, updatedAt: this.state.updatedAt } as TeamState
			: undefined;
		return {
			content: [{ type: "text", text: lines.join("\n") }],
			details: {
				action: "status",
				summary,
				state: fullState,
				compatibility: this.lastCompatibility,
				dashboard,
				warning,
			},
		};
	}

	private resultsResponse(
		action: ToolParams["action"],
		results: MemberRunResult[],
		ctx: RuntimeContext,
		extraWarnings: string[] = [],
	): RuntimeToolResult {
		const usage = aggregateUsage(results);
		const warning = this.persistenceWarning(ctx);
		const text = results
			.map((result) =>
				[
					`${result.team}/${result.member} [${result.status}] session=${result.sessionId}`,
					result.outputPath ? `[Output: ${result.outputPath}]` : "",
					result.output || "(no assistant text)",
				].filter(Boolean).join("\n"),
			)
			.concat(extraWarnings, warning ? [warning] : [])
			.join("\n\n");
		return {
			content: [{ type: "text", text }],
			details: { action, results, compatibility: this.lastCompatibility, warning },
			usage: {
				input: usage.input,
				output: usage.output,
				cacheRead: usage.cacheRead,
				cacheWrite: usage.cacheWrite,
				totalTokens: usage.input + usage.output + usage.cacheRead + usage.cacheWrite,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: usage.cost },
			},
		};
	}

	private cancelledResult(action: ToolParams["action"], message: string): RuntimeToolResult {
		return {
			content: [{ type: "text", text: `Cancelled: ${message}` }],
			details: { action, cancelled: true },
		};
	}

	private persist(ctx: RuntimeContext): void {
		if (this.readOnlyError) throw new TeamStateError(this.readOnlyError);
		this.state.updatedAt = this.now();
		ctx.appendSnapshot(this.getState());
	}

	private persistenceWarning(ctx: RuntimeContext): string | undefined {
		return ctx.parentPersisted ? undefined : "Warning: parent session is not persisted; recovery is process-local only.";
	}
}
