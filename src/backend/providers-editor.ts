import type { Emit } from "../protocol/protocol.ts";
import type { ProviderInput } from "../core/messages.ts";
import type { SessionPorts } from "./ports.ts";

// The llama.cpp servers the page shows and edits. Each function answers with events and never throws.

// Sends the servers, without their keys. Sent at the start and after each save.
export async function announceProviders(ports: SessionPorts, emit: Emit): Promise<void> {
  if (ports.providers === undefined) return;
  const listed = await ports.providers.list();
  if (!listed.ok) {
    emit({ kind: "error", message: `could not read the providers: ${listed.error.message}` });
    return;
  }
  emit({ kind: "providers", servers: listed.value });
}

// Writes the servers the page sent, then sends them again. A change applies at the next start.
export async function writeProvidersFor(ports: SessionPorts, emit: Emit, servers: ProviderInput[]): Promise<void> {
  if (ports.providers === undefined) {
    emit({ kind: "error", message: "providers are not available here" });
    return;
  }
  const saved = await ports.providers.save(servers);
  if (!saved.ok) {
    emit({ kind: "error", message: `could not save the providers: ${saved.error.message}` });
    return;
  }
  emit({ kind: "notice", text: "saved the providers; a change applies at the next start" });
  await announceProviders(ports, emit);
}
