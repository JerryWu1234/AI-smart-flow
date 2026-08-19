import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "coverage/**",
      ".agents/**",
      ".smartflow-e2e/**",
      "eslint.config.js",
      "scripts/**",
      "tests/fixtures/**"
    ]
  },
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        project: ["./tsconfig.tests.json"],
        tsconfigRootDir: import.meta.dirname
      }
    },
    rules: {
      "@typescript-eslint/explicit-function-return-type": "error",
      "@typescript-eslint/no-confusing-void-expression": "off"
    }
  },
  {
    ...tseslint.configs.disableTypeChecked,
    files: [
      "tsdown*.config.mjs",
      "apps/flow-visualizer/src/**/*.js",
      "apps/flow-visualizer/scripts/**/*.mjs"
    ],
    rules: {
      ...tseslint.configs.disableTypeChecked.rules,
      "@typescript-eslint/explicit-function-return-type": "off"
    }
  }
);
