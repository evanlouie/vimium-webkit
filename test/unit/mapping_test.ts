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
  acceptedBinding,
  canExtend,
  compileMappings,
  continuesSequence,
  deepestBinding,
  formatDiagnostics,
  hasErrors,
  keysByCommand,
  readLogicalLines,
  trieCandidates,
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

/**
 * The walk.
 *
 * The dispatcher holds a *list* of nodes, and not one node. Element 0 is the
 * root, so a new sequence can start inside one that the user abandoned. These
 * functions are what it asks of the trie.
 */
describe("the trie walk", () => {
  const walkTrie = compile("map g scrollUp\nmap gg showHelp\nmap j scrollDown")
    .trie;

  /** The node at a key path. It must exist, or the test is wrong. */
  const nodeAt = (keys: readonly string[]): TrieNode => {
    const node = lookup(walkTrie, keys);
    if (node === null) throw new Error(`no node at ${keys.join("")}`);
    return node;
  };

  /** The cursor after the user pressed `g`: the root, and the `g` node. */
  const afterG = (): readonly TrieNode[] => [walkTrie, nodeAt(["g"])];

  it.effect("gives every node that a key opens", () =>
    Effect.sync(() => {
      // `g` opens `gg` from the `g` node, and `g` again from the root.
      const candidates = trieCandidates(afterG(), "g");
      assert.lengthOf(candidates, 2);
      const deepest = deepestBinding(candidates);
      assert.isTrue(Option.isSome(deepest));
      assert.strictEqual(
        Option.isSome(deepest) ? deepest.value.command : null,
        "showHelp",
      );
    }));

  it.effect("asks the root last, so the longest match wins", () =>
    Effect.sync(() => {
      // The `g` node carries `scrollUp` and the `gg` node carries `showHelp`.
      // The deepest binding is the one that the user typed in full.
      const candidates = trieCandidates(afterG(), "g");
      assert.isFalse(canExtend(candidates));
    }));

  it.effect("says whether the half-typed sequence takes the key", () =>
    Effect.sync(() => {
      const cursor = afterG();
      // `gg` exists, so `g` continues the sequence.
      assert.isTrue(continuesSequence(cursor, "g"));
      // `j` is bound, but only at the root. It starts a new sequence, and it
      // does not continue this one.
      assert.isFalse(continuesSequence(cursor, "j"));
      assert.isFalse(continuesSequence(cursor, "x"));
      // The root alone continues nothing.
      assert.isFalse(continuesSequence([walkTrie], "g"));
    }));

  it.effect("says whether the most specific node takes another key", () =>
    Effect.sync(() => {
      assert.isTrue(canExtend([walkTrie, nodeAt(["g"])]));
      assert.isFalse(canExtend([walkTrie, nodeAt(["g"]), nodeAt(["g", "g"])]));
      assert.isFalse(canExtend([]));
    }));

  /**
   * Which node may accept a binding.
   *
   * A node that the root opens starts a new sequence. It must not take the
   * place of a binding that an earlier key accepted.
   */
  describe("the binding that a key accepts", () => {
    const overlapping =
      compile("map a scrollUp\nmap abc showHelp\nmap b scrollDown").trie;

    const nodeOf = (keys: readonly string[]): TrieNode => {
      const node = lookup(overlapping, keys);
      if (node === null) throw new Error(`no node at ${keys.join("")}`);
      return node;
    };

    const nameOf = (binding: Option.Option<{ command: string }>): string =>
      Option.isSome(binding) ? binding.value.command : "none";

    it.effect("takes the binding of a new sequence at the root", () =>
      Effect.sync(() => {
        assert.strictEqual(
          nameOf(acceptedBinding([overlapping], "a")),
          "scrollUp",
        );
      }));

    it.effect("refuses the binding of a root restart", () =>
      Effect.sync(() => {
        // `b` opens `ab`, which carries no binding, and `b`, which carries
        // `scrollDown`. The restart must accept nothing.
        const cursor = [overlapping, nodeOf(["a"])];
        assert.lengthOf(trieCandidates(cursor, "b"), 2);
        assert.strictEqual(nameOf(acceptedBinding(cursor, "b")), "none");
      }));

    it.effect("takes the binding of a node that carries on the sequence", () =>
      Effect.sync(() => {
        const cursor = [overlapping, nodeOf(["a"]), nodeOf(["a", "b"])];
        assert.strictEqual(nameOf(acceptedBinding(cursor, "c")), "showHelp");
      }));
  });
});
