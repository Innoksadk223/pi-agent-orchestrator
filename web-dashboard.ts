import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export const MAX_DASHBOARD_EVENT_BYTES = 8 * 1024;
export const VIEWER_READY_TIMEOUT_MS = 15_000;
export const VIEWER_HEARTBEAT_MS = 1_000;
export const VIEWER_HEARTBEAT_TIMEOUT_MS = 3_500;

const BIDI_CONTROLS = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu;
const TEXT_CONTROLS = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/gu;
const LOCAL_ADDRESSES = new Set(["127.0.0.1", "::ffff:127.0.0.1"]);

export interface DashboardMemberSpec {
	team: string;
	id: string;
	role: string;
	model: string;
	thinking: string;
	sessionId: string;
}

// Model catalogue entry shown in the Dashboard model switcher (parent Pi registry snapshot).
export interface DashboardModelRef {
	provider: string;
	id: string;
	name: string;
	contextWindow: number;
}

export type DashboardModelSwitch = (
	team: string,
	id: string,
	model: string,
	thinking: string,
) => Promise<{ ok: true; text?: string } | { ok: false; error: string }>;

export interface DashboardUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	turns: number;
	// current context occupancy snapshot (not cumulative; absent until the runtime reports it)
	contextWindow?: number;
	contextTokens?: number | null;
	contextPercent?: number | null;
}

export type DashboardEvent =
	| { type: "session"; model: string; sessionId: string }
	| { type: "task"; task: string }
	| { type: "assistant_text"; delta: string }
	// Final assistant text of the round, replace semantics: the runtime calibrates
	// the Dashboard mirror with the exact text wait will return (survives reconnects
	// and sparse streaming).
	| { type: "assistant_final"; text: string }
	| { type: "status"; status: string }
	| { type: "error"; message: string }
	| { type: "usage"; usage: DashboardUsage };

export interface DashboardLoss {
	reason: string;
}

export interface DashboardMemberHandle {
	readonly closed: Promise<DashboardLoss>;
	write(event: DashboardEvent): void;
	isOpen(): boolean;
}

export type DashboardVisibility = "VISIBLE" | "DETACHED" | "UNAVAILABLE";

export interface DashboardStatus {
	visibility: DashboardVisibility;
	note?: string;
}

export interface TeamDashboard {
	prepare(members: readonly DashboardMemberSpec[]): Promise<Map<string, DashboardMemberHandle>>;
	status(team: string, id: string, mode: string): DashboardStatus;
	closeMember(team: string, id: string): Promise<void>;
	// Refresh the displayed spec after a model/thinking switch for an existing member view.
	updateMember(team: string, id: string, spec: DashboardMemberSpec): void;
	// Publish the model catalogue for the model switcher (optional capability).
	setModels?(models: DashboardModelRef[]): void;
	shutdown(): Promise<void>;
}

export class DashboardUnavailableError extends Error {
	readonly code = "DASHBOARD_UNAVAILABLE";

	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "DashboardUnavailableError";
	}
}

interface MemberView {
	key: string;
	spec: DashboardMemberSpec;
	state: DashboardMemberState;
	handle: DashboardMemberHandle;
	closed: boolean;
	resolveClosed: (loss: DashboardLoss) => void;
}

export interface DashboardMemberState {
	task: string;
	assistant: string;
	assistantStarted: boolean;
	activities: Array<{ label: string; detail: string; at: number }>;
	usage: DashboardUsage;
	status: string;
	startedAt: number;
}

const MAX_ASSISTANT_CHARS = 100_000;
const MAX_ACTIVITIES = 120;

interface ReadySignal {
	promise: Promise<void>;
	resolve: () => void;
	reject: (error: Error) => void;
	settled: boolean;
}

interface WireMember {
	key: string;
	team: string;
	id: string;
	role: string;
	model: string;
	thinking: string;
	sessionId: string;
	state: DashboardMemberState;
}

type WireEvent = DashboardEvent;

