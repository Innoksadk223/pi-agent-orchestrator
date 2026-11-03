import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import * as PiCore from "@earendil-works/pi-coding-agent";
import {
	PEER_MARKER_ENV,
	PEER_TOKEN_ENV,
	PEER_TOOL_NAME,
	PEER_URL_ENV,
} from "./peer-protocol.ts";
import { loadMemberCapabilities, type CapabilityLoadOptions, type MemberCapabilities } from "./member-capabilities.ts";

/**
 * 身份块里唯一一句运行时边界，也是稳定段的一部分（可进缓存前缀）：
 * 信封与验收由每次派发给出，成员不得自己派工、不得使用 agent_team。
 * 这句话只能出现在这里——派发提示词不再重复，测试按字面计数锁死。
 */
export const MEMBER_IDENTITY_RULE =
	"The dispatch and its TaskPacket carry the report envelope and acceptance; the leader alone dispatches work and members never use agent_team.";

export const MIN_PI_VERSION = "0.82.1";
// -e builtin:<name> and --no-extensions covering built-in extensions landed in 0.99.0.
const BUILTIN_EXTENSION_MIN_VERSION = "0.99.0";
export const TESTED_PI_MINOR = "0.82";

export interface RpcStats {
	assistantMessages: number;
	tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
	cost: number;
	// transparent passthrough of pi SessionStats.contextUsage (current context occupancy)
	contextUsage?: { tokens: number | null; contextWindow: number; percent: number | null };
}

// Transparent passthrough of pi CompactionResult (subset of fields the runtime
// records as before/after metrics; extra pi fields are ignored).
export interface CompactionResultLike {
	summary: string;
	firstKeptEntryId: string;
	tokensBefore: number;
	estimatedTokensAfter?: number;
}

export interface PromptOptionsLike {
	preflightResult?: (success: boolean) => void;
}

export interface RpcClientLike {
	start(): Promise<void>;
	stop(): Promise<void>;
	onEvent(listener: (event: any) => void): () => void;
	prompt(message: string, options?: PromptOptionsLike): Promise<void>;
	waitForIdle(timeout?: number): Promise<void>;
	abort(): Promise<void>;
	// Leader steer: passthrough of Pi's public RpcClient.steer (queue a steering
	// message that interrupts the agent mid-run). Optional so older/embedded
	// adapters without the public surface stay usable; runtime rejects steer when
	// the live client lacks it instead of faking steer/pause/resume RPCs.
	steer?(message: string): Promise<void>;
	// Runtime model/thinking switch, passthrough of Pi's public RpcClient methods.
	setModel(provider: string, modelId: string): Promise<unknown>;
	setThinkingLevel(level: string): Promise<void>;
	getState(): Promise<{
		sessionId: string;
		sessionName?: string;
		model?: string | { provider: string; id: string };
		thinkingLevel?: string;
	}>;
	setSessionName(name: string): Promise<void>;
	getSessionStats(): Promise<RpcStats>;
	getLastAssistantText(): Promise<string | null>;
	// Public context RPC surface. The orchestrator enables Pi native auto-compaction
	// and never reads session JSONL or invokes compact after member settlement.
	compact(customInstructions?: string): Promise<CompactionResultLike>;
	setAutoCompaction(enabled: boolean): Promise<void>;
}

export interface ClientOptions {
	cliPath: string;
	cwd: string;
	env?: Record<string, string>;
	provider?: string;
	model?: string;
	args?: string[];
}

/**
 * 成员互通通道：父进程本机入口 + 该成员专属临时令牌 + 成员扩展的绝对路径。
 * 由 runtime 在启动 child 前签发；没有通道时成员照常工作，只是没有 team_message。
 */
export interface MemberPeerChannel {
	url: string;
	token: string;
	extension: string;
	marker: string;
}

export interface PersistentMemberOptions {
	team: string;
	id: string;
	role: string;
	instructions: string;
	headPrompt?: string;
	tailPrompt?: string;
	sessionId: string;
	model: { provider: string; id: string };
	thinking: string;
	tools: string[];
	cwd: string;
	trusted: boolean;
	// 只有 coder 角色默认拿到 MCP；只读角色要显式列 mcp__* 才开，避免静默扩权。
	allowMcpTools?: boolean;
	peer?: MemberPeerChannel;
}

