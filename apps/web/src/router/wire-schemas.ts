import { z } from "zod";

/**
 * Runtime validation of page→server WebSocket messages. Each schema covers
 * the fields a specific route needs; prefix routes (browser_*, term_*, etc.)
 * just require `type` to be a string, which the base check in
 * `handleMessage` covers.
 */

/** Every wire message has a string `type`. */
export const wireBaseSchema = z.object({ type: z.string() });

/** `line`: text is the message; images and qid are optional. */
export const lineSchema = z.object({
  type: z.literal("line"),
  text: z.string(),
  id: z.string().optional(),
  images: z.unknown().optional(),
  qid: z.string().optional(),
});

/** `steer`: text is required. */
export const steerSchema = z.object({
  type: z.literal("steer"),
  text: z.string(),
  images: z.unknown().optional(),
});

/** `unqueue`: qid identifies the held line to drop. */
export const unqueueSchema = z.object({
  type: z.literal("unqueue"),
  qid: z.string(),
});

/** `ask_answer`: the user's reply text. */
export const askAnswerSchema = z.object({
  type: z.literal("ask_answer"),
  text: z.string(),
});

/** `profile_tools`: name identifies the profile; tools is the whitelist or null. */
export const profileToolsSchema = z.object({
  type: z.literal("profile_tools"),
  id: z.string().optional(),
  name: z.string(),
  tools: z.array(z.string()).nullable().optional(),
  read: z.boolean().optional(),
});

/** `env_set`: values maps setting names to their text values. */
export const envSetSchema = z.object({
  type: z.literal("env_set"),
  values: z.record(z.string(), z.string()),
});
