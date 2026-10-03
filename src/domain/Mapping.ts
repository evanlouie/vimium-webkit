/**
 * The mapping language — `map`, `unmap`, `unmapAll` and `mapkey` — and the trie
 * that it compiles into.
 *
 * The syntax is the Vimium syntax, so a user can paste an existing
 * configuration without a change. Parsing is a pure function that gives
 * diagnostics. It does not fail. One bad line must never cost the user every
 * other binding.
 */

import {
  Array,
  Boolean,
  Equivalence,
  Match,
  Option,
  Record,
  Result,
  Struct,
  flow,
  pipe,
} from "effect";
import { type CommandName, isCommandName } from "~/domain/Command.ts";
import {
  isCountDigit,
  normaliseKeySequence,
  reservedReason,
  shiftedNonLetter,
} from "~/domain/Key.ts";

export interface KeyBinding {
  /** The canonical notation of each key in the sequence. */
  readonly keys: Array.NonEmptyReadonlyArray<string>;
  readonly command: CommandName;
  /** The source line, for the error message and for the help dialog. */
  readonly source: string;
  /** The raw line number in the compiled source. See `ParseOptions.lineOffset`. */
  readonly line: number;
}

/**
 * One node of the compiled trie.
 *
 * The compiler builds each node once, from the bindings that pass through it,
 * so no node changes after it exists and no caller can change a trie that
 * another service holds.
 */
export interface TrieNode {
  readonly children: Record.ReadonlyRecord<string, TrieNode>;
  readonly binding: Option.Option<KeyBinding>;
}

export type DiagnosticSeverity = "error" | "warning";

export interface MappingDiagnostic {
  /** The line number *in the source that the user sees*. See `lineOffset`. */
  readonly line: number;
  readonly severity: DiagnosticSeverity;
  readonly message: string;
  readonly text: string;
}

export interface CompiledMappings {
  readonly trie: TrieNode;
  readonly bindings: readonly KeyBinding[];
  /** The physical key remap from `mapkey`. It is applied before the trie walk. */
  readonly keyRemap: Record.ReadonlyRecord<string, string>;
  readonly diagnostics: readonly MappingDiagnostic[];
}

export interface ParseOptions {
  /**
   * Refuse a binding on a key combination that Safari never sends.
   *
   * On WebKit such a binding is dead, so acceptance would be a lie to the
   * user. On another engine the same configuration is correct, so the message
   * becomes a warning and the binding stays.
   */
  readonly rejectReservedShortcuts: boolean;
  /**
   * The number that is subtracted from each reported line number.
   *
   * The shipped defaults are compiled in front of the source of the user, so a
   * raw line number counts from the top of the joined text. The user sees a
   * line number only in the settings dialog, next to *their* text. There an
   * error on their line 1 was reported as "line 105". A diagnostic that
   * belongs to the defaults is dropped, and not renumbered into a negative
   * number. The user cannot correct it, and the build has its own test that
   * the defaults compile without a diagnostic.
   */
  readonly lineOffset?: number;
}

/**
 * The identity of a binding in the binding table: its keys, compared one key
 * at a time.
 *
 * `keys.join("")` is not injective. `["<", "c", "-", "a", ">"]` and `["<c-a>"]`
 * both give `"<c-a>"`, so one binding replaced the other without a message,
 * and `unmap` removed the one that stayed.
 */
const sameKeys = Array.makeEquivalence(Equivalence.String);

/** The keys of a sequence as the user reads them, for a message. */
const written = Array.join("");

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

export interface LogicalLine {
  readonly number: number;
  readonly text: string;
}

/** A line that ends with `\`, and the text that it joined so far. */
interface Continuation {
  readonly start: number;
  readonly text: string;
}

interface Joining {
  readonly lines: ReadonlyArray<LogicalLine>;
  readonly open: Option.Option<Continuation>;
}

const isCommentLine = (line: string): boolean => {
  const trimmed = line.trimStart();
  return trimmed.startsWith("#") || trimmed.startsWith('"');
};

