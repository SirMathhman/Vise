import type { ProfileDetail } from "../core/notes.ts";
import type { Emit } from "../protocol/protocol.ts";
import type { SessionPorts } from "./ports.ts";

// The profile editing the page does. Each function answers with events and never throws; a failure is
// reported, and the session goes on.

// Sends the profiles the page can edit. Sent at the start and after each save.
export async function announceProfiles(ports: SessionPorts, emit: Emit): Promise<void> {
  if (ports.profiles === undefined) return;
  const listed = await ports.profiles.list();
  if (!listed.ok) {
    emit({ kind: "error", message: `could not list the profiles: ${listed.error.message}` });
    return;
  }
  emit({ kind: "profiles", profiles: listed.value });
}

// Sends one profile's detail, for the page to show in its editor.
export async function readProfileFor(ports: SessionPorts, emit: Emit, name: string): Promise<void> {
  if (ports.profiles === undefined) {
    emit({ kind: "error", message: "profiles are not available here" });
    return;
  }
  const read = await ports.profiles.read(name);
  if (!read.ok) emit({ kind: "error", message: read.error.message });
  else emit({ kind: "profile", profile: read.value });
}

// Writes an edited profile, then sends the list again.
export async function writeProfileFor(
  ports: SessionPorts,
  emit: Emit,
  profile: ProfileDetail,
): Promise<void> {
  if (ports.profiles === undefined) {
    emit({ kind: "error", message: "profiles are not available here" });
    return;
  }
  const written = await ports.profiles.write(profile);
  if (!written.ok) {
    emit({ kind: "error", message: `could not save profile ${profile.name}: ${written.error.message}` });
    return;
  }
  emit({ kind: "notice", text: `saved profile ${profile.name}` });
  await announceProfiles(ports, emit);
}
