import assert from "node:assert/strict";
import { test } from "node:test";
import { attribute, project } from "../src/room.ts";

const view = (messages: { role: string; text: string }[]) =>
	({
		conversation: {},
		docs: {},
		entries: messages.map((m, i) => ({ id: i + 1, kind: "x", model: [{ role: m.role, content: m.text }] })),
	}) as never;

test("attribution is stored in the text and parsed back into author and steering", () => {
	const s = project(
		view([
			{ role: "user", text: attribute("Alice", "hello\nsecond line", "followUp") },
			{ role: "user", text: attribute("Bob", "stop that", "steer") },
		]),
		undefined,
		[],
		undefined,
	);
	assert.deepEqual(
		s.entries.map((e) => [e.kind, e.author, e.steering, e.text]),
		[
			["person", "Alice", false, "hello\nsecond line"],
			["person", "Bob", true, "stop that"],
		],
	);
});

test("research reports and agent answers are not shown as people; tool results are hidden", () => {
	const s = project(
		view([
			{ role: "user", text: "[research report] # Findings" },
			{ role: "assistant", text: "Here you go" },
			{ role: "toolResult", text: "raw tool output" },
			{ role: "assistant", text: "" },
		]),
		undefined,
		[],
		undefined,
	);
	assert.deepEqual(s.entries.map((e) => [e.kind, e.text]), [
		["report", "# Findings"],
		["agent", "Here you go"],
	]);
});
