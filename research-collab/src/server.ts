#!/usr/bin/env node
// research-collab: one durable research agent, many people steering it from the browser.
import { mkdir, readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createModels } from "@earendil-works/pi-ai/models";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { Auth, type Identity } from "./auth.ts";
import { openRoom } from "./room.ts";

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = resolve(here, "../public");
const dataDir = resolve(process.env.ROOM_DATA_DIR ?? join(here, "../data"));
const port = Number(process.env.ROOM_PORT ?? 4790);
const host = process.env.ROOM_HOST ?? "127.0.0.1";
const MAX_BODY = 16 * 1024;
const MAX_TEXT = 4000;
const MAX_STREAMS = 100;

const models = createModels();
models.setProvider(openrouterProvider());
models.setProvider(anthropicProvider());
const [provider, ...rest] = (process.env.ROOM_MODEL ?? "openrouter/qwen/qwen3.8-27b").split("/");
const model = { provider: provider!, modelId: rest.join("/") };

await mkdir(dataDir, { recursive: true });
const auth = await Auth.open(dataDir, process.env.ROOM_HOST_NAME ?? "Host", process.env.ROOM_HOST_TOKEN);
const room = await openRoom({ dataDir, models, model });

interface Stream {
	readonly response: ServerResponse;
	readonly who: Identity;
}
const streams = new Set<Stream>();
const presence = (): { name: string; role: string }[] => {
	const seen = new Map<string, { name: string; role: string }>();
	for (const { who } of streams) seen.set(who.id, { name: who.name, role: who.role });
	return [...seen.values()];
};
const frame = (event: string, data: unknown): string => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const broadcast = (event: string, data: unknown): void => {
	const payload = frame(event, data);
	for (const { response } of streams) response.write(payload);
};

let lastSent = 0;
let timer: NodeJS.Timeout | undefined;
room.subscribe(() => {
	// At most about 10 snapshots a second; the trailing one is always sent.
	if (timer !== undefined) return;
	timer = setTimeout(
		() => {
			timer = undefined;
			lastSent = Date.now();
			broadcast("snapshot", room.snapshot());
		},
		Math.max(0, 100 - (Date.now() - lastSent)),
	);
});
// Proxies drop idle streams; a comment line keeps them open.
setInterval(() => {
	for (const { response } of streams) response.write(": keepalive\n\n");
}, 20_000).unref();

const TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".svg": "image/svg+xml",
	".json": "application/json",
};

async function serveStatic(pathname: string, response: ServerResponse): Promise<boolean> {
	const relative = normalize(decodeURIComponent(pathname === "/" ? "/index.html" : pathname)).replace(/^[/\\]+/, "");
	const file = resolve(publicDir, relative);
	if (file !== publicDir && !file.startsWith(publicDir + sep)) return false;
	try {
		const body = await readFile(file);
		response.writeHead(200, {
			"content-type": TYPES[extname(file)] ?? "application/octet-stream",
			"cache-control": "no-cache",
			"x-content-type-options": "nosniff",
		});
		response.end(body);
		return true;
	} catch {
		return false;
	}
}

const json = (response: ServerResponse, status: number, body: unknown): void => {
	response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(body));
};

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of request) {
		size += (chunk as Buffer).length;
		if (size > MAX_BODY) throw new HttpError(413, "request too large");
		chunks.push(chunk as Buffer);
	}
	if (chunks.length === 0) return {};
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
	} catch {
		throw new HttpError(400, "invalid JSON");
	}
}

class HttpError extends Error {
	readonly status: number;
	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

const tokenOf = (request: IncomingMessage, url: URL): string | undefined =>
	request.headers.authorization?.replace(/^Bearer /u, "") ?? url.searchParams.get("token") ?? undefined;

const server = createServer(async (request, response) => {
	const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
	try {
		if (!url.pathname.startsWith("/api/")) {
			if (request.method === "GET" && (await serveStatic(url.pathname, response))) return;
			return json(response, 404, { error: "not found" });
		}
		const who = auth.identify(tokenOf(request, url));
		if (who === undefined) return json(response, 401, { error: "invalid or missing invite token" });
		const route = `${request.method} ${url.pathname}`;

		if (route === "GET /api/me") return json(response, 200, who);
		if (route === "GET /api/state") return json(response, 200, { snapshot: room.snapshot(), presence: presence() });
		if (route === "GET /api/events") {
			if (streams.size >= MAX_STREAMS) return json(response, 503, { error: "too many viewers" });
			response.writeHead(200, {
				"content-type": "text/event-stream",
				"cache-control": "no-cache, no-transform",
				connection: "keep-alive",
				"x-accel-buffering": "no",
			});
			const stream: Stream = { response, who };
			response.write(frame("snapshot", room.snapshot())); // late join: current state first
			streams.add(stream);
			broadcast("presence", presence());
			request.on("close", () => {
				streams.delete(stream);
				broadcast("presence", presence());
			});
			return;
		}
		if (request.method === "POST" && url.pathname === "/api/submit") {
			if (who.role === "viewer") return json(response, 403, { error: "viewers cannot send messages" });
			const body = await readJson(request);
			const text = typeof body.text === "string" ? body.text.trim() : "";
			if (text === "") return json(response, 400, { error: "text is required" });
			if (text.length > MAX_TEXT) return json(response, 400, { error: `text is limited to ${MAX_TEXT} characters` });
			await room.submit(who.name, text, body.steer === true ? "steer" : "followUp");
			return json(response, 202, { accepted: true });
		}
		if (request.method === "POST" && url.pathname === "/api/abort") {
			if (who.role !== "host") return json(response, 403, { error: "only the host can abort" });
			await room.abort();
			return json(response, 202, { accepted: true });
		}
		if (who.role === "host" && route === "GET /api/invites") return json(response, 200, auth.list());
		if (who.role === "host" && route === "POST /api/invites") {
			const body = await readJson(request);
			const name = typeof body.name === "string" ? body.name.trim().replace(/[[\]\r\n]/gu, "") : "";
			const role = body.role === "viewer" ? "viewer" : "editor";
			if (name === "" || name.length > 40) return json(response, 400, { error: "name must be 1-40 characters" });
			return json(response, 201, await auth.create(name, role));
		}
		if (who.role === "host" && route === "POST /api/invites/revoke") {
			const body = await readJson(request);
			return json(response, 200, { revoked: await auth.revoke(String(body.id ?? "")) });
		}
		if (url.pathname.startsWith("/api/invites")) return json(response, 403, { error: "host only" });
		return json(response, 404, { error: "not found" });
	} catch (error) {
		if (error instanceof HttpError) return json(response, error.status, { error: error.message });
		console.error(error);
		json(response, 500, { error: "internal error" });
	}
});

server.listen(port, host, () => {
	console.log(`research-collab on http://${host}:${port}  (model ${model.provider}/${model.modelId})`);
	console.log(`host sign-in:  http://${host}:${port}/#invite=${auth.hostToken}`);
	console.log(`data: ${dataDir}`);
});

let closing = false;
const shutdown = async (): Promise<void> => {
	if (closing) return;
	closing = true;
	for (const { response } of streams) response.end();
	server.close();
	await room.close();
	process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