/** The text of a line that continues on the next one, without its `\`. */
const continued = (text: string): Option.Option<string> =>
  pipe(
    text.trimEnd(),
    Option.liftPredicate((line) => line.endsWith("\\")),
    Option.map((line) => line.slice(0, -1)),
  );

/** Add a logical line. A line with no text is not one. */
const emit = (
  lines: ReadonlyArray<LogicalLine>,
  number: number,
  text: string,
): ReadonlyArray<LogicalLine> =>
  pipe(
    text.trim(),
    Option.liftPredicate((trimmed) => trimmed.length > 0),
    Option.match({
      onNone: () => lines,
      onSome: (trimmed) => pipe(lines, Array.append({ number, text: trimmed })),
    }),
  );

const joinLine = ({ lines, open }: Joining, line: LogicalLine): Joining => {
  const { start, text } = pipe(
    open,
    Option.getOrElse(() => ({ start: line.number, text: "" })),
  );
  return pipe(
    continued(line.text),
    Option.match({
      onNone: () => ({ lines: emit(lines, start, `${text}${line.text}`), open: Option.none() }),
      onSome: (part) => ({ lines, open: Option.some({ start, text: `${text}${part} ` }) }),
    }),
  );
};

/** A continuation at the end of the source still makes a line. */
const flush = ({ lines, open }: Joining): ReadonlyArray<LogicalLine> =>
  pipe(
    open,
    Option.match({
      onNone: () => lines,
      onSome: ({ start, text }) => emit(lines, start, text),
    }),
  );

const NOT_JOINING: Joining = { lines: [], open: Option.none() };

/**
 * Remove the comments and join the continuations.
 *
 * `#` and `"` start a comment **only as the first character that is not a
 * space on a line**. This is the behaviour of the upstream `parseLines`. A
 * comment at the end of a line is not supported on purpose. `#` and `"` are
 * both keys that a user can bind, so `map # searchWordBackwards` is a correct
 * line. There is no way to tell the two apart.
 */
export const readLogicalLines = (source: string): readonly LogicalLine[] =>
  pipe(
    source.split(/\r?\n/),
    Array.map((text, index) => ({ number: index + 1, text })),
    // A comment inside a continuation is a comment, and not an end. Treatment
    // as an end split `map j \` plus `# why` plus `scrollDown` into two false
    // lines, and gave two confusing errors for a correct construction.
    Array.filter((line) => !isCommentLine(line.text)),
    Array.reduce(NOT_JOINING, joinLine),
    flush,
  );

const splitTokens = (text: string): ReadonlyArray<string> =>
  pipe(
    text.split(/\s+/),
    Array.filter((token) => token.length > 0),
  );

// ---------------------------------------------------------------------------
// Compilation
// ---------------------------------------------------------------------------

/** One diagnostic, before it knows its line. */
interface Finding {
  readonly severity: DiagnosticSeverity;
  readonly message: string;
}

const error = (message: string): Finding => ({ severity: "error", message });
const warning = (message: string): Finding => ({ severity: "warning", message });

/** What the compiler reads from `ParseOptions`, decided once. */
interface Rules {
  /** The finding for a key that Safari never sends. */
  readonly reserved: (key: string, reason: string) => Finding;
}

const reservedFinding = Boolean.match({
  onFalse: () => (key: string, reason: string) =>
    warning(`${key} is reserved on Safari (${reason}); this binding will not work there`),
  onTrue: () => (key: string, reason: string) =>
    error(
      `${key} is reserved by the browser (${reason}) and never reaches the page, ` +
        "so this binding can never fire",
    ),
});

const rulesOf = (options: ParseOptions): Rules => ({
  reserved: reservedFinding(options.rejectReservedShortcuts),
});

/** The compiler between two lines. A line number here is raw. */
interface Compilation {
  readonly bindings: ReadonlyArray<KeyBinding>;
  readonly keyRemap: Record.ReadonlyRecord<string, string>;
  readonly diagnostics: ReadonlyArray<MappingDiagnostic>;
}

const EMPTY_COMPILATION: Compilation = {
  bindings: [],
  keyRemap: Record.empty(),
  diagnostics: [],
};