export interface MemberClientHandle {
	client: RpcClientLike;
	cleanupPrompt(): Promise<void>;
	// true when the child resumed an existing session file (--session-id was passed)
	restored: boolean;
}

export type RpcClientFactory = (options: ClientOptions) => RpcClientLike;

export interface CompatibilityReport {
	ok: boolean;
	code: string;
	message: string;
	piVersion?: string;
	cliPath?: string;
	doctorRequired: boolean;
	doctorPassed?: boolean;
}

export class CompatibilityError extends Error {
	readonly report: CompatibilityReport;

	constructor(report: CompatibilityReport, message = report.message) {
		super(message);
		this.report = report;
	}
}

export interface AdapterOverrides {
	version?: string;
	getPackageDir?: (() => string) | null;
	factory?: RpcClientFactory | null;
	cliPath?: string;
	// session existence probe override (defaults to the real SessionManager.list)
	listSessions?: ((cwd: string) => Promise<Array<{ id: string }>>) | null;
	// member capability discovery; tests point agentDir at a temporary directory
	capabilityOptions?: CapabilityLoadOptions;
}

function parseVersion(value: string): [number, number, number] | undefined {
	const match = /^(\d+)\.(\d+)\.(\d+)/.exec(value);
	return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

function compareVersions(a: string, b: string): number {
	const av = parseVersion(a);
	const bv = parseVersion(b);
	if (!av || !bv) return Number.NaN;
	for (let i = 0; i < 3; i++) {
		if (av[i] !== bv[i]) return av[i] - bv[i];
	}
	return 0;
}

function defaultFactory(): RpcClientFactory | undefined {
	const Constructor = (PiCore as Record<string, unknown>).RpcClient as
		| (new (options: ClientOptions) => RpcClientLike)
		| undefined;
	return typeof Constructor === "function" ? (options) => new Constructor(options) : undefined;
}

function defaultListSessions(): (cwd: string) => Promise<Array<{ id: string }>> | undefined {
	const SessionManager = (PiCore as Record<string, unknown>).SessionManager as
		| { list(cwd: string, sessionDir?: string): Promise<Array<{ id: string }>> }
		| undefined;
	return typeof SessionManager?.list === "function"
		? (cwd) => SessionManager.list(cwd)
		: undefined;
}

export class PiCompatibilityAdapter {
	readonly version: string | undefined;
	private readonly getPackageDir: (() => string) | undefined;
	private readonly factory: RpcClientFactory | undefined;
	private readonly fixedCliPath: string | undefined;
	private readonly listSessions: ((cwd: string) => Promise<Array<{ id: string }>>) | undefined;
	private readonly capabilityOptions: CapabilityLoadOptions;
	private cachedCliPath: string | undefined;
	private doctorPassedForVersion: string | undefined;

	constructor(overrides: AdapterOverrides = {}) {
		this.version = overrides.version ?? ((PiCore as Record<string, unknown>).VERSION as string | undefined);
		this.getPackageDir =
			overrides.getPackageDir === null
				? undefined
				: (overrides.getPackageDir ??
					((PiCore as Record<string, unknown>).getPackageDir as (() => string) | undefined));
		this.factory = overrides.factory === null ? undefined : (overrides.factory ?? defaultFactory());
		this.fixedCliPath = overrides.cliPath;
		this.listSessions =
			overrides.listSessions === null ? undefined : (overrides.listSessions ?? defaultListSessions());
		this.capabilityOptions = overrides.capabilityOptions ?? {};
	}

	/**
	 * 成员能力：本地插件按白名单显式加载，MCP 全开。配置/目录问题只进 diagnostics，
	 * 任何失败都退化为「不带额外能力」，绝不阻塞成员启动。
	 */
	private async memberCapabilities(): Promise<MemberCapabilities> {
		try {
			const capabilities = await loadMemberCapabilities(this.capabilityOptions);
			if (capabilities.mcp && !this.supportsBuiltinExtensions()) {
				capabilities.mcp = false;
				capabilities.diagnostics.push(
					`builtin:mcp requires Pi >= ${BUILTIN_EXTENSION_MIN_VERSION} (running ${this.version ?? "unknown"}); skipped`,
				);
			}
			return capabilities;
		} catch (error) {
			return { mcp: false, extensions: [], diagnostics: [String(error)] };
		}
	}

	private supportsBuiltinExtensions(): boolean {
		if (!this.version) return false;
		const comparison = compareVersions(this.version, BUILTIN_EXTENSION_MIN_VERSION);
		return !Number.isNaN(comparison) && comparison >= 0;
	}

	async resolveCliPath(): Promise<string> {
		if (this.cachedCliPath) return this.cachedCliPath;
		if (this.fixedCliPath) return (this.cachedCliPath = resolve(this.fixedCliPath));
		if (!this.getPackageDir) throw new Error("Pi root export getPackageDir is unavailable.");
		const packageDir = this.getPackageDir();
		const manifestPath = join(packageDir, "package.json");
		const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { bin?: string | Record<string, string> };
		const binValue = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.pi;
		if (!binValue) throw new Error(`Pi package manifest has no pi bin entry: ${manifestPath}`);
		const cliPath = isAbsolute(binValue) ? binValue : resolve(dirname(manifestPath), binValue);
		await readFile(cliPath);
		return (this.cachedCliPath = cliPath);
	}

	async featureCheck(capabilities: { appendEntry: boolean; getBranch: boolean }): Promise<CompatibilityReport> {
		if (!this.version || !parseVersion(this.version)) {
			return this.failure("PI_VERSION_UNKNOWN", "Pi VERSION root export is missing or invalid.");
		}
		if (compareVersions(this.version, MIN_PI_VERSION) < 0) {
			return this.failure("PI_VERSION_TOO_OLD", `Pi ${this.version} is below the ${MIN_PI_VERSION} baseline.`);
		}
		if (!this.factory) return this.failure("RPC_CLIENT_MISSING", "Pi root export RpcClient is unavailable.");
		const SessionManager = (PiCore as Record<string, unknown>).SessionManager as
			| { create?: (cwd: string, sessionDir?: string, options?: { id?: string }) => any }
			| undefined;
		if (typeof SessionManager?.create !== "function") {
			return this.failure("SESSION_MANAGER_MISSING", "Pi root export SessionManager.create is unavailable.");
		}
		if (!capabilities.appendEntry) {
			return this.failure("APPEND_ENTRY_MISSING", "Extension API appendEntry is unavailable.");
		}
		if (!capabilities.getBranch) {
			return this.failure("BRANCH_API_MISSING", "Session branch API getBranch is unavailable.");
		}
		try {
			const cliPath = await this.resolveCliPath();
			return {
				ok: true,
				code: "COMPATIBLE",
				message: `Pi ${this.version} public features are available.`,
				piVersion: this.version,
				cliPath,
				doctorRequired: !this.version.startsWith(`${TESTED_PI_MINOR}.`),
				doctorPassed: this.doctorPassedForVersion === this.version,
			};
		} catch (error) {
			return this.failure("CLI_NOT_FOUND", error instanceof Error ? error.message : String(error));
		}
	}

	async ensureCompatible(
		cwd: string,
		capabilities: { appendEntry: boolean; getBranch: boolean },
	): Promise<CompatibilityReport> {
		const report = await this.featureCheck(capabilities);
		if (!report.ok) throw new CompatibilityError(report);
		if (report.doctorRequired && this.doctorPassedForVersion !== this.version) return this.doctor(cwd, capabilities);
		return report;
	}

	async doctor(
		cwd: string,
		capabilities: { appendEntry: boolean; getBranch: boolean },
	): Promise<CompatibilityReport> {
		const preflight = await this.featureCheck(capabilities);
		if (!preflight.ok) throw new CompatibilityError(preflight);
		if (!this.factory || !preflight.cliPath || !this.version) throw new CompatibilityError(preflight);

		const sessionDir = await mkdtemp(join(tmpdir(), "pi-agent-team-doctor-"));
		const sessionId = randomUUID();
		const sessionName = `pi-agent-team-doctor-${randomUUID()}`;
		const SessionManager = (PiCore as Record<string, unknown>).SessionManager as {
			create(cwd: string, sessionDir?: string, options?: { id?: string }): {
				appendMessage(message: unknown): string;
				appendSessionInfo(name: string): string;
			};
		};
		const seed = SessionManager.create(cwd, sessionDir, { id: sessionId });
		seed.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "Temporary no-LLM compatibility marker." }],
			api: "openai-responses",
			provider: "pi-agent-team-doctor",
			model: "no-llm",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		});
		seed.appendSessionInfo("pi-agent-team-doctor-seed");

		const args = [
			"--session-dir",
			sessionDir,
			"--session-id",
			sessionId,
			"--no-tools",
			"--no-skills",
			"--no-extensions",
			"--no-context-files",
			"--no-approve",
		];
		let first: RpcClientLike | undefined;
		let second: RpcClientLike | undefined;
		try {
			first = this.factory({ cliPath: preflight.cliPath, cwd, args });
			await first.start();
			const firstState = await first.getState();
			if (firstState.sessionId !== sessionId) {
				throw new Error(`Requested ${sessionId}, received ${firstState.sessionId}.`);
			}
			await first.setSessionName(sessionName);
			await first.stop();
			first = undefined;

			second = this.factory({ cliPath: preflight.cliPath, cwd, args });
			await second.start();
			const restored = await second.getState();
			if (restored.sessionId !== sessionId || restored.sessionName !== sessionName) {
				throw new Error(
					`Session restore mismatch: id=${restored.sessionId}, name=${restored.sessionName ?? "<none>"}.`,
				);
			}
			this.doctorPassedForVersion = this.version;
			return {
				...preflight,
				code: "DOCTOR_OK",
				message: `Pi ${this.version} restored temporary session ${sessionId} without an LLM call.`,
				doctorPassed: true,
			};
		} catch (error) {
			throw new CompatibilityError(
				this.failure("DOCTOR_FAILED", error instanceof Error ? error.message : String(error), preflight.cliPath),
			);
		} finally {
			await Promise.allSettled([first?.stop(), second?.stop()].filter(Boolean) as Promise<void>[]);
			await rm(sessionDir, { recursive: true, force: true });
		}
	}

	async createMemberClient(member: PersistentMemberOptions): Promise<MemberClientHandle> {
		const cliPath = await this.resolveCliPath();
		const promptDir = await mkdtemp(join(tmpdir(), "pi-agent-team-prompt-"));
		const promptPath = join(promptDir, "system-prompt.md");
		const prompt = [
			"You are a member of a Pi Agent Team led by the main Pi (the leader).",
			`Team: ${member.team} | Member: ${member.id} | Role: ${member.role}`,
			"",
			"Member head prompt:",
			member.headPrompt,
			"",
			"Fixed instructions:",
			member.instructions,
			"",
			MEMBER_IDENTITY_RULE,
		].filter((line): line is string => Boolean(line)).join("\n");
		await writeFile(promptPath, prompt, { encoding: "utf8", mode: 0o600 });
		const cleanupPrompt = async () => {
			await rm(promptDir, { recursive: true, force: true });
		};
		try {
			if (!this.factory) throw new CompatibilityError(this.failure("RPC_CLIENT_MISSING", "RpcClient is unavailable."));
			const restored = await this.sessionExists(member.cwd, member.sessionId);
			// Only pass --session-id when a session file for that id already exists under
			// the member's cwd. Passing a fresh id makes the pi CLI print a stderr warning
			// ("No project session found with id '...'; creating a new session with that id.")
			// which the RpcClient forwards verbatim into the main Pi's terminal (TUI noise
			// next to the prompt input). On first launch pi assigns the id; the runtime
			// adopts the reported id (see ensureClient) so later runs resume that session.
			const args = [...(restored ? ["--session-id", member.sessionId] : []), "--thinking", member.thinking];
			const capabilities = await this.memberCapabilities();
			// 显式工具白名单在启动时追加互通工具:不改持久化的角色书/工具配置(configHash 不变),
			// 也不扩大成员原有授权(team_message 不是写工具)。
			if (member.tools.length > 0) {
				const tools = member.peer ? [...new Set([...member.tools, PEER_TOOL_NAME])] : [...member.tools];
				// 传了 --tools 时 Pi 只声明匹配条目的 MCP 工具；不给 mcp__* 通配，direct
				// 暴露的工具会留在注册表里但成员拿不到，MCP 等于白开。
				const wantsMcp = tools.some((tool) => tool.startsWith("mcp__"));
				if (capabilities.mcp && member.allowMcpTools === true && !wantsMcp) tools.push("mcp__*");
				args.push("--tools", tools.join(","));
			}
			// S2-10: isolate the child from the user's other extensions (e.g. pi-model-cycler
			// could silently change the member's model or behaviour); skills stay discoverable so
			// members can use the same reusable procedures as the main agent. The member prompt is
			// carried by --append-system-prompt.
			args.push("--no-extensions", member.trusted ? "--approve" : "--no-approve", "--append-system-prompt", promptPath);
			// 显式 -e 是 --no-extensions 下唯一放行路径：本地插件按白名单自动发现，
			// builtin:mcp 让成员读取 mcp.json 的全部 server，npm 包与危险扩展仍被隔离。
			for (const extension of capabilities.extensions) args.push("--extension", extension);
			if (capabilities.mcp) args.push("--extension", "builtin:mcp");
			// 互通只加载这一个显式扩展：--no-extensions 仍然隔离用户与项目扩展，
			// 显式 -e 路径是 Pi 文档保证的例外。
			if (member.peer) args.push("--extension", member.peer.extension);
			const rawClient = this.factory({
				cliPath,
				cwd: member.cwd,
				env: {
					PI_AGENT_TEAM_MEMBER: "1",
					...(member.peer
						? {
								[PEER_URL_ENV]: member.peer.url,
								[PEER_TOKEN_ENV]: member.peer.token,
								[PEER_MARKER_ENV]: member.peer.marker,
							}
						: {}),
				},
				provider: member.model.provider,
				model: member.model.id,
				args,
			});
			// Pi's RPC client accepts images as prompt's second argument, not prompt options.
			// Adapt the RPC acknowledgement to the orchestrator's preflight contract instead
			// of accidentally serializing { preflightResult } as an image payload.
			const client = new Proxy(rawClient, {
				get(target, property, receiver) {
					if (property !== "prompt") return Reflect.get(target, property, receiver);
					return async (message: string, options?: PromptOptionsLike) => {
						try {
							await target.prompt(message);
							options?.preflightResult?.(true);
						} catch (error) {
							options?.preflightResult?.(false);
							throw error;
						}
					};
				},
			}) as RpcClientLike;
			return { client, cleanupPrompt, restored };
		} catch (error) {
			await cleanupPrompt();
			throw error;
		}
	}

	/**
	 * Whether a session file for sessionId already exists under cwd (default session
	 * dir). Best-effort: a probe failure falls back to "not restored", which still
	 * avoids the stderr warning (pi then assigns a fresh id) at the cost of a new
	 * session. A custom sessionDir setting can also break the match; same fallback.
	 */
	private async sessionExists(cwd: string, sessionId: string): Promise<boolean> {
		if (!sessionId) return false;
		const list = this.listSessions;
		if (!list) return false;
		try {
			const sessions = await list(cwd);
			return sessions.some((session) => session.id === sessionId);
		} catch {
			return false;
		}
	}

	private failure(code: string, message: string, cliPath?: string): CompatibilityReport {
		return {
			ok: false,
			code,
			message,
			piVersion: this.version,
			cliPath,
			doctorRequired: true,
			doctorPassed: false,
		};
	}
}