export interface WebDashboardOptions {
	openBrowser(url: string): Promise<void>;
	readHtml?: () => Promise<string>;
	randomToken?: () => string;
	now?: () => number;
	readyTimeoutMs?: number;
	heartbeatTimeoutMs?: number;
	heartbeatPollMs?: number;
	// Per-member model/thinking switching from the page; the runtime wires this to
	// its own set-model path. Errors are returned to
	// the page for feedback, never thrown across the HTTP boundary.
	setMemberModel?: DashboardModelSwitch;
}

function memberKey(team: string, id: string): string {
	return `${team}\u0000${id}`;
}

function truncateUtf8(text: string, maxBytes: number): string {
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
	const suffix = "… [truncated]";
	const budget = Math.max(0, maxBytes - Buffer.byteLength(suffix, "utf8"));
	let prefix = Buffer.from(text, "utf8").subarray(0, budget).toString("utf8").replace(/\uFFFD+$/u, "");
	while (prefix && Buffer.byteLength(prefix + suffix, "utf8") > maxBytes) prefix = prefix.slice(0, -1);
	return prefix + suffix;
}

export function sanitizeDashboardText(value: unknown, maxBytes = MAX_DASHBOARD_EVENT_BYTES): string {
	const clean = String(value ?? "")
		.replace(/\r/gu, "")
		.replace(TEXT_CONTROLS, "")
		.replace(BIDI_CONTROLS, "");
	return truncateUtf8(clean, maxBytes);
}

export function dashboardEventsFromRpc(event: any): DashboardEvent[] {
	if (!event || typeof event !== "object") return [];
	if (event.type === "message_update") {
		const update = event.assistantMessageEvent;
		if (update?.type === "text_delta" && typeof update.delta === "string") {
			return [{ type: "assistant_text", delta: update.delta }];
		}
		if (update?.type === "error") {
			return [{ type: "error", message: String(update.errorMessage ?? update.reason ?? "assistant stream error") }];
		}
		return [];
	}
	if (event.type === "agent_start") return [{ type: "status", status: "RUNNING" }];
	if (event.type === "agent_settled") return [{ type: "status", status: "SETTLED" }];
	if (event.type === "auto_retry_start") {
		return [{ type: "status", status: `RETRY ${Number(event.attempt ?? 0)}/${Number(event.maxAttempts ?? 0)}` }];
	}
	if (event.type === "extension_error") {
		return [{ type: "error", message: String(event.error ?? "child extension error") }];
	}
	return [];
}

function applyMirror(state: DashboardMemberState, event: DashboardEvent): void {
	switch (event.type) {
		case "task":
			state.task = event.task;
			state.assistant = "";
			state.assistantStarted = false;
			state.activities = [];
			state.startedAt = Date.now();
			break;
		case "assistant_text":
			state.assistantStarted = true;
			state.assistant += event.delta;
			if (state.assistant.length > MAX_ASSISTANT_CHARS) {
				state.assistant = `… earlier output omitted\n${state.assistant.slice(-MAX_ASSISTANT_CHARS)}`;
			}
			break;
		case "assistant_final":
			// replace semantics: the runtime's final text is authoritative for this round
			state.assistant = event.text;
			state.assistantStarted = true;
			break;
		case "status":
			state.status = event.status;
			break;
		case "error":
			// only errors are mirrored into activities: the full activity timeline is a
			// frontend view concern, and errors are the entries worth restoring after a refresh.
			// keep the raw message; wireMember applies the display budget when serializing.
			state.activities.push({ label: "运行错误", detail: event.message, at: Date.now() });
			if (state.activities.length > MAX_ACTIVITIES) state.activities.splice(0, state.activities.length - MAX_ACTIVITIES);
			break;
		case "usage":
			state.usage = {
				input: state.usage.input + (Number(event.usage.input) || 0),
				output: state.usage.output + (Number(event.usage.output) || 0),
				cacheRead: state.usage.cacheRead + (Number(event.usage.cacheRead) || 0),
				cacheWrite: state.usage.cacheWrite + (Number(event.usage.cacheWrite) || 0),
				cost: state.usage.cost + (Number(event.usage.cost) || 0),
				turns: state.usage.turns + (Number(event.usage.turns) || 0),
			};
			// context snapshot replaces wholesale when present (contextWindow is always
			// provided by pi once known; tokens/percent may be null right after compaction)
			if (event.usage.contextWindow !== undefined) {
				state.usage.contextWindow = event.usage.contextWindow;
				state.usage.contextTokens = event.usage.contextTokens ?? null;
				state.usage.contextPercent = event.usage.contextPercent ?? null;
			}
			break;
	}
}

