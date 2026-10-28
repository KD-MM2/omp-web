"use client";

import { useState, useCallback, useRef, useEffect, useLayoutEffect, useMemo, useReducer } from "react";
import type {
  AgentMessage,
  BlockingExtensionUiRequest,
  CustomMessage,
  ExtensionStatusItem,
  ExtensionUiRequest,
  ExtensionWidgetItem,
  SessionInfo,
  SessionTreeNode,
  SubagentSnapshot,
  ToolResultMessage,
  UserMessage,
} from "@/lib/types";
import { isBlockingExtensionUiRequest } from "@/lib/browser-notifications";
import { normalizeToolCalls } from "@/lib/normalize";
import { stripAnsi } from "@/lib/ansi";
import { agentStatusUrl, canApplySessionIdentity, isPromptRejectedError, sendAgentCommand, type RuntimeSessionBinding } from "@/lib/agent-client";
import { rememberSessionContinuation, clearSessionContinuation } from "@/lib/workspace-memory";
import { getDraft, restoreDraftSubmission } from "@/lib/draft-store";
import { carryMessageKeys, messageRenderKeys } from "@/lib/message-keys";
import { shouldShowScrollToLatest } from "@/lib/chat-lazy-load";
import { isNestedToolExecutionEvent } from "@/lib/agent-event-wire";
import { getToolExecutionProgress } from "@/lib/tool-execution-progress";
import { CODEMODE_TOOL_NAME, getCodemodeProgress } from "@/lib/codemode-view";
import type {
  StreamAction as WireStreamAction,
  StreamingState as WireStreamingState,
  StreamingStore,
} from "@/lib/streaming-message";
import { getToolNamesForPreset, type ToolEntry, type ToolPreset } from "@/lib/tool-presets";
import type { ContextUsage, GoalStatusInfo, SessionStatsInfo, SlashCommandInfo } from "@/lib/omp-types";
import type { ModelRoleAssignment } from "@/lib/api-types";
import { bareMcpOpensSettings } from "@/lib/mcp-command";
import type { SettingsSection } from "@/lib/settings-navigation";

export interface SessionData {
  runtimeId?: string;
  sessionId: string;
  filePath: string;
  totalActiveMs: number;
  tree: SessionTreeNode[];
  leafId: string | null;
  contextUsage?: ContextUsage;
  context: {
    messages: AgentMessage[];
    entryIds: string[];
    thinkingLevel: string;
    configuredThinkingLevel?: string;
    model: { provider: string; modelId: string } | null;
    /** Cursor for paging upward: the oldest entry currently loaded. */
    oldestEntryId?: string | null;
    /** Whether the session has entries older than the loaded window. */
    hasMore?: boolean;
    /** Whole turns above the loaded window. */
    turnsBefore?: number;
  };
}

interface StreamingState {
  isStreaming: boolean;
  streamingMessage: Partial<AgentMessage> | null;
}

type StreamAction =
  | { type: "start" }
  | { type: "update"; message: Partial<AgentMessage> }
  | { type: "end" }
  | { type: "reset" };

function streamReducer(state: StreamingState, action: StreamAction): StreamingState {
  switch (action.type) {
    case "start":
      return { isStreaming: true, streamingMessage: null };
    case "update":
      return { isStreaming: true, streamingMessage: action.message };
    case "end":
    case "reset":
      return { isStreaming: false, streamingMessage: null };
    default:
      return state;
  }
}

/**
 * The streaming state outside React: a streamed chunk re-renders only the
 * components that subscribe to it (lib/streaming-message.ts), not the whole
 * chat. The wire-level actions stay omp's own streamReducer actions; the
 * store exposes the same interface lib components subscribe to.
 */
export interface SessionStreamingStore extends StreamingStore {
  dispatch(action: StreamAction | WireStreamAction): void;
}

function createSessionStreamingStore(): SessionStreamingStore {
  let state: StreamingState = { isStreaming: false, streamingMessage: null };
  const listeners = new Set<() => void>();
  return {
    // omp only ever streams assistant messages (handleAgentEvent drops user
    // ones before dispatch), so the stored partial is an assistant shape.
    getState: () => state as WireStreamingState,
    dispatch(action: StreamAction | WireStreamAction) {
      const mapped: StreamAction | null = action.type === "snapshot"
        ? { type: "update", message: action.message }
        : action.type === "resume"
          ? { type: "start" }
          : action.type === "delta"
            ? null // omp's wire delivers whole messages, not deltas.
            : action;
      if (!mapped) return;
      const next = streamReducer(state, mapped);
      if (next === state) return;
      state = next;
      for (const listener of listeners) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

interface AgentEvent {
  type: string;
  [key: string]: unknown;
}

interface CompactCommandResult {
  tokensBefore?: number;
  estimatedTokensAfter?: number;
}

interface LastAssistantTextResponse {
  text?: string;
}

type AgentStateResponse = {
  runtimeId?: string;
  sessionId?: string;
  model?: { provider: string; id: string };
  contextUsage?: { percent: number | null; contextWindow: number; tokens: number | null } | null;
  systemPrompt?: string;
  thinkingLevel?: string;
  configuredThinkingLevel?: string;
  isStreaming?: boolean;
  isPromptRunning?: boolean;
  isBashRunning?: boolean;
  isCompacting?: boolean;
  isHandoffRunning?: boolean;
  autoCompactionEnabled?: boolean;
  extensionStatuses?: ExtensionStatusItem[];
  extensionWidgets?: ExtensionWidgetItem[];
  queuedMessages?: { steering?: string[]; followUp?: string[] } | null;
  subagents?: SubagentSnapshot[];
  goal?: GoalStatusInfo | null;
};

interface GoalCommandResponse {
  message?: string;
  error?: string;
  prompt?: string;
  status?: GoalStatusInfo | null;
}

export interface QueuedMessages {
  steering: string[];
  followUp: string[];
}

function normalizeQueuedMessages(q?: { steering?: string[]; followUp?: string[] } | null): QueuedMessages {
  return { steering: q?.steering ?? [], followUp: q?.followUp ?? [] };
}
// State refreshes contain only live SDK entries; merge terminal frames into a bounded history.
const MAX_SUBAGENT_HISTORY = 128;

function mergeSubagentSnapshots(current: SubagentSnapshot[], incoming: SubagentSnapshot[]): SubagentSnapshot[] {
  const byId = new Map(current.map((subagent) => [subagent.id, subagent]));
  for (const subagent of incoming) byId.set(subagent.id, subagent);
  const snapshots = [...byId.values()];
  const active = snapshots
    .filter((subagent) => subagent.status === "pending" || subagent.status === "running")
    .sort((left, right) => left.index - right.index || left.id.localeCompare(right.id));
  const finished = snapshots
    .filter((subagent) => subagent.status !== "pending" && subagent.status !== "running")
    .sort((left, right) => right.lastUpdate - left.lastUpdate || left.id.localeCompare(right.id));
  return [...active, ...finished].slice(0, MAX_SUBAGENT_HISTORY);
}

type ExtensionUiDialogRequest = Extract<
  ExtensionUiRequest,
  { method: "select" | "confirm" | "input" | "editor" | "ask" | "plan_review" }
>;
type ExtensionUiCustomRequest = Extract<ExtensionUiRequest, { method: "custom" }>;
export type NoticeType = "info" | "success" | "warning" | "error";

export type NoticeItem = {
  id: string;
  message: string;
  type: NoticeType;
  exiting?: boolean;
};

type NoticeState = {
  visible: NoticeItem[];
  pending: NoticeItem[];
};

type NoticeAction =
  | { type: "add"; notice: NoticeItem }
  | { type: "mark_oldest_exiting" }
  | { type: "remove"; id: string };

export type AgentPhase =
  | { kind: "waiting_model" }
  | { kind: "running_command" }
  | { kind: "running_tools"; tools: { id: string; name: string; progress?: string }[] }
  | null;

export interface CompactResultInfo {
  reason: "manual" | "threshold" | "overflow" | "auto" | string;
  tokensBefore: number;
  estimatedTokensAfter: number;
}


export type BuiltinSlashCommandResult =
  | { handled: false }
  | { handled: true; message?: string; error?: string; prompt?: string; action?: "openSessionStats" | "openSettings" };

/** A run ended; `aborted` when it was stopped rather than finished (pi's `agent_settled.aborted`). */
export interface AgentEndInfo {
  aborted: boolean;
  /** omp: the session whose run settled, for callers that tag completion notices per session. */
  sessionId?: string;
}

/** What the composer of a fresh session carries across a project switch. */
export interface NewSessionChoices {
  model: { provider: string; modelId: string } | null;
  thinkingLevel: string | null;
}

export interface UseAgentSessionOptions {
  session: SessionInfo | null;
  newSessionCwd: string | null;
  /** Reserved hint from the sidebar's running poll; the event stream keeps authority. */
  sessionRunning?: boolean;
  /** The shell's draft key for the fresh composer (`new:<id>:<cwd>`). */
  newSessionDraftKey?: string | null;
  /** The fresh composer's choices carried over from the last new session. */
  initialNewSessionChoices?: NewSessionChoices | null;
  /** Reports the fresh composer's model/thinking so the shell can carry them. */
  onNewSessionChoicesChange?: (choices: NewSessionChoices) => void;
  onAgentEnd?: (end: AgentEndInfo) => void;
  /** A top-level tool call finished; the files it touched may have changed. */
  onToolEnd?: (toolName: string) => void;
  onAttentionNeeded?: (request: BlockingExtensionUiRequest) => void;
  onSessionCreated?: (session: SessionInfo, sourceDraftKey: string) => void;
  onSessionForked?: (newSessionId: string, runtimeId?: string | null) => void;
  modelsRefreshKey?: number;
  /** Deep-links Settings to a section; the bare `/mcp` shortcut uses "mcp". */
  onOpenSettings?: (section: SettingsSection | "mcp") => void;
  chatInputRef?: React.RefObject<ChatInputHandle | null>;
  onBranchDataChange?: (tree: SessionTreeNode[], activeLeafId: string | null, onLeafChange: (leafId: string | null) => void, locked: boolean) => void;
  onSystemPromptChange?: (prompt: string | null) => void;
  /** Reports the session's live tool list for the System panel. */
  onSystemToolsChange?: (tools: ToolEntry[] | null) => void;
  /** Registers an action that lazily starts the session and loads its prompt and tools. */
  onSystemInfoLoaderChange?: (loader: (() => Promise<void>) | null) => void;
  onSessionStatsPanelOpen?: () => void;
  setToolPreset?: (preset: ToolPreset) => void;
  /** Holds the initial chat scroll until an external anchor resolves. */
  deferInitialScroll?: boolean;
}

export type ThinkingLevelOption = "auto" | "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** The levels a model role can be starred with; `auto` is derived, never saved. */
export type ConcreteThinkingLevel = Exclude<ThinkingLevelOption, "auto">;

const THINKING_LEVEL_OPTIONS: readonly ThinkingLevelOption[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** A carried thinking level is a plain string on the wire; accept only the concrete options. */
function asCarriedThinkingLevel(value: string | null | undefined): ThinkingLevelOption | null {
  if (!value) return null;
  return (THINKING_LEVEL_OPTIONS as readonly string[]).includes(value) ? value as ThinkingLevelOption : null;
}

/** A setting is a plain string on the wire; accept only the concrete options. */
function asConcreteThinkingLevel(value: unknown): ConcreteThinkingLevel | null {
  return typeof value === "string" && (THINKING_LEVEL_OPTIONS as readonly string[]).includes(value)
    ? value as ConcreteThinkingLevel
    : null;
}

const PROGRAMMATIC_SCROLL_IGNORE_MS = 700;
const USER_SCROLL_INTENT_MS = 1200;
const AUTO_FOLLOW_BOTTOM_THRESHOLD_PX = 72;
const PROMPT_SETTLE_INITIAL_DELAY_MS = 800;
const PROMPT_SETTLE_POLL_MS = 600;
const PROMPT_SETTLE_MAX_MS = 20_000;
const EVENT_STREAM_IDLE_GRACE_MS = 30_000;
const AGENT_STATE_RECONCILE_MS = 15_000;
const CONTEXT_USAGE_REFRESH_MS = 1000;
const BASH_STATE_RECONCILE_MS = 1_000;
const EVENT_STREAM_CONNECT_TIMEOUT_MS = 5_000;
const MAX_NOTICES = 5;
const NOTICE_VISIBLE_MS = 5000;
const NOTICE_EXIT_ANIMATION_MS = 180;
const MODELS_RETRY_DELAYS_MS = [2_000, 5_000, 10_000];

// Session id -> user entry being edited. ChatWindow remounts per session, so a
// pending edit lives here as long as that session's in-memory draft does.
const pendingHistoryEdits = new Map<string, string>();

const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " ", "Space", "Spacebar"]);

type EventStreamConnectionStatus = "connected" | "timeout" | "closed";

type EventStreamConnectionResult = {
  status: EventStreamConnectionStatus;
  source: EventSource;
};

type EventStreamConnectionAttempt = {
  source: EventSource;
  promise: Promise<EventStreamConnectionResult>;
  pending: boolean;
  connected: boolean;
  cancel: () => void;
};

class EventStreamConnectionError extends Error {
  constructor(public readonly status: Exclude<EventStreamConnectionStatus, "connected">) {
    super(status === "timeout"
      ? "Timed out connecting to the agent event stream. Please try again."
      : "Failed to connect to the agent event stream. Please try again.");
    this.name = "EventStreamConnectionError";
  }
}

function createNoticeId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function markOldestNoticeExiting(notices: NoticeItem[]): NoticeItem[] {
  const index = notices.findIndex((notice) => !notice.exiting);
  if (index === -1) return notices;
  return notices.map((notice, i) => (
    i === index ? { ...notice, exiting: true } : notice
  ));
}

function fillPendingNotices(visible: NoticeItem[], pending: NoticeItem[]): NoticeState {
  let nextVisible = visible;
  let nextPending = pending;
  while (nextPending.length > 0 && nextVisible.length < MAX_NOTICES) {
    const [next, ...rest] = nextPending;
    nextVisible = [...nextVisible, next];
    nextPending = rest;
  }
  if (nextPending.length > 0 && !nextVisible.some((notice) => notice.exiting)) {
    nextVisible = markOldestNoticeExiting(nextVisible);
  }
  return { visible: nextVisible, pending: nextPending };
}

function noticeReducer(state: NoticeState, action: NoticeAction): NoticeState {
  switch (action.type) {
    case "add": {
      if (state.visible.some((notice) => notice.exiting) || state.visible.length >= MAX_NOTICES) {
        return {
          visible: state.visible.some((notice) => notice.exiting)
            ? state.visible
            : markOldestNoticeExiting(state.visible),
          pending: [...state.pending, action.notice],
        };
      }
      return { ...state, visible: [...state.visible, action.notice] };
    }
    case "mark_oldest_exiting":
      return { ...state, visible: markOldestNoticeExiting(state.visible) };
    case "remove": {
      const visible = state.visible.filter((notice) => notice.id !== action.id);
      return fillPendingNotices(visible, state.pending);
    }
    default:
      return state;
  }
}

function extractMessageText(message: Partial<AgentMessage>): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) =>
      block && typeof block === "object"
        && (block as { type?: string }).type === "text"
        && typeof (block as { text?: unknown }).text === "string"
        ? (block as { text: string }).text
        : "")
    .filter(Boolean)
    .join("\n");
}

function imageSignature(block: unknown): string {
  if (!block || typeof block !== "object" || (block as { type?: unknown }).type !== "image") return "";
  const source = (block as { source?: unknown }).source;
  if (source && typeof source === "object") {
    const src = source as { type?: unknown; media_type?: unknown; data?: unknown; url?: unknown };
    return [
      src.type === "url" ? "url" : "base64",
      typeof src.media_type === "string" ? src.media_type : "",
      typeof src.data === "string" ? src.data : "",
      typeof src.url === "string" ? src.url : "",
    ].join(":");
  }
  const flat = block as { data?: unknown; mimeType?: unknown };
  return [
    "base64",
    typeof flat.mimeType === "string" ? flat.mimeType : "",
    typeof flat.data === "string" ? flat.data : "",
    "",
  ].join(":");
}

function userMessageKey(message: Partial<AgentMessage>): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return JSON.stringify({ text: content, images: [] });
  if (!Array.isArray(content)) return JSON.stringify({ text: "", images: [] });
  return JSON.stringify({
    text: extractMessageText(message),
    images: content.map(imageSignature).filter(Boolean),
  });
}


function readCompactResult(result: unknown, reason: string): CompactResultInfo | null {
  if (!result || typeof result !== "object") return null;
  const r = result as CompactCommandResult;
  if (typeof r.tokensBefore !== "number" || typeof r.estimatedTokensAfter !== "number") return null;
  return { reason, tokensBefore: r.tokensBefore, estimatedTokensAfter: r.estimatedTokensAfter };
}

