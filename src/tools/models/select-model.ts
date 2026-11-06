import type { ModelInfo } from "../../core/messages.ts";
import { err, ok, type Result } from "../../core/result.ts";
import { saveModelSetting } from "./model-settings.ts";

export interface SelectModelOptions {
  // The working directory the choice is saved in.
  root: string;
  // The models OpenRouter lists right now.
  list: () => Promise<Result<ModelInfo[]>>;
  // The name the user asked for.
  name: string;
  // Switches the model used from the next request.
  setModel: (model: string) => void;
}

// Switches to a model that is listed. The name must be listed, and the choice is saved before the switch,
// so a choice that cannot be saved does not take effect. Resolves with the name chosen.
export async function selectModel(options: SelectModelOptions): Promise<Result<string>> {
  const listed = await options.list();
  if (!listed.ok) return listed;
  if (!listed.value.some((model) => model.id === options.name)) {
    return err(new Error(`OpenRouter does not list ${options.name}`));
  }
  const written = await saveModelSetting(options.root, options.name);
  if (!written.ok) return written;
  options.setModel(options.name);
  return ok(options.name);
}
