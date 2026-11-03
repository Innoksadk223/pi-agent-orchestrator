/**
 * 注记防伪：外来文本不得长成 harness 注记的样子。
 *
 * harness 往提示词里写 [TEAM SCOPE]、同伴消息 [...]、Leader answers to ...、
 * [Assigned by ...] 这类注记；成员报告、同伴消息、任务正文里的同名文本如果原样
 * 混进去，阅读者就分不清哪一行是 harness 写的、哪一行是别人伪造的。所以这里按
 * 「不可见字符 → 同形字 → 字面标记」三层逐个堵：先剥掉看不见的东西，再按西里尔/
 * 希腊同形字折叠后定位，最后把命中位置的起始括号换成全角括号，折断子串。
 *
 * 纯文本处理：不读文件、不猜上下文，也不 import 除自身以外的任何模块。
 */

/**
 * harness 实际使用的注记开头：一行里出现这些文本就足以冒充一条注记。
 * 清单以代码里的字面量为准（括号内为出处），成对围栏的收尾标签也算一条：
 *
 * - [TEAM SCOPE] / [/TEAM SCOPE]（session-roster.ts:36-37，每次派发的授权地图）
 * - 通信回合标记（peer-protocol.ts:19 PEER_MARKER）：runtime.ts:1389 把它写进只读同伴
 *   回合的提示；member-communication.ts:36 的 isPeerCommTurn 只看首个非空行（:43，整行等于
 *   标记或以「标记 + 说明」开头）来判定 commTurn，:105 在 tool_call 拦掉 bash/edit/write。
 *   首行判定已经把普通材料里的引用排除在外，这里再把标记列入清单属纵深防御：
 *   它仍然是一个能改变控制流的标签，不允许成员文本写出它的 ASCII 原形。
 * - Execute planned task（runtime.ts:2238）、Review planned tasks in ReviewRound（2302）、
 *   Perform read-only（2419）：派发首行指针
 * - ## Execution Task / ## Review Round / ## Expert Round / ## Consult Round
 *   （runtime.ts:2242 / 2305 / 2422 经 markdownFields:1036 拼成 `## <title>`）
 * - **Attempt** ~ **Relevant paths**（runtime.ts:2243-2249）与 **Targets** /
 *   **Submissions** / **Global acceptance** / **Kind**（2306-2308 / 2423-2425）：
 *   段标题。marker 不带收尾的 `**`，这样 `**Owned paths:**` 之类变体也漏不掉
 * - Task-specific head prompt / Member tail prompt / Task-specific tail prompt
 *   （runtime.ts:2239 / 2251 / 2252，另有 2310、2427）
 * - Reviewer fix_prompt (execute verbatim, do not broaden scope)（runtime.ts:2255）
 * - 同伴消息 [（runtime.ts:1376）、同伴消息（一次性注入（1425）、同队成员：（2806）
 * - Leader answers to（runtime.ts:1403）
 * - End with exactly one report envelope（runtime.ts:591）与
 *   Authoritative report envelope（595）：回报协议开头
 * - [Assigned by：早期 harness 面的留言签头，保留以免旧文案漏网
 */
export const NOTE_MARKERS: readonly string[] = [
	"[TEAM SCOPE]",
	"[/TEAM SCOPE]",
	"[peer-comm-turn]",
	"Execute planned task",
	"Review planned tasks in ReviewRound",
	"Perform read-only",
	"## Execution Task",
	"## Review Round",
	"## Expert Round",
	"## Consult Round",
	"**Attempt",
	"**Objective",
	"**Constraints",
	"**Dependencies",
	"**Owned paths",
	"**Acceptance",
	"**Relevant paths",
	"**Targets",
	"**Submissions",
	"**Global acceptance",
	"**Kind",
	"Task-specific head prompt",
	"Member tail prompt",
	"Task-specific tail prompt",
	"Reviewer fix_prompt (execute verbatim, do not broaden scope)",
	"同伴消息 [",
	"同伴消息（一次性注入",
	"同队成员：",
	"Leader answers to",
	"End with exactly one report envelope",
	"Authoritative report envelope",
	"[Assigned by",
];

/**
 * 不可见字符：\p{Cf} 覆盖零宽字符/软连字符/双向控制符/BOM/变体标签，
 * \p{M} 覆盖组合符（含变体选择符），后面四个是 Unicode 里少数归为 Lo/So
 * 却看不见的填充字符（Hangul filler 与盲文空白），只能显式列出。
 */
const INVISIBLE_CHAR = /[\p{Cf}\p{M}\u3164\u115F\u1160\uFFA0\u2800]/u;
const INVISIBLE_ALL = /[\p{Cf}\p{M}\u3164\u115F\u1160\uFFA0\u2800]/gu;

