#!/usr/bin/env bash
# Deploy research-collab to a boxd machine from your laptop. Re-run to update the code (secrets and data are kept).
#   OPENROUTER_API_KEY=... deploy/deploy.sh [machine-name]     (the key is optional on a re-run: the stored one is kept)
# Needs: the boxd CLI, logged in (`boxd auth login`). Creates a machine on first run: that is billable.
set -euo pipefail
NAME="${1:-research-collab}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
PORT=4790
KEY="${OPENROUTER_API_KEY:-}"

exists() { boxd machine ls --json | python3 -c 'import json,sys; sys.exit(0 if any(m["name"]==sys.argv[1] for m in json.load(sys.stdin)) else 1)' "$NAME"; }

if exists; then
	echo "==> machine $NAME exists, updating"
else
	echo "==> creating machine $NAME (sleeping off: boxd judges idle by network traffic, not CPU)"
	boxd machine new "$NAME" --vcpu 2 --memory 8G --auto-suspend-timeout 0 --auto-hibernate-timeout 0 --json
fi
# An existing machine may still have boxd's default sleeping settings (4 h idle hibernate).
boxd machine config set "$NAME" auto-suspend.timeout 0 >/dev/null
boxd machine config set "$NAME" auto-hibernate.timeout 0 >/dev/null

echo "==> copying the project (no node_modules, no data)"
tar -C "$HERE" --exclude node_modules --exclude data --exclude '.git' -czf - . |
	boxd machine exec "$NAME" -- 'mkdir -p ~/research-collab && tar -xzf - -C ~/research-collab'

echo "==> installing dependencies"
boxd machine exec "$NAME" -- 'cd ~/research-collab && npm ci --no-audit --no-fund 2>&1 | tail -3'

echo "==> writing secrets (kept if already present, except the model key)"
HOST_TOKEN="$(boxd machine exec "$NAME" -- 'grep -s "^ROOM_HOST_TOKEN=" ~/.research-collab.env | cut -d= -f2-' || true)"
NEW_TOKEN=0
if [ -z "$HOST_TOKEN" ]; then HOST_TOKEN="$(python3 -c 'import secrets; print(secrets.token_urlsafe(24))')"; NEW_TOKEN=1; fi
if [ -z "$KEY" ]; then KEY="$(boxd machine exec "$NAME" -- 'grep -s "^OPENROUTER_API_KEY=" ~/.research-collab.env | cut -d= -f2-' || true)"; fi
[ -n "$KEY" ] || echo "NOTE: no model key set. The room works, but the agent cannot answer until you add one (see the end of this output)."
printf 'OPENROUTER_API_KEY=%s\nROOM_HOST_TOKEN=%s\nROOM_MODEL=%s\n' "$KEY" "$HOST_TOKEN" "${ROOM_MODEL:-openrouter/qwen/qwen3.8-27b}" |
	boxd machine exec "$NAME" -- 'umask 077; cat > ~/.research-collab.env'

echo "==> installing the service"
boxd machine exec "$NAME" -- 'mkdir -p ~/research-collab-data && sudo cp ~/research-collab/deploy/research-collab.service /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl enable research-collab >/dev/null 2>&1 && sudo systemctl restart research-collab'

echo "==> publishing port $PORT over HTTPS"
boxd machine proxy set-port --vm "$NAME" --port "$PORT" || true

URL="$(boxd machine get "$NAME" --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["url"])')"
echo
echo "research-collab is up: $URL"
if [ "$NEW_TOKEN" = 1 ]; then
	echo "Host sign-in (shown once, keep it private):"
	echo "  $URL/#invite=$HOST_TOKEN"
else
	echo "Host token unchanged from the first deploy."
fi
if [ -z "$KEY" ]; then
	echo "Add a model key later (re-run with OPENROUTER_API_KEY=... deploy/deploy.sh $NAME)."
fi
echo "Logs: boxd machine exec $NAME -- 'sudo journalctl -u research-collab -n 50 --no-pager'"
