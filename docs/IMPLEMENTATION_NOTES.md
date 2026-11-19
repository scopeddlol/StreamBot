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
