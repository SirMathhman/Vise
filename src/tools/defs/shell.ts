import type { Tool } from "../../core/engine.ts";

/** Shell and background-process tools (handlers: `shell.ts`). */
export const shellTools: Tool[] = [
  {
    type: "function",
    core: true,
    display: { label: "Run PowerShell", icon: "💻" },
    function: {
      name: "run_powershell",
      description:
        "Run a PowerShell command and return its combined stdout/stderr output. Runs in the current working directory. Foreground by default: blocks up to 60 seconds, killing the command if it runs longer. Set background to true to run it in the background instead, which returns a numeric process id immediately; use wait_for_process and kill_process with that id to wait on or terminate it.",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "The PowerShell command to run",
          },
          background: {
            type: "boolean",
            description:
              "Run in the background and return a process id instead of blocking. Use with wait_for_process / kill_process. Default false.",
          },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    display: { label: "Wait for process", icon: "⏳" },
    function: {
      name: "wait_for_process",
      description:
        "Wait for a background process (started via run_powershell with background true) to finish, up to the given timeout. Returns the exit code and captured output if it finished within the window, or a 'still running' status with output so far if the timeout elapses first. The process keeps running after a wait times out. Set timeout to 0 to check status without waiting.",
      parameters: {
        type: "object",
        properties: {
          process_id: {
            type: "integer",
            description: "Process id returned by run_powershell",
          },
          timeout: {
            type: "integer",
            description:
              "Maximum milliseconds to wait (default 0, meaning return the current status immediately)",
          },
        },
        required: ["process_id"],
      },
    },
  },
  {
    type: "function",
    display: { label: "Stop process", icon: "⛔" },
    function: {
      name: "kill_process",
      description:
        "Send SIGTERM to a background process (started via run_powershell with background true) and return a confirmation plus any captured output. A second call against an already-finished process reports that it is no longer running.",
      parameters: {
        type: "object",
        properties: {
          process_id: {
            type: "integer",
            description: "Process id returned by run_powershell",
          },
        },
        required: ["process_id"],
      },
    },
  },
];
