import { randomBytes } from "node:crypto";
import path from "node:path";
import { AppError, publicError } from "./errors.js";
import { Source } from "./playlists.js";
import { PlaybackController } from "../services/playback.js";
import { ProviderRegistry } from "../providers/registry.js";
import { registerSecret } from "../utils/redact.js";
import config from "../config.js";
const nonce = randomBytes(32).toString("hex");
let player: PlaybackController | undefined,
  engine: any,
  client: any,
  stopping = false,
  active = false;
let entryId: string | undefined;
let playGeneration = 0;
let activation:
  | {
      resolve: () => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  | undefined;
const send = (event: string, data: object = {}) => {
  try {
    if (process.connected) process.send?.({ nonce, event, ...data });
  } catch {
    /* parent already closed */
  }
};
process.on("unhandledRejection", () =>
  send("error", { message: "Worker operation failed" }),
);
process.on("uncaughtException", () => {
  send("error", { message: "Worker process failed" });
  const deadline = setTimeout(() => process.exit(1), 10000);
  deadline.unref();
  void shutdown().finally(() => {
    clearTimeout(deadline);
    process.exitCode = 1;
  });
});
async function shutdown() {
  if (stopping) return;
  stopping = true;
  if (activation) {
    clearTimeout(activation.timer);
    activation.reject(new AppError("STOPPED", "Worker stopped"));
    activation = undefined;
  }
  await player?.stopAndClearQueue();
  await engine?.disconnect();
  client?.destroy();
  send("stopped");
  process.disconnect?.();
}
process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());
process.on("message", async (raw: any) => {
  if (
    !raw ||
    raw.nonce !== nonce ||
    typeof raw.command !== "string" ||
    Object.keys(raw).some(
      (k) =>
        ![
          "nonce",
          "command",
          "config",
          "credential",
          "providers",
          "source",
          "entryId",
          "guildId",
          "channelId",
          "dataDir",
          "content",
        ].includes(k),
    )
  )
    return;
  try {
    if (raw.command === "init") {
      if (
        player ||
        !raw.config ||
        typeof raw.credential !== "string" ||
        !Array.isArray(raw.providers)
      )
        throw new AppError("IPC_INVALID", "Invalid initialization");
      registerSecret(raw.credential);
      if (raw.config.transport !== "experimental-selfbot")
        throw new AppError(
          "UNSUPPORTED_TRANSPORT",
          "Official command bot credentials cannot broadcast native Go Live. Select the explicit experimental account transport.",
        );
      const { Client } = await import("discord.js-selfbot-v13");
      const { DiscordPlaybackEngine } =
        await import("../services/streaming.js");
      const { openGateway } = await import("../providers/gateway.js");
      const { validateBaseUrl, allowedUrl } =
        await import("../providers/security.js");
      Object.assign(config, {
        ...raw.config.encoder,
        guildId: raw.config.guildId,
        videoChannelId: raw.config.voiceChannelId,
        videosDir: path.join(raw.dataDir, "videos"),
        previewCacheDir: path.join(raw.dataDir, "preview-cache"),
      });
      const state: any = {
        joined: false,
        joinsucc: false,
        playing: false,
        manualStop: false,
        channelInfo: { guildId: "", channelId: "", cmdChannelId: "" },
        queue: { items: [], currentIndex: -1, isPlaying: false },
      };
      const registry = new ProviderRegistry(
        raw.providers.map((p: any) => p.config),
        (p) => () =>
          raw.providers.find((v: any) => v.config.id === p.id).credentials,
      );
      client = new Client();
      engine = new DiscordPlaybackEngine(client, state, { ...config });
      const legacy = engine.resolveLegacy.bind(engine);
      engine.resolveLegacy = async (item: any, signal: AbortSignal) => {
        const value = item.originalInput || item.url;
        if (/^https?:\/\//i.test(value)) {
          const url = new URL(value),
            host = url.hostname.toLowerCase();
          if (
            !["youtube.com", "youtu.be", "twitch.tv"].some(
              (domain) => host === domain || host.endsWith("." + domain),
            )
          ) {
            const base = validateBaseUrl(url.origin);
            const gateway = await openGateway(
              base,
              allowedUrl(url.href, base),
              () => ({}),
              signal,
            );
            return {
              url: gateway.inputUrl,
              title: item.title,
              type: "url",
              close: gateway.close,
            };
          }
        }
        return legacy(item, signal);
      };
      player = new PlaybackController(
        registry,
        {
          resolveLegacy: engine.resolveLegacy.bind(engine),
          play: engine.play.bind(engine),
          disconnect: async () => {
            if (raw.config.mode !== "live") await engine.disconnect();
          },
        },
        state,
      );
      engine.onStarted = () => send("playing", { entryId });
      client.on("voiceStateUpdate", (_old: any, next: any) => {
        if (next.member?.user.id === client.user?.id)
          send("voice", { connected: !!next.channelId });
      });
      client.on("messageCreate", async (message: any) => {
        if (
          message.author.bot ||
          message.author.id === client.user?.id ||
          message.guild?.id !== raw.config.guildId ||
          !raw.config.commandChannelId ||
          message.channel.id !== raw.config.commandChannelId ||
          !message.content.startsWith(raw.config.prefix || "$")
        )
          return;
        const member = await message.guild.members
          .fetch({ user: message.author.id, force: true })
          .catch(() => null);
        if (!member) return;
        send("command", {
          content: message.content.slice((raw.config.prefix || "$").length),
          guildId: message.guild.id,
          channelId: message.channel.id,
          userId: message.author.id,
          roleIds: [...member.roles.cache.keys()],
          voiceChannelId: member.voice.channelId,
        });
      });
      await client.login(raw.credential).catch(() => {
        throw new AppError(
          "AUTH_INVALID",
          "Playback account login failed; replace the credential",
        );
      });
      if (client.user?.bot)
        throw new AppError(
          "OFFICIAL_VIDEO_UNSUPPORTED",
          "Official bot credentials cannot broadcast native Go Live",
        );
      const activated = new Promise<void>((resolve, reject) => {
        activation = {
          resolve,
          reject,
          timer: setTimeout(
            () =>
              reject(
                new AppError(
                  "ACTIVATION_TIMEOUT",
                  "Worker activation timed out",
                ),
              ),
            15000,
          ),
        };
      });
      send("identity", { accountId: client.user.id });
      await activated;
      if (raw.config.autojoin) await engine.connect();
      send("ready", { capabilities: engine.capabilities() });
    } else if (raw.command === "activate") {
      if (activation) {
        clearTimeout(activation.timer);
        activation.resolve();
        activation = undefined;
      }
    } else if (raw.command === "reply") {
      const channel = client?.channels.cache.get(raw.channelId);
      if (
        channel?.guild?.id === config.guildId &&
        typeof raw.content === "string"
      )
        await channel.send({
          content: raw.content.slice(0, 1800),
          allowedMentions: { parse: [] },
        });
    } else if (raw.command === "providers") {
      if (!player || !Array.isArray(raw.providers))
        throw new AppError("IPC_INVALID", "Invalid provider refresh");
      player.providers.replace(
        raw.providers.map((p: any) => p.config),
        (p) => () =>
          raw.providers.find((v: any) => v.config.id === p.id).credentials,
      );
    } else if (raw.command === "play") {
      if (!player || active || typeof raw.entryId !== "string" || !raw.source)
        throw new AppError("IPC_INVALID", "Worker is not ready");
      if (Array.isArray(raw.providers))
        player.providers.replace(
          raw.providers.map((p: any) => p.config),
          (p) => () =>
            raw.providers.find((v: any) => v.config.id === p.id).credentials,
        );
      active = true;
      const generation = ++playGeneration;
      entryId = raw.entryId;
      const source = raw.source as Source & { input?: string };
      try {
        if (source.reference)
          await player.enqueueProvider(source.reference, "scheduler");
        else
          await player
            .getQueueService()
            .add(
              source.local
                ? path.join(config.videosDir, path.basename(source.local))
                : source.input!,
              source.title,
              "scheduler",
              source.local ? "local" : "url",
            );
        player.start();
        await player.waitForIdle();
        send("done", { entryId: raw.entryId, error: player.lastError });
      } catch (error) {
        send("done", {
          entryId: raw.entryId,
          error:
            generation === playGeneration
              ? publicError(error).body.message
              : undefined,
        });
      } finally {
        active = false;
      }
    } else if (raw.command === "skip") {
      playGeneration++;
      await player?.stopAndClearQueue();
    } else if (raw.command === "connect") {
      if (active)
        throw new AppError(
          "BUSY",
          "Stop playback before moving voice destinations",
        );
      await engine?.connect(raw.guildId, raw.channelId);
      send("connected");
    } else if (raw.command === "disconnect") {
      if (active)
        throw new AppError("BUSY", "Stop playback before disconnecting voice");
      await engine?.disconnect();
      send("disconnected");
    } else if (raw.command === "stop") await shutdown();
    else throw new AppError("IPC_INVALID", "Unknown worker command");
  } catch (error) {
    send("error", {
      message: publicError(error).body.message,
      code: error instanceof AppError ? error.code : "WORKER_ERROR",
    });
    if (raw.command === "init") {
      await shutdown();
      process.exitCode = 1;
    }
  }
});
send("hello");
setInterval(() => {
  send("metrics", {
    rss: process.memoryUsage().rss,
    cpu: process.cpuUsage(),
    ffmpeg: !!engine?.ffmpegRunning,
  });
}, 5000).unref();
