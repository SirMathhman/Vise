import type { streamChat } from "./stream-reader.ts";

/** What a streamed request asks of the server: usage, prompt progress while it reads, and a running count of what it writes. */
export const STREAM_FIELDS = {
  stream: true,
  stream_options: { include_usage: true },
};

/** The llama.cpp-only extras of a streamed request. */
export const LLAMA_STREAM_FIELDS = { return_progress: true, timings_per_token: true };

/** Added to the one request that follows a loop: llama.cpp's DRY sampler and a repeat penalty. */
export const ANTI_REPEAT_FIELDS = {
  dry_multiplier: 0.8,
  dry_base: 1.75,
  dry_allowed_length: 4,
  repeat_penalty: 1.1,
};

/** Read one model reply, and tell `generation` (if any) when the call has ended, however it ended. */
export async function readReply(
  read: () => ReturnType<typeof streamChat>,
  generation?: { done(): void },
): ReturnType<typeof streamChat> {
  try {
    return await read();
  } finally {
    generation?.done();
  }
}
