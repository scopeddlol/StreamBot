# StreamBot media libraries

A StreamBot fork adding Jellyfin and Silo compatibility-library browsing to the existing FFmpeg → Discord streamer. TypeScript, Bun, Express/EJS. Upstream: [ysdragon/StreamBot](https://github.com/ysdragon/StreamBot), MIT; original attribution and [LICENSE](LICENSE) retained. The [original README](docs/UPSTREAM_README.md) is historical; use this page for this fork's deployment.

**Discord account risk:** StreamBot is a self-bot using a regular Discord account. Discord prohibits self-bots and may suspend the account. This is not an official Discord bot; Docker does not remove that risk. No evasion features are included.

## Current verification

Local TypeScript build, automated HTTP/queue/security tests, native streaming-module import, and real FFmpeg audio/video decoding of generated media through progressive/HLS gateways pass. [Fork CI](https://github.com/scopeddlol/StreamBot/actions/runs/44460057666) also passed the Linux amd64 Docker build, native import, toolchain checks, and isolated dashboard-only Compose start/restart/persistent-mount smoke test. The local Docker build encountered host storage I/O errors and was stopped; container checks ran on GitHub instead. No live Discord, Jellyfin or Silo credentials/instances were supplied. See [implementation notes](docs/IMPLEMENTATION_NOTES.md) and the [live checklist](docs/LIVE_VERIFICATION.md). The fork is [scopeddlol/StreamBot](https://github.com/scopeddlol/StreamBot), branch `feat/jellyfin-silo-integration`.

## Install with Compose

Requires Docker Engine with Compose, adequate free disk (allow several GiB for native media dependencies/build layers), and network access to existing media servers and Discord. The stack builds this checkout; it does not deploy the unmodified upstream image or create media-server containers/databases.

```sh
cp .env.example .env
mkdir -p data/videos data/preview-cache config
cp config/media-servers.example.json config/media-servers.json
chmod 600 .env config/media-servers.json
```

Privately edit `.env` and `config/media-servers.json`:

- Fill `TOKEN`, `PREFIX`, `GUILD_ID`, `COMMAND_CHANNEL_ID`, `VIDEO_CHANNEL_ID`, and `ADMIN_IDS`. Only listed admin IDs in that guild/channel can execute commands, including playback controls. Use a dedicated test account/channel for verification.
- Set `SERVER_USERNAME`, a strong `SERVER_PASSWORD` (at least 16 characters, preferably random), and a separate random `SESSION_SECRET` (at least 32 characters). Bcrypt and Argon2 hashes are supported; single-quote values containing `$` in Compose env files. Generate random values locally with `openssl rand -hex 32`; never send them in chat or commit them.
- Set `SERVER_PUBLIC_ORIGIN=http://localhost:3000` for the default local dashboard. All mutations, including login, require that exact browser Origin. Opening the dashboard as `127.0.0.1` requires changing this setting accordingly.
- Set provider credentials in the environment variable names referenced by the JSON. Remove providers you do not use. `{"servers":[]}` is valid. IDs must be unique, letters/digits/underscore/hyphen, and are used by commands. More than one instance of either kind is supported.
- The JSON file is private even though it contains only environment references: its server URLs may identify private infrastructure. Real tokens/passwords never belong in JSON. `.env`, runtime config, local data and cookies are ignored by Git and excluded from Docker build context.

```sh
docker compose config --quiet
docker compose build
docker compose up -d
docker compose logs --tail=100 streambot
```

Open [the local dashboard](http://localhost:3000/library). Log in with the configured admin credentials. The same process owns the Discord client, dashboard and playback queue; **use the default `bun start` container command for playback**. `bun run server` is a separate read-only browsing mode and reports playback unavailable.

The checked-in mount paths are writable local video storage and preview cache. Queue/session state is in memory, intentionally resets on restart, and introduces no database. Media files/config/cache survive restarts through the bind mounts. In Linux deployments ensure the mounted directories/config are readable (and data directories writable) by container UID/GID 1000. Do not make private config world-readable to work around permissions.

### Reach existing media servers

Example URLs are placeholders, not deployed defaults. `localhost` inside StreamBot is the StreamBot container, not the host or media server. Use a reachable LAN/Tailscale URL, or attach this service to an existing private external Docker network and use the media server's service DNS name. For a host service on Linux, explicitly configure an appropriate host-gateway mapping if needed. This stack does not modify your server databases or media files.

The provider allows only the exact configured origin (scheme, host, port). API redirects, playback redirects, HLS playlists, segments, keys and artwork must stay on that origin. Cross-origin delivery/CDN/transcode nodes are deliberately rejected; expose a trusted same-origin media reverse proxy if necessary. Server filesystem `Path` fields are never opened locally.

HTTPS certificate verification stays enabled. For a private CA, mount the CA certificate read-only and set `NODE_EXTRA_CA_CERTS` to that path (verify support in your deployed Bun version); use a properly trusted server certificate. Do not disable TLS verification. Private HTTP is supported for explicitly configured trusted-network servers.

### Jellyfin

Use the actual API base URL, including any reverse-proxy path prefix. Configure either:

1. `credentialEnv` naming an API token and `userId` identifying the intended Jellyfin viewer; or
2. `usernameEnv` / `passwordEnv` naming an account login, with no `credentialEnv`.

Server API keys may carry broad privileges; prefer a dedicated restricted viewer session/login when profile restrictions matter. The client checks identity and accessible libraries, requests item details, and uses POST `PlaybackInfo` at the front of the queue. It prefers returned direct URLs, then HLS. Jellyfin sometimes omits `DirectStreamUrl`; only after negotiation reports `SupportsDirectPlay`, this adapter uses the [documented static video route](https://github.com/jellyfin/jellyfin/blob/master/Jellyfin.Api/Controllers/VideosController.cs) with the returned media-source and session identifiers. It never substitutes an arbitrary filesystem path.

### Silo

Use the **actual enabled Jellyfin compatibility listener URL**, which may be a different port from Silo's native API. Do not point this adapter at `/api/v2`. Verify listener/version, the account's permitted library/profile and playback in the dashboard before streaming.

The example uses `SILO_COMPAT_USERNAME=account#profile` and `SILO_COMPAT_PASSWORD` for a compatibility login. Current Silo source supports `password#pin` for PIN-protected profiles; confirm your deployed release's behavior before using it. Alternatively replace the login fields in JSON with `"credentialEnv":"SILO_COMPAT_TOKEN"` and supply a valid compatibility session token. Do not configure both modes. Login mode reauthenticates once when a compatibility credential expires.

Native `Authorization: Bearer ...` and `X-Profile-Id` are not sent to compatibility endpoints. Current Silo source also resolves certain admin API keys to the owner's primary profile; this is not permission to assume any native or catalog-scoped key can play media. Prefer explicit profile compatibility login and test access. No native API fallback is implemented.

References inspected: [compatibility API](https://github.com/Silo-Server/silo-server/blob/main/docs/jellycompat-api.md), [compatibility login](https://github.com/Silo-Server/silo-server/blob/main/internal/jellycompat/login.go), [API-key scope rules](https://github.com/Silo-Server/silo-server/blob/main/docs/api-keys-api.md). These describe current upstream source, not a verified installation supplied by the operator.

### Dashboard security / reverse proxies

Compose binds `127.0.0.1:3000`. Default HTTP cookies are HTTP-only, SameSite Strict, with an eight-hour lifetime. Login regenerates the session ID; login attempts are rate limited. Session storage is single-process memory, so logging in again after restart is expected.

For TLS termination, set `SERVER_PUBLIC_ORIGIN=https://your-private-dashboard.example` and `SERVER_TRUST_PROXY` to the explicit trusted proxy IP/CIDR, or `loopback` only when the proxy really connects from loopback. This enables Secure cookies and forwarded HTTPS handling. Do not trust every source IP. A proxy in another container cannot reach a loopback-bound host port as `localhost`; attach both containers to an appropriately isolated shared network, remove the host port mapping if unnecessary, and scope trust to that proxy's address/network. Keep the UI private and authenticated.

`GET /healthz` returns only `{"status":"ok"}`. This is process liveness, not a Discord/provider playback readiness claim. Provider connectivity appears separately in the authenticated source selector. No browser endpoint exposes raw media credentials or negotiated stream URLs. A random per-play loopback gateway passes source credentials only to the configured origin, proxies byte ranges, validates redirects and rewrites HLS URLs before FFmpeg sees them. Artwork is authenticated, bounded and cached only in the signed-in browser (`private`, five minutes); streams are not exposed as a dashboard download proxy.

## Use

The dashboard supports source/library selection, search, paginated movies/series, poster/details/runtime/codec summary, series → seasons → episodes, version selection, Play/Add to queue, and current queue/start/skip/stop. “Play” starts the queue when idle, and adds to the existing queue during playback. Errors and connectivity state appear inline. Existing local upload/preview management remains available under **Local files**. File deletion and logout now require POST.

Discord examples (use your configured prefix and **provider ID**):

```text
$media servers
$media search jellyfin-primary "The Matrix"
$media search silo-primary "The Matrix"
$media seasons silo-primary <series-id>
$media episodes silo-primary <series-id> <season-id>
$play jellyfin-primary:<movie-id>
$play silo-primary:<episode-id>
$queue
$skip
$stop
```

Local names, YouTube search/URLs, Twitch, HTTP URLs, header flags and other upstream commands remain available. Queue entries for providers contain stable IDs and optional version, never signed URLs or credentials. URLs/grants resolve when playback reaches that item. Failed items report a safe error and advance; skip/stop abort preparation and streaming and close provider resources before advancing. Playback errors are visible in the dashboard even when playback was started there without a Discord Message.

FFmpeg still encodes the output required by Discord; source direct play does not guarantee zero encoding. Hardware acceleration is off by default and needs platform-specific device access/configuration. No GPU claim is made for the macOS/Colima host.

## Limits and troubleshooting

- **Live release compatibility is pending verification.** No real Jellyfin movie, Silo episode, Discord audio/video, or expired live session has been tested here. Record deployed versions and run the [live checklist](docs/LIVE_VERIFICATION.md).
- Default audio only; subtitles are disabled. Track-selection requests are explicitly rejected rather than silently choosing another track. Media versions are supported when returned by item details. There is no seek/resume UI.
- An initially expired progressive/root playlist grant is renegotiated once. Expiry of an already-running HLS child/segment fails safely; seamless midstream renewal/resume is not implemented. Requeue the item after checking server grant lifetime. Session cleanup uses `DELETE /Videos/ActiveEncodings` with DeviceId/PlaySessionId; errors are reported, and server idle cleanup may still be needed after a crash.
- No progress or watched-state writeback is sent. Only playback negotiation and teardown mutate server session state. Silo may internally record playback history as part of its own session lifecycle.
- Media servers on another origin, unsupported HLS constructs and malformed responses fail closed. There is no arbitrary-URL provider proxy. Existing explicit admin URL playback/local remote-upload tools remain privileged upstream capabilities; keep admin access limited.
- `401`: replace credential or check compatibility login. `403`: account/profile/library/playback permissions. `404`: stale item/version or wrong listener/base path. `429`: bounded GET retries then an actionable error. Offline/TLS/timeout: check from inside the container; negotiation/read deadlines are bounded.
- Playback preparation supports cancellation. Legacy metadata lookups are bounded from the controller but an underlying third-party extractor may finish its read request in the background; downloaded temporary YouTube files are cleaned and downloads receive cancellation signals.
- Bun and npm packages are pinned by version/lockfile. Native setup downloads the locked datachannel prebuild and node-av's matching FFmpeg bundle. No `trust --all` is used; reviewed native steps live in `scripts/install-native.mjs`. OS package repositories and upstream native assets are not a fully hermetic/offline build. Audit/pin image digests and mirror native assets for stricter supply-chain requirements.
- Linux amd64/arm64 and macOS native package availability depend on the upstream streamer. Linux amd64 image build/start is verified in fork CI. Linux arm64 image execution and GPU acceleration remain unverified; rebuild on a healthy host with adequate storage before production use.

## Develop and verify

```sh
bun install --frozen-lockfile --ignore-scripts
bun run setup:native
bun run build
bun test
```

Install FFmpeg/ffprobe and yt-dlp on PATH for host execution; set `YTDLP_PATH` to an installed executable. Docker includes pinned yt-dlp and disables auto-update. For host development, set `FFMPEG_TEST_PATH` if the test executable is elsewhere. Generated test media uses tones/color bars, with no private libraries. The tests check provider DTOs/auth/errors/paging, HLS/redirect policy, grant renewal, queue lifecycle, dashboard auth/Origin controls and command permissions. The real FFmpeg test skips explicitly if neither `/usr/bin/ffmpeg`, the native bundle, nor the configured executable is present.

CI builds/tests without live credentials, builds the fork image, and runs an isolated dashboard-only Compose start/restart/persistence smoke test; it does not publish to upstream registries. Both Dockerfiles use the same locked setup; the default uses Bun, while `Dockerfile.node` selects the compiled Node entry point. The Node image has not been runtime-verified here.

## Source control

The implementation is on `feat/jellyfin-silo-integration` in [scopeddlol/StreamBot](https://github.com/scopeddlol/StreamBot), with `upstream` retained. To reproduce the fork workflow from an upstream-only checkout:

```sh
gh auth login -h github.com
gh auth status
gh repo fork --remote --remote-name origin
git remote -v
git push -u origin feat/jellyfin-silo-integration
```

Check that the fork belongs to the intended authenticated owner; retain `upstream`. Do not commit deployment credentials/config. Full implementation and verification results are in [implementation notes](docs/IMPLEMENTATION_NOTES.md).
