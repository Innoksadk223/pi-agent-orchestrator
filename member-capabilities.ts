/**
 * 成员能力白名单：本地插件自动发现 + 排除清单，MCP 全开。
 *
 * 成员 child 仍以 --no-extensions 启动，隔离用户与项目扩展；这里解析出的条目
 * 用显式 --extension 追加，所以新增/删除本地插件无需改代码，只要目录变了，
 * 下一次成员启动就生效。配置文件缺失或损坏时回退内置默认，不阻塞启动。
 */

import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const MEMBER_CAPABILITIES_FILE = "member-capabilities.json";

export interface MemberCapabilitiesConfig {
	mcp: boolean;
	plugins: {
		/** auto：加载发现到的全部本地扩展再减去 exclude；list：只加载 include。 */
		mode: "auto" | "list";
		include: string[];
		exclude: string[];
	};
}

/**
 * 默认排除的是三类：无头 RPC 下不渲染的 TUI 扩展、禁止成员加载的编排器本身、
 * 会给每条消息放音效的扩展，以及会自起 HTTP 服务并抢端口/弹浏览器的 artifacts。
 */
export const DEFAULT_MEMBER_CAPABILITIES: MemberCapabilitiesConfig = {
	mcp: true,
	plugins: {
		mode: "auto",
		include: [],
		exclude: [
			"styled-outputs",
			"footer",
			"spinners",
			"chat-input",
			"pi-agent-orchestrator",
			"message-sound",
			"artifacts",
		],
	},
};

export interface MemberCapabilities {
	/** true 时追加 --extension builtin:mcp，让成员读取 mcp.json 里的全部 server。 */
	mcp: boolean;
	/** 解析后的绝对路径，或原样保留的 npm: 包标识。 */
	extensions: string[];
	/** 配置回退、条目找不到等非致命问题；不写进成员提示词，仅供诊断。 */
	diagnostics: string[];
}

export interface CapabilityLoadOptions {
	/** 默认 getAgentDir()；测试注入临时目录以避开真实环境。 */
	agentDir?: string;
	/** 默认 <agentDir>/member-capabilities.json。 */
	configPath?: string;
}

const EXTENSION_SOURCE = /\.(?:ts|js|mjs|cjs|mts|cts)$/;
const ENTRY_FILES = ["index.ts", "index.js", "index.mjs", "index.mts", "index.cjs", "index.cts"];

function cloneDefaults(): MemberCapabilitiesConfig {
	return {
		mcp: DEFAULT_MEMBER_CAPABILITIES.mcp,
		plugins: {
			mode: DEFAULT_MEMBER_CAPABILITIES.plugins.mode,
			include: [...DEFAULT_MEMBER_CAPABILITIES.plugins.include],
			exclude: [...DEFAULT_MEMBER_CAPABILITIES.plugins.exclude],
		},
	};
}

function stringList(value: unknown): string[] | undefined {
	if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string" && entry.trim().length > 0)) {
		return undefined;
	}
	return value.map((entry) => entry.trim());
}

function normalizeConfig(raw: unknown, diagnostics: string[]): MemberCapabilitiesConfig {
	const config = cloneDefaults();
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		diagnostics.push("member capabilities: config must be a JSON object; using defaults");
		return config;
	}
	const record = raw as Record<string, unknown>;
	if (typeof record.mcp === "boolean") {
		config.mcp = record.mcp;
	} else if (record.mcp !== undefined) {
		diagnostics.push("member capabilities: \"mcp\" must be a boolean; using default true");
	}

	const plugins = record.plugins;
	if (plugins === undefined) return config;
	if (!plugins || typeof plugins !== "object" || Array.isArray(plugins)) {
		diagnostics.push("member capabilities: \"plugins\" must be an object; using defaults");
		return config;
	}
	const pluginRecord = plugins as Record<string, unknown>;
	if (pluginRecord.mode === "auto" || pluginRecord.mode === "list") {
		config.plugins.mode = pluginRecord.mode;
	} else if (pluginRecord.mode !== undefined) {
		diagnostics.push("member capabilities: \"plugins.mode\" must be \"auto\" or \"list\"; using default auto");
	}
	for (const key of ["include", "exclude"] as const) {
		if (pluginRecord[key] === undefined) continue;
		const list = stringList(pluginRecord[key]);
		if (list) {
			config.plugins[key] = list;
		} else {
			diagnostics.push(`member capabilities: "plugins.${key}" must be an array of names; using default`);
		}
	}
	return config;
}

async function readConfig(path: string, diagnostics: string[]): Promise<MemberCapabilitiesConfig> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== "ENOENT") {
			diagnostics.push(`member capabilities: cannot read ${path} (${code ?? "unknown error"}); using defaults`);
		}
		return cloneDefaults();
	}
	try {
		return normalizeConfig(JSON.parse(text), diagnostics);
	} catch {
		diagnostics.push(`member capabilities: ${path} is not valid JSON; using defaults`);
		return cloneDefaults();
	}
}

async function isFile(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isFile();
	} catch {
		return false;
	}
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

function normalizeName(value: string): string {
	return value.trim().toLowerCase();
}

