import { readFile, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, resolve } from "node:path";
import type { Picture, Result } from "../core/errors.ts";
import type { ImageStore } from "../image-store.ts";
import type { ImageSource } from "../repl/ports.ts";
import { errStr } from "./files.ts";

/**
 * Pictures for the model: read from a file (`view_image`) or taken from a
 * browser tab (`browser_screenshot`). A tool keeps its picture in the
 * `ImageStore` and hands the reference to the `ImageOutbox`; the tool runner
 * gives it to the engine with the tool's text result, so it reaches the model
 * as part of that result.
 */

/** File extensions that may hold a picture (what the bytes really are is checked when it is stored). */
const EXTENSIONS = [".png", ".jpg", ".jpeg", ".gif", ".webp"];

/** The largest picture file handed to the model (the server downsizes, but the upload itself should stay sane). */
export const MAX_IMAGE_BYTES = 10_000_000;

/** Pictures produced by the tool call in progress, until the runner collects them. */
export class ImageOutbox {
  private items: Picture[] = [];

  constructor(private readonly store: ImageStore) {}

  /** Keep a picture and queue it for the model; throws when the bytes are not a supported image. */
  add(bytes: Uint8Array, label: string): Picture {
    const picture = this.store.put(bytes, label);
    this.items.push(picture);
    return picture;
  }

  /** Hand over everything queued so far. */
  take(): Picture[] {
    const taken = this.items;
    this.items = [];
    return taken;
  }
}

/** Read a picture file; throws an `Error` with a message fit to show when it cannot be used. */
export async function readImageFile(
  path: string,
): Promise<{ bytes: Buffer; label: string }> {
  if (!EXTENSIONS.includes(extname(path).toLowerCase())) {
    throw new Error(
      `${basename(path)} is not a supported image (png, jpg, gif or webp)`,
    );
  }
  const info = await stat(path).catch(() => null);
  if (!info?.isFile()) throw new Error(`${path} is not a file`);
  if (info.size > MAX_IMAGE_BYTES) {
    throw new Error(
      `${basename(path)} is too large (${Math.round(info.size / 1_000_000)} MB, the limit is ${MAX_IMAGE_BYTES / 1_000_000} MB)`,
    );
  }
  return { bytes: await readFile(path), label: basename(path) };
}

/** How a picture is described in the tool's text result. */
export function describeImage(image: Picture): string {
  const size =
    image.width && image.height
      ? `${image.width}x${image.height}`
      : "size unknown";
  return `${image.label} (${size})`;
}

/** The `view_image` tool: show the model a picture file. */
export function makeImageHandlers(
  outbox: ImageOutbox,
  /** What relative paths are resolved against; without one they must be absolute. */
  cwd?: string,
): Record<string, (args: Record<string, unknown>) => Promise<string>> {
  return {
    view_image: async (args) => {
      try {
        const raw = String(args["path"] ?? "").trim();
        if (raw === "") return "error: 'path' is required";
        if (!cwd && !isAbsolute(raw)) {
          return `error: there is no working directory, use an absolute path`;
        }
        const file = await readImageFile(cwd ? resolve(cwd, raw) : raw);
        return `showing ${describeImage(outbox.add(file.bytes, file.label))}`;
      } catch (err) {
        return errStr(err);
      }
    },
  };
}

/** The `/image <path>` command's loader: reads the file, but only when the active model can see it. */
export class FileImageSource implements ImageSource {
  constructor(
    /** What relative paths are resolved against; without one they must be absolute. */
    private readonly cwd: string | undefined,
    private readonly canSee: () => Promise<boolean>,
    private readonly store: ImageStore,
  ) {}

  async load(path: string): Promise<Result<Picture>> {
    const fail = (body: string): Result<Picture> => ({
      ok: false,
      error: { kind: "malformed", body },
    });
    if (!(await this.canSee())) {
      return fail("the active model cannot see images (switch with /model)");
    }
    if (!this.cwd && !isAbsolute(path)) {
      return fail("there is no working directory, use an absolute path");
    }
    try {
      const file = await readImageFile(
        this.cwd ? resolve(this.cwd, path) : path,
      );
      return { ok: true, value: this.store.put(file.bytes, file.label) };
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  }
}
