/** @type {import("eslint").Linter.FlatConfig[]} */
module.exports = [
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      parser: require("@typescript-eslint/parser"),
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
      },
    },
    plugins: {
      "@typescript-eslint": require("@typescript-eslint/eslint-plugin"),
    },
    rules: {
      "no-console": ["warn", { allow: ["warn", "error"] }],
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/consistent-type-imports": "warn",
      eqeqeq: ["error", "smart"],
      // Drizzle hygiene (audit H4): a top-level `const X = sql\`…\`` is
      // almost always a footgun — the fragment gets inlined as raw SQL
      // when it's interpolated into another sql`` tag at the call site,
      // bypassing Drizzle's parameter binder. Prefer typed builders
      // (eq, inArray, and, or, …) or bind arrays explicitly via
      // `${jsArray}::text[]`. Inline sql`` (e.g. ORDER BY fragments
      // returned from a function) is fine; this rule only flags
      // module-level const assignments.
      "no-restricted-syntax": [
        "warn",
        {
          selector:
            "Program > VariableDeclaration > VariableDeclarator > TaggedTemplateExpression[tag.name='sql']",
          message:
            "Top-level `const = sql``...``` is a Drizzle footgun (inlined as raw SQL when nested into another sql`` tag, not parameter-bound). Use a typed builder (inArray, eq, and, …) or bind arrays inline via `${arr}::text[]`. See SECURITY NOTE in services/api/src/modules/community/routes.ts.",
        },
      ],
    },
  },
];