/**
 * What a line does to the compilation, and what the parser says about it.
 *
 * A line that fails changes nothing, and only reports.
 */
interface Edit {
  readonly apply: (compilation: Compilation) => Compilation;
  readonly findings: ReadonlyArray<Finding>;
}

type LineStep = Result.Result<Edit, ReadonlyArray<Finding>>;

const edit = (
  apply: (compilation: Compilation) => Compilation,
  findings: ReadonlyArray<Finding> = [],
): Edit => ({ apply, findings });

const note =
  (line: LogicalLine, findings: ReadonlyArray<Finding>) =>
  (compilation: Compilation): Compilation =>
    pipe(
      compilation,
      Struct.assign({
        diagnostics: pipe(
          findings,
          Array.map(({ severity, message }) => ({
            line: line.number,
            severity,
            message,
            text: line.text,
          })),
          Array.prependAll(compilation.diagnostics),
        ),
      }),
    );

/** Put a binding in the table. A binding on the same keys is replaced where it stands. */
const bind =
  (binding: KeyBinding) =>
  (bindings: ReadonlyArray<KeyBinding>): ReadonlyArray<KeyBinding> =>
    pipe(
      bindings,
      Array.findFirstIndex((entry) => sameKeys(entry.keys, binding.keys)),
      Option.flatMap((index) => pipe(bindings, Array.replace(index, binding))),
      Option.getOrElse(() => pipe(bindings, Array.append(binding))),
    );

/** Take a binding out of the table. `Option.none()` means that nothing was bound to the keys. */
const unbind =
  (keys: ReadonlyArray<string>) =>
  (bindings: ReadonlyArray<KeyBinding>): Option.Option<ReadonlyArray<KeyBinding>> =>
    pipe(
      bindings,
      Array.findFirstIndex((entry) => sameKeys(entry.keys, keys)),
      Option.map((index) => pipe(bindings, Array.remove(index))),
    );

/**
 * Normalise a key sequence, or give the failure as a finding.
 *
 * This is where a `KeyNotationError` value becomes a diagnostic with a line
 * number. `Key.ts` does not know the line number, and this module does.
 */
const normalised = flow(
  normaliseKeySequence,
  Result.mapError(({ detail }) => [error(detail)]),
);

/** What one key of a `map` line says about the binding. */
const keyFindings =
  (rules: Rules) =>
  (key: string): ReadonlyArray<Finding> =>
    pipe(
      [
        pipe(
          key,
          Option.liftPredicate(shiftedNonLetter),
          Option.map(() =>
            warning(
              `${key} names a shifted character that shift changes on most layouts ` +
                "(Shift+1 arrives as !), so this binding is unlikely to ever fire",
            ),
          ),
        ),
        pipe(
          reservedReason(key),
          Option.map((reason) => rules.reserved(key, reason)),
        ),
      ],
      Array.getSomes,
    );

/**
 * Every finding for the keys of a `map` line.
 *
 * The first error ends the line, so the keys after it say nothing.
 */
const sequenceFindings = (
  rules: Rules,
  keys: ReadonlyArray<string>,
): Result.Result<ReadonlyArray<Finding>, ReadonlyArray<Finding>> => {
  const findings = pipe(keys, Array.flatMap(keyFindings(rules)));
  return pipe(
    findings,
    Array.findFirstIndex((finding) => finding.severity === "error"),
    Option.match({
      onNone: () => Result.succeed(findings),
      onSome: (index) => pipe(findings, Array.take(index + 1), Result.fail),
    }),
  );
};

const mapStep = (rules: Rules, line: LogicalLine, args: ReadonlyArray<string>): LineStep =>
  Result.gen(function* () {
    const [sequence, name] = yield* pipe(
      Option.all([pipe(args, Array.get(0)), pipe(args, Array.get(1))]),
      Result.fromOption(() => [error("map needs a key sequence and a command")]),
    );
    const keys = yield* normalised(sequence);
    const command = yield* pipe(
      name,
      Result.liftPredicate(isCommandName, () => [error(`unknown command "${name}"`)]),
    );
    const findings = yield* sequenceFindings(rules, keys);
    // A token after the command is an option of upstream, such as
    // `swap=true`. No command here reads one, so the token is ignored, and a
    // configuration of upstream still compiles.
    const binding: KeyBinding = {
      keys,
      command,
      source: line.text,
      line: line.number,
    };
    return edit(Struct.evolve({ bindings: bind(binding) }), findings);
  });

