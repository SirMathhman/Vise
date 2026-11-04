import js from "@eslint/js";
import tseslint from "typescript-eslint";

// Size limits from ARCHITECTURE.md. Lines that are blank or comments do not count.
export default tseslint.config(js.configs.recommended, ...tseslint.configs.recommended, {
  rules: {
    "max-lines": ["error", { max: 500, skipBlankLines: true, skipComments: true }],
    "max-lines-per-function": ["error", { max: 100, skipBlankLines: true, skipComments: true }],
    "no-restricted-syntax": [
      "error",
      { selector: "TSTypeLiteral", message: "Use a named interface instead of an object type literal." },
      { selector: "ThrowStatement", message: "Return a Result (src/core/result.ts) instead of throwing." },
    ],
  },
});
