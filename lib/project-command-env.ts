/**
 * Sanitized bash operations for commands a project runs on the operator's
 * behalf (`!` commands and the model's bash tool).
 *
 * Ported from upstream pi-web's `lib/project-command-env.ts`: host runtime
 * variables never reach project commands, `~/.omp/bin` joins the PATH, and a
 * command whose process tree refuses to die is released after a grace period
 * so Stop and steering cannot be held by a surviving grandchild (#647). The
 * local default operations run through the omp SDK's own bash executor.
 */
import { getAgentDir } from "@oh-my-pi/pi-coding-agent";
import type { BashOperations } from "@oh-my-pi/pi-coding-agent/extensibility/legacy-pi-coding-agent-shim";
import { executeBash as executeBashCommand } from "@oh-my-pi/pi-coding-agent/exec/bash-executor";
import { join } from "node:path";

// Pi's own abort path settles well within this once the process tree is gone.
const ABORT_SETTLE_GRACE_MS = 1000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

type ProjectCommandBashOperationsOptions = {
  abortSettleGraceMs?: number;
  agentBinDir?: string;
  baseEnvironment?: NodeJS.ProcessEnv;
  localOperations?: BashOperations;
  platform?: NodeJS.Platform;
  shellPath?: string;
};

/** What a project command's exec resolves to once the shell process ends. */
type ProjectBashExecResult = { exitCode: number | null };

function isHostRuntimeVariable(name: string, platform: NodeJS.Platform): boolean {
  const comparableName = platform === "win32" ? name.toUpperCase() : name;
  return comparableName === "PORT"
    || comparableName === "NODE_ENV"
    || comparableName.startsWith("NEXT_")
    // The browser login password guards this server; commands run on behalf of
    // a project (and the model reading their output) have no use for it.
    || comparableName === "PI_WEB_PASSWORD";
}

export function sanitizeProjectCommandEnvironment(
  baseEnvironment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const environment = { ...baseEnvironment };
  for (const name of Object.keys(environment)) {
    if (isHostRuntimeVariable(name, platform)) delete environment[name];
  }
  return environment;
}

function withAgentBinDirectory(
  environment: NodeJS.ProcessEnv,
  agentBinDir: string,
  platform: NodeJS.Platform,
): NodeJS.ProcessEnv {
  const pathKey = platform === "win32"
    ? Object.keys(environment).find((name) => name.toUpperCase() === "PATH") ?? "PATH"
    : "PATH";
  const pathDelimiter = platform === "win32" ? ";" : ":";
  const currentPath = environment[pathKey] ?? "";
  const pathEntries = currentPath.split(pathDelimiter).filter(Boolean);
  if (!pathEntries.includes(agentBinDir)) {
    environment[pathKey] = [agentBinDir, currentPath].filter(Boolean).join(pathDelimiter);
  }
  return environment;
}

/** omp's own executor resolves the shell from its settings; the requested
 *  shell path is honored by callers that route through a user-shell. */
function createLocalBashOperations(options: { shellPath?: string } = {}): BashOperations {
  return {
    async exec(command, cwd, executionOptions) {
      const environment: Record<string, string> = {};
      for (const [name, value] of Object.entries(executionOptions.env ?? process.env)) {
        if (value !== undefined) environment[name] = value;
      }
      const result = await executeBashCommand(command, {
        cwd,
        env: environment,
        signal: executionOptions.signal,
        ...(executionOptions.timeout !== undefined
          ? { timeout: executionOptions.timeout * 1000 }
          : {}),
        ...(executionOptions.onData
          ? { onChunk: (chunk: string) => executionOptions.onData(Buffer.from(chunk)) }
          : {}),
      });
      return { exitCode: result.exitCode ?? null };
    },
  };
}

export function createProjectCommandBashOperations(
  options: ProjectCommandBashOperationsOptions = {},
): BashOperations {
  const {
    abortSettleGraceMs = ABORT_SETTLE_GRACE_MS,
    agentBinDir = join(getAgentDir(), "bin"),
    baseEnvironment = process.env,
    localOperations = createLocalBashOperations({ shellPath: options.shellPath }),
    platform = process.platform,
  } = options;

  return {
    exec(command, cwd, executionOptions) {
      const environment = withAgentBinDirectory(
        sanitizeProjectCommandEnvironment(executionOptions.env ?? baseEnvironment, platform),
        agentBinDir,
        platform,
      );
      const { onData, signal, timeout } = executionOptions;
      let released = false;
      const execution = localOperations.exec(command, cwd, {
        ...executionOptions,
        env: environment,
        // Callers finalize their output once the command is released; a
        // survivor must not append to it afterwards.
        onData: (data) => {
          if (!released) onData(data);
        },
      });
      // Pi rejects any other timeout before it starts the command.
      const timeoutMs = typeof timeout === "number" && Number.isFinite(timeout) && timeout > 0
        ? timeout * 1000
        : undefined;
      if (!signal && timeoutMs === undefined) return execution;

      // On Stop or a timeout, pi kills the shell's process tree but then keeps
      // reading until every inherited stdout/stderr handle falls idle. A
      // descendant the kill cannot reach (its own session on POSIX, an orphan
      // `taskkill /T` misses on Windows) can keep writing and hold the tool
      // call, and with it Stop and any steering, until the script ends on its
      // own (#647). The errors are pi's own, so the bash tool reports them as
      // "Command aborted" and "Command timed out".
      return new Promise<ProjectBashExecResult>((resolve, reject) => {
        const timers: ReturnType<typeof setTimeout>[] = [];
        const release = () => {
          released = true;
          for (const timer of timers) clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
        };
        const releaseAfter = (delayMs: number, error: Error) => {
          timers.push(setTimeout(() => {
            release();
            reject(error);
          }, Math.min(delayMs, MAX_TIMER_DELAY_MS)));
        };
        const onAbort = () => releaseAfter(abortSettleGraceMs, new Error("aborted"));
        if (timeoutMs !== undefined) {
          releaseAfter(timeoutMs + abortSettleGraceMs, new Error(`timeout:${timeout}`));
        }
        execution.then((result) => {
          release();
          resolve(result);
        }, (error: unknown) => {
          release();
          reject(error);
        });
        if (signal?.aborted) onAbort();
        else signal?.addEventListener("abort", onAbort, { once: true });
      });
    },
  };
}
