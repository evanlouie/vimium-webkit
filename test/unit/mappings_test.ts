import { assert, assertEquals } from "@std/assert";
import {
  compileMappings,
  hasErrors,
  keysByCommand,
  readLogicalLines,
  type TrieNode,
} from "~/core/mappings.ts";
import { commandNames, DEFAULT_MAPPINGS } from "~/core/commands.ts";

const known = new Set(["scrollDown", "scrollUp", "showHelp", "reload"]);

const compile = (source: string, rejectReserved = false) =>
  compileMappings(source, {
    knownCommands: known,
    rejectReservedShortcuts: rejectReserved,
  });

const lookup = (trie: TrieNode, keys: readonly string[]): TrieNode | null => {
  let node: TrieNode | undefined = trie;
  for (const key of keys) {
    node = node?.children.get(key);
    if (node === undefined) return null;
  }
  return node ?? null;
};

Deno.test("readLogicalLines: strips comments and joins continuations", () => {
  const lines = readLogicalLines(
    [
      "# a comment",
      '" another comment',
      "map j scrollDown",
      "map k \\",
      "  scrollUp",
      "",
    ].join("\n"),
  );
  assertEquals(lines.map((line) => line.text), [
    "map j scrollDown",
    "map k    scrollUp",
  ]);
});

Deno.test('readLogicalLines: `#` and `"` are bindable keys, not trailing comments', () => {
  // Upstream only honours a comment marker as the first character of a line,
  // and `map # searchWordBackwards` is in our own defaults.
  assertEquals(readLogicalLines("map # showHelp")[0]?.text, "map # showHelp");
  assertEquals(readLogicalLines('map " showHelp')[0]?.text, 'map " showHelp');
  assertEquals(readLogicalLines("   # indented comment").length, 0);
});

Deno.test("compileMappings: builds a trie with the canonical notation", () => {
  const result = compile("map j scrollDown\nmap <c-d> scrollDown");
  assertEquals(lookup(result.trie, ["j"])?.binding?.command, "scrollDown");
  assertEquals(lookup(result.trie, ["<c-d>"])?.binding?.command, "scrollDown");
  assertEquals(result.diagnostics.length, 0);
});

Deno.test("compileMappings: a prefix and its extension coexist", () => {
  const result = compile("map gg scrollUp\nmap j scrollDown");
  const g = lookup(result.trie, ["g"]);
  assert(g !== null);
  assertEquals(g.binding, null, "`g` alone must remain a pure prefix");
  assertEquals(lookup(result.trie, ["g", "g"])?.binding?.command, "scrollUp");
});

Deno.test("compileMappings: unmap removes an earlier binding", () => {
  const result = compile("map j scrollDown\nunmap j");
  assertEquals(lookup(result.trie, ["j"]), null);
  assertEquals(result.diagnostics.length, 0);
});

Deno.test("compileMappings: unmap of nothing warns rather than fails", () => {
  const result = compile("unmap q");
  assertEquals(result.diagnostics[0]?.severity, "warning");
  assertEquals(hasErrors(result), false);
});

Deno.test("compileMappings: unmapAll clears everything before it", () => {
  const result = compile("map j scrollDown\nunmapAll\nmap k scrollUp");
  assertEquals(lookup(result.trie, ["j"]), null);
  assertEquals(lookup(result.trie, ["k"])?.binding?.command, "scrollUp");
});

Deno.test("compileMappings: options are parsed from the map line", () => {
  const result = compile("map j scrollDown swap=true count=3 flag");
  const binding = lookup(result.trie, ["j"])?.binding;
  assertEquals(binding?.options, { swap: true, count: "3", flag: true });
});

Deno.test("compileMappings: an unknown command is an error, not a crash", () => {
  const result = compile("map j scrollDown\nmap k noSuchCommand");
  assert(hasErrors(result));
  // The good line survives; one bad line must not cost the user everything.
  assertEquals(lookup(result.trie, ["j"])?.binding?.command, "scrollDown");
});

Deno.test("compileMappings: a malformed key sequence is attributed by line", () => {
  const result = compile("map j scrollDown\nmap <c-a scrollUp");
  const error = result.diagnostics.find((entry) => entry.severity === "error");
  assertEquals(error?.line, 2);
});

Deno.test("compileMappings: mapkey records a physical remap", () => {
  const result = compile("mapkey a b");
  assertEquals(result.keyRemap.get("a"), "b");
});

Deno.test("compileMappings: mapkey rejects sequences", () => {
  const result = compile("mapkey ab cd");
  assert(hasErrors(result));
});

Deno.test("compileMappings: reserved shortcuts are rejected on WebKit", () => {
  // `⌘T` never produces a keydown in Safari, so accepting the binding would be
  // lying to the user.
  const rejected = compile("map <m-t> reload", true);
  assert(hasErrors(rejected));
  assertEquals(lookup(rejected.trie, ["<m-t>"]), null);
});

Deno.test("compileMappings: reserved shortcuts only warn elsewhere", () => {
  const warned = compile("map <m-t> reload", false);
  assertEquals(hasErrors(warned), false);
  assertEquals(warned.diagnostics[0]?.severity, "warning");
  assertEquals(lookup(warned.trie, ["<m-t>"])?.binding?.command, "reload");
});

Deno.test("keysByCommand: groups every sequence bound to a command", () => {
  const result = compile("map j scrollDown\nmap <down> scrollDown");
  assertEquals(keysByCommand(result).get("scrollDown"), ["j", "<down>"]);
});

Deno.test("DEFAULT_MAPPINGS compiles cleanly against the real registry", () => {
  // The shipping defaults must never contain a typo or a stale command name.
  const result = compileMappings(DEFAULT_MAPPINGS, {
    knownCommands: commandNames(),
    rejectReservedShortcuts: true,
  });
  assertEquals(
    result.diagnostics.filter((entry) => entry.severity === "error"),
    [],
  );
});

Deno.test("DEFAULT_MAPPINGS binds Tier C commands too", () => {
  // Pressing `J` must explain why tab switching is impossible, not do nothing.
  const result = compileMappings(DEFAULT_MAPPINGS, {
    knownCommands: commandNames(),
    rejectReservedShortcuts: true,
  });
  assertEquals(lookup(result.trie, ["J"])?.binding?.command, "previousTab");
  assertEquals(lookup(result.trie, ["X"])?.binding?.command, "restoreTab");
});

Deno.test("user mappings layer on top of the defaults", () => {
  const result = compileMappings(
    `${DEFAULT_MAPPINGS}\nunmap j\nmap J showHelp`,
    {
      knownCommands: commandNames(),
      rejectReservedShortcuts: true,
    },
  );
  assertEquals(lookup(result.trie, ["j"]), null);
  assertEquals(lookup(result.trie, ["J"])?.binding?.command, "showHelp");
});
