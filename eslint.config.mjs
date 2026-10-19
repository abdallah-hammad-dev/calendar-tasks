import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["main.js", "node_modules/", "test-vault/", "*.mjs", "scripts/", "tools/"] },
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/require-await": "off",
      "no-console": ["error", { allow: ["debug", "warn", "error"] }],
    },
  },
  {
    // The extension runs on Obsidian mobile: no Node APIs in shipped code. HTTP goes through requestUrl.
    files: ["src/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [{ group: ["node:*"], message: "No Node APIs: the extension must load on mobile." }],
          paths: ["fs", "path", "os", "child_process", "http", "https", "url", "crypto", "events"].map((name) => ({
            name,
            message: "No Node APIs: the extension must load on mobile.",
          })),
        },
      ],
    },
  },
  {
    // Tests and the obsidian stub trade type-safety for brevity.
    files: ["test/**/*.ts"],
    rules: {
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  },
);
