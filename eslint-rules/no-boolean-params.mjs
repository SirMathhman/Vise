// A boolean parameter usually stands for a toggle: the function does one of two things, and the
// flag picks which. That is two responsibilities behind one signature. Write two functions, or
// pass the value that differs, instead.

// True when a parameter is annotated as a boolean, or defaults to a boolean literal.
function isBooleanParam(param) {
  const annotated = (node) =>
    node.typeAnnotation?.typeAnnotation?.type === "TSBooleanKeyword";
  if (param.type === "Identifier") {
    return annotated(param);
  }
  if (param.type === "AssignmentPattern") {
    const literal =
      param.right.type === "Literal" && typeof param.right.value === "boolean";
    return (
      literal || (param.left.type === "Identifier" && annotated(param.left))
    );
  }
  return false;
}

export default {
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Disallow boolean parameters, which usually signal a function doing two jobs.",
    },
    schema: [],
    messages: {
      booleanParam:
        'Parameter "{{name}}" is a boolean flag. Split the function, or pass a value that says what differs.',
    },
  },
  create(context) {
    const check = (node) => {
      for (const param of node.params) {
        if (isBooleanParam(param)) {
          const target =
            param.type === "AssignmentPattern" ? param.left : param;
          context.report({
            node: param,
            messageId: "booleanParam",
            data: { name: target.name ?? "?" },
          });
        }
      }
    };
    return {
      FunctionDeclaration: check,
      FunctionExpression: check,
      ArrowFunctionExpression: check,
      TSMethodSignature: check,
      TSDeclareFunction: check,
    };
  },
};
