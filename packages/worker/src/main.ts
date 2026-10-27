import { loadConfig } from "@stardust/config";

const configPath = process.env.STARDUST_CONFIG ?? "stardust.yaml";

try {
  await loadConfig(configPath);
  console.log("stardust worker started (no job types registered yet)");
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
