import { expect, test } from "bun:test";
import { busyView } from "../web/src/busy.ts";

const base = {
  server: false,
  steerable: false,
  submitting: false,
  loading: false,
};

test("idle when nothing is happening", () => {
  expect(busyView(base)).toEqual({ busy: false, steering: false });
});

test("a line just sent, or the lists loading, locks the page until the server or the load says otherwise", () => {
  expect(busyView({ ...base, submitting: true }).busy).toBe(true);
  expect(busyView({ ...base, loading: true }).busy).toBe(true);
});

test("a running turn keeps the composer for steering; a running command does not", () => {
  expect(busyView({ ...base, server: true, steerable: true })).toEqual({
    busy: true,
    steering: true,
  });
  expect(busyView({ ...base, server: true, steerable: false })).toEqual({
    busy: true,
    steering: false,
  });
});
