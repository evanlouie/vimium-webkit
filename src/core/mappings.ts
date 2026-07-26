/**
 * The mapping language: `map` / `unmap` / `unmapAll` / `mapkey`, and the trie
 * they compile into.
 *
 * Syntax is Vimium-compatible so that an existing user can paste their
 * configuration in unchanged (goal G5). Parsing is a pure function returning
 * diagnostics rather than throwing, because a single bad line must never cost
 * the user every other binding they wrote.
 */

import {
  KeyNotationError,
  normaliseKeySequence,
  parseKeySequence,
  reservedReason,
  shiftedNonLetter,
} from "./key-notation.ts";

export interface KeyBinding {
  /** Canonical notation for each key in the sequence. */
  readonly keys: readonly string[];
  readonly command: string;
  readonly options: Readonly<Record<string, string | boolean>>;
  /** The source line, for error attribution and the help dialog. */
  readonly source: string;
  /** Raw line number in the compiled source; see `ParseOptions.lineOffset`. */
  readonly line: number;
}

export interface TrieNode {
  readonly children: Map<string, TrieNode>;
  binding: KeyBinding | null;
}

export type DiagnosticSeverity = "error" | "warning";

export interface MappingDiagnostic {
  /** Line number *within the source the user is looking at*. See `lineOffset`. */
  readonly line: number;
  readonly severity: DiagnosticSeverity;
  readonly message: string;
  readonly text: string;
}

export interface CompiledMappings {
  readonly trie: TrieNode;
  readonly bindings: readonly KeyBinding[];
  /** Physical-key remapping from `mapkey`, applied before the trie walk. */
  readonly keyRemap: ReadonlyMap<string, string>;
  readonly diagnostics: readonly MappingDiagnostic[];
}

export interface ParseOptions {
  /** Command names that exist; unknown names become diagnostics. */
  readonly knownCommands: ReadonlySet<string>;
  /**
   * Reject bindings on key combinations Safari never delivers.
   *
   * On WebKit these bindings are dead on arrival, so accepting them would be
   * lying to the user. On other engines the same configuration is legitimate,
   * so it downgrades to a warning and the binding is kept.
   */
  readonly rejectReservedShortcuts: boolean;
  /**
   * Subtracted from reported line numbers.
   *
   * The shipped defaults are compiled as a prefix of the user's own source, so
   * raw line numbers count from the top of the combined text. The only place a
   * user ever sees one is the settings dialog, next to *their* text — where an
   * error on their line 1 was reported as "line 105". Diagnostics attributed to
   * the defaults are dropped rather than renumbered into negatives: the user
   * cannot act on them, and the build has its own test that the defaults
   * compile cleanly.
   */
  readonly lineOffset?: number;
}

const newNode = (): TrieNode => ({ children: new Map(), binding: null });

/**
 * Identity for the binding table.
 *
 * `keys.join("")` is not injective: `["<", "c", "-", "a", ">"]` and `["<c-a>"]`
 * both flatten to `"<c-a>"`, so one binding silently replaced the other and
 * `unmap` removed whichever happened to survive. A separator that cannot appear
 * in a canonical notation fixes it.
 */
const bindingKey = (keys: readonly string[]): string => keys.join("\u0000");

// ---------------------------------------------------------------------------
// Tokenising
// ---------------------------------------------------------------------------

interface LogicalLine {
  readonly number: number;
  readonly text: string;
}

