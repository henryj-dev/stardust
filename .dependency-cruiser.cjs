/**
 * Boundary rules. Every rule has a violating fixture in
 * tools/fixtures/deps/ and tools/dependency-rules.test.ts checks that each
 * fixture is stopped by exactly that rule.
 */
const SRC = "^(packages|plugins)/";

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "no-circular",
      severity: "error",
      from: { path: SRC },
      to: { circular: true },
    },
    {
      name: "core-is-pure",
      comment: "core holds the domain and the plugin contract; it depends on nothing else in the repo.",
      severity: "error",
      from: { path: "^packages/core/" },
      to: { path: "^(packages/(?!core/)|plugins/)" },
    },
    {
      name: "plugins-only-use-core",
      comment: "A plugin implements contracts from core and must not reach into server, worker or web.",
      severity: "error",
      from: { path: "^plugins/" },
      to: { path: "^packages/(?!core/)" },
    },
    {
      name: "plugins-are-isolated",
      comment: "Plugins never import each other; shared code belongs in core.",
      severity: "error",
      from: { path: "^plugins/([^/]+)/" },
      to: { path: "^plugins/", pathNot: "^plugins/$1/" },
    },
    {
      name: "web-only-uses-sdk",
      comment: "The dashboard talks to the API through the generated client only.",
      severity: "error",
      from: { path: "^packages/web/" },
      to: { path: "^(packages/(?!web/|sdk/)|plugins/)" },
    },
    {
      name: "sdk-is-standalone",
      comment: "The client is generated from the API contract, not from server code.",
      severity: "error",
      from: { path: "^packages/sdk/" },
      to: { path: "^(packages/(?!sdk/)|plugins/)" },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    exclude: { path: "(\\.svelte-kit|/build/|/fixtures/)" },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      extensions: [".ts", ".js"],
      exportsFields: ["exports"],
      conditionNames: ["import", "default"],
    },
  },
};
