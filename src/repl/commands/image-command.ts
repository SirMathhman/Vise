import type { Message, Picture, Result } from "../../core/errors.ts";
import type { ImageSource } from "../ports.ts";

/**
 * Images the user has attached to their next message with `/image <path>`
 * (the terminal's way; the web page sends images with the message itself).
 * They wait here until the next real message takes them.
 */
export class PendingImages {
  private pictures: Picture[] = [];

  constructor(private readonly source?: ImageSource) {}

  /** Hand over everything attached so far. */
  take(): Picture[] {
    const taken = this.pictures;
    this.pictures = [];
    return taken;
  }

  /** The user's message, with what they attached by `/image` and what came with the line itself. */
  message(content: string, images: Picture[] = []): Message {
    const attached = [...this.take(), ...images];
    return {
      role: "user",
      content,
      typed: true,
      ...(attached.length > 0 ? { images: attached } : {}),
    };
  }

  /** `/image` (what is attached), `/image <path>` (attach), `/image clear`. */
  async command(line: string): Promise<Result<string>> {
    if (!this.source) {
      return fail("images are not supported by the current client");
    }
    const arg = line.slice("/image".length).trim();
    if (arg === "") return { ok: true, value: this.status() };
    if (arg === "clear") {
      this.pictures = [];
      return { ok: true, value: "no images attached" };
    }
    const loaded = await this.source.load(arg);
    if (!loaded.ok) return loaded;
    this.pictures.push(loaded.value);
    return {
      ok: true,
      value: `attached ${loaded.value.label}; it goes with your next message (${this.status()})`,
    };
  }

  private status(): string {
    const n = this.pictures.length;
    return n === 0
      ? "no images attached"
      : `${n} image${n === 1 ? "" : "s"} attached: ${this.pictures.map((p) => p.label).join(", ")}`;
  }
}

function fail(body: string): Result<string> {
  return { ok: false, error: { kind: "malformed", body } };
}