const unmapStep = (compilation: Compilation, args: ReadonlyArray<string>): LineStep =>
  Result.gen(function* () {
    const sequence = yield* pipe(
      args,
      Array.head,
      Result.fromOption(() => [error("unmap needs a key sequence")]),
    );
    const keys = yield* normalised(sequence);
    const bindings = yield* pipe(
      compilation.bindings,
      unbind(keys),
      Result.fromOption(() => [warning(`nothing was mapped to ${sequence}`)]),
    );
    return edit(Struct.assign({ bindings }));
  });

/** The one key of a sequence that must hold one key. */
const isSingleKey = (keys: Array.NonEmptyReadonlyArray<string>): boolean => keys.length === 1;

const onlyKey = flow(Option.liftPredicate(isSingleKey), Option.map(Array.headNonEmpty));

/** Both sequences of a `mapkey` line, or a finding for each one that is bad. */
const remapSequences = (
  from: string,
  to: string,
): Result.Result<
  readonly [Array.NonEmptyReadonlyArray<string>, Array.NonEmptyReadonlyArray<string>],
  ReadonlyArray<Finding>
> => {
  const sequences = [normaliseKeySequence(from), normaliseKeySequence(to)] as const;
  return pipe(
    Result.all(sequences),
    Result.mapError(() =>
      pipe(
        sequences,
        Array.getFailures,
        Array.map(({ detail }) => error(detail)),
      ),
    ),
  );
};

const mapKeyStep = (args: ReadonlyArray<string>): LineStep =>
  Result.gen(function* () {
    const [from, to] = yield* pipe(
      Option.all([pipe(args, Array.get(0)), pipe(args, Array.get(1))]),
      Result.fromOption(() => [error("mapkey needs two key arguments")]),
    );
    const [fromKeys, toKeys] = yield* remapSequences(from, to);
    const [source, target] = yield* pipe(
      Option.all([onlyKey(fromKeys), onlyKey(toKeys)]),
      Result.fromOption(() => [error("mapkey takes single keys, not sequences")]),
    );
    // `1` to `9` at the start of a sequence are the count prefix. A remap onto
    // one of them makes the source key a count digit, and not a binding. It
    // does this without a message, and the user has no way to see it.
    const findings = pipe(
      target,
      Option.liftPredicate((key) => isCountDigit(key, false)),
      Option.map(() =>
        warning(
          `${target} is a count digit, so ${source} will start a count ` +
            "rather than run a command",
        ),
      ),
      Option.toArray,
    );
    return edit(
      Struct.evolve({ keyRemap: (remap) => pipe(remap, Record.set(source, target)) }),
      findings,
    );
  });

const directiveStep = (
  rules: Rules,
  line: LogicalLine,
  compilation: Compilation,
  directive: string,
  args: ReadonlyArray<string>,
): LineStep =>
  pipe(
    Match.value(directive),
    Match.withReturnType<LineStep>(),
    Match.when("map", () => mapStep(rules, line, args)),
    Match.when("unmap", () => unmapStep(compilation, args)),
    Match.when("unmapAll", () =>
      Result.succeed(edit(Struct.assign({ bindings: Array.empty<KeyBinding>() }))),
    ),
    Match.when("mapkey", () => mapKeyStep(args)),
    Match.orElse(() => Result.fail([error(`unknown directive "${directive}"`)])),
  );

