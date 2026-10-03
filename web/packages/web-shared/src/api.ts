// Shared fetch wrapper for the SPA embedded by identity-service.
// credentials: include so the __Host-id_session cookie set by identity-service
// is sent on every /api call.

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function request<T>(
  input: string,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(input, { credentials: "include", ...init });
  if (res.status === 204) return undefined as T;
  const body = res.headers.get("content-type")?.includes("application/json")
    ? await res.json()
    : await res.text();
  if (!res.ok) {
    throw new HttpError(
      res.status,
      failureMessage(typeof body === "string" ? body : body?.error, res.status),
    );
  }
  return body as T;
}

/// Prefer a nonblank service message, with the always-present status code as
/// fallback. Profile views use message truthiness to display the failure.
function failureMessage(reported: unknown, status: number): string {
  const text = reported == null ? "" : String(reported);
  return text.trim() === "" ? `HTTP ${status}` : text;
}
