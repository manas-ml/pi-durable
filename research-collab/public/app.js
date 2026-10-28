import { marked } from "./vendor/marked.js";
import DOMPurify from "./vendor/purify.js";

const $ = (id) => document.getElementById(id);
{
	// ?theme=light or ?theme=dark overrides the system setting.
	const theme = new URLSearchParams(location.search).get("theme");
	if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
}
const KEY = "research-room.invite";
const SUGGESTIONS = [
	"Research the main differences between SQLite and PostgreSQL for a small SaaS.",
	"What is WAL mode in SQLite and when should I use it?",
	"Give me a short history of the Rust programming language.",
];

let token = "";
let me = null;
let snapshot = null;
let abortStream = null;

// ── storage and helpers ─────────────────────────────────────────────────────────
const store = {
	get() { try { return localStorage.getItem(KEY) || ""; } catch { return ""; } },
	set(v) { try { localStorage.setItem(KEY, v); } catch {} },
	clear() { try { localStorage.removeItem(KEY); } catch {} },
};

function toast(message) {
	const el = $("toast");
	el.textContent = message;
	el.hidden = false;
	clearTimeout(toast.t);
	toast.t = setTimeout(() => { el.hidden = true; }, 4000);
}

async function api(path, options = {}) {
	const response = await fetch(path, {
		...options,
		headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(options.headers || {}) },
	});
	if (response.status === 401) { signOut("That invite is no longer valid."); throw new Error("unauthorized"); }
	const body = await response.json().catch(() => ({}));
	if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
	return body;
}

const hue = (name) => { let h = 0; for (const c of name) h = (h * 31 + c.codePointAt(0)) % 360; return h; };
function avatar(name, small) {
	const el = document.createElement("span");
	el.className = `avatar${small ? " sm" : ""}`;
	el.style.background = `hsl(${hue(name)} 55% 42%)`;
	el.textContent = (name.trim()[0] || "?").toUpperCase();
	el.setAttribute("aria-hidden", "true");
	return el;
}
function el(tag, className, text) {
	const node = document.createElement(tag);
	if (className) node.className = className;
	if (text !== undefined) node.textContent = text;
	return node;
}

// Reports and answers come from the web through a model: render markdown, then sanitize, and open links safely.
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
	if (node.tagName === "A") { node.setAttribute("target", "_blank"); node.setAttribute("rel", "noopener noreferrer"); }
});
function markdown(text) {
	const box = el("div", "md");
	box.innerHTML = DOMPurify.sanitize(marked.parse(text, { gfm: true, breaks: false }), { USE_PROFILES: { html: true } });
	return box;
}

