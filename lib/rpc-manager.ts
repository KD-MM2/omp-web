import { isDeepStrictEqual } from "node:util";
import { getSetting } from "@/lib/omp-settings";
import type { ConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";
import {
  applyResolvedSystemPromptInputs,
  createAgentSession,
  type CreateAgentSessionOptions,
  discoverSessionExtensionPaths,
  getAgentDir,
  initTheme,
  SessionManager,
  Theme,
} from "@oh-my-pi/pi-coding-agent";
import { buildAvailableSlashCommands } from "@oh-my-pi/pi-coding-agent/slash-commands/available-commands";
import { BUILTIN_SLASH_COMMAND_DEFS } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import { executeAcpBuiltinSlashCommand, type AcpBuiltinSlashCommandResult } from "@oh-my-pi/pi-coding-agent/slash-commands/acp-builtins";
import { discoverCustomToolPaths } from "@oh-my-pi/pi-coding-agent/extensibility/custom-tools";
import { initializeExtensions } from "@oh-my-pi/pi-coding-agent/modes/runtime-init";
import { readPlanFile } from "@oh-my-pi/pi-coding-agent/plan-mode/plan-files";
import {
  readRpcSubagentTranscript,
  RpcSubagentRegistry,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-subagents";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { KeybindingsManager as TuiKeybindingsManager, TUI_KEYBINDINGS } from "@oh-my-pi/pi-tui";
import { randomUUID } from "crypto";
import { existsSync, realpathSync, writeFileSync } from "fs";
import { resolve } from "path";
import { validateAgentImages } from "./image-attachments";
import { invalidateModelsCache } from "./models-cache";
import { resolveVisibleModels, selectInitialModelScope } from "./model-scope";
import { cacheSessionPath, invalidateSessionListCache, readLatestSessionEntryId } from "./session-reader";
import {
  appendClearedSessionToolSelection,
  appendSessionToolSelection,
  readSessionToolSelection,
  validateSessionToolSelection,
} from "./session-tool-selection";
import { getProjectTrustStatus, untrustedProjectSessionOptions } from "./project-trust";
import { createProjectCommandBashOperations } from "./project-command-env";
import { hasActiveSessionLivenessProvider } from "./session-liveness";
import { isNestedToolExecutionEvent } from "./agent-event-wire";
import { resolveSessionSystemPrompts } from "./session-system-prompt";
import { readDefaultModelRole } from "./model-roles";
import { getOmpRuntime, getSettingsForCwd } from "./omp-runtime";
import { PRESET_FULL } from "./tool-presets";
import { readSubagentRun } from "./subagents";
import { persistExplicitStartupPreferences } from "./startup-preferences";
import type { SlashCommandInfo } from "./omp-types";
import type { AgentSessionLike, ExtensionUiContextLike, ToolInfo } from "./omp-types";
import { GoalModeController } from "./goal-mode";
import type {
  ExtensionAskDialogResult,
  ExtensionUiRequest,
  ExtensionUiResponse,
  ExtensionWidgetItem,
  SessionInfo,
  SessionMessageEntry,
  SessionEntry,
  SubagentSnapshot,
} from "./types";
import { createHeadlessCustomUiTui, DEFAULT_CUSTOM_UI_COLUMNS, type HeadlessCustomUiTui } from "./custom-ui-terminal";

// ============================================================================
// Types
// ============================================================================

// The fork's @types/node does not export `Timeout` from node:timers yet.
type Timeout = ReturnType<typeof setTimeout>;

export interface AgentEvent {
  type: string;
  [key: string]: unknown;
}

type EventListener = (event: AgentEvent) => void;

type PendingUiResponse = {
  resolve: (response: ExtensionUiResponse) => void;
  cancel: () => void;
};

type CustomUiComponent = {
  render: (width: number) => string[];
  handleInput?: (data: string) => void;
  dispose?: () => void;
  invalidate?: () => void;
};

type ExtensionWidgetComponent = {
  render: (width: number) => unknown;
  dispose?: () => void;
};

type ExtensionWidgetFactory = (tui: HeadlessCustomUiTui, theme: Theme) => unknown;

type ActiveExtensionWidget = {
  key: string;
  component: ExtensionWidgetComponent;
  placement: "aboveEditor" | "belowEditor";
  generation: number;
  clearEmitted: boolean;
  rendered: boolean;
};

/** The subset of pi's extension command context pi-web projects for `bindExtensions` hosts. */
type ExtensionCommandContextActionsLike = {
  waitForIdle: () => Promise<void>;
  newSession: () => Promise<{ cancelled: boolean }>;
  fork: () => Promise<{ cancelled: boolean }>;
  navigateTree: (targetId: string, options?: { summarize?: boolean }) => Promise<{ cancelled: boolean }>;
  switchSession: () => Promise<{ cancelled: boolean }>;
  reload: () => Promise<void>;
};

/** Host settings surface omp-web reads; SDK builds and test doubles vary, so every member is optional. */
type HostSettingsLike = {
  setProjectTrusted?: (trusted: boolean) => void;
  getShellPath?: () => string | undefined;
};

/** Session manager variants: doubles and non-omp hosts may persist no entries. */
type HostSessionManagerLike = {
  getEntries?: () => Array<{ type?: string; mode?: string; data?: Record<string, unknown> }>;
};

type ActiveCustomUi = {
  component: CustomUiComponent;
  width: number;
  resolve: (value: unknown) => void;
  settled: boolean;
};

type ExtensionUiRequestBody = Record<string, unknown> & {
  method: ExtensionUiRequest["method"];
  timeout?: number;
  expiresAt?: number;
};

type ExtensionBindingOptions = {
  forceEmptySystemPrompt?: boolean;
};

const RUNNING_STATE_EVENT_TYPES = new Set([
  "agent_start",
  "agent_end",
  "agent_settled",
  "auto_compaction_start",
  "auto_compaction_end",
  "compaction_start",
  "compaction_end",
]);

const IDLE_RESET_EVENT_TYPES = new Set([
  "agent_end",
  "agent_settled",
  "auto_compaction_end",
  "compaction_end",
]);

const MAX_SUBAGENT_HISTORY = 128;

const HANDOFF_ALLOWED_COMMAND_TYPES: Record<string, true> = {
  abort: true,
  extension_ui_input: true,
  extension_ui_response: true,
  get_commands: true,
  get_last_assistant_text: true,
  get_session_stats: true,
  get_state: true,
  get_subagent_messages: true,
  get_subagents: true,
  get_tools: true,
};

type ForkBranchEntry = {
  id?: string;
  type?: string;
  message?: { role?: string };
};

export function resolveForkEntryId(
  entries: readonly ForkBranchEntry[],
  requestedEntryId?: unknown,
): string | undefined {
  if (typeof requestedEntryId === "string" && requestedEntryId.length > 0) return requestedEntryId;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.type === "message" && entry.message?.role === "user" && entry.id) return entry.id;
  }
  return undefined;
}

export interface RpcSessionStartOptions {
  toolNames?: string[];
  initialModel?: { provider: string; modelId: string };
  thinkingLevel?: ConfiguredThinkingLevel;
}

const CODING_TOOL_NAMES: Record<string, true> = Object.fromEntries(
  PRESET_FULL.map((name) => [name, true]),
);

// Extensions require a complete Theme, while the web UI applies its own styling.
class PlainTextTheme extends Theme {
  constructor() {
    super(
      { thinkingXhigh: "" } as ConstructorParameters<typeof Theme>[0],
      {} as ConstructorParameters<typeof Theme>[1],
      "truecolor",
      "unicode",
      {},
    );
  }

  override fg(...[, text]: Parameters<Theme["fg"]>): string { return text; }
  override bg(...[, text]: Parameters<Theme["bg"]>): string { return text; }
  override bold(text: string): string { return text; }
  override italic(text: string): string { return text; }
  override underline(text: string): string { return text; }
  override inverse(text: string): string { return text; }
  override strikethrough(text: string): string { return text; }
  override getFgAnsi(): string { return ""; }
  override getBgAnsi(): string { return ""; }
  override getThinkingBorderColor(): (text: string) => string {
    return (text) => text;
  }
  override getBashModeBorderColor(): (text: string) => string { return (text) => text; }
}

const PLAIN_TEXT_THEME = new PlainTextTheme();
const CUSTOM_UI_KEYBINDINGS = new TuiKeybindingsManager(TUI_KEYBINDINGS);

const DEFAULT_SESSION_IDLE_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Resolves the PI_WEB_IDLE_TIMEOUT_MS environment variable into a session idle
 * timeout in milliseconds. An unset/blank value returns the 10-minute default,
 * `0` disables idle shutdown, and positive values up to Node's timer limit
 * (2147483647 ms) are used as-is. Invalid or out-of-range values fall back to
 * the default with a console warning.
 * @param rawValue Value to parse; defaults to the environment variable.
 */
export function resolveSessionIdleTimeoutMs(
  rawValue: string | undefined = process.env.PI_WEB_IDLE_TIMEOUT_MS,
): number {
  if (rawValue !== undefined && rawValue.trim() !== "") {
    const parsed = Number(rawValue);
    if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 2_147_483_647) return parsed;
    console.warn(`[pi-web] invalid PI_WEB_IDLE_TIMEOUT_MS "${rawValue}", falling back to 10 minutes`);
  }
  return DEFAULT_SESSION_IDLE_TIMEOUT_MS;
}

const SESSION_IDLE_TIMEOUT_MS = resolveSessionIdleTimeoutMs();

const DEFAULT_SESSION_SHUTDOWN_DEADLINE_MS = 5_000;

/**
 * Resolves the PI_WEB_SHUTDOWN_DEADLINE_MS environment variable into the time
 * extensions get to handle `session_shutdown` before the wrapper disposes the
 * SDK session anyway. An unset/blank value returns the 5-second default, and
 * positive values up to Node's timer limit (2147483647 ms) are used as-is.
 * `0`, invalid and out-of-range values fall back to the default with a console
 * warning: shutdown always has a deadline.
 * @param rawValue Value to parse; defaults to the environment variable.
 */
export function resolveSessionShutdownDeadlineMs(
  rawValue: string | undefined = process.env.PI_WEB_SHUTDOWN_DEADLINE_MS,
): number {
  if (rawValue !== undefined && rawValue.trim() !== "") {
    const parsed = Number(rawValue);
    if (Number.isFinite(parsed) && parsed > 0 && parsed <= 2_147_483_647) return parsed;
    console.warn(`[pi-web] invalid PI_WEB_SHUTDOWN_DEADLINE_MS "${rawValue}", falling back to 5 seconds`);
  }
  return DEFAULT_SESSION_SHUTDOWN_DEADLINE_MS;
}

const SESSION_SHUTDOWN_DEADLINE_MS = resolveSessionShutdownDeadlineMs();

function withExtensionTools(session: AgentSessionLike, toolNames: string[]): string[] {
  if (toolNames.length === 0) return [];

  const extensionToolNames = session
    .getAllToolNames()
    .filter((name) => CODING_TOOL_NAMES[name] !== true);

  return [...new Set([...toolNames, ...extensionToolNames])];
}

/** Tool descriptors for the browser's tool picker. */
function listTools(session: AgentSessionLike): ToolInfo[] {
  return session.getAllToolNames().map((name) => ({
    name,
    description: session.getToolByName(name)?.description ?? "",
  }));
}

type AvailableCommandsSession = Parameters<typeof buildAvailableSlashCommands>[0];

function appendSlashCommand(
  commands: SlashCommandInfo[],
  seenNames: Set<string>,
  command: SlashCommandInfo,
): void {
  const name = command.name.trim();
  if (!name || seenNames.has(name)) return;
  seenNames.add(name);
  commands.push({ ...command, name });
}

/**
 * Browser-native builtins with no shared SDK handler; advertised with their
 * canonical registry metadata. `/goal` is a mode command omp implements as a
 * TUI-only handler, so it never reaches ACP discovery; omp-web drives the same
 * GoalRuntime itself (lib/goal-mode.ts) and advertises it here.
 */
export const BROWSER_NATIVE_SLASH_COMMANDS = ["fork", "goal"] as const;

/**
 * Registry metadata that does not describe the browser handler. omp 18.10 gave
 * /fork pane/window/tab subcommands that open the fork in a terminal
 * multiplexer; the browser fork ignores them, so it keeps its own description.
 */
const BROWSER_NATIVE_DESCRIPTIONS: Partial<Record<(typeof BROWSER_NATIVE_SLASH_COMMANDS)[number], string>> = {
  fork: "Create a new fork from a previous message",
};

/**
 * Keep the browser palette aligned with omp's own command registry and
 * discovery pipeline. Shared text/ACP builtins and every discovered
 * extension/custom/MCP/file/skill command come from the SDK discovery;
 * browser-native /fork is added explicitly from the canonical builtin registry
 * because it has no shared SDK handler yet. /handoff gained one in omp 18, so
 * it now arrives through discovery like every other shared builtin.
 */
export async function getAvailableSlashCommands(session: AgentSessionLike): Promise<SlashCommandInfo[]> {
  const commands: SlashCommandInfo[] = [];
  const seenNames = new Set<string>();

  const discovered = await buildAvailableSlashCommands(session as unknown as AvailableCommandsSession);
  for (const command of discovered) {
    appendSlashCommand(commands, seenNames, command);
  }

  for (const name of BROWSER_NATIVE_SLASH_COMMANDS) {
    const builtin = BUILTIN_SLASH_COMMAND_DEFS.find((def) => def.name === name);
    if (!builtin) continue;
    const browserDescription = BROWSER_NATIVE_DESCRIPTIONS[name];
    const hint = builtin.inlineHint;
    // A browser-specific description means the registry's subcommands don't apply.
    const subcommands = browserDescription ? undefined : builtin.subcommands;
    appendSlashCommand(commands, seenNames, {
      name: builtin.name,
      aliases: builtin.aliases,
      description: browserDescription ?? builtin.description,
      source: "builtin",
      ...(hint ? { input: { hint } } : {}),
      ...(subcommands ? { subcommands } : {}),
    });
  }

  // Prompt templates are a separate SDK resource from custom commands and
  // file-based commands, so retain them explicitly in the browser contract.
  for (const template of session.promptTemplates) {
    appendSlashCommand(commands, seenNames, {
      name: template.name,
      description: template.description,
      source: "prompt",
      ...(template.source ? { path: template.source } : {}),
    });
  }

  return commands;
}

