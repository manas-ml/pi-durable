// The durable room: one Harness over SQLite, one shared conversation, and a plain-JSON snapshot for browsers.
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { AttachedReplicatedState } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { MutableModels } from "@earendil-works/pi-ai/models";
import {
	type Conversation,
	type ConversationView,
	createRegistry,
	Harness,
	type ModelRef,
	type TaskGraph,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { Researcher, Search } from "./agent.ts";

const context = BACKGROUND_CONTEXT;

export type EntryKind = "person" | "report" | "agent" | "tool";

export interface EntryLine {
	readonly id: string;
	readonly kind: EntryKind;
	readonly author?: string;
	readonly steering?: boolean;
	readonly text: string;
}

/** What browsers render: a reduced projection of the conversation, so the wire stays small and stable. */
export interface Snapshot {
	readonly busy: boolean;
	readonly partial: string;
	readonly entries: readonly EntryLine[];
	readonly tools: readonly { name: string; status: string; output: string }[];
	readonly tasks: readonly { id: string; kind: string; owner?: string; status: string }[];
	readonly model?: string;
	readonly notices: readonly { id: number; message: string }[];
}

export interface OpenRoomOptions {
	readonly dataDir: string;
	readonly models: MutableModels;
	readonly model: ModelRef;
}

export interface Room {
	snapshot(): Snapshot;
	subscribe(listener: () => void): () => void;
	/** Prompt when idle; otherwise steer or queue a follow-up. The author is stored in the message text. */
	submit(author: string, text: string, mode: "steer" | "followUp"): Promise<void>;
	abort(): Promise<void>;
	close(): Promise<void>;
}

const PERSON = /^\[([^\]]{1,40}?)( \(steering\))?\] ([\s\S]*)$/u;
const REPORT = "[research report]";

/** The line a person's message is stored as: the name is part of the durable text, so the model sees it too. */
export function attribute(author: string, text: string, mode: "steer" | "followUp"): string {
	return `[${author}${mode === "steer" ? " (steering)" : ""}] ${text}`;
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.flatMap((part: { type?: string; text?: string }) => (part.type === "text" ? [part.text ?? ""] : []))
		.join("");
}

function entryLine(id: string, role: string, text: string): EntryLine | undefined {
	if (role === "toolResult") return undefined;
	if (role === "assistant") return text === "" ? undefined : { id, kind: "agent", text };
	if (text.startsWith(REPORT)) return { id, kind: "report", text: text.slice(REPORT.length).trim() };
	const match = PERSON.exec(text);
	if (match) return { id, kind: "person", author: match[1]!, steering: match[2] !== undefined, text: match[3]! };
	return text === "" ? undefined : { id, kind: "person", author: "someone", text };
}

export function project(
	view: ConversationView,
	graph: TaskGraph | undefined,
	notices: Snapshot["notices"],
	model: string | undefined,
): Snapshot {
	const entries: EntryLine[] = [];
	for (const entry of view.entries) {
		const message = entry.model?.[0];
		if (message === undefined) continue;
		const line = entryLine(String(entry.id), message.role, textOf(message.content));
		if (line !== undefined) entries.push(line);
	}
	const live = (view.docs["pi.live"] ?? {}) as {
		run?: unknown;
		generation?: { message?: { content?: unknown } };
		tools?: { name?: string; status?: string; output?: string }[];
	};
	return {
		busy: live.run !== undefined,
		partial: textOf(live.generation?.message?.content),
		entries,
		tools: (live.tools ?? []).map((t) => ({ name: t.name ?? "?", status: t.status ?? "?", output: t.output ?? "" })),
		tasks: Object.values(graph?.tasks ?? {}).map((node) => ({
			id: String(node.id),
			kind: node.kind,
			...(node.owner === undefined ? {} : { owner: String(node.owner) }),
			status: node.state.status,
		})),
		...(model === undefined ? {} : { model }),
		notices,
	};
}

export async function openRoom(options: OpenRoomOptions): Promise<Room> {
	await mkdir(options.dataDir, { recursive: true });
	const registry = createRegistry();
	registry.install(Researcher);
	registry.install(Search);

	const notices: { id: number; message: string }[] = [];
	const report = (error: unknown): void => {
		notices.push({ id: notices.length + 1, message: error instanceof Error ? error.message : String(error) });
		notices.splice(0, Math.max(0, notices.length - 10));
		update();
	};
	const harness = await Harness.open(
		await openNodeSqliteStorage(join(options.dataDir, "room.sqlite")),
		{ models: options.models, registry, onReport: report },
		context,
	);
	const root: Conversation = await harness.root(context, {
		agent: { extensions: [Researcher], model: options.model },
	});
	const modelName = `${options.model.provider}/${options.model.modelId}`;

	const listeners = new Set<() => void>();
	let view: AttachedReplicatedState<ConversationView> = await root.viewState(context);
	let graph: AttachedReplicatedState<TaskGraph> = await harness.taskGraph(context);
	let current = project(view.value, graph.value, notices, modelName);
	let pending = false;
	function update(): void {
		current = project(view.value, graph.value, notices, modelName);
		if (pending) return;
		pending = true;
		setImmediate(() => {
			pending = false;
			for (const listener of listeners) listener();
		});
	}
	const stopView = view.subscribe(update);
	const stopGraph = graph.subscribe(update);
	// Recovered work from an interrupted turn continues now.
	harness.resume();

	let closing: Promise<void> | undefined;
	return {
		snapshot: () => current,
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		async submit(author, text, mode) {
			const submission = await root.submit(
				{ type: "input", content: attribute(author, text, mode), whenBusy: mode },
				context,
			);
			// A submission that ends without an answer (provider error, bad model, no credentials) must not vanish silently.
			void submission.wait(context).then((settled) => {
				if (settled.status === "unanswered" && settled.reason !== "aborted") {
					const detail = settled.detail === undefined ? "" : ` ${JSON.stringify(settled.detail)}`;
					report(new Error(`No answer: ${settled.reason}${detail}`));
				}
			}, report);
		},
		abort: () => root.abort(context),
		close() {
			closing ??= (async () => {
				stopView();
				stopGraph();
				view.dispose();
				graph.dispose();
				// Close writes no outcome: a running turn resumes on the next start.
				await harness.close(context);
			})();
			return closing;
		},
	};
}