// ── join / sign out ─────────────────────────────────────────────────────────────
function inviteFrom(input) {
	const value = input.trim();
	const match = /invite=([^&\s#]+)/u.exec(value);
	return match ? decodeURIComponent(match[1]) : value;
}
function showJoin(error) {
	abortStream?.abort();
	$("app").hidden = true;
	$("join").hidden = false;
	const e = $("join-error");
	e.hidden = !error;
	e.textContent = error || "";
	$("invite-input").focus();
}
function signOut(message) {
	store.clear();
	token = ""; me = null; snapshot = null;
	showJoin(message);
}
$("join-form").addEventListener("submit", async (event) => {
	event.preventDefault();
	token = inviteFrom($("invite-input").value);
	try { await start(); } catch (error) { if (error.message !== "unauthorized") showJoin(error.message); }
});
$("leave").addEventListener("click", () => signOut());

// ── connection ──────────────────────────────────────────────────────────────────
function setStatus(kind, text) {
	$("status").className = `chip ${kind}`;
	$("status-text").textContent = text;
}

async function connect() {
	abortStream?.abort();
	const controller = new AbortController();
	abortStream = controller;
	let delay = 800;
	while (!controller.signal.aborted) {
		try {
			setStatus("warn", "Connecting");
			const response = await fetch("/api/events", { headers: { authorization: `Bearer ${token}` }, signal: controller.signal });
			if (response.status === 401) { signOut("That invite is no longer valid."); return; }
			if (!response.ok || !response.body) throw new Error(String(response.status));
			setStatus("ok", "Live");
			delay = 800;
			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			let buffer = "";
			for (;;) {
				const { value, done } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				let end;
				while ((end = buffer.indexOf("\n\n")) >= 0) {
					const frame = buffer.slice(0, end);
					buffer = buffer.slice(end + 2);
					const event = /^event: (.+)$/mu.exec(frame)?.[1];
					const data = /^data: (.+)$/mu.exec(frame)?.[1];
					if (event && data) handle(event, JSON.parse(data));
				}
			}
		} catch (error) {
			if (controller.signal.aborted) return;
		}
		setStatus("warn", "Reconnecting");
		await new Promise((resolve) => setTimeout(resolve, delay));
		delay = Math.min(delay * 1.7, 8000);
	}
}

function handle(event, data) {
	if (event === "snapshot") { snapshot = data; render(); }
	else if (event === "presence") renderPresence(data);
}

// ── rendering: conversation ─────────────────────────────────────────────────────
const log = $("log");
let thread = null;
let live = null;
let renderedIds = [];
let lastGroup = null;
let stuck = true;

log.addEventListener("scroll", () => {
	stuck = log.scrollHeight - log.scrollTop - log.clientHeight < 60;
	if (stuck) $("jump").hidden = true;
});
$("jump").addEventListener("click", () => { log.scrollTop = log.scrollHeight; });

function resetThread() {
	log.replaceChildren();
	thread = el("div", "thread");
	live = el("div", "live");
	log.append(thread);
	renderedIds = [];
	lastGroup = null;
}

function group(kind, name) {
	const g = el("div", "group");
	g.dataset.author = name;
	g.append(kind === "agent" ? agentAvatar() : avatar(name));
	const body = el("div", "body");
	const who = el("div", "who");
	who.append(el("strong", "", kind === "agent" ? "Research agent" : name));
	if (kind === "agent") who.append(el("span", "agent-tag", "AI"));
	body.append(who);
	g.append(body);
	g.bodyEl = body;
	g.whoEl = who;
	return g;
}
function agentAvatar() {
	const a = el("span", "avatar");
	a.style.background = "var(--accent)";
	a.style.color = "var(--accent-text)";
	a.textContent = "R";
	a.setAttribute("aria-hidden", "true");
	return a;
}

function appendEntry(entry) {
	if (entry.kind === "report") {
		lastGroup = null;
		const d = el("details", "report");
		d.open = true;
		const s = el("summary");
		s.append(el("span", "", "Research report"), el("span", "pill", "Ready"));
		const chev = el("span", "chev");
		chev.innerHTML = '<svg viewBox="0 0 16 16" width="16" height="16"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
		s.append(chev);
		const body = el("div", "body");
		body.append(markdown(entry.text));
		d.append(s, body);
		thread.append(d);
		return;
	}
	const isAgent = entry.kind === "agent";
	const name = isAgent ? "agent" : entry.author || "someone";
	if (!lastGroup || lastGroup.dataset.author !== name) {
		lastGroup = group(isAgent ? "agent" : "person", name);
		thread.append(lastGroup);
	}
	if (entry.steering && !isAgent && !lastGroup.whoEl.querySelector(".steer-tag")) {
		lastGroup.whoEl.append(el("span", "steer-tag", "steering"));
	}
	if (isAgent) lastGroup.bodyEl.append(markdown(entry.text));
	else lastGroup.bodyEl.append(el("div", "bubble said", entry.text));
}

function render() {
	if (!snapshot) return;
	if (!thread) resetThread();
	const ids = snapshot.entries.map((e) => e.id);
	const prefixOk = renderedIds.every((id, i) => ids[i] === id);
	if (!prefixOk) resetThread();
	if (live.parentNode) live.remove();
	for (const entry of snapshot.entries.slice(renderedIds.length)) appendEntry(entry);
	renderedIds = ids;

	if (snapshot.entries.length === 0 && !snapshot.busy) renderEmpty();
	else thread.querySelector(".empty-state")?.remove();
	renderLive();
	renderSidebar();
	renderComposer();
	if (stuck) log.scrollTop = log.scrollHeight;
	else if (snapshot.busy || snapshot.partial) $("jump").hidden = false;
}

function renderEmpty() {
	if (thread.querySelector(".empty-state")) return;
	const box = el("div", "empty-state");
	const icon = el("div", "logo");
	icon.style.margin = "0 auto";
	icon.innerHTML = '<svg viewBox="0 0 32 32" width="28" height="28"><circle cx="15" cy="15" r="6" fill="none" stroke="currentColor" stroke-width="3"/><path d="M20 20l6 6" stroke="currentColor" stroke-width="3" stroke-linecap="round"/></svg>';
	box.append(icon, el("h2", "", "Ask the room anything"));
	box.append(el("p", "", me?.role === "viewer" ? "You're watching. Others can start the research." : "The agent researches in the background while everyone keeps chatting. Try one of these:"));
	if (me?.role !== "viewer") {
		const list = el("div", "suggestions");
		for (const text of SUGGESTIONS) {
			const b = el("button", "suggestion", text);
			b.type = "button";
			b.addEventListener("click", () => send(text));
			list.append(b);
		}
		box.append(list);
	}
	thread.append(box);
}

function renderLive() {
	live.replaceChildren();
	const running = snapshot.tools.filter((t) => t.status === "running");
	if (!snapshot.busy && !snapshot.partial && running.length === 0) return;
	const g = group("agent", "agent");
	if (snapshot.partial) {
		const partial = markdown(snapshot.partial);
		partial.classList.add("partial");
		g.bodyEl.append(partial);
	} else if (running.length === 0) {
		const t = el("div", "typing");
		t.setAttribute("aria-label", "The agent is thinking");
		t.append(el("i"), el("i"), el("i"));
		g.bodyEl.append(t);
	}
	for (const tool of running) {
		const line = el("div", "tool-line");
		line.append(el("span", "spin"), el("span", "", describeTool(tool)));
		g.bodyEl.append(line);
	}
	live.append(g);
	thread.append(live);
}

function describeTool(tool) {
	const last = tool.output.trim().split("\n").filter(Boolean).pop() || "";
	const label = { research: "Starting research", web_search: "Searching the web", fetch_page: "Reading a page" }[tool.name] || tool.name;
	return last ? `${label}: ${last.slice(0, 90)}` : `${label}…`;
}

// ── rendering: sidebar, presence, composer ──────────────────────────────────────
function renderSidebar() {
	const tasks = snapshot.tasks.filter((t) => t.kind.startsWith("research."));
	const running = tasks.filter((t) => t.status !== "terminal").length;
	const count = $("tab-count");
	count.hidden = running === 0;
	count.textContent = String(running);

	const box = $("tasks");
	box.replaceChildren();
	const tools = snapshot.tools.filter((t) => t.status === "running");
	// The task graph drops finished tasks, so finished research is listed from the reports in the transcript.
	const reports = snapshot.entries.filter((e) => e.kind === "report");
	for (const [i, report] of reports.entries()) {
		const card = el("div", "card");
		const row = el("div", "row");
		row.append(el("span", "", `Research brief ${reports.length > 1 ? i + 1 : ""}`.trim()), el("span", "status done", "done"));
		const lines = report.text.split("\n").map((l) => l.trim());
		const picked = lines.find((l) => l.startsWith("#")) ?? lines.find((l) => l.length > 12) ?? "";
		const heading = picked.replace(/^[#>*\-\s]+/u, "").replace(/\*+/gu, "");
		card.append(row);
		if (heading) card.append(el("div", "sub", heading.slice(0, 110)));
		box.append(card);
	}
	for (const task of tasks) {
		const done = task.status === "terminal";
		if (done) continue;
		const card = el("div", "card");
		const row = el("div", "row");
		row.append(el("span", "", "Research brief"), el("span", `status ${done ? "done" : "running"}`, done ? "done" : task.status));
		card.append(row);
		if (!done) card.append(el("div", "sub", "A subagent is searching and reading in the background."));
		box.append(card);
	}
	for (const tool of tools.filter((t) => t.name !== "research")) {
		const card = el("div", "card");
		const row = el("div", "row");
		row.append(el("span", "", describeTool(tool).split(":")[0]), el("span", "status running", "running"));
		card.append(row, el("div", "sub", tool.output.trim().split("\n").filter(Boolean).pop() || ""));
		box.append(card);
	}
	if (!box.children.length) box.append(el("div", "empty", "Nothing running. Ask a research question to get started."));

	const urls = new Map();
	for (const entry of snapshot.entries.filter((e) => e.kind === "report")) {
		for (const m of entry.text.matchAll(/https?:\/\/[^\s)<>\]"']+/gu)) {
			const url = m[0].replace(/[.,;:!?]+$/u, "");
			if (!urls.has(url)) urls.set(url, true);
		}
	}
	const list = $("sources");
	list.replaceChildren();
	for (const url of urls.keys()) {
		let host = url, path = "";
		try { const u = new URL(url); host = u.hostname.replace(/^www\./u, ""); path = u.pathname === "/" ? "" : u.pathname; } catch {}
		const li = el("li");
		const a = el("a");
		a.href = url; a.target = "_blank"; a.rel = "noopener noreferrer";
		a.append(el("b", "", host));
		if (path) a.append(el("span", "", path));
		li.append(a);
		list.append(li);
	}
	if (!urls.size) list.append(el("li", "empty", "Links from research reports appear here."));
}

function renderPresence(people) {
	const list = $("presence");
	list.replaceChildren();
	for (const p of people) {
		const li = el("li", "person");
		li.append(avatar(p.name, true), el("span", "name", p.name === me?.name ? `${p.name} (you)` : p.name), el("span", `badge ${p.role}`, p.role));
		list.append(li);
	}
	if (!people.length) list.append(el("li", "empty", "Just you so far."));
}

// The server reports failed turns (bad or expired model key, provider errors) as notices. Say so instead of staying silent.
let dismissedNotice = 0;
function friendlyNotice(message) {
	if (/API key expired|invalid_token|401|not configured|unauthorized/iu.test(message)) {
		return me?.role === "host"
			? "The agent couldn't answer: the model API key was rejected (expired, invalid or missing). Update it on the server and redeploy."
			: "The agent couldn't answer: the model API key was rejected. Ask the host to update it.";
	}
	return `The agent couldn't answer: ${message.replace(/^No answer: /u, "").slice(0, 200)}`;
}
function renderNotice() {
	const last = snapshot.notices[snapshot.notices.length - 1];
	const box = $("notice");
	box.hidden = !last || last.id <= dismissedNotice;
	if (!box.hidden) { $("notice-text").textContent = friendlyNotice(last.message); box.dataset.id = String(last.id); }
}
$("notice-close").addEventListener("click", () => { dismissedNotice = Number($("notice").dataset.id || 0); $("notice").hidden = true; });

function renderComposer() {
	renderNotice();
	const viewer = me?.role === "viewer";
	const input = $("input");
	input.disabled = viewer;
	$("send").disabled = viewer;
	$("steer").disabled = viewer;
	$("abort").hidden = !(me?.role === "host" && snapshot.busy);
	const note = $("composer-note");
	let text = "";
	if (viewer) text = "You're watching. Ask the host for edit access to send messages.";
	else if (snapshot.busy) text = $("steer").checked ? "Your message will interrupt the agent's current step." : "The agent is working. Your message will be queued behind it.";
	note.hidden = !text;
	note.textContent = text;
	input.placeholder = viewer ? "Watching only" : snapshot.busy ? "Add to the research, or turn on Steer to redirect it…" : "Ask something, or steer the research…";
}
$("steer").addEventListener("change", () => snapshot && renderComposer());

async function send(text) {
	const body = (text ?? $("input").value).trim();
	if (!body || me?.role === "viewer") return;
	const steer = $("steer").checked && snapshot?.busy === true;
	if (text === undefined) { $("input").value = ""; autosize(); }
	stuck = true;
	try { await api("/api/submit", { method: "POST", body: JSON.stringify({ text: body, steer }) }); }
	catch (error) { if (error.message !== "unauthorized") { toast(error.message); if (text === undefined) $("input").value = body; } }
}
$("composer").addEventListener("submit", (e) => { e.preventDefault(); send(); });
$("input").addEventListener("keydown", (e) => {
	if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
});
function autosize() { const t = $("input"); t.style.height = "auto"; t.style.height = `${Math.min(t.scrollHeight, 180)}px`; }
$("input").addEventListener("input", autosize);
$("abort").addEventListener("click", async () => {
	try { await api("/api/abort", { method: "POST" }); toast("Stopped the current run."); } catch (error) { toast(error.message); }
});

// ── host tools ──────────────────────────────────────────────────────────────────
async function loadInvites() {
	if (me?.role !== "host") return;
	const invites = await api("/api/invites");
	const list = $("invites");
	list.replaceChildren();
	for (const invite of invites) {
		const li = el("li", "person");
		const revoke = el("button", "icon-btn", "✕");
		revoke.type = "button";
		revoke.title = `Revoke ${invite.name}'s invite`;
		revoke.setAttribute("aria-label", revoke.title);
		revoke.addEventListener("click", async () => { await api("/api/invites/revoke", { method: "POST", body: JSON.stringify({ id: invite.id }) }); loadInvites(); });
		li.append(avatar(invite.name, true), el("span", "name", invite.name), el("span", `badge`, invite.role === "viewer" ? "watch" : "steer"), revoke);
		list.append(li);
	}
	if (!invites.length) list.append(el("li", "empty", "No invites yet."));
}
$("invite-form").addEventListener("submit", async (event) => {
	event.preventDefault();
	try {
		const result = await api("/api/invites", { method: "POST", body: JSON.stringify({ name: $("invite-name").value, role: $("invite-role").value }) });
		const link = `${location.origin}/#invite=${result.token}`;
		const box = $("invite-result");
		box.replaceChildren(el("div", "", `Send this link to ${result.identity.name}. It is shown once.`), el("code", "", link));
		const copy = el("button", "btn sm", "Copy link");
		copy.type = "button";
		copy.addEventListener("click", async () => {
			try { await navigator.clipboard.writeText(link); copy.textContent = "Copied"; } catch { toast("Select the link and copy it."); }
		});
		box.append(copy);
		box.hidden = false;
		$("invite-name").value = "";
		loadInvites();
	} catch (error) { toast(error.message); }
});

// ── tabs (narrow screens) ───────────────────────────────────────────────────────
for (const tab of document.querySelectorAll(".tab")) {
	tab.addEventListener("click", () => {
		document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t === tab));
		document.querySelector(".layout").dataset.pane = tab.dataset.pane;
		if (tab.dataset.pane === "chat") log.scrollTop = log.scrollHeight;
	});
}

// ── start ───────────────────────────────────────────────────────────────────────
async function start() {
	me = await api("/api/me");
	store.set(token);
	$("join").hidden = true;
	$("app").hidden = false;
	$("me").textContent = me.name;
	$("me").title = `Signed in as ${me.name} (${me.role})`;
	$("host-tools").hidden = me.role !== "host";
	resetThread();
	renderPresence([]);
	loadInvites();
	connect();
}

const fromHash = /invite=([^&]+)/u.exec(location.hash)?.[1];
if (fromHash) {
	token = decodeURIComponent(fromHash);
	history.replaceState(null, "", location.pathname + location.search);
} else {
	token = store.get();
}
if (token) start().catch((error) => { if (error.message !== "unauthorized") showJoin(error.message); });
else showJoin();