export interface ChatInputHandle {
  insertText: (text: string) => void;
  insertIfEmpty: (content: string) => void;
  prependText: (text: string) => void;
  addImages: (files: File[]) => void;
  restoreSubmission: (text: string, images?: Array<{ data: string; mimeType: string }>, targetDraftKey?: string) => void;
  replaceMessage: (message: UserMessage) => void;
  rekeyDraft?: (previousKey: string, nextKey: string) => void;
}

export interface AttachedImage {
  data: string;
  mimeType: string;
  previewUrl: string;
}

type SelectedModel = { provider: string; modelId: string };
type ModelEntry = { id: string; name: string; provider: string };
type ModelsResponse = {
  models: Record<string, string>;
  modelList?: ModelEntry[];
  defaultModel?: SelectedModel | null;
  /** Thinking level a new session starts with when the user has not picked one. */
  defaultThinkingLevel?: string | null;
  /** `defaultThinkingLevel` as saved in settings; starred in the reasoning menu. */
  savedDefaultThinkingLevel?: string | null;
  thinkingLevels?: Record<string, string[]>;
  thinkingLevelMaps?: Record<string, Record<string, string | null>>;
  thinkingLevelPins?: Record<string, string>;
  roles?: ModelRoleAssignment[];
  modelError?: string;
  modelScopeWarnings?: string[];
};

type SlashCommandsResponse = {
  commands?: SlashCommandInfo[];
};

