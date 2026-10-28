# research-collab

A shared research room. One durable agent, several people steering it from their own browsers. Built on
[`@earendil-works/pi-durable`](https://www.npmjs.com/package/@earendil-works/pi-durable) (pinned to 1.0.3, from npm: no pi checkout needed).

- Everyone sees one transcript, with each message attributed to its author.
- Anyone with edit access can ask, or **steer** (interrupt the current step) the agent.
- Research runs in a background subagent. Its report arrives as a card with a sources list.
- The run lives in SQLite. Kill the server mid-research, start it again, and it resumes; the report arrives once.

## Run locally

```bash
npm ci
export OPENROUTER_API_KEY=...            # or ANTHROPIC_API_KEY with ROOM_MODEL=anthropic/<model-id>
npm start                                # http://127.0.0.1:4790
```

The first start prints a host sign-in link (`/#invite=<token>`). The host token is kept in `data/host-token` (mode 600),
or set `ROOM_HOST_TOKEN`. Open the link, then use **Invite someone** to create one link per person (name and role).
Roles: **host** (stop the run, manage invites), **can steer** (ask and steer), **watch only**.

| Variable | Default | |
|---|---|---|
| `ROOM_MODEL` | `openrouter/qwen/qwen3.8-27b` | `<provider>/<model id>`; providers: `openrouter`, `anthropic` |
| `ROOM_PORT`, `ROOM_HOST` | `4790`, `127.0.0.1` | use `0.0.0.0` behind a proxy |
| `ROOM_DATA_DIR` | `./data` | holds `room.sqlite`, `invites.json`, `host-token` |
| `ROOM_HOST_TOKEN`, `ROOM_HOST_NAME` | generated, `Host` | |

Add `?theme=light` or `?theme=dark` to the page URL to override the system theme.

## Deploy to boxd

```bash
boxd auth login                                   # once
OPENROUTER_API_KEY=... deploy/deploy.sh           # creates the machine, installs a systemd service, publishes the port
```

The script creates a 2 vCPU / 8G machine with auto-suspend and auto-hibernate off (boxd judges idle by network traffic, so a
research run waiting on a model could otherwise be hibernated), copies the project, runs `npm ci`, writes the key and host
token to a mode-600 file, enables `deploy/research-collab.service`, and publishes port 4790 at `https://<name>.boxd.sh`.
Re-running it updates the code and keeps the data and host token.

State lives on the machine at `/home/boxd/research-collab-data`. The disk survives reboots, but not removing the machine:
take `boxd machine backup now <name>` before risky changes.

## How it works

```
browsers ── HTTPS + SSE ──> src/server.ts ──> src/room.ts ──> pi-durable Harness + SQLite
                                                   └─ src/agent.ts: main agent, `research` tool, background subagent
```

- `GET /api/events` sends the current snapshot first (so late joiners catch up), then one per change (about 10/s at most),
  plus a keepalive every 20 s and a presence list.
- A person's name is written into the stored message (`[Alice] ...`), so attribution is durable and the model sees it.
- Report text comes from the web through a model. The browser renders it with `marked` and sanitizes it with DOMPurify
  (both vendored in `public/vendor`).
- Tokens are stored as SHA-256 hashes and compared in constant time. Invite links are shown once.

## Limits

One room, one shared conversation: two people steering at once interleave, by design. Static invite tokens over HTTPS suit a
demo, not sensitive research. No accounts, no per-room isolation, no cost limits. Snapshots are full state, so a very long
session makes them large.

## Tests

`npm test` covers the invite/auth store and the transcript projection. The crash-recovery and multi-client behavior were
checked by hand against a real model (see the project history), not by automated tests.