// ============================================================================
// AgentSessionWrapper
// Wraps AgentSession with the same interface the rest of the app expects
// ============================================================================

type WrapperEventBus = { on: (...args: never[]) => unknown };

type AgentSessionWrapperOptions = {
  /** Observability bus for the fork SDK's subagent registry (see the constructor). */
  eventBus?: WrapperEventBus;
  /** Reports the exact per-run system prompt in place of the transcript-replayed one. */
  exactSystemPrompt?: () => string;
  /** Chat-only sessions declare no tools and no completion announcements. */
  chatOnly?: boolean;
  /** Notified once an accepted agent run reaches idle. */
  onAgentRunComplete?: (sessionId: string, sessionName: string | undefined) => void;
  /** Session never announces completion (its work is not operator-facing). */
  suppressCompletionNotifications?: boolean;
};

export class AgentSessionWrapper {
  readonly runtimeId = `runtime:${randomUUID()}`;
  private listeners: EventListener[] = [];
  private pendingUiResponses = new Map<string, PendingUiResponse>();
  private pendingUiRequests = new Map<string, AgentEvent>();
  private activeCustomUis = new Map<string, ActiveCustomUi>();
  private extensionStatuses = new Map<string, string>();
  private extensionWidgets = new Map<string, ExtensionWidgetItem>();
  private activeExtensionWidgets = new Map<string, ActiveExtensionWidget>();
  private extensionWidgetGenerations = new Map<string, number>();
  private extensionWidgetsResetting = false;
  private promptRunning = false;
  // Prompts admitted but not yet settled; a accepted prompt counts even after
  // its run reports, so Stop/teardown still treat the session as busy.
  private pendingPromptCount = 0;
  // The tail of the prompt-admission queue: each prompt waits for the
  // preceding one's preflight to pass or fail before entering the SDK.
  private promptAdmissionTail: Promise<void> = Promise.resolve();
  // An accepted run awaits its agent_settled before completion is announced.
  private agentRunNeedsCompletion = false;
  // The last settled run was stopped, not finished: nothing to announce.
  private lastRunAborted = false;
  // Set while the handoff RPC is in flight so state polls and the running-set
  // stay honest during the long oneshot generation + session transition.
  private handoffRunning = false;
  // The latest start/update of each running tool call, replayed to new
  // listeners; cleared when the run ends.
  private activeToolEvents = new Map<string, AgentEvent>();
  // Stop could not unwind the run: the idle timer must still reap it.
  private forceShutdownOnIdle = false;
  // The armed idle timer is the forced cleanup Stop scheduled.
  private forcedIdleTimerArmed = false;
  // Aborted by Stop; every extension UI request made through the current
  // controller unwinds with it, and a fresh controller starts the next prompt.
  private extensionUiAbortController = new AbortController();
  private readonly exactSystemPrompt?: () => string;
  private readonly chatOnly: boolean = false;
  private readonly onAgentRunComplete?: (sessionId: string, sessionName: string | undefined) => void;
  private readonly suppressCompletionNotifications: boolean = false;
  private extensionsBound = false;
  private extensionBindingPromise: Promise<void> | null = null;
  private extensionBindingError: unknown = null;
  private forceEmptySystemPrompt = false;
  private unsubscribe: (() => void) | null = null;
  private idleTimer: Timeout | undefined;
  private onDestroyCallback: (() => void) | null = null;
  private shutdownPromise: Promise<void> | null = null;
  // True once session_shutdown has been given to the extensions, so destroy()
  // never hands them a second copy after shutdown() already did.
  private sessionShutdownEmitted = false;
  private resolveDisposed: () => void = () => {};
  private readonly disposed = new Promise<void>((resolve) => { this.resolveDisposed = resolve; });
  // Set when shutdown() starts. The SDK session stays usable until destroy(),
  // but lookups must treat the wrapper as gone from this point on.
  private closing = false;
  private readonly subagents: RpcSubagentRegistry;
  // The SDK registry removes terminal entries after emitting their lifecycle frame.
  // Keep a bounded per-session copy so state requests can still expose history.
  private readonly subagentHistory = new Map<string, SubagentSnapshot>();
  private goalModeController: GoalModeController | null = null;
  private _alive = true;

  constructor(
    public readonly inner: AgentSessionLike,
    // The second argument is either the observability bus (the fork SDK's
    // RpcSubagentRegistry subscribes to it at construction time and, unlike
    // upstream, does not tolerate an absent bus; production always gets the
    // session's real bus from createAgentSession()) or an options object that
    // carries that bus under `eventBus` plus the wrapper's behavioral options.
    // Callers/tests that hand over neither get an isolated bus (no producers
    // -> inert).
    options: AgentSessionWrapperOptions | WrapperEventBus = {},
  ) {
    const isBus = typeof (options as WrapperEventBus).on === "function";
    const asOptions = isBus ? {} as AgentSessionWrapperOptions : (options as AgentSessionWrapperOptions);
    const eventBus: WrapperEventBus = (isBus ? (options as WrapperEventBus) : asOptions.eventBus) ?? new EventBus();
    this.exactSystemPrompt = asOptions.exactSystemPrompt;
    this.chatOnly = asOptions.chatOnly ?? false;
    this.onAgentRunComplete = asOptions.onAgentRunComplete;
    this.suppressCompletionNotifications = asOptions.suppressCompletionNotifications ?? false;
    this.subagents = new RpcSubagentRegistry(eventBus as EventBus, (frame) => {
      const event = frame as unknown as AgentEvent;
      this.rememberSubagentFrame(event);
      this.emit(event);
      this.resetIdleTimer();
      notifyRunningChange();
    });
    this.subagents.setSubscriptionLevel("progress");
  }

  private rememberSubagentSnapshot(snapshot: SubagentSnapshot): void {
    this.subagentHistory.set(snapshot.id, snapshot);
    if (this.subagentHistory.size <= MAX_SUBAGENT_HISTORY) return;
    const removable = [...this.subagentHistory.values()]
      .filter((entry) => entry.status !== "pending" && entry.status !== "running")
      .sort((left, right) => left.lastUpdate - right.lastUpdate);
    while (this.subagentHistory.size > MAX_SUBAGENT_HISTORY && removable.length > 0) {
      const oldest = removable.shift();
      if (oldest) this.subagentHistory.delete(oldest.id);
    }
  }

  private rememberSubagentFrame(event: AgentEvent): void {
    if (event.type === "subagent_progress") {
      const payload = event.payload as { progress?: { id?: string } } | undefined;
      const id = payload?.progress?.id;
      if (!id) return;
      const live = this.subagents.getSubagents().find((entry) => entry.id === id);
      if (live) this.rememberSubagentSnapshot(live as unknown as SubagentSnapshot);
      return;
    }
    if (event.type !== "subagent_lifecycle") return;
    const payload = event.payload as {
      id?: string;
      index?: number;
      agent?: string;
      agentSource?: "bundled" | "user" | "project";
      description?: string;
      status?: "started" | "completed" | "failed" | "aborted";
      sessionFile?: string;
      parentToolCallId?: string;
    } | undefined;
    if (!payload?.id || !payload.status) return;
    const live = this.subagents.getSubagents().find((entry) => entry.id === payload.id);
    if (payload.status === "started") {
      if (live) this.rememberSubagentSnapshot(live as unknown as SubagentSnapshot);
      return;
    }
    const previous = (live as unknown as SubagentSnapshot | undefined) ?? this.subagentHistory.get(payload.id);
    const terminalStatus: SubagentSnapshot["status"] = payload.status === "failed"
      ? "failed"
      : payload.status === "aborted"
        ? "aborted"
        : "completed";
    this.rememberSubagentSnapshot({
      id: payload.id,
      index: payload.index ?? previous?.index ?? 0,
      agent: payload.agent ?? previous?.agent ?? payload.id,
      agentSource: payload.agentSource ?? previous?.agentSource ?? "bundled",
      description: payload.description ?? previous?.description,
      status: terminalStatus,
      task: previous?.task,
      assignment: previous?.assignment,
      sessionFile: payload.sessionFile ?? previous?.sessionFile,
      lastUpdate: Date.now(),
      parentToolCallId: payload.parentToolCallId ?? previous?.parentToolCallId,
      progress: previous?.progress
        ? { ...previous.progress, status: terminalStatus }
        : undefined,
    });
  }

  private getSubagentSnapshots(): SubagentSnapshot[] {
    for (const live of this.subagents.getSubagents()) {
      const snapshot = live as unknown as SubagentSnapshot;
      this.rememberSubagentSnapshot(snapshot);
    }
    const snapshots = new Map(this.subagentHistory);
    for (const live of this.subagents.getSubagents()) {
      const snapshot = live as unknown as SubagentSnapshot;
      snapshots.set(snapshot.id, snapshot);
    }
    return [...snapshots.values()].sort((left, right) => {
      const leftActive = left.status === "pending" || left.status === "running";
      const rightActive = right.status === "pending" || right.status === "running";
      if (leftActive !== rightActive) return leftActive ? -1 : 1;
      if (leftActive) return left.index - right.index || left.id.localeCompare(right.id);
      return right.lastUpdate - left.lastUpdate || left.id.localeCompare(right.id);
    });
  }

  get sessionId(): string {
    return this.inner.sessionId;
  }

  get sessionFile(): string {
    return this.inner.sessionFile ?? "";
  }

  get cwd(): string {
    return this.inner.sessionManager.getCwd();
  }

  /**
   * False from the moment shutdown() or destroy() begins, not only once the SDK
   * session is disposed: extensions may take up to the shutdown deadline to
   * handle session_shutdown, and a prompt routed here meanwhile would be lost.
   */
  isAlive(): boolean {
    return this._alive && !this.closing;
  }

  /**
   * Drop this idle wrapper when the on-disk JSONL has an entry the in-memory
   * index never saw (another pi process appended). Rechecks isRunning() so a
   * prompt that started during the probe cannot be disposed.
   */
  evictIfDiskAhead(): boolean {
    if (!this.isAlive() || this.isRunning()) return false;
    const diskLatestId = readLatestSessionEntryId(this.sessionFile);
    if (!diskLatestId || this.inner.sessionManager.getEntry(diskLatestId)) return false;
    if (this.isRunning()) return false;
    this.destroy();
    invalidateSessionListCache();
    return true;
  }

  isRunning(): boolean {
    return this._alive && (
      this.promptRunning
      || this.pendingPromptCount > 0
      || this.handoffRunning
      || this.inner.isStreaming
      || this.inner.isCompacting
      || this.inner.isBashRunning
      || this.subagents.getSubagents().length > 0
    );
  }
  bindToolUiContext(setter: (uiContext: ExtensionUiContextLike, hasUI: boolean) => void): void {
    setter(this.createExtensionUiContext(), true);
  }


  start(): void {
    this.syncPlanModeFromSession();
    void this.goalMode.restore().catch((error) => {
      console.error(
        "[omp-web] failed to restore goal mode:",
        error instanceof Error ? error.message : error,
      );
    });
    this.unsubscribe = this.inner.subscribe((sessionEvent) => {
      // SDK event members are closed interfaces; the browser stream treats them
      // as open records (omp 18.10's cache_warming_* events made that explicit).
      const event = sessionEvent as unknown as AgentEvent;
      if (event.type === "agent_start") {
        this.agentRunNeedsCompletion = true;
        this.lastRunAborted = false;
      }
      if (event.type === "agent_settled") this.lastRunAborted = event.aborted === true;
      if (event.type === "agent_end") {
        invalidateSessionListCache();
        // Every tool call of the run has finished; nothing is left to replay.
        this.activeToolEvents.clear();
      }
      this.trackActiveToolEvent(event);
      if (IDLE_RESET_EVENT_TYPES.has(event.type)) this.resetIdleTimer();
      this.emit(event);
      if (event.type === "agent_settled") this.notifyAgentRunCompleteIfIdle();
      if (RUNNING_STATE_EVENT_TYPES.has(event.type)) notifyRunningChange();
      void this.goalMode.handleSessionEvent(event).catch((error) => {
        console.error(
          "[omp-web] goal mode failed to handle a session event:",
          error instanceof Error ? error.message : error,
        );
      });
    });
    this.resetIdleTimer();
    notifyRunningChange();
  }

  setForceEmptySystemPrompt(force: boolean): void {
    this.forceEmptySystemPrompt = force;
    this.applyForcedEmptySystemPrompt();
  }

  beginExtensionBinding(options: ExtensionBindingOptions = {}): void {
    void this.ensureExtensionsBound(options).catch((err) => {
      console.error("[omp-web] failed to dispatch session_start to extensions:", err instanceof Error ? err.message : err);
    });
  }

  async waitUntilReady(): Promise<void> {
    await this.waitForExtensionsBound();
  }

  private ensureExtensionsBound(options: ExtensionBindingOptions = {}): Promise<void> {
    if (options.forceEmptySystemPrompt) this.forceEmptySystemPrompt = true;
    if (this.extensionsBound) {
      this.applyForcedEmptySystemPrompt();
      return Promise.resolve();
    }
    if (this.extensionBindingPromise) return this.extensionBindingPromise;

    this.extensionBindingError = null;
    this.extensionBindingPromise = (async () => {
      if (!this._alive) return;
      const uiContext = this.createExtensionUiContext();
      const bindExtensions = this.inner.bindExtensions as ((bindings: {
        uiContext?: ExtensionUiContextLike;
        mode?: "rpc";
        commandContextActions?: ExtensionCommandContextActionsLike;
        shutdownHandler?: () => void;
        onError?: (error: { extensionPath: string; event: string; error: string }) => void;
      }) => Promise<void>) | undefined;
      const shutdownHandler = () => this.emit({
        type: "extension_ui_request",
        id: randomUUID(),
        method: "notify",
        notifyType: "warning",
        message: "Extension requested shutdown, but shutdown is not supported in omp-web.",
      } as ExtensionUiRequest as AgentEvent);
      if (typeof bindExtensions === "function") {
        // SDKs that let the host bind extensions at session_start: hand them the
        // browser-backed context and command actions as part of the binding.
        await bindExtensions.call(this.inner, {
          uiContext,
          mode: "rpc",
          commandContextActions: this.createExtensionCommandContextActions(),
          shutdownHandler,
          onError: (error) => this.emit({
            type: "extension_error",
            extensionPath: error.extensionPath,
            event: error.event,
            error: error.error,
          }),
        });
      } else if (typeof this.inner.extensionRunner?.initialize === "function") {
        // omp wires extensions the same way for every non-interactive host; reuse
        // its shared initializer so omp-web sessions expose exactly the action set
        // `omp --mode rpc` does, then layer our browser-backed UI context on top.
        await initializeExtensions(this.inner as never, {
          uiContext: uiContext as never,
          reportSendError: (action, error) => this.emit({
            type: "extension_error",
            extensionPath: action,
            event: "send",
            error: error.message,
          }),
          reportRuntimeError: (error) => this.emit({
            type: "extension_error",
            extensionPath: error.extensionPath,
            event: error.event,
            error: error.error,
          }),
          onShutdown: shutdownHandler,
        });
      } else {
        // Runners already initialized by the SDK: only the UI context is ours to set.
        this.inner.extensionRunner?.setUIContext?.(uiContext, "rpc");
      }
      this.extensionsBound = true;
      this.applyForcedEmptySystemPrompt();
      console.log(`[omp-web] session_start dispatched to extensions for session ${this.inner.sessionId}`);
    })().catch((err) => {
      this.extensionBindingError = err;
      throw err;
    });

    return this.extensionBindingPromise;
  }

