import * as readline from "node:readline";

// Endpoint of the already-running OpenAI-compatible LLM server (llama.cpp).
const BASE_URL = process.env.LLM_BASE_URL ?? "http://localhost:8080";
const MODEL = process.env.LLM_MODEL ?? "local";
// Sent as a Bearer token only when set (the server may run without a key).
const API_KEY = process.env.LLM_API_KEY;

const rl = readline.createInterface({
	input: process.stdin,
	output: process.stdout,
});

// Every "line" event is pushed onto a buffer as it arrives, so piped lines
// that land while a fetch is in flight are not lost.
const lines: string[] = [];
let closed = false;
rl.on("line", (line) => {
	lines.push(line);
});
rl.on("close", () => {
	closed = true;
});
process.on("SIGINT", () => {
	console.log("\nBye.");
	rl.close();
});

// Resolves with the next buffered line, or "" once input has closed and no
// lines remain.
const nextLine = (): Promise<string> => {
	if (lines.length > 0) return Promise.resolve(lines.shift() ?? "");
	if (closed) return Promise.resolve("");
	return new Promise((resolve) => {
		const done = (value: string) => {
			rl.removeListener("line", onLine);
			rl.removeListener("close", onClose);
			resolve(value);
		};
		const onLine = () => done(lines.shift() ?? "");
		const onClose = () => done("");
		rl.on("line", onLine);
		rl.on("close", onClose);
	});
};

// The running conversation; every turn appends to it, so each request
// carries the full history (context) to the model.
const messages: { role: "user" | "assistant"; content: string }[] = [];

for (;;) {
	process.stdout.write("you> ");
	const raw = await nextLine();
	const text = (raw ?? "").trim();
	if (text.length === 0) {
		if (closed) break;
		continue;
	}
	messages.push({ role: "user", content: text });

	try {
		const res = await fetch(`${BASE_URL}/v1/chat/completions`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				...(API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {}),
			},
			body: JSON.stringify({
				model: MODEL,
				messages,
			}),
		});
		if (!res.ok) {
			const detail = await res.text();
			throw new Error(`HTTP ${res.status}: ${detail}`);
		}
		const data = (await res.json()) as {
			choices?: { message?: { content?: string } }[];
		};
		const answer = data.choices?.[0]?.message?.content ?? "";
		if (answer.length > 0)
			messages.push({ role: "assistant", content: answer });
		console.log(`\nassistant> ${answer || "(empty response)"}\n`);
	} catch (err) {
		console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
	}
}

// Loop broke on EOF (or stdin was drained); nothing left to do.
process.exit(0);
