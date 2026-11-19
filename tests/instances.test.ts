import { test, expect } from "bun:test";
import { fixture, instance, until } from "./tv-helpers.js";
test("eight independently supervised workers, configurable ninth, destination/account conflicts and targeted stop", async () => {
  const { runtime: r, cleanup } = fixture();
  try {
    const rooms = Array.from({ length: 9 }, (_, i) => instance(r, i));
    await Promise.all(
      rooms.slice(0, 8).map((room) => r.instances.start(room.id)),
    );
    expect(r.instances.list().filter((v) => v.state === "ready")).toHaveLength(
      8,
    );
    await expect(r.instances.start(rooms[8].id)).rejects.toThrow("limit");
    r.store.set("limits", { maxWorkers: 9, maxFfmpeg: 9 });
    await r.instances.start(rooms[8].id);
    expect(r.instances.list().filter((v) => v.state === "ready")).toHaveLength(
      9,
    );
    await r.instances.stop(rooms[0].id);
    expect(r.instances.get(rooms[1].id).state).toBe("ready");
    await r.instances.restart(rooms[0].id);
    await r.instances.connect(rooms[0].id);
    expect(r.instances.get(rooms[0].id).state).toBe("ready");
    const copy = r.instances.duplicate(rooms[0].id);
    expect(copy.secret.configured).toBe(false);
    await expect(r.instances.start(copy.id)).rejects.toThrow("Acknowledge");
    const bad = instance(r, 20, {
      credential: "fixture-playback-credential-1",
    });
    r.store.set("limits", { maxWorkers: 20, maxFfmpeg: 9 });
    await expect(r.instances.start(bad.id)).rejects.toThrow("account");
    const conflict = instance(r, 21, {
      voiceChannelId: rooms[1].voiceChannelId,
    });
    await expect(r.instances.start(conflict.id)).rejects.toThrow("destination");
  } finally {
    await cleanup();
  }
}, 20000);
test("official control token cannot silently become a video broadcaster", async () => {
  const { runtime: r, cleanup } = fixture();
  try {
    const room = instance(r, 0, { transport: "official-control-only" });
    await expect(r.instances.start(room.id)).rejects.toThrow("Official bots");
  } finally {
    await cleanup();
  }
});
test("different credentials resolving to the same account are rejected before activation", async () => {
  const { runtime: r, cleanup } = fixture();
  try {
    const a = instance(r, 1),
      b = instance(r, 2, { credential: "different-fixture-token-1" });
    await r.instances.start(a.id);
    await expect(r.instances.start(b.id)).rejects.toThrow("account identity");
    expect(r.instances.get(a.id).state).toBe("ready");
  } finally {
    await cleanup();
  }
});
