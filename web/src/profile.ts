// The default profile: the instructions the conversation starts with, requested again on New and on load.

// The default profile's request, started on load and on New. The first message waits for it, so the profile's
// instructions join the conversation before the user's message does. Stop cancels it.
let defaultProfile: Promise<void> = Promise.resolve();
let defaultAbort: AbortController | null = null;

// Starts the conversation with the built-in default profile. The server applies its tools and returns its
// instructions, if it has any, which join the conversation. Nothing is shown in the log.
function applyDefaultProfile(): Promise<void> {
  const controller = new AbortController();
  defaultAbort = controller;
  defaultProfile = (async () => {
    try {
      const done = await streamChat([{ role: "user", content: "/profile default" }], () => {}, controller.signal);
      if (done.profile != null) {
        conversation.push({ role: "profile", content: done.profile });
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        addEntry("error").textContent = errorMessage(err);
      }
    }
    void refreshTools();
  })();
  return defaultProfile;
}
