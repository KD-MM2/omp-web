import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { parseJsonc, stripJsonComments } = await jiti.import("./jsonc.ts");
// The fork SDK (`@oh-my-pi/*`) ships no json helper, so models.json reads use
// lib/jsonc.ts alone; the upstream test here also diffed pi's own stripper.

test("drops line comments, block comments and trailing commas", () => {
  assert.deepEqual(parseJsonc(`{
    // a line comment
    "servers": { /* inline */ "a": { "command": "npx", "args": ["-y",], }, },
    /*
     * a block comment
     */
    "inputs": [],
  }`), { servers: { a: { command: "npx", args: ["-y"] } }, inputs: [] });
});

test("leaves comment and comma lookalikes inside strings alone", () => {
  assert.deepEqual(parseJsonc(String.raw`{
    "url": "https://example.com/mcp", // keeps the // in the string
    "glob": "src/**/*.ts",
    "text": "a /* not a comment */ b",
    "comma": "x,}",
    "quote": "say \"hi\" // still a string",
  }`), {
    url: "https://example.com/mcp",
    glob: "src/**/*.ts",
    text: "a /* not a comment */ b",
    comma: "x,}",
    quote: 'say "hi" // still a string',
  });
});

test("a block comment separates tokens instead of joining them", () => {
  assert.deepEqual(parseJsonc("[1/**/, 2]"), [1, 2]);
  assert.throws(() => parseJsonc("[1/**/2]"), SyntaxError);
  assert.throws(() => parseJsonc("[tr/**/ue]"), SyntaxError);
});

test("an unterminated block comment and other broken JSON still throw", () => {
  assert.throws(() => parseJsonc('{ "a": 1 /* never closed'), SyntaxError);
  assert.throws(() => parseJsonc("{ a: 1 }"), SyntaxError);
  assert.throws(() => parseJsonc(""), SyntaxError);
});

test("a byte-order mark is accepted", () => {
  assert.deepEqual(parseJsonc('\uFEFF{"a": 1}'), { a: 1 });
});

