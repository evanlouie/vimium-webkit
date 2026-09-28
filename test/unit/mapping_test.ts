/**
 * The mapping language and the trie that it compiles into.
 *
 * One bad line must cost the user that line only. The compiler therefore gives
 * diagnostics, and it never fails. `TrieNode.binding` is an `Option`, so a pure
 * prefix is `Option.none()` and not a special node.
 */

import { assert, describe, it } from "@effect/vitest";
import { Array, Effect, Option, Record, flow, pipe } from "effect";
import { COMMANDS, DEFAULT_MAPPINGS } from "~/domain/Command.ts";
import {
  type BranchCursor,
  canExtend,
  type CompiledMappings,
  compileMappings,
  deepestBranch,
  type DiagnosticSeverity,
  extendBranches,
  formatDiagnostics,
  hasErrors,
  type KeyBinding,
  type KeyBranch,
  keysByCommand,
  type MappingDiagnostic,
  openBranch,
  readLogicalLines,
  type TrieNode,
} from "~/domain/Mapping.ts";

const known: ReadonlySet<string> = new Set(["scrollDown", "scrollUp", "showHelp", "reload"]);

const compile = (source: string, rejectReserved = false) =>
  compileMappings(source, {
    knownCommands: known,
    rejectReservedShortcuts: rejectReserved,
  });

/** The child of a node for one key. */
const childAt =
  (key: string) =>
  (parent: TrieNode): Option.Option<TrieNode> =>
    pipe(parent.children, Record.get(key));

/** Walk the trie. `Option.none()` means that no node is at this path. */
const lookup = (trie: TrieNode, keys: readonly string[]): Option.Option<TrieNode> =>
  pipe(
    keys,
    Array.reduce(Option.some(trie), (node, key) => pipe(node, Option.flatMap(childAt(key)))),
  );

/** The command that a key path runs, or `null`. */
const command = (trie: TrieNode, keys: readonly string[]): string | null =>
  pipe(
    lookup(trie, keys),
    Option.flatMap((node) => node.binding),
    Option.map((binding) => binding.command),
    Option.getOrNull,
  );

/** The text of each logical line of a source. */
const texts = (source: string): readonly string[] =>
  pipe(
    readLogicalLines(source),
    Array.map((line) => line.text),
  );

/** The key that `mapkey` sends a key to, or `null`. */
const remapOf = (result: CompiledMappings, key: string): string | null =>
  pipe(result.keyRemap, Record.get(key), Option.getOrNull);

/** The diagnostics of one severity. */
const withSeverity = (
  result: CompiledMappings,
  severity: DiagnosticSeverity,
): ReadonlyArray<MappingDiagnostic> =>
  pipe(
    result.diagnostics,
    Array.filter((entry) => entry.severity === severity),
  );

/** The severity of the first diagnostic, or `null` when there is none. */
const firstSeverity = (result: CompiledMappings): string | null =>
  pipe(
    result.diagnostics,
    Array.head,
    Option.map((entry) => entry.severity),
    Option.getOrNull,
  );

const allCommandNames: ReadonlySet<string> = new Set(Record.keys(COMMANDS));

const compileDefaults = () =>
  compileMappings(DEFAULT_MAPPINGS, {
    knownCommands: allCommandNames,
    rejectReservedShortcuts: true,
  });