/** 同形字最小集：只收能把注记字母折叠成 ASCII 的那些，用于检测，不用于输出。 */
const HOMOGLYPHS: Readonly<Record<string, string>> = Object.freeze({
	// 西里尔大写
	"\u0410": "A", "\u0412": "B", "\u0415": "E", "\u041A": "K", "\u041C": "M",
	"\u041D": "H", "\u041E": "O", "\u0420": "P", "\u0421": "C", "\u0422": "T",
	"\u0423": "Y", "\u0425": "X", "\u0405": "S", "\u0406": "I", "\u0408": "J",
	// 西里尔小写
	"\u0430": "a", "\u0435": "e", "\u043E": "o", "\u0440": "p", "\u0441": "c",
	"\u0443": "y", "\u0445": "x", "\u0455": "s", "\u0456": "i", "\u0458": "j",
	"\u04BB": "h", "\u0501": "d", "\u04CF": "l",
	// 希腊大写
	"\u0391": "A", "\u0392": "B", "\u0395": "E", "\u0396": "Z", "\u0397": "H",
	"\u0399": "I", "\u039A": "K", "\u039C": "M", "\u039D": "N", "\u039F": "O",
	"\u03A1": "P", "\u03A4": "T", "\u03A5": "Y", "\u03A7": "X",
	// 希腊小写
	"\u03B1": "a", "\u03B5": "e", "\u03B9": "i", "\u03BA": "k", "\u03BD": "v",
	"\u03BF": "o", "\u03C1": "p", "\u03C4": "t", "\u03C5": "u", "\u03C7": "x",
});

/** 单个 marker 的改写轮数上限：替换字符不在折叠集里，正常一两轮就收敛，这里只保底。 */
const MAX_DEFANG_ROUNDS = 8;

/** 删掉不可见字符：零宽、双向控制、组合符、填充字符都不该参与「像不像注记」的判断。 */
export function stripInvisible(text: string): string {
	return text.replace(INVISIBLE_ALL, "");
}

/** 把西里尔/希腊同形字折叠成 ASCII。仅用于检测；输出正文时不要把原文折叠掉。 */
export function foldHomoglyphs(text: string): string {
	let folded = "";
	for (const char of text) folded += HOMOGLYPHS[char] ?? char;
	return folded;
}

interface Skeleton {
	/** 剥不可见字符 + 折叠同形字后的文本，只用来定位，不拿去替换。 */
	text: string;
	/** 每个骨架字符对应原文的 UTF-16 下标，替换时据此改回原文。 */
	origin: number[];
}

function skeleton(text: string): Skeleton {
	let out = "";
	const origin: number[] = [];
	let index = 0;
	while (index < text.length) {
		const char = String.fromCodePoint(text.codePointAt(index) ?? 0);
		if (!INVISIBLE_CHAR.test(char)) {
			const folded = foldHomoglyphs(char);
			out += folded;
			// origin 按 UTF-16 单元对齐：折叠结果若是代理对，也要占两个下标，
			// 否则后面用 indexOf 得到的骨架下标会与 origin 错位，改错字符。
			for (let unit = 0; unit < folded.length; unit += 1) origin.push(index);
		}
		index += char.length;
	}
	return { text: out, origin };
}

/** ASCII 可见字符有全角孪生（[ → ［、L → Ｌ）；没有孪生的字符退化为直接换成全角括号。 */
function defangChar(char: string): string {
	const code = char.codePointAt(0) ?? 0;
	if (code >= 0x21 && code <= 0x7e) return String.fromCodePoint(code + 0xfee0);
	return "［";
}

/**
 * 改写一个 marker 的全部出现位置：骨架里定位后，把「起始括号」在原文中的那一个字符
 * 换成全角孪生。全角括号不在折叠集里，所以替换不可逆，折回去再也拼不出 marker。
 * 对没有括号的 marker（Leader answers to）没有括号可换，就换掉命中首字符——
 * 插入字符没用，子串仍然在，必须改动命中区间内的某个字符才算折断。
 *
 * 一轮扫描把骨架里所有出现位置从后往前改完：后面的下标先不动前面的，
 * 出现几百次也只是一次遍历，不做「改一处重扫一次」的平方级循环。
 */
function defangMarker(text: string, marker: string): string {
	const needle = skeleton(stripInvisible(marker)).text;
	if (!needle) return text;
	const targetAt = Math.max(0, needle.indexOf("["));
	let out = text;
	for (let round = 0; round < MAX_DEFANG_ROUNDS; round += 1) {
		const look = skeleton(out);
		const hits: number[] = [];
		for (let hit = look.text.indexOf(needle); hit >= 0; hit = look.text.indexOf(needle, hit + 1)) {
			hits.push(hit);
		}
		if (hits.length === 0) return out;
		let changed = false;
		for (const hit of hits.reverse()) {
			const at = look.origin[hit + targetAt];
			if (at === undefined) continue;
			const original = String.fromCodePoint(out.codePointAt(at) ?? 0);
			const replacement = defangChar(original);
			if (replacement === original) continue;
			out = out.slice(0, at) + replacement + out.slice(at + original.length);
			changed = true;
		}
		if (!changed) return out;
	}
	return out;
}

/** 对每个 marker 做 fold+strip 后检测，命中就折断原文中对应的注记开头。 */
export function defangNoteMarkers(text: string, markers: readonly string[] = NOTE_MARKERS): string {
	let out = text;
	for (const marker of markers) {
		if (!marker) continue;
		out = defangMarker(out, marker);
	}
	return out;
}

/** 注入外来文本前的唯一入口：先剥不可见字符，再折断注记开头，且幂等。 */
export function guardNote(text: string, markers: readonly string[] = NOTE_MARKERS): string {
	return defangNoteMarkers(stripInvisible(text), markers);
}
