import { readFile, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, resolve } from "node:path";
import type { Picture, Result } from "../core/errors.ts";
import type { ImageSource } from "../repl/ports.ts";
import { errStr } from "./files.ts";

/**
 * Pictures for the model: read from a file (`view_image`) or taken from a
 * browser tab (`browser_screenshot`). A tool hands its picture to the
 * `ImageOutbox`; the tool runner gives it to the engine with the tool's text
 * result, so it reaches the model as part of that result.
 */

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

/** The largest picture file handed to the model (the server downsizes, but the upload itself should stay sane). */
export const MAX_IMAGE_BYTES = 10_000_000;

/** Pictures produced by the tool call in progress, until the runner collects them. */
export class ImageOutbox {
  private items: Picture[] = [];

  push(image: Picture): void {
    this.items.push(image);
  }

  /** Hand over everything collected so far. */
  take(): Picture[] {
    const taken = this.items;
    this.items = [];
    return taken;
  }
}

/** The pixel size of a PNG, GIF or JPEG from its header; undefined when it cannot be read. */
export function imageSize(
  bytes: Uint8Array,
  mime: string,
): { width: number; height: number } | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  try {
    if (mime === "image/png" && bytes.length >= 24) {
      return { width: view.getUint32(16), height: view.getUint32(20) };
    }
    if (mime === "image/gif" && bytes.length >= 10) {
      return {
        width: view.getUint16(6, true),
        height: view.getUint16(8, true),
      };
    }
    if (mime === "image/jpeg") {
      let at = 2;
      while (at + 9 < bytes.length) {
        if (bytes[at] !== 0xff) return undefined;
        const marker = bytes[at + 1]!;
        // Start-of-frame markers (not the DHT, JPG and DAC ones in the same range) carry the size.
        if (
          marker >= 0xc0 &&
          marker <= 0xcf &&
          ![0xc4, 0xc8, 0xcc].includes(marker)
        ) {
          return {
            height: view.getUint16(at + 5),
            width: view.getUint16(at + 7),
          };
        }
        at += 2 + view.getUint16(at + 2);
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/** A picture from raw bytes. */
export function toImage(
  bytes: Uint8Array,
  mime: string,
  label: string,
): Picture {
  const size = imageSize(bytes, mime);
  return {
    uri: `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`,
    label,
    ...(size ?? {}),
  };
}

/** Read a picture file; throws an `Error` with a message fit to show when it cannot be used. */
export async function readImageFile(path: string): Promise<Picture> {
  const mime = MIME[extname(path).toLowerCase()];
  if (!mime) {
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
  return toImage(await readFile(path), mime, basename(path));
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
        const image = await readImageFile(cwd ? resolve(cwd, raw) : raw);
        outbox.push(image);
        return `showing ${describeImage(image)}`;
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
      return {
        ok: true,
        value: await readImageFile(this.cwd ? resolve(this.cwd, path) : path),
      };
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  }
}
