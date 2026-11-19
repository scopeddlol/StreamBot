#!/usr/bin/env bash
# Isolated generated configuration only; never uses or overwrites deployment .env/config.
set -euo pipefail
repo_dir="$(cd "$(dirname "$0")/.." && pwd)"
smoke_dir="$(mktemp -d)"
compose=(docker compose --project-directory "$smoke_dir" -f "$repo_dir/docker-compose.yml" -f "$smoke_dir/override.yml" -p streambot-ci-smoke)
cleanup() { "${compose[@]}" down --timeout 10 >/dev/null 2>&1 || true; rm -rf "$smoke_dir"; }
trap cleanup EXIT
mkdir -p "$smoke_dir/config" "$smoke_dir/data/videos" "$smoke_dir/data/preview-cache"
# Public test directories, with no user media or credentials.
chmod 777 "$smoke_dir/data/videos" "$smoke_dir/data/preview-cache"
printf '{"servers":[]}\n' > "$smoke_dir/config/media-servers.json"
node --input-type=module - "$smoke_dir/runtime.env" <<'JS'
import { writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
writeFileSync(process.argv[2], `SERVER_USERNAME=admin\nSERVER_PASSWORD=${randomBytes(32).toString('hex')}\nSESSION_SECRET=${randomBytes(32).toString('hex')}\nSERVER_PUBLIC_ORIGIN=http://localhost:3000\n`, { mode: 0o600 });
JS
export STREAMBOT_ENV_FILE="$smoke_dir/runtime.env"
printf 'services:\n  streambot:\n    command: ["bun", "run", "server"]\n' > "$smoke_dir/override.yml"
"${compose[@]}" config --quiet
"${compose[@]}" up -d --no-build
ready=false
for _ in {1..30}; do
  if curl --fail --silent http://127.0.0.1:3000/healthz > "$smoke_dir/health.json"; then ready=true; break; fi
  sleep 1
done
if [ "$ready" != true ]; then "${compose[@]}" logs --tail=50 streambot; exit 1; fi
node -e 'const fs=require("fs"); if(JSON.parse(fs.readFileSync(process.argv[1])).status!=="ok") process.exit(1)' "$smoke_dir/health.json"
"${compose[@]}" exec -T streambot sh -c 'bun --version && ffmpeg -version >/dev/null && ffprobe -version >/dev/null && yt-dlp --version'
"${compose[@]}" exec -T streambot sh -c 'printf fixture > videos/persistence.fixture; printf fixture > tmp/preview-cache/persistence.fixture'
"${compose[@]}" restart
"${compose[@]}" exec -T streambot sh -c 'test -f videos/persistence.fixture && test -f tmp/preview-cache/persistence.fixture && test -r config/media-servers.json'
"${compose[@]}" logs --tail=50 streambot
printf 'Dashboard-only Compose start, toolchain and persistent mount smoke test passed.\n'
