/** Simulate a different OS process in tests, AFTER draining the prior worker.
 * Overlap tests retain old module references to model separate process globals.
 * A module reload alone must NOT reset production authority.
 */
export function forgetTestProcess(): void {
  Reflect.deleteProperty(globalThis, Symbol.for('kyneloom.live.process-state.v1'));
}
