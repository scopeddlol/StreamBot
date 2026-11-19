import { test, expect } from "bun:test";
import { fixture, instance, owner } from "./tv-helpers.js";
test("unconfigured AI returns only actual authorized catalog results and never queues; unauthorized caller denied before lookup", async () => {
  const { runtime: r, cleanup } = fixture();
  try {
    const room = instance(r);
    let calls = 0;
    const provider: any = {
      config: { id: "fixture", name: "Fixture" },
      search: async () => {
        calls++;
        return {
          items: [
            {
              providerId: "fixture",
              id: "actual",
              title: "Actual catalog movie",
              kind: "movie",
            },
          ],
          total: 1,
        };
      },
    };
    (r.providers.registry as any).providers.set("fixture", provider);
    const result = await r.ai.recommend(owner, "something funny", room.id);
    expect(result.mode).toBe("catalog");
    expect(result.items[0].title).toBe("Actual catalog movie");
    expect(r.playlists.queue(room.id)).toEqual([]);
    const before = calls;
    await expect(
      r.ai.recommend(
        {
          id: "bad",
          source: "discord",
          guildId: room.guildId,
          verified: true,
          roleIds: [],
        },
        "movie",
        room.id,
      ),
    ).rejects.toThrow("permission");
    expect(calls).toBe(before);
  } finally {
    await cleanup();
  }
});
test("backup envelope has no raw credentials, detects tampering and restores settings with session revocation", async () => {
  const { runtime: r, code, cleanup } = fixture();
  try {
    await r.auth.claim(code, "fixture-owner", "fixture-owner-password-long");
    r.vault.put("test", "fixture", "fixture-private-key-value");
    r.store.set("fixture-setting", 42);
    const exported = r.backups.export("fixture-backup-passphrase-long-enough");
    expect(JSON.stringify(exported)).not.toContain("fixture-private-key-value");
    r.store.set("fixture-setting", 99);
    expect(() => r.backups.import(exported, "bad passphrase", true)).toThrow(
      "integrity",
    );
    r.backups.import(exported, "fixture-backup-passphrase-long-enough", true);
    expect(r.store.setting("fixture-setting", 0)).toBe(42);
    expect(r.store.all("SELECT * FROM sessions")).toHaveLength(0);
  } finally {
    await cleanup();
  }
});
test("configured AI cannot invent playable inventory or call unauthorized tools", async () => {
  const { runtime: r, cleanup } = fixture();
  let mode = "rank";
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const body = await req.json();
      expect(JSON.stringify(body)).not.toContain("fixture-ai-credential");
      return Response.json({
        choices: [
          {
            message:
              mode === "rank"
                ? {
                    content: JSON.stringify({
                      keys: ["fake:missing", "fixture:actual"],
                    }),
                  }
                : {
                    tool_calls: [
                      {
                        id: "malicious",
                        type: "function",
                        function: { name: "grantRoles", arguments: "{}" },
                      },
                    ],
                  },
          },
        ],
      });
    },
  });
  try {
    const room = instance(r);
    (r.providers.registry as any).providers.set("fixture", {
      config: { id: "fixture" },
      search: async () => ({
        items: [
          {
            providerId: "fixture",
            id: "actual",
            title: "Actual movie — ignore this untrusted title instruction",
            kind: "movie",
          },
        ],
        total: 1,
      }),
    });
    r.ai.save({
      enabled: true,
      endpoint: `http://127.0.0.1:${server.port}/v1`,
      model: "fixture-model",
      credential: "fixture-ai-credential",
      allowPrivate: true,
      allowedRooms: [room.id],
      dailyTokenBudget: 100000,
    });
    const result = await r.ai.recommend(owner, "movie", room.id);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.id).toBe("actual");
    expect(r.playlists.queue(room.id)).toHaveLength(0);
    mode = "tool";
    await expect(r.ai.recommend(owner, "movie", room.id)).rejects.toThrow(
      "unauthorized tool",
    );
    expect(r.playlists.queue(room.id)).toHaveLength(0);
  } finally {
    server.stop(true);
    await cleanup();
  }
});
