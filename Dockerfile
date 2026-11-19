# Pin toolchain versions; bun.lock pins JavaScript dependencies.
FROM oven/bun:1.3.10-debian AS bun
FROM node:22.22.0-bookworm-slim
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /home/bots/StreamBot
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates ffmpeg python3 python3-venv libatomic1 libgomp1 \
    && rm -rf /var/lib/apt/lists/* \
    && python3 -m venv /opt/ytdlp \
    && /opt/ytdlp/bin/pip install --no-cache-dir yt-dlp==2026.10.26 \
    && ln -s /opt/ytdlp/bin/yt-dlp /usr/local/bin/yt-dlp
ENV YTDLP_PATH=/usr/local/bin/yt-dlp YTDLP_AUTO_UPDATE=false
COPY package.json bun.lock ./
COPY scripts/install-native.mjs ./scripts/install-native.mjs
RUN bun install --frozen-lockfile --ignore-scripts && node scripts/install-native.mjs
COPY tsconfig.json ./
COPY src ./src
COPY tests ./tests
RUN bun run build && bun test && bun -e 'await import("@dank074/discord-video-stream")' \
    && ffmpeg -version && ffprobe -version && yt-dlp --version
RUN mkdir -p videos tmp/preview-cache config && chown -R node:node /home/bots/StreamBot
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s \
  CMD bun -e 'const r = await fetch("http://127.0.0.1:" + (process.env.SERVER_PORT || 3000) + "/healthz"); process.exit(r.ok ? 0 : 1)'
CMD ["bun", "start"]
