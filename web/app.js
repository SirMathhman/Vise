"use strict";
const conversation = [];
const log = document.getElementById("log");
const form = document.getElementById("form");
const input = document.getElementById("input");
const newButton = document.getElementById("new");
function append(kind, text) {
    const entry = document.createElement("div");
    entry.className = kind;
    entry.textContent = text;
    log.appendChild(entry);
    entry.scrollIntoView();
}
async function sendChat(messages) {
    const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages }),
    });
    const data = (await res.json());
    if (!res.ok || data.reply === undefined) {
        throw new Error(data.error ?? `HTTP ${res.status}`);
    }
    return data.reply;
}
form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (text === "") {
        return;
    }
    input.value = "";
    conversation.push({ role: "user", content: text });
    append("user", text);
    input.disabled = true;
    try {
        const reply = await sendChat(conversation);
        conversation.push({ role: "assistant", content: reply });
        append("assistant", reply);
    }
    catch (err) {
        conversation.pop();
        append("error", err instanceof Error ? err.message : String(err));
    }
    finally {
        input.disabled = false;
        input.focus();
    }
});
newButton.addEventListener("click", () => {
    conversation.length = 0;
    log.replaceChildren();
});