describe("Mapping", () => {
  it.effect("removes comments and joins continuations", () =>
    Effect.sync(() => {
      const lines = texts(
        ["# a comment", '" another comment', "map j scrollDown", "map k \\", "  scrollUp", ""].join(
          "\n",
        ),
      );
      assert.deepEqual(lines, ["map j scrollDown", "map k    scrollUp"]);
    }),
  );

  it.effect('treats `#` and `"` as bindable keys, not trailing comments', () =>
    Effect.sync(() => {
      // Upstream honours a comment marker as the first character of a line
      // only, and `map # searchWordBackwards` is in the shipped defaults.
      assert.deepEqual(texts("map # showHelp"), ["map # showHelp"]);
      assert.deepEqual(texts('map " showHelp'), ['map " showHelp']);
      assert.lengthOf(readLogicalLines("   # indented comment"), 0);
    }),
  );

  it.effect("builds a trie with the canonical notation", () =>
    Effect.sync(() => {
      const result = compile("map j scrollDown\nmap <c-d> scrollDown");
      assert.strictEqual(command(result.trie, ["j"]), "scrollDown");
      assert.strictEqual(command(result.trie, ["<c-d>"]), "scrollDown");
      assert.lengthOf(result.diagnostics, 0);
    }),
  );

  it.effect("lets a prefix and its extension live together", () =>
    Effect.sync(() => {
      const result = compile("map gg scrollUp\nmap j scrollDown");
      const g = lookup(result.trie, ["g"]);
      const pure = pipe(
        g,
        Option.exists((node) => Option.isNone(node.binding)),
      );
      assert.isTrue(Option.isSome(g));
      assert.isTrue(pure, "`g` alone must stay a pure prefix");
      assert.strictEqual(command(result.trie, ["g", "g"]), "scrollUp");
    }),
  );

  it.effect("warns when one binding shadows another as a prefix", () =>
    Effect.sync(() => {
      const result = compile("map g scrollUp\nmap gg scrollDown");
      assert.isNotEmpty(withSeverity(result, "warning"));
      assert.isFalse(hasErrors(result));
    }),
  );

  it.effect("removes an earlier binding with unmap", () =>
    Effect.sync(() => {
      const result = compile("map j scrollDown\nunmap j");
      assert.isTrue(Option.isNone(lookup(result.trie, ["j"])));
      assert.lengthOf(result.diagnostics, 0);
    }),
  );

  it.effect("warns rather than fails when unmap finds nothing", () =>
    Effect.sync(() => {
      const result = compile("unmap q");
      assert.strictEqual(firstSeverity(result), "warning");
      assert.isFalse(hasErrors(result));
    }),
  );

  it.effect("clears everything before it with unmapAll", () =>
    Effect.sync(() => {
      const result = compile("map j scrollDown\nunmapAll\nmap k scrollUp");
      assert.isTrue(Option.isNone(lookup(result.trie, ["j"])));
      assert.strictEqual(command(result.trie, ["k"]), "scrollUp");
    }),
  );

  it.effect("reads the options of a map line", () =>
    Effect.sync(() => {
      const result = compile("map j scrollDown swap=true count=3 flag");
      const options = pipe(
        lookup(result.trie, ["j"]),
        Option.flatMap((node) => node.binding),
        Option.map((binding) => binding.options),
      );
      assert.deepEqual(Option.getOrNull(options), {
        swap: true,
        count: "3",
        flag: true,
      });
    }),
  );

  it.effect("reports an unknown command and keeps the good line", () =>
    Effect.sync(() => {
      const result = compile("map j scrollDown\nmap k noSuchCommand");
      assert.isTrue(hasErrors(result));
      assert.strictEqual(command(result.trie, ["j"]), "scrollDown");
    }),
  );

  it.effect("attributes a malformed key sequence to its line", () =>
    Effect.sync(() => {
      const result = compile("map j scrollDown\nmap <c-a scrollUp");
      const line = pipe(
        result.diagnostics,
        Array.findFirst((entry) => entry.severity === "error"),
        Option.map((entry) => entry.line),
        Option.getOrNull,
      );
      assert.strictEqual(line, 2);
    }),
  );

  it.effect("drops a diagnostic that belongs to the shipped defaults", () =>
    Effect.sync(() => {
      // The user cannot edit the defaults, so a line number below 1 is noise.
      const result = compileMappings("map <c-a scrollUp\nmap j scrollDown", {
        knownCommands: known,
        rejectReservedShortcuts: false,
        lineOffset: 1,
      });
      assert.lengthOf(result.diagnostics, 0);
    }),
  );

  it.effect("records a physical remap with mapkey", () =>
    Effect.sync(() => {
      const result = compile("mapkey a b");
      assert.strictEqual(remapOf(result, "a"), "b");
      assert.isFalse(hasErrors(result));
    }),
  );

  it.effect("refuses a sequence in mapkey", () =>
    Effect.sync(() => {
      assert.isTrue(hasErrors(compile("mapkey ab cd")));
      assert.isTrue(hasErrors(compile("mapkey a")));
    }),
  );

  it.effect("warns when mapkey targets a count digit", () =>
    Effect.sync(() => {
      const result = compile("mapkey a 3");
      assert.strictEqual(firstSeverity(result), "warning");
      assert.strictEqual(remapOf(result, "a"), "3");
    }),
  );

  it.effect("reports an unknown directive", () =>
    Effect.sync(() => {
      const result = compile("nope j scrollDown");
      const first = pipe(
        formatDiagnostics(result),
        Array.head,
        Option.getOrElse(() => ""),
      );
      assert.isTrue(hasErrors(result));
      assert.include(first, "unknown directive");
    }),
  );

  it.effect("refuses a reserved shortcut on WebKit", () =>
    Effect.sync(() => {
      // `⌘T` never gives a keydown in Safari, so acceptance is a lie.
      const rejected = compile("map <m-t> reload", true);
      assert.isTrue(hasErrors(rejected));
      assert.isTrue(Option.isNone(lookup(rejected.trie, ["<m-t>"])));
    }),
  );

  it.effect("only warns about a reserved shortcut elsewhere", () =>
    Effect.sync(() => {
      const warned = compile("map <m-t> reload", false);
      assert.isFalse(hasErrors(warned));
      assert.strictEqual(firstSeverity(warned), "warning");
      assert.strictEqual(command(warned.trie, ["<m-t>"]), "reload");
    }),
  );

  it.effect("groups every sequence that is bound to a command", () =>
    Effect.sync(() => {
      const result = compile("map j scrollDown\nmap <down> scrollDown");
      const keys = pipe(result, keysByCommand, Record.get("scrollDown"), Option.getOrNull);
      assert.deepEqual(keys, ["j", "<down>"]);
    }),
  );

  it.effect("keeps two bindings that join to the same text apart", () =>
    Effect.sync(() => {
      // `["<","c","-","a",">"]` and `["<c-a>"]` both join to `"<c-a>"`. The
      // binding table must not treat them as one entry.
      const result = compile("map <lt>c-a> scrollDown\nmap <c-a> scrollUp");
      assert.strictEqual(command(result.trie, ["<c-a>"]), "scrollUp");
      assert.strictEqual(command(result.trie, ["<", "c", "-", "a", ">"]), "scrollDown");
    }),
  );

  it.effect("compiles the shipped defaults with no error", () =>
    Effect.sync(() => {
      assert.deepEqual(withSeverity(compileDefaults(), "error"), []);
    }),
  );

  it.effect("puts the user mappings on top of the defaults", () =>
    Effect.sync(() => {
      const result = compileMappings(`${DEFAULT_MAPPINGS}\nunmap j\nmap J showHelp`, {
        knownCommands: allCommandNames,
        rejectReservedShortcuts: true,
      });
      assert.isTrue(Option.isNone(lookup(result.trie, ["j"])));
      assert.strictEqual(command(result.trie, ["J"]), "showHelp");
    }),
  );
});

