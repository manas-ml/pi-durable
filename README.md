# pi-durable POCs

Experiments on top of [earendil-works/pi](https://github.com/earendil-works/pi)'s durable agent library
(`@earendil-works/pi-durable`), built from its `experimental/vacation` example.

- [`research-agent/`](research-agent): a durable research agent. The main agent hands questions to a background
  subagent that runs `web_search` / `fetch_page` in parallel; the report comes back as a follow-up message.
- [`research-room/`](research-room): the same agent behind a small HTTP/SSE server, with a terminal client, a
  browser page and a `curl` client attached to one shared run.

- [`research-collab/`](research-collab): a shared research room for several people. Everyone steers one durable agent from
  their own browser, with per-person invites, attributed messages, a polished UI, and a deploy script for [boxd](https://boxd.sh).
  Unlike the other two, it is self-contained: it depends on the published `@earendil-works/pi-durable@1.0.3` packages from npm
  and needs no pi checkout (see its README).

## Setup (research-agent and research-room)

These projects import pi's source, so they expect a pi checkout next to them, at the commit that has the vacation example:

```bash
git clone https://github.com/earendil-works/pi.git
cd pi
git fetch --depth 1 origin b78e6a9085343ec0f308c3d377da72528b4cf7ee && git checkout FETCH_HEAD
npm install --ignore-scripts
cd ..
ln -s ../pi/node_modules research-agent/node_modules
```

Log in with pi itself first; credentials in `~/.pi/agent` are shared. Do not use `npm run build` on that commit: it fails in
`packages/ai`. Everything runs from source through pi's source resolver. See each folder's README for the run commands.

Folder layout expected:

```
pi/  research-agent/  research-room/
```

## Credits

`research-agent/{main,runtime,tui,sessions,harness-setup}.ts` are adapted from pi's
`packages/coding-agent/src/experimental/vacation` (MIT, Copyright (c) 2025 Mario Zechner). Not affiliated with the pi authors.
