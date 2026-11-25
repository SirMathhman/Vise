import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import folderFileLimit from "./eslint-rules/folder-file-limit.mjs";
import jsdoc from "eslint-plugin-jsdoc";
import noBooleanParams from "./eslint-rules/no-boolean-params.mjs";

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
    // Interface members are written as methods, `close(): void`, not as function-valued properties.
    rules: {
      "@typescript-eslint/method-signature-style": ["error", "method"],
    },
  },
  {
    // Every exported declaration carries a JSDoc comment.
    plugins: { jsdoc },
    rules: {
      "jsdoc/require-param": "error",
      "jsdoc/require-returns": "error",
      "jsdoc/require-jsdoc": [
        "error",
        {
          publicOnly: true,
          require: {
            FunctionDeclaration: true,
            ClassDeclaration: true,
            MethodDefinition: true,
          },
          contexts: [
            "ExportNamedDeclaration > TSInterfaceDeclaration > TSInterfaceBody > TSPropertySignature",
            "ExportNamedDeclaration > VariableDeclaration",
            "TSInterfaceDeclaration",
            "TSTypeAliasDeclaration",
            "TSEnumDeclaration",
          ],
        },
      ],
    },
  },
  {
    // No folder may directly hold more than 10 git-tracked or visible files.
    // Local rules: each folder holds at most 10 files, and no parameter is a boolean flag.
    plugins: {
      local: {
        rules: {
          "folder-file-limit": folderFileLimit,
          "no-boolean-params": noBooleanParams,
        },
      },
    },
    rules: {
      "local/folder-file-limit": "error",
      "local/no-boolean-params": "error",
    },
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
