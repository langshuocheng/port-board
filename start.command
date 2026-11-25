#!/usr/bin/env bash
# macOS: double-click to launch (first run: chmod +x start.command)
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js not found in PATH. Install Node 14+ and retry."
  exit 1
fi

if node -e "require('http').get('http://127.0.0.1:8888/api/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"; then
  echo "PortBoard is already running. Opening http://127.0.0.1:8888 ..."
  open "http://127.0.0.1:8888"
  exit 0
fi

echo
echo "  PortBoard  http://127.0.0.1:8888"
echo "  Press Ctrl+C to stop."
echo

(sleep 1 && open "http://127.0.0.1:8888") &
exec node server.js
