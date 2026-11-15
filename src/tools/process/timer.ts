// A timer that can be cancelled. `done` resolves to "timeout" when it fires.
export interface Timer {
  done: Promise<"timeout">;
  cancel(): void;
}

export function timer(ms: number): Timer {
  let handle: ReturnType<typeof setTimeout> | undefined;
  const done = new Promise<"timeout">((resolve) => {
    handle = setTimeout(() => resolve("timeout"), ms);
  });
  return { done, cancel: () => clearTimeout(handle) };
}
