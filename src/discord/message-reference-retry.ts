/** Detects Discord's stale reply-reference validation error. */
export function isUnknownMessageReferenceError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  if (message.includes("MESSAGE_REFERENCE_UNKNOWN_MESSAGE")) return true;
  if (message.includes("message_reference") && message.includes("Unknown message")) return true;

  return containsString(error, "MESSAGE_REFERENCE_UNKNOWN_MESSAGE")
    || (containsKey(error, "message_reference") && containsString(error, "Unknown message"));
}

/** Retries a failed Discord reply as a plain send when the reply target vanished. */
export async function sendWithUnknownMessageReferenceFallback<T>(
  sendReply: () => Promise<T>,
  sendFallback: () => Promise<T>,
  onFallback?: (error: unknown) => void,
): Promise<T> {
  try {
    return await sendReply();
  } catch (error) {
    if (!isUnknownMessageReferenceError(error)) throw error;
    onFallback?.(error);
    return await sendFallback();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function containsString(value: unknown, needle: string, seen = new WeakSet<object>()): boolean {
  if (typeof value === "string") return value.includes(needle);
  if (Array.isArray(value)) return value.some((item) => containsString(item, needle, seen));
  if (!isRecord(value)) return false;
  if (seen.has(value)) return false;
  seen.add(value);
  return Object.values(value).some((item) => containsString(item, needle, seen));
}

function containsKey(value: unknown, key: string, seen = new WeakSet<object>()): boolean {
  if (Array.isArray(value)) return value.some((item) => containsKey(item, key, seen));
  if (!isRecord(value)) return false;
  if (seen.has(value)) return false;
  seen.add(value);
  return Object.keys(value).includes(key)
    || Object.values(value).some((item) => containsKey(item, key, seen));
}
