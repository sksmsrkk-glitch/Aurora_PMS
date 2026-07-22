/** Converts unexpected route failures into non-sensitive public responses. */
import { randomUUID } from "node:crypto";

export type SafeConflictRule = {
  pattern: RegExp;
  error: string;
  status?: number;
};

export function safeRouteError(
  error: unknown,
  options: {
    context: string;
    conflicts?: readonly SafeConflictRule[];
    logger?: (entry: Record<string, unknown>) => void;
  },
) {
  const message = error instanceof Error ? error.message : String(error);
  const conflict = options.conflicts?.find((rule) => rule.pattern.test(message));
  if (conflict) {
    return {
      status: conflict.status ?? 409,
      body: { error: conflict.error },
    };
  }
  const errorId = randomUUID();
  (options.logger ?? ((entry) => console.error("[TALOS_ROUTE_ERROR]", entry)))({
    errorId,
    context: options.context,
    error: error instanceof Error ? error.name : "UnknownError",
    message,
  });
  return {
    status: 500,
    body: {
      error: "처리 중 일시적인 문제가 발생했습니다. 문제가 계속되면 오류 ID를 관리자에게 알려 주세요.",
      errorId,
    },
  };
}