/**
 * 一个路径可能命中的 deny list 名字：自身、去扩展名后的名字，以及 index.* 入口所在目录名。
 * 绝对路径 include 不能只比 basename，否则 Artifacts/index.ts 会因为 basename 是
 * index.ts 而绕过 exclude。
 */
function excludedCandidates(path: string): string[] {
	const base = basename(path);
	const candidates = [normalizeName(base)];
	const extension = extname(base);
	if (extension) candidates.push(normalizeName(basename(base, extension)));
	if (/^index\.[^.]+$/i.test(base)) candidates.push(normalizeName(basename(dirname(path))));
	return candidates;
}

interface DiscoveredExtension {
	name: string;
	path: string;
}

async function discoverExtensions(dir: string, diagnostics: string[]): Promise<DiscoveredExtension[]> {
	let entries;
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== "ENOENT") {
			diagnostics.push(`member capabilities: cannot scan ${dir} (${code ?? "unknown error"})`);
		}
		return [];
	}
	const found: DiscoveredExtension[] = [];
	for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
		if (entry.name.startsWith(".")) continue;
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			let hasEntry = false;
			for (const candidate of ENTRY_FILES) {
				if (await isFile(join(full, candidate))) {
					hasEntry = true;
					break;
				}
			}
			// 目录里没有扩展入口（assets 之类）就不是扩展，静默跳过。
			if (hasEntry) found.push({ name: entry.name, path: full });
		} else if (entry.isFile() && EXTENSION_SOURCE.test(entry.name)) {
			found.push({ name: basename(entry.name, extname(entry.name)), path: full });
		}
	}
	return found;
}

async function selectExtensions(
	discovered: DiscoveredExtension[],
	plugins: MemberCapabilitiesConfig["plugins"],
	extensionsDir: string,
	diagnostics: string[],
): Promise<string[]> {
	const selected: string[] = [];
	const push = (value: string) => {
		if (!selected.includes(value)) selected.push(value);
	};
	// 比较前统一 trim/lowercase：macOS 文件系统不区分大小写，尾随空格目录与大小写变体
	// 不应绕过 deny list。list 模式同样让 exclude 作为最终否决。
	const excluded = new Set(plugins.exclude.map(normalizeName));
	const isExcluded = (name: string, path: string) =>
		excluded.has(normalizeName(name)) || excludedCandidates(path).some((candidate) => excluded.has(candidate));

	if (plugins.mode === "list") {
		for (const entry of plugins.include) {
			if (entry.startsWith("npm:")) {
				const packagePath = entry.slice(4);
				if (excludedCandidates(packagePath).some((candidate) => excluded.has(candidate))) {
					diagnostics.push(`member capabilities: include entry "${entry}" is excluded`);
					continue;
				}
				// 包是否可用由 Pi 解析；这里无法离线校验，保留原条目。
				push(entry);
				continue;
			}
			if (isAbsolute(entry)) {
				// 软链可以把 Artifacts 包装成无害名字；先解析真实路径再跑 deny list，
				// 但传给 -e 的仍是原条目。
				const resolved = await realpath(entry).catch(() => entry);
				if (isExcluded(entry, entry) || (resolved !== entry && isExcluded(entry, resolved))) {
					diagnostics.push(`member capabilities: include entry "${entry}" is excluded`);
					continue;
				}
				// 直接传给 -e 的不存在路径会让 pi 以 Failed to load extension 退出，
				// 导致成员完全起不来；此处降级为跳过 + 诊断。
				if (!(await pathExists(entry))) {
					diagnostics.push(`member capabilities: include entry "${entry}" does not exist; skipped`);
					continue;
				}
				push(entry);
				continue;
			}
			const match = discovered.find(
				(candidate) => candidate.name === entry || basename(candidate.path) === entry,
			);
			if (!match) {
				diagnostics.push(`member capabilities: include entry "${entry}" not found under ${extensionsDir}`);
			} else if (isExcluded(match.name, match.path)) {
				diagnostics.push(`member capabilities: include entry "${entry}" is excluded`);
			} else {
				push(match.path);
			}
		}
		return selected;
	}
	for (const candidate of discovered) {
		if (isExcluded(candidate.name, candidate.path)) continue;
		push(candidate.path);
	}
	return selected;
}

/** 解析成员能力；配置与目录问题只进 diagnostics，永不抛错。 */
export async function loadMemberCapabilities(options: CapabilityLoadOptions = {}): Promise<MemberCapabilities> {
	const diagnostics: string[] = [];
	let agentDir: string;
	try {
		agentDir = options.agentDir ?? getAgentDir();
	} catch (error) {
		diagnostics.push(`member capabilities: cannot resolve agent directory (${String(error)}); using fallbacks`);
		return { mcp: DEFAULT_MEMBER_CAPABILITIES.mcp, extensions: [], diagnostics };
	}
	const configPath = options.configPath ?? join(agentDir, MEMBER_CAPABILITIES_FILE);
	const config = await readConfig(configPath, diagnostics);
	const extensionsDir = join(agentDir, "extensions");
	const discovered = await discoverExtensions(extensionsDir, diagnostics);
	const extensions = await selectExtensions(discovered, config.plugins, extensionsDir, diagnostics);
	return { mcp: config.mcp, extensions, diagnostics };
}
