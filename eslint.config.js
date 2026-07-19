import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", "data/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { files: ["public/**/*.js"], languageOptions: { globals: { document: "readonly", fetch: "readonly", FormData: "readonly" } } },
  { rules: { "@typescript-eslint/consistent-type-imports": "error" } }
);
