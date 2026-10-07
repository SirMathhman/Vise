interface CompletionChoice {
  label: string;
  value: string;
  description?: string;
}

interface CompletionChoices {
  models: CompletionChoice[];
  profiles: CompletionChoice[];
  sessions: CompletionChoice[];
  tools: CompletionChoice[];
}

export interface CommandSuggestion {
  label: string;
  description: string;
  value: string;
  appendSpace: boolean;
}

const reasoningLevels = [
  "default",
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

function matches(
  values: CompletionChoice[],
  query: string,
  command: string,
  description: string,
  appendSpace = false,
): CommandSuggestion[] {
  return values
    .filter(
      (candidate) =>
        candidate.label.toLowerCase().startsWith(query.toLowerCase()) &&
        candidate.label.toLowerCase() !== query.toLowerCase(),
    )
    .slice(0, 8)
    .map((candidate) => ({
      ...candidate,
      description: candidate.description ?? description,
      value: `${command} ${candidate.value}`,
      appendSpace,
    }));
}

/** Suggest only known finite argument values for supported slash commands. */
export function getArgumentSuggestions(
  command: string,
  rawArgs: string,
  choices: CompletionChoices,
): CommandSuggestion[] {
  const args = rawArgs.trimStart();
  const fixedSubcommands = {
    "/profile": ["init"],
    "/note": ["init"],
    "/workflow": ["init"],
  }[command];

  if (fixedSubcommands && !/\s/.test(args)) {
    if (command === "/profile" && args.toLowerCase() === "init") {
      return [];
    }
    const initMatches = matches(
      fixedSubcommands.map((item) => ({ label: item, value: item })),
      args,
      command,
      "subcommand",
      true,
    );
    if (initMatches.length > 0) {
      if (command !== "/profile") {
        return initMatches;
      }
      return [
        ...initMatches,
        ...matches(choices.profiles, args, command, "switch to profile"),
      ].slice(0, 8);
    }
  }

  const listCommands: Record<string, [CompletionChoice[], string]> = {
    "/model": [choices.models, "switch to model"],
    "/profile": [choices.profiles, "switch to profile"],
    "/burst": [
      [
        { label: "on", value: "on" },
        { label: "off", value: "off" },
      ],
      "burst mode",
    ],
    "/reasoning": [
      reasoningLevels.map((value) => ({ label: value, value })),
      "reasoning effort",
    ],
    "/resume": [choices.sessions, "resume session"],
    "/delete": [choices.sessions, "delete session"],
  } as const;
  const listChoice = listCommands[command];
  if (listChoice) {
    if (/\s/.test(args)) return [];
    return matches(listChoice[0], args, command, listChoice[1]);
  }

  if (command === "/tool") {
    const nameEnd = rawArgs.search(/\s/);
    const name = nameEnd === -1 ? rawArgs : rawArgs.slice(0, nameEnd);
    const exactName = choices.tools.find(
      (tool) => tool.label.toLowerCase() === name.toLowerCase(),
    );
    if (exactName && nameEnd !== -1) {
      const verb = rawArgs.slice(nameEnd).trimStart();
      if (/\s/.test(verb)) return [];
      return ["enable", "disable"]
        .filter(
          (item) =>
            item.startsWith(verb.toLowerCase()) && item !== verb.toLowerCase(),
        )
        .map((item) => ({
          label: item,
          description: "toggle tool",
          value: `/tool ${exactName.value} ${item}`,
          appendSpace: false,
        }));
    }
    if (nameEnd !== -1) return [];
    return matches(choices.tools, name, command, "select tool", true);
  }

  if (command === "/workflow" && args.startsWith("init ")) {
    const scopeArg = args.slice("init ".length);
    if (
      !/\s/.test(scopeArg) &&
      "--global".startsWith(scopeArg.toLowerCase()) &&
      scopeArg.toLowerCase() !== "--global"
    ) {
      return [
        {
          label: "--global",
          description: "create a global workflow",
          value: "/workflow init --global",
          appendSpace: true,
        },
      ];
    }
  }

  return [];
}
