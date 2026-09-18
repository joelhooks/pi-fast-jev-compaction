import { defineConfig } from "oxlint";
import core from "ultracite/oxlint/core";

export default defineConfig({
  extends: [core],
  ignorePatterns: core.ignorePatterns,
  options: {
    typeAware: true,
  },
  rules: {
    complexity: "off",
    "consistent-type-specifier-style": "off",
    curly: "off",
    "func-style": "off",
    "import-style": "off",
    "no-array-sort": "off",
    "no-use-before-define": "off",
    "numeric-separators-style": "off",
    "prefer-destructuring": "off",
    "promise/avoid-new": "off",
    "require-await": "off",
    "sort-keys": "off",
    "typescript/consistent-type-exports": "off",
    "typescript/no-base-to-string": "off",
    "typescript/no-confusing-void-expression": "off",
    "typescript/no-unsafe-argument": "off",
    "typescript/no-unsafe-assignment": "off",
    "typescript/no-unsafe-member-access": "off",
    "typescript/no-unsafe-return": "off",
    "typescript/no-unsafe-type-assertion": "off",
    "typescript/prefer-nullish-coalescing": "off",
    "typescript/promise-function-async": "off",
    "typescript/return-await": "off",
    "typescript/strict-boolean-expressions": "off",
  },
});