function wireMember(view: MemberView): WireMember {
	const spec = view.spec;
	return {
		key: memberKey(spec.team, spec.id),
		team: sanitizeDashboardText(spec.team, 128),
		id: sanitizeDashboardText(spec.id, 128),
		role: sanitizeDashboardText(spec.role, 512),
		model: sanitizeDashboardText(spec.model, 512),
		thinking: sanitizeDashboardText(spec.thinking, 64),
		sessionId: sanitizeDashboardText(spec.sessionId, 256),
		state: {
			task: sanitizeDashboardText(view.state.task, 4096),
			// the mirror truncates by UTF-16 chars (MAX_ASSISTANT_CHARS); the byte budget
			// below is *3 so CJK output is not cut further during serialization
			assistant: sanitizeDashboardText(view.state.assistant, MAX_ASSISTANT_CHARS * 3),
			assistantStarted: view.state.assistantStarted,
			activities: view.state.activities.map((activity) => ({
				label: sanitizeDashboardText(activity.label, 256),
				detail: sanitizeDashboardText(activity.detail, 1024),
				at: activity.at,
			})),
			usage: { ...view.state.usage },
			status: sanitizeDashboardText(view.state.status, 64),
			startedAt: view.state.startedAt,
		},
	};
}

function wireEvent(event: DashboardEvent): WireEvent {
	switch (event.type) {
		case "session":
			return {
				type: "session",
				model: sanitizeDashboardText(event.model, 512),
				sessionId: sanitizeDashboardText(event.sessionId, 256),
			};
		case "task":
			return { type: "task", task: sanitizeDashboardText(event.task) };
		case "assistant_text":
			return { type: "assistant_text", delta: sanitizeDashboardText(event.delta) };
		case "assistant_final":
			return { type: "assistant_final", text: sanitizeDashboardText(event.text, MAX_ASSISTANT_CHARS * 3) };
		case "status":
			return { type: "status", status: sanitizeDashboardText(event.status, 256) };
		case "error":
			return { type: "error", message: sanitizeDashboardText(event.message) };
		case "usage":
			return {
				type: "usage",
				usage: {
					input: Number(event.usage.input) || 0,
					output: Number(event.usage.output) || 0,
					cacheRead: Number(event.usage.cacheRead) || 0,
					cacheWrite: Number(event.usage.cacheWrite) || 0,
					cost: Number(event.usage.cost) || 0,
					turns: Number(event.usage.turns) || 0,
					contextWindow: event.usage.contextWindow,
					contextTokens: event.usage.contextTokens ?? null,
					contextPercent: event.usage.contextPercent ?? null,
				},
			};
	}
}

function createReadySignal(): ReadySignal {
	let resolve!: () => void;
	let reject!: (error: Error) => void;
	const signal: ReadySignal = {
		promise: new Promise<void>((resolvePromise, rejectPromise) => {
			resolve = resolvePromise;
			reject = rejectPromise;
		}),
		resolve: () => undefined,
		reject: () => undefined,
		settled: false,
	};
	signal.resolve = () => {
		if (signal.settled) return;
		signal.settled = true;
		resolve();
	};
	signal.reject = (error) => {
		if (signal.settled) return;
		signal.settled = true;
		reject(error);
	};
	void signal.promise.catch(() => undefined);
	return signal;
}

