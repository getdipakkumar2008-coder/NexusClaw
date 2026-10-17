import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: [".dependency-cruiser.cjs", "**/dist/**", "**/node_modules/**", "spikes/**", "tools/**", "docs/**", "release/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "no-console": "error",
    },
  },
  {
    // Plugins run in Node 22+ and use its built-in web APIs.
    files: ["extensions/**/*.mjs"],
    languageOptions: {
      globals: { fetch: "readonly", AbortSignal: "readonly", AbortController: "readonly", setTimeout: "readonly", clearTimeout: "readonly", setInterval: "readonly", clearInterval: "readonly", WebSocket: "readonly", process: "readonly", Buffer: "readonly", URL: "readonly", URLSearchParams: "readonly", FormData: "readonly", Blob: "readonly" },
    },
  },
  {
    // Browser scripts shipped to visitors run in a browser, not in Node.
    files: ["src/channels/assets/**/*.js"],
    languageOptions: {
      sourceType: "script",
      globals: { window: "readonly", document: "readonly", WebSocket: "readonly", Uint8Array: "readonly" },
    },
  },
);
