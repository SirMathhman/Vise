/**
 * The recent output of one shell, replayed to a page that (re)attaches.
 * Capped by characters; the oldest text goes first, cut at a line start so
 * the replay does not begin inside a line.
 */
export class Scrollback {
  private chunks: string[] = [];
  private size = 0;

  constructor(private readonly limit: () => number) {}

  push(text: string): void {
    if (!text) return;
    this.chunks.push(text);
    this.size += text.length;
    this.trim();
  }

  text(): string {
    return this.chunks.join("");
  }

  clear(): void {
    this.chunks = [];
    this.size = 0;
  }

  private trim(): void {
    const limit = Math.max(1, this.limit());
    if (this.size <= limit) return;
    let text = this.text().slice(this.size - limit);
    const lineStart = text.indexOf("\n");
    if (lineStart >= 0 && lineStart < text.length - 1) text = text.slice(lineStart + 1);
    this.chunks = [text];
    this.size = text.length;
  }
}
