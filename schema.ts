import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
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
		ownedPaths: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { maxItems: 100, uniqueItems: true }),
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

// Keep one transport-compatible object at the harness boundary. Action-specific
// requiredness and cross-field permissions stay in validateToolRequest(), where
// the runtime can return precise errors without relying on JSON Schema unions.
export const AgentTeamParams = Type.Object(
	{
		action: StringEnum([
			"plan", "run", "parallel", "review", "expert", "wait", "status", "stop", "kill", "cancel",
			"set-model", "set-auto", "steer", "pause", "resume", "answer-request", "resolve-request",
		] as const),
		team: Type.Optional(Id),
		member: Type.Optional(Member),
		plan: Type.Optional(Plan),
		expectedRevision: Type.Optional(Type.Integer({ minimum: 1 })),
		validateOnly: Type.Optional(Type.Boolean()),
		taskId: Type.Optional(Id),
		taskIds: Type.Optional(Type.Array(Id, { minItems: 1, maxItems: MAX_PARALLEL_TASKS, uniqueItems: true })),
		reviewRoundId: Type.Optional(Id),
		expertRoundId: Type.Optional(Id),
		expertId: Type.Optional(Id),
		objective: Type.Optional(Prompt),
		full: Type.Optional(Type.Boolean()),
		background: Type.Optional(Type.Boolean()),
		timeout: Type.Optional(Type.Integer({ minimum: 1 })),
		auto: Type.Optional(Type.Boolean()),
		message: Type.Optional(Type.String({ minLength: 1, maxLength: 2000 })),
		requestId: Type.Optional(RequestId),
		answer: Type.Optional(Type.String({ minLength: 1, maxLength: 2000 })),
	},
	{ additionalProperties: false },
);

// The public schema is intentionally transport-compatible; runtime validation
// remains the second line of defense for action-specific fields and state.
type SchemaParams = Static<typeof AgentTeamParams>;
const _typeCheck: SchemaParams extends ToolParams ? true : never = true;
void _typeCheck;
