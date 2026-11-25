import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/node_modules/**"],
  },
  eslint.configs.recommended,
  tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ["**/*.mjs"],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    // Every deserialization goes through a zod schema. parseJson in common is the one
    // place that turns text into a value, so only it may call JSON.parse.
    rules: {
      "no-restricted-properties": [
        "error",
        {
          object: "JSON",
          property: "parse",
          message:
            "Use parseJson with a zod schema from common instead of JSON.parse.",
        },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "CallExpression[arguments.length=0][callee.property.name='json']",
          message:
            "Read the body as text and check it with parseJson and a zod schema instead of .json().",
        },
      ],
    },
  },
);
