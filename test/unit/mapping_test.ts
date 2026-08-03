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
  type BranchCursor,
  canExtend,
  compileMappings,
  deepestBranch,
  extendBranches,
  formatDiagnostics,
  hasErrors,
  type KeyBranch,
  keysByCommand,
  openBranch,
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

/**
 * The walk, in the per-branch model.
 *
 * A branch is one live attempt at a mapping. It holds the node that the keys
 * reached, and the binding that the attempt accepted. A branch starts at the
 * root, and it dies when its node has no child for the next key.
 */
describe("the trie walk", () => {
  const walkTrie = compile("map g scrollUp\nmap gg showHelp\nmap j scrollDown")
    .trie;

  const nameOf = (binding: Option.Option<{ command: string }>): string =>
    Option.isSome(binding) ? binding.value.command : "none";

  /** The branch that a key starts at the root. It must exist, or the test is wrong. */
  const start = (trie: TrieNode, key: string): KeyBranch => {
    const branch = openBranch(trie, key);
    if (Option.isNone(branch)) throw new Error(`the root has no ${key}`);
    return branch.value;
  };

  /** The accepted binding of the deepest branch, by name. */
  const decision = (cursor: BranchCursor): string => {
    const deepest = deepestBranch(cursor);
    return Option.isNone(deepest) ? "none" : nameOf(deepest.value.accepted);
  };

  it.effect("gives a new branch the binding of its own node", () =>
    Effect.sync(() => {
      // `g` is bound, so the branch that `g` starts accepts `scrollUp`.
      assert.strictEqual(nameOf(start(walkTrie, "g").accepted), "scrollUp");
      // `x` is bound nowhere, so it opens no branch at all.
      assert.isTrue(Option.isNone(openBranch(walkTrie, "x")));
    }));

  it.effect("lets a deeper node replace the accepted binding", () =>
    Effect.sync(() => {
      const after = extendBranches([start(walkTrie, "g")], "g");
      assert.lengthOf(after, 1);
      assert.strictEqual(decision(after), "showHelp");
    }));

  it.effect("kills a branch that has no child for the key", () =>
    Effect.sync(() => {
      // `gj` is bound nowhere, so the branch `g` dies. The answer is empty,
      // which is what tells the dispatcher to run the accepted binding.
      assert.lengthOf(extendBranches([start(walkTrie, "g")], "j"), 0);
      assert.lengthOf(extendBranches([], "g"), 0);
    }));

  it.effect("says whether a branch takes another key", () =>
    Effect.sync(() => {
      assert.isTrue(canExtend(start(walkTrie, "g")));
      const [deep] = extendBranches([start(walkTrie, "g")], "g");
      assert.isTrue(deep !== undefined && !canExtend(deep));
    }));

  it.effect("gives no deepest branch when nothing is live", () =>
    Effect.sync(() => {
      assert.isTrue(Option.isNone(deepestBranch([])));
    }));

  /**
   * Two branches that live at the same time.
   *
   * The accepted binding belongs to the branch that accepted it. A new branch
   * accepts the binding of its own node alone, and it takes nothing from an
   * older branch.
   */
  describe("an accepted binding belongs to its branch", () => {
    const overlapping =
      compile("map a scrollUp\nmap abc showHelp\nmap b scrollDown").trie;

    it.effect("keeps the older binding out of a new branch", () =>
      Effect.sync(() => {
        // `b` after `a` extends the attempt at `abc`, and it also starts a new
        // branch at the root. The new branch is one key deep, so it goes first.
        const extended = extendBranches([start(overlapping, "a")], "b");
        const cursor = [start(overlapping, "b"), ...extended];

        assert.lengthOf(cursor, 2);
        // The new branch accepts its own binding, and nothing else.
        assert.strictEqual(
          nameOf(cursor[0]?.accepted ?? Option.none()),
          "scrollDown",
        );
        // The deepest branch decides, and it accepted `scrollUp` at `a`.
        assert.strictEqual(decision(cursor), "scrollUp");
      }));

    it.effect("gives the deepest branch even when it accepted nothing", () =>
      Effect.sync(() => {
        // `ab` accepted nothing, and it is deeper than the new branch `b`,
        // which accepted `scrollDown`. The deepest branch still decides.
        const uneven = compile("map abz showHelp\nmap b scrollDown").trie;
        const cursor = [
          start(uneven, "b"),
          ...extendBranches([start(uneven, "a")], "b"),
        ];

        assert.lengthOf(cursor, 2);
        assert.strictEqual(decision(cursor), "none");
      }));

    it.effect("drops the accepted binding when the branch dies", () =>
      Effect.sync(() => {
        const live = extendBranches([start(overlapping, "a")], "b");
        // `abz` is bound nowhere, so the attempt at `abc` dies, and the
        // binding that `a` accepted dies with it.
        assert.lengthOf(extendBranches(live, "z"), 0);
      }));

    it.effect("takes the binding of a node that carries on the attempt", () =>
      Effect.sync(() => {
        const live = extendBranches([start(overlapping, "a")], "b");
        assert.strictEqual(decision(extendBranches(live, "c")), "showHelp");
      }));
  });
});