const compileLine =
  (rules: Rules) =>
  (compilation: Compilation, line: LogicalLine): Compilation =>
    pipe(
      splitTokens(line.text),
      Array.matchLeft({
        onEmpty: (): LineStep => Result.succeed(edit((unchanged) => unchanged)),
        onNonEmpty: (directive, args) => directiveStep(rules, line, compilation, directive, args),
      }),
      Result.match({
        onFailure: (findings) => pipe(compilation, note(line, findings)),
        onSuccess: ({ apply, findings }) => pipe(compilation, apply, note(line, findings)),
      }),
    );

/** A binding, and the keys that are left below the node that is being built. */
interface Descent {
  readonly rest: ReadonlyArray<string>;
  readonly binding: KeyBinding;
}

/** The first key that is left, and the descent one level down. */
const descend = ({
  rest,
  binding,
}: Descent): ReadonlyArray<{ readonly key: string; readonly below: Descent }> =>
  pipe(
    rest,
    Array.matchLeft({
      onEmpty: () => [],
      onNonEmpty: (key, tail) => [{ key, below: { rest: tail, binding } }],
    }),
  );

/**
 * The node that these descents meet at.
 *
 * The binding table holds one binding per key sequence, so at most one
 * descent ends here.
 */
const nodeOf = (descents: ReadonlyArray<Descent>): TrieNode => ({
  binding: pipe(
    descents,
    Array.findFirst(({ rest }) => Array.isReadonlyArrayEmpty(rest)),
    Option.map(({ binding }) => binding),
  ),
  children: pipe(
    descents,
    Array.flatMap(descend),
    Array.groupBy(({ key }) => key),
    Record.map(
      flow(
        Array.map(({ below }) => below),
        nodeOf,
      ),
    ),
  ),
});

/** A binding at the root, with every one of its keys still to go. */
const fromRoot = (binding: KeyBinding): Descent => ({ rest: binding.keys, binding });

/** The bindings on a strict prefix of this binding, shortest first. */
const boundPrefixes =
  (bindings: ReadonlyArray<KeyBinding>) =>
  (binding: KeyBinding): ReadonlyArray<KeyBinding> =>
    pipe(
      binding.keys,
      Array.dropRight(1),
      Array.map((_, index) => pipe(binding.keys, Array.take(index + 1))),
      Array.map((prefix) =>
        pipe(
          bindings,
          Array.findFirst((other) => sameKeys(other.keys, prefix)),
        ),
      ),
      Array.getSomes,
    );

/**
 * Give a warning where one binding is a strict prefix of another one.
 *
 * `map g A` together with `map gg B` is not an error. The dispatcher waits for
 * the next key and then decides. But `g` alone no longer runs until the user
 * presses a key that ends the sequence. That is a surprise, so the parser says
 * it. Before, it was silent in both directions.
 */
const shadowedPrefixes = (bindings: ReadonlyArray<KeyBinding>): ReadonlyArray<MappingDiagnostic> =>
  pipe(
    bindings,
    Array.flatMap((binding) =>
      pipe(
        binding,
        boundPrefixes(bindings),
        Array.map((prefix) => ({
          line: binding.line,
          severity: "warning" as const,
          message:
            `${written(prefix.keys)} is also bound, so it only runs once a key ` +
            `that is not part of ${written(binding.keys)} follows it`,
          text: binding.source,
        })),
      ),
    ),
  );

export const compileMappings = (source: string, options: ParseOptions): CompiledMappings => {
  const offset = options.lineOffset ?? 0;
  const { bindings, keyRemap, diagnostics } = pipe(
    readLogicalLines(source),
    Array.reduce(EMPTY_COMPILATION, compileLine(rulesOf(options))),
  );
  return {
    trie: pipe(bindings, Array.map(fromRoot), nodeOf),
    bindings,
    keyRemap,
    diagnostics: pipe(
      diagnostics,
      Array.appendAll(shadowedPrefixes(bindings)),
      // A line at or below the offset belongs to the shipped defaults, which
      // the user cannot edit.
      Array.filter((entry) => entry.line > offset),
      Array.map((entry) => pipe(entry, Struct.assign({ line: entry.line - offset }))),
    ),
  };
};

// ---------------------------------------------------------------------------
// The walk
// ---------------------------------------------------------------------------

