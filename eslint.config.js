import js from "@eslint/js";
import tseslint from "typescript-eslint";

// Size limits from ARCHITECTURE.md. Lines that are blank or comments do not count.
export default tseslint.config(js.configs.recommended, ...tseslint.configs.recommended, {
  rules: {
    "max-lines": ["warn", { max: 500, skipBlankLines: true, skipComments: true }],
    "max-lines-per-function": ["warn", { max: 100, skipBlankLines: true, skipComments: true }],
    "no-restricted-syntax": [
      "error",
      { selector: "TSTypeLiteral", message: "Use a named interface instead of an object type literal." },
    ],
  },
});
