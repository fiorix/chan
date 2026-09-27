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

/** Parse the sentence and retain structured details for callers that branch. */
export function apiErrorFromText(
  status: number,
  statusText: string,
  text: string,
  options: { allowBlankMessage?: boolean } = {},
): ApiError {
  let data: unknown = null;
  let message = text || statusText || `HTTP ${status}`;
  if (text) {
    try {
      data = JSON.parse(text);
      if (
        data &&
        typeof data === "object" &&
        "error" in data &&
        typeof data.error === "string" &&
        (options.allowBlankMessage !== false || data.error.trim())
      ) {
        message = data.error;
      }
    } catch {
      // Keep the raw text fallback.
    }
  }
  return new ApiError(status, message, data);
}

/** Read a refusal once, falling back to the response status text. */
export async function readApiError(response: Response): Promise<ApiError> {
  const text = await response.text().catch(() => response.statusText);
  return apiErrorFromText(response.status, response.statusText, text);
}

/** The server's machine-readable refusal code, independent of its sentence. */
export function apiErrorCode(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null;
  const data = error.data;
  return data !== null && typeof data === "object" && "code" in data && typeof data.code === "string"
    ? data.code
    : null;
}

/// True when a request failure is transient and worth retrying: the
/// server is briefly unreachable rather than returning a real error.
/// A `fetch` to a refused/dropped socket throws a bare `TypeError`
/// (not an `ApiError`); our transport maps a timeout to `ApiError(0)`;
/// a server still spinning up its routes (or a tunnel gateway whose
/// upstream is coming back) can answer 502/503/504. A 401 (missing
/// token) or any other 4xx is NOT transient and must surface
/// immediately. Shared by bootstrap, the server-instance health check,
/// and the extension-catalog refresh; lives in this leaf so state
/// modules agree without importing each other.
export function isTransientApiError(e: unknown): boolean {
  if (e instanceof ApiError) {
    return e.status === 0 || e.status === 502 || e.status === 503 || e.status === 504;
  }
  // A connection-refused / dropped-socket fetch rejects with a
  // TypeError; treat any non-ApiError throwable as transient.
  return e instanceof Error;
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
