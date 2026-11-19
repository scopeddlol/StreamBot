import { test, expect } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { AppStore } from "../src/tv/store.js";
import { Auth } from "../src/tv/auth.js";
test("pairing is one-time and concurrent claims cannot create another owner; sessions survive reopening and revoke", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "streambot-auth-"));
  let store = new AppStore(dir);
  try {
    let code = "";
    const auth = new Auth(store, (message) => {
      code = message.split(": ").pop()!;
    });
    await expect(
      auth.claim("bad", "owner", "fixture-very-strong-password"),
    ).rejects.toThrow("Pairing");
    const results = await Promise.allSettled([
      auth.claim(code, "owner", "fixture-very-strong-password"),
      auth.claim(code, "other", "fixture-very-strong-password"),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const token = (
      results.find(
        (r) => r.status === "fulfilled",
      ) as PromiseFulfilledResult<string>
    ).value;
    expect(auth.user(token)?.role).toBe("owner");
    await expect(
      auth.claim(code, "other", "fixture-very-strong-password"),
    ).rejects.toThrow();
    store.close();
    store = new AppStore(dir);
    const next = new Auth(store, () => {
      throw Error("Pairing replay");
    });
    expect(next.user(token)?.role).toBe("owner");
    next.logout(token);
    expect(next.user(token)).toBeUndefined();
    await expect(next.login("admin", "admin")).rejects.toThrow("Invalid");
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
