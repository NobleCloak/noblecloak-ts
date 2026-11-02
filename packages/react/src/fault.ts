/**
 * A fault in a host callback or store, or one the module could not handle: reported like an uncaught exception
 * where the runtime has `reportError` (browsers; Node has none), and otherwise written to `console.error` as
 * `name: message` and never as the object, which may carry host data. It is never rethrown into the code that
 * called the host. Internal: the package entries do not export it.
 */
export function reportFault(fault: unknown): void {
  if (typeof globalThis.reportError === 'function') {
    globalThis.reportError(fault);
    return;
  }
  const name = fault instanceof Error ? fault.name : 'Error';
  const message =
    fault instanceof Error ? fault.message : 'a value that is not an Error was thrown';
  console.error(`${name}: ${message}`);
}
