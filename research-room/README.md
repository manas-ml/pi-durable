# research-room

One durable research agent behind a small HTTP server, with several thin clients attached to the same run.
The server owns the Harness and the SQLite session (via `../research-agent/runtime.ts`). Clients hold no
agent state: they read snapshots over Server-Sent Events and POST commands.

```
terminal client ─┐
browser page    ─┼── HTTP + SSE ──> server.ts ──> openDurable() ──> Harness + SQLite
curl / ask.sh   ─┘
```

## Run

```bash
cd /Users/manasnarkar/Documents/_POCs/pi-durable/research-room
ROOM_TOKEN=op ROOM_VIEWER_TOKEN=vw npm run server            # add -- --continue to resume the last session
```

Tokens are random and printed at start if you don't set them. The server binds to 127.0.0.1:4790
(`ROOM_HOST`, `ROOM_PORT`).

Clients (any number, any time):

```bash
ROOM_TOKEN=op node clients/terminal.ts                       # "!text" steers, "/abort" aborts
open "http://127.0.0.1:4790/#token=op"                       # browser; use #token=vw for read-only
ROOM_TOKEN=op clients/ask.sh "Research X. Use a subagent."   # blocks until the agent and its tasks are quiet
```

## API

| Route | Role | What |
|---|---|---|
| `GET /state` | viewer | current snapshot as JSON |
| `GET /events` | viewer | SSE: a `snapshot` immediately (late join), then one per change (at most ~10/s) |
| `POST /submit {text, whenBusy}` | operator | `followUp` (queue) or `steer` |
| `POST /ask {text, timeoutMs?}` | operator | submit, wait until quiet, return the last answer |
| `POST /abort`, `POST /switch {id}` | operator | abort current conversation; view a subagent |

Auth is `Authorization: Bearer <token>` (the browser keeps the token in the URL fragment and sends it as a header).

## Notes and limits

- Snapshots are full, not diffs. Fine for a POC; a long session makes them large. The upgrade is the durable
  library's ops stream (`root.watch`, see `pi/packages/durable/test/examples/19-json.ts`).
- `switchConversation` is server-wide: switching in one client changes what every client sees.
- `/ask` decides "done" by polling for two quiet checks in a row (main conversation idle and no live tasks).
- Plain HTTP and static tokens: localhost use only.

## Verified

Real model, real network: 401 without a token, viewer GET 200 / viewer POST 403, operator submit, two SSE watchers
(one joining mid-run got the full 9-entry state first), `/ask` returning the final summary of a subagent research,
and a `kill -9` mid-research followed by `--continue`: the run resumed and each research request produced exactly
one report. The terminal client and the browser page were not exercised in an interactive terminal or browser.
