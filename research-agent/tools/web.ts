const USER_AGENT = "durable-research-agent-poc/0.1 (local experiment)";
const MAX_PAGE_CHARS = 6000;

export interface SearchHit {
	readonly title: string;
	readonly url: string;
	readonly snippet: string;
}

/** Keyless search over Wikipedia. Swap this one function for a real search API. */
export async function searchWeb(query: string, signal: AbortSignal): Promise<SearchHit[]> {
	const url = new URL("https://en.wikipedia.org/w/api.php");
	url.search = new URLSearchParams({
		action: "query",
		list: "search",
		srsearch: query,
		srlimit: "5",
		format: "json",
		origin: "*",
	}).toString();
	const response = await fetch(url, { signal, headers: { "User-Agent": USER_AGENT } });
	if (!response.ok) throw new Error(`search failed: HTTP ${response.status}`);
	const body = (await response.json()) as {
		query?: { search?: { title: string; snippet: string }[] };
	};
	return (body.query?.search ?? []).map((hit) => ({
		title: hit.title,
		url: `https://en.wikipedia.org/wiki/${encodeURIComponent(hit.title.replaceAll(" ", "_"))}`,
		snippet: stripHtml(hit.snippet),
	}));
}

/** Fetches a page and returns its readable text, cut to a fixed size. */
export async function fetchPageText(pageUrl: string, signal: AbortSignal): Promise<string> {
	const parsed = new URL(pageUrl);
	if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("only http(s) urls");
	const response = await fetch(parsed, { signal, headers: { "User-Agent": USER_AGENT } });
	if (!response.ok) throw new Error(`fetch failed: HTTP ${response.status}`);
	const html = await response.text();
	const text = stripHtml(
		html.replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, " ").replace(/<(nav|footer|header)[\s\S]*?<\/\1>/gi, " "),
	);
	return text.length > MAX_PAGE_CHARS ? `${text.slice(0, MAX_PAGE_CHARS)}\n[truncated]` : text;
}

function stripHtml(html: string): string {
	return html
		.replace(/<[^>]+>/g, " ")
		.replaceAll("&quot;", '"')
		.replaceAll("&amp;", "&")
		.replaceAll("&lt;", "<")
		.replaceAll("&gt;", ">")
		.replaceAll("&#039;", "'")
		.replace(/\s+/g, " ")
		.trim();
}
