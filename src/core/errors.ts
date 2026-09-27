export interface Message {
  role: "system" | "user" | "assistant";
  content: string;
}

export type ViseError =
  | { kind: "http"; status: number; body: string }
  | { kind: "network"; cause: string }
  | { kind: "malformed"; body: string };

export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; error: ViseError };
