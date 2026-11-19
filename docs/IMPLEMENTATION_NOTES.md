# Implementation notes

## Baseline (2026-11-18)

- Upstream: https://github.com/ysdragon/StreamBot, main at `c67f6b715c3168c21531fdaaa54f94b0b9e50fa0`.
- Local feature branch: `feat/jellyfin-silo-integration`; upstream remote retained.
- GitHub CLI reports an invalid token for its configured account. No fork exists from this run and nothing has been pushed. The connected GitHub tool has no fork operation.
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
+- Image build, container start/restart, volume persistence and container SIGTERM verification remain blocked by host storage. Do not claim the image is verified. Recover storage and inspect Colima health before retrying.
