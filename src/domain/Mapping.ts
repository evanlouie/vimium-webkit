/**
 * The mapping language — `map`, `unmap`, `unmapAll` and `mapkey` — and the trie
 * that it compiles into.
 *
 * The syntax is the Vimium syntax, so a user can paste an existing
 * configuration without a change. Parsing is a pure function that gives
 * diagnostics. It does not fail. One bad line must never cost the user every
 * other binding.
 */

import { Option, Result } from "effect";
import {
  isCountDigit,
  normaliseKeySequence,
  reservedReason,
  shiftedNonLetter,
} from "~/domain/Key.ts";

export interface KeyBinding {
  /** The canonical notation of each key in the sequence. */
  readonly keys: readonly string[];
  readonly command: string;
  readonly options: Readonly<Record<string, string | boolean>>;
  /** The source line, for the error message and for the help dialog. */
  readonly source: string;
  /** The raw line number in the compiled source. See `ParseOptions.lineOffset`. */
  readonly line: number;
}

/**
 * One node of the compiled trie.
 *
 * The type is read-only. The compiler builds a mutable tree inside
 * `compileMappings` and gives it out as this type, so no caller can change a
 * trie that another service holds.
 */
export interface TrieNode {
  readonly children: ReadonlyMap<string, TrieNode>;
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
  readonly keyRemap: ReadonlyMap<string, string>;
  readonly diagnostics: readonly MappingDiagnostic[];
}

