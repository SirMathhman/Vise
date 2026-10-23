// The default profile: the instructions a chat starts with, requested when the chat is opened.

// Starts a chat with the built-in default profile. The server applies its tools and returns its instructions, if it has
// any, which join that chat's conversation. Nothing is shown in its log. The chat's first message waits for this.
function applyDefaultProfile(chat: Chat): Promise<void> {
  const controller = new AbortController();
  chat.defaultAbort = controller;
  chat.defaultProfile = (async () => {
    try {
      const done = await streamChat(
        [{ role: "user", content: "/profile default" }],
        chat.told,
        () => {},
        controller.signal,
        chat.workingDir,
      );
      if (done.profile != null) {
        chat.conversation.push({ role: "profile", content: done.profile });
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        addEntry(chat, "error").textContent = errorMessage(err);
      }
    }
    void refreshTools();
  })();
  return chat.defaultProfile;
}
