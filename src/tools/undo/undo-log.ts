// The undo log: what each turn changed, kept in memory. A turn is one message of the user. For each file a
// turn first changes, the log keeps the bytes the file had before that turn, or nothing when it did not exist.
// Every turn keeps its record, because a turn that is not a point now can be one later, when more turns have
// come. The points offered are the turns that are 1, 2, 3, 5, 8, ... back; the records are what makes each
// of them exact.

// The bytes of a file, or undefined when there is no file.
export type Bytes = Uint8Array | undefined;

export interface Turn {
  // Path to the bytes the file had before this turn first changed it.
  changes: Map<string, Bytes>;
}

export interface UndoLog {
  // Oldest first. The last turn is the most recent one.
  turns: Turn[];
  // What Vise last left each file with. A revert is refused when a file no longer holds these bytes.
  expected: Map<string, Bytes>;
}

export function createLog(): UndoLog {
  return { turns: [], expected: new Map() };
}

// Whether a turn this many turns back is kept: the distances are 1, 2, 3, 5, 8, and so on.
export function isKeptDistance(turnsBack: number): boolean {
  let previous = 1;
  let current = 2;
  while (previous < turnsBack) {
    [previous, current] = [current, previous + current];
  }
  return previous === turnsBack;
}

// The distances a revert can use: every kept distance up to the number of turns.
export function pointsOf(log: UndoLog): number[] {
  const points: number[] = [];
  for (let distance = 1; distance <= log.turns.length; distance++) {
    if (isKeptDistance(distance)) points.push(distance);
  }
  return points;
}

// Starts a turn.
export function startTurn(log: UndoLog): void {
  log.turns.push({ changes: new Map() });
}

// Records the bytes a file had before the current turn first changed it. Later changes in the same turn keep
// the first record.
export function recordBefore(log: UndoLog, path: string, before: Bytes): void {
  if (log.turns.length === 0) log.turns.push({ changes: new Map() });
  const turn = log.turns[log.turns.length - 1];
  if (turn !== undefined && !turn.changes.has(path)) turn.changes.set(path, before);
}

// Records the bytes a file holds after Vise changed it.
export function recordAfter(log: UndoLog, path: string, after: Bytes): void {
  log.expected.set(path, after);
}

// The bytes each file should have after a revert to the start of the turn that is `turnsBack` back. The
// oldest kept record for a file among those turns is the one that counts. Undefined when there is no such
// point.
export function planRevert(log: UndoLog, turnsBack: number): Map<string, Bytes> | undefined {
  if (!isKeptDistance(turnsBack) || turnsBack > log.turns.length) return undefined;
  const plan = new Map<string, Bytes>();
  for (let index = log.turns.length - turnsBack; index < log.turns.length; index++) {
    const turn = log.turns[index];
    if (turn === undefined) continue;
    for (const [path, before] of turn.changes) {
      if (!plan.has(path)) plan.set(path, before);
    }
  }
  return plan;
}

// Removes the turns a revert went back over: the turns that are `turnsBack` back and more recent.
export function dropTurns(log: UndoLog, turnsBack: number): void {
  log.turns = log.turns.slice(0, log.turns.length - turnsBack);
}
