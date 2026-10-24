const root = document.getElementById("root");
if (root) {
  root.innerHTML = `
    <h1>Vise</h1>
    <form id="chat-form">
      <input id="message" type="text" placeholder="Send a message..." autocomplete="off" />
      <button type="submit">Send</button>
    </form>
    <pre id="response"></pre>
  `;
}

const form = document.getElementById("chat-form") as HTMLFormElement | null;
const input = document.getElementById("message") as HTMLInputElement | null;
const response = document.getElementById("response");

if (form && input && response) {
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const message = input.value.trim();
    if (!message) return;

    response.textContent = "…";
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
      });
      const data = (await res.json()) as { content?: string };
      response.textContent = data.content ?? "(empty response)";
    } catch (err) {
      response.textContent = `Error: ${err}`;
    }
  });
}
