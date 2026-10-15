import { clearSessionContinuation } from "./workspace-memory";

// Client-side helper for POST /api/agent/[id].
//
// Every /api/agent/[id] route returns one of:
//   { success: true, data: <result> }
//   { error: string }              (non-2xx)
//
// Call sites previously repeated the same 5-line fetch block 13× in
// hooks/useAgentSession.ts. This helper collapses that down to one line.

export class AgentCommandError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
    public readonly accepted?: boolean,
  ) {
    super(message);
    this.name = "AgentCommandError";
  }
}

export function isPromptRejectedError(error: unknown): error is AgentCommandError {
  return error instanceof AgentCommandError
    && (error.code === "prompt_rejected" || error.code === "runtime_expired")
    && error.accepted === false;
}

export async function sendAgentCommand<T = unknown>(
  sessionId: string,
  command: Record<string, unknown>,
  runtime?: { current: string | null; onSessionId?: (id: string, expiredRuntimeId: string) => void },
): Promise<T> {
  const runtimeId = runtime?.current;
  const res = await fetch(`/api/agent/${encodeURIComponent(runtimeId ?? sessionId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(command),
  });
  const body = (await res.json().catch(() => ({}))) as {
    success?: boolean;
    data?: T;
    error?: string;
    code?: string;
    accepted?: boolean;
    sessionId?: string;
  };
  if (!res.ok || body.error) {
    // Retry only when the server guarantees that the expired handle executed nothing.
    if (runtimeId && runtime?.current === runtimeId && res.status === 404
      && body.code === "runtime_expired" && body.accepted === false && body.sessionId) {
      runtime.current = null;
      clearSessionContinuation(undefined, runtimeId);
      runtime.onSessionId?.(body.sessionId, runtimeId);
      return sendAgentCommand<T>(body.sessionId, command);
    }
    throw new AgentCommandError(
      body.error ?? `HTTP ${res.status}`,
      res.status,
      body.code,
      body.accepted,
    );
  }
  return body.data as T;
}
