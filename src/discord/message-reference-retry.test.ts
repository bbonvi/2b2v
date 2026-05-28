import { describe, expect, mock, test } from "bun:test";
import {
  isUnknownMessageReferenceError,
  sendWithUnknownMessageReferenceFallback,
} from "./message-reference-retry";

describe("isUnknownMessageReferenceError", () => {
  test("recognizes Discord's Invalid Form Body reply-reference error text", () => {
    const error = new Error("Invalid Form Body\nmessage_reference[MESSAGE_REFERENCE_UNKNOWN_MESSAGE]: Unknown message");

    expect(isUnknownMessageReferenceError(error)).toBe(true);
  });

  test("recognizes nested Discord raw error payloads", () => {
    const error = {
      code: 50035,
      rawError: {
        message: "Invalid Form Body",
        errors: {
          message_reference: {
            _errors: [{ code: "MESSAGE_REFERENCE_UNKNOWN_MESSAGE", message: "Unknown message" }],
          },
        },
      },
    };

    expect(isUnknownMessageReferenceError(error)).toBe(true);
  });

  test("does not match unrelated Discord API errors", () => {
    const error = { code: 50035, rawError: { message: "Invalid Form Body", errors: { content: "Required field" } } };

    expect(isUnknownMessageReferenceError(error)).toBe(false);
  });
});

describe("sendWithUnknownMessageReferenceFallback", () => {
  test("falls back only for unknown reply-reference errors", async () => {
    const onFallback = mock(() => {});
    const result = await sendWithUnknownMessageReferenceFallback(
      () => Promise.reject(new Error("message_reference[MESSAGE_REFERENCE_UNKNOWN_MESSAGE]: Unknown message")),
      () => Promise.resolve("sent normally"),
      onFallback,
    );

    expect(result).toBe("sent normally");
    expect(onFallback).toHaveBeenCalledTimes(1);
  });

  test("rethrows unrelated send failures", async () => {
    const error = new Error("Missing Permissions");

    let thrown: unknown;
    try {
      await sendWithUnknownMessageReferenceFallback(
        () => Promise.reject(error),
        () => Promise.resolve("sent normally"),
      );
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBe(error);
  });
});
