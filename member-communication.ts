import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import {
	DEFAULT_PEER_INBOX,
	MAX_PEER_INBOX,
	MAX_PEER_TEXT_CHARS,
	PEER_MARKER,
	PEER_MARKER_ENV,
	PEER_REQUEST_TIMEOUT_MS,
	PEER_TOKEN_ENV,
	PEER_TOOL_NAME,
	PEER_URL_ENV,
} from "./peer-protocol.ts";

/**
 * 通信回合允许的工具：只读查看。其余工具（含 bash、edit、write、team_message 与
 * 任何未知/自定义工具）在通信回合按 fail-safe 拦截——只靠提示词禁止写入不算通过。
 */
const COMM_READONLY_TOOLS = new Set(["read", "grep", "find", "ls", "ffgrep", "fffind", "glob"]);

/**
 * harness 在只读回合首行拼的说明（runtime.ts 的 peerAnswerPrompt 第一段）。
 * 这里只镜像它的开头，用来确认「标记 + 这句说明」确实是 harness 自己写的回合头。
 */
export const COMM_TURN_NOTICE = "本轮是只读的同伴通信回合";

/**
 * 判定本轮是不是 harness 拼出的只读同伴回合。
 *
 * 只认提示词首行（跳过前导空行）：整行只有标记，或以「标记 + harness 说明」开头。
 * 任务材料、证据、reviewer fix_prompt、同伴正文里引用这个标记——即使出现在某行行首、
 * 只要后面还跟着别的文字——都不足以翻转回合类型；此前用裸 includes 判定，任何人
 * 引用一次标记就会把接收者的执行回合锁成只读。
 */
export function isPeerCommTurn(prompt: string, marker: string): boolean {
	if (!marker) return false;
	const firstLine = prompt
		.split(/\r?\n/u)
		.find((line) => line.trim() !== "")
		?.trim();
	if (!firstLine) return false;
	return firstLine === marker || firstLine.startsWith(`${marker} ${COMM_TURN_NOTICE}`);
}

const Id = Type.String({ minLength: 1, maxLength: 64, pattern: "^[a-zA-Z0-9][a-zA-Z0-9._-]*$" });
const MessageId = Type.String({ minLength: 1, maxLength: 64, pattern: "^[a-zA-Z0-9-]+$" });

const PeerParams = Type.Object(
	{
		action: StringEnum(["members", "send", "inbox"] as const),
		to: Type.Optional({ ...Id, description: "send: 同队成员 id。" }),
		text: Type.Optional(
			Type.String({ minLength: 1, maxLength: MAX_PEER_TEXT_CHARS, description: "send: 消息正文。" }),
		),
		replyTo: Type.Optional({
			...MessageId,
			description: "send: 回答某条提问时的消息 id（inbox 里给出的 id）。",
		}),
		limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_PEER_INBOX })),
	},
	{ additionalProperties: false },
);

/**
 * 成员侧互通入口。只在受控 child 中通过显式 `--extension` 加载（`--no-extensions`
 * 仍会加载显式路径），凭环境变量注入的本机地址与成员令牌工作；父进程没有提供通道
 * 时（例如被当成普通扩展加载）本扩展不注册任何能力。
 */
export default function memberCommunication(pi: ExtensionAPI): void {
	const url = process.env[PEER_URL_ENV];
	const token = process.env[PEER_TOKEN_ENV];
	if (!url || !token) return;
	const marker = process.env[PEER_MARKER_ENV] ?? PEER_MARKER;
	// 只读通信回合：只由 harness 拼的回合头决定（不是任何一处标记引用），随每个新回合重置。
	let commTurn = false;

	const post = async (payload: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> => {
		const timeout = AbortSignal.timeout(PEER_REQUEST_TIMEOUT_MS);
		const response = await fetch(url, {
			method: "POST",
			headers: { "content-type": "application/json", "x-agent-team-token": token },
			body: JSON.stringify(payload),
			signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
		});
		const body = (await response.json().catch(() => undefined)) as { error?: string; text?: string } | undefined;
		if (!response.ok) throw new Error(body?.error ?? `Peer request failed with HTTP ${response.status}.`);
		return body ?? {};
	};

	pi.on("before_agent_start", (event) => {
		commTurn = "prompt" in event && isPeerCommTurn(event.prompt, marker);
		// 成员身份块默认由 --append-system-prompt 注入，位置在 docs 与 project_context/skills 之间。
		// 把它移到最后的自定义分节，让 preamble→tools→rules→docs→AGENTS.md→skills 成为
		// 跨成员共享的缓存前缀，只有 Team/Member/Role 在尾部按成员分化。
		const options = event.systemPromptOptions;
		if (!options?.appendSystemPrompt) return;
		const identity = options.appendSystemPrompt;
		options.appendSystemPrompt = "";
		options.sections = { ...options.sections, member_identity: identity };
	});
	pi.on("agent_settled", () => {
		commTurn = false;
	});
	pi.on("tool_call", (event) => {
		if (!commTurn) return undefined;
		if (COMM_READONLY_TOOLS.has(event.toolName)) return undefined;
		return {
			block: true,
			reason: `通信回合是只读的：${event.toolName} 在回答同伴提问时不可用，只能查看文件后直接回答。`,
		};
	});

	pi.registerTool({
		name: PEER_TOOL_NAME,
		label: "Team Message",
		description:
			"向同队成员发消息或查看成员与收件箱（members/send/inbox）。普通回合回答时用 replyTo 指向原消息，否则会被当成新提问；只读通信回合直接输出答案，不要调用本工具。",
		promptSnippet: "Exchange short messages with teammates",
		parameters: PeerParams,
		executionMode: "sequential",
		async execute(_toolCallId, params, signal) {
			const body = await post(
				{
					action: params.action,
					...(params.to === undefined ? {} : { to: params.to }),
					...(params.text === undefined ? {} : { text: params.text }),
					...(params.replyTo === undefined ? {} : { replyTo: params.replyTo }),
					...(params.limit === undefined ? {} : { limit: params.limit }),
				},
				signal,
			);
			return {
				content: [{ type: "text" as const, text: typeof body.text === "string" ? body.text : "已处理。" }],
				details: undefined,
			};
		},
	});
}
