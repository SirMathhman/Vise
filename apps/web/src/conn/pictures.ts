import { config } from "@vise/backend";
import type { Picture } from "@vise/core";
import { imageStore, sniffImage } from "@vise/backend";

/** Most pictures that may come with one message. */

const DATA_URI =
  /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]+={0,2})$/;

/**
 * The pictures a browser attached to a message: each a base64 data URI of a
 * png, jpeg, gif or webp within the size limit, kept in the image store. The
 * page is not trusted, so every field is checked, and the type the page
 * declares must be what the bytes really are; throws an `Error` fit to show
 * when one is not valid.
 */
export function acceptPictures(raw: unknown): Picture[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw))
    throw new Error("the attached images must be a list");
  if (raw.length > config.maxPictures) {
    throw new Error(
      `at most ${config.maxPictures} images can come with one message`,
    );
  }
  return raw.map((item: unknown, index): Picture => {
    const fields =
      typeof item === "object" && item !== null
        ? (item as Record<string, unknown>)
        : {};
    const uri = typeof fields["uri"] === "string" ? fields["uri"] : "";
    const match = DATA_URI.exec(uri);
    const which = `attached image ${index + 1}`;
    if (!match) throw new Error(`${which} is not a png, jpeg, gif or webp`);
    const bytes = Buffer.from(match[2]!, "base64");
    if (bytes.length > config.maxImageBytes) {
      throw new Error(
        `${which} is too large (the limit is ${config.maxImageBytes / 1_000_000} MB)`,
      );
    }
    if (sniffImage(bytes) !== match[1]) {
      throw new Error(`${which} is not really a ${match[1]!.slice(6)} file`);
    }
    const name =
      typeof fields["label"] === "string" ? fields["label"].trim() : "";
    return imageStore.put(bytes, (name || `image ${index + 1}`).slice(0, 80));
  });
}
