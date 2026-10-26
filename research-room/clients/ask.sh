#!/usr/bin/env bash
# One-shot client: send a question, wait until the agent and its background tasks are quiet, print the answer.
# Usage: ROOM_TOKEN=... clients/ask.sh "your question" [url]
set -euo pipefail
URL="${2:-${ROOM_URL:-http://127.0.0.1:4790}}"
curl -sS -X POST "$URL/ask" \
	-H "authorization: Bearer ${ROOM_TOKEN:?set ROOM_TOKEN}" \
	-H "content-type: application/json" \
	-d "$(printf '{"text": %s}' "$(printf '%s' "$1" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')")"
echo
