/** Architecture boundary rules (docs/02 section 5, FR-GW-2, FR-EXT-1). Violations fail CI. */
module.exports = {
  forbidden: [
    {
      name: "clients-only-use-protocol",
      comment: "CLI/TUI/UI/apps are Gateway clients: no imports from src/ (Gateway internals).",
      severity: "error",
      from: { path: "^packages/(cli|tui|control-ui)/" },
      to: { path: "^src/" },
    },
    {
      name: "extensions-only-use-plugin-sdk",
      comment: "Extensions may import only the plugin SDK (plus third-party deps).",
      severity: "error",
      from: { path: "^extensions/" },
      to: { path: "^(src|packages)/", pathNot: "^packages/plugin-sdk/" },
    },
    {
      name: "extensions-are-independent",
      comment: "An extension must not import another extension.",
      severity: "error",
      from: { path: "^extensions/([^/]+)/" },
      to: { path: "^extensions/", pathNot: "^extensions/$1/" },
    },
    {
      name: "packages-do-not-import-core",
      comment: "Shared packages must not depend on the Gateway/core under src/.",
      severity: "error",
      from: { path: "^packages/" },
      to: { path: "^src/" },
    },
    {
      name: "protocol-and-sdk-are-leaf-packages",
      comment: "protocol and plugin-sdk depend on nothing else in this repo.",
      severity: "error",
      from: { path: "^packages/(protocol|plugin-sdk)/" },
      to: { path: "^(src|extensions)/|^packages/(cli|tui|control-ui|brand)/" },
    },
    {
      name: "no-circular",
      severity: "error",
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    exclude: { path: "(^|/)(dist|node_modules)/" },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.depcruise.json" },
    moduleSystems: ["es6", "cjs"],
  },
};
