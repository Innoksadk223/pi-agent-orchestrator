import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static, type TProperties } from "typebox";
import { MAX_PARALLEL_TASKS, THINKING_LEVELS, type ToolParams } from "./runtime.ts";

const Id = Type.String({
	minLength: 1,
	maxLength: 64,
	pattern: "^[a-zA-Z0-9][a-zA-Z0-9._-]*$",
});
// Runtime-generated request IDs include their source tuple, e.g. execution:task-a:1.
const RequestId = Type.String({
	minLength: 1,
	maxLength: 200,
	pattern: "^[a-zA-Z0-9][a-zA-Z0-9._:-]*$",
});
const ToolName = Type.String({ minLength: 1, maxLength: 80, pattern: "^[a-zA-Z0-9_-]+$" });
const Prompt = Type.String({ minLength: 1, maxLength: 8000 });
const Member = Type.Object(
	{
		id: Id,
		role: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
		instructions: Type.Optional(Prompt),
		headPrompt: Type.Optional(Prompt),
		tailPrompt: Type.Optional(Prompt),
		model: Type.Optional(
			Type.String({
				minLength: 3,
				maxLength: 200,
				description:
					"For a new member, leave empty to inherit the main Pi's current model; during an amendment, omission preserves an existing member's persisted model. Only fill when the user explicitly asks for an override, using an exact available canonical \"provider/model\"; invalid explicit values never fall back.",
			}),
		),
		thinking: Type.Optional(
			StringEnum(THINKING_LEVELS, {
				description: "Leave empty to inherit the main Pi's current thinking level.",
			}),
		),
		tools: Type.Optional(Type.Array(ToolName, { minItems: 1, maxItems: 20, uniqueItems: true })),
	},
	{ additionalProperties: false },
);
const MemberId = Type.Object({ id: Id }, { additionalProperties: false });
const SetModelMember = Type.Object(
	{
		id: Id,
		model: Type.String({
			minLength: 3,
			maxLength: 200,
			description: "Exact canonical provider/model; never silently replaced.",
		}),
		thinking: Member.properties.thinking,
	},
	{ additionalProperties: false },
);
const PlanMember = Type.Object(
	{
		id: Id,
		kind: StringEnum(["coder", "reviewer", "debugger", "product", "optimizer"] as const),
		role: Type.String({ minLength: 1, maxLength: 500 }),
		instructions: Prompt,
		headPrompt: Type.Optional(Prompt),
		tailPrompt: Type.Optional(Prompt),
		model: Member.properties.model,
		thinking: Member.properties.thinking,
		tools: Member.properties.tools,
	},
	{ additionalProperties: false },
);
const PlannedTask = Type.Object(
	{
		id: Id,
		memberId: Id,
		objective: Prompt,
		constraints: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 1000 }), { maxItems: 30 })),
		dependsOn: Type.Optional(Type.Array(Id, { maxItems: 30, uniqueItems: true })),
		ownedPaths: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { minItems: 1, maxItems: 100, uniqueItems: true }),
		acceptance: Type.Array(Type.String({ minLength: 1, maxLength: 1000 }), { minItems: 1, maxItems: 30 }),
		relevantPaths: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { maxItems: 100, uniqueItems: true })),
		headPrompt: Type.Optional(Prompt),
		tailPrompt: Type.Optional(Prompt),
		outputContract: Type.Optional(Type.String({ minLength: 1, maxLength: 4000 })),
	},
	{ additionalProperties: false },
);
const Plan = Type.Object(
	{
		members: Type.Array(PlanMember, { minItems: 2, maxItems: 32 }),
		reviewerId: Id,
		tasks: Type.Array(PlannedTask, { minItems: 1, maxItems: 200 }),
		acceptance: Type.Array(Type.String({ minLength: 1, maxLength: 1000 }), { minItems: 1, maxItems: 50 }),
	},
	{ additionalProperties: false },
);

function Action<T extends TProperties>(action: string, properties: T) {
	return Type.Object(
		{ action: Type.Literal(action), team: Type.Optional(Id), ...properties },
		{ additionalProperties: false },
	);
}

// Keep each action's public shape small. Runtime validation remains the second
// line of defense for state-dependent checks such as task status and ownership.
export const AgentTeamParams = Type.Union([
	Action("plan", {
		plan: Plan,
		expectedRevision: Type.Optional(Type.Integer({ minimum: 1 })),
		validateOnly: Type.Optional(Type.Boolean()),
	}),
	Action("run", { taskId: Id, background: Type.Optional(Type.Boolean()) }),
	Action("resume", { taskId: Id, background: Type.Optional(Type.Boolean()) }),
	Action("parallel", {
		taskIds: Type.Array(Id, { minItems: 2, maxItems: MAX_PARALLEL_TASKS, uniqueItems: true }),
		background: Type.Optional(Type.Boolean()),
	}),
	Action("review", {
		reviewRoundId: Id,
		taskIds: Type.Array(Id, { minItems: 1, maxItems: MAX_PARALLEL_TASKS, uniqueItems: true }),
		background: Type.Optional(Type.Boolean()),
	}),
	Action("expert", {
		expertRoundId: Id,
		expertId: Id,
		taskIds: Type.Array(Id, { minItems: 1, maxItems: MAX_PARALLEL_TASKS, uniqueItems: true }),
		objective: Prompt,
		background: Type.Optional(Type.Boolean()),
	}),
	Action("wait", { member: MemberId, timeout: Type.Optional(Type.Integer({ minimum: 1 })) }),
	Action("status", { member: Type.Optional(MemberId), full: Type.Optional(Type.Boolean()) }),
	Action("stop", { member: Type.Optional(MemberId) }),
	Action("kill", { member: Type.Optional(MemberId) }),
	Action("cancel", { taskIds: Type.Array(Id, { minItems: 1, maxItems: MAX_PARALLEL_TASKS, uniqueItems: true }) }),
	Action("set-model", { member: SetModelMember }),
	Action("set-auto", { auto: Type.Boolean() }),
	Action("steer", { member: MemberId, message: Type.String({ minLength: 1, maxLength: 2000 }) }),
	Action("pause", { taskId: Id }),
	Action("answer-request", { requestId: RequestId, answer: Type.String({ minLength: 1, maxLength: 2000 }) }),
	Action("resolve-request", { requestId: RequestId }),
]);

// The public schema is intentionally narrower than the runtime's internal
// action-dispatch interface; runtime validation also checks state and ownership.
type SchemaParams = Static<typeof AgentTeamParams>;
const _typeCheck: SchemaParams extends ToolParams ? true : never = true;
void _typeCheck;