/**
 * The per-branch model of a half-typed sequence.
 *
 * A branch is one live attempt at a mapping. It holds the trie node that the
 * keys of the attempt reached. It also holds the binding that the attempt
 * accepted, which is the deepest binding on its own path.
 *
 * A branch starts when the root opens a child for a key. The accepted binding
 * of a new branch is the binding of that child alone. A new branch has accepted
 * nothing that an earlier key typed.
 *
 * A key extends a branch when the node of the branch has a child for that key.
 * A binding on the child replaces the accepted binding of that branch. A child
 * with no binding keeps the accepted binding of the branch.
 *
 * A branch dies when its node has no child for the key. The accepted binding
 * belongs to the branch, so it dies with the branch.
 *
 * The deepest branch is the branch that lived longest. When every branch dies,
 * the dispatcher runs the accepted binding of that branch. The key then starts
 * again at the root.
 *
 * With `map a`, `map abc` and `map b`, the key `b` after `a` opens two
 * branches. The branch `ab` carries on the attempt at `abc`, and the branch `b`
 * is new. The attempt at `abc` consumes the keystroke `b`: the dispatcher
 * suppresses the key, and the pending indicator shows it. The binding of `b`
 * therefore never runs, and a stray key after it runs the binding of `a`.
 */
export interface KeyBranch {
  readonly node: TrieNode;
  readonly accepted: Option.Option<KeyBinding>;
}

/**
 * Every live branch, shallowest first.
 *
 * The root is not a branch, so an empty cursor means "at the root". The last
 * branch is the deepest one, and it is the branch that lived longest. A new
 * branch is always one key deep, so it goes in front of the others.
 */
export type BranchCursor = readonly KeyBranch[];

/**
 * The branch that this key starts at the root.
 *
 * The new branch accepts the binding of the child, and nothing else. `g` and
 * then `j` scrolls down, as upstream Vimium does, because `j` starts here.
 */
export const openBranch = (root: TrieNode, key: string): Option.Option<KeyBranch> =>
  pipe(
    root.children,
    Record.get(key),
    Option.map((child) => ({ node: child, accepted: child.binding })),
  );

/** The branch one key deeper. `Option.none()` means that the branch dies at this key. */
const extendBranch =
  (key: string) =>
  (branch: KeyBranch): Option.Option<KeyBranch> =>
    pipe(
      branch.node.children,
      Record.get(key),
      Option.map((child) => ({
        node: child,
        accepted: pipe(
          child.binding,
          Option.orElse(() => branch.accepted),
        ),
      })),
    );

/**
 * Take one key into every live branch.
 *
 * A branch whose node has the key moves to the child. A binding on the child
 * replaces the accepted binding of that branch. A branch whose node does not
 * have the key is absent from the answer, because it died. Its accepted binding
 * dies with it.
 *
 * An empty answer means that this key ends every live attempt.
 */
export const extendBranches = (cursor: BranchCursor, key: string): readonly KeyBranch[] =>
  pipe(cursor, Array.map(extendBranch(key)), Array.getSomes);

/**
 * Can this branch take another key?
 *
 * While it can, the attempt is not finished, and a binding on the node waits.
 * Firing it at once is what made `map gg` unreachable behind `map g`.
 */
export const canExtend = (branch: KeyBranch): boolean =>
  !Record.isEmptyReadonlyRecord(branch.node.children);

// ---------------------------------------------------------------------------
// Inspection (the help dialog and the tests)
// ---------------------------------------------------------------------------

/** Each command with the key sequences that are bound to it, in insertion order. */
export const keysByCommand = (
  mappings: CompiledMappings,
): Record.ReadonlyRecord<string, Array.NonEmptyReadonlyArray<string>> =>
  pipe(
    mappings.bindings,
    Array.groupBy((binding): string => binding.command),
    Record.map(Array.map((binding) => written(binding.keys))),
  );

export const formatDiagnostics = (mappings: CompiledMappings): readonly string[] =>
  pipe(
    mappings.diagnostics,
    Array.map((entry) => `line ${entry.line}: ${entry.severity}: ${entry.message}`),
  );
