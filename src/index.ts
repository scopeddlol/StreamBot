import path from "node:path";
import { TVRuntime } from "./tv/runtime.js";
import { createTVApp } from "./tv/server.js";
const runtime = new TVRuntime(path.resolve(process.env.DATA_DIR || "./data"));
const app = createTVApp(runtime);
const port = Number(process.env.SERVER_PORT || 3000);
const server = app.listen(port, process.env.SERVER_HOST || "127.0.0.1", () =>
  console.info(
    `StreamBot TV listening on port ${port}; open the local dashboard for onboarding.`,
  ),
);
void runtime.recover();
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  server.close();
  const deadline = setTimeout(() => process.exit(1), 40000);
  deadline.unref();
  const clean = await runtime.shutdown();
  server.closeAllConnections();
  if (clean) clearTimeout(deadline);
  else deadline.ref();
}
process.once("SIGTERM", () => void stop());
process.once("SIGINT", () => void stop());
