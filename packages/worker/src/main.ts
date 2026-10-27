import { loadConfig } from "@stardust/config";

const configPath = process.env.STARDUST_CONFIG ?? "stardust.yaml";

try {
  await loadConfig(configPath);
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}

// No job types exist yet; stay up until asked to stop so the process behaves
// like the long-running worker it will become.
const keepAlive = setInterval(() => {}, 1 << 30);
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    clearInterval(keepAlive);
    console.log(`stardust worker stopping (${signal})`);
  });
}
console.log("stardust worker started (no job types registered yet)");
