# Implementation notes

## Baseline (2026-11-18)

- Upstream: https://github.com/ysdragon/StreamBot, main at `c67f6b715c3168c21531fdaaa54f94b0b9e50fa0`.
- Local feature branch: `feat/jellyfin-silo-integration`; upstream remote retained.
- The first sandboxed GitHub auth check misleadingly reported an invalid token. Rechecking with network permission confirmed scopeddlol is authenticated (repo/workflow scope); fork/push proceeded after that correction.
- Bun 1.3.10 installed under `/private/tmp/streambot-toolchain` for verification; Node v25.6.1; Docker client 29.9.0, darwin/arm64.
- `bun install --frozen-lockfile --ignore-scripts`: passed (358 packages). `bun run build`: passed before edits. Upstream has no test script.
- Docker daemon unavailable: Colima socket does not exist. No live Discord or media-server credentials supplied.
- Upstream Compose pulls an unmodified image, publishes on all interfaces, and uses admin/admin. Dockerfile trusts all dependency scripts and does not lock installation.

## Execution path and design

Commands previously passed Discord Message objects directly through streaming and queue advancement; dashboard was a separate process. The integration uses a shared application playback controller with command adapters, and injects it into the HTTP app in the Discord process. Provider references resolve at playback time, bypassing the generic URL/YouTube resolver. Existing FFmpeg/Discord encoding remains the output engine.

## Reference inspection

Inspected upstream source and Silo main documentation: jellycompat-api.md, catalog-api.md, playback-api.md, auth-api.md and authentication/login handlers. Silo compatibility tokens use Jellyfin headers. Compatibility sign-in supports `username#profile` and `password#pin`; native bearer/profile headers are not substituted. Distinct media-source IDs and per-play grants must be preserved. Real deployed listener/version/profile validation remains an operator gate.

Jellyfin playback controller source: https://github.com/jellyfin/jellyfin/blob/master/Jellyfin.Api/Controllers/MediaInfoController.cs . Silo contract: https://github.com/Silo-Server/silo-server/blob/main/docs/jellycompat-api.md . These moving references are not proof of compatibility with an unprovided deployment.

## Container verification status
+
+- `STREAMBOT_ENV_FILE=.env.example docker-compose --env-file .env.example config --quiet`: passed. The machine has standalone Compose; `docker compose` is not registered as a CLI plugin.
+- Colima was initially stopped. Started it for the build, then stopped it after the failed attempt.
+- Build pulled pinned Bun/Node base images but failed at Docker's COPY layer commit with storage `input/output error`, before application dependency installation. Host free space was ~135 MiB. Docker subsequently could not list/remove the two task-pulled images due to the same I/O failure. No existing volumes/files were deleted. After stopping Colima the host reported ~1.5 GiB free; insufficient headroom for reliable retries.
+- Local image build/start checks are blocked by host storage. Recover storage and inspect Colima health before local retry. Subsequent GitHub CI successfully performed image build and dashboard-only start/restart/mount checks (see below); this does not establish live Discord cleanup.

## Implementation and local checks
+
+- `src/providers/`: registry, shared authenticated compatibility client, Jellyfin/Silo adapters, bounded HTTP errors/retries, origin validation and private per-play progressive/HLS gateway. Credentials remain backend-only; artwork uses the authenticated HTTP app.
+- `src/services/playback.ts`: application-level queue controller; `streaming.ts` retains the existing prepareStream/playStream engine behind a cancellable driver. Discriminated provider queue items store stable references. Discord and HTTP adapters share the controller without manufacturing Messages.
+- `src/server/`: EJS remote-library browser, source/library filters, details, TV navigation, version selection, queue controls. Strong dashboard configuration, session regeneration, strict cookies, Origin mutation protection and POST logout/delete. All command dispatch now requires configured guild/channel/admin authorization.
+- Provider session negotiation and ActiveEncodings teardown only; no explicit watched/progress writeback. Default audio, subtitles off. Startup root-grant renewal once; active HLS segment expiry is controlled failure, no seamless midstream resume. See README for limits.
+- `bun run build`: passes after integration. Reviewed native dependency setup completed locally; importing `@dank074/discord-video-stream` succeeds.
+- Real FFmpeg test generated one-second video+tone and decoded both mapped streams through progressive and HLS gateway transport. This does not verify real providers or Discord delivery.
+- Credentials absent: real Jellyfin/Silo versions/listeners/profiles, actual movie/episode playback, live expiry and Discord skip/stop verification remain unexecuted. Docker storage blocker is separate from these missing credentials.

- Final local regression run: **28 passed, 0 failed, 103 assertions** across four test files, including real FFmpeg audio/video transport.

## Fork and remote container verification

- Fork: https://github.com/scopeddlol/StreamBot; branch `feat/jellyfin-silo-integration`, upstream retained and branch pushed.
- CI https://github.com/scopeddlol/StreamBot/actions/runs/44460057666 passed at `2f0fd14`: locked install, build/tests, Linux amd64 image build, native streaming import, Bun/FFmpeg/ffprobe/yt-dlp checks, isolated dashboard-only Compose start, restart, persistent video/cache/config mounts, and shutdown. No image was published to upstream registries.
- Follow-up regression fix resolves HLS children relative to the final allowlisted redirect URL, with a dedicated nested-manifest test. Build and complete suite rerun before push; latest branch CI tracks the final revision.
- Live Discord output, real Jellyfin/Silo content/profile behavior, prolonged grant expiry, real FFmpeg SIGTERM during Discord playback, Linux arm64 container execution, and GPU behavior remain unverified. These require operator infrastructure; use LIVE_VERIFICATION.md. Full production acceptance is conditional on those checks.