export function useAgentSession(opts: UseAgentSessionOptions) {
  const {
    session, newSessionCwd, newSessionDraftKey, onAgentEnd, onToolEnd, onAttentionNeeded, onSessionCreated, onSessionForked,
    modelsRefreshKey, onBranchDataChange, onSystemPromptChange, onSystemToolsChange, onSystemInfoLoaderChange,
    onSessionStatsPanelOpen, onOpenSettings,
  } = opts;
  const deferInitialScroll = opts.deferInitialScroll ?? false;

  const isNew = session === null && newSessionCwd !== null;

  const [data, setData] = useState<SessionData | null>(null);
  const [loading, setLoading] = useState(!isNew);
  const [error, setError] = useState<string | null>(null);
  const [activeLeafId, setActiveLeafId] = useState<string | null>(null);
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [entryIds, setEntryIds] = useState<string[]>([]);
  // React keys carried across history reloads so paging does not remount
  // (and re-animate) rows that stay visible.
  const [messageKeyAliases, setMessageKeyAliases] = useState<Map<string, string>>(() => new Map());
  // Streaming text lives outside React so a chunk re-renders only the rows
  // subscribed to it; this mirror only exists to recompute the live region's
  // size, which decides whether older rows lazy-load their bodies.
  const streamingStoreRef = useRef<SessionStreamingStore | null>(null);
  streamingStoreRef.current ??= createSessionStreamingStore();
  const streamingStore = streamingStoreRef.current;
  // The latest render, read by history loads so they can carry React keys
  // across reloads without re-creating on every message change.
  const messagesRef = useRef<AgentMessage[]>(messages);
  messagesRef.current = messages;
  const entryIdsRef = useRef<string[]>(entryIds);
  entryIdsRef.current = entryIds;
  const [historyCursor, setHistoryCursor] = useState<string | null>(null);
  const [hasEarlierMessages, setHasEarlierMessages] = useState(false);
  const [earlierTurnCount, setEarlierTurnCount] = useState(0);
  // In-flight tool calls, by toolCallId, so a tool card can show live output
  // before the tool_execution_end event lands with the final result.
  const [activeToolResults, setActiveToolResults] = useState<Map<string, ToolResultMessage>>(() => new Map());
  // The history entry the composer is rewriting (edit-and-resend). A pending
  // edit lives with the session's draft, so it survives a remount (#1146).
  const [editEntryId, setEditEntryId] = useState(() => {
    const sid = session?.id;
    if (sid && !getDraft(sid)) pendingHistoryEdits.delete(sid);
    return (sid && pendingHistoryEdits.get(sid)) || null;
  });
  const [streamState, dispatchStreamReducer] = useReducer(streamReducer, { isStreaming: false, streamingMessage: null });
  // The reducer keeps `streamState` for logic that reacts to streaming
  // transitions; the store is what message rows actually subscribe to.
  const dispatch = useCallback((action: StreamAction) => {
    dispatchStreamReducer(action);
    streamingStore.dispatch(action);
  }, [streamingStore]);
  const [agentRunning, setAgentRunning] = useState(false);
  const [bashRunning, setBashRunning] = useState(false);
  const [pendingBash, setPendingBash] = useState<{ command: string; excludeFromContext: boolean } | null>(null);
  const [modelNames, setModelNames] = useState<Record<string, string>>({});
  const [modelList, setModelList] = useState<ModelEntry[]>([]);
  const [modelError, setModelError] = useState<string | null>(null);
  const [modelScopeWarnings, setModelScopeWarnings] = useState<string[]>([]);
  const [modelThinkingLevels, setModelThinkingLevels] = useState<Record<string, string[]>>({});
  const [modelThinkingLevelMaps, setModelThinkingLevelMaps] = useState<Record<string, Record<string, string | null>>>({});
  const [modelRoles, setModelRoles] = useState<ModelRoleAssignment[]>([]);
  const [newSessionModel, setNewSessionModel] = useState<SelectedModel | null>(null);
  const [newSessionDefaultModel, setNewSessionDefaultModel] = useState<SelectedModel | null>(null);
  const [newSessionDefaultThinkingLevel, setNewSessionDefaultThinkingLevel] = useState<ConcreteThinkingLevel | null>(null);
  // The level saved as `defaultThinkingLevel`, starred in the reasoning menu.
  const [savedDefaultThinkingLevel, setSavedDefaultThinkingLevel] = useState<ConcreteThinkingLevel | null>(null);
  const [toolPreset, setToolPreset] = useState<ToolPreset>("default");
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevelOption>("auto");
  const [effectiveThinkingLevel, setEffectiveThinkingLevel] = useState<string | undefined>();
  const [retryInfo, setRetryInfo] = useState<{ attempt: number; maxAttempts: number; errorMessage?: string } | null>(null);
  const [autoCompactionEnabled, setAutoCompactionEnabled] = useState(false);
  const [contextUsage, setContextUsage] = useState<{ percent: number | null; contextWindow: number; tokens: number | null } | null>(null);
  const [systemPrompt, setSystemPrompt] = useState<string | null>(null);
  const [forkingEntryId, setForkingEntryId] = useState<string | null>(null);
  const [currentModelOverride, setCurrentModelOverride] = useState<{ provider: string; modelId: string } | null>(null);
  const [pendingModel, setPendingModel] = useState<{ provider: string; modelId: string } | null>(null);
  const [modelSwitching, setModelSwitching] = useState(false);
  const [isCompacting, setIsCompacting] = useState(false);
  const [compactError, setCompactError] = useState<string | null>(null);
  const [compactResult, setCompactResult] = useState<CompactResultInfo | null>(null);
  const [agentPhase, setAgentPhase] = useState<AgentPhase>(null);
  // True while a freshly sent prompt is waiting to be anchored to the top;
  // held across the blanking gap so the anchor effect is not cancelled.
  const [promptAnchorActive, setPromptAnchorActive] = useState(false);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const [slashCommands, setSlashCommands] = useState<SlashCommandInfo[]>([]);
  const [slashCommandsLoading, setSlashCommandsLoading] = useState(false);
  const slashCommandsRef = useRef<SlashCommandInfo[]>([]);
  const slashCommandsGenerationRef = useRef(0);
  const slashCommandsLoadRef = useRef<Promise<SlashCommandInfo[] | null> | null>(null);
  const [noticeState, dispatchNotice] = useReducer(noticeReducer, { visible: [], pending: [] });
  const [sessionStatsOverride, setSessionStatsOverride] = useState<SessionStatsInfo | null>(null);
  const [extensionDialog, setExtensionDialog] = useState<ExtensionUiDialogRequest | null>(null);
  const [extensionCustomUi, setExtensionCustomUi] = useState<ExtensionUiCustomRequest | null>(null);
  const [extensionStatuses, setExtensionStatuses] = useState<ExtensionStatusItem[]>([]);
  const [extensionWidgets, setExtensionWidgets] = useState<ExtensionWidgetItem[]>([]);
  const [queuedMessages, setQueuedMessages] = useState<QueuedMessages>({ steering: [], followUp: [] });
  const [subagents, setSubagents] = useState<SubagentSnapshot[]>([]);

  const eventSourceRef = useRef<EventSource | null>(null);
  const eventSourceSessionIdRef = useRef<string | null>(null);
  const eventSourceRuntimeIdRef = useRef<string | null>(null);
  const eventConnectionAttemptRef = useRef<EventStreamConnectionAttempt | null>(null);
  const eventStreamGraceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const eventStreamGraceGenerationRef = useRef(0);
  const eventStreamGraceActiveRef = useRef(false);
  const sessionIdRef = useRef<string | null>(session?.id ?? null);
  const runtimeIdRef: RuntimeSessionBinding = useRef(session?.runtimeId ?? null);
  const historyRequestRef = useRef(0);
  const contextRequestRef = useRef(0);
  const mountedRef = useRef(false);
  const identityDraftKeyRef = useRef<string | undefined>(undefined);
  useLayoutEffect(() => {
    mountedRef.current = true;
    if (session) {
      sessionIdRef.current = session.id;
      runtimeIdRef.current = session.runtimeId ?? null;
    }
    identityDraftKeyRef.current = session?.id ?? newSessionDraftKey ?? (newSessionCwd ? `new:${newSessionCwd}` : undefined);
    return () => { mountedRef.current = false; };
  }, [session?.id, session?.runtimeId, newSessionCwd]);

  // Carried from the previous fresh session (a project switch): preselect the same
  // model and thinking level so the next composer starts where the last one was.
  useEffect(() => {
    const carried = opts.initialNewSessionChoices;
    if (!isNew || !carried) return;
    if (carried.model) setNewSessionModel(carried.model);
    const carriedLevel = asCarriedThinkingLevel(carried.thinkingLevel);
    if (carriedLevel) setThinkingLevel(carriedLevel);
  }, [isNew, opts.initialNewSessionChoices]);

  // Report the fresh composer's choices so the shell can carry them to the next new session.
  const onNewSessionChoicesChange = opts.onNewSessionChoicesChange;
  useEffect(() => {
    if (!isNew) return;
    onNewSessionChoicesChange?.({
      model: newSessionModel ? { provider: newSessionModel.provider, modelId: newSessionModel.modelId } : null,
      thinkingLevel: thinkingLevel === "auto" ? null : thinkingLevel,
    });
  }, [isNew, newSessionModel, thinkingLevel, onNewSessionChoicesChange]);

  const agentRunningRef = useRef(false);
  const sdkAgentActiveRef = useRef(false);
  const rpcPromptPendingRef = useRef(false);
  const notifiedPromptRunIdRef = useRef(-1);
  const bashRunningRef = useRef(false);
  const bashRecoveryIdRef = useRef(0);
  const handleAgentEventRef = useRef<((event: AgentEvent) => void) | null>(null);
  const initialScrollDoneRef = useRef(deferInitialScroll);
  const lastUserMsgRef = useRef<HTMLDivElement | null>(null);
  const pendingScrollToUserRef = useRef(false);
  const handleNavigateRef = useRef<((leafId: string) => Promise<boolean>) | null>(null);
  // Auto-follow authority: false once the user scrolls away mid-run.
  const completionScrollAllowedRef = useRef(true);
  // `enabledModels` `:level` pins and the resolved settings default, applied
  // to a fresh session's starting reasoning level.
  const thinkingLevelPinsRef = useRef<Record<string, string>>({});
  const defaultThinkingLevelRef = useRef<ConcreteThinkingLevel | null>(null);
  const [autoFollowPaused, setAutoFollowPaused] = useState(false);
  const [goalStatus, setGoalStatus] = useState<GoalStatusInfo | null>(null);
  const executeBashRef = useRef<(command: string, excludeFromContext: boolean) => Promise<void> | undefined>(undefined);
  const userScrollIntentUntilRef = useRef(0);
  const ignoreProgrammaticScrollUntilRef = useRef(0);
  // Forward reference: handleSend/executeBash are declared above setAutoFollow.
  const setAutoFollowRef = useRef<(following: boolean) => void>(() => {});
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const ensuringNewSessionRef = useRef<Promise<string | null> | null>(null);
  const newSessionPromotedRef = useRef(false);
  const newSessionModelOverrideRef = useRef<SelectedModel | null>(null);
  const thinkingLevelOverrideRef = useRef<ThinkingLevelOption | null>(null);
  const promptRunIdRef = useRef(0);
  const contextUsageRequestIdRef = useRef(0);
  const contextUsageAppliedIdRef = useRef(0);
  const sessionHookMountedRef = useRef(true);
  const optimisticUserMessageKeyRef = useRef<string | null>(null);
  const modelSwitchPendingRef = useRef(false);

  const setToolPresetState = opts.setToolPreset ?? setToolPreset;

  const currentModel = currentModelOverride ?? data?.context.model ?? pendingModel ?? null;
  const displayModel = isNew ? (newSessionModel ?? newSessionDefaultModel) : currentModel;

  const sessionStats = useMemo(() => {
    if (sessionStatsOverride) {
      return { ...sessionStatsOverride, totalActiveMs: data?.totalActiveMs };
    }
    const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
    let cost = 0;
    let userMessages = 0;
    let assistantMessages = 0;
    let toolResults = 0;
    let toolCalls = 0;
    for (const msg of messages) {
      if (msg.role === "user") userMessages += 1;
      if (msg.role === "toolResult") toolResults += 1;
      if (msg.role !== "assistant") continue;
      assistantMessages += 1;
      const u = (msg as import("@/lib/types").AssistantMessage).usage;
      toolCalls += (msg as import("@/lib/types").AssistantMessage).content.filter((c) => c.type === "toolCall").length;
      if (!u) continue;
      tokens.input += u.input ?? 0;
      tokens.output += u.output ?? 0;
      tokens.cacheRead += u.cacheRead ?? 0;
      tokens.cacheWrite += u.cacheWrite ?? 0;
      cost += u.cost?.total ?? 0;
    }
    tokens.total = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
    if (tokens.total === 0 && messages.length === 0) return null;
    return {
      sessionFile: data?.filePath || undefined,
      sessionId: sessionIdRef.current ?? session?.id ?? "",
      sessionName: session?.name,
      userMessages,
      assistantMessages,
      toolCalls,
      toolResults,
      totalMessages: messages.length,
      tokens,
      cost,
      totalActiveMs: data?.totalActiveMs,
      ...(contextUsage ? { contextUsage } : {}),
    } satisfies SessionStatsInfo;
  }, [messages, sessionStatsOverride, contextUsage, data?.filePath, data?.totalActiveMs, session?.id, session?.name]);

  const closeEvents = useCallback(() => {
    const source = eventSourceRef.current;
    const attempt = eventConnectionAttemptRef.current;
    eventSourceRef.current = null;
    eventSourceSessionIdRef.current = null;
    eventSourceRuntimeIdRef.current = null;
    eventConnectionAttemptRef.current = null;
    attempt?.cancel();
    source?.close();
  }, []);

  const followSessionIdentity = useCallback((nextId: string, runtimeId?: string | null) => {
    if (!mountedRef.current) return;
    const previousRuntimeId = runtimeIdRef.current;
    const handleChanged = runtimeId !== undefined && runtimeId !== previousRuntimeId;
    // A source belongs to one live wrapper, not merely its transcript ID. An
    // expired wrapper can keep heartbeating, so OPEN alone cannot prove reuse is
    // safe. Same-runtime relocations retain their source and pending handshake.
    if (runtimeId !== undefined && eventSourceRef.current
      && eventSourceRuntimeIdRef.current !== runtimeId) {
      const attempt = eventConnectionAttemptRef.current;
      // State polling can discover a canonical connection's new wrapper before
      // its first frame arrives. Adopt that expected binding without declaring
      // the handshake ready; known/expired or unrelated sources still retire.
      if (runtimeId !== null && previousRuntimeId === null && eventSourceRuntimeIdRef.current === null
        && nextId === sessionIdRef.current && eventSourceSessionIdRef.current === nextId
        && attempt?.source === eventSourceRef.current && attempt.pending) {
        eventSourceRuntimeIdRef.current = runtimeId;
      } else {
        closeEvents();
      }
    }
    if (runtimeId !== undefined) runtimeIdRef.current = runtimeId;
    if (runtimeId === null && previousRuntimeId) clearSessionContinuation(undefined, previousRuntimeId);
    if (runtimeIdRef.current) rememberSessionContinuation(nextId, runtimeIdRef.current);
    if (nextId === sessionIdRef.current) {
      if (handleChanged || runtimeId === null) onSessionForked?.(nextId, runtimeId);
      return;
    }
    // Async sends awaiting the SSE handshake must use the new ID immediately;
    // React state alone leaves pending callbacks pointing at historical IDs.
    if (identityDraftKeyRef.current) {
      opts.chatInputRef?.current?.rekeyDraft?.(identityDraftKeyRef.current, nextId);
    }
    contextRequestRef.current += 1;
    identityDraftKeyRef.current = nextId;
    sessionIdRef.current = nextId;
    if (eventSourceRef.current) eventSourceSessionIdRef.current = nextId;
    onSessionForked?.(nextId, runtimeId === null ? null : runtimeIdRef.current ?? undefined);
  }, [closeEvents, onSessionForked, opts.chatInputRef]);

  runtimeIdRef.onIdentity = (identity, request) => {
    if (!mountedRef.current || !sessionIdRef.current) return false;
    const current = { sessionId: sessionIdRef.current, runtimeId: runtimeIdRef.current };
    if (!canApplySessionIdentity(current, identity, request)) return false;
    followSessionIdentity(identity.sessionId, identity.runtimeId);
    return true;
  };

  const followRuntimeState = useCallback((state: AgentStateResponse | undefined, requestedId: string, requestedRuntimeId: string | null) => {
    // A response from an expired handle can arrive after another request has
    // installed its replacement for the same transcript. Drop all stale state,
    // including idle flags, rather than clearing or settling that newer runtime.
    if (!mountedRef.current || sessionIdRef.current !== requestedId
      || runtimeIdRef.current !== requestedRuntimeId) return true;
    if (state?.sessionId) {
      followSessionIdentity(state.sessionId, state.runtimeId ?? null);
    }
    return false;
  }, [followSessionIdentity]);

  const loadSession = useCallback(async (sid: string, showLoading = false, includeState = false) => {
    const requestId = ++historyRequestRef.current;
    const ownsHistory = () => mountedRef.current && sessionIdRef.current === sid && historyRequestRef.current === requestId;
    let messagesLoaded = false;
    try {
      if (showLoading) setLoading(true);
      const params = new URLSearchParams({ deferThinking: "1", deferMedia: "1" });
      const res = await fetch(`/api/sessions/${encodeURIComponent(sid)}?${params}`);
      if (res.status === 404) {
        if (showLoading && ownsHistory()) {
          setData(null);
          setActiveLeafId(null);
          setMessages([]);
          setEntryIds([]);
          setHistoryCursor(null);
          setHasEarlierMessages(false);
          setEarlierTurnCount(0);
          setError(null);
        }
        return null;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = await res.json() as SessionData;
      if (!ownsHistory()) return null;
      if (d.runtimeId || d.sessionId !== sid) {
        followSessionIdentity(d.sessionId, d.runtimeId);
        sid = d.sessionId;
      }
      setData(d);
      setActiveLeafId(d.leafId);
      const nextEntryIds = d.context.entryIds ?? [];
      setMessages(d.context.messages);
      setEntryIds(nextEntryIds);
      // Paged history answers carry the branch cursor; only then do the
      // cursor and the render-key carry (which keeps reloaded rows mounted
      // across paging) have anything to track.
      if ("oldestEntryId" in d.context) {
        setMessageKeyAliases((aliases) => carryMessageKeys(
          { messages: messagesRef.current, entryIds: entryIdsRef.current, aliases },
          { messages: d.context.messages, entryIds: nextEntryIds },
        ));
        setHistoryCursor(d.context.oldestEntryId ?? null);
        setHasEarlierMessages(d.context.hasMore ?? false);
        setEarlierTurnCount(d.context.turnsBefore ?? 0);
      }
      setContextUsage(d.contextUsage ?? null);
      setCurrentModelOverride((current) => modelSwitchPendingRef.current ? current : null);
      setError(null);
      setThinkingLevel((d.context.configuredThinkingLevel ?? d.context.thinkingLevel ?? "off") as ThinkingLevelOption);
      setEffectiveThinkingLevel(d.context.thinkingLevel);

      messagesLoaded = true;
      if (showLoading) setLoading(false);
      if (!includeState) return null;

      try {
        const requestedRuntimeId = runtimeIdRef.current;
        const stateRes = await fetch(requestedRuntimeId
          ? `/api/agent/${encodeURIComponent(requestedRuntimeId)}`
          : `/api/sessions/${encodeURIComponent(sid)}/state`);
        if (!stateRes.ok) throw new Error(`HTTP ${stateRes.status}`);
        const agentState = await stateRes.json() as { running: boolean; state?: AgentStateResponse };
        if (!mountedRef.current || sessionIdRef.current !== sid) return null;

        const liveState = agentState.state;
        if (followRuntimeState(liveState, sid, requestedRuntimeId)) return null;
        if (!agentState.running && liveState?.sessionId) runtimeIdRef.current = null;
        if (liveState) {
          if (liveState.contextUsage !== undefined) setContextUsage(liveState.contextUsage ?? null);
          if (liveState.systemPrompt !== undefined) setSystemPrompt(liveState.systemPrompt ?? null);
          if (liveState.thinkingLevel !== undefined) {
            setThinkingLevel((liveState.configuredThinkingLevel ?? liveState.thinkingLevel) as ThinkingLevelOption);
            setEffectiveThinkingLevel(liveState.thinkingLevel);
          }
          if (liveState.extensionStatuses !== undefined) setExtensionStatuses(liveState.extensionStatuses ?? []);
          if (liveState.extensionWidgets !== undefined) setExtensionWidgets(liveState.extensionWidgets ?? []);
          if (liveState.queuedMessages !== undefined) setQueuedMessages(normalizeQueuedMessages(liveState.queuedMessages));
          if (liveState.autoCompactionEnabled !== undefined) setAutoCompactionEnabled(liveState.autoCompactionEnabled ?? true);
          if (liveState.subagents !== undefined) setSubagents((current) => mergeSubagentSnapshots(current, liveState.subagents ?? []));
        } else if (!agentState.running) {
          setQueuedMessages({ steering: [], followUp: [] });
        }
        return agentState;
      } catch (e) {
        console.error("Failed to load agent state:", e);
        return null;
      }
    } catch (e) {
      if (ownsHistory()) setError(String(e));
      return null;
    } finally {
      if (ownsHistory() && (showLoading || messagesLoaded)) setLoading(false);
    }
  }, [followSessionIdentity, followRuntimeState, onSessionForked]);

  const loadContext = useCallback(async (
    sid: string,
    leafId: string | null,
    before?: string | null,
    options?: { tail?: number; signal?: AbortSignal },
  ): Promise<boolean | SessionData["context"]> => {
    const requestId = ++contextRequestRef.current;
    const requestedRuntimeId = runtimeIdRef.current;
    const ownsContext = () => mountedRef.current && sessionIdRef.current === sid
      && contextRequestRef.current === requestId && runtimeIdRef.current === requestedRuntimeId;
    try {
      const params = new URLSearchParams({ deferThinking: "1", deferMedia: "1" });
      if (leafId) params.set("leafId", leafId);
      // Page upward: ask the server for the `tail` ancestors preceding `before`,
      // then prepend them. Omitting `before` fetches the most-recent `tail`.
      if (before) params.set("before", before);
      if (options?.tail) params.set("tail", String(options.tail));
      const url = `/api/sessions/${encodeURIComponent(requestedRuntimeId ?? sid)}/context?${params}`;
      const res = await fetch(url, options?.signal ? { signal: options.signal } : undefined);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = await res.json() as {
        sessionId?: string;
        runtimeId?: string | null;
        context: SessionData["context"];
        contextUsage?: ContextUsage;
      };
      if (!ownsContext() || options?.signal?.aborted) return false;
      if (d.sessionId) followSessionIdentity(d.sessionId, d.runtimeId ?? null);
      if (before) {
        // Older page: prepend so scroll position stays anchored.
        setHistoryCursor(d.context.oldestEntryId ?? null);
        setHasEarlierMessages(d.context.hasMore ?? false);
        setEarlierTurnCount(d.context.turnsBefore ?? 0);
        setData((prev) => prev && prev.sessionId === sid ? {
          ...prev,
          context: {
            ...prev.context,
            messages: [...d.context.messages, ...prev.context.messages],
            entryIds: [...(d.context.entryIds ?? []), ...prev.context.entryIds],
            oldestEntryId: d.context.oldestEntryId,
            hasMore: d.context.hasMore,
            turnsBefore: d.context.turnsBefore,
          },
        } : prev);
        setMessages((prev) => [...d.context.messages, ...prev]);
        setEntryIds((prev) => [...(d.context.entryIds ?? []), ...prev]);
        return d.context;
      }
      setMessages(d.context.messages);
      setEntryIds(d.context.entryIds ?? []);
      setContextUsage(d.contextUsage ?? null);
      // A branch switch re-baselines the paging cursor when the response
      // carries paged-view metadata; a legacy payload has nothing to track.
      if ("oldestEntryId" in d.context) {
        setData((prev) => prev && prev.sessionId === sid ? { ...prev, context: d.context } : prev);
        setHistoryCursor(d.context.oldestEntryId ?? null);
        setHasEarlierMessages(d.context.hasMore ?? false);
        setEarlierTurnCount(d.context.turnsBefore ?? 0);
      }
      return true;
    } catch (e) {
      if (ownsContext() && !options?.signal?.aborted) console.error("Failed to load context:", e);
      return false;
    }
  }, [followSessionIdentity]);

  const loadTools = useCallback(async (sid: string) => {
    try {
      const tools = await sendAgentCommand<ToolEntry[]>(sid, { type: "get_tools" }, runtimeIdRef);
      if (!tools || !sessionHookMountedRef.current || sessionIdRef.current !== sid) return null;
      const { getPresetFromTools } = await import("@/lib/tool-presets");
      setToolPresetState(getPresetFromTools(tools));
      onSystemToolsChange?.(tools);
      return tools;
    } catch (e) {
      console.error("Failed to load tools:", e);
      return null;
    }
  }, [onSystemToolsChange, setToolPresetState]);

  const promoteNewSession = useCallback((messageCount = 0, firstMessage = "(no messages)") => {
    const sid = sessionIdRef.current;
    if (!isNew || !newSessionCwd || !sid || newSessionPromotedRef.current) return;
    newSessionPromotedRef.current = true;
    // The provisional composer draft (the shell's `new:<id>:<cwd>` key) belongs to
    // this session from here on: rekey it before the next mount reads drafts.
    const provisionalDraftKey = identityDraftKeyRef.current;
    if (provisionalDraftKey && provisionalDraftKey !== sid) {
      opts.chatInputRef?.current?.rekeyDraft?.(provisionalDraftKey, sid);
    }
    onSessionCreated?.({
      id: sid,
      runtimeId: runtimeIdRef.current ?? undefined,
      path: "",
      cwd: newSessionCwd,
      name: undefined,
      created: new Date().toISOString(),
      modified: new Date().toISOString(),
      messageCount,
      firstMessage,
      transient: true,
    }, provisionalDraftKey ?? sid);
  }, [isNew, newSessionCwd, onSessionCreated, opts.chatInputRef]);

  const ensureNewSession = useCallback(async () => {
    if (sessionIdRef.current) return sessionIdRef.current;
    if (!isNew || !newSessionCwd) return sessionIdRef.current;
    if (ensuringNewSessionRef.current) return ensuringNewSessionRef.current;

    const promise = (async () => {
      // Only send explicit user overrides. The server resolves the current
      // enabledModels scope atomically with AgentSession construction.
      const selectedModel = newSessionModelOverrideRef.current;
      const selectedThinkingLevel = thinkingLevelOverrideRef.current;
      if (selectedModel) setPendingModel(selectedModel);
      const toolNames = getToolNamesForPreset(toolPreset);
      const res = await fetch("/api/agent/new", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cwd: newSessionCwd,
          type: "ensure_session",
          toolNames,
          ...(selectedModel ? { provider: selectedModel.provider, modelId: selectedModel.modelId } : {}),
          ...(selectedThinkingLevel
            ? { thinkingLevel: selectedThinkingLevel }
            : {}),
        }),
      });
      if (!res.ok) {
        // The server's reason (a project folder that no longer exists, a model Chat only
        // cannot load) beats a bare status.
        const body = await res.json().catch(() => null) as { error?: unknown } | null;
        throw new Error(typeof body?.error === "string" ? body.error : `HTTP ${res.status}`);
      }
      const result = await res.json() as {
        sessionId: string;
        runtimeId?: string;
        model?: SelectedModel | null;
        thinkingLevel?: ThinkingLevelOption;
        configuredThinkingLevel?: ThinkingLevelOption;
      };
      const realId = result.sessionId;
      sessionIdRef.current = realId;
      runtimeIdRef.current = result.runtimeId ?? null;
      if (result.runtimeId) rememberSessionContinuation(realId, result.runtimeId);
      if (result.model && newSessionModelOverrideRef.current === selectedModel) {
        setPendingModel(result.model);
        if (!selectedModel) setNewSessionDefaultModel(result.model);
      }
      if (
        result.thinkingLevel
        && thinkingLevelOverrideRef.current === selectedThinkingLevel
      ) {
        setThinkingLevel(result.configuredThinkingLevel ?? result.thinkingLevel);
        setEffectiveThinkingLevel(result.thinkingLevel);
        if (!selectedThinkingLevel) setNewSessionDefaultThinkingLevel(asConcreteThinkingLevel(result.thinkingLevel));
      }
      return realId;
    })();

    ensuringNewSessionRef.current = promise;
    try {
      return await promise;
    } finally {
      ensuringNewSessionRef.current = null;
    }
  }, [isNew, newSessionCwd, toolPreset]);

  // Opening the System or Tools panel may initialize an otherwise dormant
  // session. This is deliberately a non-prompt command: it creates no message
  // or model run, but lets users inspect the exact prompt before sending one.
  const loadSystemInfo = useCallback(async () => {
    const sid = sessionIdRef.current ?? await ensureNewSession();
    if (!sid) return;
    const [state] = await Promise.all([
      sendAgentCommand<AgentStateResponse>(sid, { type: "get_state" }, runtimeIdRef),
      loadTools(sid),
    ]);
    if (!sessionHookMountedRef.current || sessionIdRef.current !== sid) return;
    if (state?.systemPrompt !== undefined) setSystemPrompt(state.systemPrompt ?? null);
  }, [ensureNewSession, loadTools]);

  const composerDraftKey = session?.id ?? newSessionDraftKey ?? undefined;

  // Returns a rejected submission's text to the composer. Once the fresh
  // composer's hook is gone (the user switched away) and the session was never
  // promoted, nothing on screen can show it — dropping it beats leaking text
  // into the session the user moved to.
  const restoreSubmission = useCallback((
    text: string,
    images: AttachedImage[] | undefined,
    targetDraftKey: string | undefined,
  ) => {
    const draftImages = images?.map(({ data, mimeType }) => ({ data, mimeType }));
    if (
      !sessionHookMountedRef.current
      && !newSessionPromotedRef.current
      && targetDraftKey === newSessionDraftKey
    ) return;
    const input = opts.chatInputRef?.current;
    if (input) {
      input.restoreSubmission(text, draftImages, targetDraftKey);
    } else if (targetDraftKey) {
      restoreDraftSubmission(targetDraftKey, text, draftImages);
    }
  }, [newSessionDraftKey, opts.chatInputRef]);

  // Editing a past message only prefills the composer; the branch moves when it is sent,
  // so cancelling or reloading never hides the rest of the conversation.
  const setEdit = useCallback((entryId: string | null) => {
    if (!session?.id) return;
    if (entryId) pendingHistoryEdits.set(session.id, entryId);
    else pendingHistoryEdits.delete(session.id);
    setEditEntryId(entryId);
  }, [session?.id]);
  const handleEditContent = useCallback((message: UserMessage, entryId: string) => {
    if (!session?.id) return;
    opts.chatInputRef?.current?.replaceMessage(message);
    setEdit(entryId);
  }, [opts.chatInputRef, session?.id, setEdit]);
  const cancelEdit = useCallback(() => setEdit(null), [setEdit]);

  const replaceSlashCommands = useCallback((commands: SlashCommandInfo[]) => {
    slashCommandsRef.current = commands;
    setSlashCommands(commands);
  }, []);

  // The session's tools changed (set_tools may have rebuilt it as Chat only): forget the
  // list and the request under way, so the next reader asks the session as it is now.
  const clearSlashCommands = useCallback(() => {
    slashCommandsGenerationRef.current += 1;
    slashCommandsLoadRef.current = null;
    replaceSlashCommands([]);
  }, [replaceSlashCommands]);

  // Null when get_commands failed, which an empty list (a Chat-only session's) must not be mistaken for.
  const requestSlashCommands = useCallback((): Promise<SlashCommandInfo[] | null> => {
    const generation = ++slashCommandsGenerationRef.current;
    const current = () => slashCommandsGenerationRef.current === generation;
    const load = (async () => {
      const sid = sessionIdRef.current ?? await ensureNewSession();
      if (!sid) {
        if (current()) replaceSlashCommands([]);
        return [] as SlashCommandInfo[];
      }
      setSlashCommandsLoading(true);
      try {
        const data = await sendAgentCommand<SlashCommandsResponse>(sid, { type: "get_commands" }, runtimeIdRef);
        const commands = data?.commands ?? [];
        if (current()) replaceSlashCommands(commands);
        return commands;
      } catch (e) {
        console.error("Failed to load slash commands:", e);
        if (current()) replaceSlashCommands([]);
        return null;
      } finally {
        // A newer request under way keeps the palette's "Loading" until it answers.
        if (current() || !slashCommandsLoadRef.current) setSlashCommandsLoading(false);
      }
    })();
    slashCommandsLoadRef.current = load;
    const settle = () => {
      if (slashCommandsLoadRef.current === load) slashCommandsLoadRef.current = null;
    };
    load.then(settle, settle);
    return load;
  }, [ensureNewSession, replaceSlashCommands]);

  const slashCommandsForMcp = useCallback(async (): Promise<SlashCommandInfo[] | null> => {
    const pending = slashCommandsLoadRef.current;
    const known = slashCommandsRef.current;
    if (!pending && known.length > 0) return known;
    const loaded = await (pending ?? requestSlashCommands()).catch(() => null);
    return loaded ?? (known.length > 0 ? known : null);
  }, [requestSlashCommands]);

  const loadSlashCommands = useCallback(async () => (await requestSlashCommands()) ?? [], [requestSlashCommands]);

  const cancelEventStreamGrace = useCallback(() => {
    eventStreamGraceGenerationRef.current += 1;
    eventStreamGraceActiveRef.current = false;
    if (eventStreamGraceTimerRef.current) {
      clearTimeout(eventStreamGraceTimerRef.current);
      eventStreamGraceTimerRef.current = null;
    }
  }, []);

  const connectEvents = useCallback((sid: string): Promise<EventStreamConnectionResult> => {
    if (!mountedRef.current) return Promise.reject(new Error("Session is no longer active"));
    closeEvents();
    const es = new EventSource(`/api/agent/${encodeURIComponent(runtimeIdRef.current ?? sid)}/events`);
    eventSourceRef.current = es;
    eventSourceSessionIdRef.current = sid;
    eventSourceRuntimeIdRef.current = runtimeIdRef.current;

    let cancel = () => {};
    const promise = new Promise<EventStreamConnectionResult>((resolve) => {
      let settled = false;
      let receivedConnected = false;
      const settle = (status: EventStreamConnectionStatus) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (eventConnectionAttemptRef.current?.source === es) {
          eventConnectionAttemptRef.current.pending = false;
        }
        resolve({ status, source: es });
      };
      const timeout = setTimeout(() => settle("timeout"), EVENT_STREAM_CONNECT_TIMEOUT_MS);
      cancel = () => settle("closed");

      es.onmessage = (e) => {
        if (!mountedRef.current || eventSourceRef.current !== es) return;
        try {
          const event = JSON.parse(e.data) as AgentEvent;
          // A canonical-ID connection may create a new runtime. Bind its first
          // frame before following identity so we do not close that fresh source.
          if (event.type === "connected" && typeof event.runtimeId === "string") {
            // A poll may have adopted an expected runtime while this source was
            // unbound. Reject a contradictory first frame, even after timeout,
            // instead of rolling the selected runtime back to another wrapper.
            const expectedRuntimeId = eventSourceRuntimeIdRef.current;
            if (!receivedConnected && expectedRuntimeId !== null && event.runtimeId !== expectedRuntimeId) {
              closeEvents();
              return;
            }
            eventSourceRuntimeIdRef.current = event.runtimeId;
          }
          if (event.type === "connected") receivedConnected = true;
          if (event.type === "connected" && eventConnectionAttemptRef.current?.source === es) {
            eventConnectionAttemptRef.current.connected = true;
          }
          handleAgentEventRef.current?.(event);
          if (event.type === "connected") settle("connected");
        } catch {
          // ignore
        }
      };
      es.onerror = () => {
        if (!mountedRef.current || eventSourceRef.current !== es) return;
        if (eventConnectionAttemptRef.current?.source === es) eventConnectionAttemptRef.current.connected = false;
        if (es.readyState === EventSource.CLOSED) {
          // Fatal error (404/500/content-type mismatch): browser won't
          // auto-reconnect. Settle the Promise and manually reconnect for
          // already-running sessions or an active idle grace window.
          settle("closed");
          if (eventSourceRef.current === es && (agentRunningRef.current || eventStreamGraceActiveRef.current)) {
            eventSourceRef.current = null;
            eventSourceSessionIdRef.current = null;
            eventSourceRuntimeIdRef.current = null;
            eventConnectionAttemptRef.current = null;
            const reconnectGeneration = eventStreamGraceGenerationRef.current;
            setTimeout(() => {
              if (
                mountedRef.current
                && reconnectGeneration === eventStreamGraceGenerationRef.current
                && !eventSourceRef.current
                && (agentRunningRef.current || eventStreamGraceActiveRef.current)
              ) {
                void connectEvents(sid);
              }
            }, 1000);
          }
        }
        // Recoverable errors (CONNECTING): let EventSource auto-reconnect.
        // The timeout above resolves only to let callers decide whether this
        // connection must be ready before they continue.
      };
    });
    eventConnectionAttemptRef.current = { source: es, promise, pending: true, connected: false, cancel };
    return promise;
  }, [closeEvents]);

  const ensureEventsConnected = useCallback(async (sid: string) => {
    if (!mountedRef.current) throw new Error("Session is no longer active");
    const requestedRuntimeId = runtimeIdRef.current;
    if (requestedRuntimeId) {
      const stateRes = await fetch(agentStatusUrl(requestedRuntimeId));
      if (stateRes.ok) {
        const state = await stateRes.json() as { running?: boolean; state?: AgentStateResponse };
        if (!mountedRef.current || sessionIdRef.current !== sid) throw new Error("Session is no longer active");
        const stale = followRuntimeState(state.state, sid, requestedRuntimeId);
        if (!stale && !state.running) {
          if (!state.state?.sessionId) throw new Error("Runtime identity expired; reopen the intended session");
          runtimeIdRef.current = null;
        }
        sid = sessionIdRef.current ?? sid;
      }
    }
    if (!mountedRef.current) throw new Error("Session is no longer active");
    const current = eventSourceRef.current;
    if (current && eventSourceSessionIdRef.current === sid
      && eventSourceRuntimeIdRef.current === runtimeIdRef.current) {
      const attempt = eventConnectionAttemptRef.current;
      if (attempt?.source === current && attempt.pending) {
        const result = await attempt.promise;
        if (!mountedRef.current) throw new Error("Session is no longer active");
        if (result.status === "connected" && eventSourceRef.current === current
          && eventSourceRuntimeIdRef.current === runtimeIdRef.current
          && current.readyState === EventSource.OPEN) return;
      } else if (attempt?.source === current && attempt.connected && current.readyState === EventSource.OPEN) {
        return;
      }
    }

    const result = await connectEvents(sessionIdRef.current ?? sid);
    if (!mountedRef.current || eventSourceRef.current !== result.source) {
      result.source.close();
      throw new Error("Session is no longer active");
    }
    if (result.status === "connected") return;
    if (eventSourceRef.current === result.source) eventSourceRef.current = null;
    if (eventSourceSessionIdRef.current === sid) eventSourceSessionIdRef.current = null;
    eventSourceRuntimeIdRef.current = null;
    if (eventConnectionAttemptRef.current?.source === result.source) eventConnectionAttemptRef.current = null;
    result.source.close();
    throw new EventStreamConnectionError(result.status);
  }, [connectEvents, followRuntimeState]);

  const respondToExtensionUi = useCallback(async (
    request: ExtensionUiDialogRequest,
    response: { value: string } | { confirmed: boolean } | { cancelled: true },
  ) => {
    const sid = sessionIdRef.current;
    setExtensionDialog((current) => current?.id === request.id ? null : current);
    if (!sid) return;
    try {
      await sendAgentCommand(sid, {
        type: "extension_ui_response",
        id: request.id,
        ...response,
      }, runtimeIdRef);
    } catch (e) {
      console.error("Failed to send extension UI response:", e);
    }
  }, []);

  const sendExtensionCustomInput = useCallback(async (request: ExtensionUiCustomRequest, data: string) => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    try {
      await sendAgentCommand(sid, {
        type: "extension_ui_input",
        id: request.id,
        data,
      }, runtimeIdRef);
    } catch (e) {
      console.error("Failed to send extension custom UI input:", e);
    }
  }, []);

  const addNotice = useCallback((notice: { id?: string; message: string; type?: NoticeType }) => {
    const message = notice.message.trim();
    if (!message) return;
    dispatchNotice({
      type: "add",
      notice: {
        id: notice.id ?? createNoticeId(),
        message,
        type: notice.type ?? "info",
      },
    });
  }, []);
  const appendCommandOutput = useCallback((text: string) => {
    const content = stripAnsi(text).trim();
    const message: CustomMessage = {
      role: "custom",
      customType: "command",
      content,
      display: true,
      timestamp: Date.now(),
    };
    setMessages((previous) => [...previous, message]);
  }, []);

  const handleExtensionUiRequest = useCallback((request: ExtensionUiRequest) => {
    if (isBlockingExtensionUiRequest(request)) onAttentionNeeded?.(request);

    switch (request.method) {
      case "select":
      case "confirm":
      case "input":
      case "editor":
      case "ask":
      case "plan_review":
        setExtensionDialog(request);
        break;
      case "notify": {
        addNotice({
          id: request.id,
          message: request.message,
          type: request.notifyType ?? "info",
        });
        break;
      }
      case "setStatus":
        setExtensionStatuses((prev) => {
          const rest = prev.filter((item) => item.key !== request.statusKey);
          return request.statusText !== undefined
            ? [...rest, { key: request.statusKey, text: request.statusText }]
            : rest;
        });
        break;
      case "setWidget":
        setExtensionWidgets((prev) => {
          const rest = prev.filter((item) => item.key !== request.widgetKey);
          return request.widgetLines
            ? [...rest, {
                key: request.widgetKey,
                lines: request.widgetLines,
                placement: request.widgetPlacement ?? "aboveEditor",
              }]
            : rest;
        });
        break;
      case "setTitle":
        if (request.title) document.title = request.title;
        break;
      case "set_editor_text":
        opts.chatInputRef?.current?.insertText(request.text);
        break;
      case "custom":
        setExtensionCustomUi((current) => {
          if (request.closed) return current?.id === request.id ? null : current;
          return request;
        });
        break;
    }
  }, [addNotice, onAttentionNeeded, opts.chatInputRef]);

  const settleUiStage = useCallback(() => {
    const wasRunning = agentRunningRef.current;
    agentRunningRef.current = false;
    setAgentRunning(false);
    setAgentPhase(null);
    setRetryInfo(null);
    dispatch({ type: "end" });
    return wasRunning;
  }, []);

  const notifyPromptStage = useCallback((runId: number) => {
    if (!mountedRef.current || notifiedPromptRunIdRef.current === runId) return false;
    notifiedPromptRunIdRef.current = runId;
    // omp has no aborted flag on its settle paths yet; completion always announces.
    onAgentEnd?.({ aborted: false, sessionId: sessionIdRef.current ?? undefined });
    return true;
  }, [onAgentEnd]);

  const scheduleEventStreamClose = useCallback((sid: string) => {
    cancelEventStreamGrace();
    eventStreamGraceActiveRef.current = true;
    const generation = eventStreamGraceGenerationRef.current;

    const checkServerIdle = async () => {
      if (
        generation !== eventStreamGraceGenerationRef.current
        || sessionIdRef.current !== sid
        || !eventStreamGraceActiveRef.current
      ) return;

      try {
        const requestedRuntimeId = runtimeIdRef.current;
        const res = await fetch(agentStatusUrl(requestedRuntimeId ?? sid));
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json() as { running?: boolean; state?: AgentStateResponse };
        if (
          generation !== eventStreamGraceGenerationRef.current
          || sessionIdRef.current !== sid
          || !eventStreamGraceActiveRef.current
        ) return;

        const state = data.state;
        if (followRuntimeState(state, sid, requestedRuntimeId)) {
          if (mountedRef.current) {
            eventStreamGraceTimerRef.current = setTimeout(() => void checkServerIdle(), PROMPT_SETTLE_POLL_MS);
          }
          return;
        }
        sid = sessionIdRef.current ?? sid;
        setSubagents((current) => mergeSubagentSnapshots(current, state?.subagents ?? []));
        const promptActive = Boolean(
          data.running
          && state
          && (state.isStreaming || state.isPromptRunning || state.isHandoffRunning)
        );
        if (promptActive) {
          eventStreamGraceActiveRef.current = false;
          eventStreamGraceTimerRef.current = null;
          sdkAgentActiveRef.current = Boolean(state?.isStreaming);
          rpcPromptPendingRef.current = Boolean(state?.isPromptRunning);
          agentRunningRef.current = true;
          setAgentRunning(true);
          setAgentPhase(state?.isStreaming ? { kind: "waiting_model" } : { kind: "running_command" });
          return;
        }

        if (data.running && state?.isCompacting) {
          setIsCompacting(true);
          eventStreamGraceTimerRef.current = setTimeout(() => void checkServerIdle(), PROMPT_SETTLE_POLL_MS);
          return;
        }
        if (data.running && (state?.subagents?.length ?? 0) > 0) {
          eventStreamGraceTimerRef.current = setTimeout(
            () => void checkServerIdle(),
            CONTEXT_USAGE_REFRESH_MS,
          );
          return;
        }


        eventStreamGraceActiveRef.current = false;
        eventStreamGraceTimerRef.current = null;
        closeEvents();
      } catch {
        // Keep the stream alive while state cannot be verified.
        if (
          generation !== eventStreamGraceGenerationRef.current
          || sessionIdRef.current !== sid
          || !eventStreamGraceActiveRef.current
        ) return;
        eventStreamGraceTimerRef.current = setTimeout(() => void checkServerIdle(), PROMPT_SETTLE_POLL_MS);
      }
    };

    eventStreamGraceTimerRef.current = setTimeout(() => void checkServerIdle(), EVENT_STREAM_IDLE_GRACE_MS);
  }, [cancelEventStreamGrace, closeEvents, followRuntimeState]);

  const finishPromptWithoutStream = useCallback(async (sid: string | null = sessionIdRef.current, runId = promptRunIdRef.current) => {
    // Bail out before loadSession too: a stale finish for a previous run
    // must not overwrite the messages of the run currently streaming.
    if (!mountedRef.current || promptRunIdRef.current !== runId) return;
    sid = sessionIdRef.current ?? sid;
    try {
      if (sid) await loadSession(sid);
    } finally {
      if (!mountedRef.current || promptRunIdRef.current !== runId) return;
      const promptWasPending = rpcPromptPendingRef.current;
      const agentWasActive = sdkAgentActiveRef.current;
      rpcPromptPendingRef.current = false;
      sdkAgentActiveRef.current = false;
      optimisticUserMessageKeyRef.current = null;
      const wasRunning = settleUiStage();
      if (promptWasPending) {
        notifyPromptStage(runId);
      } else if (agentWasActive && wasRunning) {
        onAgentEnd?.({ aborted: false, sessionId: sessionIdRef.current ?? undefined });
      }
      if (sid) scheduleEventStreamClose(sid);
    }
  }, [loadSession, notifyPromptStage, onAgentEnd, scheduleEventStreamClose, settleUiStage]);

  const waitForPromptSettlement = useCallback(async (sid: string, runId?: number) => {
    await delay(PROMPT_SETTLE_INITIAL_DELAY_MS);
    const startedAt = Date.now();

    while (agentRunningRef.current && Date.now() - startedAt < PROMPT_SETTLE_MAX_MS) {
      if (!mountedRef.current || sessionIdRef.current !== sid) return;
      if (runId !== undefined && promptRunIdRef.current !== runId) return;
      try {
        const requestedRuntimeId = runtimeIdRef.current;
        const res = await fetch(agentStatusUrl(requestedRuntimeId ?? sid));
        if (res.ok) {
          const data = await res.json() as { running?: boolean; state?: AgentStateResponse };
          if (runId !== undefined && promptRunIdRef.current !== runId) return;
          const state = data.state;
          if (followRuntimeState(state, sid, requestedRuntimeId)) {
            await delay(PROMPT_SETTLE_POLL_MS);
            continue;
          }
          sid = sessionIdRef.current ?? sid;
          if (!data.running || !state || (!state.isStreaming && !state.isPromptRunning)) {
            await finishPromptWithoutStream(sid, runId);
            return;
          }
        }
      } catch {
        // SSE remains the primary completion path.
      }
      await delay(PROMPT_SETTLE_POLL_MS);
    }
  }, [finishPromptWithoutStream, followRuntimeState]);

  const waitForBashSettlement = useCallback(async (sid: string) => {
    const recoveryId = bashRecoveryIdRef.current + 1;
    bashRecoveryIdRef.current = recoveryId;

    while (
      mountedRef.current
      && bashRunningRef.current
      && bashRecoveryIdRef.current === recoveryId
      && sessionIdRef.current === sid
    ) {
      await delay(BASH_STATE_RECONCILE_MS);
      try {
        const requestedRuntimeId = runtimeIdRef.current;
        const res = await fetch(agentStatusUrl(requestedRuntimeId ?? sid));
        if (!res.ok) continue;
        const data = await res.json() as { state?: AgentStateResponse };
        if (bashRecoveryIdRef.current !== recoveryId) return;
        if (followRuntimeState(data.state, sid, requestedRuntimeId)) continue;
        sid = sessionIdRef.current ?? sid;
        if (data.state?.isBashRunning) continue;

        await loadSession(sid);
        if (bashRecoveryIdRef.current !== recoveryId || sessionIdRef.current !== sid) return;
        bashRunningRef.current = false;
        setBashRunning(false);
        setPendingBash(null);
        return;
      } catch {
        // Keep polling while the page is mounted; network recovery is transparent.
      }
    }
  }, [loadSession, followRuntimeState]);

  // Reconcile client streaming state with the server. When SSE events are
  // missed (network drop, mobile tab backgrounded, half-open connection),
  // agent_end never arrives and the UI stays in streaming state forever.
  // If the server reports idle while we still think it's running, finish
  // through the same settlement path used by non-streaming prompts.
  const applyContextUsage = useCallback((state: AgentStateResponse | undefined, sid: string, runId: number, requestId: number) => {
    if (!sessionHookMountedRef.current || sessionIdRef.current !== sid
      || promptRunIdRef.current !== runId || requestId <= contextUsageAppliedIdRef.current) return;
    contextUsageAppliedIdRef.current = requestId;
    if (state?.contextUsage !== undefined) setContextUsage(state.contextUsage ?? null);
  }, []);

  const reconcileAgentState = useCallback(async (sid: string) => {
    if (!agentRunningRef.current) return;
    const runId = promptRunIdRef.current;
    const usageRequestId = ++contextUsageRequestIdRef.current;
    try {
      const requestedRuntimeId = runtimeIdRef.current;
      const res = await fetch(agentStatusUrl(requestedRuntimeId ?? sid));
      if (!res.ok) return;
      const data = await res.json() as { running?: boolean; state?: AgentStateResponse };
      // A slow response can straddle a run boundary (previous run finished
      // and the user already started the next one while this request was in
      // flight) — everything in it is stale, drop it.
      if (promptRunIdRef.current !== runId) return;
      const state = data.state;
      if (followRuntimeState(state, sid, requestedRuntimeId)) return;
      sid = sessionIdRef.current ?? sid;
      // Mirror compaction state unconditionally: a missed compaction_end
      // would otherwise leave the "Stop compaction" UI stuck. No state
      // (wrapper destroyed) means nothing is compacting.
      setIsCompacting(state?.isCompacting ?? false);
      setQueuedMessages(normalizeQueuedMessages(state?.queuedMessages));
      applyContextUsage(state, sid, runId, usageRequestId);
      setSubagents((current) => mergeSubagentSnapshots(current, state?.subagents ?? []));
      const busy = data.running && state
        && (state.isStreaming || state.isPromptRunning || state.isCompacting || state.isHandoffRunning);
      if (busy || !agentRunningRef.current) return;
      if (state) {
        if (state.systemPrompt !== undefined) setSystemPrompt(state.systemPrompt ?? null);
        if (state.extensionStatuses !== undefined) setExtensionStatuses(state.extensionStatuses ?? []);
        if (state.extensionWidgets !== undefined) setExtensionWidgets(state.extensionWidgets ?? []);
      }
      await finishPromptWithoutStream(sid, runId);
    } catch {
      // Network still down — the next poll / visibility / online tick retries.
    }
  }, [applyContextUsage, finishPromptWithoutStream, followRuntimeState]);
  const refreshContextUsage = useCallback(async (sid: string, runId = promptRunIdRef.current) => {
    const requestId = ++contextUsageRequestIdRef.current;
    try {
      const requestedRuntimeId = runtimeIdRef.current;
      const res = await fetch(agentStatusUrl(requestedRuntimeId ?? sid));
      if (!res.ok) return;
      const data = await res.json() as { state?: AgentStateResponse };
      if (followRuntimeState(data.state, sid, requestedRuntimeId)) return;
      applyContextUsage(data.state, sid, runId, requestId);
      // The model may have changed server-side (a /model run elsewhere); keep
      // the override in step unless a local switch is still in flight.
      if (sessionIdRef.current === sid && promptRunIdRef.current === runId
        && data.state?.model && !modelSwitchPendingRef.current) {
        setCurrentModelOverride({ provider: data.state.model.provider, modelId: data.state.model.id });
      }
    } catch {
      // The next refresh retries; state reconciliation owns error recovery.
    }
  }, [applyContextUsage, followRuntimeState]);

  // Context usage changes after each model/tool turn, not only when the prompt
  // settles. Poll the lightweight state endpoint while the session is active
  // so the meter follows those changes even if an SSE event is missed.
  useEffect(() => {
    if (!agentRunning && !isCompacting) return;
    const refresh = () => {
      const sid = sessionIdRef.current;
      if (sid) void refreshContextUsage(sid);
    };
    refresh();
    const interval = setInterval(refresh, CONTEXT_USAGE_REFRESH_MS);
    return () => clearInterval(interval);
  }, [agentRunning, isCompacting, refreshContextUsage]);


  // Recovery net for missed SSE events: while the agent is running, verify
  // against the server periodically and whenever the tab returns to the
  // foreground or the network comes back.
  useEffect(() => {
    if (!agentRunning) return;
    const reconcile = () => {
      // Read the ref on every tick: for brand-new sessions the id is
      // assigned only after ensure_session returns.
      const sid = sessionIdRef.current;
      if (sid) void reconcileAgentState(sid);
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") reconcile();
    };
    const interval = setInterval(reconcile, AGENT_STATE_RECONCILE_MS);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", reconcile);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", reconcile);
    };
  }, [agentRunning, reconcileAgentState]);

  useEffect(() => {
    agentRunningRef.current = agentRunning;
  }, [agentRunning]);

  useEffect(() => () => { sessionHookMountedRef.current = false; }, []);

  const handleAgentEvent = useCallback((event: AgentEvent) => {
    switch (event.type) {
      case "session_changed":
      case "connected": {
        if (typeof event.sessionId === "string") {
          followSessionIdentity(event.sessionId, typeof event.runtimeId === "string" ? event.runtimeId : undefined);
        }
        dispatch({ type: "end" });
        if (Array.isArray(event.pendingExtensionUiIds)) {
          // The server replays the requests it still holds right after this
          // event; anything it no longer owns must leave the screen.
          const pending = new Set<string>(event.pendingExtensionUiIds as string[]);
          setExtensionDialog((current) => current && !pending.has(current.id) ? null : current);
          setExtensionCustomUi((current) => current && !pending.has(current.id) ? null : current);
        }
        if (event.isStreaming === true) {
          // Connecting the stream is what resumes an idle-reaped session; a run
          // that survived the reap must look running again at once.
          cancelEventStreamGrace();
          sdkAgentActiveRef.current = true;
          agentRunningRef.current = true;
          setAgentRunning(true);
          setAgentPhase({ kind: "waiting_model" });
        }
        // The mount's state read may have found no runtime and no usage to show.
        if (sessionIdRef.current) void refreshContextUsage(sessionIdRef.current);
        break;
      }
      case "agent_start":
        cancelEventStreamGrace();
        sdkAgentActiveRef.current = true;
        agentRunningRef.current = true;
        setAgentRunning(true);
        setAgentPhase({ kind: "waiting_model" });
        // A retry's wait is over once its run starts, as pi's TUI shows it: the
        // successful auto_retry_end comes only with the retry's first complete
        // reply, which can stream for minutes.
        setRetryInfo(null);
        dispatch({ type: "start" });
        break;
      case "agent_end":
        // One logical prompt can emit multiple agent_end events before retrying,
        // compacting, or continuing messages queued by extension handlers.
        // Keep the stream open until prompt_done/agent_settled and the idle grace.
        if (!agentRunningRef.current) break;
        setAgentPhase(null);
        setRetryInfo(null);
        dispatch({ type: "end" });
        if (sessionIdRef.current) {
          const sid = sessionIdRef.current;
          loadSession(sid);
          const requestedRuntimeId = runtimeIdRef.current;
          fetch(agentStatusUrl(requestedRuntimeId ?? sid))
            .then((r) => r.json())
            .then((d: { state?: AgentStateResponse }) => {
              if (followRuntimeState(d.state, sid, requestedRuntimeId)) return;
              if (d.state?.contextUsage !== undefined) setContextUsage(d.state.contextUsage ?? null);
              if (d.state?.systemPrompt !== undefined) setSystemPrompt(d.state.systemPrompt ?? null);
              if (d.state?.extensionStatuses !== undefined) setExtensionStatuses(d.state.extensionStatuses ?? []);
              if (d.state?.extensionWidgets !== undefined) setExtensionWidgets(d.state.extensionWidgets ?? []);
              if (d.state?.subagents !== undefined) setSubagents((current) => mergeSubagentSnapshots(current, d.state?.subagents ?? []));
              if (d.state?.goal !== undefined) setGoalStatus(d.state.goal ?? null);
              // Aborted turns can leave messages queued in pi (delivered with the
              // next turn); dead wrapper (no state) means the queue is gone.
              setQueuedMessages(normalizeQueuedMessages(d.state?.queuedMessages));
            })
            .catch(() => {});
        }
        break;
      case "goal_status":
        setGoalStatus((event.status as GoalStatusInfo | null | undefined) ?? null);
        break;
      case "agent_settled": {
        const agentWasActive = sdkAgentActiveRef.current;
        sdkAgentActiveRef.current = false;
        if (!agentWasActive || rpcPromptPendingRef.current) break;

        const sid = sessionIdRef.current;
        const wasRunning = settleUiStage();
        setIsCompacting(false);
        if (sid) {
          void loadSession(sid);
          scheduleEventStreamClose(sid);
        }
        // omp's agent_settled carries no aborted flag unless the bridge adds one.
        if (wasRunning) onAgentEnd?.({ aborted: "aborted" in event && event.aborted === true, sessionId: sessionIdRef.current ?? undefined });
        break;
      }
      case "prompt_done":
        {
          const runId = promptRunIdRef.current;
          const promptWasPending = rpcPromptPendingRef.current;
          rpcPromptPendingRef.current = false;
          optimisticUserMessageKeyRef.current = null;
          const firstNotification = notifyPromptStage(runId);
          if (!promptWasPending && !firstNotification) break;

          const sid = sessionIdRef.current;
          if (sid) void loadSession(sid);
          // An extension-injected agent may already have started before the
          // command's prompt_done. Keep that active stage visible and let its
          // agent_settled event perform the next completion transition.
          if (!sdkAgentActiveRef.current) {
            settleUiStage();
            if (sid) scheduleEventStreamClose(sid);
          }
        }
        break;
      case "prompt_error":
        addNotice({ type: "error", message: (event.errorMessage as string | undefined) ?? "Command failed" });
        break;
      case "extension_error":
        addNotice({
          type: "error",
          message: (event.error as string | undefined) ?? "Extension command failed",
        });
        break;
      case "message_start":
      case "message_update": {
        // Ignore streaming events arriving after this run already finished
        // (e.g. SSE data buffered while the tab was frozen, flushed after
        // reconcile) — they would resurrect a ghost streaming bubble.
        if (!agentRunningRef.current) break;
        const msg = event.message as Partial<AgentMessage> | undefined;
        if (msg?.role === "user") {
          break;
        }
        if (msg) {
          dispatch({ type: "update", message: normalizeToolCalls(msg as AgentMessage) });
        }
        setAgentPhase(null);
        break;
      }
      case "message_end": {
        // Same late-event guard: after reconcile finished this run,
        // loadSession already loaded this message from the session file —
        // appending it again would duplicate it.
        if (!agentRunningRef.current) break;
        const completed = event.message as AgentMessage | undefined;
        if (completed && completed.role === "user") {
          // Delivered steering/follow-up messages surface here as user
          // messages. The run's initial prompt also emits one, but handleSend
          // already appended it optimistically. Consume only the still-adjacent
          // optimistic bubble; later same-text queue deliveries must render.
          const delivered = normalizeToolCalls(completed);
          const deliveredKey = userMessageKey(delivered);
          const optimisticKey = optimisticUserMessageKeyRef.current;
          optimisticUserMessageKeyRef.current = null;
          setMessages((prev) => {
            const last = prev[prev.length - 1];
            if (optimisticKey && last?.role === "user" && userMessageKey(last) === optimisticKey) {
              return optimisticKey === deliveredKey
                ? prev
                : [...prev.slice(0, -1), delivered];
            }
            return [...prev, delivered];
          });
        } else if (completed) {
          setMessages((prev) => [...prev, normalizeToolCalls(completed)]);
        }
        if (completed?.role === "assistant") {
          const sid = sessionIdRef.current;
          if (sid) void refreshContextUsage(sid);
        }
        dispatch({ type: "reset" });
        setAgentPhase({ kind: "waiting_model" });
        break;
      }
      case "tool_execution_start": {
        // A call a tool made itself (a codemode script's) belongs to its
        // parent's card; listed here it would show as a top-level running tool,
        // and a call cut off by its script can end after the parent did.
        if (isNestedToolExecutionEvent(event)) break;
        const id = event.toolCallId as string;
        const name = event.toolName as string;
        setAgentPhase((prev) => {
          const tools = prev?.kind === "running_tools" ? [...prev.tools] : [];
          if (!tools.some((t) => t.id === id)) tools.push({ id, name });
          return { kind: "running_tools", tools };
        });
        break;
      }
      case "tool_execution_update": {
        if (isNestedToolExecutionEvent(event)) break;
        const id = event.toolCallId as string;
        const name = event.toolName as string;
        const partialResult = event.partialResult as Partial<ToolResultMessage> | undefined;
        const content = partialResult?.content;
        // Live output for shells; for codemode, the calls its script has made so far.
        if ((name === "bash" || name === "powershell" || name === CODEMODE_TOOL_NAME) && Array.isArray(content)) {
          setActiveToolResults((prev) => {
            const next = new Map(prev);
            next.set(id, {
              role: "toolResult",
              toolCallId: id,
              toolName: name,
              content,
              isError: partialResult?.isError,
              details: partialResult?.details,
            });
            return next;
          });
        }
        const progress = name === CODEMODE_TOOL_NAME
          ? getCodemodeProgress(event.partialResult)
          : getToolExecutionProgress(event.partialResult);
        setAgentPhase((prev) => {
          const tools = prev?.kind === "running_tools" ? [...prev.tools] : [];
          const existing = tools.find((tool) => tool.id === id);
          const updated = {
            id,
            name: name || existing?.name || "tool",
            progress: progress ?? existing?.progress,
          };
          return {
            kind: "running_tools",
            tools: [...tools.filter((tool) => tool.id !== id), updated],
          };
        });
        break;
      }
      case "tool_execution_end": {
        if (isNestedToolExecutionEvent(event)) break;
        if (typeof event.toolName === "string") onToolEnd?.(event.toolName);
        const id = event.toolCallId as string;
        setActiveToolResults((prev) => {
          if (!prev.has(id)) return prev;
          const next = new Map(prev);
          next.delete(id);
          return next;
        });
        setAgentPhase((prev) => {
          if (prev?.kind !== "running_tools") return prev;
          const tools = prev.tools.filter((t) => t.id !== id);
          if (tools.length === 0) return { kind: "waiting_model" };
          return { kind: "running_tools", tools };
        });
        break;
      }
      case "subagent_lifecycle": {
        const payload = event.payload as {
          id?: string;
          index?: number;
          agent?: string;
          agentSource?: SubagentSnapshot["agentSource"];
          description?: string;
          status?: "started" | "completed" | "failed" | "aborted";
          sessionFile?: string;
          parentToolCallId?: string;
        } | undefined;
        if (!payload?.id) break;
        if (payload.status !== "started") {
          const terminalStatus: SubagentSnapshot["status"] = payload.status === "failed"
            ? "failed"
            : payload.status === "aborted"
              ? "aborted"
              : "completed";
          setSubagents((current) => {
            const previous = current.find((subagent) => subagent.id === payload.id);
            const finished: SubagentSnapshot = {
              id: payload.id!,
              index: payload.index ?? previous?.index ?? 0,
              agent: payload.agent ?? previous?.agent ?? payload.id!,
              agentSource: payload.agentSource ?? previous?.agentSource ?? "bundled",
              description: payload.description ?? previous?.description,
              status: terminalStatus,
              task: previous?.task,
              assignment: previous?.assignment,
              sessionFile: payload.sessionFile ?? previous?.sessionFile,
              parentToolCallId: payload.parentToolCallId ?? previous?.parentToolCallId,
              lastUpdate: Date.now(),
              progress: previous?.progress ? { ...previous.progress, status: terminalStatus } : undefined,
            };
            return mergeSubagentSnapshots(current, [finished]);
          });
          break;
        }
        const started: SubagentSnapshot = {
          id: payload.id,
          index: payload.index ?? 0,
          agent: payload.agent ?? payload.id,
          agentSource: payload.agentSource ?? "bundled",
          description: payload.description,
          status: "running",
          sessionFile: payload.sessionFile,
          parentToolCallId: payload.parentToolCallId,
          lastUpdate: Date.now(),
        };
        setSubagents((previous) => mergeSubagentSnapshots(previous, [started]));
        break;
      }
      case "subagent_progress": {
        const payload = event.payload as {
          index?: number;
          agent?: string;
          agentSource?: SubagentSnapshot["agentSource"];
          task?: string;
          assignment?: string;
          sessionFile?: string;
          parentToolCallId?: string;
          progress?: SubagentSnapshot["progress"];
        } | undefined;
        if (!payload?.progress) break;
        const progress = payload.progress;
        const snapshot: SubagentSnapshot = {
          id: progress.id,
          index: payload.index ?? progress.index,
          agent: payload.agent ?? progress.agent,
          agentSource: payload.agentSource ?? "bundled",
          description: progress.description,
          status: progress.status,
          task: payload.task ?? progress.task,
          assignment: payload.assignment ?? progress.assignment,
          sessionFile: payload.sessionFile,
          parentToolCallId: payload.parentToolCallId,
          lastUpdate: Date.now(),
          progress,
        };
        setSubagents((previous) => mergeSubagentSnapshots(previous, [snapshot]));
        break;
      }
      case "queue_update":
        setQueuedMessages({
          steering: [...((event.steering as string[] | undefined) ?? [])],
          followUp: [...((event.followUp as string[] | undefined) ?? [])],
        });
        break;
      case "auto_retry_start":
        setRetryInfo({ attempt: event.attempt as number, maxAttempts: event.maxAttempts as number, errorMessage: event.errorMessage as string | undefined });
        break;
      case "auto_retry_end":
        setRetryInfo(null);
        break;
      case "auto_compaction_start":
      case "compaction_start":
        setIsCompacting(true);
        setCompactError(null);
        setCompactResult(null);
        break;
      case "auto_compaction_end":
      case "compaction_end":
        setIsCompacting(false);
        if (event.errorMessage) {
          setCompactError(event.errorMessage as string);
          setCompactResult(null);
        } else if (!event.aborted) {
          setCompactResult(readCompactResult(event.result, (event.reason as string | undefined) ?? "auto"));
          const sid = sessionIdRef.current;
          if (sid) {
            void loadSession(sid);
            void refreshContextUsage(sid);
          }
        }
        break;
      case "extension_ui_request":
        handleExtensionUiRequest(event as ExtensionUiRequest);
        break;
      case "extension_ui_closed":
        setExtensionDialog((current) => current?.id === event.id ? null : current);
        break;
    }
  }, [addNotice, cancelEventStreamGrace, handleExtensionUiRequest, loadSession, notifyPromptStage, onAgentEnd, followSessionIdentity, followRuntimeState, refreshContextUsage, scheduleEventStreamClose, settleUiStage]);
  handleAgentEventRef.current = handleAgentEvent;

  const handleSend = useCallback(async (message: string, images?: AttachedImage[]) => {
    const trimmedMessage = message.trim();
    if (!trimmedMessage && !images?.length) return;
    if (agentRunningRef.current || bashRunningRef.current) {
      restoreSubmission(message, images, composerDraftKey);
      return;
    }
    if (editEntryId) {
      // Navigate and prompt are two RPCs: a prompt rejected after navigating
      // keeps the new leaf until the server can apply both atomically.
      const entryId = editEntryId;
      setEdit(null);
      if (!(await handleNavigateRef.current?.(entryId))) {
        setEdit(entryId);
        restoreSubmission(message, images, composerDraftKey);
        return;
      }
    }
    const isSlashCommandPrompt = !images?.length && trimmedMessage.startsWith("/");

    const isBashCommand = !images?.length && trimmedMessage.startsWith("!");
    if (isBashCommand) {
      const isExcluded = trimmedMessage.startsWith("!!");
      const bashCmd = (isExcluded ? trimmedMessage.slice(2) : trimmedMessage.slice(1)).trim();
      if (!bashCmd) {
        restoreSubmission(message, images, composerDraftKey);
        return;
      }
      await executeBashRef.current?.(bashCmd, isExcluded);
      return;
    }

    const promptRunId = promptRunIdRef.current + 1;
    cancelEventStreamGrace();
    rpcPromptPendingRef.current = true;

    const imageBlocks = images?.map((img) => ({ type: "image" as const, source: { type: "base64" as const, media_type: img.mimeType, data: img.data } }));
    const userMsg: AgentMessage = {
      role: "user",
      content: imageBlocks?.length
        ? [...(message.trim() ? [{ type: "text" as const, text: message }] : []), ...imageBlocks]
        : message,
      timestamp: Date.now(),
    };
    setMessages((prev) => [...prev, userMsg]);
    optimisticUserMessageKeyRef.current = userMessageKey(userMsg);
    promptRunIdRef.current = promptRunId;
    agentRunningRef.current = true;
    setAgentRunning(true);
    setAgentPhase(isSlashCommandPrompt ? { kind: "running_command" } : { kind: "waiting_model" });
    dispatch({ type: "start" });
    setAutoFollowRef.current(true);
    pendingScrollToUserRef.current = true;
    setPromptAnchorActive(true);

    const piImages = images?.map((img) => ({ type: "image" as const, data: img.data, mimeType: img.mimeType }));
    let sentSessionId: string | null = null;
    let promptRequestStarted = false;

    try {
      if (isNew && newSessionCwd) {
        const selectedModel = newSessionModel;
        const existingSid = sessionIdRef.current ?? await ensuringNewSessionRef.current;
        const sid = existingSid ?? await ensureNewSession();

        if (!sid) throw new Error("Unable to create a session for the prompt");
        sentSessionId = sid;
        if (selectedModel) {
          setPendingModel(selectedModel);
          if (existingSid) {
            await sendAgentCommand(sid, { type: "set_model", provider: selectedModel.provider, modelId: selectedModel.modelId }, runtimeIdRef);
          }
        }
        // Switching sessions unmounts this composer and closes its stream. The
        // prompt still goes out, so the new session runs and gets its sidebar
        // row instead of losing the submitted text (#1146).
        if (sessionHookMountedRef.current) {
          await ensureEventsConnected(sid).catch((error) => {
            if (sessionHookMountedRef.current) throw error;
          });
        }
        promptRequestStarted = true;
        await sendAgentCommand(sid, {
          type: "prompt",
          message,
          ...(piImages?.length ? { images: piImages } : {}),
        }, runtimeIdRef);
        promoteNewSession(1, message);
      } else if (session) {
        sentSessionId = session.id;
        await ensureEventsConnected(sessionIdRef.current ?? session.id);
        promptRequestStarted = true;
        await sendAgentCommand(sentSessionId, {
          type: "prompt",
          message,
          ...(piImages?.length ? { images: piImages } : {}),
        }, runtimeIdRef);
      } else {
        throw new Error("No active session for the prompt");
      }
      if (isSlashCommandPrompt && sentSessionId) {
        void waitForPromptSettlement(sentSessionId, promptRunId);
      }
    } catch (e) {
      console.error("Failed to send message:", e);
      const definitivelyRejected = !promptRequestStarted || isPromptRejectedError(e);
      // A transport/proxy failure after dispatch is ambiguous: the server may
      // have accepted the prompt before the response was lost. Keep SSE alive
      // until server state confirms the run is idle.
      if (!definitivelyRejected && sentSessionId) {
        void waitForPromptSettlement(sentSessionId, promptRunId);
        return;
      }
      rpcPromptPendingRef.current = false;
      const optimisticKey = optimisticUserMessageKeyRef.current;
      if (optimisticKey) {
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          return last?.role === "user" && userMessageKey(last) === optimisticKey
            ? prev.slice(0, -1)
            : prev;
        });
      }
      addNotice({ type: "error", message: e instanceof Error ? e.message : String(e) });
      // The prompt never reached the agent, so restore the user's text (and
      // any attached images) into the input instead of losing it. Mirrors the
      // shell-command recovery in executeBash; restoreSubmission avoids
      // clobbering anything typed since.
      restoreSubmission(message, images, sessionIdRef.current ?? sentSessionId ?? session?.id ?? undefined);
      optimisticUserMessageKeyRef.current = null;
      // Rejection only describes this submission. Another tab or an event we
      // missed may still have a real run active for the same session, so keep
      // its SSE connection until server state says the wrapper is idle.
      if (sentSessionId) {
        void reconcileAgentState(sentSessionId);
        return;
      }
      agentRunningRef.current = false;
      closeEvents();
      setAgentRunning(false);
      setAgentPhase(null);
      dispatch({ type: "end" });
    }
  }, [isNew, newSessionCwd, newSessionModel, session, ensureNewSession, ensureEventsConnected, promoteNewSession, waitForPromptSettlement, addNotice, cancelEventStreamGrace, closeEvents, composerDraftKey, reconcileAgentState, dispatch, restoreSubmission, editEntryId, setEdit]);

  const executeBash = useCallback(async (command: string, excludeFromContext: boolean) => {
    if (agentRunningRef.current || bashRunningRef.current) return;
    const inputText = `${excludeFromContext ? "!!" : "!"}${command}`;
    bashRunningRef.current = true;
    setAutoFollowRef.current(true);
    setPendingBash({ command, excludeFromContext });
    setBashRunning(true);
    try {
      const sid = sessionIdRef.current ?? session?.id ?? await ensureNewSession();
      if (!sid) throw new Error("Unable to create a session for the shell command");
      await sendAgentCommand(sid, {
        type: "bash",
        command,
        excludeFromContext,
      }, runtimeIdRef);
      await loadSession(sid);
      promoteNewSession(1, inputText);
    } catch (e) {
      console.error("Failed to execute shell command:", e);
      addNotice({ type: "error", message: e instanceof Error ? e.message : String(e) });
      // The command never ran: give the text back instead of losing it.
      restoreSubmission(inputText, undefined, sessionIdRef.current ?? session?.id ?? composerDraftKey);
    } finally {
      bashRunningRef.current = false;
      setPendingBash(null);
      setBashRunning(false);
    }
  }, [addNotice, composerDraftKey, ensureNewSession, loadSession, promoteNewSession, restoreSubmission, session]);
  executeBashRef.current = executeBash;

  const handleAbort = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    if (bashRunningRef.current) {
      try {
        await sendAgentCommand(sid, { type: "abort_bash" }, runtimeIdRef);
      } catch (e) {
        console.error("Failed to abort bash:", e);
      }
      return;
    }
    try {
      await sendAgentCommand(sid, { type: "abort" }, runtimeIdRef);
    } catch (e) {
      console.error("Failed to abort:", e);
    }
  }, []);

  /**
   * Fork a new session from an explicit transcript entry, or from the latest
   * persisted user entry when invoked through `/fork`.
   */
  const handleFork = useCallback(async (
    entryId?: string,
  ): Promise<{ forked: boolean; error?: string }> => {
    if (bashRunningRef.current) return { forked: false, error: "Cannot fork while a shell command is running" };
    const sid = sessionIdRef.current;
    if (!sid) return { forked: false, error: "No active session to fork" };
    setForkingEntryId(entryId ?? null);
    try {
      const result = await sendAgentCommand<{ cancelled?: boolean; newSessionId?: string }>(sid, {
        type: "fork",
        ...(entryId ? { entryId } : {}),
      }, runtimeIdRef);
      const { cancelled, newSessionId } = result ?? {};
      if (!cancelled && newSessionId) {
        if (mountedRef.current) onSessionForked?.(newSessionId);
        return { forked: true };
      }
      return { forked: false, error: "Fork was cancelled" };
    } catch (e) {
      console.error("Fork failed:", e);
      return { forked: false, error: e instanceof Error ? e.message : String(e) };
    } finally {
      setForkingEntryId(null);
    }
  }, [onSessionForked]);

  const handleNavigate = useCallback(async (entryId: string) => {
    if (bashRunningRef.current) return;
    const sid = sessionIdRef.current;
    if (!sid) return;
    sendAgentCommand(sid, { type: "navigate_tree", targetId: entryId }, runtimeIdRef).catch(() => {});
    setActiveLeafId(entryId);
    await loadContext(sid, entryId);
  }, [loadContext]);

  // handleSend replays a pending history edit through this ref so its own
  // identity does not churn with every branch change.
  handleNavigateRef.current = async (leafId: string) => {
    try {
      await handleNavigate(leafId);
      return true;
    } catch {
      return false;
    }
  };

  const handleLeafChange = useCallback(async (leafId: string | null) => {
    if (bashRunningRef.current) return;
    setActiveLeafId(leafId);
    const sid = sessionIdRef.current;
    if (!sid) return;
    if (!await loadContext(sid, leafId)) return;
    if (leafId && mountedRef.current && sessionIdRef.current) {
      sendAgentCommand(sessionIdRef.current, { type: "navigate_tree", targetId: leafId }, runtimeIdRef).catch(() => {});
    }
  }, [loadContext]);

  const handleModelChange = useCallback(async (provider: string, modelId: string) => {
    if (isNew) {
      const selectedModel = { provider, modelId };
      newSessionModelOverrideRef.current = selectedModel;
      setNewSessionModel(selectedModel);
      setPendingModel(selectedModel);
      const sid = sessionIdRef.current ?? await ensuringNewSessionRef.current;
      if (!sid) return;
      try {
        await sendAgentCommand(sid, { type: "set_model", provider, modelId }, runtimeIdRef);
      } catch (e) {
        console.error("Failed to set model:", e);
      }
      return;
    }
    const sid = sessionIdRef.current;
    if (!sid || modelSwitchPendingRef.current) return;
    const target = { provider, modelId };
    const previousOverride = currentModelOverride;
    modelSwitchPendingRef.current = true;
    setCurrentModelOverride(target);
    setModelSwitching(true);
    try {
      await sendAgentCommand(sid, { type: "set_model", provider, modelId }, runtimeIdRef);
      // Pi persists model_change synchronously. Reload the canonical session so
      // the model, thinking level, and active leaf all advance together.
      modelSwitchPendingRef.current = false;
      await loadSession(sid);
    } catch (e) {
      console.error("Failed to set model:", e);
      modelSwitchPendingRef.current = false;
      setCurrentModelOverride(previousOverride);
      addNotice({
        type: "error",
        message: `Failed to switch model: ${e instanceof Error ? e.message : String(e)}`,
      });
      // A failed response can still follow a server-side write (for example, a
      // dropped connection), so let the session file settle the displayed model.
      await loadSession(sid);
    } finally {
      modelSwitchPendingRef.current = false;
      setModelSwitching(false);
    }
  }, [addNotice, currentModelOverride, isNew, loadSession, setNewSessionModel]);

  /**
   * Switch the session onto the model configured for one of omp's roles.
   *
   * The role is sent along, not just the model, so the transcript records which
   * role drove the change — the same thing `/model` does in the TUI, and what
   * lets omp resolve retry fallbacks for that role later.
   */
  const handleRoleModelChange = useCallback(async (role: string) => {
    const assignment = modelRoles.find((candidate) => candidate.role === role);
    const resolved = assignment?.resolved;
    if (!resolved) return;

    if (isNew) {
      const selectedModel = { provider: resolved.provider, modelId: resolved.modelId };
      const selectedThinkingLevel = resolved.thinkingLevel as ThinkingLevelOption | undefined;
      // A role selector can pin a level (`provider/model:high`). Preserve that
      // pin for deferred creation so the initial AgentSession receives it.
      thinkingLevelOverrideRef.current = selectedThinkingLevel ?? null;
      setThinkingLevel(selectedThinkingLevel ?? "auto");
      setEffectiveThinkingLevel(undefined);
      newSessionModelOverrideRef.current = selectedModel;
      setNewSessionModel(selectedModel);
      setPendingModel(selectedModel);
    }
    const sid = sessionIdRef.current ?? (isNew ? await ensuringNewSessionRef.current : null);
    if (!sid) return;
    try {
      await sendAgentCommand(sid, { type: "set_role_model", role }, runtimeIdRef);
      if (!isNew) setCurrentModelOverride({ provider: resolved.provider, modelId: resolved.modelId });
    } catch (e) {
      console.error("Failed to set role model:", e);
    }
  }, [isNew, modelRoles, setNewSessionModel]);

  const handleCompact = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (!sid || isCompacting) return;
    setIsCompacting(true);
    setCompactError(null);
    setCompactResult(null);
    try {
      const result = await sendAgentCommand<CompactCommandResult>(sid, { type: "compact" }, runtimeIdRef);
      setCompactResult(readCompactResult(result, "manual"));
      await loadSession(sid, true);
    } catch (e) {
      setCompactError(e instanceof Error ? e.message : String(e));
      setCompactResult(null);
    } finally {
      setIsCompacting(false);
    }
  }, [isCompacting, loadSession]);

  const loadModels = useCallback(async (signal?: AbortSignal) => {
    const modelCwd = newSessionCwd ?? session?.cwd ?? "";
    const modelsUrl = modelCwd ? `/api/models?cwd=${encodeURIComponent(modelCwd)}` : "/api/models";
    let d: ModelsResponse;
    try {
      const res = await fetch(modelsUrl, signal ? { signal } : undefined);
      if (!res.ok) {
        let detail = "";
        try {
          const body: unknown = await res.json();
          if (body && typeof body === "object" && "error" in body && typeof body.error === "string") {
            detail = body.error;
          }
        } catch (e) {
          if (e instanceof DOMException && e.name === "AbortError") throw e;
          // Non-JSON error responses fall back to the HTTP status.
        }
        throw new Error(detail || `Failed to load models (HTTP ${res.status})`);
      }
      d = await res.json() as ModelsResponse;
      signal?.throwIfAborted();
    } catch (e) {
      if (!signal?.aborted && !(e instanceof DOMException && e.name === "AbortError")) {
        setModelError(e instanceof Error ? e.message : String(e));
      }
      throw e;
    }
    setModelNames(d.models);
    setModelError(d.modelError ?? null);
    setModelScopeWarnings(d.modelScopeWarnings ?? []);
    setModelThinkingLevels(d.thinkingLevels ?? {});
    setModelThinkingLevelMaps(d.thinkingLevelMaps ?? {});
    setModelRoles(d.roles ?? []);
    const nextModelList = d.modelList ?? [];
    setModelList(nextModelList);
    const displayDefaultModel = d.defaultModel
      ? nextModelList.find((m) => m.id === d.defaultModel?.modelId && m.provider === d.defaultModel?.provider)
      : undefined;
    setNewSessionDefaultModel(displayDefaultModel
      ? { provider: displayDefaultModel.provider, modelId: displayDefaultModel.id }
      : null);
    thinkingLevelPinsRef.current = d.thinkingLevelPins ?? {};
    defaultThinkingLevelRef.current = asConcreteThinkingLevel(d.defaultThinkingLevel);
    setSavedDefaultThinkingLevel(asConcreteThinkingLevel(d.savedDefaultThinkingLevel));
    if (isNew && !sessionIdRef.current) {
      // A picked model this folder does not offer (one carried over from the
      // composer this one replaced, or since scoped out) goes back to automatic.
      // An empty list offers nothing to compare with (a failed load answers
      // with one): the pick stays.
      const picked = newSessionModelOverrideRef.current;
      const kept = picked && (nextModelList.length === 0
        || nextModelList.some((m) => m.provider === picked.provider && m.id === picked.modelId));
      if (picked && !kept) {
        newSessionModelOverrideRef.current = null;
        setNewSessionModel(null);
      }
      // The first listed model is not necessarily the runtime's automatic choice.
      // An `enabledModels` pattern may pin a thinking level (`anthropic/*:high`).
      // Like pi, apply it to the model a new session starts with.
      const startModel = kept ? picked : displayDefaultModel && { provider: displayDefaultModel.provider, modelId: displayDefaultModel.id };
      const pinned = startModel && d.thinkingLevelPins?.[`${startModel.provider}/${startModel.modelId}`];
      if (thinkingLevelOverrideRef.current === null) {
        setNewSessionDefaultThinkingLevel(
          asConcreteThinkingLevel(pinned) ?? defaultThinkingLevelRef.current,
        );
        // A fresh composer mirrors the selector for a brand-new session: the
        // pin (or the resolved settings default) is what the first prompt
        // would actually run with.
        setThinkingLevel((pinned ? asConcreteThinkingLevel(pinned) : null)
          ?? defaultThinkingLevelRef.current ?? "auto");
      }
    }
  }, [isNew, newSessionCwd, session?.cwd]);

  const handleBuiltinSlashCommand = useCallback(async (text: string): Promise<BuiltinSlashCommandResult> => {
    if (!text.startsWith("/")) return { handled: false };
    const match = text.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/);
    if (!match) return { handled: false };

    const [, commandName, rawArgs = ""] = match;
    const args = rawArgs.trim();
    const sid = sessionIdRef.current ?? await ensureNewSession();
    const complete = (result: BuiltinSlashCommandResult): BuiltinSlashCommandResult => {
      if (!result.handled) return result;
      if (result.error) {
        addNotice({ type: "error", message: result.error });
      } else if (result.action !== "openSessionStats" && result.action !== "openSettings") {
        addNotice({ type: "success", message: result.message ?? "Command completed" });
      }
      return result;
    };

    try {
      switch (commandName) {
        case "compact": {
          if (!sid || isCompacting) return complete({ handled: true, error: "No active session to compact" });
          setIsCompacting(true);
          setCompactError(null);
          setCompactResult(null);
          const result = await sendAgentCommand<CompactCommandResult>(sid, {
            type: "compact",
            ...(args ? { customInstructions: args } : {}),
          }, runtimeIdRef);
          setCompactResult(readCompactResult(result, "manual"));
          if (await loadSession(sid, true)) promoteNewSession();
          return complete({ handled: true, message: "Compacted context" });
        }

        case "reload": {
          if (!sid) return complete({ handled: true, error: "No active session to reload" });
          await sendAgentCommand(sid, { type: "reload" }, runtimeIdRef);
          await Promise.all([
            loadSession(sid, false, true),
            loadTools(sid),
            loadSlashCommands(),
            loadModels(),
          ]);
          return complete({ handled: true, message: "Reloaded session resources" });
        }

        case "name": {
          if (!sid) return complete({ handled: true, error: "No active session to name" });
          if (!args) return complete({ handled: true, error: "Usage: /name <name>" });
          await sendAgentCommand(sid, { type: "set_session_name", name: args }, runtimeIdRef);
          if (await loadSession(sid)) promoteNewSession();
          return complete({ handled: true, message: `Session renamed to ${args}` });
        }

        case "session": {
          if (!sid) return complete({ handled: true, error: "No active session" });
          const stats = await sendAgentCommand<SessionStatsInfo>(sid, { type: "get_session_stats" }, runtimeIdRef);
          if (stats) {
            setSessionStatsOverride(stats);
          }
          if (!mountedRef.current) return { handled: true };
          onSessionStatsPanelOpen?.();
          return complete({ handled: true, action: "openSessionStats" });
        }

        case "mcp": {
          // Only a bare /mcp, and only when the built-in MCP extension owns it or
          // nothing does (lib/mcp-command.ts): another extension's /mcp is sent as
          // before, and so is every subcommand, since `/mcp login`, `logout` and
          // `reconnect` act on this session's own connections. Returning before
          // onSend leaves no "/mcp" bubble and no sidebar row for a new chat; a
          // streaming run is not touched.
          if (args || !onOpenSettings) return { handled: false };
          const commands = await slashCommandsForMcp();
          if (!commands || !bareMcpOpensSettings(commands)) return { handled: false };
          onOpenSettings("mcp");
          return complete({ handled: true, action: "openSettings" });
        }

        case "copy": {
          if (!sid) return complete({ handled: true, error: "No active session" });
          const data = await sendAgentCommand<LastAssistantTextResponse>(sid, { type: "get_last_assistant_text" }, runtimeIdRef);
          const textToCopy = data?.text ?? "";
          if (!textToCopy) return complete({ handled: true, error: "No assistant message to copy" });
          await navigator.clipboard.writeText(textToCopy);
          return complete({ handled: true, message: "Copied last assistant message" });
        }

        case "fork": {
          if (!sid) return complete({ handled: true, error: "No active session to fork" });
          const result = await handleFork();
          if (!result.forked) {
            return complete({ handled: true, error: result.error ?? "Fork failed" });
          }
          return complete({ handled: true, message: "Forked a new session" });
        }

        case "goal": {
          if (!sid) return complete({ handled: true, error: "No active session" });
          const result = await sendAgentCommand<GoalCommandResponse>(sid, { type: "goal", args }, runtimeIdRef);
          setGoalStatus(result?.status ?? null);
          if (result?.error) return complete({ handled: true, error: result.error });
          // `/goal show` output belongs in the transcript, not a toast that
          // disappears before it can be read.
          if (result?.message && result.message.includes("\n")) {
            appendCommandOutput(result.message);
            if (result.prompt) return { handled: true, prompt: result.prompt };
            return { handled: true };
          }
          if (result?.prompt) {
            if (result.message) addNotice({ type: "success", message: result.message });
            return { handled: true, prompt: result.prompt };
          }
          return complete({ handled: true, message: result?.message ?? "Command completed" });
        }

        case "handoff": {
          if (!sid) return complete({ handled: true, error: "No active session" });
          if (agentRunningRef.current || bashRunningRef.current) {
            return complete({ handled: true, error: "Cannot hand off while the session is busy" });
          }
          // Handoff generation is a long oneshot LLM call; keep the composer
          // busy through it with the existing agent-running state so a prompt
          // cannot race the compaction entry it commits.
          agentRunningRef.current = true;
          setAgentRunning(true);
          setAgentPhase({ kind: "running_command" });
          try {
            await ensureEventsConnected(sessionIdRef.current ?? sid);
            const currentSid = sessionIdRef.current ?? sid;
            const result = await sendAgentCommand<{ cancelled?: boolean }>(currentSid, {
              type: "handoff",
              ...(args ? { customInstructions: args } : {}),
            }, runtimeIdRef);
            if (!result || result.cancelled) {
              return complete({ handled: true, error: "Handoff cancelled" });
            }
            // omp 18 hands off in place, so the session keeps its id and gains
            // a handoff compaction entry: reload this transcript rather than
            // navigating to a replacement session.
            if (mountedRef.current && await loadSession(sessionIdRef.current ?? currentSid, true)) promoteNewSession();
            return complete({ handled: true, message: "Context handed off and compacted in place" });
          } finally {
            if (mountedRef.current) {
              agentRunningRef.current = false;
              setAgentRunning(false);
              setAgentPhase(null);
              const finalSid = sessionIdRef.current;
              if (finalSid) scheduleEventStreamClose(finalSid);
            }
          }
        }

        default: {
          if (!sid) return complete({ handled: true, error: "No active session" });
          const result = await sendAgentCommand<{
            handled: boolean;
            output?: string[];
            prompt?: string;
          }>(sid, {
            type: "execute_slash_command",
            message: text,
          }, runtimeIdRef);
          if (!result?.handled) return { handled: false };
          const output = result.output?.filter((line) => line.trim()).join("\n\n") ?? "";
          if (output) appendCommandOutput(output);
          if (result.prompt) return { handled: true, prompt: result.prompt };
          if (output) return { handled: true };
          return complete({ handled: true, message: "Command completed" });
        }
      }
    } catch (e) {
      return complete({ handled: true, error: e instanceof Error ? e.message : String(e) });
    } finally {
      if (commandName === "compact") setIsCompacting(false);
    }
  }, [addNotice, appendCommandOutput, ensureEventsConnected, ensureNewSession, handleFork, isCompacting, loadModels, loadSession, loadSlashCommands, loadTools, onOpenSettings, onSessionStatsPanelOpen, promoteNewSession, scheduleEventStreamClose, slashCommandsForMcp]);

  // Queued (undelivered) messages live in the queue panel only; the chat gets
  // the real user message when pi delivers it (user message_end event). An
  // optimistic chat bubble here would duplicate the queue panel and turn into
  // a ghost message if the queue is recalled.
  const handleSteer = useCallback(async (message: string, images?: AttachedImage[]) => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    const piImages = images?.map((img) => ({ type: "image" as const, data: img.data, mimeType: img.mimeType }));
    try {
      await sendAgentCommand(sid, {
        type: "steer",
        message,
        ...(piImages?.length ? { images: piImages } : {}),
      }, runtimeIdRef);
    } catch (e) {
      console.error("Failed to steer:", e);
    }
  }, []);

  const handlePromptWithStreamingBehavior = useCallback(async (
    message: string,
    behavior: "steer" | "followUp",
    images?: AttachedImage[],
  ) => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    const piImages = images?.map((img) => ({ type: "image" as const, data: img.data, mimeType: img.mimeType }));
    try {
      await sendAgentCommand(sid, {
        type: "prompt",
        message,
        streamingBehavior: behavior,
        ...(piImages?.length ? { images: piImages } : {}),
      }, runtimeIdRef);
    } catch (e) {
      console.error("Failed to queue prompt:", e);
    }
  }, []);

  const handleFollowUp = useCallback(async (message: string, images?: AttachedImage[]) => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    const piImages = images?.map((img) => ({ type: "image" as const, data: img.data, mimeType: img.mimeType }));
    try {
      await sendAgentCommand(sid, {
        type: "follow_up",
        message,
        ...(piImages?.length ? { images: piImages } : {}),
      }, runtimeIdRef);
    } catch (e) {
      console.error("Failed to follow up:", e);
    }
  }, []);

  const handleAbortCompaction = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    try {
      await sendAgentCommand(sid, { type: "abort_compaction" }, runtimeIdRef);
    } catch (e) {
      console.error("Failed to abort compaction:", e);
    }
  }, []);

  const handleRecallQueue = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    try {
      const result = await sendAgentCommand<{ steering?: string[]; followUp?: string[] }>(sid, { type: "clear_queue" }, runtimeIdRef);
      // clearQueue also emits an empty queue_update, but that only reaches us
      // while SSE is connected — clear locally so idle recalls update the UI.
      setQueuedMessages({ steering: [], followUp: [] });
      const texts = [...(result?.steering ?? []), ...(result?.followUp ?? [])];
      if (mountedRef.current && texts.length > 0) {
        opts.chatInputRef?.current?.prependText(texts.join("\n\n"));
      }
    } catch (e) {
      console.error("Failed to recall queued messages:", e);
      addNotice({ type: "error", message: "Failed to recall queued messages" });
    }
  }, [opts.chatInputRef, addNotice]);

  const handleThinkingLevelChange = useCallback(async (level: ThinkingLevelOption) => {
    setThinkingLevel(level);
    if (isNew && !sessionIdRef.current) {
      thinkingLevelOverrideRef.current = level;
    }
    setEffectiveThinkingLevel(undefined);
    const sid = sessionIdRef.current ?? await ensuringNewSessionRef.current;
    if (!sid) return;
    try {
      await sendAgentCommand(sid, { type: "set_thinking_level", level }, runtimeIdRef);
      await loadSession(sid);
    } catch (e) {
      console.error("Failed to set thinking level:", e);
      addNotice({ type: "error", message: "Failed to set thinking level" });
      await loadSession(sid);
    }
  }, [isNew, loadSession, addNotice]);

  // The selectors' star is the explicit Ctrl+S equivalent: it saves the global
  // default new sessions start with and also selects it for this chat. This
  // server stores defaults as model roles, so the star writes the `default`
  // role selector `provider/modelId[:level]` — the `:level` suffix is exactly
  // the starred reasoning level.
  const saveDefaultPreferences = useCallback(async (
    edit: { provider: string; modelId: string } | { thinkingLevel: ConcreteThinkingLevel },
  ) => {
    const cwd = newSessionCwd ?? session?.cwd;
    const model = newSessionDefaultModel ?? displayModel;
    let selector: string;
    if ("provider" in edit) {
      selector = `${edit.provider}/${edit.modelId}${savedDefaultThinkingLevel ? `:${savedDefaultThinkingLevel}` : ""}`;
    } else if (model) {
      selector = `${model.provider}/${model.modelId}:${edit.thinkingLevel}`;
    } else {
      throw new Error("Pick a default model before starring a reasoning level");
    }
    const res = await fetch("/api/model-roles", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...(cwd ? { cwd } : {}), role: "default", selector, scope: "global" }),
    });
    if (res.ok) return;
    let detail = "";
    try {
      const body: unknown = await res.json();
      if (body && typeof body === "object" && "error" in body && typeof body.error === "string") detail = body.error;
    } catch {
      // Non-JSON error responses fall back to the HTTP status.
    }
    throw new Error(detail || `HTTP ${res.status}`);
  }, [displayModel, newSessionCwd, newSessionDefaultModel, savedDefaultThinkingLevel, session?.cwd]);

  const reloadModelsQuietly = useCallback(() => {
    // The star already updated the marker; a failed refresh keeps the old list.
    loadModels().catch(() => {});
  }, [loadModels]);

  const handleSetDefaultModel = useCallback(async (provider: string, modelId: string) => {
    try {
      await saveDefaultPreferences({ provider, modelId });
    } catch (e) {
      addNotice({ type: "error", message: `Failed to save default model: ${e instanceof Error ? e.message : String(e)}` });
      return;
    }
    addNotice({ type: "success", message: `Default model: ${provider}/${modelId}` });
    setNewSessionDefaultModel({ provider, modelId });
    if (displayModel?.provider !== provider || displayModel?.modelId !== modelId) {
      await handleModelChange(provider, modelId);
    }
    reloadModelsQuietly();
  }, [addNotice, displayModel, handleModelChange, reloadModelsQuietly, saveDefaultPreferences]);

  const handleSetDefaultThinkingLevel = useCallback(async (level: ConcreteThinkingLevel) => {
    try {
      await saveDefaultPreferences({ thinkingLevel: level });
    } catch (e) {
      addNotice({ type: "error", message: `Failed to save default reasoning level: ${e instanceof Error ? e.message : String(e)}` });
      return;
    }
    addNotice({ type: "success", message: `Default reasoning level: ${level}` });
    setSavedDefaultThinkingLevel(level);
    if (thinkingLevel !== level) await handleThinkingLevelChange(level);
    reloadModelsQuietly();
  }, [addNotice, handleThinkingLevelChange, reloadModelsQuietly, saveDefaultPreferences, thinkingLevel]);

  const dismissCompactError = useCallback(() => setCompactError(null), []);

  const handleToolPresetChange = useCallback(async (preset: ToolPreset) => {
    const toolNames = getToolNamesForPreset(preset);
    setToolPresetState(preset);
    const sid = sessionIdRef.current ?? await ensuringNewSessionRef.current;
    if (!sid) return;
    try {
      await sendAgentCommand(sid, { type: "set_tools", toolNames }, runtimeIdRef);
    } catch (e) {
      console.error("Failed to set tools:", e);
    }
  }, [setToolPresetState]);

  // Single writer for the follow flag so the ref (read by the scroll effects)
  // and the state (read by the jump-to-bottom button) never drift apart.
  const setAutoFollow = useCallback((following: boolean) => {
    completionScrollAllowedRef.current = following;
    setAutoFollowPaused((paused) => (paused === !following ? paused : !following));
  }, []);
  setAutoFollowRef.current = setAutoFollow;

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "smooth") => {
    ignoreProgrammaticScrollUntilRef.current = Date.now() + PROGRAMMATIC_SCROLL_IGNORE_MS;
    messagesEndRef.current?.scrollIntoView({ behavior });
  }, []);

  // Jump to a search hit or branch row: the clicked message becomes the top
  // of the viewport, and follow stays paused until the user resumes it.
  const scrollToMessage = useCallback((element: HTMLElement, viewportOffset = 16) => {
    const container = scrollContainerRef.current;
    if (!container) return;
    initialScrollDoneRef.current = true;
    pendingScrollToUserRef.current = false;
    setPromptAnchorActive(false);
    setAutoFollowRef.current(false);
    ignoreProgrammaticScrollUntilRef.current = Date.now() + PROGRAMMATIC_SCROLL_IGNORE_MS;
    container.scrollTo({
      top: element.getBoundingClientRect().top
        - container.getBoundingClientRect().top
        + container.scrollTop
        - viewportOffset,
      behavior: "instant",
    });
  }, []);

  // A freshly sent prompt opens at the top of the viewport instead of the
  // usual bottom-anchored follow.
  const scrollUserMsgToTop = useCallback(() => {
    const container = scrollContainerRef.current;
    const el = lastUserMsgRef.current;
    if (!container || !el) return;
    const elAbsTop = el.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop;
    const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
    const targetTop = Math.min(Math.max(0, elAbsTop - 16), maxScrollTop);
    ignoreProgrammaticScrollUntilRef.current = Date.now() + PROGRAMMATIC_SCROLL_IGNORE_MS;
    container.scrollTo({ top: targetTop, behavior: "auto" });
  }, []);

  const resumeAutoFollow = useCallback(() => {
    // Clear any lingering intent window so the smooth scroll we are about to
    // start is not mistaken for the user scrolling away again.
    userScrollIntentUntilRef.current = 0;
    setAutoFollow(true);
    scrollToBottom("smooth");
  }, [scrollToBottom, setAutoFollow]);

  const markUserScrollIntent = useCallback((event: Event) => {
    if (event instanceof KeyboardEvent) {
      if (!SCROLL_KEYS.has(event.key)) return;
      if (event.target instanceof Element && event.target.closest("input, textarea, [contenteditable='true']")) return;
    }
    userScrollIntentUntilRef.current = Date.now() + USER_SCROLL_INTENT_MS;
  }, []);

  const handleScrollPositionChange = useCallback(() => {
    const watched = scrollContainerRef.current;
    if (watched) {
      const { scrollTop, clientHeight, scrollHeight } = watched;
      const shouldShow = shouldShowScrollToLatest(scrollTop, clientHeight, scrollHeight);
      setShowScrollToBottom((previous) => (previous === shouldShow ? previous : shouldShow));
    }
    if (!agentRunningRef.current && !bashRunningRef.current) return;
    const container = watched;
    if (!container) return;
    // The auto-follow effect refreshes the programmatic-scroll window on every
    // streaming chunk, so during a stream it is always open. Honour a scroll
    // the user actually drove (wheel/touch/pointer/keys) regardless of it,
    // otherwise following could never be paused mid-turn.
    const userDriven = Date.now() <= userScrollIntentUntilRef.current;
    if (!userDriven && Date.now() < ignoreProgrammaticScrollUntilRef.current) return;
    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    if (distanceFromBottom <= AUTO_FOLLOW_BOTTOM_THRESHOLD_PX) {
      setAutoFollow(true);
      return;
    }
    if (userDriven) {
      setAutoFollow(false);
    }
  }, [setAutoFollow]);

  const displayedSessionIdRef = useRef(session?.id);
  useEffect(() => {
    if (session?.id && session.id !== displayedSessionIdRef.current) {
      displayedSessionIdRef.current = session.id;
      void loadSession(session.id);
    }
  }, [session?.id, loadSession]);

  // Load session on mount
  useEffect(() => {
    if (session) {
      sessionIdRef.current = session.id;
      loadSession(session.id, true, true).then((agentState) => {
        const sid = sessionIdRef.current;
        if (!mountedRef.current || !sid) return;
        if (agentState?.running) {
          loadTools(sid);
          if (
            agentState.state?.isStreaming
            || agentState.state?.isPromptRunning
            || agentState.state?.isHandoffRunning
          ) {
            sdkAgentActiveRef.current = Boolean(agentState.state.isStreaming);
            rpcPromptPendingRef.current = Boolean(agentState.state.isPromptRunning);
            agentRunningRef.current = true;
            setAgentRunning(true);
            setAgentPhase(agentState.state.isStreaming ? { kind: "waiting_model" } : { kind: "running_command" });
            dispatch({ type: "start" });
            void connectEvents(sid);
            if (!agentState.state.isStreaming && agentState.state.isPromptRunning) {
              void waitForPromptSettlement(sid);
            }
          }
          if (agentState.state?.isBashRunning) {
            bashRunningRef.current = true;
            setBashRunning(true);
            void waitForBashSettlement(sid);
          }
          if ((agentState.state?.subagents?.length ?? 0) > 0) {
            void connectEvents(sid);
          }
        }
        const state = agentState?.state;
        if (state) {
          if (state.isCompacting !== undefined) setIsCompacting(state.isCompacting);
          if (state.contextUsage !== undefined) setContextUsage(state.contextUsage ?? null);
          if (state.systemPrompt !== undefined) setSystemPrompt(state.systemPrompt ?? null);
          if (state.thinkingLevel !== undefined) {
            setThinkingLevel((state.configuredThinkingLevel ?? state.thinkingLevel) as ThinkingLevelOption);
            setEffectiveThinkingLevel(state.thinkingLevel);
          }
          if (state.extensionStatuses !== undefined) setExtensionStatuses(state.extensionStatuses ?? []);
          if (state.extensionWidgets !== undefined) setExtensionWidgets(state.extensionWidgets ?? []);
          if (state.queuedMessages !== undefined) setQueuedMessages(normalizeQueuedMessages(state.queuedMessages));
          if (state.subagents !== undefined) setSubagents((current) => mergeSubagentSnapshots(current, state.subagents ?? []));
          if (state.goal !== undefined) setGoalStatus(state.goal ?? null);
        }
      });
    }
    return () => {
      bashRecoveryIdRef.current += 1;
      cancelEventStreamGrace();
      closeEvents();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    onSystemPromptChange?.(systemPrompt);
  }, [systemPrompt, onSystemPromptChange]);

  useEffect(() => {
    onSystemInfoLoaderChange?.(loadSystemInfo);
    return () => onSystemInfoLoaderChange?.(null);
  }, [loadSystemInfo, onSystemInfoLoaderChange]);

  const branchSwitchLocked = agentRunning || bashRunning || isCompacting;
  useEffect(() => {
    if (!onBranchDataChange) return;
    onBranchDataChange(data?.tree ?? [], activeLeafId, handleLeafChange, branchSwitchLocked);
  }, [data?.tree, activeLeafId, handleLeafChange, branchSwitchLocked, onBranchDataChange]);

  useEffect(() => {
    window.addEventListener("keydown", markUserScrollIntent);
    return () => {
      window.removeEventListener("keydown", markUserScrollIntent);
    };
  }, [markUserScrollIntent]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    container.addEventListener("pointerdown", markUserScrollIntent, { passive: true });
    container.addEventListener("wheel", markUserScrollIntent, { passive: true });
    container.addEventListener("touchstart", markUserScrollIntent, { passive: true });
    container.addEventListener("scroll", handleScrollPositionChange, { passive: true });
    return () => {
      container.removeEventListener("pointerdown", markUserScrollIntent);
      container.removeEventListener("wheel", markUserScrollIntent);
      container.removeEventListener("touchstart", markUserScrollIntent);
      container.removeEventListener("scroll", handleScrollPositionChange);
    };
  }, [messages.length, loading, handleScrollPositionChange, markUserScrollIntent]);

  useEffect(() => {
    if ((!agentRunning && !bashRunning) || !completionScrollAllowedRef.current) return;
    const container = scrollContainerRef.current;
    if (!container) return;
    const frame = requestAnimationFrame(() => {
      ignoreProgrammaticScrollUntilRef.current = Date.now() + PROGRAMMATIC_SCROLL_IGNORE_MS;
      container.scrollTo({ top: container.scrollHeight, behavior: "instant" });
    });
    return () => cancelAnimationFrame(frame);
  }, [agentRunning, bashRunning, messages.length, streamState.streamingMessage, agentPhase, pendingBash]);

  useLayoutEffect(() => {
    if (messages.length === 0) return;
    if (pendingScrollToUserRef.current) {
      pendingScrollToUserRef.current = false;
      initialScrollDoneRef.current = true;
      scrollUserMsgToTop();
      return;
    }
    if (!initialScrollDoneRef.current) {
      initialScrollDoneRef.current = true;
      scrollToBottom("instant");
      return;
    }
    if (completionScrollAllowedRef.current) {
      scrollToBottom(agentRunningRef.current || bashRunningRef.current ? "instant" : "smooth");
    }
  }, [messages.length, agentRunning, bashRunning, scrollToBottom, scrollUserMsgToTop]);

  // The prompt anchor waits for the first streamed content; once the run is
  // over (or aborted while nothing arrived) it must not hold the layout.
  useEffect(() => {
    if (!agentRunning) setPromptAnchorActive(false);
  }, [agentRunning]);

  // Load the model list with bounded retries; loadModels exposes each failure.
  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          await loadModels(controller.signal);
          return;
        } catch (e) {
          if (controller.signal.aborted) return;
          if (e instanceof DOMException && e.name === "AbortError") return;
          if (attempt >= MODELS_RETRY_DELAYS_MS.length) return;
          await delay(MODELS_RETRY_DELAYS_MS[attempt]);
          if (controller.signal.aborted) return;
        }
      }
    })();
    return () => controller.abort();
  }, [loadModels, modelsRefreshKey]);

  useEffect(() => {
    if (!compactResult) return;
    const t = setTimeout(() => setCompactResult(null), 6000);
    return () => clearTimeout(t);
  }, [compactResult]);

  // Pause notice expiry while hovered or focused.
  // The remainingMs/startedAt/oldestId refs implement a true pause-and-resume instead of resetting the 5s timer.
  const [pausedNoticeId, setPausedNoticeId] = useState<string | null>(null);
  const noticeRemainingMsRef = useRef(NOTICE_VISIBLE_MS);
  const noticeTimerStartedAtRef = useRef<number | null>(null);
  const noticeOldestIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (noticeState.visible.length === 0) {
      noticeOldestIdRef.current = null;
      return;
    }
    const exiting = noticeState.visible.find((notice) => notice.exiting);
    if (exiting) {
      const t = setTimeout(() => {
        dispatchNotice({ type: "remove", id: exiting.id });
      }, NOTICE_EXIT_ANIMATION_MS);
      return () => clearTimeout(t);
    }
    const oldest = noticeState.visible[0];
    if (!oldest) return;
    // Oldest visible notice changed; restart the countdown
    if (noticeOldestIdRef.current !== oldest.id) {
      noticeOldestIdRef.current = oldest.id;
      noticeRemainingMsRef.current = NOTICE_VISIBLE_MS;
    }
    if (noticeState.visible.some((notice) => notice.id === pausedNoticeId)) return;
    noticeTimerStartedAtRef.current = Date.now();
    const t = setTimeout(() => {
      dispatchNotice({ type: "mark_oldest_exiting" });
    }, noticeRemainingMsRef.current);
    return () => {
      clearTimeout(t);
      // Accrue the elapsed time so the countdown resumes from the remaining time
      if (noticeTimerStartedAtRef.current !== null) {
        noticeRemainingMsRef.current = Math.max(
          0,
          noticeRemainingMsRef.current - (Date.now() - noticeTimerStartedAtRef.current),
        );
        noticeTimerStartedAtRef.current = null;
      }
    };
  }, [noticeState.visible, pausedNoticeId]);

  useEffect(() => {
    setSessionStatsOverride(null);
  }, [messages.length, contextUsage?.tokens, contextUsage?.percent, contextUsage?.contextWindow]);

  const messageKeys = useMemo(
    () => messageRenderKeys(entryIds, messages.length, messageKeyAliases),
    [entryIds, messages.length, messageKeyAliases],
  );

  return {
    // State
    data, loading, error, activeLeafId, messages, activeToolResults, entryIds, messageKeys, historyCursor, hasEarlierMessages, earlierTurnCount, streamingStore,
    agentRunning, modelNames, modelList, modelError, modelScopeWarnings, modelThinkingLevels, modelThinkingLevelMaps, modelRoles, newSessionModel, toolPreset, thinkingLevel,
    effectiveThinkingLevel,
    retryInfo, contextUsage, systemPrompt, forkingEntryId,
    isCompacting, compactError, compactResult, currentModel, displayModel, modelSwitching, sessionStats, autoCompactionEnabled,
    slashCommands, slashCommandsLoading, queuedMessages, subagents,
    notices: noticeState.visible, extensionDialog, extensionCustomUi, extensionStatuses, extensionWidgets, respondToExtensionUi, sendExtensionCustomInput,
    addNotice,
    setNoticePaused: setPausedNoticeId,
    isAutoModelSelection: isNew && newSessionModel === null,
    isAutoThinkingSelection: isNew && thinkingLevel === "auto",
    defaultModel: newSessionDefaultModel,
    savedDefaultThinkingLevel,
    agentPhase,
    isNew,
    editEntryId,
    promptAnchorActive,
    showScrollToBottom,
    autoFollowPaused, resumeAutoFollow,
    goalStatus,
    // Refs
    sessionIdRef, eventSourceRef, messagesEndRef, scrollContainerRef,
    lastUserMsgRef,
    // Actions
    handleSend, handleAbort, handleFork, handleNavigate, handleModelChange, handleRoleModelChange,
    handleCompact, handleSteer, handleFollowUp, handlePromptWithStreamingBehavior, handleAbortCompaction,
    dismissCompactError,
    handleRecallQueue,
    handleBuiltinSlashCommand,
    handleEditContent,
    // Present only while a history edit is pending.
    cancelEdit: editEntryId ? cancelEdit : undefined,
    handleToolPresetChange, handleThinkingLevelChange, handleSetDefaultModel, handleSetDefaultThinkingLevel, loadTools, loadSlashCommands, setActiveLeafId, setData, setMessages, loadContext,
    scrollToBottom, scrollUserMsgToTop, scrollToMessage,
    dispatch, setAgentRunning, setForkingEntryId,
    bashRunning, pendingBash,
    // Subscriptions
    handleAgentEventRef,
  };
}
