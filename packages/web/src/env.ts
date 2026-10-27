import { defineEnvVars } from "@sveltejs/kit/env";

export const variables = defineEnvVars({
  STARDUST_API_URL: {
    description: "Base URL of the stardust API, as reachable from the web server.",
    schema: (value) => value || "http://localhost:8080",
  },
});
