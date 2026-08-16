import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { MAX_PARALLEL_TASKS, THINKING_LEVELS, type ToolParams } from "./runtime.ts";

const Id = Type.String({
	minLength: 1,
	maxLength: 64,
	pattern: "^[a-zA-Z0-9][a-zA-Z0-9._-]*$",
});
const ToolName = Type.String({ minLength: 1, maxLength: 80, pattern: "^[a-zA-Z0-9_-]+$" });
const Member = Type.Object(
	{
		id: Id,
		role: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
		instructions: Type.Optional(Type.String({ minLength: 1, maxLength: 8000 })),
		model: Type.Optional(
			Type.String({
				minLength: 3,
				maxLength: 200,
				description:
					"Leave empty to inherit the main Pi's current model. Only fill when the user explicitly asks for a different member model, using \"provider/model\" form.",
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
		instructions: Type.String({ minLength: 1, maxLength: 8000 }),
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
		objective: Type.String({ minLength: 1, maxLength: 8000 }),
		constraints: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 1000 }), { maxItems: 30 })),
		dependsOn: Type.Optional(Type.Array(Id, { maxItems: 30, uniqueItems: true })),
		ownedPaths: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { minItems: 1, maxItems: 100, uniqueItems: true }),
		acceptance: Type.Array(Type.String({ minLength: 1, maxLength: 1000 }), { minItems: 1, maxItems: 30 }),
		relevantPaths: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { maxItems: 100, uniqueItems: true })),
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

export const AgentTeamParams = Type.Object(
	{
		action: StringEnum(["plan", "run", "parallel", "review", "expert", "wait", "status", "stop", "kill", "set-model", "set-auto"] as const),
		team: Type.Optional(Id),
		member: Type.Optional(Member),
		plan: Type.Optional(Plan),
		expectedRevision: Type.Optional(Type.Integer({ minimum: 1 })),
		taskId: Type.Optional(Id),
		taskIds: Type.Optional(Type.Array(Id, { minItems: 1, maxItems: MAX_PARALLEL_TASKS, uniqueItems: true })),
		reviewRoundId: Type.Optional(Id),
		expertRoundId: Type.Optional(Id),
		expertId: Type.Optional(Id),
		objective: Type.Optional(Type.String({ minLength: 1, maxLength: 8000 })),
		full: Type.Optional(Type.Boolean()),
		// run/parallel dispatch the member run and return immediately by default
		// (background semantics); pass background:false to run synchronously to a
		// settled result. Use wait to collect results, stop to soft-interrupt the
		// current prompt (Esc semantics; member/session/dashboard stay), and kill to
		// hard-terminate the member child (stops it and removes its Dashboard view).
		background: Type.Optional(Type.Boolean()),
		// wait: maximum milliseconds to wait for the member to settle (clamped to 1s-24h).
		timeout: Type.Optional(Type.Integer({ minimum: 1 })),
		// set-auto: session-scoped USER_GATE authorization for plan registration
		// and amendments (memory-only; new sessions default to confirmation).
		auto: Type.Optional(Type.Boolean()),
	},
	{ additionalProperties: false },
);

// Keep runtime validation and provider-visible schema tied to the same public contract.
type SchemaParams = Static<typeof AgentTeamParams>;
const _typeCheck: ToolParams extends SchemaParams ? (SchemaParams extends ToolParams ? true : never) : never = true;
void _typeCheck;
