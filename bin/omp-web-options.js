"use strict";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { parseArgs } = require("util");

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);

const CLI_OPTIONS = {
  port: { type: "string", short: "p" },
  hostname: { type: "string", short: "H" },
  "no-open": { type: "boolean" },
  // Turns the password lock on for this run and every later one, asking for
  // a password on the terminal when none has been set yet.
  authenticated: { type: "boolean" },
  // Recovery from the machine itself: replaces the stored password without
  // needing the old one.
  "reset-password": { type: "boolean" },
  help: { type: "boolean", short: "h" },
};

function isEnabled(value) {
  return typeof value === "string" && TRUE_VALUES.has(value.trim().toLowerCase());
}

function normalizePort(value) {
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new Error("Port must be a non-negative integer.");
  }

  const port = Number(value);
  if (!Number.isSafeInteger(port) || port > 65535) {
    throw new Error("Port must be between 0 and 65535.");
  }

  return String(port);
}

function getHelpText() {
  return `Usage: omp-web [command] [options]

Start the omp-web server for the omp (oh-my-pi) coding agent, or run one of
the commands below.

Commands:
  version                    Print the installed omp-web version (also -v, --version)

Options:
  -p, --port <port>          Server port (default: 30141, or PORT)
  -H, --hostname <host>      Bind hostname (default: 127.0.0.1, or OMP_WEB_HOSTNAME)
      --no-open              Do not open a browser automatically
      --authenticated        Require password access (HTTP Basic, username omp)
      --reset-password       Set a new password without knowing the old one
  -h, --help                 Show this help message and exit

Environment:
  PORT                       Default port when --port is omitted
  OMP_WEB_HOSTNAME           Default hostname when --hostname is omitted
  OMP_WEB_NO_OPEN            Set to 1/true/yes/on to disable browser open
  OMP_WEB_APP_NAME           PWA manifest name (trimmed; default omp-web)
  OMP_WEB_PASSWORD           Override the stored password access credential
  OMP_WEB_AUTHENTICATED      Set to 1/true/yes/on to enable password access
  OMP_WEB_AUTH_FILE          Password store location (default ~/.omp/agent/omp-web-auth.json)
  OMP_WEB_DISABLE_SELF_UPDATE  Set to 1 to disable omp-web update checks
`;
}

function toParseError(error) {
  const message = error instanceof Error ? error.message : String(error);
  const err = new Error(`${message}\nUse --help to see available options.`);
  err.code = "ERR_PARSE_ARGS_UNKNOWN_OPTION";
  return err;
}

// Returns { command: "start", ...launch options } for a bare launch, or
// { command: "version", help: false } for the version subcommand.
function parseCommandLine(args = process.argv.slice(2), env = process.env) {
  const first = args[0];
  if (first === "version" || first === "-v" || first === "--version") {
    return { command: "version", help: false };
  }

  return { command: "start", ...parseLaunchOptions(args, env) };
}

function parseLaunchOptions(args = process.argv.slice(2), env = process.env) {
  let values;
  let positionals;
  try {
    ({ values, positionals } = parseArgs({
      args,
      options: CLI_OPTIONS,
      strict: true,
      allowPositionals: true,
    }));
  } catch (error) {
    throw toParseError(error);
  }

  if (values.help) {
    return { help: true };
  }

  if (positionals.length > 0) {
    throw new Error(
      `Unexpected argument(s): ${positionals.join(" ")}\nUse --help to see available options.`,
    );
  }

  return {
    help: false,
    port: normalizePort(values.port ?? env.PORT ?? "30141"),
    hostname: values.hostname ?? env.OMP_WEB_HOSTNAME ?? "127.0.0.1",
    openBrowser: !values["no-open"] && !isEnabled(env.OMP_WEB_NO_OPEN),
    authenticated: Boolean(values.authenticated) || isEnabled(env.OMP_WEB_AUTHENTICATED),
    resetPassword: Boolean(values["reset-password"]),
  };
}

module.exports = { parseCommandLine, parseLaunchOptions, getHelpText };
