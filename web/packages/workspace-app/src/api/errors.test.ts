// The refusal readers: the sentence a person reads and the parsed body a
// caller branches on, for the bodies a server or a proxy in front of it can
// send. Which policy each transport applies is pinned beside that transport.

import { describe, expect, test } from "vitest";
import { ApiError, apiErrorFromText, readApiError } from "./errors";

/// A refusal whose body the network lost after the status line arrived.
function unreadableBody(status: number, statusText: string): Response {
  const response = new Response('{"error":"lost"}', { status, statusText });
  Object.defineProperty(response, "text", {
    value: () => Promise.reject(new TypeError("network error")),
  });
  return response;
}

describe("apiErrorFromText", () => {
  test.each(["", " \t"])("keeps a blank error %j as the sentence by default", (blank) => {
    const body = { error: blank, code: "blank_refusal" };
    const error = apiErrorFromText(409, "Conflict", JSON.stringify(body));
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 409, message: blank, data: body });
  });

  test.each(["", " \t"])("gives the raw body for a blank error %j when blanks are refused", (blank) => {
    const body = { error: blank, code: "blank_refusal" };
    const text = JSON.stringify(body);
    const error = apiErrorFromText(409, "Conflict", text, { allowBlankMessage: false });
    expect(error).toMatchObject({ status: 409, message: text, data: body });
  });

  test.each([
    ["a string", '"refused"', "refused"],
    ["a number", "42", 42],
    ["an array", '["refused"]', ["refused"]],
  ] as const)("keeps JSON that is %s as data beside its raw text", (_kind, text, data) => {
    const error = apiErrorFromText(500, "Internal Server Error", text);
    expect(error).toMatchObject({ status: 500, message: text, data });
  });
});

describe("readApiError", () => {
  test.each([
    ["Bad Gateway", "Bad Gateway"],
    ["", "HTTP 502"],
  ])("reads status text %j as %j when the body cannot be read", async (statusText, message) => {
    const error = await readApiError(unreadableBody(502, statusText));
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 502, message, data: null });
  });
});
