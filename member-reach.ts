/**
 * 「能联系」与「能改」是两个独立判断，不能互相替代。
 *
 * 同伴消息只能解决信息不对称：A 可以给 B 发消息，不代表 A 获得 B 的
 * ownedPaths 写权限；反过来，B 已经 STOPPED 时消息队列也不应把他唤醒，
 * 却仍然不影响任何人对他那部分代码的授权判断。
 *
 * 因此这里拆成四个无副作用函数：canMessage 只看会话可达性，
 * authorityPaths / pathWithinAuthority 只看授权面，reachNotice 只负责
 * 把「联系归联系、写入权归写入权」这句话连同接收方实际可写路径写成一行。
 * 纯函数不 import ./runtime.ts（避免循环依赖），也不 import 任何第三方包，
 * 便于独立穷举测试。
 */

/** 判断可达性所需的最小成员视图；runtime 的 MemberState 结构上即可满足。 */
export interface ReachMember {
	id: string;
	status: string;
}

/** 判断授权面所需的最小任务视图；运行时权威是 packet.ownedPaths。 */
export interface AuthorityTask {
	memberId: string;
	/** 缺省（旧快照/纯函数测试）按「仍拥有」处理，保持向后兼容。 */
	status?: string;
	ownedPaths?: readonly string[];
	packet?: { ownedPaths?: readonly string[] };
}

/** 成员既可能是数组（测试、临时视图），也可能是 runtime 的 id→成员字典。 */
export type MemberSource = readonly ReachMember[] | Readonly<Record<string, ReachMember>>;
/** 任务同理：runtime 用 Record<string, ExecutionTask> 存 DAG。 */
export type TaskSource = readonly AuthorityTask[] | Readonly<Record<string, AuthorityTask>>;

/** reachNotice 中逐个列出的路径上限，超出后只剩一句「另有 N 条见 TaskPacket」。 */
export const REACH_NOTICE_PATH_LIMIT = 6;

/**
 * 不再持有 ownedPaths 的终态，口径与 runtime 的锁集合对齐：
 * runtime 的 lockStatuses（runtime.ts:928、2215）是 RUNNING/SUBMITTED/AUDITING/
 * FIX_REQUIRED/BLOCKED/REPORT_INVALID，这两个状态都不在其中；而 runtime 也只愿意
 * 派发 READY/FIX_REQUIRED/BLOCKED/REPORT_INVALID（runtime.ts:2196），所以
 * VERIFIED（已验收交付）与 CANCELED（已作废）既拿不到锁、也不会再跑一轮，
 * 它们的路径不能继续算成某个成员的可写范围。PENDING/READY 虽不在锁集合里，
 * 但仍在等待派发，路径仍归它们。
 */
const RELEASED_STATUSES: ReadonlySet<string> = new Set(["VERIFIED", "CANCELED"]);

function isReleased(task: AuthorityTask): boolean {
	return typeof task.status === "string" && RELEASED_STATUSES.has(task.status.trim().toUpperCase());
}

function isStopped(member: ReachMember): boolean {
	return typeof member.status === "string" && member.status.trim().toUpperCase() === "STOPPED";
}

// 字典来源按 key 排序遍历，保证同一快照在不同插入历史下得到同一路径列表。
function memberList(source: MemberSource): ReachMember[] {
	if (Array.isArray(source)) return [...source];
	return Object.keys(source)
		.sort()
		.map((key) => source[key])
		.filter((member): member is ReachMember => Boolean(member));
}

function taskList(source: TaskSource): AuthorityTask[] {
	if (Array.isArray(source)) return [...source];
	return Object.keys(source)
		.sort()
		.map((key) => source[key])
		.filter((task): task is AuthorityTask => Boolean(task));
}

/**
 * 路径归一化：统一分隔符、压掉重复斜杠与尾部斜杠、去掉 ./ 前缀。
 * 只做字面前缀比较，不解析 .. 与软链——授权判断宁可保守失败，也不在这里猜真实路径。
 */
