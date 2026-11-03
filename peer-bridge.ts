import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
	MAX_PEER_BODY_BYTES,
	PEER_PATH,
	PEER_REQUEST_TIMEOUT_MS,
	PEER_TOKEN_HEADER,
} from "./peer-protocol.ts";

export interface PeerIdentity {
	team: string;
	member: string;
}

export interface PeerReply {
	status: number;
	body: unknown;
}

/** 传输层只负责校验与转发；业务路由（授权、限额、投递）由 runtime 决定。 */
export type PeerRequestHandler = (
	identity: PeerIdentity,
	payload: Record<string, unknown>,
) => Promise<PeerReply>;

export interface PeerBridge {
	readonly url: string;
	/** 为成员签发令牌；同一成员旧令牌立即失效。 */
	issue(team: string, member: string): string;
	revokeAll(): void;
	close(): Promise<void>;
}

/**
 * 只监听 127.0.0.1 的随机端口，仅接受严格 POST/JSON。不依赖 Dashboard、浏览器或
 * UI 模式：没有网页时成员依然可以互通；父会话关闭时 close() 释发端口与连接。
 */
export async function startPeerBridge(handler: PeerRequestHandler): Promise<PeerBridge> {
	const tokens = new Map<string, PeerIdentity>();
	const server = createServer((request, response) => {
		void serve(request, response);
	});
	server.on("clientError", (_error, socket) => socket.destroy());
	await new Promise<void>((resolve, reject) => {
		const onError = (error: Error) => reject(error);
		server.once("error", onError);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", onError);
			resolve();
		});
	});
	const address = server.address();
	if (!address || typeof address === "string") {
		server.close();
		throw new Error("Peer bridge could not bind a loopback port.");
	}
	const url = `http://127.0.0.1:${address.port}${PEER_PATH}`;

	const reply = (response: ServerResponse, status: number, body: unknown): void => {
		const text = JSON.stringify(body);
		response.writeHead(status, {
			"content-type": "application/json",
			"content-length": Buffer.byteLength(text),
		});
		response.end(text);
	};

	const readBody = (request: IncomingMessage): Promise<string | "TOO_LARGE"> =>
		new Promise((resolve) => {
			const declared = Number(request.headers["content-length"]);
			if (Number.isFinite(declared) && declared > MAX_PEER_BODY_BYTES) {
				resolve("TOO_LARGE");
				return;
			}
			let size = 0;
			let overflow = false;
			const chunks: Buffer[] = [];
			request.on("data", (chunk: Buffer) => {
				if (overflow) return;
				size += chunk.length;
				if (size > MAX_PEER_BODY_BYTES) {
					overflow = true;
					chunks.length = 0;
					return;
				}
				chunks.push(chunk);
			});
			request.on("end", () => resolve(overflow ? "TOO_LARGE" : Buffer.concat(chunks).toString("utf8")));
			request.on("error", () => resolve("TOO_LARGE"));
		});

	async function serve(request: IncomingMessage, response: ServerResponse): Promise<void> {
		request.setTimeout(PEER_REQUEST_TIMEOUT_MS, () => request.destroy());
		if ((request.url ?? "").split("?")[0] !== PEER_PATH) {
			reply(response, 404, { error: "Unknown peer endpoint." });
			return;
		}
		if (request.method !== "POST") {
			reply(response, 405, { error: "The peer endpoint accepts POST only." });
			return;
		}
		const header = request.headers[PEER_TOKEN_HEADER];
		const token = Array.isArray(header) ? header[0] : header;
		const identity = token ? tokens.get(token) : undefined;
		if (!identity) {
			reply(response, 401, { error: "Unknown or missing peer token." });
			return;
		}
		const body = await readBody(request);
		if (body === "TOO_LARGE") {
			reply(response, 413, { error: "Peer request body is too large." });
			return;
		}
		let payload: unknown;
		try {
			payload = JSON.parse(body);
		} catch {
			reply(response, 400, { error: "Peer request body must be JSON." });
			return;
		}
		if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
			reply(response, 400, { error: "Peer request body must be a JSON object." });
			return;
		}
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const result = await Promise.race([
				handler(identity, payload as Record<string, unknown>),
				new Promise<never>((_resolve, reject) => {
					timer = setTimeout(
						() => reject(new Error(`Peer request timed out after ${PEER_REQUEST_TIMEOUT_MS}ms.`)),
						PEER_REQUEST_TIMEOUT_MS,
					);
				}),
			]);
			reply(response, result.status, result.body);
		} catch (error) {
			reply(response, 500, { error: error instanceof Error ? error.message : String(error) });
		} finally {
			clearTimeout(timer);
		}
	}

	return {
		url,
		issue(team, member) {
			for (const [existing, identity] of tokens) {
				if (identity.team === team && identity.member === member) tokens.delete(existing);
			}
			const token = randomBytes(24).toString("hex");
			tokens.set(token, { team, member });
			return token;
		},
		revokeAll() {
			tokens.clear();
		},
		async close() {
			tokens.clear();
			await new Promise<void>((resolve) => {
				server.close(() => resolve());
				server.closeAllConnections();
			});
		},
	};
}
