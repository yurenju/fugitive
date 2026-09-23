/** An error as one line of log: the stack when there is one, so the failure can be placed in the code. */
export function errorText(e: unknown): string {
  return e instanceof Error ? (e.stack ?? e.message) : String(e);
}

/**
 * One structured line per failure we do not re-throw. Workers Observability groups on `event`, so a
 * failure nobody sees at the time is still findable afterwards. Failures that are the caller's normal
 * answer (a bad signature, a malformed header) are not failures here and must not be logged.
 */
export function logFailure(event: string, e: unknown, extra: Record<string, unknown> = {}): void {
  console.error(JSON.stringify({ event, ...extra, error: errorText(e) }));
}
