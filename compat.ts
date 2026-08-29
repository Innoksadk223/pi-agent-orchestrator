import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import * as PiCore from "@earendil-works/pi-coding-agent";

export const MIN_PI_VERSION = "0.82.1";
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

export interface RpcClientLike {
	start(): Promise<void>;
	stop(): Promise<void>;
	onEvent(listener: (event: any) => void): () => void;
	prompt(message: string): Promise<void>;
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

export interface PersistentMemberOptions {
	team: string;
	id: string;
	role: string;
	instructions: string;
	sessionId: string;
	model: { provider: string; id: string };
	thinking: string;
	tools: string[];
	cwd: string;
	trusted: boolean;
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
			"Fixed instructions:",
			member.instructions,
			"",
			"Follow only the current runtime dispatch and its local TaskPacket or review/expert targets.",
			"Do not consult legacy team files, other members, the parent roster, global plan, or parent conversation history.",
			"Do not create or coordinate agents and do not use agent_team; the leader alone dispatches work.",
		].join("\n");
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
			if (member.tools.length > 0) args.push("--tools", member.tools.join(","));
			// S2-10: isolate the child from the user's other extensions and skills
			// (e.g. pi-model-cycler could silently change the member's model or
			// behavior); the member prompt is fully carried by --append-system-prompt.
			args.push("--no-extensions", "--no-skills", member.trusted ? "--approve" : "--no-approve", "--append-system-prompt", promptPath);
			const client = this.factory({
				cliPath,
				cwd: member.cwd,
				env: { PI_AGENT_TEAM_MEMBER: "1" },
				provider: member.model.provider,
				model: member.model.id,
				args,
			});
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
