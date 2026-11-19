# Operator live verification (not executed)

Use a dedicated authorized Discord test account and channel. StreamBot is a prohibited Discord self-bot with suspension risk. No credentials should appear in saved test records.

1. Recover host disk space and check Docker/Colima health. Do not delete media-server volumes. Rebuild the fork image with `docker compose build`; verify Bun, FFmpeg, ffprobe, yt-dlp and native streaming-module import (also asserted by Dockerfile).
2. Supply private `.env` and `config/media-servers.json`; run `docker compose config --quiet`, `docker compose up -d`, and `docker compose logs --tail=100 streambot`. Check localhost-only port and admin login. Inspect logs privately; do not paste credentials or private media metadata.
3. Check `/healthz` returns only status. Logged-out API requests must fail; logged-in cross-origin POST requests must fail. Verify Secure cookies and Origin handling if using a trusted TLS proxy.
4. Record Jellyfin/Silo versions, configured listener and intended profile privately. Confirm libraries/permissions with the provider connectivity status. Silo must use its compatibility listener, not native v2 headers. Verify wrong/expired credentials give safe errors.
5. Search each provider; check duplicate titles remain distinct, paging, movies/TV, no results and inaccessible content. Navigate series → seasons → episodes and check artwork.
6. Play one real Jellyfin movie and one real Silo TV episode. In Discord confirm moving video AND audible audio in the same stream. Confirm correct version and title without exposing signed URLs. Stop, skip and autoplay a mixed local/YouTube/Jellyfin/Silo queue. Also test invalid/missing media file.
7. Let a queued item's old grant expire before it starts: playback must negotiate fresh. Force an initially expired root playback grant and verify one renewal. Confirm expiry of an active HLS child is a controlled failure (seamless resume is outside this MVP).
8. Stop while negotiation is in progress and while streaming. Confirm FFmpeg exits, provider sessions release, voice disconnects, queue clears and nothing starts afterward. Check provider session accounting; no explicit progress/watch-state writeback should be sent.
9. Restart the container and run `docker compose down`: confirm graceful process cleanup; local videos/cache/config persist. In-memory queue and admin sessions intentionally reset.
10. Record pass/fail and deployed versions beside the final local test results. Unchecked steps remain unverified, even if unit tests pass.
