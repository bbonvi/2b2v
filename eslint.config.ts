import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // Base recommended rules
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,

  // Global ignores
  {
    ignores: ["node_modules/", ".dev/", ".ck/", "**/*.js"],
  },

  // TypeScript source files
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // --- Tier 1: Catches real bugs ---

      // Force proper typing at boundaries instead of `as any` escape hatches
      "@typescript-eslint/no-explicit-any": "error",

      // Forgetting `await` silently drops errors — production bugs
      "@typescript-eslint/no-floating-promises": "error",

      // Passing async where sync is expected — subtle, nasty
      "@typescript-eslint/no-misused-promises": "error",

      // Prevents `if (str)` when "" is valid; forces explicit checks
      "@typescript-eslint/strict-boolean-expressions": [
        "error",
        {
          allowString: false,
          allowNumber: false,
          allowNullableObject: true,
          allowNullableBoolean: false,
          allowNullableString: false,
          allowNullableNumber: false,
          allowAny: false,
        },
      ],

      // Exhaustive switch on discriminated unions — compiler catches missing cases
      "@typescript-eslint/switch-exhaustiveness-check": "error",

      // Ban enums; use `as const` objects instead
      "no-restricted-syntax": [
        "error",
        {
          selector: "TSEnumDeclaration",
          message: "Use `as const` objects instead of enums.",
        },
      ],

      // === always; no type coercion surprises
      eqeqeq: ["error", "always"],

      // --- Tier 2: Enforces idioms, prevents drift ---

      // Separate type imports — required by verbatimModuleSyntax anyway
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],

      // Catches dead code from over-defensive null guards
      "@typescript-eslint/no-unnecessary-condition": "error",

      // ?? over || — prevents falsy-value bugs with 0, "", false
      "@typescript-eslint/prefer-nullish-coalescing": "error",

      // Catch unused variables; allow _ prefix for intentional ignores
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],

      // Ban ! postfix — force explicit narrowing
      "@typescript-eslint/no-non-null-assertion": "error",

      // --- Relaxations from strictTypeChecked that don't apply here ---

      // Allow void expressions for fire-and-forget (common in event handlers)
      "@typescript-eslint/no-confusing-void-expression": "off",

      // Template literal types are fine
      "@typescript-eslint/restrict-template-expressions": [
        "error",
        { allowNumber: true, allowBoolean: true },
      ],

      // Empty functions are fine for no-op callbacks
      "@typescript-eslint/no-empty-function": "off",

      // Disable base rule in favor of TS version
      "no-unused-vars": "off",
    },
  },
);
