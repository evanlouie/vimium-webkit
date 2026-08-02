/**
 * The mapping language and the trie that it compiles into.
 *
 * One bad line must cost the user that line only. The compiler therefore gives
 * diagnostics, and it never fails. `TrieNode.binding` is an `Option`, so a pure
 * prefix is `Option.none()` and not a special node.
 */

import { assert, describe, it } from "@effect/vitest";
import { Effect, Option } from "effect";
import { COMMANDS, DEFAULT_MAPPINGS } from "~/domain/Command.ts";
import {
  compileMappings,
  formatDiagnostics,
  hasErrors,
  keysByCommand,
  readLogicalLines,
  type TrieNode,
} from "~/domain/Mapping.ts";

const known: ReadonlySet<string> = new Set([
  "scrollDown",
  "scrollUp",
  "showHelp",
  "reload",
]);

const compile = (source: string, rejectReserved = false) =>
  compileMappings(source, {
    knownCommands: known,
    rejectReservedShortcuts: rejectReserved,
  });

/** Walk the trie. `null` means that no node is at this path. */
const lookup = (trie: TrieNode, keys: readonly string[]): TrieNode | null => {
  let node: TrieNode | undefined = trie;
  for (const key of keys) {
    node = node?.children.get(key);
    if (node === undefined) return null;
  }
  return node ?? null;
};

/** The command that a key path runs, or `null`. */
const command = (trie: TrieNode, keys: readonly string[]): string | null => {
  const node = lookup(trie, keys);
  if (node === null) return null;
  return Option.isSome(node.binding) ? node.binding.value.command : null;
};

const allCommandNames: ReadonlySet<string> = new Set(Object.keys(COMMANDS));

const compileDefaults = () =>
  compileMappings(DEFAULT_MAPPINGS, {
    knownCommands: allCommandNames,
    rejectReservedShortcuts: true,
  });

