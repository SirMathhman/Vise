import type { ModelSelf } from "../chat/model-facts";

/**
 * The name the model uses to call the model-info tool.
 */
export const MODEL_INFO_NAME = "get_model_info";

/**
 * The tool the model may call to read facts about itself. It takes no arguments and changes nothing.
 */
export const MODEL_INFO_TOOL = {
  type: "function" as const,
  function: {
    name: MODEL_INFO_NAME,
    description:
      "Get facts about the model answering this reply: its id and name, its context window, the tokens reserved for the reply, the conversation budget still free when the reply started, and the tools it may call. Takes no arguments.",
    parameters: {
      type: "object",
      properties: {},
    },
  },
};

/**
 * Reports the model's facts as JSON text. The arguments are ignored, since the tool takes none.
 *
 * @param _root The project root. Unused by this tool.
 * @param _argumentsJson The model's arguments. Unused by this tool.
 * @param self The facts about the model answering this reply, when the backend has them.
 * @returns The facts as JSON text, or a note that they are not available.
 */
export function runModelInfo(
  _root: string,
  _argumentsJson: string,
  self?: ModelSelf,
): Promise<string> {
  if (self === undefined) {
    return Promise.resolve(
      "Model information is not available for this reply.",
    );
  }
  return Promise.resolve(JSON.stringify(self, null, 2));
}
