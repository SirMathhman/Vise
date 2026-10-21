"use strict";
const conversation = [];
const log = document.getElementById("log");
const form = document.getElementById("form");
const input = document.getElementById("input");
const newButton = document.getElementById("new");
function addEntry(kind) {
    const entry = document.createElement("div");
    entry.className = kind;
    log.appendChild(entry);
    return entry;
}
function scrollToEnd() {
    log.scrollTop = log.scrollHeight;
}
async function streamChat(messages, onEvent) {
    let res;
    try {
        res = await fetch("/api/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ messages }),
        });
    }
    catch {
        throw new Error(`Could not reach the Vise server at ${location.origin}. Check that "vise web" is still running, then try again.`);
    }
    if (!res.ok || res.body === null) {
        const data = (await res.json().catch(() => ({})));
        throw new Error(data.error ?? `HTTP ${res.status}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let answer = "";
    for (;;) {
        const { done, value } = await reader.read().catch(() => {
            throw new Error("The connection dropped partway through the reply. Try again.");
        });
        if (done) {
            break;
        }
        buffer += decoder.decode(value, { stream: true });
        let end = buffer.indexOf("\n\n");
        while (end !== -1) {
            const block = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            end = buffer.indexOf("\n\n");
            const line = block.split("\n").find((l) => l.startsWith("data: "));
            if (line === undefined) {
                continue;
            }
            const event = JSON.parse(line.slice("data: ".length));
            if (event.type === "error") {
                throw new Error(event.error);
            }
            if (event.type === "done") {
                return answer;
            }
            if (event.type === "content") {
                answer += event.text;
            }
            onEvent(event);
        }
    }
    throw new Error("The reply ended before it finished. Try again.");
}
form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (text === "") {
        return;
    }
    input.value = "";
    conversation.push({ role: "user", content: text });
    addEntry("user").textContent = text;
    input.disabled = true;
    const bubble = addEntry("assistant");
    const thinking = document.createElement("details");
    thinking.className = "thinking";
    thinking.open = true;
    thinking.hidden = true;
    const thinkingSummary = document.createElement("summary");
    thinkingSummary.textContent = "Thinking";
    const thinkingText = document.createElement("div");
    thinking.append(thinkingSummary, thinkingText);
    const answerText = document.createElement("div");
    bubble.append(thinking, answerText);
    try {
        const reply = await streamChat(conversation, (streamed) => {
            if (streamed.type === "reasoning") {
                thinking.hidden = false;
                thinkingText.textContent += streamed.text;
            }
            else if (streamed.type === "content") {
                answerText.textContent += streamed.text;
            }
            scrollToEnd();
        });
        conversation.push({ role: "assistant", content: reply });
    }
    catch (err) {
        conversation.pop();
        if (answerText.textContent === "" && thinkingText.textContent === "") {
            bubble.remove();
        }
        addEntry("error").textContent = err instanceof Error ? err.message : String(err);
    }
    finally {
        input.disabled = false;
        input.focus();
        scrollToEnd();
    }
});
newButton.addEventListener("click", () => {
    conversation.length = 0;
    log.replaceChildren();
});