/**
 * Strip comments and join continuations.
 *
 * `#` and `"` introduce a comment **only as the first non-whitespace character
 * of a line**, matching upstream's `parseLines`. Trailing comments are
 * deliberately not supported: `#` and `"` are both bindable keys, so
 * `map # searchWordBackwards` is a legitimate line and there is no way to tell
 * it apart from a trailing comment without guessing.
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

    // A comment inside a continuation is a comment, not a terminator. Treating
    // it as one split `map j \` / `# why` / `scrollDown` into two bogus lines
    // and reported two confusing errors for a construct that reads as valid.
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

/** `swap=true` → `["swap", true]`; a bare `swap` → `["swap", true]`. */
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
    // Attributed to the shipped defaults, which the user cannot edit.
    if (relative < 1) return;
    diagnostics.push({
      line: relative,
      severity,
      message,
      text: line.text,
    });
  };

  for (const line of readLogicalLines(source)) {
    const tokens = splitTokens(line.text);
    const directive = tokens[0];
    if (directive === undefined) continue;

    switch (directive) {
      case "map": {
        const binding = parseMapLine(tokens, line, options, report);
        if (binding) bindings.set(bindingKey(binding.keys), binding);
        break;
      }

      case "unmap": {
        const sequence = tokens[1];
        if (sequence === undefined) {
          report(line, "error", "unmap needs a key sequence");
          break;
        }
        const keys = tryNormalise(sequence, line, report);
        if (keys) {
          if (!bindings.delete(bindingKey(keys))) {
            report(line, "warning", `nothing was mapped to ${sequence}`);
          }
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
        if (!fromKeys || !toKeys) break;
        if (fromKeys.length !== 1 || toKeys.length !== 1) {
          report(line, "error", "mapkey takes single keys, not sequences");
          break;
        }
        const source0 = fromKeys[0];
        const target0 = toKeys[0];
        if (source0 !== undefined && target0 !== undefined) {
          if (isCountDigit(target0)) {
            // `1`–`9` at the start of a sequence are the count prefix, so a
            // remap onto one turns the source key into a count digit rather
            // than into a binding — silently, and with no way to notice.
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
 * Warn where one binding is a strict prefix of another.
 *
 * `map g A` plus `map gg B` is not an error — the dispatcher waits for the next
 * key and resolves it — but it does mean `g` on its own no longer fires until
 * the user presses something that dead-ends. That is surprising enough to be
 * worth saying out loud, and it was previously silent in both directions.
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

const tryNormalise = (
  sequence: string,
  line: LogicalLine,
  report: Reporter,
): readonly string[] | null => {
  try {
    parseKeySequence(sequence);
    return normaliseKeySequence(sequence);
  } catch (cause) {
    report(
      line,
      "error",
      cause instanceof KeyNotationError ? cause.message : String(cause),
    );
    return null;
  }
};

const parseMapLine = (
  tokens: readonly string[],
  line: LogicalLine,
  options: ParseOptions,
  report: Reporter,
): KeyBinding | null => {
  const sequence = tokens[1];
  const command = tokens[2];

  if (sequence === undefined || command === undefined) {
    report(line, "error", "map needs a key sequence and a command");
    return null;
  }

  const keys = tryNormalise(sequence, line, report);
  if (!keys) return null;

  if (!options.knownCommands.has(command)) {
    report(line, "error", `unknown command "${command}"`);
    return null;
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
    if (reason === null) continue;
    if (options.rejectReservedShortcuts) {
      report(
        line,
        "error",
        `${key} is reserved by the browser (${reason}) and never reaches the ` +
          `page, so this binding can never fire`,
      );
      return null;
    }
    report(
      line,
      "warning",
      `${key} is reserved on Safari (${reason}); this binding will not work there`,
    );
  }

  const entries = tokens.slice(3).map(parseOption);
  return {
    keys,
    command,
    options: Object.fromEntries(entries),
    source: line.text,
    line: line.number,
  };
};

/** `1`–`9`: the count prefix claims these before the trie is consulted. */
const isCountDigit = (key: string): boolean =>
  key.length === 1 && key >= "1" && key <= "9";

const insert = (trie: TrieNode, binding: KeyBinding): void => {
  let node = trie;
  for (const key of binding.keys) {
    let next = node.children.get(key);
    if (next === undefined) {
      next = newNode();
      node.children.set(key, next);
    }
    node = next;
  }
  node.binding = binding;
};

// ---------------------------------------------------------------------------
// Inspection helpers (help dialog, tests)
// ---------------------------------------------------------------------------

/** `command -> the key sequences bound to it`, in insertion order. */
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
