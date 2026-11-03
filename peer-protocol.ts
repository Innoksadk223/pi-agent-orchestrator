/**
 * 成员互通协议常量：父进程（runtime / peer-bridge / compat）与成员 child 扩展
 * （member-communication.ts）共用。这里只有常量，没有实现，也不依赖任何模块，
 * 因此 child 侧加载它不会带上 runtime 或 HTTP 服务代码。
 */

/** 成员 child 侧读取的本机入口地址（含路径）。 */
export const PEER_URL_ENV = "PI_AGENT_TEAM_PEER_URL";
/** 每个 child 独立的临时令牌：服务端据此绑定 team/member，发送者不能自填身份。 */
export const PEER_TOKEN_ENV = "PI_AGENT_TEAM_PEER_TOKEN";
/** 通信回合标记：出现在派发提示里时，child 侧进入只读回答模式。 */
export const PEER_MARKER_ENV = "PI_AGENT_TEAM_PEER_MARKER";
/** 测试/打包用：覆盖成员扩展路径解析。 */
export const PEER_EXTENSION_ENV = "PI_AGENT_TEAM_PEER_EXTENSION";

export const PEER_TOOL_NAME = "team_message";
export const PEER_PATH = "/message";
export const PEER_TOKEN_HEADER = "x-agent-team-token";
export const PEER_MARKER = "[peer-comm-turn]";

export const MAX_PEER_TEXT_CHARS = 1000;
/** 自动回答的正文上限：问答比任务报告短，但仍允许带简短分析与路径引用。 */
export const MAX_PEER_ANSWER_CHARS = 2000;
export const MAX_PEER_BODY_BYTES = 16 * 1024;
export const PEER_REQUEST_TIMEOUT_MS = 10_000;
/** 自动回答的硬上限：最多 3 个模型回合、总计 120 秒，超限中断且不追加回答。 */
export const MAX_PEER_ANSWER_TURNS = 3;
export const PEER_ANSWER_TIMEOUT_MS = 120_000;
/** 同一 attempt 内每个成员最多发出的受控消息数。 */
export const MAX_PEER_SENDS_PER_TURN = 5;
export const MAX_PEER_INBOX = 20;
export const DEFAULT_PEER_INBOX = 5;
