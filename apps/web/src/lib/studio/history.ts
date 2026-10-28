/**
 * KYN-17 — intentional undo/redo history.
 *
 * History advances ONLY at explicit command boundaries (a completed edit
 * operation from the inspector or a committed timeline drag) — never per
 * render frame, never per keystroke. The past stack is BOUNDED, so a long
 * editing session cannot leak memory; redo futures are cleared by any new
 * command, exactly like every professional editor.
 */

const MAX_HISTORY = 100;

export interface DraftHistory<T> {
  readonly past: readonly T[];
  readonly present: T;
  readonly future: readonly T[];
}

export function createHistory<T>(initial: T): DraftHistory<T> {
  return { past: [], present: initial, future: [] };
}

/** Commit the next document as one undoable command. */
export function applyCommand<T>(history: DraftHistory<T>, next: T): DraftHistory<T> {
  const past = [...history.past, history.present];
  if (past.length > MAX_HISTORY) past.splice(0, past.length - MAX_HISTORY);
  return { past, present: next, future: [] };
}

export function undo<T>(history: DraftHistory<T>): DraftHistory<T> {
  if (history.past.length === 0) return history;
  const previous = history.past[history.past.length - 1]!;
  return {
    past: history.past.slice(0, -1),
    present: previous,
    future: [history.present, ...history.future],
  };
}

export function redo<T>(history: DraftHistory<T>): DraftHistory<T> {
  if (history.future.length === 0) return history;
  const next = history.future[0]!;
  return {
    past: [...history.past, history.present],
    present: next,
    future: history.future.slice(1),
  };
}