function securityHeaders(nonce: string): Record<string, string> {
	return {
		"Cache-Control": "no-store, max-age=0",
		Pragma: "no-cache",
		"Content-Security-Policy": [
			"default-src 'none'",
			`script-src 'nonce-${nonce}'`,
			`style-src 'nonce-${nonce}'`,
			"connect-src 'self'",
			"img-src 'self' data:",
			"font-src 'self'",
			"base-uri 'none'",
			"form-action 'none'",
			"frame-ancestors 'none'",
			"object-src 'none'",
		].join("; "),
		"Referrer-Policy": "no-referrer",
		"X-Content-Type-Options": "nosniff",
		"X-Frame-Options": "DENY",
		"Cross-Origin-Resource-Policy": "same-origin",
		"Cross-Origin-Opener-Policy": "same-origin",
		"Permissions-Policy": "camera=(), microphone=(), geolocation=(), usb=()",
	};
}

export class WebDashboard implements TeamDashboard {
	private readonly openBrowser: (url: string) => Promise<void>;
	private readonly readHtml: () => Promise<string>;
	private readonly randomToken: () => string;
	private readonly now: () => number;
	private readonly readyTimeoutMs: number;
	private readonly heartbeatTimeoutMs: number;
	private readonly heartbeatPollMs: number;
	private readonly setMemberModel?: DashboardModelSwitch;
	private readonly members = new Map<string, MemberView>();
	private models: DashboardModelRef[] = [];
	private htmlTemplate?: string;
	private server?: Server;
	private origin?: string;
	private basePath?: string;
	private nonce?: string;
	private viewerResponse?: ServerResponse;
	private viewerReady = false;
	private viewerVisible = false;
	private lastHeartbeat = 0;
	private viewerNote?: string;
	private readySignal?: ReadySignal;
	private heartbeatTimer?: NodeJS.Timeout;
	private browserOpened = false;
	private closingRuntime = false;
	private cleanupPromise?: Promise<void>;

	constructor(options: WebDashboardOptions) {
		this.openBrowser = options.openBrowser;
		this.readHtml = options.readHtml ?? (() => readFile(new URL("./web-dashboard.html", import.meta.url), "utf8"));
		this.randomToken = options.randomToken ?? (() => randomBytes(32).toString("hex"));
		this.now = options.now ?? Date.now;
		this.readyTimeoutMs = options.readyTimeoutMs ?? VIEWER_READY_TIMEOUT_MS;
		this.heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? VIEWER_HEARTBEAT_TIMEOUT_MS;
		this.heartbeatPollMs = options.heartbeatPollMs ?? Math.min(VIEWER_HEARTBEAT_MS, 500);
		this.setMemberModel = options.setMemberModel;
	}

	async prepare(members: readonly DashboardMemberSpec[]): Promise<Map<string, DashboardMemberHandle>> {
		if (this.cleanupPromise) await this.cleanupPromise;
		const createdRuntime = !this.server;
		const createdKeys: string[] = [];
		try {
			if (!this.server) await this.startRuntime();
			for (const spec of members) {
				const key = memberKey(spec.team, spec.id);
				if (!this.members.has(key)) {
					this.members.set(key, this.createMember(spec));
					createdKeys.push(key);
				}
			}
			if (createdKeys.length > 0) this.send({ kind: "members", members: createdKeys.map((key) => wireMember(this.members.get(key)!)) });
			// Reopen only when no viewer is attached at all: a live SSE response means the
			// page (or its EventSource reconnection) is still around, so detach states like
			// hidden tabs or heartbeat gaps must reuse the existing page instead of opening
			// a new one. When the SSE connection is fully gone, prepare re-opens the SAME
			// runtime URL and re-handshakes on the next dispatch.
			if (!this.browserOpened || (!this.viewerReady && !this.viewerResponse)) {
				this.browserOpened = true;
				// A fresh readiness signal is required: the previous one already resolved
				// for the old viewer and would make waitForViewer return before the new
				// page has handshaken.
				this.readySignal = createReadySignal();
				await this.openBrowser(`${this.origin}${this.basePath}/`);
				await this.waitForViewer();
			}
			const handles = new Map<string, DashboardMemberHandle>();
			for (const spec of members) {
				const key = memberKey(spec.team, spec.id);
				const view = this.members.get(key);
				if (!view || view.closed || !view.handle.isOpen()) {
					throw new Error(`Dashboard view is unavailable for ${spec.team}/${spec.id}.`);
				}
				handles.set(key, view.handle);
			}
			return handles;
		} catch (error) {
			if (createdRuntime) await this.closeRuntime("dashboard preparation failed", false);
			else {
				for (const key of createdKeys) this.removeMember(key, "dashboard preparation rolled back");
			}
			if (error instanceof DashboardUnavailableError) throw error;
			throw new DashboardUnavailableError(
				`DASHBOARD_UNAVAILABLE: ${error instanceof Error ? error.message : String(error)}`,
				{ cause: error },
			);
		}
	}

