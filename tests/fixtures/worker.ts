// Disposable test-only worker. Production instance validation never offers a mock transport.
import { randomBytes } from "node:crypto";
const nonce = randomBytes(32).toString("hex");
let timer: ReturnType<typeof setTimeout> | undefined;
let current: string | undefined;
const send = (event: string, data: object = {}) =>
  process.send?.({ nonce, event, ...data });
process.on("message", (message: any) => {
  if (message?.nonce !== nonce) return;
  if (message.command === "init")
    send("identity", {
      accountId: String(
        400000000000000000n +
          BigInt(message.credential.match(/(\d+)$/)?.[1] || 0),
      ),
    });
  if (message.command === "activate") send("ready");
  if (message.command === "play") {
    current = message.entryId;
    send("playing", { entryId: current });
    if (message.source.title === "crash") {
      process.exit(2);
    }
    if (message.source.title !== "hang")
      timer = setTimeout(() => {
        send("done", {
          entryId: current,
          error:
            message.source.title === "broken"
              ? "fixture media failed"
              : undefined,
        });
        current = undefined;
      }, 100);
  }
  if (message.command === "skip") {
    clearTimeout(timer);
    if (current) send("done", { entryId: current });
    current = undefined;
  }
  if (message.command === "connect") send("connected");if(message.command==="disconnect")send("disconnected");
  if (message.command === "stop") {
    clearTimeout(timer);
    if (current) send("done", { entryId: current });
    send("stopped");
    process.disconnect?.();
  }
});
send("hello");
setInterval(
  () =>
    send("metrics", {
      rss: process.memoryUsage().rss,
      cpu: process.cpuUsage(),
      ffmpeg: !!current,
    }),
  100,
).unref();
