import type { Picture } from "../core/errors.ts";
import { imageSize, MAX_IMAGE_BYTES } from "../tools/images.ts";

/** Most pictures that may come with one message. */
export const MAX_PICTURES = 6;

const DATA_URI =
  /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]+={0,2})$/;

/**
 * The pictures a browser attached to a message: each a base64 data URI of a
 * png, jpeg, gif or webp within the size limit. The page is not trusted, so
 * every field is checked; throws an `Error` fit to show when one is not valid.
 */
export function acceptPictures(raw: unknown): Picture[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw))
    throw new Error("the attached images must be a list");
  if (raw.length > MAX_PICTURES) {
    throw new Error(`at most ${MAX_PICTURES} images can come with one message`);
  }
  return raw.map((item: unknown, index): Picture => {
    const fields =
      typeof item === "object" && item !== null
        ? (item as Record<string, unknown>)
        : {};
    const uri = typeof fields["uri"] === "string" ? fields["uri"] : "";
    const match = DATA_URI.exec(uri);
    if (!match) {
      throw new Error(
        `attached image ${index + 1} is not a png, jpeg, gif or webp`,
      );
    }
    const bytes = Buffer.from(match[2]!, "base64");
    if (bytes.length > MAX_IMAGE_BYTES) {
      throw new Error(
        `attached image ${index + 1} is too large (the limit is ${MAX_IMAGE_BYTES / 1_000_000} MB)`,
      );
    }
    const name =
      typeof fields["label"] === "string" ? fields["label"].trim() : "";
    return {
      uri,
      label: (name || `image ${index + 1}`).slice(0, 80),
      ...(imageSize(bytes, match[1]!) ?? {}),
    };
  });
}