describe("Mapping", () => {
  it.effect("removes comments and joins continuations", () =>
    Effect.sync(() => {
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
      assert.deepEqual(lines.map((line) => line.text), [
        "map j scrollDown",
        "map k    scrollUp",
      ]);
    }));

  it.effect('treats `#` and `"` as bindable keys, not trailing comments', () =>
    Effect.sync(() => {
      // Upstream honours a comment marker as the first character of a line
      // only, and `map # searchWordBackwards` is in the shipped defaults.
      assert.strictEqual(
        readLogicalLines("map # showHelp")[0]?.text,
        "map # showHelp",
      );
      assert.strictEqual(
        readLogicalLines('map " showHelp')[0]?.text,
        'map " showHelp',
      );
      assert.lengthOf(readLogicalLines("   # indented comment"), 0);
    }));

  it.effect("builds a trie with the canonical notation", () =>
    Effect.sync(() => {
      const result = compile("map j scrollDown\nmap <c-d> scrollDown");
      assert.strictEqual(command(result.trie, ["j"]), "scrollDown");
      assert.strictEqual(command(result.trie, ["<c-d>"]), "scrollDown");
      assert.lengthOf(result.diagnostics, 0);
    }));

  it.effect("lets a prefix and its extension live together", () =>
    Effect.sync(() => {
      const result = compile("map gg scrollUp\nmap j scrollDown");
      const g = lookup(result.trie, ["g"]);
      assert.isNotNull(g);
      assert.isTrue(
        g !== null && Option.isNone(g.binding),
        "`g` alone must stay a pure prefix",
      );
      assert.strictEqual(command(result.trie, ["g", "g"]), "scrollUp");
    }));

  it.effect("warns when one binding shadows another as a prefix", () =>
    Effect.sync(() => {
      const result = compile("map g scrollUp\nmap gg scrollDown");
      const warning = result.diagnostics.find(
        (entry) => entry.severity === "warning",
      );
      assert.isDefined(warning);
      assert.isFalse(hasErrors(result));
    }));

  it.effect("removes an earlier binding with unmap", () =>
    Effect.sync(() => {
      const result = compile("map j scrollDown\nunmap j");
      assert.isNull(lookup(result.trie, ["j"]));
      assert.lengthOf(result.diagnostics, 0);
    }));

  it.effect("warns rather than fails when unmap finds nothing", () =>
    Effect.sync(() => {
      const result = compile("unmap q");
      assert.strictEqual(result.diagnostics[0]?.severity, "warning");
      assert.isFalse(hasErrors(result));
    }));

  it.effect("clears everything before it with unmapAll", () =>
    Effect.sync(() => {
      const result = compile("map j scrollDown\nunmapAll\nmap k scrollUp");
      assert.isNull(lookup(result.trie, ["j"]));
      assert.strictEqual(command(result.trie, ["k"]), "scrollUp");
    }));

  it.effect("reads the options of a map line", () =>
    Effect.sync(() => {
      const result = compile("map j scrollDown swap=true count=3 flag");
      const node = lookup(result.trie, ["j"]);
      assert.isTrue(node !== null && Option.isSome(node.binding));
      if (node === null || Option.isNone(node.binding)) return;
      assert.deepEqual(node.binding.value.options, {
        swap: true,
        count: "3",
        flag: true,
      });
    }));

  it.effect("reports an unknown command and keeps the good line", () =>
    Effect.sync(() => {
      const result = compile("map j scrollDown\nmap k noSuchCommand");
      assert.isTrue(hasErrors(result));
      assert.strictEqual(command(result.trie, ["j"]), "scrollDown");
    }));

  it.effect("attributes a malformed key sequence to its line", () =>
    Effect.sync(() => {
      const result = compile("map j scrollDown\nmap <c-a scrollUp");
      const error = result.diagnostics.find(
        (entry) => entry.severity === "error",
      );
      assert.strictEqual(error?.line, 2);
    }));

  it.effect("drops a diagnostic that belongs to the shipped defaults", () =>
    Effect.sync(() => {
      // The user cannot edit the defaults, so a line number below 1 is noise.
      const result = compileMappings("map <c-a scrollUp\nmap j scrollDown", {
        knownCommands: known,
        rejectReservedShortcuts: false,
        lineOffset: 1,
      });
      assert.lengthOf(result.diagnostics, 0);
    }));

  it.effect("records a physical remap with mapkey", () =>
    Effect.sync(() => {
      const result = compile("mapkey a b");
      assert.strictEqual(result.keyRemap.get("a"), "b");
      assert.isFalse(hasErrors(result));
    }));

  it.effect("refuses a sequence in mapkey", () =>
    Effect.sync(() => {
      assert.isTrue(hasErrors(compile("mapkey ab cd")));
      assert.isTrue(hasErrors(compile("mapkey a")));
    }));

  it.effect("warns when mapkey targets a count digit", () =>
    Effect.sync(() => {
      const result = compile("mapkey a 3");
      assert.strictEqual(result.diagnostics[0]?.severity, "warning");
      assert.strictEqual(result.keyRemap.get("a"), "3");
    }));

  it.effect("reports an unknown directive", () =>
    Effect.sync(() => {
      const result = compile("nope j scrollDown");
      assert.isTrue(hasErrors(result));
      assert.include(formatDiagnostics(result)[0] ?? "", "unknown directive");
    }));

  it.effect("refuses a reserved shortcut on WebKit", () =>
    Effect.sync(() => {
      // `⌘T` never gives a keydown in Safari, so acceptance is a lie.
      const rejected = compile("map <m-t> reload", true);
      assert.isTrue(hasErrors(rejected));
      assert.isNull(lookup(rejected.trie, ["<m-t>"]));
    }));

  it.effect("only warns about a reserved shortcut elsewhere", () =>
    Effect.sync(() => {
      const warned = compile("map <m-t> reload", false);
      assert.isFalse(hasErrors(warned));
      assert.strictEqual(warned.diagnostics[0]?.severity, "warning");
      assert.strictEqual(command(warned.trie, ["<m-t>"]), "reload");
    }));

  it.effect("groups every sequence that is bound to a command", () =>
    Effect.sync(() => {
      const result = compile("map j scrollDown\nmap <down> scrollDown");
      assert.deepEqual(keysByCommand(result).get("scrollDown"), [
        "j",
        "<down>",
      ]);
    }));

  it.effect("keeps two bindings that join to the same text apart", () =>
    Effect.sync(() => {
      // `["<","c","-","a",">"]` and `["<c-a>"]` both join to `"<c-a>"`. The
      // binding table must not treat them as one entry.
      const result = compile("map <lt>c-a> scrollDown\nmap <c-a> scrollUp");
      assert.strictEqual(command(result.trie, ["<c-a>"]), "scrollUp");
      assert.strictEqual(
        command(result.trie, ["<", "c", "-", "a", ">"]),
        "scrollDown",
      );
    }));

  it.effect("compiles the shipped defaults with no error", () =>
    Effect.sync(() => {
      const result = compileDefaults();
      assert.deepEqual(
        result.diagnostics.filter((entry) => entry.severity === "error"),
        [],
      );
    }));

  it.effect("binds the tier C commands as well", () =>
    Effect.sync(() => {
      // A press of `J` must say why tab control is impossible, not do nothing.
      const result = compileDefaults();
      assert.strictEqual(command(result.trie, ["J"]), "previousTab");
      assert.strictEqual(command(result.trie, ["X"]), "restoreTab");
    }));

  it.effect("puts the user mappings on top of the defaults", () =>
    Effect.sync(() => {
      const result = compileMappings(
        `${DEFAULT_MAPPINGS}\nunmap j\nmap J showHelp`,
        {
          knownCommands: allCommandNames,
          rejectReservedShortcuts: true,
        },
      );
      assert.isNull(lookup(result.trie, ["j"]));
      assert.strictEqual(command(result.trie, ["J"]), "showHelp");
    }));
});
