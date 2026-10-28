import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");

test("expands process details when a completed turn has no final answer", () => {
  assert.match(source, /const \[expanded, setExpanded\] = useState\(defaultExpanded\)/);
  // Upstream sharpened the fork's #447 rule: a turn counts as answered only
  // when its final assistant message carries real content (text or image),
  // so a whitespace-only answer still reveals the process details.
  assert.match(source, /const answered = collapsesProcessDetails\(finalAnswerMessage\)/);
  assert.match(source, /<ProcessDetailsGroup[\s\S]*?defaultExpanded=\{!answered\}/);
});
