import { execFile } from "child_process";
import { promisify } from "util";
import { nodeCliInvocation } from "./node-cli";

const execFileAsync = promisify(execFile);

export interface RunNpxOptions {
  timeout?: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export interface RunNpxResult {
  stdout: string;
  stderr: string;
}
const SENSITIVE_ENV_NAME_RE = /(?:^|_)(?:API_KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE_KEY|AUTH)(?:$|_)/i;
const SENSITIVE_ENV_FRAGMENT_RE = /(?:auth(?:token)?|userconfig|globalconfig)/i;

function isSensitiveEnvName(name: string): boolean {
  return SENSITIVE_ENV_NAME_RE.test(name) || SENSITIVE_ENV_FRAGMENT_RE.test(name);
}

/**
 * Keep the environment needed by npm/skills while withholding credentials from
 * package code executed by npx. Explicit overrides are still allowed for
 * non-secret process controls such as FORCE_COLOR.
 */
export function getSafeNpxEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const safe = {} as NodeJS.ProcessEnv;
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && !isSensitiveEnvName(name)) safe[name] = value;
  }
  for (const [name, value] of Object.entries(overrides)) {
    if (value !== undefined) safe[name] = value;
  }
  return safe;
}

/** Redact inherited credentials before subprocess output reaches the browser. */
export function redactNpxOutput(value: string, env: Record<string, string | undefined> = process.env): string {
  let redacted = value;
  const secrets = [...new Set(
    Object.entries(env)
      .filter(([name, secret]) => isSensitiveEnvName(name) && typeof secret === "string" && secret.length >= 4)
      .map(([, secret]) => secret as string),
  )].sort((a, b) => b.length - a.length);
  for (const secret of secrets) redacted = redacted.replaceAll(secret, "[REDACTED]");
  return redacted.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 [REDACTED]");
}

/**
 * Cross-platform wrapper for invoking `npx <args>` without ever using a
 * shell, so user-controlled arguments are never interpreted as shell syntax.
 * See `lib/node-cli.ts` for why the bundled `npx-cli.js` is preferred over the
 * `npx` (or `npx.cmd`) on PATH.
 */
export async function runNpx(args: string[], opts: RunNpxOptions = {}): Promise<RunNpxResult> {
  const { command, args: commandArgs } = nodeCliInvocation("npx", args);
  return execFileAsync(command, commandArgs, {
    timeout: opts.timeout,
    cwd: opts.cwd,
    env: opts.env,
  });
}