## StreamBot TV baseline (2026-11-19)

- Continued on the same fork/feature branch; fetched origin and confirmed HEAD `7d0924755df132098ded2aabf1677a0849d02a30` has no newer branch commits or local changes.
- Bun 1.3.10 locked install and TypeScript build pass. Existing regression suite: 28 passed, 103 assertions, including real generated-media FFmpeg transport.
- Existing provider/gateway/transport implementation is retained. New canonical runtime will use Bun SQLite WAL, a private AES-GCM keyring, database sessions, browser configuration and child-process workers. Legacy server exports remain regression-compatible; canonical startup changes to the integrated TV runtime.
- Host has ~3.7 GiB free. Container verification will use fork CI rather than risk filling the local Docker VM again.

## StreamBot TV implementation (2026-11-19)

- `src/tv/store.ts`: transactional SQLite WAL schema/migration for settings, users, sessions, individual encrypted secrets, providers, applications, instances/runtime, playlists/entries, queue/checkpoints, rules, request policies/requests, AI and audit events.
- `vault.ts`, `auth.ts`, `backups.ts`: AES-GCM records authenticated to ID/purpose/owner/version, private crash-safe keyring rotation, one-time local pairing, Argon2id, hashed persistent sessions and passphrase-sealed exports/imports. Restore is explicit, owner-only and requires stopped connections.
- `providers.ts`, existing providers/gateway: runtime secret injection, unchanged handle reuse, unique playback device identities, source-specific private IPC, bounded catalog pagination, pinned DNS/origin checks, metadata blocking and retained HLS fixes. Generic direct inputs require a configured origin and are encrypted in SQLite.
- `instances.ts`, `worker.ts`, retained FFmpeg engine: dedicated process groups, authenticated private IPC, token/account identity checks before activation/voice join, destination conflicts, bounded crash/retry policy, heartbeat/RSS watchdog, configurable worker/encoder caps and graceful/forced group cleanup. Active provider sources resolve just in time. No mock transport is exposed in production.
- `playlists.ts`: stable references, series expansion, optimistic revisions, persisted cursor/cycle/shuffle, repeat off/one/all, saved duplication/selection, reference exports, and queue interruption without resetting live progress. Stop preserves work; skip advances once. Interrupted playback restarts from the beginning.
- `permissions.ts`, `requests.ts`, `discord.ts`: central web/Discord/AI policy; fresh Discord membership; official SDK 14.28.1 commands and guided, actor-bound, expiring selections; approvals, duplicate/cooldown/item limits, cancellation and completion state. Optional worker prefix routing uses the same policy.
- `ai.ts`: disabled-by-default Chat-Completions-compatible adapter; bounded catalog tools, no mutation tool, validated actual-result intersection, token/call limits, no conversations or secret metadata sent to the model. Compatible tool schema inspected in official API documentation.
- `server.ts`, `src/server/public/tv/`, retained catalog view: bundled dark responsive UI for onboarding, instances, live playlists, requests, sources, command apps, permissions/users, concierge, security, backup/import/migration, metrics/audit; authenticated SSE refreshes. Original provider and HTTP/FFmpeg regressions retained.
- Canonical Compose now has one service, no env-file dependency and one persistent `./data` mount. Read-only image, bounded scratch, localhost binding, initialization capabilities only and immediate UID/GID 1000 execution. Browser-upload migration supports old files without mounting them into the image or changing originals.

### Verification

- Locked installation and TypeScript build pass on Bun 1.3.10.
- Latest complete local regression: **52 passed, 0 failed, 270 assertions**, including the original 28 tests. Added actual mock-worker process isolation/recovery, nine-worker cap tests, crypto/migrations/auth, legacy import, request/RBAC/AI and backup recovery. No live accounts used.
- Actual browser verification in disposable `/private/tmp` data: onboarding shown, fixture login, instance creation, unsupported official-video failure, connections/request-policy views, and eight rooms created through UI (six live, two on demand). All remained stopped; no fake live-stream claims. Narrow-screen horizontal overflow was fixed and checked.
- Real generated FFmpeg audio/video transport remains tested through progressive and HLS gateways. Additional 160×90, 0.5-second concurrent encodes (software, one thread each): 2 processes: 39 ms wall / 83,257 µs CPU / 41,385,984 bytes sum of peak RSS; 4: 34 ms / 133,358 µs / 82,771,968 bytes; 8: 46 ms / 278,435 µs / 165,543,936 bytes. Peak-RSS sums are upper-bound aggregates, not measured simultaneous process-tree memory. This is a small synthetic load, not sustained Discord/HD/GPU throughput.
- Host Docker remains avoided after its previous storage failure. Updated CI builds the canonical image and uses an isolated empty-data smoke test: no-config startup, pairing/claim/replay rejection, protected routes, actual non-root runtime, persisted sessions/instances/media/cache after restart, and shutdown. Current CI result is recorded in the delivery report.
- Real Discord interactions/role revocation and audio/video, actual Jellyfin/Silo releases/profile access, long expiry, GPU and Linux arm64 remain operator gates. No live credentials supplied. Track selection/pause/vote-skip/clock schedules/frame-accurate seek are not implemented; continuous playlists, default audio and subtitles-off behavior are explicit.

- TV container CI at `94073a4`: https://github.com/scopeddlol/StreamBot/actions/runs/44471962761 — passed locked install, build/tests, image build, native import and the no-config onboarding/non-root/restart smoke test. A final follow-up awaits the pinned SDK's asynchronous disconnect and prevents startup work from reopening connections during shutdown; its regression raises the local suite to 52 tests / 270 assertions. The delivery report links CI for the exact final revision.
