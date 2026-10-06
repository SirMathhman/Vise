import { describe, expect, test } from "bun:test";
import { getArgumentSuggestions } from "../web/src/command-completions.ts";

const choices = {
  models: [
    { label: "model-alpha", value: "model-alpha" },
    { label: "model-beta", value: "model-beta" },
  ],
  profiles: [
    { label: "default", value: "default" },
    { label: "implement", value: "implement" },
  ],
  sessions: [{ label: "session-one", value: "session-one" }],
  tools: [{ label: "read_file", value: "read_file" }],
};

describe("web command argument completion", () => {
  test("suggests known model and reasoning choices", () => {
    expect(getArgumentSuggestions("/model", "model-a", choices)).toEqual([
      {
        label: "model-alpha",
        value: "/model model-alpha",
        description: "switch to model",
        appendSpace: false,
      },
    ]);
    expect(getArgumentSuggestions("/reasoning", "med", choices)[0]?.value).toBe(
      "/reasoning medium",
    );
  });

  test("suggests reserved subcommands and matching profile choices", () => {
    expect(
      getArgumentSuggestions("/profile", "i", choices).map(
        ({ value }) => value,
      ),
    ).toEqual(["/profile init", "/profile implement"]);
    expect(
      getArgumentSuggestions("/note", "i", choices).map(({ value }) => value),
    ).toEqual(["/note init"]);
    expect(getArgumentSuggestions("/profile", "init", choices)).toEqual([]);
  });

  test("completes tool names and finite verbs but not freeform arguments", () => {
    expect(getArgumentSuggestions("/tool", "read_f", choices)[0]?.value).toBe(
      "/tool read_file",
    );
    expect(
      getArgumentSuggestions("/tool", "read_file e", choices)[0]?.value,
    ).toBe("/tool read_file enable");
    expect(getArgumentSuggestions("/save", "arbitrary name", choices)).toEqual(
      [],
    );
    expect(
      getArgumentSuggestions("/workflow", "build something", choices),
    ).toEqual([]);
  });

  test("completes workflow scope flag, sessions, and fixed subcommands", () => {
    expect(
      getArgumentSuggestions("/workflow", "init --g", choices)[0]?.value,
    ).toBe("/workflow init --global");
    expect(
      getArgumentSuggestions("/resume", "session-", choices)[0]?.value,
    ).toBe("/resume session-one");
    expect(
      getArgumentSuggestions("/delete", "session-", choices)[0]?.value,
    ).toBe("/delete session-one");
  });
});