	status(team: string, id: string, mode: string): DashboardStatus {
		if (mode !== "tui") return { visibility: "UNAVAILABLE", note: `Web Dashboard not used in ${mode} mode` };
		const view = this.members.get(memberKey(team, id));
		if (!view || view.closed) return { visibility: "UNAVAILABLE", note: "Web Dashboard not started" };
		if (this.viewerReady && this.viewerVisible && this.viewerResponse) return { visibility: "VISIBLE" };
		return { visibility: "DETACHED", note: this.viewerNote ?? "Web Dashboard viewer reconnecting" };
	}

	async closeMember(team: string, id: string): Promise<void> {
		if (this.cleanupPromise) await this.cleanupPromise;
		const key = memberKey(team, id);
		if (!this.members.has(key)) return;
		this.send({ kind: "remove", memberKey: key });
		this.removeMember(key, "member stopped");
		if (this.members.size === 0) await this.closeRuntime("last member stopped", true);
	}

		setModels(models: DashboardModelRef[]): void {
			// Keep the catalogue bounded and sanitized; publish it so the page can render
			// the model switcher even when the page was already open.
			this.models = models
				.map((model) => ({
					provider: sanitizeDashboardText(model.provider, 128),
					id: sanitizeDashboardText(model.id, 256),
					name: sanitizeDashboardText(model.name, 256),
					contextWindow: Number(model.contextWindow) || 0,
				}))
				.filter((model) => model.provider && model.id);
			this.send({ kind: "models", models: this.models });
		}

	updateMember(team: string, id: string, spec: DashboardMemberSpec): void {
		const key = memberKey(team, id);
		const view = this.members.get(key);
		if (!view || view.closed) return;
		view.spec = { ...spec };
		this.send({ kind: "members", members: [wireMember(view)] });
	}

	async shutdown(): Promise<void> {
		if (this.cleanupPromise) return this.cleanupPromise;
		this.cleanupPromise = this.closeRuntime("dashboard shutdown", true).finally(() => {
			this.cleanupPromise = undefined;
		});
		return this.cleanupPromise;
	}

	private createMember(spec: DashboardMemberSpec): MemberView {
		const key = memberKey(spec.team, spec.id);
		let resolveClosed!: (loss: DashboardLoss) => void;
		const closed = new Promise<DashboardLoss>((resolve) => {
			resolveClosed = resolve;
		});
		const state: DashboardMemberState = {
			task: "",
			assistant: "",
			assistantStarted: false,
			activities: [],
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
			status: "APPROVED",
			startedAt: Date.now(),
		};
		const view = {} as MemberView;
		const handle: DashboardMemberHandle = {
			closed,
			write: (event) => {
				if (!view.closed && this.members.get(key) === view) {
					applyMirror(state, event);
					this.send({ kind: "event", memberKey: key, event: wireEvent(event) });
				}
			},
			isOpen: () => !view.closed && this.members.get(key) === view,
		};
		Object.assign(view, { key, spec: { ...spec }, state, handle, closed: false, resolveClosed });
		return view;
	}

