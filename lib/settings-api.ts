export type SettingsValue = boolean | string | number | string[] | Record<string, number> | null;

export interface SettingsOption {
  value: string;
  label: string;
  description?: string;
}

export type SettingsFieldType =
  | "boolean"
  | "select"
  | "text"
  | "secret"
  | "multiselect"
  | "providerLimits";

export interface SettingsField {
  path: string;
  tab: string;
  group?: string;
  label: string;
  description: string;
  type: SettingsFieldType;
  value: SettingsValue;
  defaultValue: SettingsValue;
  configured: boolean;
  options?: SettingsOption[];
  ordered?: boolean;
  condition?: string;
}

export interface SettingsTab {
  id: string;
  label: string;
  groups: string[];
}

export interface WebThemePalette {
  name: string;
  colorScheme: "dark" | "light";
  variables: Record<string, string>;
}

export interface WebThemeConfig {
  names: { dark: string; light: string };
  // omp builds a palette for its two themes; upstream's extra theme ids resolve
  // through CSS only, so indexing by any ResolvedTheme yields possibly-undefined.
  palettes: { dark: WebThemePalette; light: WebThemePalette } & Record<string, WebThemePalette | undefined>;
}

/** Render-affecting settings the transcript view reads from omp's config. */
export interface DisplaySettings {
  hideThinkingBlock: boolean;
}

export interface SettingsResponse {
  tabs: SettingsTab[];
  fields: SettingsField[];
  availableThemes: Array<{ name: string; colorScheme: "dark" | "light" }>;
  theme: WebThemeConfig;
}

export type McpTransport = "stdio" | "http" | "sse";

export interface McpServerConfig {
  enabled?: boolean;
  timeout?: number;
  type?: McpTransport;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  auth?: Record<string, unknown>;
  oauth?: Record<string, unknown>;
}

export interface McpServerEntry {
  name: string;
  config: McpServerConfig;
  enabled: boolean;
  editable?: boolean;
  source?: {
    path: string;
    provider: string;
    level: "user" | "project" | "native";
  };
}

export interface McpScopeConfig {
  scope: "user" | "project";
  path: string;
  servers: McpServerEntry[];
  error?: string;
}

export interface McpConfigResponse {
  user: McpScopeConfig;
  project: McpScopeConfig | null;
}