  private async waitForExtensionsBound(): Promise<void> {
    try {
      if (this.extensionBindingPromise) await this.extensionBindingPromise;
    } catch (err) {
      throw err instanceof Error ? err : new Error(String(err));
    }
    if (this.extensionBindingError) {
      throw this.extensionBindingError instanceof Error
        ? this.extensionBindingError
        : new Error(String(this.extensionBindingError));
    }
  }

  private shouldWaitForExtensions(type: string): boolean {
    return type === "prompt"
      || type === "steer"
      || type === "follow_up"
      || type === "handoff"
      || type === "get_commands"
      || type === "get_state"
      || type === "execute_slash_command"
      || type === "goal";
  }

  private async withFinalRunningNotification<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } finally {
      this.resetIdleTimer();
      notifyRunningChange();
    }
  }

  private async shutdownAfterCommittedFork(newSessionId: string): Promise<void> {
    try {
      await this.shutdown();
    } catch (error) {
      // The forked session is already persisted. Cleanup failures must not
      // hide its id from the browser and strand the committed transition.
      console.error(
        `[omp-web] fork created session ${newSessionId}, but wrapper shutdown failed:`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  private applyForcedEmptySystemPrompt(): void {
    if (this.forceEmptySystemPrompt && this.inner.agent.state) {
      this.inner.agent.state.systemPrompt = [];
    }
  }
  /**
   * Goal mode lives server-side so an active goal keeps working through the
   * continuation loop whether or not a browser tab is watching.
   */
  private get goalMode(): GoalModeController {
    if (!this.goalModeController) {
      this.goalModeController = new GoalModeController(this.inner, {
        isBusy: () => this.promptRunning
          || this.handoffRunning
          || this.inner.isStreaming
          || this.inner.isCompacting
          || this.inner.isBashRunning,
        runContinuation: (prompt) => this.runGoalContinuation(prompt),
        onStatusChange: (status) => this.emit({ type: "goal_status", status }),
      });
    }
    return this.goalModeController;
  }

  /**
   * Send one goal continuation turn. It is a hidden custom message rather than
   * a prompt so it does not appear as something the operator typed, but the
   * browser must still see the session go busy, exactly as for a real prompt.
   */
  private async runGoalContinuation(prompt: string): Promise<void> {
    this.promptRunning = true;
    notifyRunningChange();
    try {
      await this.inner.promptCustomMessage({
        customType: "goal-continuation",
        content: prompt,
        display: false,
        attribution: "user",
      });
    } catch (error) {
      this.emit({
        type: "prompt_error",
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      this.promptRunning = false;
      this.resetIdleTimer();
      this.emit({ type: "prompt_done" });
      notifyRunningChange();
    }
  }

  private syncPlanModeFromSession(): void {
    let state = this.inner.getPlanModeState?.();
    if (!state) {
      // Test doubles and non-omp hosts may not surface entries at all; the
      // persisted mode is then simply unknown, as before the first sync.
      const sessionManager = this.inner.sessionManager as HostSessionManagerLike | undefined;
      const entries = sessionManager?.getEntries?.() ?? [];
      let persistedMode: (typeof entries)[number] | undefined;
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        if (entries[index]?.type !== "mode_change") continue;
        persistedMode = entries[index];
        break;
      }
      const planFilePath = persistedMode?.data?.planFilePath;
      if (persistedMode?.mode === "plan" && typeof planFilePath === "string" && planFilePath.length > 0) {
        state = {
          enabled: true,
          planFilePath,
          workflow: persistedMode.data?.workflow === "sequential" ? "sequential" : "parallel",
          reentry: true,
        };
        this.inner.setPlanModeState?.(state);
      }
    }

    if (state?.enabled) {
      this.inner.setPlanProposalHandler?.((title) => this.handlePlanProposal(title));
    }
  }

  private async handlePlanProposal(title: string): Promise<{
    content: Array<{ type: "text"; text: string }>;
    details?: unknown;
  }> {
    const state = this.inner.getPlanModeState?.();
    if (!state?.enabled || !this.inner.preparePlanForReview) {
      throw new Error("Plan mode is not active.");
    }

    const review = await this.inner.preparePlanForReview(title);
    const planFilePath = review.details?.planFilePath;
    const resolvedTitle = review.details?.title;
    if (!planFilePath || !resolvedTitle) {
      throw new Error("The proposed plan could not be resolved.");
    }

    const planContent = await readPlanFile(planFilePath, {
      cwd: this.cwd,
      localProtocolOptions: {
        getArtifactsDir: () => this.inner.sessionManager.getArtifactsDir(),
        getSessionId: () => this.inner.sessionManager.getSessionId(),
      },
    });
    if (!planContent?.trim()) {
      throw new Error(`Plan file not found at ${planFilePath}`);
    }

    const responseValue = await this.requestExtensionUi(
      { method: "plan_review", title: resolvedTitle, planFilePath, planContent },
      JSON.stringify({ action: "refine" }),
      (response) => "value" in response ? response.value : JSON.stringify({ action: "refine" }),
    );
    let choice: { action?: unknown; feedback?: unknown } = {};
    try {
      choice = JSON.parse(responseValue) as { action?: unknown; feedback?: unknown };
    } catch {
      // Treat malformed or stale browser responses as a request to keep planning.
    }

    const details = { planFilePath, title: resolvedTitle, planExists: true };
    if (choice.action === "approve") {
      this.inner.setPlanReferencePath?.(planFilePath);
      this.inner.setPlanProposalHandler?.(null);
      this.inner.setPlanModeState?.(undefined);
      this.inner.sessionManager.appendModeChange("none");
      return {
        content: [{
          type: "text",
          text: `Plan approved at ${planFilePath}. Plan mode exited; proceed with the implementation.`,
        }],
        details,
      };
    }

    if (state.planFilePath !== planFilePath) {
      this.inner.setPlanModeState?.({ ...state, planFilePath });
      this.inner.sessionManager.appendModeChange("plan", { planFilePath });
    }
    const feedback = typeof choice.feedback === "string" ? choice.feedback.trim() : "";
    return {
      content: [{
        type: "text",
        text: [
          "Plan refinement requested.",
          feedback ? `User feedback:\n${feedback}` : "",
          `Update the plan file, then write ${resolvedTitle} to xd://propose again when ready.`,
        ].filter(Boolean).join("\n\n"),
      }],
      details,
    };
  }


  syncSessionIdentity(): void {
    const registry = globalThis.__ompSessions;
    const currentId = this.sessionId;
    if (!registry || registry.get(currentId) === this) return;
    let moved = false;
    for (const [id, session] of registry) {
      if (session !== this) continue;
      registry.delete(id);
      moved = true;
    }
    if (!moved) return;
    registry.set(currentId, this);
    if (this.sessionFile) cacheSessionPath(currentId, this.sessionFile);
    invalidateSessionListCache();
    // Existing streams still hold this wrapper after its registry key moves.
    for (const listener of this.listeners) listener({ type: "session_changed", sessionId: currentId, runtimeId: this.runtimeId });
  }

  private emit(event: AgentEvent): void {
    this.syncSessionIdentity();
    // Snapshot: destroy() emits session_shutdown while SSE handlers unsubscribe
    // from this very loop, and splicing the live array would skip the next one.
    for (const l of [...this.listeners]) {
      try {
        l(event);
      } catch (error) {
        console.error(
          `[omp-web] failed to deliver ${event.type} event:`,
          error instanceof Error ? error.message : error,
        );
      }
    }
  }

  /**
   * Keep the latest start or update of each running tool call for onEvent() to
   * replay. Calls a tool makes itself (a codemode script's, which carry
   * `parentToolCallId`) are left out: a reconnecting client would show each as
   * a top-level tool, and the parent's own update already reports them. A
   * nested end can still arrive after its parent's, and is ignored like the rest.
   */
  private trackActiveToolEvent(event: AgentEvent): void {
    const toolCallId = event.toolCallId;
    if (typeof toolCallId !== "string" || isNestedToolExecutionEvent(event)) return;
    if (event.type === "tool_execution_start" || event.type === "tool_execution_update") {
      this.activeToolEvents.set(toolCallId, event);
    } else if (event.type === "tool_execution_end") {
      this.activeToolEvents.delete(toolCallId);
      const nestedPrefix = `${toolCallId}/`;
      for (const id of this.activeToolEvents.keys()) {
        if (id.startsWith(nestedPrefix)) this.activeToolEvents.delete(id);
      }
    }
  }

  private notifyAgentRunCompleteIfIdle(): void {
    if (!this.agentRunNeedsCompletion || this.isRunning()) return;
    this.agentRunNeedsCompletion = false;
    // A stopped run did not finish a task, as pi's own status reporting has it: nothing to announce.
    if (this.suppressCompletionNotifications || this.lastRunAborted) return;
    try {
      this.onAgentRunComplete?.(this.sessionId, this.inner.sessionManager.getSessionName?.());
    } catch (error) {
      console.error("[omp-web] completion listener failed:", error instanceof Error ? error.message : error);
    }
  }

  /** `prompt_done`, saying `aborted` when the prompt's run was stopped rather than finished. */
  private promptDoneEvent(): AgentEvent {
    return { type: "prompt_done", ...(this.lastRunAborted ? { aborted: true } : {}) };
  }

  private async acquirePromptAdmission(): Promise<() => void> {
    const previous = this.promptAdmissionTail;
    const tail = Promise.withResolvers<void>();
    this.promptAdmissionTail = tail.promise;
    await previous;
    return tail.resolve;
  }

  private resetIdleTimer(): void {
    if (!this._alive) {
      clearTimeout(this.idleTimer);
      return;
    }
    if (!this.isRunning()) this.forceShutdownOnIdle = false;
    // A stuck user reloads, reopens the session or presses Stop again, and
    // each of those commands lands here. Moving the forced deadline for them
    // would keep a run that Stop cannot unwind alive indefinitely.
    if (this.forceShutdownOnIdle && this.forcedIdleTimerArmed) return;
    clearTimeout(this.idleTimer);
    // A resolved timeout of 0 disables idle shutdown, but a run that Stop could
    // not unwind is still reaped after the default delay; otherwise it stays
    // running until the server restarts (#656).
    const timeoutMs = SESSION_IDLE_TIMEOUT_MS
      || (this.forceShutdownOnIdle ? DEFAULT_SESSION_IDLE_TIMEOUT_MS : 0);
    this.forcedIdleTimerArmed = timeoutMs !== 0 && this.forceShutdownOnIdle;
    if (timeoutMs === 0) return;
    this.idleTimer = setTimeout(() => {
      if (!this.forceShutdownOnIdle && (this.isRunning() || hasActiveSessionLivenessProvider({
        sessionId: this.sessionId,
        sessionFile: this.sessionFile || undefined,
      }))) {
        this.resetIdleTimer();
        return;
      }
      void this.shutdown().catch((error) => {
        console.error("[pi-web] failed to shut down idle session:", error instanceof Error ? error.message : error);
      });
    }, timeoutMs);
  }

  private persistBashOnlySession(): void {
    const manager = this.inner.sessionManager;
    const sessionFile = manager.getSessionFile();
    if (!sessionFile || existsSync(sessionFile)) return;

    const header = manager.getHeader();
    if (!header) return;

    const content = [header, ...manager.getEntries()]
      .map((entry) => JSON.stringify(entry))
      .join("\n") + "\n";
    writeFileSync(sessionFile, content, { encoding: "utf8", flag: "wx" });

    // omp normally delays the first flush until an assistant message exists.
    // A leading shell command has no assistant message, so mark this SDK
    // manager as flushed after writing its own generated entries.
    (manager as unknown as { flushed: boolean }).flushed = true;
    cacheSessionPath(this.inner.sessionId, sessionFile);
  }

  onEvent(listener: EventListener): () => void {
    this.listeners.push(listener);
    for (const event of this.pendingUiRequests.values()) listener(event);
    for (const event of this.activeToolEvents.values()) listener(event);
    return () => {
      const i = this.listeners.indexOf(listener);
      if (i !== -1) this.listeners.splice(i, 1);
    };
  }

  onDestroy(cb: () => void): void {
    this.onDestroyCallback = cb;
  }

  /**
   * Resolves `true` once the SDK session is disposed, or `false` after `timeoutMs`:
   * shutdown() waits for extension binding without a deadline.
   */
  waitUntilDisposed(timeoutMs: number): Promise<boolean> {
    let timer: Timeout | undefined;
    const timedOut = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
      timer.unref?.();
    });
    return Promise.race([this.disposed.then(() => true), timedOut]).finally(() => clearTimeout(timer));
  }

  /** Chat only declares no tools: the empty selection or the chat-only option. */
  isChatOnly(): boolean {
    return this.chatOnly || this.forceEmptySystemPrompt;
  }

  /** Apply a coding tool selection in place, keeping the fork's goal-mode and prompt rules. */
  async setActiveToolSelection(toolNames: string[]): Promise<void> {
    this.setForceEmptySystemPrompt(toolNames.length === 0);
    await this.inner.setActiveToolsByName(
      this.goalMode.reconcileToolNames(withExtensionTools(this.inner, toolNames)),
    );
    this.applyForcedEmptySystemPrompt();
  }

  async send(command: Record<string, unknown>): Promise<unknown> {
    const type = command.type as string;
    // Status reconciliation must not postpone forced cleanup after Stop.
    if (type !== "get_state") this.resetIdleTimer();
    if (this.shouldWaitForExtensions(type)) await this.waitForExtensionsBound();
    if (this.handoffRunning && HANDOFF_ALLOWED_COMMAND_TYPES[type] !== true) {
      throw new Error("Cannot modify the session while a handoff is in progress");
    }
    if (type === "prompt" || type === "steer" || type === "follow_up") {
      this.syncPlanModeFromSession();
    }

    if (type === "prompt" || type === "steer" || type === "follow_up") {
      const imageError = validateAgentImages(command.images);
      if (imageError) throw new Error(imageError);
    }

    // A session whose folder was deleted outside pi-web stays readable, but a
    // run there would reach the model only for its tools to fail (and `write`
    // to recreate the folder). The omp CLI does not resume such a session
    // either; refuse as /api/agent/new does. (A `!` command already refuses.)
    if (type === "prompt" && !existsSync(this.cwd)) {
      throw new Error(`Directory does not exist: ${this.cwd}`);
    }

    switch (type) {
      case "prompt": {
        // Serialize only admission. Once the preceding prompt has either
        // passed or failed preflight, the SDK can atomically decide whether
        // this submission starts a run or joins its streaming queue.
        const releaseAdmission = await this.acquirePromptAdmission();
        try {
          if (this.inner.isBashRunning) {
            throw new Error("Cannot send a prompt while a shell command is running");
          }
          if (this.extensionUiAbortController.signal.aborted) {
            this.extensionUiAbortController = new AbortController();
          }
          // A turn the operator asked for means the next continuation is wanted,
          // and supersedes one already scheduled.
          this.goalMode.onUserPrompt();
          const promptImages = command.images as Array<{ type: "image"; data: string; mimeType: string }> | undefined;
          const streamingBehavior = command.streamingBehavior as "steer" | "followUp" | undefined;
          let preflightAccepted = false;
          let preflightSettled = false;
          let promptSettled = false;
          const preflight = Promise.withResolvers<void>();
          // A prompt rejected after the response has returned must not surface as an unhandled rejection.
          preflight.promise.catch(() => {});
          const acceptPreflight = () => {
            preflightAccepted = true;
            this.agentRunNeedsCompletion = true;
            if (preflightSettled) return;
            preflightSettled = true;
            // A new prompt, not one queued into a run: what an earlier run's Stop said is over.
            if (!streamingBehavior) this.lastRunAborted = false;
            preflight.resolve();
          };
          const rejectPreflight = (error: unknown) => {
            if (preflightSettled) return;
            preflightSettled = true;
            preflight.reject(error);
          };
          const finishPrompt = () => {
            if (promptSettled) return;
            promptSettled = true;
            this.pendingPromptCount = Math.max(0, this.pendingPromptCount - 1);
            this.resetIdleTimer();
            this.notifyAgentRunCompleteIfIdle();
            notifyRunningChange();
          };

          this.pendingPromptCount += 1;
          notifyRunningChange();
          const message = command.message as string;
          let prompt: Promise<unknown>;
          try {
            prompt = this.inner.prompt(message, {
              ...(promptImages?.length ? { images: promptImages } : {}),
              ...(streamingBehavior ? { streamingBehavior } : {}),
              userInitiated: true,
              source: "rpc",
              // Match pi's RPC contract: acknowledge only after synchronous prompt
              // validation and extension preflight have accepted the submission.
              // Every disposition (handled, queued, started) is an acceptance; a
              // rejected prompt never calls these and rejects `prompt` instead.
              // The omp SDK names the same acceptance point `onPromptAdmitted`.
              preflightResult: () => acceptPreflight(),
              onPromptAdmitted: () => acceptPreflight(),
            });
          } catch (error) {
            finishPrompt();
            throw error;
          }

          void prompt.then(() => {
            // Compatibility fallback if a future SDK resolves without invoking
            // the internal callback. This waits for the run, but never acks early.
            acceptPreflight();
            finishPrompt();
            if (!streamingBehavior) this.emit(this.promptDoneEvent());
          }, async (error) => {
            if (!preflightAccepted) {
              // Some SDK builds dispatch extension commands inside prompt()
              // itself. When the SDK failed before ever admitting the
              // submission, run the command here so the browser sees the
              // command's UI, as pi's own dispatch would show it, instead of
              // an internal error.
              if (await this.tryExecuteExtensionCommand(message)) {
                acceptPreflight();
                finishPrompt();
                if (!streamingBehavior) this.emit(this.promptDoneEvent());
                return;
              }
            }
            rejectPreflight(error);
            finishPrompt();
            invalidateSessionListCache();
            // A preflight rejection is returned by the POST itself. Only an
            // unexpected failure after acceptance needs the asynchronous event.
            if (preflightAccepted) {
              this.emit({
                type: "prompt_error",
                errorMessage: error instanceof Error ? error.message : String(error),
              });
              if (!streamingBehavior) this.emit(this.promptDoneEvent());
            }
          }).catch((error) => {
            console.error(
              "[omp-web] prompt completion handler failed:",
              error instanceof Error ? error.message : error,
            );
          });

          await preflight.promise;
          return null;
        } finally {
          releaseAdmission();
        }
      }

      case "abort":
        this.forceShutdownOnIdle = true;
        // Arm the forced cleanup now: the reset above ran before this flag,
        // and the final reset only runs once the SDK run has unwound.
        this.resetIdleTimer();
        // Stop must unwind extension commands that have not started the agent yet.
        this.extensionUiAbortController.abort(new DOMException("Extension UI cancelled by Stop", "AbortError"));
        this.goalMode.onAbort();
        try {
          await this.withFinalRunningNotification(async () => {
            try {
              await this.inner.abort();
            } catch (error) {
              // The SDK's own unwind may fail while the wrapper-side Stop of
              // extension work already succeeded; report, but do not strand Stop.
              console.error("[omp-web] SDK abort failed:", error instanceof Error ? error.message : error);
            }
          });
          return null;
        } finally {
          if (!this.isRunning()) this.forceShutdownOnIdle = false;
        }

      case "get_state": {
        const model = this.inner.model;
        const contextUsage = this.inner.getContextUsage();
        // Doubles and non-omp hosts expose the queue under its pi names; the omp
        // accessor wins whenever the SDK provides it.
        const queueSource = this.inner as AgentSessionLike & {
          getQueuedMessages?: () => { steering: Iterable<string>; followUp: Iterable<string> };
          getSteeringMessages?: () => Iterable<string>;
          getFollowUpMessages?: () => Iterable<string>;
          pendingMessageCount?: number;
        };
        const queued = queueSource.getQueuedMessages?.() ?? {
          steering: queueSource.getSteeringMessages?.() ?? [],
          followUp: queueSource.getFollowUpMessages?.() ?? [],
        };
        // An exact prompt is projected onto each run by the inline extension. Every other
        // session reports `agent.state.systemPrompt`, which replays the transcript: that is
        // what the model actually saw, including sections a `before_agent_start` handler
        // changed for the run. It stays empty until the first run persists a system message,
        // so a session that has not sent anything yet falls back to the session getter, which
        // renders the prompt from the current options. The getter alone would drop those
        // per-run changes again once the run ends.
        const stateSystemPrompt = [this.inner.agent.state?.systemPrompt ?? ""].flat().join("\n");
        return {
          sessionId: this.inner.sessionId,
          runtimeId: this.runtimeId,
          sessionFile: this.inner.sessionFile ?? "",
          isStreaming: this.inner.isStreaming,
          isPromptRunning: this.pendingPromptCount > 0 || this.promptRunning,
          isBashRunning: this.inner.isBashRunning,
          isCompacting: this.inner.isCompacting,
          isHandoffRunning: this.handoffRunning,
          autoCompactionEnabled: this.inner.autoCompactionEnabled,
          autoRetryEnabled: this.inner.autoRetryEnabled,
          model: model ? { id: model.id, provider: model.provider } : undefined,
          messageCount: 0,
          pendingMessageCount: queueSource.queuedMessageCount ?? queueSource.pendingMessageCount ?? 0,
          queuedMessages: {
            steering: [...queued.steering],
            followUp: [...queued.followUp],
          },
          contextUsage: contextUsage
            ? { percent: contextUsage.percent, contextWindow: contextUsage.contextWindow, tokens: contextUsage.tokens }
            : null,
          systemPrompt: this.exactSystemPrompt?.() || stateSystemPrompt || this.inner.systemPrompt || "",
          thinkingLevel: this.inner.agent.state?.thinkingLevel ?? "off",
          configuredThinkingLevel: queueSource.configuredThinkingLevel?.() ?? "off",
          extensionStatuses: this.getExtensionStatuses(),
          extensionWidgets: this.getExtensionWidgets(),
          subagents: this.getSubagentSnapshots(),
          goal: this.goalMode.getStatus(),
        };
      }
      case "get_subagents":
        return { subagents: this.getSubagentSnapshots() };

      case "get_subagent_messages": {
        const selector = command as {
          subagentId?: string;
          sessionFile?: string;
          fromByte?: number;
        };
        const transcriptFile = this.subagents.resolveSessionFile(selector);
        return readRpcSubagentTranscript(transcriptFile, selector.fromByte);
      }


      case "set_model": {
        const { provider, modelId, role } = command as { provider: string; modelId: string; role?: string };
        // As pi's /model, which refreshes before listing: re-read the saved
        // definitions even for a known id, so reselecting a model applies a
        // saved edit of it (#1273). A failed offline refresh keeps the cache.
        await this.inner.modelRegistry.refresh("offline").catch(() => undefined);
        // modelRegistry.find() takes (provider, modelId) as two arguments — passing a
        // pre-joined "provider/modelId" selector leaves modelId undefined and throws
        // inside the SDK before we ever get a chance to report "model not found".
        const model = this.inner.modelRegistry.find(provider, modelId);
        if (!model) throw new Error(`Model not found: ${provider}/${modelId}`);
        // Reselecting an unchanged model writes nothing.
        if (isDeepStrictEqual(this.inner.model, model)) {
          return { id: model.id, provider: model.provider, ...(role ? { role } : {}) };
        }
        const sameId = this.inner.model?.provider === provider && this.inner.model?.id === model.id;
        // The agent state selector is a ConfiguredThinkingLevel at runtime; the
        // loosely typed agent state loses that, so cast once at read.
        const thinkingLevel = this.inner.agent?.state?.thinkingLevel as ConfiguredThinkingLevel | undefined;
        // omp records the role a model change came from, so the transcript and
        // the `/model` carousel agree on which role is currently driving.
        await this.inner.setModel(model, role);
        // A reselect to apply an edit is not a new model choice: keep the level,
        // clamped to off when the saved edit dropped thinking support (omp only
        // preserves an explicit off for models without a reasoning budget).
        // registry.find() hands back a ModelLike; the concrete Model carries the
        // reasoning flag, so narrow for it instead of asserting the shape.
        const reasoningCapable =
          typeof model === "object" && model !== null && "reasoning" in model && model.reasoning === true;
        const keptLevel: ConfiguredThinkingLevel | undefined = reasoningCapable ? thinkingLevel : "off";
        if (sameId && keptLevel) this.inner.setThinkingLevel(keptLevel);
        invalidateModelsCache();
        invalidateSessionListCache();
        return { id: model.id, provider: model.provider, ...(role ? { role } : {}) };
      }

      case "set_role_model": {
        const role = command.role as string;
        const model = this.inner.resolveRoleModel(role);
        if (!model) throw new Error(`No model configured for role "${role}"`);
        await this.inner.setModel(model, role);
        invalidateModelsCache();
        invalidateSessionListCache();
        return { id: model.id, provider: model.provider, role };
      }

      case "fork": {
        if (this.inner.isBashRunning) {
          throw new Error("Cannot fork while a shell command is running");
        }
        const sessionManager = this.inner.sessionManager;
        const entryId = resolveForkEntryId(
          sessionManager.getBranch() as ForkBranchEntry[],
          command.entryId,
        );
        if (!entryId) throw new Error("No user message to fork from yet");
        const currentSessionFile = this.inner.sessionFile;

        if (!currentSessionFile) return { cancelled: true };

        const entry = sessionManager.getEntry(entryId);
        if (!entry) throw new Error("Invalid entry ID for forking");

        const sessionDir = sessionManager.getSessionDir();
        let newSessionFile: string;

        if (!entry.parentId) {
          // Fork before the first message: create an empty session linked to this one
          const newManager = SessionManager.create(sessionManager.getCwd(), sessionDir);
          await newManager.newSession({ parentSession: currentSessionFile });
          await newManager.ensureOnDisk();
          newSessionFile = newManager.getSessionFile() as string;
        } else {
          // Fork after some history: copy path up to (but not including) the fork point
          const sourceManager = await SessionManager.open(currentSessionFile, sessionDir);
          const forkedPath = sourceManager.createBranchedSession(entry.parentId);
          if (!forkedPath) throw new Error("Failed to create forked session");
          newSessionFile = forkedPath;
        }

        const newSessionId = (await SessionManager.open(newSessionFile, sessionDir)).getSessionId();
        cacheSessionPath(newSessionId, newSessionFile);
        invalidateSessionListCache();
        await this.shutdownAfterCommittedFork(newSessionId);
        return { cancelled: false, newSessionId };
      }

      case "handoff": {
        // omp 18 made handoff in-place: it summarizes the conversation into a
        // handoff document and commits that as this session's compaction entry
        // instead of minting a replacement session. It still rewrites history
        // behind a oneshot model call, so it must not run while a prompt is
        // streaming or any other work owns the session.
        if (this.handoffRunning || this.promptRunning || this.inner.isStreaming || this.inner.isCompacting || this.inner.isBashRunning) {
          throw new Error("Cannot hand off while the session is busy");
        }
        const customInstructions = command.customInstructions as string | undefined;
        this.handoffRunning = true;
        notifyRunningChange();
        try {
          // No result means the handoff was cancelled; the session is untouched.
          const result = await this.inner.handoff(customInstructions);
          if (!result) return { cancelled: true };
          // The session id and file are unchanged, so only the cached listing
          // (modified time, token counts) has gone stale.
          invalidateSessionListCache();
          return { cancelled: false };
        } finally {
          this.handoffRunning = false;
          notifyRunningChange();
        }
      }

      case "navigate_tree": {
        if (this.inner.isBashRunning) {
          throw new Error("Cannot navigate while a shell command is running");
        }
        const result = await this.inner.navigateTree(command.targetId as string, {});
        return { cancelled: result.cancelled };
      }

      case "set_thinking_level": {
        const level = command.level as string;
        this.inner.setThinkingLevel(level);
        // setThinkingLevel clamps xhigh→high for models where supportsXhigh()===false.
        // If the model has DeepSeek thinking compat (reasoningEffortMap maps xhigh→max),
        // force the state back so the compat layer can use it correctly.
        if (level === "xhigh" && (this.inner.model as { compat?: { thinkingFormat?: string } } | null)?.compat?.thinkingFormat === "deepseek" && this.inner.agent?.state) {
          this.inner.agent.state.thinkingLevel = "xhigh";
        }
        invalidateSessionListCache();
        return null;
      }

      case "compact": {
        try {
          return await this.withFinalRunningNotification(() =>
            this.inner.compact(command.customInstructions as string | undefined)
          );
        } finally {
          invalidateSessionListCache();
        }
      }

      case "set_session_name": {
        const name = (command.name as string | undefined)?.trim();
        if (!name) throw new Error("Session name cannot be empty");
        await this.inner.sessionManager.setSessionName(name, "user");
        invalidateSessionListCache();
        return null;
      }

      case "get_session_stats": {
        return {
          ...this.inner.getSessionStats(),
          sessionName: this.inner.sessionManager.getSessionName(),
        };
      }

      case "get_last_assistant_text": {
        return { text: this.inner.getLastAssistantText() ?? "" };
      }

      case "set_auto_compaction": {
        this.inner.setAutoCompactionEnabled(command.enabled as boolean);
        return null;
      }

      case "clear_queue": {
        // Full clear only: omp has no single-item dequeue, and clear+requeue
        // races against the agent loop pulling messages mid-flight.
        const cleared = this.inner.clearQueue();
        const toText = (message: unknown): string =>
          typeof message === "string" ? message : String((message as { text?: string })?.text ?? "");
        return {
          steering: cleared.steering.map(toText),
          followUp: cleared.followUp.map(toText),
        };
      }

      case "steer": {
        const steerImages = command.images as Array<{ type: "image"; data: string; mimeType: string }> | undefined;
        await this.inner.steer(command.message as string, steerImages?.length ? steerImages : undefined);
        return null;
      }

      case "follow_up": {
        const followImages = command.images as Array<{ type: "image"; data: string; mimeType: string }> | undefined;
        await this.inner.followUp(command.message as string, followImages?.length ? followImages : undefined);
        return null;
      }

      case "get_tools": {
        const active = new Set<string>(this.inner.getActiveToolNames());
        return listTools(this.inner).map((t) => ({
          name: t.name,
          description: t.description,
          active: active.has(t.name),
        }));
      }

      case "get_commands": {
        return { commands: await getAvailableSlashCommands(this.inner) };
      }

      case "goal": {
        return await this.goalMode.handleCommand((command.args as string | undefined) ?? "");
      }

      case "execute_slash_command": {
        const output: string[] = [];
        const result: AcpBuiltinSlashCommandResult = await executeAcpBuiltinSlashCommand(command.message as string, {
          session: this.inner as never,
          sessionManager: this.inner.sessionManager,
          settings: this.inner.settings,
          cwd: this.cwd,
          output: (text) => {
            output.push(text);
          },
          refreshCommands: () => {},
          reloadPlugins: async () => {
            await this.waitForExtensionsBound();
            this.extensionStatuses.clear();
            this.resetExtensionWidgetsForReload();
            await this.inner.reload();
            await this.inner.refreshSkills?.();
            this.applyForcedEmptySystemPrompt();
            invalidateModelsCache();
          },
        });
        if (result === false) return { handled: false, output };
        return {
          handled: true,
          output,
          ...("prompt" in result ? { prompt: result.prompt } : {}),
        };
      }


      case "set_tools": {
        const toolNames = command.toolNames as string[];
        this.setForceEmptySystemPrompt(toolNames.length === 0);
        await this.inner.setActiveToolsByName(
          this.goalMode.reconcileToolNames(withExtensionTools(this.inner, toolNames)),
        );
        this.applyForcedEmptySystemPrompt();
        return null;
      }

      case "reload": {
        // A reload invalidates the extension ctx the running turn still holds,
        // and the turn dies at its next extension hook (#1172). pi refuses too.
        if (this.isSessionRunningForReplacement()) {
          throw new Error("Wait for the current response to finish before reloading.");
        }
        if (this.extensionUiAbortController.signal.aborted) {
          this.extensionUiAbortController = new AbortController();
        }
        await this.waitForExtensionsBound();
        this.extensionStatuses.clear();
        // Reset widget state before reload so old widgets are disposed and stale
        // extension callbacks cannot mutate a widget that no longer exists.
        this.resetExtensionWidgetsForReload();
        this.syncProjectTrust();
        await this.inner.reload();
        await this.inner.refreshSkills?.();
        this.applyForcedEmptySystemPrompt();
        invalidateModelsCache();
        return { success: true };
      }

      case "abort_compaction": {
        this.inner.abortCompaction();
        return null;
      }

      case "extension_ui_response": {
        this.resolveExtensionUiResponse(command as ExtensionUiResponse);
        return null;
      }

      case "extension_ui_input": {
        this.handleExtensionUiInput(command.id as string, command.data as string);
        return null;
      }

      case "set_auto_retry": {
        this.inner.setAutoRetryEnabled(command.enabled as boolean);
        return null;
      }

      case "bash": {
        if (
          this.promptRunning
          || this.pendingPromptCount > 0
          || this.inner.isStreaming
          || this.inner.isCompacting
          || this.inner.isBashRunning
        ) {
          throw new Error("Cannot run a shell command while the session is busy");
        }
        // SDK builds and test doubles differ on the settings manager; each read is optional.
        const settingsManager = this.inner.settingsManager as HostSettingsLike | undefined;
        const execution = this.inner.executeBash(
          command.command as string,
          undefined,
          {
            excludeFromContext: command.excludeFromContext as boolean | undefined,
            // Project trust is a pi-web browser concern; the SDK runs commands
            // through a host-supplied sandbox, which omp-web implements as a
            // per-command PATH overlay in front of the agent-bin directory.
            operations: createProjectCommandBashOperations({
              shellPath: settingsManager?.getShellPath?.(),
            }),
          },
        );
        notifyRunningChange();
        try {
          const result = await execution;
          this.persistBashOnlySession();
          return result;
        } finally {
          this.resetIdleTimer();
          invalidateSessionListCache();
          notifyRunningChange();
        }
      }

      case "abort_bash": {
        // Stop must force cleanup even when the SDK's bash state cannot unwind.
        this.forceShutdownOnIdle = true;
        this.resetIdleTimer();
        this.inner.abortBash();
        return null;
      }

      default:
        throw new Error(`Unsupported command: ${type}`);
    }
  }

  destroy(): void {
    if (!this._alive) return;
    this._alive = false;
    // Tell attached SSE listeners to drop this instance so the browser
    // EventSource errors and reconnects instead of staying OPEN on a dead wrapper.
    this.emit({ type: "session_shutdown" });
    const finalIds = globalThis.__ompFinalSessionIds ??= new Map<string, string>();
    finalIds.set(this.runtimeId, this.sessionId);
    // A bounded continuation record, never a historical-session alias.
    while (finalIds.size > 1024) finalIds.delete(finalIds.keys().next().value!);
    clearTimeout(this.idleTimer);
    if (this.inner.isBashRunning) this.inner.abortBash();
    this.unsubscribe?.();
    this.goalModeController?.dispose();
    this.subagents.dispose();
    this.subagentHistory.clear();
    for (const pending of this.pendingUiResponses.values()) pending.cancel();
    for (const id of Array.from(this.activeCustomUis.keys())) this.closeCustomUi(id, undefined);
    this.pendingUiResponses.clear();
    this.pendingUiRequests.clear();
    this.activeToolEvents.clear();
    this.clearExtensionWidgets(false);

    const finishDispose = () => {
      try {
        void this.inner.dispose?.();
      } finally {
        try {
          // Runtime fallback can move this wrapper away from its startup ID.
          // Remove only this instance, preserving separately reopened sessions.
          for (const [id, session] of globalThis.__ompSessions ?? []) {
            if (session === this) globalThis.__ompSessions?.delete(id);
          }
          this.onDestroyCallback?.();
        } finally {
          notifyRunningChange();
          this.resolveDisposed();
        }
      }
    };

    // Always emit session_shutdown before dispose, even when callers skip
    // shutdown() (process exit, direct destroy). Await when possible so
    // extension MCP children can reap before the runner is invalidated.
    if (this.sessionShutdownEmitted) {
      finishDispose();
      return;
    }

    this.sessionShutdownEmitted = true;
    const emit = this.inner.extensionRunner?.emit;
    if (typeof emit !== "function") {
      finishDispose();
      return;
    }

    void this.emitSessionShutdown(emit)
      .catch((error) => {
        console.error(
          "[pi-web] session_shutdown before dispose failed:",
          error instanceof Error ? error.message : error,
        );
      })
      .finally(finishDispose);
  }

  async shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    if (!this._alive) return;
    // Closing starts before the first await, so a request that arrives while
    // extensions shut down starts a fresh wrapper instead of prompting this one.
    this.closing = true;

    this.shutdownPromise = (async () => {
      try {
        try {
          await this.waitForExtensionsBound();
        } catch (error) {
          console.error(
            "[pi-web] extension binding failed before session shutdown:",
            error instanceof Error ? error.message : error,
          );
        }
        if (!this.sessionShutdownEmitted) {
          this.sessionShutdownEmitted = true;
          const emit = this.inner.extensionRunner?.emit;
          if (typeof emit === "function") await this.emitSessionShutdown(emit);
        }
      } finally {
        this.destroy();
      }
    })();
    return this.shutdownPromise;
  }

  /**
   * Gives extensions at most SESSION_SHUTDOWN_DEADLINE_MS to handle
   * session_shutdown, then returns so the SDK session is disposed and
   * unregistered anyway. Closing an MCP connection has no upper bound: it waits
   * for a token refresh in flight and for a stdio child whose daemonized
   * grandchild may never close stdout.
   */
  private async emitSessionShutdown(
    emit: (event: { type: "session_shutdown"; reason: "quit" }) => Promise<unknown>,
  ): Promise<void> {
    let timer: Timeout | undefined;
    const deadline = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), SESSION_SHUTDOWN_DEADLINE_MS);
      // A quitting process must not wait for an extension's cleanup.
      timer.unref?.();
    });
    // A synchronous throw becomes a rejection, and a rejection that arrives
    // after the deadline is still handled by the race below.
    const handled = (async () => {
      await emit.call(this.inner.extensionRunner, { type: "session_shutdown", reason: "quit" });
      return "handled" as const;
    })();
    try {
      if (await Promise.race([handled, deadline]) === "timeout") {
        console.warn(
          `[pi-web] extensions did not finish session_shutdown for session ${this.sessionId} within ${SESSION_SHUTDOWN_DEADLINE_MS} ms; disposing it anyway`,
        );
      }
    } finally {
      clearTimeout(timer);
    }
  }

  private resolveExtensionUiResponse(response: ExtensionUiResponse): void {
    const pending = this.pendingUiResponses.get(response.id);
    if (!pending) return;
    pending.resolve(response);
  }

  private getExtensionStatuses(): Array<{ key: string; text: string }> {
    return Array.from(this.extensionStatuses, ([key, text]) => ({ key, text }));
  }

  private getExtensionWidgets(): ExtensionWidgetItem[] {
    return Array.from(this.extensionWidgets.values());
  }

  private isSessionRunningForReplacement(): boolean {
    return this.inner.isBashRunning
      || this.inner.isStreaming
      || this.inner.isCompacting
      || this.pendingPromptCount > 0;
  }

  private syncProjectTrust(): void {
    const status = getProjectTrustStatus(this.cwd, getAgentDir());
    // SDK builds and test doubles differ on the settings manager; each read is optional.
    const settingsManager = this.inner.settingsManager as HostSettingsLike | undefined;
    settingsManager?.setProjectTrusted?.(status.trusted);
  }

  /**
   * Dispatches an extension command the way the SDK's own prompt path does, for
   * builds where the wrapper must run it itself: the handler receives a command
   * context, and a failing handler is reported through the runner's error channel
   * exactly as pi reports a command that died inside a prompt. Resolves whether
   * a command was found and run.
   */
  private async tryExecuteExtensionCommand(message: string): Promise<boolean> {
    if (typeof message !== "string" || !message.startsWith("/")) return false;
    const name = message.slice(1).split(/\s+/)[0];
    if (!name) return false;
    // Some SDK builds keep the runner on a private field rather than the public accessor.
    const inner = this.inner as { _extensionRunner?: AgentSessionLike["extensionRunner"] };
    const runner = inner._extensionRunner ?? this.inner.extensionRunner;
    const command = runner?.getCommand?.(name);
    if (!command) return false;
    try {
      await command.handler(runner?.createCommandContext?.() ?? {});
    } catch (error) {
      runner?.emitError?.({
        extensionPath: "extension-command",
        event: "command",
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return true;
  }

  private createExtensionCommandContextActions(): ExtensionCommandContextActionsLike {
    return {
      waitForIdle: async () => {
        const agent = this.inner.agent as { waitForIdle?: () => Promise<void> };
        await agent.waitForIdle?.();
      },
      newSession: async () => ({ cancelled: true }),
      fork: async () => ({ cancelled: true }),
      navigateTree: (targetId, options) => this.send({
        type: "navigate_tree",
        targetId,
        ...(options?.summarize !== undefined ? { summarize: options.summarize } : {}),
      }) as Promise<{ cancelled: boolean }>,
      switchSession: async () => ({ cancelled: true }),
      reload: async () => {
        // As pi's TUI: a command runs inside its own prompt, so the pending
        // prompt does not count; only a streaming or compacting turn does.
        const busy = this.inner.isStreaming
          ? "Wait for the current response to finish before reloading."
          : this.inner.isCompacting
            ? "Wait for compaction to finish before reloading."
            : null;
        if (busy) {
          this.emit({
            type: "extension_ui_request",
            id: randomUUID(),
            method: "notify",
            notifyType: "warning",
            message: busy,
          } as ExtensionUiRequest as AgentEvent);
          return;
        }
        this.extensionStatuses.clear();
        this.resetExtensionWidgetsForReload();
        this.syncProjectTrust();
        await this.inner.reload({
          beforeSessionStart: () => {
            this.inner.extensionRunner?.setUIContext?.(this.createExtensionUiContext(), "rpc");
          },
        });
        // As the `reload` command: the provider lists' runtime follows.
        invalidateModelsCache();
      },
    };
  }

  private nextExtensionWidgetGeneration(key: string): number {
    const generation = (this.extensionWidgetGenerations.get(key) ?? 0) + 1;
    this.extensionWidgetGenerations.set(key, generation);
    return generation;
  }

  private disposeExtensionWidgetComponent(component: unknown): void {
    if (!component || (typeof component !== "object" && typeof component !== "function")) return;
    const dispose = (component as { dispose?: unknown }).dispose;
    if (typeof dispose !== "function") return;
    try {
      dispose.call(component);
    } catch {
      // Ignore dispose errors from extension widgets.
    }
  }

  private emitExtensionWidgetClear(key: string): void {
    this.emit({
      type: "extension_ui_request",
      id: randomUUID(),
      method: "setWidget",
      widgetKey: key,
      widgetLines: undefined,
      widgetPlacement: undefined,
    } as ExtensionUiRequest as AgentEvent);
  }

  private clearExtensionWidget(key: string, emitClear = true): number {
    const generation = this.nextExtensionWidgetGeneration(key);

    const active = this.activeExtensionWidgets.get(key);
    this.activeExtensionWidgets.delete(key);
    this.extensionWidgets.delete(key);
    if (active) this.disposeExtensionWidgetComponent(active.component);
    if (this.extensionWidgetGenerations.get(key) !== generation) return generation;
    if (emitClear) this.emitExtensionWidgetClear(key);
    return generation;
  }

  private clearExtensionWidgets(emitClear: boolean): void {
    const keys = new Set([
      ...this.extensionWidgets.keys(),
      ...this.activeExtensionWidgets.keys(),
    ]);
    for (const key of keys) this.clearExtensionWidget(key, emitClear);
  }

  private resetExtensionWidgetsForReload(): void {
    this.extensionWidgetsResetting = true;
    try {
      const factoryKeys = [...this.activeExtensionWidgets.keys()];
      for (const key of factoryKeys) this.clearExtensionWidget(key);
      // Keep the existing array-widget reload behavior: snapshots are reset and
      // the next extension session_start repopulates them.
      this.extensionWidgets.clear();
    } finally {
      this.extensionWidgetsResetting = false;
    }
  }

  private emitExtensionWidgetError(key: string, error: unknown): void {
    this.emit({
      type: "extension_error",
      extensionPath: `extension-widget:${key}`,
      event: "setWidget",
      error: error instanceof Error ? error.message : String(error),
    });
  }

  private failExtensionWidget(
    key: string,
    generation: number,
    error: unknown,
    clearEmitted: boolean,
    component?: unknown,
  ): void {
    if (this.extensionWidgetGenerations.get(key) !== generation) {
      this.disposeExtensionWidgetComponent(component);
      return;
    }

    const active = this.activeExtensionWidgets.get(key);
    let shouldEmitClear = !clearEmitted;
    if (active?.generation === generation) {
      shouldEmitClear = active.rendered || !active.clearEmitted;
      this.activeExtensionWidgets.delete(key);
      this.disposeExtensionWidgetComponent(active.component);
    } else {
      this.disposeExtensionWidgetComponent(component);
    }
    if (this.extensionWidgetGenerations.get(key) !== generation) {
      this.emitExtensionWidgetError(key, error);
      return;
    }
    this.extensionWidgets.delete(key);
    if (shouldEmitClear) this.emitExtensionWidgetClear(key);
    this.emitExtensionWidgetError(key, error);
  }

  private renderExtensionWidget(active: ActiveExtensionWidget): void {
    if (
      this.activeExtensionWidgets.get(active.key) !== active
      || this.extensionWidgetGenerations.get(active.key) !== active.generation
    ) return;

    let lines: unknown;
    try {
      lines = active.component.render(DEFAULT_CUSTOM_UI_COLUMNS);
    } catch (error) {
      this.failExtensionWidget(active.key, active.generation, error, active.clearEmitted);
      return;
    }
    if (!Array.isArray(lines) || !lines.every((line) => typeof line === "string")) {
      this.failExtensionWidget(
        active.key,
        active.generation,
        new Error("Extension widget render must return string[]"),
        active.clearEmitted,
      );
      return;
    }
    if (
      this.activeExtensionWidgets.get(active.key) !== active
      || this.extensionWidgetGenerations.get(active.key) !== active.generation
    ) return;

    const widgetLines = lines as string[];
    this.extensionWidgets.set(active.key, {
      key: active.key,
      lines: widgetLines,
      placement: active.placement,
    });
    active.rendered = true;
    this.emit({
      type: "extension_ui_request",
      id: randomUUID(),
      method: "setWidget",
      widgetKey: active.key,
      widgetLines,
      widgetPlacement: active.placement,
    } as ExtensionUiRequest as AgentEvent);
  }

  private setExtensionWidgetFactory(
    key: string,
    factory: ExtensionWidgetFactory,
    options?: { placement?: "aboveEditor" | "belowEditor" },
  ): void {
    const hadPrevious = this.extensionWidgets.has(key) || this.activeExtensionWidgets.has(key);
    const generation = this.clearExtensionWidget(key, hadPrevious);
    if (this.extensionWidgetGenerations.get(key) !== generation) return;
    const tui = createHeadlessCustomUiTui(() => {
      const active = this.activeExtensionWidgets.get(key);
      if (active?.generation === generation) this.renderExtensionWidget(active);
    }, DEFAULT_CUSTOM_UI_COLUMNS);

    let component: unknown;
    try {
      component = factory(tui, PLAIN_TEXT_THEME);
    } catch (error) {
      this.failExtensionWidget(key, generation, error, hadPrevious);
      return;
    }
    if (this.extensionWidgetGenerations.get(key) !== generation) {
      this.disposeExtensionWidgetComponent(component);
      return;
    }
    if (
      !component
      || (typeof component !== "object" && typeof component !== "function")
      || typeof (component as { render?: unknown }).render !== "function"
    ) {
      this.failExtensionWidget(
        key,
        generation,
        new Error("Extension widget factory must return a component with render(width)"),
        hadPrevious,
        component,
      );
      return;
    }

    const active: ActiveExtensionWidget = {
      key,
      component: component as ExtensionWidgetComponent,
      placement: options?.placement ?? "aboveEditor",
      generation,
      clearEmitted: hadPrevious,
      rendered: false,
    };
    this.activeExtensionWidgets.set(key, active);
    this.renderExtensionWidget(active);
  }

  private getCustomUiWidth(options: unknown): number {
    if (!options || typeof options !== "object") return DEFAULT_CUSTOM_UI_COLUMNS;
    const overlayOptions = (options as { overlayOptions?: unknown }).overlayOptions;
    const resolved = typeof overlayOptions === "function" ? overlayOptions() : overlayOptions;
    if (!resolved || typeof resolved !== "object") return DEFAULT_CUSTOM_UI_COLUMNS;
    const width = (resolved as { width?: unknown }).width;
    return typeof width === "number" && Number.isFinite(width)
      ? Math.max(40, Math.min(140, Math.round(width)))
      : 92;
  }

  private emitCustomUiRender(id: string, custom: ActiveCustomUi): void {
    let lines: string[];
    try {
      lines = custom.component.render(custom.width);
    } catch (error) {
      lines = [`Extension custom UI render failed: ${error instanceof Error ? error.message : String(error)}`];
    }
    const event = {
      type: "extension_ui_request",
      id,
      method: "custom",
      lines,
    } as ExtensionUiRequest as AgentEvent;
    this.pendingUiRequests.set(id, event);
    this.emit(event);
  }

  private closeCustomUi(id: string, value: unknown): void {
    const custom = this.activeCustomUis.get(id);
    if (!custom || custom.settled) return;
    custom.settled = true;
    this.activeCustomUis.delete(id);
    this.pendingUiRequests.delete(id);
    try {
      custom.component.dispose?.();
    } catch {
      // Ignore dispose errors from extension UI components.
    }
    this.emit({
      type: "extension_ui_request",
      id,
      method: "custom",
      lines: [],
      closed: true,
    } as ExtensionUiRequest as AgentEvent);
    custom.resolve(value);
  }

  private handleExtensionUiInput(id: string, data: string): void {
    const custom = this.activeCustomUis.get(id);
    if (!custom || typeof data !== "string") return;
    try {
      custom.component.handleInput?.(data);
      if (this.activeCustomUis.has(id)) this.emitCustomUiRender(id, custom);
    } catch (error) {
      this.closeCustomUi(id, undefined);
      this.emit({
        type: "extension_error",
        extensionPath: `custom-ui:${id}`,
        event: "custom_ui_input",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private requestExtensionCustomUi<T>(
    factory: unknown,
    options?: unknown,
  ): Promise<T> {
    if (typeof factory !== "function") return Promise.resolve(undefined as T);

    const stopSignal = this.extensionUiAbortController.signal;
    if (stopSignal.aborted) return Promise.reject(stopSignal.reason);

    const id = randomUUID();
    const width = this.getCustomUiWidth(options);
    const { promise, resolve, reject } = Promise.withResolvers<T>();

    let completed = false;
    const tui = createHeadlessCustomUiTui(
      () => {
        const custom = this.activeCustomUis.get(id);
        if (custom) this.emitCustomUiRender(id, custom);
      },
      width,
    );
    const finish = (value: T) => {
      if (completed) return;
      completed = true;
      stopSignal.removeEventListener("abort", onStop);
      if (stopSignal.aborted) reject(stopSignal.reason);
      else resolve(value);
    };
    const done = (value: T) => {
      if (this.activeCustomUis.has(id)) {
        this.closeCustomUi(id, value);
      } else {
        finish(value);
      }
    };
    const onStop = () => done(undefined as T);
    stopSignal.addEventListener("abort", onStop, { once: true });

    void Promise.resolve()
      .then(() => completed ? undefined : factory(tui, PLAIN_TEXT_THEME, CUSTOM_UI_KEYBINDINGS, done))
      .then((component) => {
        if (completed) {
          try {
            (component as CustomUiComponent | undefined)?.dispose?.();
          } catch {
            // Ignore dispose errors from a component completed before mounting.
          }
          return;
        }
        if (!component || typeof component !== "object" || typeof (component as CustomUiComponent).render !== "function") {
          finish(undefined as T);
          return;
        }
        const custom: ActiveCustomUi = {
          component: component as CustomUiComponent,
          width,
          resolve: (value) => finish(value as T),
          settled: false,
        };
        this.activeCustomUis.set(id, custom);
        this.emitCustomUiRender(id, custom);
      })
      .catch((error) => {
        if (completed) return;
        this.emit({
          type: "extension_error",
          extensionPath: `custom-ui:${id}`,
          event: "custom_ui",
          error: error instanceof Error ? error.message : String(error),
        });
        finish(undefined as T);
      });
    return promise;
  }

  private requestExtensionUi<T>(
    request: ExtensionUiRequestBody,
    defaultValue: T,
    parseResponse: (response: ExtensionUiResponse) => T,
    timeout?: number,
    signal?: AbortSignal,
  ): Promise<T> {
    if (signal?.aborted) return Promise.resolve(defaultValue);
    const stopSignal = this.extensionUiAbortController.signal;
    if (stopSignal.aborted) return Promise.reject(stopSignal.reason);
    const abortSignal = signal ? AbortSignal.any([signal, stopSignal]) : stopSignal;

    const id = randomUUID();
    const fullRequest = {
      type: "extension_ui_request",
      id,
      ...request,
      ...(timeout ? { timeout, expiresAt: Date.now() + timeout } : {}),
    };

    const { promise, resolve, reject } = Promise.withResolvers<T>();
    let settled = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      if (timeoutId) clearTimeout(timeoutId);
      abortSignal.removeEventListener("abort", onAbort);
      this.pendingUiRequests.delete(id);
      this.pendingUiResponses.delete(id);
      this.emit({ type: "extension_ui_closed", id });
    };
    const settle = (value: T) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (stopSignal.aborted) reject(stopSignal.reason);
      else resolve(value);
    };
    const onAbort = () => settle(defaultValue);

    if (timeout) timeoutId = setTimeout(() => settle(defaultValue), timeout);
    abortSignal.addEventListener("abort", onAbort, { once: true });

    this.pendingUiRequests.set(id, fullRequest as AgentEvent);
    this.pendingUiResponses.set(id, {
      resolve: (response) => settle(parseResponse(response)),
      cancel: () => settle(defaultValue),
    });
    this.emit(fullRequest as AgentEvent);
    return promise;
  }

  private createExtensionUiContext(): ExtensionUiContextLike {
    return {
      timeoutStartsOnPresentation: false,
      askDialog: (questions, opts) => this.requestExtensionUi(
        { method: "ask", questions, ...(opts?.timeout ? { timeout: opts.timeout } : {}) },
        undefined,
        (response) => {
          if (!("value" in response)) return undefined;
          try {
            return JSON.parse(response.value) as ExtensionAskDialogResult;
          } catch {
            return undefined;
          }
        },
        opts?.timeout,
        opts?.signal,
      ),
      select: (title, options, opts) => this.requestExtensionUi(
        { method: "select", title, options, ...(opts?.timeout ? { timeout: opts.timeout } : {}) },
        undefined,
        (response) => "value" in response ? response.value : undefined,
        opts?.timeout,
        opts?.signal,
      ),
      confirm: (title, message, opts) => this.requestExtensionUi(
        { method: "confirm", title, message, ...(opts?.timeout ? { timeout: opts.timeout } : {}) },
        false,
        (response) => "confirmed" in response ? response.confirmed : false,
        opts?.timeout,
        opts?.signal,
      ),
      input: (title, placeholder, opts) => this.requestExtensionUi(
        { method: "input", title, ...(placeholder !== undefined ? { placeholder } : {}), ...(opts?.timeout ? { timeout: opts.timeout } : {}) },
        undefined,
        (response) => "value" in response ? response.value : undefined,
        opts?.timeout,
        opts?.signal,
      ),
      editor: (title, prefill, opts) => this.requestExtensionUi(
        { method: "editor", title, ...(prefill !== undefined ? { prefill } : {}), ...(opts?.timeout ? { timeout: opts.timeout } : {}) },
        undefined,
        (response) => "value" in response ? response.value : undefined,
        opts?.timeout,
        opts?.signal,
      ),
      notify: (message, type) => {
        this.emit({
          type: "extension_ui_request",
          id: randomUUID(),
          method: "notify",
          message,
          notifyType: type,
        } as ExtensionUiRequest as AgentEvent);
      },
      onTerminalInput: () => () => {},
      setStatus: (key, text) => {
        if (text === undefined) this.extensionStatuses.delete(key);
        else this.extensionStatuses.set(key, text);
        this.emit({
          type: "extension_ui_request",
          id: randomUUID(),
          method: "setStatus",
          statusKey: key,
          statusText: text,
        } as ExtensionUiRequest as AgentEvent);
      },
      setWorkingMessage: () => {},
      setWorkingVisible: () => {},
      setWorkingIndicator: () => {},
      setHiddenThinkingLabel: () => {},
      setWidget: (key, content, options) => {
        if (!this._alive || this.extensionWidgetsResetting) return;
        if (typeof content === "function") {
          this.setExtensionWidgetFactory(
            key,
            content as unknown as ExtensionWidgetFactory,
            options,
          );
          return;
        }
        if (content !== undefined && !Array.isArray(content)) return;
        if (content === undefined) {
          this.clearExtensionWidget(key);
          return;
        }
        const generation = this.activeExtensionWidgets.has(key)
          ? this.clearExtensionWidget(key)
          : this.nextExtensionWidgetGeneration(key);
        if (this.extensionWidgetGenerations.get(key) !== generation) return;
        this.extensionWidgets.set(key, {
          key,
          lines: content,
          placement: options?.placement ?? "aboveEditor",
        });
        this.emit({
          type: "extension_ui_request",
          id: randomUUID(),
          method: "setWidget",
          widgetKey: key,
          widgetLines: content,
          widgetPlacement: options?.placement,
        } as ExtensionUiRequest as AgentEvent);
      },
      setFooter: () => {},
      setHeader: () => {},
      setTitle: (title) => {
        this.emit({
          type: "extension_ui_request",
          id: randomUUID(),
          method: "setTitle",
          title,
        } as ExtensionUiRequest as AgentEvent);
      },
      custom: <T = unknown>(factory: unknown, options?: unknown) => this.requestExtensionCustomUi<T>(factory, options),
      pasteToEditor: (text) => {
        this.emit({
          type: "extension_ui_request",
          id: randomUUID(),
          method: "set_editor_text",
          text,
        } as ExtensionUiRequest as AgentEvent);
      },
      setEditorText: (text) => {
        this.emit({
          type: "extension_ui_request",
          id: randomUUID(),
          method: "set_editor_text",
          text,
        } as ExtensionUiRequest as AgentEvent);
      },
      getEditorText: () => "",
      addAutocompleteProvider: () => {},
      setEditorComponent: () => {},
      getEditorComponent: () => undefined,
      get theme() { return PLAIN_TEXT_THEME; },
      getAllThemes: () => [],
      getTheme: () => undefined,
      setTheme: () => ({ success: false, error: "Theme switching is not supported in omp-web extension UI yet" }),
      getToolsExpanded: () => false,
      setToolsExpanded: () => {},
    };
  }
}

// ============================================================================
// Session registry
// ============================================================================

declare global {
  var __ompSessions: Map<string, AgentSessionWrapper> | undefined;
  // Legacy pi-web integration names: alias handles for the same maps, kept
  // pointing at the live runtime-identity registry (never a second registry).
  var __piSessions: Map<string, AgentSessionWrapper> | undefined;
  var __piStartLocks: Map<string, Promise<{ session: AgentSessionWrapper; realSessionId: string }>> | undefined;
  var __ompFinalSessionIds: Map<string, string> | undefined;
  var __ompStartLocks: Map<string, Promise<{ session: AgentSessionWrapper; realSessionId: string }>> | undefined;
  var __ompStartingSessionCwds: Map<string, number> | undefined;
  var __ompRunningListeners: Set<(ids: string[]) => void> | undefined;
}

function getRegistry(): Map<string, AgentSessionWrapper> {
  if (!globalThis.__ompSessions) {
    // A previous module generation under the pi-web name may already own the map.
    globalThis.__ompSessions = globalThis.__piSessions ?? new Map();
    const cleanup = () => globalThis.__ompSessions?.forEach((s) => s.destroy());
    process.once("exit", cleanup);
    process.once("SIGINT", cleanup);
    process.once("SIGTERM", cleanup);
  }
  for (const session of globalThis.__ompSessions.values()) {
    if (Object.getPrototypeOf(session) === AgentSessionWrapper.prototype) continue;
    // HMR retains pre-identity wrappers, including their SDK run and listeners.
    // Upgrade only wrapper instances carrying the existing private state.
    if (!Array.isArray(Reflect.get(session, "listeners"))) continue;
    if (!session.runtimeId) Object.defineProperty(session, "runtimeId", { value: `runtime:${randomUUID()}` });
    // The old manager callback deleted the startup ID even after relocation.
    // Current destroy() removes entries by wrapper identity instead.
    Reflect.set(session, "onDestroyCallback", null);
    Object.setPrototypeOf(session, AgentSessionWrapper.prototype);
  }
  globalThis.__piSessions = globalThis.__ompSessions;
  return globalThis.__ompSessions;
}

function getLocks(): Map<string, Promise<{ session: AgentSessionWrapper; realSessionId: string }>> {
  if (!globalThis.__ompStartLocks) {
    globalThis.__ompStartLocks = globalThis.__piStartLocks ?? new Map();
  }
  globalThis.__piStartLocks = globalThis.__ompStartLocks;
  return globalThis.__ompStartLocks;
}

const CLOSING_SESSION_WAIT_MARGIN_MS = 1_000;
const closingSessionWaits = new WeakMap<AgentSessionWrapper, { done: boolean; promise: Promise<void> }>();

/**
 * The wait for a wrapper of `sessionId` that is shutting down, or null when there is none
 * left to wait for. Until it is disposed the closing wrapper still owns the session: an
 * extension's session_shutdown may append to the file, which a replacement opened earlier
 * would branch away from, and dispose() releases provider resources (a Codex websocket) by
 * session id, which the replacement shares. The wait is bounded so a shutdown stuck in
 * extension binding cannot keep the session from starting again. One wait per closing
 * wrapper: its bound runs from the first caller and later callers share it, so a
 * shutdown still binding extensions can be overtaken.
 */
function closingRpcSessionWait(sessionId: string): Promise<void> | null {
  const closing = getRegistry().get(sessionId);
  // A wrapper from before a hot reload may lack waitUntilDisposed.
  if (!closing || closing.isAlive() || typeof closing.waitUntilDisposed !== "function") return null;
  let wait = closingSessionWaits.get(closing);
  if (!wait) {
    const entry = { done: false, promise: Promise.resolve() };
    entry.promise = closing.waitUntilDisposed(SESSION_SHUTDOWN_DEADLINE_MS + CLOSING_SESSION_WAIT_MARGIN_MS)
      .then((disposed) => {
        if (!disposed) console.warn(`[pi-web] session ${sessionId} is still shutting down; starting it again anyway`);
      })
      .finally(() => { entry.done = true; });
    closingSessionWaits.set(closing, entry);
    wait = entry;
  }
  return wait.done ? null : wait.promise;
}

function normalizeRpcCwd(cwd: string): string {
  const resolvedCwd = resolve(cwd);
  try {
    return realpathSync(resolvedCwd);
  } catch {
    return resolvedCwd;
  }
}

function getStartingSessionCwds(): Map<string, number> {
  if (!globalThis.__ompStartingSessionCwds) globalThis.__ompStartingSessionCwds = new Map();
  return globalThis.__ompStartingSessionCwds;
}

function trackStartingSession(cwd: string): () => void {
  const startingCwds = getStartingSessionCwds();
  const key = normalizeRpcCwd(cwd);
  startingCwds.set(key, (startingCwds.get(key) ?? 0) + 1);
  return () => {
    const remaining = (startingCwds.get(key) ?? 1) - 1;
    if (remaining > 0) startingCwds.set(key, remaining);
    else startingCwds.delete(key);
  };
}

export function getFinalRpcSessionId(runtimeId: string): string | undefined {
  return globalThis.__ompFinalSessionIds?.get(runtimeId);
}

export function getRpcSession(sessionId: string): AgentSessionWrapper | undefined {
  const registry = getRegistry();
  // Canonical history IDs never redirect to another transcript. Only an
  // explicit runtime handle follows the wrapper when the SDK changes its ID.
  for (const candidate of [...registry.values()]) {
    if (candidate.isAlive()) candidate.syncSessionIdentity?.();
  }
  const registered = registry.get(sessionId);
  // The entry registered under the exact id answers even while closing: it still
  // owns the session file until disposed, and callers gate routed work on isAlive().
  if (registered && registered.sessionId === sessionId) return registered;
  return [...registry.values()].find(
    (candidate) => candidate.isAlive() && (candidate.sessionId === sessionId || candidate.runtimeId === sessionId),
  );
}

export interface SetRpcSessionToolsResult {
  session: AgentSessionWrapper;
  sessionId: string;
  recreated: boolean;
}

/**
 * Persist a normal session's tool selection and rebuild when resource policy changes.
 * An undefined requestedToolNames returns the session to pi's configured defaults:
 * the pin is retracted and the session is rebuilt, because the loadout that
 * settings.json defaultTools resolves to is only known once pi builds the session.
 */
export async function setRpcSessionTools(
  sessionId: string,
  sessionFile: string | undefined,
  requestedToolNames: unknown,
): Promise<SetRpcSessionToolsResult> {
  const toolNames = requestedToolNames === undefined
    ? undefined
    : validateSessionToolSelection(requestedToolNames);
  const existing = getRpcSession(sessionId);

  if (!existing?.isAlive()) {
    if (!sessionFile) throw new Error("Session not found");
    // A wrapper still closing, or a start already under way, owns the file: wait for it and
    // apply the selection to whatever it left, or a start that opened the file first would
    // come up without the selection while this call reported success.
    const pending = closingRpcSessionWait(sessionId) ?? getLocks().get(sessionId);
    if (pending) {
      await pending.catch(() => undefined);
      return setRpcSessionTools(sessionId, sessionFile, requestedToolNames);
    }
    const manager = await SessionManager.open(sessionFile, undefined);
    if (toolNames === undefined) appendClearedSessionToolSelection(manager);
    else appendSessionToolSelection(manager, toolNames);
    invalidateSessionListCache();
    const started = await startRpcSession(sessionId, sessionFile, undefined);
    return { session: started.session, sessionId: started.realSessionId, recreated: false };
  }

  if (existing.isRunning()) throw new Error("Cannot change tools while the session is running");

  const hasCurrentResourcePolicy = typeof existing.isChatOnly === "function"
    && typeof existing.setActiveToolSelection === "function";
  const crossesChatOnlyBoundary = toolNames === undefined
    || !hasCurrentResourcePolicy
    || existing.isChatOnly() !== (toolNames.length === 0);
  if (toolNames === undefined) appendClearedSessionToolSelection(existing.inner.sessionManager);
  else appendSessionToolSelection(existing.inner.sessionManager, toolNames);
  invalidateSessionListCache();

  if (toolNames !== undefined && !crossesChatOnlyBoundary) {
    await existing.setActiveToolSelection(toolNames);
    return { session: existing, sessionId, recreated: false };
  }

  const persistedFile = existing.sessionFile && existsSync(existing.sessionFile)
    ? existing.sessionFile
    : undefined;
  const sessionCwd = existing.cwd;
  const model = existing.inner.model;
  const currentThinkingLevel = existing.inner.agent.state?.thinkingLevel;
  await existing.shutdown();

  if (persistedFile) {
    const started = await startRpcSession(sessionId, persistedFile, undefined);
    return { session: started.session, sessionId: started.realSessionId, recreated: true };
  }

  const started = await startRpcSession(`__recreate__${randomUUID()}`, "", sessionCwd, {
    ...(toolNames !== undefined ? { toolNames } : {}),
    ...(model ? { initialModel: { provider: model.provider, modelId: model.id } } : {}),
    ...(currentThinkingLevel ? { thinkingLevel: currentThinkingLevel as ConfiguredThinkingLevel } : {}),
  });
  return { session: started.session, sessionId: started.realSessionId, recreated: true };
}

function runtimeMessageText(entry: SessionMessageEntry): string {
  if (entry.message.role === "bashExecution") return "";
  const content = entry.message.content;
  if (typeof content === "string") return content;
  return content
    .map((block) => block.type === "text" ? block.text : "")
    .filter(Boolean)
    .join(" ");
}

function runtimeMessageActivityMs(entry: SessionMessageEntry): number | undefined {
  if (entry.message.role !== "user" && entry.message.role !== "assistant") return undefined;
  if (typeof entry.message.timestamp === "number") return entry.message.timestamp;
  const timestamp = new Date(entry.timestamp).getTime();
  return Number.isNaN(timestamp) ? undefined : timestamp;
}

/**
 * Return live sessions that should be visible in the session list. Pi delays
 * the first JSONL flush until an assistant message exists, so an accepted new
 * prompt must temporarily be described from its in-memory SessionManager.
 */
export function getRpcSessionInfos(options: { includeTransient?: boolean } = {}): SessionInfo[] {
  const sessions: SessionInfo[] = [];
  for (const session of getRegistry().values()) {
    if (typeof session.isAlive !== "function" || !session.isAlive()) continue;
    // Registry entries seeded by tests or other helpers may lack wrapper internals.
    const manager = session.inner?.sessionManager;
    if (!manager) continue;
    const header = manager.getHeader();
    const entries = manager.getEntries() as unknown as Array<
      { type: string; timestamp: string } | SessionMessageEntry
    >;
    const messages = entries.filter((entry): entry is SessionMessageEntry => entry.type === "message");
    const firstUserMessage = messages.find((entry) => entry.message.role === "user");
    const sessionFile = manager.getSessionFile() ?? session.sessionFile;
    const persisted = Boolean(sessionFile && existsSync(sessionFile));
    const subagent = readSubagentRun(entries as unknown as SessionEntry[], header?.id ?? session.sessionId, sessionFile ?? "");

    // An ensure_session call creates an idle, empty runtime while the composer
    // loads commands. Do not leak it into history before a prompt is accepted.
    if (!persisted && !options.includeTransient && (!session.isRunning() || !firstUserMessage)) continue;

    const created = header?.timestamp
      ?? entries[0]?.timestamp
      ?? new Date().toISOString();
    const headerTimestamp = new Date(created).getTime();
    let lastActivityMs = Number.isNaN(headerTimestamp) ? Date.now() : headerTimestamp;
    for (const message of messages) {
      const activityMs = runtimeMessageActivityMs(message);
      if (activityMs !== undefined) lastActivityMs = Math.max(lastActivityMs, activityMs);
    }

    sessions.push({
      path: sessionFile ?? "",
      id: header?.id ?? session.sessionId,
      cwd: header?.cwd ?? session.cwd,
      name: manager.getSessionName(),
      created,
      modified: new Date(lastActivityMs).toISOString(),
      messageCount: messages.length,
      firstMessage: firstUserMessage ? runtimeMessageText(firstUserMessage) || "(no messages)" : "(no messages)",
      ...(subagent ? {
        parentSessionId: subagent.parentSessionId,
        relation: {
          kind: "subagent" as const,
          parentSessionId: subagent.parentSessionId,
          profile: subagent.profile,
          description: subagent.description,
          status: session.isRunning() ? "running" as const : subagent.status,
        },
      } : {}),
      transient: !persisted,
    });
  }
  return sessions;
}

export function hasBusyRpcSessionForCwd(cwd: string): boolean {
  const targetCwd = normalizeRpcCwd(cwd);
  if (getStartingSessionCwds().has(targetCwd)) return true;
  return Array.from(getRegistry().values()).some(
    (session) => normalizeRpcCwd(session.cwd) === targetCwd && session.isRunning(),
  );
}

export async function destroyRpcSessionsForCwd(cwd: string): Promise<number> {
  const targetCwd = normalizeRpcCwd(cwd);
  const sessions = Array.from(getRegistry().values()).filter(
    (session) => normalizeRpcCwd(session.cwd) === targetCwd,
  );
  await Promise.all(sessions.map((session) => session.shutdown()));
  return sessions.length;
}

// Include idle wrappers so a run that changes ID and finishes between polls
// is attributed to its final transcript rather than its historical ID.
export function getRpcSessionActivitySnapshot() {
  const runningSessionIds = new Set<string>();
  const sessionIdsByRuntimeId: Record<string, string> = Object.fromEntries(globalThis.__ompFinalSessionIds ?? []);
  for (const session of getRegistry().values()) {
    if (!session.isAlive()) continue;
    sessionIdsByRuntimeId[session.runtimeId] = session.sessionId;
    if (session.isRunning()) runningSessionIds.add(session.sessionId);
  }
  return { runningSessionIds: [...runningSessionIds], sessionIdsByRuntimeId };
}

export function getRunningRpcSessionIds(): string[] {
  const ids = new Set<string>();
  for (const [sessionId, session] of getRegistry()) {
    if (session.isRunning()) ids.add(session.sessionId || sessionId);
  }
  return [...ids];
}

/**
 * Aborts the live run behind `sessionId` (a subagent being deleted mid-run).
 * Throws when there is no running wrapper, which the caller treats as the
 * ordinary case: an idle or completed session needs no abort.
 */
export function abortSubagent(sessionId: string): void {
  const wrapper = getRegistry().get(sessionId);
  if (!wrapper || !wrapper.isAlive() || !wrapper.isRunning()) {
    throw new Error(`No running subagent for session ${sessionId}`);
  }
  void wrapper.send({ type: "abort" }).catch(() => { /* the run was winding down anyway */ });
}

// ----------------------------------------------------------------------------
// Running-status broadcaster
//
// Pushes the current set of running session ids to subscribers whenever any
// session's running state may have changed. This lets the sidebar receive live
// updates over SSE instead of polling. Listeners live on globalThis so they
// survive Next.js hot-reload.
// ----------------------------------------------------------------------------

function getRunningListeners(): Set<(ids: string[]) => void> {
  if (!globalThis.__ompRunningListeners) globalThis.__ompRunningListeners = new Set();
  return globalThis.__ompRunningListeners;
}

/** Subscribe to running-session-id changes. Returns an unsubscribe function. */
export function subscribeRunningSessions(listener: (ids: string[]) => void): () => void {
  const listeners = getRunningListeners();
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

let lastRunningSnapshot = "";

/**
 * Recompute the running-session-id set and, if it changed since the last
 * notification, broadcast it to subscribers.
 */
export function notifyRunningChange(): void {
  const listeners = getRunningListeners();
  if (listeners.size === 0) {
    // A future subscriber receives its own initial snapshot. Clear this one so
    // its first state transition cannot match stale state from an old listener.
    lastRunningSnapshot = "";
    return;
  }
  const ids = getRunningRpcSessionIds();
  const snapshot = JSON.stringify([...ids].sort());
  if (snapshot === lastRunningSnapshot) return;
  lastRunningSnapshot = snapshot;
  for (const listener of listeners) {
    try { listener(ids); } catch { /* ignore listener errors */ }
  }
}

/**
 * Get or create an AgentSession for the given session.
 * For new sessions (sessionFile === ""), omp generates its own id.
 * New sessions resolve enabledModels before construction so the initial model,
 * thinking pin, and SDK scopedModels share one settings snapshot.
 * Pass options.toolNames to pre-configure active tools (empty = all disabled).
 */
export async function startRpcSession(
  sessionId: string,
  sessionFile: string,
  cwd: string | undefined,
  options: RpcSessionStartOptions = {},
): Promise<{ session: AgentSessionWrapper; realSessionId: string }> {
  const { initialModel, thinkingLevel } = options;
  const requestedToolNames = options.toolNames === undefined
    ? undefined
    : validateSessionToolSelection(options.toolNames);
  const registry = getRegistry();
  const locks = getLocks();

  const existing = getRpcSession(sessionId);
  if (existing?.isAlive()) return { session: existing, realSessionId: existing.sessionId };

  const inflight = locks.get(sessionId);
  if (inflight) return inflight;

  // A wrapper still closing owns the session until it is disposed: a replacement
  // opened earlier would branch away from appends its session_shutdown still makes
  // and share the provider resources its dispose() releases. Concurrent starts
  // share this lock, then the one start that follows it.
  const closingWait = closingRpcSessionWait(sessionId);
  if (closingWait) {
    const waiting: Promise<{ session: AgentSessionWrapper; realSessionId: string }> = closingWait.then(() => {
      if (locks.get(sessionId) === waiting) locks.delete(sessionId);
      return startRpcSession(sessionId, sessionFile, cwd, options);
    });
    locks.set(sessionId, waiting);
    return waiting;
  }
  const starting = (async () => {
    // Some extensions access the SDK's global theme even outside the terminal UI.
    await initTheme(false);
    const agentDir = getAgentDir();
    const sessionManager = sessionFile
      ? await SessionManager.open(sessionFile, undefined)
      : (() => {
        if (!cwd) throw new Error("cwd is required for a new session");
        return SessionManager.create(cwd, undefined);
      })();
    const sessionCwd = sessionManager.getCwd();
    const sessionEntries = sessionManager.getEntries() as unknown as SessionEntry[];
    // The newest selection in the file wins over a request, so a replacement of a
    // closing wrapper comes up with the tool policy the session already carries.
    const persistedToolNames = readSessionToolSelection(sessionEntries);
    const selectedToolNames = persistedToolNames ?? requestedToolNames;
    if (persistedToolNames === undefined && requestedToolNames !== undefined) {
      appendSessionToolSelection(sessionManager, requestedToolNames);
    }
    const finishStartingSession = trackStartingSession(sessionCwd);

    try {
      const runtime = await getOmpRuntime();
      const settings = await getSettingsForCwd(sessionCwd);

      // Determine which tools to pass based on requested toolNames.
      let toolsOption: string[] | undefined;
      if (selectedToolNames !== undefined) {
        // toolNames === [] -> "all off" (an empty allow-list disables every tool).
        // Otherwise DO NOT pass a builtin-only allow-list: passing CODING_TOOL_NAMES
        // set allowedToolNames to coding builtins only, which filtered every
        // extension/package-provided tool (e.g. subagents, web access) out of the
        // tool registry — so they were unavailable in omp-web sessions even though the
        // `omp` CLI keeps them. Leaving the allow-list unset lets the SDK register all
        // tools (and activate extension tools); we narrow the ACTIVE set below.
        toolsOption = selectedToolNames.length === 0 ? [] : undefined;
      }

      // Gate untrusted project code so opening a repository in a browser tab does
      // not run its `.omp/extensions`, `.omp/tools`, or `.mcp.json` servers (see
      // lib/project-trust.ts). Discovery still runs — only project-local entries
      // are dropped, so user-level extensions keep working.
      const [extensionPaths, customToolPaths] = await Promise.all([
        discoverSessionExtensionPaths({}, sessionCwd, settings),
        discoverCustomToolPaths([], sessionCwd),
      ]);
      const untrusted = untrustedProjectSessionOptions(sessionCwd, agentDir, { extensionPaths, customToolPaths });

      // `SYSTEM.md` / `APPEND_SYSTEM.md`, resolved against this session's cwd the
      // way the CLI resolves them against its own (lib/session-system-prompt.ts).
      const systemPrompts = await resolveSessionSystemPrompts(sessionCwd);

      const { modelRegistry } = runtime;
      const scope = await resolveVisibleModels(modelRegistry, getSetting<string[]>(settings, "enabledModels"), settings);
      const defaultRole = readDefaultModelRole(settings);
      const hasExistingMessages = sessionManager.buildSessionContext().messages.length > 0;
      const initial = hasExistingMessages
        ? { scopedModels: [...scope.scopedModels], model: undefined, thinkingLevel: undefined }
        : selectInitialModelScope(scope, {
          ...(initialModel ? { requestedModel: initialModel } : {}),
          ...(defaultRole ? { defaultModel: defaultRole } : {}),
          ...(thinkingLevel ? { thinkingLevel } : {}),
        });
      const sessionOptions: CreateAgentSessionOptions = {
        cwd: sessionCwd,
        agentDir,
        settings,
        sessionManager,
        modelRegistry,
        hasUI: true,
        ...(initial.model ? { model: initial.model } : {}),
        ...(initial.thinkingLevel ? { thinkingLevel: initial.thinkingLevel } : {}),
        ...(initial.scopedModels.length > 0 ? { scopedModels: initial.scopedModels } : {}),
        ...(toolsOption !== undefined ? { toolNames: toolsOption, restrictToolNames: true } : {}),
        ...(untrusted ?? {}),
      };
      // omp's own applier, so a prompt file goes through the same templates the
      // CLI renders it with instead of overwriting the whole system prompt.
      applyResolvedSystemPromptInputs(sessionOptions, systemPrompts.systemPrompt, systemPrompts.appendPrompt);
      const { session: inner, eventBus, setToolUIContext } = await createAgentSession(sessionOptions);

      const persistedPreferences = await persistExplicitStartupPreferences(
        runtime.settings,
        {
          ...(initialModel ? { model: initialModel } : {}),
          ...(thinkingLevel ? { thinkingLevel } : {}),
        },
        {
          ...(inner.model
            ? { model: { provider: inner.model.provider, modelId: inner.model.id } }
            : {}),
          thinkingLevel: inner.thinkingLevel ?? "off",
          supportsThinking: Boolean(inner.model?.reasoning),
        },
      );
      if (persistedPreferences.modelDefaultChanged) invalidateModelsCache();

      const session = inner as unknown as AgentSessionLike;

      // If specific tool names were requested (non-empty), set the active tools to the
      // requested builtin coding tools PLUS all extension/package tools, so installed
      // extensions stay usable in omp-web just like in the `omp` CLI.
      if (selectedToolNames && selectedToolNames.length > 0) {
        await session.setActiveToolsByName(withExtensionTools(session, selectedToolNames));
      }

      const wrapper = new AgentSessionWrapper(session, eventBus);
      wrapper.bindToolUiContext(
        setToolUIContext as unknown as (uiContext: ExtensionUiContextLike, hasUI: boolean) => void,
      );
      // When all tools are disabled, clear the system prompt entirely.
      // omp's buildSystemPrompt always produces a non-empty prompt even with no
      // tools; keep this forced after extension discovery and reloads as well.
      if (selectedToolNames?.length === 0) {
        wrapper.setForceEmptySystemPrompt(true);
      }
      wrapper.start();

      const realSessionId = inner.sessionId as string;
      const realSessionFile = inner.sessionFile as string | undefined;
      if (realSessionFile) cacheSessionPath(realSessionId, realSessionFile);

      // A wrapper registered before a hot reload unregisters by id alone when it
      // finishes; disarm it so it cannot drop this replacement from the registry.
      const previousWrapper = registry.get(realSessionId);
      if (previousWrapper && previousWrapper !== wrapper && typeof previousWrapper.onDestroy === "function") {
        previousWrapper.onDestroy(() => {});
      }
      registry.set(realSessionId, wrapper);
      wrapper.beginExtensionBinding({ forceEmptySystemPrompt: selectedToolNames?.length === 0 });

      return { session: wrapper, realSessionId };
    } finally {
      finishStartingSession();
    }
  })().finally(() => {
    locks.delete(sessionId);
  });

  locks.set(sessionId, starting);
  return starting;
}
