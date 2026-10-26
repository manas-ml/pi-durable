# research-agent

A durable research agent, adapted from pi's `experimental/vacation` example (pinned at earendil-works/pi `b78e6a9`).
The main agent hands research to a background subagent that runs `web_search` and `fetch_page` in parallel
(both `replay: "safe"`) and posts a `[research report]` back as a follow-up. Search is Wikipedia, keyless; swap
`searchWeb` in `tools/web.ts` for a real search API.

Run from this folder, in a real terminal:

```bash
node --import ../pi/packages/coding-agent/src/experimental/source-resolver.ts main.ts
node --import ../pi/packages/coding-agent/src/experimental/source-resolver.ts main.ts --continue
```

Sessions: `~/.pi/agent/experimental/research-sessions/`. Login is shared with pi.