export interface ParseOptions {
  /** The command names that exist. An unknown name becomes a diagnostic. */
  readonly knownCommands: ReadonlySet<string>;
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

/** The tree that the compiler builds. It becomes a `TrieNode` on the way out. */
interface MutableTrieNode {
  readonly children: Map<string, MutableTrieNode>;
  binding: Option.Option<KeyBinding>;
}

const newNode = (): MutableTrieNode => ({
  children: new Map(),
  binding: Option.none(),
});

/**
 * The identity of a binding in the binding table.
 *
 * `keys.join("")` is not injective. `["<", "c", "-", "a", ">"]` and `["<c-a>"]`
 * both give `"<c-a>"`, so one binding replaced the other without a message,
 * and `unmap` removed the one that stayed. A separator that cannot occur in a
 * canonical notation corrects this.
 */
const bindingKey = (keys: readonly string[]): string => keys.join("\u0000");

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

export interface LogicalLine {
  readonly number: number;
  readonly text: string;
}

/**
 * Remove the comments and join the continuations.
 *
 * `#` and `"` start a comment **only as the first character that is not a
 * space on a line**. This is the behaviour of the upstream `parseLines`. A
 * comment at the end of a line is not supported on purpose. `#` and `"` are
 * both keys that a user can bind, so `map # searchWordBackwards` is a correct
 * line. There is no way to tell the two apart.
 */
export const readLogicalLines = (source: string): readonly LogicalLine[] => {
  const out: LogicalLine[] = [];
  const raw = source.split(/\r?\n/);

  let buffer = "";
  let continuing = false;
  let startLine = 0;

  for (let index = 0; index < raw.length; index++) {
    const line = raw[index] ?? "";
    const isComment = isCommentLine(line);

    // A comment inside a continuation is a comment, and not an end. Treatment
    // as an end split `map j \` plus `# why` plus `scrollDown` into two false
    // lines, and gave two confusing errors for a correct construction.
    if (isComment && continuing) continue;

    const stripped = isComment ? "" : line;

    if (stripped.trimEnd().endsWith("\\")) {
      if (!continuing) startLine = index + 1;
      continuing = true;
      buffer += `${stripped.trimEnd().slice(0, -1)} `;
      continue;
    }

    const text = `${buffer}${stripped}`.trim();
    if (text.length > 0) {
      out.push({ number: continuing ? startLine : index + 1, text });
    }
    buffer = "";
    continuing = false;
  }

  if (buffer.trim().length > 0) {
    out.push({ number: startLine, text: buffer.trim() });
  }
  return out;
};

const isCommentLine = (line: string): boolean => {
  const trimmed = line.trimStart();
  return trimmed.startsWith("#") || trimmed.startsWith('"');
};

const splitTokens = (text: string): readonly string[] =>
  text.split(/\s+/).filter((token) => token.length > 0);

/** `swap=true` gives `["swap", true]`. A bare `swap` gives `["swap", true]`. */
const parseOption = (token: string): readonly [string, string | boolean] => {
  const equals = token.indexOf("=");
  if (equals === -1) return [token, true];
  const key = token.slice(0, equals);
  const value = token.slice(equals + 1);
  if (value === "true") return [key, true];
  if (value === "false") return [key, false];
  return [key, value];
};

// ---------------------------------------------------------------------------
// Compilation
// ---------------------------------------------------------------------------

export const compileMappings = (
  source: string,
  options: ParseOptions,
): CompiledMappings => {
  const diagnostics: MappingDiagnostic[] = [];
  const bindings = new Map<string, KeyBinding>();
  const keyRemap = new Map<string, string>();
  const offset = options.lineOffset ?? 0;

  const report = (
    line: LogicalLine,
    severity: DiagnosticSeverity,
    message: string,
  ): void => {
    const relative = line.number - offset;
    // The line belongs to the shipped defaults, which the user cannot edit.
    if (relative < 1) return;
    diagnostics.push({ line: relative, severity, message, text: line.text });
  };

  for (const line of readLogicalLines(source)) {
    const tokens = splitTokens(line.text);
    const directive = tokens[0];
    if (directive === undefined) continue;

    switch (directive) {
      case "map": {
        const binding = parseMapLine(tokens, line, options, report);
        if (Option.isSome(binding)) {
          bindings.set(bindingKey(binding.value.keys), binding.value);
        }
        break;
      }

      case "unmap": {
        const sequence = tokens[1];
        if (sequence === undefined) {
          report(line, "error", "unmap needs a key sequence");
          break;
        }
        const keys = tryNormalise(sequence, line, report);
        if (Option.isSome(keys) && !bindings.delete(bindingKey(keys.value))) {
          report(line, "warning", `nothing was mapped to ${sequence}`);
        }
        break;
      }

      case "unmapAll":
        bindings.clear();
        break;

      case "mapkey": {
        const from = tokens[1];
        const to = tokens[2];
        if (from === undefined || to === undefined) {
          report(line, "error", "mapkey needs two key arguments");
          break;
        }
        const fromKeys = tryNormalise(from, line, report);
        const toKeys = tryNormalise(to, line, report);
        if (Option.isNone(fromKeys) || Option.isNone(toKeys)) break;
        if (fromKeys.value.length !== 1 || toKeys.value.length !== 1) {
          report(line, "error", "mapkey takes single keys, not sequences");
          break;
        }
        const source0 = fromKeys.value[0];
        const target0 = toKeys.value[0];
        if (source0 !== undefined && target0 !== undefined) {
          if (isCountDigit(target0, false)) {
            // `1` to `9` at the start of a sequence are the count prefix. A
            // remap onto one of them makes the source key a count digit, and
            // not a binding. It does this without a message, and the user has
            // no way to see it.
            report(
              line,
              "warning",
              `${target0} is a count digit, so ${source0} will start a count ` +
                "rather than run a command",
            );
          }
          keyRemap.set(source0, target0);
        }
        break;
      }

      default:
        report(line, "error", `unknown directive "${directive}"`);
    }
  }

  const trie = newNode();
  const ordered = [...bindings.values()];
  for (const binding of ordered) insert(trie, binding);

  reportShadowedPrefixes(ordered, diagnostics, offset);

  return { trie, bindings: ordered, keyRemap, diagnostics };
};

/**
 * Give a warning where one binding is a strict prefix of another one.
 *
 * `map g A` together with `map gg B` is not an error. The dispatcher waits for
 * the next key and then decides. But `g` alone no longer runs until the user
 * presses a key that ends the sequence. That is a surprise, so the parser says
 * it. Before, it was silent in both directions.
 */
const reportShadowedPrefixes = (
  bindings: readonly KeyBinding[],
  diagnostics: MappingDiagnostic[],
  offset: number,
): void => {
  const byKey = new Map(bindings.map((b) => [bindingKey(b.keys), b]));

  for (const binding of bindings) {
    if (binding.keys.length < 2) continue;
    for (let length = 1; length < binding.keys.length; length++) {
      const prefix = byKey.get(bindingKey(binding.keys.slice(0, length)));
      if (prefix === undefined) continue;
      const line = binding.line - offset;
      if (line < 1) continue;
      diagnostics.push({
        line,
        severity: "warning",
        message:
          `${prefix.keys.join("")} is also bound, so it only runs once a key ` +
          `that is not part of ${binding.keys.join("")} follows it`,
        text: binding.source,
      });
    }
  }
};

type Reporter = (
  line: LogicalLine,
  severity: DiagnosticSeverity,
  message: string,
) => void;

/**
 * Normalise a key sequence, or report the failure on this line.
 *
 * This is where a `KeyNotationError` value becomes a diagnostic with a line
 * number. `Key.ts` does not know the line number, and this module does.
 */
const tryNormalise = (
  sequence: string,
  line: LogicalLine,
  report: Reporter,
): Option.Option<readonly string[]> => {
  const normalised = normaliseKeySequence(sequence);
  if (Result.isFailure(normalised)) {
    report(line, "error", normalised.failure.detail);
    return Option.none();
  }
  return Option.some(normalised.success);
};

const parseMapLine = (
  tokens: readonly string[],
  line: LogicalLine,
  options: ParseOptions,
  report: Reporter,
): Option.Option<KeyBinding> => {
  const sequence = tokens[1];
  const command = tokens[2];

  if (sequence === undefined || command === undefined) {
    report(line, "error", "map needs a key sequence and a command");
    return Option.none();
  }

  const normalised = tryNormalise(sequence, line, report);
  if (Option.isNone(normalised)) return Option.none();
  const keys = normalised.value;

  if (!options.knownCommands.has(command)) {
    report(line, "error", `unknown command "${command}"`);
    return Option.none();
  }

  for (const key of keys) {
    if (shiftedNonLetter(key)) {
      report(
        line,
        "warning",
        `${key} names a shifted character that shift changes on most layouts ` +
          "(Shift+1 arrives as !), so this binding is unlikely to ever fire",
      );
    }
    const reason = reservedReason(key);
    if (Option.isNone(reason)) continue;
    if (options.rejectReservedShortcuts) {
      report(
        line,
        "error",
        `${key} is reserved by the browser (${reason.value}) and never ` +
          `reaches the page, so this binding can never fire`,
      );
      return Option.none();
    }
    report(
      line,
      "warning",
      `${key} is reserved on Safari (${reason.value}); this binding will not ` +
        `work there`,
    );
  }

  const entries = tokens.slice(3).map(parseOption);
  return Option.some({
    keys,
    command,
    options: Object.fromEntries(entries),
    source: line.text,
    line: line.number,
  });
};

const insert = (trie: MutableTrieNode, binding: KeyBinding): void => {
  let node = trie;
  for (const key of binding.keys) {
    let next = node.children.get(key);
    if (next === undefined) {
      next = newNode();
      node.children.set(key, next);
    }
    node = next;
  }
  node.binding = Option.some(binding);
};

// ---------------------------------------------------------------------------
// The walk
// ---------------------------------------------------------------------------

/**
 * The live nodes of a half-typed sequence, shallowest first.
 *
 * Element 0 is the root, and it stays there, so a new sequence can start inside
 * one that the user abandoned. `g` and then `j` scrolls down, as upstream
 * Vimium does.
 */
export type TrieCursor = readonly TrieNode[];

/** The nodes that this key opens, in the order of the cursor. */
export const trieCandidates = (
  cursor: TrieCursor,
  key: string,
): readonly TrieNode[] => {
  const found: TrieNode[] = [];
  for (const node of cursor) {
    const child = node.children.get(key);
    if (child !== undefined) found.push(child);
  }
  return found;
};

/**
 * Can the half-typed sequence take this key?
 *
 * The root is not part of the answer. A key that matches at the root only
 * starts a new sequence; it does not continue the one that the user typed. The
 * dispatcher asks this to learn whether a binding that it accepted earlier must
 * run now.
 */
export const continuesSequence = (
  cursor: TrieCursor,
  key: string,
): boolean => {
  for (let index = 1; index < cursor.length; index++) {
    if (cursor[index]?.children.has(key) === true) return true;
  }
  return false;
};

/**
 * The binding of the most specific node.
 *
 * The cursor is shallowest first, so the last binding in it is the longest
 * match, and the longest match wins.
 */
export const deepestBinding = (
  cursor: TrieCursor,
): Option.Option<KeyBinding> => {
  let found: Option.Option<KeyBinding> = Option.none();
  for (const node of cursor) {
    if (Option.isSome(node.binding)) found = node.binding;
  }
  return found;
};

/**
 * Can the most specific node take another key?
 *
 * While it can, the sequence is not finished, and a binding on the node waits.
 * Firing it at once is what made `map gg` unreachable behind `map g`.
 */
export const canExtend = (cursor: TrieCursor): boolean => {
  const deepest = cursor[cursor.length - 1];
  return deepest !== undefined && deepest.children.size > 0;
};

// ---------------------------------------------------------------------------
// Inspection (the help dialog and the tests)
// ---------------------------------------------------------------------------

/** Each command with the key sequences that are bound to it, in insertion order. */
export const keysByCommand = (
  mappings: CompiledMappings,
): ReadonlyMap<string, readonly string[]> => {
  const out = new Map<string, string[]>();
  for (const binding of mappings.bindings) {
    const list = out.get(binding.command) ?? [];
    list.push(binding.keys.join(""));
    out.set(binding.command, list);
  }
  return out;
};

export const hasErrors = (mappings: CompiledMappings): boolean =>
  mappings.diagnostics.some((entry) => entry.severity === "error");

export const formatDiagnostics = (
  mappings: CompiledMappings,
): readonly string[] =>
  mappings.diagnostics.map(
    (entry) => `line ${entry.line}: ${entry.severity}: ${entry.message}`,
  );
