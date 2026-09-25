// Record the HTTP requests the app sends through the transport seam and
// answer each one, so a test asserts on the request an api call makes and on
// the value the call returns, rather than on how the client spells it.

import { setFetchImpl } from "../api/transport";

export interface RecordedRequest {
  method: string;
  /// The path the request went to, without the query string.
  path: string;
  query: URLSearchParams;
  headers: Headers;
  /// The body: parsed when it is JSON, as sent otherwise, null when absent.
  body: unknown;
}

/// Route every request to `respond` and record it. Undo with
/// `stopRecordingRequests`.
export function recordRequests(
  respond: (request: RecordedRequest) => Response | Promise<Response> = () => json({}),
): RecordedRequest[] {
  const requests: RecordedRequest[] = [];
  setFetchImpl(async (input, init) => {
    const url = new URL(String(input), window.location.href);
    const request: RecordedRequest = {
      method: (init?.method ?? "GET").toUpperCase(),
      path: url.pathname,
      query: url.searchParams,
      headers: new Headers(init?.headers),
      body: parseBody(init?.body),
    };
    requests.push(request);
    return respond(request);
  });
  return requests;
}

export function stopRecordingRequests(): void {
  setFetchImpl(null);
}

/// A JSON response.
export function json(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
  });
}

function parseBody(body: BodyInit | null | undefined): unknown {
  if (body === undefined || body === null) return null;
  if (typeof body !== "string") return body;
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}
