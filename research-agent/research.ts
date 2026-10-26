import { Type } from "@earendil-works/pi-ai";
import {
	AssistantEntry,
	type ConversationId,
	configure,
	defineExtension,
	defineTask,
	defineTool,
	section,
} from "@earendil-works/pi-durable";
import { fetchPageText, searchWeb } from "./tools/web.ts";

// ─── web tools: read-only, so a call cut off by a crash simply runs again ───

const webSearch = defineTool({
	name: "web_search",
	description: "Search the web for a query. Returns titles, urls and snippets. Call several in parallel.",
	parameters: Type.Object({ query: Type.String() }),
	replay: "safe",
	execute: async (args, api, context) => {
		api.output(`searching: ${args.query}\n`);
		const hits = await searchWeb(args.query, context.abortSignal);
		if (hits.length === 0) api.output("- no results\n");
		for (const hit of hits) api.output(`- ${hit.title} (${hit.url}): ${hit.snippet}\n`);
		return {};
	},
});

const fetchPage = defineTool({
	name: "fetch_page",
	description: "Fetch a web page and return its text, truncated. Call several in parallel.",
	parameters: Type.Object({ url: Type.String() }),
	replay: "safe",
	execute: async (args, api, context) => {
		api.output(`fetching: ${args.url}\n`);
		api.output(`${await fetchPageText(args.url, context.abortSignal)}\n`);
		return {};
	},
});

/** What the research subagent gets: only the web tools. */
export const Search = defineExtension({ name: "research-web", tools: [webSearch, fetchPage] });

// ─── research: a background subagent that reports back ──────────────────────

type ResearchState = { phase: "deliver" } | { phase: "report"; report: string };

/** Delivers the task to its subagent and posts the report to the main conversation as a new message. */
const Brief = defineTask<{ task: string }, ResearchState, null>({
	name: "research.brief",
	version: 1,
	initial: () => ({ phase: "deliver" }),
	phases: {
		deliver: async (task, runtime, context) => {
			// The subagent's conversation is owned by this task. No Session call may run inside a commit.
			let owned: ConversationId | undefined;
			await runtime.commit(async (tx) => {
				owned = (await tx.scanConversations({ ownerTaskId: task.id }, 1)).items[0]?.id;
				return undefined;
			}, context);
			const child = await runtime.conversation(owned!, context);
			// A rerun after a crash gets the same submission back.
			const request = { type: "input", content: task.input.task, requestId: `research:${task.id}` } as const;
			const settled = await (await child!.submit(request, context)).wait(context);
			await runtime.commit(async (tx) => {
				let report = `[research report] The research failed: ${settled.status === "unanswered" ? settled.reason : "?"}`;
				if (settled.status === "done" && settled.type === "input") {
					const message = (await tx.entry(AssistantEntry, settled.answer))?.model?.[0];
					const text =
						message?.role === "assistant"
							? message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("")
							: "";
					report = `[research report] ${text}`;
				}
				return { status: "running", checkpoint: { phase: "report", report } };
			}, context);
		},
		report: async (task, runtime, context) => {
			const main = await runtime.conversation(runtime.conversationId, context);
			const report = { type: "input", content: task.state.checkpoint.report, whenBusy: "followUp" } as const;
			await main!.submit({ ...report, requestId: `research-report:${task.id}` }, context);
			await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), context);
		},
	},
	abort: (_task, runtime, context) =>
		runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
});

const research = defineTool({
	name: "research",
	description:
		"Start a research subagent in the background. It searches while you keep talking with the user; its report arrives later as a message starting with [research report].",
	parameters: Type.Object({ task: Type.String({ description: "The topic or question to research, with any constraints" }) }),
	execute: async (args, api, context) => {
		await api.commit(async (tx) => {
			// Background: the main conversation stays free while the research runs.
			const owner = await tx.createTask(
				Brief,
				{ task: args.task },
				{ ownership: { kind: "conversation" }, background: true },
			);
			const child = await tx.createConversation({ ownership: { kind: "task", taskId: owner } });
			await configure(tx, child.id, {
				extensions: [Search],
				instructions:
					"You are a research subagent. Break the task into 2-4 queries, run web_search for them in parallel in one step, fetch the most relevant pages in parallel, then report a short brief of bullet points, each with its source url.",
			});
		}, context);
		return { content: [{ type: "text", text: "Research started in the background." }] };
	},
});

/** What the main conversation gets: the prompt, `research`, and the task that delivers its report. */
export const Researcher = defineExtension({
	name: "researcher",
	tools: [research],
	tasks: [Brief],
	sections: [
		section(
			"preamble",
			() =>
				"You are a research assistant. Keep answers short. Hand all research to the research tool; while it runs, keep chatting with the user. When a [research report] arrives, summarize it with its sources.",
			{ tag: false },
		),
	],
});
