import { test, expect } from "bun:test";
import { fixture, instance } from "./tv-helpers.js";
import { AppStore } from "../src/tv/store.js";
test("persistent live TV cycles, repeat one, removal/reorder during playback and optimistic conflict", async () => {
  const { runtime: r, cleanup } = fixture();
  try {
    const room = instance(r, 0, { mode: "live" });
    const sources = Array.from({ length: 10 }, (_, n) => ({
      title: `Movie ${n}`,
      local: `fixture-${n}.mp4`,
    }));
    r.playlists.add(room.id, sources, "owner", true);
    let list = r.playlists.playlist(room.id);
    r.playlists.edit(room.id, { revision: list.revision, repeat: "all" });
    for (let i = 0; i < 12; i++) {
      const next = r.playlists.next(room.id, true)!;
      expect(next.source.title).toBe(`Movie ${i % 10}`);
      r.playlists.begin(room.id, next);
      r.playlists.finish(room.id, next);
    }
    list = r.playlists.playlist(room.id);
    r.playlists.edit(room.id, { revision: list.revision, repeat: "one" });
    const first = r.playlists.next(room.id, true)!;
    r.playlists.begin(room.id, first);
    r.playlists.finish(room.id, first);
    expect(r.playlists.next(room.id, true)?.id).toBe(first.id);
    list = r.playlists.playlist(room.id);
    r.playlists.edit(room.id, { revision: list.revision, remove: [first.id] });
    r.playlists.finish(room.id, first, true);
    expect(r.playlists.next(room.id, true)?.source.title).toBe("Movie 3");
    expect(() =>
      r.playlists.edit(room.id, { revision: 0, clear: true }),
    ).toThrow("changed");
    const reopened = new AppStore(r.dir);
    expect(reopened.get("SELECT count(*) AS n FROM playlist_entries").n).toBe(
      9,
    );
    expect(
      reopened.get(
        "SELECT cycle FROM playback_checkpoints WHERE instance_id=?",
        room.id,
      ).cycle,
    ).toBe(1);
    reopened.close();
  } finally {
    await cleanup();
  }
});
test("stable shuffle survives reopening and single-item repeat all loops", async () => {
  const { runtime: r, cleanup } = fixture();
  try {
    const room = instance(r, 0, { mode: "live" });
    r.playlists.add(
      room.id,
      [{ title: "Only movie", local: "fixture.mp4" }],
      "owner",
      true,
    );
    const p = r.playlists.playlist(room.id);
    r.playlists.edit(room.id, {
      revision: p.revision,
      repeat: "all",
      shuffle: true,
    });
    for (let i = 0; i < 3; i++) {
      const next = r.playlists.next(room.id, true)!;
      expect(next.source.title).toBe("Only movie");
      r.playlists.begin(room.id, next);
      r.playlists.finish(room.id, next);
    }
    expect(r.store.get("SELECT cycle FROM playback_checkpoints").cycle).toBe(3);
  } finally {
    await cleanup();
  }
});
test("saved playlist duplicate/select and reference export never include private URL credentials", async () => {
  const { runtime: r, cleanup } = fixture();
  try {
    const room = instance(r, 0, { mode: "live" });
    const secret = r.vault.put(
      "legacy-input",
      room.id,
      "https://example.invalid/video?grant=fixture-private",
    );
    r.playlists.add(
      room.id,
      [
        { title: "Local", local: "fixture.mp4" },
        { title: "Private input", inputSecretId: secret },
      ],
      "owner",
      true,
    );
    const original = r.playlists.playlist(room.id),
      copy = r.playlists.duplicate(room.id, "Saved copy");
    expect(r.playlists.saved(room.id)).toHaveLength(2);
    expect(r.playlists.playlist(room.id).id).toBe(original.id);
    r.playlists.select(room.id, copy.id);
    expect(r.playlists.playlist(room.id).config.name).toBe("Saved copy");
    const exported = r.playlists.exportReferences(room.id);
    expect(exported.items).toEqual([{ local: "fixture.mp4" }]);
    expect(exported.excludedPrivateInputs).toBe(1);
    expect(JSON.stringify(exported)).not.toContain(secret);
    expect(JSON.stringify(exported)).not.toContain("grant");
  } finally {
    await cleanup();
  }
});
test("temporary live play-now queue preserves the channel cursor", async () => {
  const { runtime: r, cleanup } = fixture();
  try {
    const room = instance(r, 0, { mode: "live" });
    r.playlists.add(
      room.id,
      [
        { title: "One", local: "one" },
        { title: "Two", local: "two" },
        { title: "Three", local: "three" },
      ],
      "owner",
      true,
    );
    const a = r.playlists.next(room.id, true)!;
    r.playlists.begin(room.id, a);
    r.playlists.finish(room.id, a);
    r.playlists.add(room.id, [{ title: "Temporary", local: "temp" }], "owner");
    const request = r.playlists.next(room.id, true)!;
    expect(request.source.title).toBe("Temporary");
    r.playlists.begin(room.id, request);
    r.playlists.finish(room.id, request);
    expect(r.playlists.next(room.id, true)?.source.title).toBe("Two");
  } finally {
    await cleanup();
  }
});
