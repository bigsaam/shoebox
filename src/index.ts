import { loadConfig } from "./config.js";
import { buildServer, startSweeper } from "./server.js";

const cfg = loadConfig();
const { app, store } = await buildServer(cfg);
startSweeper(store);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void app.close().then(() => process.exit(0));
  });
}

await app.listen({ port: cfg.port, host: cfg.host });
