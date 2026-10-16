import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: [".dependency-cruiser.cjs", "**/dist/**", "**/node_modules/**", "spikes/**", "tools/**", "docs/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "no-console": "error",
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
