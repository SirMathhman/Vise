import { createFileStateStore, type SaveStatus } from "./fileState.js";

/** A fake persist whose behavior and calls we can control and observe. */
function fakePersist(): {
  persist: (rel: string, value: string) => Promise<void>;
  calls: Array<{ rel: string; value: string }>;
  setReject: (msg: string) => void;
} {
  const calls: Array<{ rel: string; value: string }> = [];
  let rejectMsg: string | undefined;
  const persist = async (rel: string, value: string): Promise<void> => {
    calls.push({ rel, value });
    if (rejectMsg) throw new Error(rejectMsg);
  };
  return {
    persist,
    calls,
    setReject: (msg: string) => {
      rejectMsg = msg;
    },
  };
}

/** Build a store with a controllable reader and captured status events. */
function makeStore(
  readerValue: string | undefined,
  persist?: (rel: string, value: string) => Promise<void>
) {
  const statuses: Array<{ state: SaveStatus; message?: string }> = [];
  const reader = { current: readerValue };
  const { persist: fp, calls, setReject } = fakePersist();
  const store = createFileStateStore(persist ?? fp, (state, message) => {
    statuses.push({ state, message });
  });
  store.setReader(() => reader.current);
  return {
    store,
    statuses,
    calls,
    setReaderValue: (v: string | undefined) => {
      reader.current = v;
    },
    setReject,
  };
}

describe("fileState store", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it("tracks dirty state via markDirty / resetDirty", () => {
    const { store } = makeStore("x");
    expect(store.isDirty()).toBe(false);
    store.markDirty();
    expect(store.isDirty()).toBe(true);
    store.resetDirty();
    expect(store.isDirty()).toBe(false);
  });

  it("beginLoad sets rel + content and clears dirty", () => {
    const { store } = makeStore("x");
    store.markDirty();
    store.beginLoad("a.txt", "abc");
    expect(store.getRel()).toBe("a.txt");
    expect(store.getContent()).toBe("abc");
    expect(store.isDirty()).toBe(false);
  });

  it("save() is a no-op when the buffer is unchanged", async () => {
    const { store, statuses, calls } = makeStore("abc");
    store.beginLoad("a.txt", "abc");
    await store.save();
    expect(calls).toHaveLength(0);
    expect(statuses).toEqual([{ state: "saved" }]);
  });

  it("save() persists changes and reports saving -> saved", async () => {
    const { store, statuses, calls, setReaderValue } = makeStore("abc");
    store.beginLoad("a.txt", "abc");
    setReaderValue("abc edited");
    await store.save();
    expect(calls).toEqual([{ rel: "a.txt", value: "abc edited" }]);
    expect(statuses.map((s) => s.state)).toEqual(["saving", "saved"]);
    expect(store.getContent()).toBe("abc edited");
    expect(store.isDirty()).toBe(false);
  });

  it("save() keeps dirty and reports error when persist fails", async () => {
    const { store, statuses, setReject, setReaderValue } = makeStore("abc");
    store.beginLoad("a.txt", "abc");
    setReaderValue("abc edited");
    store.markDirty();
    setReject("boom");
    await store.save();
    expect(store.isDirty()).toBe(true);
    expect(store.getContent()).toBe("abc");
    expect(statuses.at(-1)).toEqual({ state: "error", message: "boom" });
  });

  it("flush() resolves true when clean", async () => {
    const { store } = makeStore("abc");
    store.beginLoad("a.txt", "abc");
    expect(await store.flush()).toBe(true);
  });

  it("flush() persists a dirty buffer and resolves true", async () => {
    const { store, calls, setReaderValue } = makeStore("abc");
    store.beginLoad("a.txt", "abc");
    setReaderValue("abc saved");
    store.markDirty();
    expect(await store.flush()).toBe(true);
    expect(calls).toEqual([{ rel: "a.txt", value: "abc saved" }]);
    expect(store.isDirty()).toBe(false);
  });

  it("flush() resolves false, keeps dirty, and reports error on failure", async () => {
    const { store, statuses, setReject, setReaderValue } = makeStore("abc");
    store.beginLoad("a.txt", "abc");
    setReaderValue("abc saved");
    store.markDirty();
    setReject("network down");
    expect(await store.flush()).toBe(false);
    expect(store.isDirty()).toBe(true);
    expect(statuses.at(-1)).toEqual({
      state: "error",
      message: "network down",
    });
  });

  it("beginLoad clears a pending scheduled save", () => {
    const { store, calls, setReaderValue } = makeStore("abc");
    store.beginLoad("a.txt", "abc");
    setReaderValue("abc pending");
    store.markDirty();
    store.scheduleSave();
    store.beginLoad("b.txt", "other");
    jest.advanceTimersByTime(1000);
    expect(calls).toHaveLength(0);
  });

  it("scheduleSave debounces and persists after the window", async () => {
    const { store, calls, setReaderValue } = makeStore("abc");
    store.beginLoad("a.txt", "abc");
    setReaderValue("abc auto");
    store.markDirty();
    store.scheduleSave();
    store.scheduleSave();
    await jest.advanceTimersByTimeAsync(1000);
    expect(calls).toEqual([{ rel: "a.txt", value: "abc auto" }]);
    expect(store.isDirty()).toBe(false);
  });

  it("clearTimer cancels a pending scheduled save", () => {
    const { store, calls, setReaderValue } = makeStore("abc");
    store.beginLoad("a.txt", "abc");
    setReaderValue("abc pending");
    store.markDirty();
    store.scheduleSave();
    store.clearTimer();
    jest.advanceTimersByTime(1000);
    expect(calls).toHaveLength(0);
  });
});
