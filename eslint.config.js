import js from "@eslint/js";
import globals from "globals";

export default [
  js.configs.recommended,
  {
    files: ["src/**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        ...globals.node,
        fetch: "readonly"
      }
    },
    rules: {
      // Unused vars are errors; prefix with _ to intentionally suppress
      "no-unused-vars": ["error", {
        argsIgnorePattern: "^_",
        varsIgnorePattern: "^_",
        caughtErrorsIgnorePattern: "^_"
      }],
      // Allow empty catch blocks (used widely for non-critical I/O)
      "no-empty": ["error", { allowEmptyCatch: true }],
      "no-console": "off"
    }
  }
];
