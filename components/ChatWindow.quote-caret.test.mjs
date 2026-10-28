import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";

// "Ask here" inserts the quote and leaves the caret at its end so the question
// is typed after it. `window.getSelection().removeAllRanges()` clears the
// focused textarea's selection too and drops the caret to offset 0 (#1319).
test("asking about a selection in the current chat keeps the caret at the quote's end", async () => {
  // Upstream keeps a second ChatWindow in its demo app; the fork ships only
  // the real one, so the loop covers whichever copies exist.
  const paths = ["../components/ChatWindow.tsx", "../demo/components/ChatWindow.tsx"].filter((path) => existsSync(new URL(path, import.meta.url)));
  assert.ok(paths.includes("../components/ChatWindow.tsx"));
  for (const path of paths) {
    const source = await readFile(new URL(path, import.meta.url), "utf8");
    const body = source.match(/const askSelectionHere = useCallback\(\(\) => \{[\s\S]*?\}, \[[^\]]*\]\);/);
    assert.ok(body, `expected askSelectionHere in ${path}`);
    const code = body[0].replace(/^\s*\/\/.*$/gm, "");
    assert.doesNotMatch(
      code,
      /removeAllRanges\s*\(/,
      `${path}: inserting already collapses the page's selection, and removing ranges afterwards resets the composer's caret`,
    );
  }
});
