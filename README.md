# StreamBot TV

A single-container broadcast dashboard for independent playback rooms, persistent live-TV playlists, on-demand requests, Jellyfin/Silo browsing, encrypted credentials, permissions and optional catalog-based AI recommendations.

Continued in [scopeddlol/StreamBot](https://github.com/scopeddlol/StreamBot/tree/feat/jellyfin-silo-integration), branch `feat/jellyfin-silo-integration`. Based on [ysdragon/StreamBot](https://github.com/ysdragon/StreamBot); MIT license and attribution retained. Bun 1.3.10, TypeScript, Express/EJS, SQLite WAL, FFmpeg and yt-dlp. No external database, scheduler or management service is required.

**Platform and rights notice:** An official Discord application handles legitimate commands and interactions; its token cannot broadcast native Go Live video. Video playback uses the explicitly experimental user-account transport. Discord prohibits self-bots and may suspend that account. This project has no Discord approval, account/token harvesting, evasion or DRM bypass. Broadcast only content you have permission to share.

## Start with no credentials

From this checkout:

```sh
docker compose up -d --build
```

Open [http://localhost:3000](http://localhost:3000). There is no default administrator and no `.env` prerequisite. Read the one-time pairing code in the local container logs:

```sh
docker compose logs --tail=30 streambot
```

1. Claim the administrator using the pairing code, a unique username, a password of at least 16 characters, and the rights notice. Codes expire after 15 minutes and cannot be replayed; the wizard can renew an expired code into the local logs.
2. Under **Connections**, add optional Jellyfin/Silo sources and test them. Credentials are entered privately in the browser, encrypted at rest, and never echoed back.
3. Optionally add an official Discord application with its application ID, bot token and installed guild IDs. The panel provides an installation link. Start the connection to register commands and enable guild/voice-channel discovery. Installation still requires your Discord permissions.
4. Under **Instances**, create Live TV or On Demand rooms. Pick a transport, destination, optional legacy command channel, encoder settings, source restrictions and retry policy. Discovered destinations are convenient choices, not proof that the playback account has access: Join/Move checks that account's actual guild/channel permissions.
5. For video, explicitly acknowledge the experimental transport risk and supply its account credential. Each concurrently active playback account and destination must be independent. Start the room; no Compose edits or application restart are required.
6. Under **Media Library**, select a target room, browse shows/seasons/episodes, select versions or bulk items, and add them. Live rooms use persistent playlists; on-demand rooms use independent request queues. Start a stopped instance separately.

A fresh installation works without Discord, media or AI connections. Empty/unsupported configurations display actionable errors instead of pretending to stream. Eight active workers are allowed by default; **System** can raise/lower concurrency, encoder and worker RSS caps. Capacity depends on your actual host and codecs.

## One container and persistent data

The canonical Compose file contains exactly one application service, `streambot`, with one `./data:/data` mount. It persists:

```text
/data/database/       SQLite settings, users, sessions, rules, queues and playlists
/data/security/       protected AES-GCM keyring (separate from the database)
/data/videos/         local uploads (existing ./data/videos stays in place)
/data/preview-cache/  previews (existing ./data/preview-cache stays in place)
/data/cache/          writable runtime cache
```

The image filesystem is read-only, `/tmp` is bounded scratch space, and the host port binds only to `127.0.0.1:3000`. No Docker socket, privileged mode or media-server database is mounted. The entrypoint briefly initializes application-directory ownership, using only CHOWN/SETUID/SETGID/DAC_OVERRIDE capabilities for initialization and KILL for the root init process to forward signals, then immediately runs Bun and workers as UID/GID **1000** without effective capabilities. It does not recursively change ownership of your media libraries. The non-root process is checked by the container smoke test. Host Docker administrators can still access the container; this does not protect against a compromised host.

For native development:

```sh
bun install --frozen-lockfile --ignore-scripts
bun run setup:native
bun run build
bun test
bun start
```

Set `DATA_DIR` only if the infrastructure needs another data directory; default is `./data`. `SERVER_HOST`/`SERVER_PORT` are infrastructure bindings. Canonical operation does not require `TOKEN`, `SERVER_PASSWORD`, `SESSION_SECRET`, `ADMIN_IDS`, provider credential variables or JSON config. Bun is required for SQLite and workers; legacy `start:node`, `server:node` and `Dockerfile.node` names are compatibility aliases to the Bun runtime. Dependencies and selected native setup steps are locked; no `trust --all` is used. Runtime assets are bundled locally, with no CDN dependency.

## Upgrade without losing media or tokens

1. Keep a secure backup of the current checkout's `.env`, `config/media-servers.json` and existing `data` directory. Do not delete or recreate media-server volumes.
2. Check out this feature branch and rebuild the canonical service. The existing `./data/videos` and `./data/preview-cache` paths remain mapped; their contents are not deleted by migration.
3. Claim the new dashboard administrator. Under **System & Security**, choose your old `.env` and provider JSON files using **Import legacy files through the browser**. Preview the redacted summary, then confirm import. For native installs, server-side legacy files can also be detected automatically and imported after review.
4. The import preserves provider IDs, copies associated credentials into the encrypted vault, and can create the old Discord configuration as a **stopped** instance. It never starts that account automatically or deletes/overwrites the originals. Review destinations, source access, encoder settings and risk acknowledgement before starting it.
5. Verify sources and real playback; then remove or rotate the old external credentials at your discretion. Keep an encrypted backup and its separate recovery passphrase. Import is one-time, avoiding accidental re-import loops.

Old `./videos` installations should upload or intentionally copy their existing local files into `./data/videos`; the application does not move/delete arbitrary host media paths. Provider filesystem `Path` fields are never treated as local mount paths.

## Sources and network safety

**Jellyfin:** configure its real API base URL and either a token plus intended viewer ID or username/password login. Server API keys can be broad; use a restricted viewer login where profile restrictions matter.

**Silo:** use its enabled **Jellyfin compatibility listener**, which can be on a different port from native `/api/v2`. Use a compatibility token or documented compatibility login (`account#profile`; `password#pin` only where your deployed version supports it). Native bearer/profile headers are not substituted. Confirm the intended profile, library and playback permissions with the deployed release.

Catalog browsing, authenticated artwork, bounded episode pagination, media-source selection, just-in-time negotiation, root-grant renewal, private gateway transport and nested HLS redirect handling are retained. Provider edits update future handles while active sessions drain; unrelated streams are not restarted. Revocation stops only streams using that source, removes its encrypted credential and refreshes workers. Workers receive only the selected source's required credentials over private IPC at playback time; credentials are not CLI arguments or per-instance environment settings.

Every provider request uses the exact configured origin and a DNS-validated, pinned connection. Redirects stay within that origin; link-local/cloud-metadata/multicast destinations are rejected, including IPv6-mapped metadata addresses. HLS manifests/keys/segments are rewritten through a random, loopback-only per-play gateway. TLS verification stays enabled. Explicit private LAN/Tailscale media origins are supported, but never arbitrary metadata endpoints. For a private CA, provision a trusted certificate/CA at the host/image boundary and verify your Bun/Node TLS configuration; never disable verification.

Generic direct-media URLs must have their exact origin allowed in **System**. They use the same protected gateway and encrypted input storage. YouTube/Twitch extractors remain supported separately. Local files stay confined to the local-video directory. Existing remote-upload HTTP fetching is replaced by browser uploads and streaming from configured direct origins.

## Playlists and requests

Live TV supports movies, episodes, full seasons and deterministic whole-show snapshots (specials excluded by default), bulk selection, version references, drag/keyboard reorder, saved-playlist duplication/selection, reference-only import/export, sequential/shuffle ordering and repeat **off / one / all**. Shuffle order is stable within a cycle and persisted. Private URL inputs are excluded from reference exports. A pending on-demand/play-now queue can interrupt a live playlist without resetting its cursor.

Completion advances the persistent checkpoint. Skip aborts preparation/encoding, closes the media session and advances once. Stop preserves queue/checkpoint for restart; **Clear queue** is a separate confirmed operation. After recovery, the interrupted item restarts from the beginning with the same reference; frame-accurate seeking is not implemented. Per-item retries/backoff and a consecutive-failure limit prevent broken channels from spinning indefinitely. Empty playlists remain idle; there is no mandatory standby-media service. This is continuous playback, not a clock-based EPG scheduler.

Official commands include `/watch`, `/queue`, `/nowplaying`, `/skip`, `/room`, `/request-cancel` and `/recommend`. `/watch` guides selection through real matches, seasons/episodes and confirmation into an authorized on-demand room. Requests support staff approval, current-VC requirements, cooldowns, per-request/daily item limits and own pending cancellation. Commands refresh membership/roles before actions and use ephemeral responses. Request state tracks queue/playback completion.

Optional legacy prefix commands are scoped to a configured command channel and routed through the same permission policy: `play`, `media search`, `queue`, `skip`, `stop`, and `status`. Local names, URLs, YouTube queries and explicit `provider-id:item-id` references remain available. The old standalone account bootstrap is no longer the normal entry point. Legacy raw header flags and old file-management prefix commands are not activated in the new router; enter server credentials through the panel and manage local files there.

## Permissions and security

Web owner/admin/operator/viewer roles and guild/Discord-role/user/instance/action rules are enforced server-side for web, Discord and AI. The owner retains recovery control. Otherwise precedence is **explicit user deny → user allow → role deny → role allow → guild default → web-role default → deny**. Applicable user denies override generic allows; conflicting role denies win. A Discord Administrator flag or role name is never an authorization shortcut. Cross-guild room access is denied and fresh membership verification fails closed.

The owner can create web users; permissions are edited as explicit rules in the panel. Viewer defaults permit library/instance/queue reads, operator defaults add operational controls, and admin adds configuration. An application-level read grant is deliberately broader than a room-scoped grant. Credential metadata is visible only to the appropriate management role; plaintext values are never returned. Destructive operations require confirmation, with audit records containing actor/action/target/outcome rather than payloads.

Passwords use Argon2id. Database sessions use hashed random tokens, eight-hour absolute/30-minute idle expiry, HttpOnly/SameSite Strict cookies and revocation. State changes require exact Origin and reject cross-site requests. Authentication and mutation rates are bounded. Sensitive configuration over non-local plain HTTP is rejected. For a trusted HTTPS reverse proxy, set the exact dashboard origin and trusted proxy IP/CIDR in **System**; Secure cookies follow that origin. A proxy container needs a suitable private shared network; it cannot use the host's loopback port as its own localhost. Initial onboarding must be reached locally or through an SSH tunnel. DNS, TLS termination, firewall rules, port publication and GPU-device exposure remain explicit host prerequisites.

The vault uses fresh AES-256-GCM nonces and authenticated record ID/purpose/owner/version. The keyring is owner-only and separate from the DB. Missing/corrupt keys with ciphertext fail closed and never silently reset. Key rotation retains older key material for crash-safe transition. Backups are passphrase-encrypted envelopes containing the DB and key material; media files are separate. Restore requires explicit owner confirmation and all workers/command connections stopped, replaces configuration/accounts and revokes sessions. Keep backups/passphrases separately: loss of both key material and a recoverable encrypted backup makes credentials unrecoverable. A lost-key installation may need a fresh data directory plus an explicitly confirmed encrypted-backup restore; preserve the original directory for recovery.

## Optional AI

AI is off until configured. Use a Chat-Completions/tool-compatible endpoint and model, not a Responses-only model. The adapter follows the [official request/tool format](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create). Private compatible endpoints require an explicit opt-in; metadata endpoints are always blocked. No model server/container is installed.

Every catalog tool call is permission checked. Only allowlisted read tools are available; the model cannot grant roles, read secrets, call arbitrary URLs or queue anything. Returned keys are intersected with actual catalog results and playback requires ordinary selection/confirmation. Prompts/results are bounded, tool rounds are capped, daily token/call reservations and per-user requests are limited, and conversations are not retained. Library URLs, profile credentials and signed grants are not sent to the model. Unconfigured AI falls back to catalog search; API errors do not block core playback. Provider pricing/spend should also be constrained in the provider account—local token reservation is conservative, not an invoice estimate.

## Verification and limits

Local build and **53 tests / 273 assertions** pass, including the original provider/gateway regressions, persistence/vault/onboarding, worker isolation, account/destination conflicts, request/RBAC/AI checks, encrypted backup recovery, legacy migration and real generated-media FFmpeg transport. Eight stopped fixture rooms (six live/two on demand) were created through the actual browser UI. Actual child-process mock workers were started independently, including a ninth after raising the cap. These are not live Discord successes.

Short 160×90 generated tone/color fixtures were encoded concurrently at 2/4/8 processes. CPU and peak-RSS aggregates are recorded in implementation notes; this is not a sustained HD throughput or GPU capacity claim. Worker RSS caps cover the Bun process, not aggregate FFmpeg descendants. Concurrency caps and encoder settings bound work; use host/cgroup limits for hard system-wide resource isolation.

Real Discord command installation, account voice/video delivery, Jellyfin movie/Silo episode streaming, permission behavior on a deployed guild, long grant expiry, GPU encoding and Linux arm64 runtime still require operator credentials/infrastructure. Default audio is retained and subtitles remain off; per-track switching, pause, frame-accurate resume, vote-skip and clock schedules are not implemented. Full production acceptance remains conditional on [live verification](docs/LIVE_VERIFICATION.md). See [implementation notes](docs/IMPLEMENTATION_NOTES.md) for current build/CI results and architecture.
