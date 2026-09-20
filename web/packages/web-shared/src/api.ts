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

/// What a failed request says, which is never nothing.
///
/// The status code is the only field always present. An error body can be
/// empty, `{"error": ""}` is not nullish so it survives a `??`, and
/// `res.statusText` is empty over HTTP/2, which carries no reason phrase and is
/// how this SPA is served. A view that renders the message on truthiness draws
/// nothing for any of those, so a failed request reads as a successful one.
/// The service's own words are better than a number whenever it has any.
function failureMessage(reported: unknown, status: number): string {
  const text = reported == null ? "" : String(reported);
  return text.trim() === "" ? `HTTP ${status}` : text;
}
