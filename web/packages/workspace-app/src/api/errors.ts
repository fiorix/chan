// Shared error type for any API call, regardless of transport.
//
// Lives in its own module so the transport layer can throw it without
// pulling in the rest of `client.ts` and creating a cycle.

export class ApiError extends Error {
  public status: number;
  /// Parsed JSON body when the server returned one (e.g. the 409
  /// conflict body { current_mtime_ns } from the CAS write path).
  /// Null when the body wasn't JSON or was empty. Callers that
  /// care about a specific status code branch on it without paying
  /// the parse on the happy path.
  public data: unknown | null;

  constructor(status: number, message: string, data?: unknown) {
    super(message);
    this.status = status;
    this.data = data ?? null;
  }
}

/** A workspace tenant can remain alive long enough to report that its source
 * root was removed externally. Keep this classifier in the transport leaf so
 * File Browser and Graph error paths agree without importing app state. */
export function isWorkspaceRootMissingError(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.status === 404 &&
    error.message.toLowerCase().includes("workspace root does not exist")
  );
}
