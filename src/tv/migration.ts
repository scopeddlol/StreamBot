import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { AppStore } from "./store.js";
import { Vault } from "./vault.js";
import { RuntimeProviders } from "./providers.js";
import { InstanceManager } from "./instances.js";
import { AppError } from "./errors.js";
import { ProviderRegistry } from "../providers/registry.js";
export class LegacyImport {
  constructor(
    readonly store: AppStore,
    readonly vault: Vault,
    readonly providers: RuntimeProviders,
    readonly instances: InstanceManager,
    readonly root = process.cwd(),
    private source?: () => { env: any; configs: any[] },
  ) {}
  private legacy() {
    if (this.source) return this.source();
    const file = path.join(this.root, ".env");
    const env = {
      ...(fs.existsSync(file) ? dotenv.parse(fs.readFileSync(file)) : {}),
      ...process.env,
    };
    const configFile =
      env.MEDIA_SERVERS_CONFIG ||
      path.join(this.root, "config/media-servers.json");
    let configs: any[] = [];
    if (fs.existsSync(configFile)) {
      try {
        configs = JSON.parse(fs.readFileSync(configFile, "utf8")).servers;
        if (!Array.isArray(configs)) throw Error();
      } catch {
        throw new AppError("LEGACY_JSON", "Legacy provider JSON is invalid");
      }
    }
    return { env, configs };
  }
  upload(
    environment: unknown,
    config: unknown,
    confirm: boolean,
    createInstance = false,
  ) {
    if (
      typeof environment !== "string" ||
      environment.length > 131072 ||
      !config ||
      typeof config !== "object" ||
      !Array.isArray((config as any).servers) ||
      (config as any).servers.length > 100
    )
      throw new AppError(
        "LEGACY_UPLOAD",
        "Choose a legacy .env text file and provider JSON (maximum 100 sources)",
      );
    const env = dotenv.parse(environment),
      configs = (config as any).servers;
    const importer = new LegacyImport(
      this.store,
      this.vault,
      this.providers,
      this.instances,
      this.root,
      () => ({ env, configs }),
    );
    return confirm ? importer.run(createInstance) : importer.summary();
  }
  summary() {
    const data = this.legacy();
    return {
      available: !!(data.configs.length || data.env.TOKEN),
      imported: this.store.setting("legacy-imported", false),
      providers: data.configs.map((c) => ({
        id: c.id,
        name: c.name,
        kind: c.kind,
        exists: !!this.store.get(
          "SELECT id FROM media_providers WHERE id=?",
          c.id,
        ),
      })),
      discordConfigured: !!data.env.TOKEN,
      warning:
        "Import does not start a playback account or delete your existing files. Review, verify, then remove/rotate external legacy secrets.",
    };
  }
  run(createInstance = false) {
    if (this.store.setting("legacy-imported", false))
      throw new AppError(
        "ALREADY_IMPORTED",
        "Legacy import already completed",
        409,
      );
    const { env, configs } = this.legacy();
    this.store.db.transaction(() => {
      for (const config of configs) {
        if (
          this.store.get("SELECT id FROM media_providers WHERE id=?", config.id)
        )
          continue;
        const credentials = {
          token: env[config.credentialEnv],
          username: env[config.usernameEnv],
          password: env[config.passwordEnv],
        };
        new ProviderRegistry([config], () => () => credentials);
        const normalized = {
          id: config.id,
          name: config.name,
          kind: config.kind,
          baseUrl: config.baseUrl,
          userId: config.userId,
        };
        const secret = this.vault.put(
          "media-provider",
          config.id,
          JSON.stringify(credentials),
        );
        this.store.run(
          "INSERT INTO media_providers VALUES(?,?,?,0)",
          config.id,
          JSON.stringify(normalized),
          secret,
        );
      }
      this.providers.refresh();
      if (createInstance) {
        if (!env.TOKEN)
          throw new AppError("NO_LEGACY_TOKEN", "No legacy token detected");
        this.instances.save({
          name: "Imported playback account — review before starting",
          mode: "on-demand",
          transport: "experimental-selfbot",
          guildId: env.GUILD_ID,
          voiceChannelId: env.VIDEO_CHANNEL_ID,
          credential: env.TOKEN,
          prefix: env.PREFIX || "$",
          commandChannelId: env.COMMAND_CHANNEL_ID || "",
          autostart: false,
          autojoin: false,
          riskAccepted: false,
          encoder: {
            width: Number(env.STREAM_WIDTH || 1280),
            height: Number(env.STREAM_HEIGHT || 720),
            fps: Number(env.STREAM_FPS || 30),
            bitrateKbps: Number(env.STREAM_BITRATE_KBPS || 2000),
          },
        });
      }
      this.store.set("legacy-imported", true);
    })();
    this.providers.refresh();
    return this.summary();
  }
}
