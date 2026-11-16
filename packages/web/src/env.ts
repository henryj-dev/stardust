import { defineEnvVars } from "@sveltejs/kit/env";

export const variables = defineEnvVars({
  STARDUST_API_URL: {
    description: "Base URL of the stardust API, as reachable from the web server.",
    schema: (value) => value || "http://localhost:8080",
  },
  STARDUST_HOME_REGION: {
    description: "Optional, with STARDUST_REGIONS: this installation's region, reached at STARDUST_API_URL.",
    schema: (value) => value ?? "",
  },
  STARDUST_REGIONS: {
    description:
      "Optional: several regions shown as one, as name=https://…,name=https://… (the home region is the one at STARDUST_API_URL).",
    schema: (value) => value ?? "",
  },
});