	private async startRuntime(): Promise<void> {
		this.htmlTemplate ??= await this.readHtml();
		if (!this.htmlTemplate.includes("__CSP_NONCE__")) throw new Error("Dashboard HTML has no CSP nonce placeholder.");
		const token = this.randomToken();
		if (!/^[a-fA-F0-9]{64,}$/u.test(token)) throw new Error("Dashboard token generator returned insufficient entropy.");
		this.nonce = randomBytes(18).toString("base64");
		this.basePath = `/${token}`;
		this.readySignal = createReadySignal();
		const server = createServer((request, response) => void this.route(request, response));
		server.requestTimeout = 5_000;
		server.headersTimeout = 5_000;
		server.keepAliveTimeout = 1_000;
		this.server = server;
		try {
			await new Promise<void>((resolve, reject) => {
				const onError = (error: Error) => {
					server.off("listening", onListening);
					reject(error);
				};
				const onListening = () => {
					server.off("error", onError);
					resolve();
				};
				server.once("error", onError);
				server.once("listening", onListening);
				server.listen(0, "127.0.0.1");
			});
			const address = server.address();
			if (!address || typeof address === "string" || address.address !== "127.0.0.1" || address.port <= 0) {
				throw new Error("Dashboard server did not bind an IPv4 loopback random port.");
			}
			this.origin = `http://127.0.0.1:${address.port}`;
			server.unref();
			this.startHeartbeatMonitor();
		} catch (error) {
			await this.closeRuntime("dashboard server startup failed", false);
			throw error;
		}
	}

	private async waitForViewer(): Promise<void> {
		if (this.viewerReady) return;
		const signal = this.readySignal;
		if (!signal) throw new Error("Dashboard readiness signal is unavailable.");
		let timer: NodeJS.Timeout | undefined;
		try {
			await Promise.race([
				signal.promise,
				new Promise<never>((_resolve, reject) => {
					// Deliberately NOT unref'd: an unreferenced timer lets the event loop exit
					// while this wait is pending, hanging the caller (e.g. a node test or a
					// quiet parent process) instead of failing after readyTimeoutMs.
					timer = setTimeout(
						() => reject(new DashboardUnavailableError("DASHBOARD_UNAVAILABLE: browser viewer was not visible before timeout.")),
						this.readyTimeoutMs,
					);
				}),
			]);
		} finally {
			if (timer) clearTimeout(timer);
		}
	}

	private route(request: IncomingMessage, response: ServerResponse): void {
		const nonce = this.nonce ?? "invalid";
		const headers = securityHeaders(nonce);
		for (const [name, value] of Object.entries(headers)) response.setHeader(name, value);
		response.setHeader("Connection", "close");
		const remoteAddress = request.socket.remoteAddress ?? "";
		const expectedHost = this.origin?.slice("http://".length);
		if (!LOCAL_ADDRESSES.has(remoteAddress) || !expectedHost || request.headers.host !== expectedHost) {
			this.respond(response, 403, "Forbidden");
			return;
		}
		const url = new URL(request.url ?? "/", this.origin);
		const base = this.basePath;
		if (!base || (url.pathname !== base && !url.pathname.startsWith(`${base}/`))) {
			this.respond(response, 404, "Not found");
			return;
		}
		if ((url.pathname === base || url.pathname === `${base}/`) && request.method === "GET") {
			response.statusCode = 200;
			response.setHeader("Content-Type", "text/html; charset=utf-8");
			response.end(this.htmlTemplate!.replaceAll("__CSP_NONCE__", nonce));
			return;
		}
		if (url.pathname === `${base}/events`) {
			if (request.method !== "GET") {
				this.methodNotAllowed(response, "GET");
				return;
			}
			if (!this.sameOrigin(request, true)) {
				this.respond(response, 403, "Forbidden");
				return;
			}
			this.openEventStream(response);
			return;
		}
		if (url.pathname === `${base}/viewer`) {
			if (request.method !== "POST") {
				this.methodNotAllowed(response, "POST");
				return;
			}
			if (!this.sameOrigin(request, false)) {
				this.respond(response, 403, "Forbidden");
				return;
			}
			this.readViewerState(request, response);
			return;
		}
		if (url.pathname === `${base}/model`) {
			if (request.method !== "POST") {
				this.methodNotAllowed(response, "POST");
				return;
			}
			if (!this.sameOrigin(request, false)) {
				this.respond(response, 403, "Forbidden");
				return;
			}
			this.switchMemberModel(request, response);
			return;
		}
		this.respond(response, 404, "Not found");
	}