/**
 * The walk, in the per-branch model.
 *
 * A branch is one live attempt at a mapping. It holds the node that the keys
 * reached, and the binding that the attempt accepted. A branch starts at the
 * root, and it dies when its node has no child for the next key.
 */
describe("the trie walk", () => {
  const walkTrie = compile("map g scrollUp\nmap gg showHelp\nmap j scrollDown").trie;

  const nameOf = flow(
    Option.map((binding: KeyBinding) => binding.command),
    Option.getOrElse(() => "none"),
  );

  /** The branch that a key starts at the root. It must exist, or the test is wrong. */
  const start = (trie: TrieNode, key: string): KeyBranch =>
    pipe(
      openBranch(trie, key),
      Option.getOrThrowWith(() => new Error(`the root has no ${key}`)),
    );

  /** The accepted binding of the deepest branch, by name. */
  const decision = (cursor: BranchCursor): string =>
    pipe(
      deepestBranch(cursor),
      Option.flatMap((deepest) => deepest.accepted),
      nameOf,
    );

  it.effect("gives a new branch the binding of its own node", () =>
    Effect.sync(() => {
      // `g` is bound, so the branch that `g` starts accepts `scrollUp`.
      assert.strictEqual(nameOf(start(walkTrie, "g").accepted), "scrollUp");
      // `x` is bound nowhere, so it opens no branch at all.
      assert.isTrue(Option.isNone(openBranch(walkTrie, "x")));
    }),
  );

  it.effect("lets a deeper node replace the accepted binding", () =>
    Effect.sync(() => {
      const after = extendBranches([start(walkTrie, "g")], "g");
      assert.lengthOf(after, 1);
      assert.strictEqual(decision(after), "showHelp");
    }),
  );

  it.effect("kills a branch that has no child for the key", () =>
    Effect.sync(() => {
      // `gj` is bound nowhere, so the branch `g` dies. The answer is empty,
      // which is what tells the dispatcher to run the accepted binding.
      assert.lengthOf(extendBranches([start(walkTrie, "g")], "j"), 0);
      assert.lengthOf(extendBranches([], "g"), 0);
    }),
  );

  it.effect("says whether a branch takes another key", () =>
    Effect.sync(() => {
      assert.isTrue(canExtend(start(walkTrie, "g")));
      const deep = pipe(extendBranches([start(walkTrie, "g")], "g"), Array.head);
      const finished = pipe(
        deep,
        Option.exists((branch) => !canExtend(branch)),
      );
      assert.isTrue(Option.isSome(deep));
      assert.isTrue(finished);
    }),
  );

  it.effect("gives no deepest branch when nothing is live", () =>
    Effect.sync(() => {
      assert.isTrue(Option.isNone(deepestBranch([])));
    }),
  );

  /**
   * Two branches that live at the same time.
   *
   * The accepted binding belongs to the branch that accepted it. A new branch
   * accepts the binding of its own node alone, and it takes nothing from an
   * older branch.
   */
  describe("an accepted binding belongs to its branch", () => {
    const overlapping = compile("map a scrollUp\nmap abc showHelp\nmap b scrollDown").trie;

    it.effect("keeps the older binding out of a new branch", () =>
      Effect.sync(() => {
        // `b` after `a` extends the attempt at `abc`, and it also starts a new
        // branch at the root. The new branch is one key deep, so it goes first.
        const extended = extendBranches([start(overlapping, "a")], "b");
        const cursor = pipe(extended, Array.prepend(start(overlapping, "b")));

        const newest = pipe(
          cursor,
          Array.head,
          Option.flatMap((branch) => branch.accepted),
          nameOf,
        );

        assert.lengthOf(cursor, 2);
        // The new branch accepts its own binding, and nothing else.
        assert.strictEqual(newest, "scrollDown");
        // The deepest branch decides, and it accepted `scrollUp` at `a`.
        assert.strictEqual(decision(cursor), "scrollUp");
      }),
    );

    it.effect("gives the deepest branch even when it accepted nothing", () =>
      Effect.sync(() => {
        // `ab` accepted nothing, and it is deeper than the new branch `b`,
        // which accepted `scrollDown`. The deepest branch still decides.
        const uneven = compile("map abz showHelp\nmap b scrollDown").trie;
        const cursor = pipe(
          extendBranches([start(uneven, "a")], "b"),
          Array.prepend(start(uneven, "b")),
        );

        assert.lengthOf(cursor, 2);
        assert.strictEqual(decision(cursor), "none");
      }),
    );

    it.effect("drops the accepted binding when the branch dies", () =>
      Effect.sync(() => {
        const live = extendBranches([start(overlapping, "a")], "b");
        // `abz` is bound nowhere, so the attempt at `abc` dies, and the
        // binding that `a` accepted dies with it.
        assert.lengthOf(extendBranches(live, "z"), 0);
      }),
    );

    it.effect("takes the binding of a node that carries on the attempt", () =>
      Effect.sync(() => {
        const live = extendBranches([start(overlapping, "a")], "b");
        assert.strictEqual(decision(extendBranches(live, "c")), "showHelp");
      }),
    );
  });
});
