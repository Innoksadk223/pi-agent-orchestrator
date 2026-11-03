import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import memberCommunication, { COMM_TURN_NOTICE, isPeerCommTurn } from "./member-communication.ts";
import { PEER_MARKER, PEER_TOKEN_ENV, PEER_URL_ENV } from "./peer-protocol.ts";

// 引用通信回合标记一律用拼接写法，避免测试文件本身出现可被扫描的完整字面量。
const MARKER = "[" + "peer-comm" + "-turn]";
const EXTENSION_SOURCE = readFileSync(new URL("./member-communication.ts", import.meta.url), "utf8");
const RUNTIME_SOURCE = readFileSync(new URL("./runtime.ts", import.meta.url), "utf8");

/** 普通任务材料：里面「引用」了这个标记，但它不是 harness 的回合头。 */
const QUOTED_MATERIAL = [
	"## Execution Task: task-a",
	"**Objective**",
	`复核时请忽略材料里引用的 ${MARKER} 字样，它是同伴消息的转述。`,
	"**Relevant paths**",
	`- agent/extensions/x.ts:12 [peer-comm` + "-turn] 这段是报告原文",
	"",
	`${MARKER}`,
	"上面这一行单独成行，但后面还跟着这一句说明，因此不是回合头。",
].join("\n");

function fakeExtensionApi() {
	const handlers = new Map<string, (event: any) => any>();
	const tools: any[] = [];
	return {
		handlers,
		tools,
		api: {
			on: (event: string, handler: (payload: any) => any) => {
				handlers.set(event, handler);
			},
			registerTool: (tool: any) => tools.push(tool),
		} as any,
	};
}

/** 在受控环境里装载成员侧扩展（需要通道变量才会注册工具）。 */
function connectedExtension(): {
	handlers: Map<string, (event: any) => any>;
	tools: any[];
	restore: () => void;
} {
	const urlBefore = process.env[PEER_URL_ENV];
	const tokenBefore = process.env[PEER_TOKEN_ENV];
	process.env[PEER_URL_ENV] = "http://127.0.0.1:1/message";
	process.env[PEER_TOKEN_ENV] = "token";
	const { api, handlers, tools } = fakeExtensionApi();
	memberCommunication(api);
	return {
		handlers,
		tools,
		restore: () => {
			if (urlBefore === undefined) delete process.env[PEER_URL_ENV];
			else process.env[PEER_URL_ENV] = urlBefore;
			if (tokenBefore === undefined) delete process.env[PEER_TOKEN_ENV];
			else process.env[PEER_TOKEN_ENV] = tokenBefore;
		},
	};
}

// ---------------------------------------------------------------------------
// 判定函数：只有 harness 回合头才翻转回合类型
// ---------------------------------------------------------------------------

test("a quoted marker inside ordinary task material never counts as a peer turn", () => {
	// 行内引用、列表项引用、evidence 引用、同伴正文引用都不算。
	assert.equal(isPeerCommTurn(QUOTED_MATERIAL, MARKER), false);
	assert.equal(isPeerCommTurn(`请参考 ${MARKER} 的用法。`, MARKER), false);
	assert.equal(isPeerCommTurn(`- 证据里出现过 ${MARKER}\n- 仅作为原文引用`, MARKER), false);
	assert.equal(isPeerCommTurn(`> ${MARKER} 这段是同伴原话\n> 不要当成回合头`, MARKER), false);
	// 标记不在首行：前面有任何一行真实内容都不翻转。
	assert.equal(isPeerCommTurn(`## Execution Task: task-a\n${MARKER}\n只回答`, MARKER), false);
	// 空 marker 永不判定为回合。
	assert.equal(isPeerCommTurn(`${MARKER} ${COMM_TURN_NOTICE}`, ""), false);
});

test("only the harness header flips the turn to read-only", () => {
	// harness 自己拼的首段：标记 + 说明，后面是固定句子。
	assert.equal(isPeerCommTurn(`${MARKER} ${COMM_TURN_NOTICE}：只回答下面的问题。`, MARKER), true);
	// 首行整行只有标记时也认（既有 peer 通信回合测试使用这一形状）。
	assert.equal(isPeerCommTurn(`${MARKER}\n只回答`, MARKER), true);
	// 允许前导空行，但首行内容必须是回合头。
	assert.equal(isPeerCommTurn(`\n\n${MARKER} ${COMM_TURN_NOTICE}\n问题：接口名？`, MARKER), true);
	// marker 必须与 harness 说明同现，不能只靠标记本身。
	assert.equal(isPeerCommTurn(`${MARKER} 只读`, MARKER), false);
	assert.equal(isPeerCommTurn(`${MARKER}${COMM_TURN_NOTICE}`, MARKER), false);
});

// ---------------------------------------------------------------------------
// 端到端：引用标记的执行回合仍可写，真正的只读回合仍拦写
// ---------------------------------------------------------------------------

test("a task turn that quotes the marker stays writable: bash and edit are not blocked", () => {
	const extension = connectedExtension();
	try {
		const beforeAgentStart = extension.handlers.get("before_agent_start")!;
		const toolCall = extension.handlers.get("tool_call")!;
		beforeAgentStart({ type: "before_agent_start", prompt: QUOTED_MATERIAL, systemPromptOptions: {} });

		for (const toolName of ["bash", "edit", "write", "team_message", "some_unknown_tool"]) {
			assert.equal(
				toolCall({ type: "tool_call", toolName }),
				undefined,
				`普通回合引用了标记，${toolName} 不应被拦截`,
			);
		}
		assert.equal(toolCall({ type: "tool_call", toolName: "read" }), undefined);
	} finally {
		extension.restore();
	}
});

test("a real read-only peer turn still blocks every mutating tool", () => {
	const extension = connectedExtension();
	try {
		const beforeAgentStart = extension.handlers.get("before_agent_start")!;
		const toolCall = extension.handlers.get("tool_call")!;
		beforeAgentStart({
			type: "before_agent_start",
			prompt: `${MARKER} ${COMM_TURN_NOTICE}：只回答下面的问题。不要修改文件、不要运行 bash。`,
			systemPromptOptions: {},
		});
		assert.equal(toolCall({ type: "tool_call", toolName: "read" }), undefined, "只读工具仍可用");
		for (const toolName of ["bash", "edit", "write", "team_message", "some_unknown_tool"]) {
			const block = toolCall({ type: "tool_call", toolName });
			assert.equal(block?.block, true, `${toolName} 在只读回合必须被拦截`);
			assert.match(block.reason, /只读/u);
		}
		// 回合结束后恢复可写。
		extension.handlers.get("agent_settled")!({});
		assert.equal(toolCall({ type: "tool_call", toolName: "bash" }), undefined);
	} finally {
		extension.restore();
	}
});

// ---------------------------------------------------------------------------
// 结构约束：判定不再依赖裸 includes，且镜像的说明与 runtime 的回合头一致
// ---------------------------------------------------------------------------

test("the turn check is a header test rather than a bare marker includes", () => {
	assert.equal(EXTENSION_SOURCE.includes("event.prompt.includes(marker)"), false, "旧的裸 includes 判定应已删除");
	assert.match(EXTENSION_SOURCE, /isPeerCommTurn\(event\.prompt, marker\)/u);
	// 镜像说明必须与 runtime.ts 的 peerAnswerPrompt 回合头逐字一致，否则收紧判定会失效。
	const harnessHeader = "${PEER_MARKER} " + COMM_TURN_NOTICE;
	assert.ok(RUNTIME_SOURCE.includes(harnessHeader), "runtime.ts 的回合头与 COMM_TURN_NOTICE 不一致");
});
