import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const cssSource = await readFile(new URL("../app/settings.css", import.meta.url), "utf8");
// The fork has no login page: provider OAuth completes in-process (server
// registry + the paste panel), so upstream's `safeLoginDestination()` page-side
// guard has no counterpart — pin that the flow stays navigation-free instead.
const loginRouteSource = await readFile(new URL("../app/api/auth/login/[provider]/route.ts", import.meta.url), "utf8");

test("the trust dialog Settings › MCP opens stacks above Settings", () => {
  const zIndex = (selector) => Number(cssSource.match(new RegExp(`\\${selector} \\{[^}]*z-index: (\\d+);`))?.[1]);
  assert.ok(zIndex(".project-trust-backdrop") > zIndex(".settings-dialog-backdrop"));
});

test("provider login never navigates the browser to a caller-supplied destination", () => {
  assert.doesNotMatch(loginRouteSource, /Response\.redirect\(|location\.assign|location\.href\s*=/);
  assert.doesNotMatch(loginRouteSource, /destination/);
});
