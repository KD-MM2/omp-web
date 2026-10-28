import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
// Bun's CJS interop exposes the named `Prism` export on the namespace object
// but hands a callable default that lacks it; normalize both runtimes.
import * as reactSyntaxHighlighterModule from "react-syntax-highlighter";

const cssSource = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
const { Prism: SyntaxHighlighter } =
  reactSyntaxHighlighterModule.default?.Prism ? reactSyntaxHighlighterModule.default : reactSyntaxHighlighterModule;

test("markdown table tokens stay inline despite Tailwind's table utility", () => {
  const html = renderToStaticMarkup(
    React.createElement(
      SyntaxHighlighter,
      { language: "markdown" },
      "| Name | Desc |\n| --- | --- |\n| A | first |",
    ),
  );

  assert.match(html, /class="token table[ "]/);
  assert.match(cssSource, /span\.token\.table\s*\{[^}]*display:\s*inline;/);
});
