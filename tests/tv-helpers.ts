import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { TVRuntime } from "../src/tv/runtime.js";
export function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "streambot-tv-test-"));
  let code = "";
  const runtime = new TVRuntime(
    dir,
    (message) => {
      code = message.split(": ").pop()!;
    },
    fileURLToPath(new URL("./fixtures/worker.ts", import.meta.url)),
  );
  return {
    runtime,
    dir,
    code,
    cleanup: async () => {
      await runtime.shutdown();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
export const owner: any = { id: "fixture-owner", role: "owner", source: "web" };
export function instance(runtime: TVRuntime, index = 0, options: any = {}) {
  return runtime.instances.save({
    name: `Fixture ${index}`,
    mode: "on-demand",
    transport: "experimental-selfbot",
    riskAccepted: true,
    guildId: "100000000000000001",
    voiceChannelId: String(200000000000000000n + BigInt(index)),
    credential: `fixture-playback-credential-${index}`,
    maxRetries: 0,
    ...options,
  });
}
export async function until(fn: () => boolean, timeout = 5000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (fn()) return;
    await Bun.sleep(10);
  }
  throw new Error("Condition timed out");
}
