#!/usr/bin/env bash
# Disposable empty volume only: no .env, tokens or production config.
set -euo pipefail
repo_dir="$(cd "$(dirname "$0")/.." && pwd)"
smoke_dir="$(mktemp -d)"
compose=(docker compose --project-directory "$smoke_dir" -f "$repo_dir/docker-compose.yml" -p streambot-tv-ci-smoke)
cleanup() { "${compose[@]}" exec -T --user root streambot chown -R "$(id -u):$(id -g)" /data >/dev/null 2>&1 || true; "${compose[@]}" down --timeout 40 >/dev/null 2>&1 || true; rm -rf "$smoke_dir" || true; }
trap cleanup EXIT
"${compose[@]}" config --quiet
"${compose[@]}" up -d --no-build
ready=false
for _ in {1..30}; do
  if curl --fail --silent http://127.0.0.1:3000/healthz > "$smoke_dir/health.json"; then ready=true; break; fi
  sleep 1
done
if [ "$ready" != true ]; then exit 1; fi
# Pairing secret remains in a private scratch file; never output the log/code.
umask 077
"${compose[@]}" logs --no-color streambot > "$smoke_dir/private-startup.log"
node --input-type=module - "$smoke_dir" <<'JS'
import { readFileSync,writeFileSync } from 'node:fs'; import { randomBytes } from 'node:crypto';
const dir=process.argv[2], origin='http://localhost:3000';const code=readFileSync(dir+'/private-startup.log','utf8').match(/pairing code.*: ([A-Za-z0-9_-]+)/)?.[1];if(!code)throw Error('Pairing code absent');
const call=async(path,body,cookie='')=>{const response=await fetch(origin+path,body===undefined?{headers:{Cookie:cookie}}:{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',Cookie:cookie},body:JSON.stringify(body)});return {response,data:await response.json()};};
if((await call('/api/v1/instances')).response.status!==401)throw Error('Unprotected instance API');
if((await call('/api/v1/auth/login',{username:'admin',password:'admin'})).response.status!==401)throw Error('Default credentials accepted');
const result=await call('/api/v1/bootstrap/claim',{code,username:'fixture-owner',password:randomBytes(32).toString('hex'),rightsAccepted:true});if(result.response.status!==201)throw Error('Claim failed');
const cookie=result.response.headers.get('set-cookie').split(';')[0];
if((await call('/api/v1/system',undefined,cookie)).data.uid!==1000)throw Error('Application runtime is not non-root');
if((await call('/api/v1/bootstrap/claim',{code,username:'other',password:randomBytes(32).toString('hex'),rightsAccepted:true})).response.status===201)throw Error('Pairing replay');
const room=await call('/api/v1/instances',{name:'Persistence fixture',mode:'live',transport:'official-control-only',guildId:'100000000000000001',voiceChannelId:'200000000000000001'},cookie);if(!room.data.id)throw Error('Instance save failed');
writeFileSync(dir+'/private-cookie',cookie,{mode:0o600});writeFileSync(dir+'/room-id',room.data.id);
JS
"${compose[@]}" exec -T --user node streambot sh -c 'test "$(id -u)" = 1000 && bun --version && ffmpeg -version >/dev/null && ffprobe -version >/dev/null && yt-dlp --version'
"${compose[@]}" exec -T --user node streambot sh -c 'printf fixture > /data/videos/persistence.fixture; printf fixture > /data/preview-cache/persistence.fixture'
"${compose[@]}" restart
for _ in {1..30}; do if curl --fail --silent http://127.0.0.1:3000/healthz >/dev/null;then break;fi;sleep 1;done
node --input-type=module - "$smoke_dir" <<'JS'
import{readFileSync}from'node:fs';const dir=process.argv[2],cookie=readFileSync(dir+'/private-cookie','utf8'),id=readFileSync(dir+'/room-id','utf8');const response=await fetch('http://localhost:3000/api/v1/instances',{headers:{Cookie:cookie}});if(!response.ok||!(await response.json()).some(r=>r.id===id))throw Error('Session/instance persistence failed');
JS
"${compose[@]}" exec -T --user node streambot sh -c 'test -f /data/videos/persistence.fixture && test -f /data/preview-cache/persistence.fixture && test -f /data/security/vault-keys.json && test -f /data/database/streambot.sqlite'
printf 'No-config onboarding, protected API, non-root runtime and restart persistence passed.\n'
