import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Picture } from "../core/errors.ts";
import { globalDataDir } from "../data-dir.ts";

/**
 * Pictures kept as files, by the hash of their bytes (`<id>.<ext>`), so a
 * conversation, a saved session and the web page refer to a picture by its id
 * instead of carrying its bytes around. A picture is written once however
 * often it is shown. Shared by every session (`~/.vise/images`); it is read
 * back to build a model request and to serve the web page's thumbnails.
 */

const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

/** The type a file's first bytes declare, or undefined when they are not a png, jpeg, gif or webp. */
export function sniffImage(bytes: Uint8Array): string | undefined {
  const at = (offset: number, text: string): boolean =>
    [...text].every((c, i) => bytes[offset + i] === c.charCodeAt(0));
  if (bytes[0] === 0x89 && at(1, "PNG")) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (at(0, "GIF8")) return "image/gif";
  if (at(0, "RIFF") && at(8, "WEBP")) return "image/webp";
  return undefined;
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

/** Ids are the 64 hex digits of a SHA-256: nothing else names a stored picture (so an id can never be a path). */
export const ID_PATTERN = /^[0-9a-f]{64}$/;

export class ImageStore {
  constructor(private readonly dir: string) {}

  private fileFor(id: string, mime: string): string {
    return join(this.dir, `${id}.${EXTENSIONS[mime] ?? "bin"}`);
  }

  /**
   * Keep a picture. The type is taken from the bytes themselves, never from a
   * name or a declared type; throws an `Error` when they are not a supported image.
   */
  put(bytes: Uint8Array, label: string): Picture {
    const mime = sniffImage(bytes);
    if (!mime)
      throw new Error(`${label} is not a png, jpeg, gif or webp image`);
    const id = createHash("sha256").update(bytes).digest("hex");
    const file = this.fileFor(id, mime);
    if (!existsSync(file)) {
      mkdirSync(this.dir, { recursive: true });
      writeFileSync(file, bytes, { mode: 0o600 });
    }
    return {
      id,
      mime,
      label,
      bytes: bytes.length,
      ...(imageSize(bytes, mime) ?? {}),
    };
  }

  /** A stored picture's bytes, or undefined when it is not (or no longer) there. */
  read(id: string, mime: string): Buffer | undefined {
    if (!ID_PATTERN.test(id)) return undefined;
    try {
      return readFileSync(this.fileFor(id, mime));
    } catch {
      return undefined;
    }
  }

  /** The picture as a `data:` URI for a model request; undefined when its file is gone. */
  dataUri(picture: Picture): string | undefined {
    const bytes = this.read(picture.id, picture.mime);
    return bytes && `data:${picture.mime};base64,${bytes.toString("base64")}`;
  }

  /** The picture with this id (any supported type), for the web page; undefined when unknown. */
  find(id: string): { mime: string; bytes: Buffer } | undefined {
    for (const mime of Object.keys(EXTENSIONS)) {
      const bytes = this.read(id, mime);
      if (bytes) return { mime, bytes };
    }
    return undefined;
  }
}

/** The store every session shares. */
export const imageStore = new ImageStore(join(globalDataDir, "images"));
