import { test, expect } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { fixture } from "./tv-helpers.js";
import { LegacyImport } from "../src/tv/migration.js";
test("one-time legacy import preserves stable provider IDs, encrypts environment credentials and leaves operator files intact", async () => {
  const { runtime: r, cleanup, dir } = fixture();
  try {
    const root = path.join(dir, "legacy");
    fs.mkdirSync(path.join(root, "config"), { recursive: true });
    const env =
      "TOKEN=fixture-old-account\nPREFIX=$\nGUILD_ID=100000000000000001\nVIDEO_CHANNEL_ID=200000000000000001\nCOMMAND_CHANNEL_ID=300000000000000001\nFIXTURE_LEGACY_KEY=fixture-old-provider-token\n";
    fs.writeFileSync(path.join(root, ".env"), env);
    fs.writeFileSync(
      path.join(root, "config/media-servers.json"),
      JSON.stringify({
        servers: [
          {
            id: "existing-stable-id",
            name: "Legacy fixture",
            kind: "jellyfin",
            baseUrl: "http://127.0.0.1:8096",
            credentialEnv: "FIXTURE_LEGACY_KEY",
          },
        ],
      }),
    );
    const migration = new LegacyImport(
      r.store,
      r.vault,
      r.providers,
      r.instances,
      root,
    );
    expect(migration.summary().available).toBe(true);
    migration.run(true);
    expect(r.providers.list()[0].id).toBe("existing-stable-id");
    expect(
      JSON.stringify(r.store.all("SELECT * FROM secret_records")),
    ).not.toContain("fixture-old-provider-token");
    const room = r.instances.list()[0];
    expect(room.autostart).toBe(false);
    expect(room.riskAccepted).toBe(false);
    expect(room.commandChannelId).toBe("300000000000000001");
    expect(fs.readFileSync(path.join(root, ".env"), "utf8")).toBe(env);
    expect(() => migration.run(true)).toThrow("already");
  } finally {
    await cleanup();
  }
});