	private sameOrigin(request: IncomingMessage, allowMissing: boolean): boolean {
		const origin = request.headers.origin;
		return origin === this.origin || (allowMissing && origin === undefined);
	}

	private openEventStream(response: ServerResponse): void {
		if (this.viewerResponse && !this.viewerResponse.writableEnded && !this.viewerResponse.destroyed) {
			this.respond(response, 409, "Viewer already connected");
			return;
		}
		response.statusCode = 200;
		response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
		response.setHeader("Connection", "keep-alive");
		response.setHeader("X-Accel-Buffering", "no");
		response.flushHeaders();
		this.viewerResponse = response;
		this.send({ kind: "bootstrap", members: [...this.members.values()].map((view) => wireMember(view)), models: this.models });
		response.on("close", () => {
			if (this.closingRuntime || this.viewerResponse !== response) return;
			this.viewerResponse = undefined;
			this.markViewerDetached("SSE viewer reconnecting");
		});
		this.markReadyIfVisible();
	}

	/**
	 * Per-member model/thinking switch from the page. The runtime callback performs
	 * live RPC verification plus persistence; failures return as JSON feedback.
	 */
	private switchMemberModel(request: IncomingMessage, response: ServerResponse): void {
		if (!this.setMemberModel) {
			this.respondJson(response, 200, { ok: false, error: "Model switching is not available in this runtime." });
			return;
		}
		let body = "";
		request.setEncoding("utf8");
		request.on("data", (chunk: string) => {
			body += chunk;
			if (body.length > 512) request.destroy();
		});
		request.on("error", () => {
			if (!response.headersSent) this.respondJson(response, 400, { ok: false, error: "Invalid request" });
		});
		request.on("end", () => {
			let parsed: unknown;
			try {
				parsed = JSON.parse(body);
			} catch {
				this.respondJson(response, 400, { ok: false, error: "Invalid JSON body" });
				return;
			}
			const team = (parsed as Record<string, unknown>)?.team;
			const id = (parsed as Record<string, unknown>)?.id;
			const model = (parsed as Record<string, unknown>)?.model;
			const thinking = (parsed as Record<string, unknown>)?.thinking;
			if (typeof team !== "string" || typeof id !== "string" || typeof model !== "string" || typeof thinking !== "string") {
				this.respondJson(response, 400, { ok: false, error: "team, id, model, and thinking are required." });
				return;
			}
			void this.setMemberModel?.(
				sanitizeDashboardText(team, 128),
				sanitizeDashboardText(id, 128),
				sanitizeDashboardText(model, 512),
				sanitizeDashboardText(thinking, 64),
			)
				.then((result) => this.respondJson(response, 200, result))
				.catch((error) => {
					this.respondJson(response, 200, {
						ok: false,
						error: error instanceof Error ? error.message : String(error),
					});
				});
		});
	}

	private respondJson(response: ServerResponse, statusCode: number, payload: unknown): void {
		response.statusCode = statusCode;
		response.setHeader("Content-Type", "application/json; charset=utf-8");
		response.end(JSON.stringify(payload));
	}

