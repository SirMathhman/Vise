import js from "@eslint/js";
import tseslint from "typescript-eslint";

// Size limits from ARCHITECTURE.md. Lines that are blank or comments do not count.
export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "max-lines": [
        "error",
        { max: 500, skipBlankLines: true, skipComments: true },
      ],
      "max-lines-per-function": [
        "error",
        { max: 100, skipBlankLines: true, skipComments: true },
      ],
      // More than four parameters are passed as one parameter object, with an interface for its type.
      "max-params": ["error", 4],
      "no-restricted-syntax": [
        "error",
        {
          selector: "TSTypeLiteral",
          message: "Use a named interface instead of an object type literal.",
        },
        {
          selector:
            "TSInterfaceBody > TSPropertySignature > TSTypeAnnotation > TSFunctionType",
          message:
            "Declare a method in the interface instead of a function-typed field.",
        },
        {
          selector:
            "TSInterfaceBody > TSPropertySignature > TSTypeAnnotation > TSUnionType > TSFunctionType",
          message:
            "Declare a method in the interface instead of a function-typed field.",
        },
        {
          selector: "ThrowStatement",
          message: "Return a Result (src/core/result.ts) instead of throwing.",
        },
      ],
    },
  },
);
