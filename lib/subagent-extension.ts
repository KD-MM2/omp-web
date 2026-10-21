import type { SubagentRunInfo } from "./subagents";

/**
 * The tool details the upstream subagent extension attaches to its control
 * tool calls. The extension itself (`defineTool`, the host runtime) needs SDK
 * v1 services the omp runtime does not expose, so it is dropped; the shape
 * stays because `MessageView` recognizes the card and future omp-side
 * producers can emit the same details.
 */
export interface SubagentToolDetails {
  kind: "pi-web-subagent";
  sessionId: string;
  profile: string;
  description: string;
  status: SubagentRunInfo["status"];
  runInBackground: boolean;
  createdAt: string;
  completedAt?: string;
  error?: string;
  worktreePath?: string;
  worktreeBranch?: string;
  worktreeCleanupError?: string;
}