	private readViewerState(request: IncomingMessage, response: ServerResponse): void {
		let body = "";
		request.setEncoding("utf8");
		request.on("data", (chunk: string) => {
			body += chunk;
			if (body.length > 256) request.destroy();
		});
		request.on("end", () => {
			const state = body.trim().replace(/^"|"$/gu, "");
			if (state === "visible") {
				this.viewerVisible = true;
				this.lastHeartbeat = this.now();
				response.statusCode = 204;
				response.end();
				this.markReadyIfVisible();
				return;
			}
			if (["hidden", "pagehide", "disconnected"].includes(state)) {
				response.statusCode = 204;
				response.end();
				this.markViewerDetached(`viewer reported ${state}`);
				return;
			}
			this.respond(response, 400, "Invalid viewer state");
		});
		request.on("error", () => {
			if (!response.headersSent) this.respond(response, 400, "Invalid request");
		});
	}

	private markReadyIfVisible(): void {
		if (this.viewerReady || !this.viewerResponse || !this.viewerVisible) return;
		this.viewerReady = true;
		this.viewerNote = undefined;
		this.readySignal?.resolve();
	}

	private markViewerDetached(reason: string): void {
		this.viewerReady = false;
		this.viewerVisible = false;
		this.lastHeartbeat = 0;
		this.viewerNote = sanitizeDashboardText(reason, 256);
	}

	private startHeartbeatMonitor(): void {
		if (this.heartbeatTimer || this.heartbeatPollMs <= 0) return;
		this.heartbeatTimer = setInterval(() => {
			if (!this.viewerReady || this.closingRuntime) return;
			if (!this.viewerResponse || this.now() - this.lastHeartbeat > this.heartbeatTimeoutMs) {
				this.markViewerDetached("viewer heartbeat timed out");
			}
		}, this.heartbeatPollMs);
		this.heartbeatTimer.unref?.();
	}

	private send(payload: unknown): void {
		const response = this.viewerResponse;
		if (!response || response.writableEnded || response.destroyed) return;
		response.write(`data: ${JSON.stringify(payload)}\n\n`);
	}

	private removeMember(key: string, reason: string): void {
		const view = this.members.get(key);
		if (!view) return;
		this.members.delete(key);
		if (!view.closed) {
			view.closed = true;
			view.resolveClosed({ reason });
		}
	}

	private async closeRuntime(reason: string, notify: boolean): Promise<void> {
		if (this.closingRuntime) return;
		this.closingRuntime = true;
		if (notify) this.send({ kind: "shutdown", reason: sanitizeDashboardText(reason, 256) });
		this.readySignal?.reject(new DashboardUnavailableError(`DASHBOARD_UNAVAILABLE: ${reason}`));
		if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
		this.heartbeatTimer = undefined;
		for (const key of [...this.members.keys()]) this.removeMember(key, reason);
		const response = this.viewerResponse;
		this.viewerResponse = undefined;
		if (response && !response.writableEnded) response.end();
		const server = this.server;
		this.server = undefined;
		if (server) {
			await new Promise<void>((resolve) => {
				server.close(() => resolve());
				server.closeIdleConnections?.();
				setTimeout(() => server.closeAllConnections?.(), 250).unref?.();
			});
		}
		this.origin = undefined;
		this.basePath = undefined;
		this.nonce = undefined;
		this.readySignal = undefined;
		this.viewerReady = false;
		this.viewerVisible = false;
		this.lastHeartbeat = 0;
		this.viewerNote = undefined;
		this.browserOpened = false;
		this.closingRuntime = false;
	}

	private respond(response: ServerResponse, statusCode: number, text: string): void {
		response.statusCode = statusCode;
		response.setHeader("Content-Type", "text/plain; charset=utf-8");
		response.end(text);
	}

	private methodNotAllowed(response: ServerResponse, allow: string): void {
		response.setHeader("Allow", allow);
		this.respond(response, 405, "Method not allowed");
	}
}
