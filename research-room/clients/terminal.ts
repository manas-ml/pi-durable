#!/usr/bin/env node
// Thin terminal client: renders SSE snapshots, sends lines as input. Holds no agent state.
// Usage: ROOM_TOKEN=... node clients/terminal.ts [url]      Lines starting with "!" steer instead of queueing; "/abort" aborts.
import { createInterface } from "node:readline";

const base = process.argv[2] ?? process.env.ROOM_URL ?? "http://127.0.0.1:4790";
const token = process.env.ROOM_TOKEN ?? "";
const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };

const post = async (path: string, body: unknown): Promise<void> => {
	const response = await fetch(`${base}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
	if (!response.ok) console.log(`! ${path}: ${response.status} ${await response.text()}`);
};

const printed = new Set<string>();
let lastTasks = "";
const label = { user: "you", assistant: "agent", tool: "tool", other: "?" } as const;

function render(snapshot: {
	entries: { id: string; role: keyof typeof label; text: string }[];
	tasks: { kind: string; status: string }[];
	notices: { id: number; message: string }[];
	busy: boolean;
}): void {
	for (const entry of snapshot.entries) {
		if (printed.has(entry.id) || entry.text === "") continue;
		printed.add(entry.id);
		console.log(`\n[${label[entry.role]}] ${entry.text}`);
	}
	const live = snapshot.tasks.filter((t) => t.status !== "terminal").map((t) => t.kind);
	const line = `${snapshot.busy ? "busy" : "idle"}${live.length ? ` | tasks: ${live.join(", ")}` : ""}`;
	if (line !== lastTasks) console.log(`  (${(lastTasks = line)})`);
}

const response = await fetch(`${base}/events`, { headers });
if (!response.ok || response.body === null) throw new Error(`cannot attach: HTTP ${response.status}`);
console.log(`attached to ${base}. Type a message; "!text" steers, "/abort" aborts.`);

const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
	const text = line.trim();
	if (text === "/abort") void post("/abort", {});
	else if (text.startsWith("!")) void post("/submit", { text: text.slice(1).trim(), whenBusy: "steer" });
	else if (text !== "") void post("/submit", { text, whenBusy: "followUp" });
});

const decoder = new TextDecoder();
let buffer = "";
for await (const chunk of response.body) {
	buffer += decoder.decode(chunk, { stream: true });
	let end: number;
	while ((end = buffer.indexOf("\n\n")) >= 0) {
		const frame = buffer.slice(0, end);
		buffer = buffer.slice(end + 2);
		const data = frame.split("\n").find((l) => l.startsWith("data: "));
		if (data !== undefined) render(JSON.parse(data.slice(6)));
	}
}
console.log("server closed the stream; rerun to reattach.");
