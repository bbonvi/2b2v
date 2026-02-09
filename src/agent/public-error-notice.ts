import type { UiLang } from "../config/types";

export type PublicErrorKind = "timeout" | "generic";

export function classifyPublicErrorKind(error: unknown): PublicErrorKind {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  if (normalized.includes("timed out") || normalized.includes("timeout")) {
    return "timeout";
  }
  return "generic";
}

function buildPublicErrorNotice(kind: PublicErrorKind, uiLang: UiLang): string {
  if (uiLang === "ru") {
    if (kind === "timeout") {
      return "[SYSTEM ERROR] Не успела ответить вовремя, попробуй еще раз.";
    }
    return "[SYSTEM ERROR] Внутренняя ошибка бота. Попробуй еще раз.";
  }

  if (kind === "timeout") {
    return "[SYSTEM ERROR] Request timed out. Please try again.";
  }
  return "[SYSTEM ERROR] Internal bot failure. Please try again.";
}

export function buildPublicErrorNoticeForError(error: unknown, uiLang: UiLang): string {
  return buildPublicErrorNotice(classifyPublicErrorKind(error), uiLang);
}
