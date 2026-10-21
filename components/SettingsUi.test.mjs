import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const configSources = await Promise.all(
  ["SkillsConfig", "PluginsConfig"].map(async (name) => [
    name,
    await readFile(new URL(`./${name}.tsx`, import.meta.url), "utf8"),
  ]),
);

test("every add pane chooses its scope in one place: the save target under its title", async () => {
  const sources = Object.fromEntries(configSources);
  const panes = {
    SkillsConfig: sources.SkillsConfig.match(/function AddSkillPanel[\s\S]*?\n\}\n/)?.[0] ?? "",
    PluginsConfig: sources.PluginsConfig.match(/function AddPluginPanel[\s\S]*?\n\}\n/)?.[0] ?? "",
  };
  for (const [name, source] of Object.entries(panes)) {
    assert.ok(source, name);
    assert.match(source, /<ConfigSaveTarget[\s\S]*?label=\{t\("config\.saveTo"\)\}[\s\S]*?path=\{/, name);
    assert.doesNotMatch(source, /<ConfigScopeSwitch/, `${name} uses the shared row, not a switch of its own`);
  }
});

