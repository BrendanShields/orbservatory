import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      // The transcript normalizers intentionally handle provider-specific JSON
      // shapes with pragmatic `any` casts. Keep lint useful without requiring a
      // full schema rewrite as part of the Next port.
      "@typescript-eslint/no-explicit-any": "off",
      "prefer-const": "off",
      "@typescript-eslint/no-unused-expressions": "off",
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Project build artifacts:
    ".build/**",
    "dist/**",
  ]),
]);

export default eslintConfig;