function normalizePath(value: string): string {
	if (typeof value !== "string") return "";
	const cleaned = value.replace(/[\u0000-\u001F\u007F\u2028\u2029]/gu, "").replace(/\\+/gu, "/").trim();
	if (!cleaned) return "";
	let path = cleaned.replace(/\/{2,}/gu, "/");
	const absolute = path.startsWith("/");
	while (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
	while (path.startsWith("./")) path = path.slice(2);
	if (absolute && !path.startsWith("/")) path = `/${path}`;
	return path;
}

/** 去掉换行与控制字符，让一段外来文本只能占一行。 */
function oneLine(value: string, limit = 120): string {
	if (typeof value !== "string") return "";
	return value
		.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u2028\u2029]/gu, " ")
		.replace(/\s+/gu, " ")
		.trim()
		.slice(0, limit);
}

/**
 * 能否把消息发给对方：只回答会话可达性。
 * 自己发给自己、任一端不在名册里、任一端已 STOPPED，都返回 false。
 */
export function canMessage(source: MemberSource, fromId: string, toId: string): boolean {
	if (!fromId || !toId || fromId === toId) return false;
	const byId = new Map<string, ReachMember>();
	for (const member of memberList(source)) byId.set(member.id, member);
	const from = byId.get(fromId);
	const to = byId.get(toId);
	if (!from || !to) return false;
	return !isStopped(from) && !isStopped(to);
}

/**
 * 某成员此刻真正可写的路径：按任务取 packet.ownedPaths（运行时权威），
 * 旧结构或测试数据缺 packet 时回退到顶层 ownedPaths。已释放所有权的终态
 * （VERIFIED/CANCELED）不计入；去重并保持任务 id 顺序。
 */
export function authorityPaths(source: TaskSource, memberId: string): string[] {
	const paths: string[] = [];
	const seen = new Set<string>();
	for (const task of taskList(source)) {
		if (task.memberId !== memberId) continue;
		if (isReleased(task)) continue;
		const owned = task.packet?.ownedPaths ?? task.ownedPaths;
		if (!owned) continue;
		for (const raw of owned) {
			const path = normalizePath(raw);
			if (!path || seen.has(path)) continue;
			seen.add(path);
			paths.push(path);
		}
	}
	return paths;
}

/**
 * path 是否落在 ownedPaths 内。按目录前缀判定，所以授权 a/b 含 a/b 与 a/b/c，
 * 但不含 a/bc——多加一个字符就不是同一棵子树，这正是前缀判断最容易漏的边界。
 * 空路径一律 false；"." 或 "/" 视为整仓/整盘授权。
 */
export function pathWithinAuthority(path: string, ownedPaths: readonly string[]): boolean {
	const target = normalizePath(path);
	if (!target) return false;
	for (const owned of ownedPaths ?? []) {
		const grant = normalizePath(owned);
		if (!grant) continue;
		if (grant === "." || grant === "/") return true;
		if (target === grant) return true;
		if (target.startsWith(`${grant}/`)) return true;
	}
	return false;
}

/**
 * 一行中英混排注记：联系不授予写入权，并列出接收方本次实际可写路径。
 * 路径过多时只列前 6 条，剩下用「…另有 N 条见 TaskPacket」指回权威来源。
 */
export function reachNotice(fromId: string, toId: string, receiverPaths: readonly string[]): string {
	const paths: string[] = [];
	const seen = new Set<string>();
	for (const raw of receiverPaths ?? []) {
		const path = normalizePath(raw);
		if (!path || seen.has(path)) continue;
		seen.add(path);
		paths.push(path);
	}
	const head = `同伴联系 ${oneLine(fromId, 64)} → ${oneLine(toId, 64)}：仅表示可以发消息 (message allowed)，不授予写入权 (contact ≠ write authority)；`;
	if (paths.length === 0) {
		return `${head}接收方本次没有可写路径 (no owned paths in this TaskPacket)。`;
	}
	const shown = paths.slice(0, REACH_NOTICE_PATH_LIMIT).join("、");
	const hidden = paths.length - REACH_NOTICE_PATH_LIMIT;
	const listed = hidden > 0 ? `${shown}，…另有 ${hidden} 条见 TaskPacket` : shown;
	return `${head}接收方本次可写路径 (owned paths)：${listed}。`;
}
