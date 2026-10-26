#!/usr/bin/env node
// One durable research agent behind HTTP. Clients hold no state: they read snapshots over SSE and POST commands.
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { type DurableView, openDurable } from "../research-agent/runtime.ts";

interface EntryLine {
	readonly id: string;
	readonly role: "user" | "assistant" | "tool" | "other";
	readonly text: string;
}

/** What clients render. A reduced projection of the DurableView, so clients stay small and the wire stays JSON. */
export interface Snapshot {
	readonly conversationId: string;
	readonly busy: boolean;
	readonly partial: string;
	readonly entries: readonly EntryLine[];
	readonly tools: readonly { name: string; status: string; output: string }[];
	readonly tasks: readonly { id: string; kind: string; owner?: string; status: string }[];
	readonly conversations: readonly { id: string; label: string; title?: string }[];
	readonly notices: readonly { id: number; level: string; message: string }[];
}

const ROLES = { user: "user", assistant: "assistant", toolResult: "tool" } as const;

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.flatMap((part: { type?: string; text?: string; name?: string }) =>
			part.type === "text" ? [part.text ?? ""] : part.type === "toolCall" ? [`[tool call: ${part.name}]`] : [],
		)
		.join("");
}

export function project(view: DurableView): Snapshot {
	const conversation = view.conversation;
	const entries: EntryLine[] = [];
	for (const entry of conversation.entries) {
		const message = entry.model?.[0];
		if (message === undefined) continue;
		const role = ROLES[message.role as keyof typeof ROLES] ?? "other";
		entries.push({ id: String(entry.id), role, text: textOf(message.content) });
	}
	const live = (conversation.docs["pi.live"] ?? {}) as {
		run?: unknown;
		generation?: { message?: { content?: unknown } };
		tools?: { name?: string; status?: string; output?: string }[];
	};
	const graph = view.tasks === undefined ? [] : Object.values(view.tasks.tasks);
	return {
		conversationId: String(conversation.conversation.id),
		busy: live.run !== undefined,
		partial: textOf(live.generation?.message?.content),
		entries,
		tools: (live.tools ?? []).map((tool) => ({
			name: tool.name ?? "?",
			status: tool.status ?? "?",
			output: tool.output ?? "",
		})),
		tasks: graph.map((node) => ({
			id: String(node.id),
			kind: node.kind,
			...(node.owner === undefined ? {} : { owner: String(node.owner) }),
			status: node.state.status,
		})),
		conversations: view.conversations.map((c) => ({ id: String(c.id), label: c.label, ...(c.title ? { title: c.title } : {}) })),
		notices: view.notices,
	};
}

const operatorToken = process.env.ROOM_TOKEN ?? randomBytes(12).toString("hex");
const viewerToken = process.env.ROOM_VIEWER_TOKEN ?? randomBytes(12).toString("hex");
const port = Number(process.env.ROOM_PORT ?? 4790);
const host = process.env.ROOM_HOST ?? "127.0.0.1";

const durable = await openDurable({ continueSession: process.argv.includes("--continue") });
let snapshot = project(durable.view.current());
const clients = new Set<ServerResponse>();
let lastSent = 0;
let timer: NodeJS.Timeout | undefined;
const send = (response: ServerResponse): void => void response.write(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`);
const broadcast = (): void => {
	lastSent = Date.now();
	for (const client of clients) send(client);
};
durable.view.subscribe(() => {
	snapshot = project(durable.view.current());
	// At most about 10 snapshots a second; the trailing one is always sent.
	if (timer !== undefined) return;
	timer = setTimeout(
		() => {
			timer = undefined;
			broadcast();
		},
		Math.max(0, 100 - (Date.now() - lastSent)),
	);
});

type Role = "operator" | "viewer";
function authorize(request: IncomingMessage, url: URL): Role | undefined {
	const header = request.headers.authorization?.replace(/^Bearer /, "");
	const token = header ?? url.searchParams.get("token") ?? undefined;
	if (token === operatorToken) return "operator";
	if (token === viewerToken) return "viewer";
	return undefined;
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) chunks.push(chunk as Buffer);
	return chunks.length === 0 ? {} : (JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
}

const lastAnswer = (s: Snapshot): string => s.entries.findLast((e) => e.role === "assistant" && e.text !== "")?.text ?? "";

/** Resolves when the main conversation and every task are quiet for two checks in a row. */
async function waitQuiet(timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	let quiet = 0;
	while (Date.now() < deadline) {
		const s = snapshot;
		const working = s.busy || s.tasks.some((t) => t.status !== "terminal");
		quiet = working ? 0 : quiet + 1;
		if (quiet >= 2) return true;
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
	return false;
}

const json = (response: ServerResponse, status: number, body: unknown): void => {
	response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
};

const server = createServer(async (request, response) => {
	const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
	try {
		if (request.method === "GET" && url.pathname === "/") {
			response
				.writeHead(200, { "content-type": "text/html" })
				.end(await readFile(new URL("./clients/browser.html", import.meta.url)));
			return;
		}
		const role = authorize(request, url);
		if (role === undefined) return json(response, 401, { error: "missing or wrong token" });
		if (request.method === "GET" && url.pathname === "/state") return json(response, 200, snapshot);
		if (request.method === "GET" && url.pathname === "/events") {
			response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
			send(response); // late join: the current state first, then changes
			clients.add(response);
			request.on("close", () => clients.delete(response));
			return;
		}
		if (request.method !== "POST") return json(response, 404, { error: "not found" });
		if (role !== "operator") return json(response, 403, { error: "viewer tokens are read-only" });
		const body = await readJson(request);
		if (url.pathname === "/submit") {
			const text = String(body.text ?? "").trim();
			if (text === "") return json(response, 400, { error: "text is required" });
			await durable.controller.submit(text, body.whenBusy === "steer" ? "steer" : "followUp");
			return json(response, 202, { accepted: true });
		}
		if (url.pathname === "/ask") {
			const text = String(body.text ?? "").trim();
			if (text === "") return json(response, 400, { error: "text is required" });
			await durable.controller.submit(text, "followUp");
			const done = await waitQuiet(Number(body.timeoutMs ?? 300_000));
			return json(response, done ? 200 : 504, { done, answer: lastAnswer(snapshot) });
		}
		if (url.pathname === "/abort") {
			await durable.controller.abort();
			return json(response, 202, { accepted: true });
		}
		if (url.pathname === "/switch") {
			await durable.controller.switchConversation(String(body.id) as never);
			return json(response, 202, { accepted: true });
		}
		return json(response, 404, { error: "not found" });
	} catch (error) {
		json(response, 500, { error: error instanceof Error ? error.message : String(error) });
	}
});

server.listen(port, host, () => {
	console.log(`research-room on http://${host}:${port}`);
	console.log(`operator token: ${operatorToken}`);
	console.log(`viewer token:   ${viewerToken}`);
	console.log(`browser: http://${host}:${port}/#token=${operatorToken}`);
});

let closing = false;
const shutdown = async (): Promise<void> => {
	if (closing) return;
	closing = true;
	for (const client of clients) client.end();
	server.close();
	// Close writes no outcome: a running turn resumes with --continue.
	await durable.close();
	process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
