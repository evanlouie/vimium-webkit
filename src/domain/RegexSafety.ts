/**
 * A static safety check for a regular expression that a user wrote.
 *
 * The platform gives one regular expression engine, and that engine
 * backtracks. A pattern such as `(a|a|a|a)*$` against twenty characters takes
 * minutes. No code in JavaScript can stop an `exec` that is already inside
 * such a pattern, so the tab stops answering.
 *
 * A measurement cannot protect the page. The measurement cannot end before the
 * match ends. This module therefore decides on the *text* of the pattern,
 * before any input touches it.
 *
 * # What the check promises
 *
 * The check refuses a pattern only when it can *prove* that the pattern is
 * ambiguous. An ambiguous pattern gives the engine more than one way to match
 * one text. Each extra way is another path that the engine walks after a
 * failure. These are the shapes that the check proves:
 *
 * - a quantifier over an expression that matches nothing, as in `(a*)*`;
 * - a quantifier whose body can grow past its own end, as in `(a+)+`. One
 *   text then has two divisions into iterations;
 * - two alternatives that match the same text, as in `(a|a)*`;
 * - two neighbouring quantifiers that compete for the same characters, as in
 *   `\s+\s+`;
 * - more than one unbounded quantifier that competes with the text after it,
 *   as in `a.*b.*c`;
 * - more than eight lookaheads or lookbehinds in one pattern;
 * - a backreference.
 *
 * The check compares the character sets of the two parts that compete. A part
 * that cannot take the first character of the next part cannot compete with
 * it. `([a-z0-9-]+\.)*` is therefore safe, because the inner loop cannot take
 * the dot that ends each iteration.
 *
 * # A lookahead and a lookbehind
 *
 * An assertion gives back no text, but it holds an expression that runs. The
 * check reads inside it. The body of an assertion competes with the text that
 * follows the assertion, so its character sets take part in every neighbour
 * test, and a quantifier in the body counts in the budget below.
 *
 * The body of an assertion runs again for each way that the text before it can
 * match. `.*(?=.*x)` therefore costs a window times a window, which is the
 * same cost as `a.*b.*c`, and both are refused. `(?=.*foo)(?=.*bar)` costs two
 * windows, because nothing before the two assertions can vary, and both are
 * accepted.
 *
 * # What the check does not promise
 *
 * The check does not promise a linear match. It promises only that the shapes
 * above are absent. Two limits stay:
 *
 * - A search tries every start position. A pattern that is linear at one
 *   position is quadratic over a whole search. `[a-z]*x` costs about 2.3 s in
 *   one `exec` against 40 000 characters, and the check accepts it.
 * - The check reads a small model of the pattern. It accepts a shape that the
 *   model cannot describe, because it cannot prove a fault there.
 *
 * The budget of a caller bounds a pattern whose cost grows with a power of the
 * length of the text. It cannot bound a pattern whose cost doubles with each
 * character. The shapes in the list above are the shapes that double, and the
 * check refuses each one with a proof.
 *
 * Each caller must therefore hold a budget of its own. `~/domain/Exclusion.ts`
 * caps the length of the URL that a raw expression reads.
 * `~/features/find/Engine.ts` searches the page text in windows, measures each
 * window, and makes the next window smaller when a window costs too much. Read
 * those two modules with this one. This check is the first limit, and the
 * budget of the caller is the second.
 *
 * The check prefers to accept when it is not sure. A refused pattern costs the
 * user a rule that they must write again, and the budget of the caller holds
 * the limit for a pattern that this check accepts by mistake.
 *
 * Everything here is a pure function of the pattern text. Nothing throws.
 */

import { Option } from "effect";

// ---------------------------------------------------------------------------
// The reasons
// ---------------------------------------------------------------------------

const UNSUPPORTED_SYNTAX =
  "this pattern uses syntax that the safety check does not know";
const TOO_LONG = "this pattern is too long for the safety check";
const BACKREFERENCE = "a backreference can hang the page";
const EMPTY_LOOP =
  "a quantifier over an expression that matches nothing can hang the page";
const AMBIGUOUS_LOOP =
  "a quantifier whose body can grow past its own end can hang the page";
const AMBIGUOUS_BRANCHES =
  "two alternatives that match the same text can hang the page";
const COMPETING_LOOPS =
  "two quantifiers that match the same characters can hang the page";
const MANY_LOOPS =
  "this pattern can try too many ways to match one piece of text, " +
  "and that can hang the page";
const MANY_ASSERTIONS =
  "this pattern holds too many lookaheads or lookbehinds for the safety check";
const PROPERTY_ESCAPE =
  "a property escape such as `\\p{L}` needs the `u` flag, which this field " +
  "does not allow; write a character class such as `[a-zA-Z]` instead";
const LONG_ESCAPE =
  "`\\u{…}` needs the `u` flag, which this field does not allow; write " +
  "`\\uFFFF` with four digits instead";

// ---------------------------------------------------------------------------
// Character sets
// ---------------------------------------------------------------------------

/** The class escapes that this module can reason about. */
type ClassName = "d" | "D" | "w" | "W" | "s" | "S";

/**
 * The characters that one atom can match.
 *
 * `negated` inverts the whole set, as `[^…]` does. A set that the module
 * cannot describe becomes `ANY_SET`, which intersects everything and therefore
 * refuses more.
 */
interface CharSet {
  readonly negated: boolean;
  readonly chars: ReadonlySet<number>;
  readonly ranges: ReadonlyArray<readonly [number, number]>;
  readonly classes: ReadonlySet<ClassName>;
}

const EMPTY_SET: CharSet = {
  negated: false,
  chars: new Set<number>(),
  ranges: [],
  classes: new Set<ClassName>(),
};

const ANY_SET: CharSet = { ...EMPTY_SET, negated: true };

/** `.` matches everything except the line terminators, without the `s` flag. */
const DOT_SET: CharSet = {
  ...EMPTY_SET,
  negated: true,
  chars: new Set([0x0a, 0x0d, 0x2028, 0x2029]),
};

const oneChar = (code: number): CharSet => ({
  ...EMPTY_SET,
  chars: new Set([code]),
});

const oneClass = (name: ClassName): CharSet => ({
  ...EMPTY_SET,
  classes: new Set([name]),
});

/** The characters of `\s`, as the specification lists them. */
const WHITESPACE: ReadonlySet<number> = new Set([
  0x09,
  0x0a,
  0x0b,
  0x0c,
  0x0d,
  0x20,
  0xa0,
  0x1680,
  0x2000,
  0x2001,
  0x2002,
  0x2003,
  0x2004,
  0x2005,
  0x2006,
  0x2007,
  0x2008,
  0x2009,
  0x200a,
  0x2028,
  0x2029,
  0x202f,
  0x205f,
  0x3000,
  0xfeff,
]);

const isDigit = (code: number): boolean => code >= 0x30 && code <= 0x39;

const isWord = (code: number): boolean =>
  isDigit(code) ||
  (code >= 0x41 && code <= 0x5a) ||
  (code >= 0x61 && code <= 0x7a) ||
  code === 0x5f;

const inClass = (name: ClassName, code: number): boolean => {
  switch (name) {
    case "d":
      return isDigit(code);
    case "D":
      return !isDigit(code);
    case "w":
      return isWord(code);
    case "W":
      return !isWord(code);
    case "s":
      return WHITESPACE.has(code);
    case "S":
      return !WHITESPACE.has(code);
  }
};

/** Does `set` hold this character? The answer is exact. */
const holdsExactly = (set: CharSet, code: number): boolean => {
  let inside = set.chars.has(code) ||
    set.ranges.some(([low, high]) => code >= low && code <= high);
  if (!inside) {
    for (const name of set.classes) {
      if (inClass(name, code)) {
        inside = true;
        break;
      }
    }
  }
  return set.negated ? !inside : inside;
};

/** The same question, with the case folding of the `i` flag. */
const holds = (set: CharSet, code: number, ignoreCase: boolean): boolean => {
  if (holdsExactly(set, code)) return true;
  if (!ignoreCase) return false;
  const char = String.fromCharCode(code);
  const upper = char.toUpperCase();
  const lower = char.toLowerCase();
  return (upper.length === 1 && holdsExactly(set, upper.charCodeAt(0))) ||
    (lower.length === 1 && holdsExactly(set, lower.charCodeAt(0)));
};

/** The most members that this module lists for one set. */
const MEMBER_LIMIT = 256;

/** The lists that `members` already made. One set never changes. */
const memberCache = new WeakMap<
  CharSet,
  Option.Option<ReadonlyArray<number>>
>();

/**
 * List the members of `set`, when there are few enough of them.
 *
 * A `None` means "too many, or an unlimited number". A negated set and `\D`,
 * `\W` and `\S` are unlimited.
 */
const members = (set: CharSet): Option.Option<ReadonlyArray<number>> => {
  const found = memberCache.get(set);
  if (found !== undefined) return found;
  const made = listMembers(set);
  memberCache.set(set, made);
  return made;
};

const listMembers = (set: CharSet): Option.Option<ReadonlyArray<number>> => {
  if (set.negated) return Option.none();
  const found = new Set<number>(set.chars);
  for (const [low, high] of set.ranges) {
    if (high - low > MEMBER_LIMIT) return Option.none();
    for (let code = low; code <= high; code++) found.add(code);
  }
  for (const name of set.classes) {
    switch (name) {
      case "d":
        for (let code = 0x30; code <= 0x39; code++) found.add(code);
        break;
      case "w":
        for (let code = 0x30; code <= 0x39; code++) found.add(code);
        for (let code = 0x41; code <= 0x5a; code++) found.add(code);
        for (let code = 0x61; code <= 0x7a; code++) found.add(code);
        found.add(0x5f);
        break;
      case "s":
        for (const code of WHITESPACE) found.add(code);
        break;
      default:
        return Option.none();
    }
  }
  return found.size > MEMBER_LIMIT
    ? Option.none()
    : Option.some([...found]);
};

/**
 * Can one character belong to both sets?
 *
 * The answer is exact when one of the two sets is small enough to list. Two
 * unlimited sets give `true`, which refuses the pattern.
 */
const setsIntersect = (
  left: CharSet,
  right: CharSet,
  ignoreCase: boolean,
): boolean => {
  const listed = members(left);
  if (Option.isSome(listed)) {
    return listed.value.some((code) => holds(right, code, ignoreCase));
  }
  const other = members(right);
  if (Option.isSome(other)) {
    return other.value.some((code) => holds(left, code, ignoreCase));
  }
  return true;
};

const unionSets = (left: CharSet, right: CharSet): CharSet =>
  left.negated || right.negated ? ANY_SET : {
    negated: false,
    chars: new Set([...left.chars, ...right.chars]),
    ranges: [...left.ranges, ...right.ranges],
    classes: new Set([...left.classes, ...right.classes]),
  };

// ---------------------------------------------------------------------------
// The syntax tree
// ---------------------------------------------------------------------------

type Node =
  /** Nothing at all, as between the two bars of `a||b`. */
  | { readonly kind: "empty" }
  /** One character, from a literal, a class escape or a `[…]` class. */
  | { readonly kind: "char"; readonly set: CharSet }
  /** `^`, `$`, `\b` and `\B`. They match a position and no character. */
  | { readonly kind: "anchor" }
  | { readonly kind: "look"; readonly body: Node }
  | { readonly kind: "concat"; readonly parts: ReadonlyArray<Node> }
  | { readonly kind: "alt"; readonly branches: ReadonlyArray<Node> }
  | {
    readonly kind: "repeat";
    readonly body: Node;
    readonly min: number;
    readonly max: number;
  };

const EMPTY_NODE: Node = { kind: "empty" };
const ANCHOR_NODE: Node = { kind: "anchor" };

// ---------------------------------------------------------------------------
// The parser
// ---------------------------------------------------------------------------

/** One element inside a `[…]` class. `open` is an element we cannot list. */
type ClassItem =
  | { readonly kind: "char"; readonly code: number }
  | { readonly kind: "class"; readonly name: ClassName }
  | { readonly kind: "open" };

const OPEN_ITEM: ClassItem = { kind: "open" };

type ParseOutcome =
  | { readonly ok: true; readonly node: Node }
  | { readonly ok: false; readonly reason: string };

/** `{2}`, `{2,}` and `{2,4}`. Anything else after a `{` is a literal `{`. */
const COUNTED = /^\{(\d+)(?:,(\d*))?\}/;

const HEX = /^[0-9a-fA-F]+$/;

const readHex = (text: string): Option.Option<number> =>
  HEX.test(text) ? Option.some(Number.parseInt(text, 16)) : Option.none();

/**
 * Parse `source` into a tree.
 *
 * The caller compiled the same text with `new RegExp` first, so the text is
 * valid. Syntax that this parser does not know is therefore not a fault of the
 * user: it is a limit of the check, and the pattern is refused.
 */
const parse = (
  source: string,
  dotAll: boolean,
  unicode: boolean,
): ParseOutcome => {
  let index = 0;
  let failure: string | null = null;
  let assertions = 0;

  const fail = (reason: string): Node => {
    failure ??= reason;
    return EMPTY_NODE;
  };

  /**
   * The character at `index`, and the step over it.
   *
   * With the `u` flag the engine reads one code point, so `😀+` repeats one
   * character. Without the flag it reads two code units, and `😀+` repeats the
   * second one. The model must say what the engine does.
   */
  const readCodePoint = (): number => {
    const point = unicode
      ? source.codePointAt(index) ?? 0
      : source.charCodeAt(index);
    index += point > 0xffff ? 2 : 1;
    return point;
  };

  const parseEscapeItem = (): ClassItem => {
    const char = source[index];
    if (char === undefined) {
      fail(UNSUPPORTED_SYNTAX);
      return OPEN_ITEM;
    }
    index++;
    switch (char) {
      case "d":
      case "D":
      case "w":
      case "W":
      case "s":
      case "S":
        return { kind: "class", name: char };
      case "n":
        return { kind: "char", code: 0x0a };
      case "r":
        return { kind: "char", code: 0x0d };
      case "t":
        return { kind: "char", code: 0x09 };
      case "f":
        return { kind: "char", code: 0x0c };
      case "v":
        return { kind: "char", code: 0x0b };
      case "x": {
        const code = readHex(source.slice(index, index + 2));
        if (Option.isNone(code)) {
          fail(UNSUPPORTED_SYNTAX);
          return OPEN_ITEM;
        }
        index += 2;
        return { kind: "char", code: code.value };
      }
      case "u": {
        if (source[index] === "{") {
          // `\u{41}` is one character with the `u` flag, and the five literal
          // characters `u{41}` without it. Refuse the second reading: a model
          // that does not match the engine is not a safe model.
          if (!unicode) {
            fail(LONG_ESCAPE);
            return OPEN_ITEM;
          }
          const close = source.indexOf("}", index);
          if (close === -1) {
            fail(UNSUPPORTED_SYNTAX);
            return OPEN_ITEM;
          }
          const code = readHex(source.slice(index + 1, close));
          index = close + 1;
          return Option.isNone(code)
            ? OPEN_ITEM
            : { kind: "char", code: code.value };
        }
        const code = readHex(source.slice(index, index + 4));
        if (Option.isNone(code)) {
          fail(UNSUPPORTED_SYNTAX);
          return OPEN_ITEM;
        }
        index += 4;
        return { kind: "char", code: code.value };
      }
      case "c": {
        const letter = source[index];
        if (letter === undefined || !/[A-Za-z]/.test(letter)) return OPEN_ITEM;
        index++;
        return { kind: "char", code: letter.charCodeAt(0) % 32 };
      }
      case "p":
      case "P": {
        // A property escape such as `\p{L}`. It is one character with the `u`
        // flag, and the four literal characters `p{L}` without it. Refuse the
        // second reading, so that the model always says what the engine does.
        if (!unicode) {
          fail(PROPERTY_ESCAPE);
          return OPEN_ITEM;
        }
        // We cannot list the members of the property.
        if (source[index] === "{") {
          const close = source.indexOf("}", index);
          index = close === -1 ? source.length : close + 1;
        }
        return OPEN_ITEM;
      }
      default:
        return { kind: "char", code: char.charCodeAt(0) };
    }
  };

  /** One element of a `[…]` class: an escape, or one plain character. */
  const readClassItem = (): ClassItem => {
    if (source[index] === "\\") {
      index++;
      return parseEscapeItem();
    }
    return { kind: "char", code: readCodePoint() };
  };

  const parseClass = (): Node => {
    index++;
    let negated = false;
    if (source[index] === "^") {
      negated = true;
      index++;
    }

    const chars = new Set<number>();
    const ranges: Array<readonly [number, number]> = [];
    const classes = new Set<ClassName>();
    let open = false;

    while (index < source.length && source[index] !== "]") {
      const item = readClassItem();
      if (failure !== null) return EMPTY_NODE;

      if (item.kind !== "char") {
        if (item.kind === "class") classes.add(item.name);
        else open = true;
        continue;
      }

      const dash = source[index] === "-" && source[index + 1] !== undefined &&
        source[index + 1] !== "]";
      if (!dash) {
        chars.add(item.code);
        continue;
      }

      index++;
      const upper = readClassItem();
      if (failure !== null) return EMPTY_NODE;

      if (upper.kind === "char") {
        ranges.push([item.code, upper.code]);
        continue;
      }
      // `[a-\d]` is a literal dash between two elements.
      chars.add(item.code);
      chars.add(0x2d);
      if (upper.kind === "class") classes.add(upper.name);
      else open = true;
    }

    if (source[index] !== "]") return fail(UNSUPPORTED_SYNTAX);
    index++;
    const set: CharSet = open
      ? ANY_SET
      : { negated, chars, ranges, classes };
    return { kind: "char", set };
  };

  const parseEscape = (): Node => {
    index++;
    const char = source[index];
    if (char === undefined) return fail(UNSUPPORTED_SYNTAX);
    if (char === "b" || char === "B") {
      index++;
      return ANCHOR_NODE;
    }
    // A backreference repeats an earlier group, so the engine can revisit the
    // same position with a different group content.
    if (char === "k" || (char >= "1" && char <= "9")) {
      return fail(BACKREFERENCE);
    }
    const item = parseEscapeItem();
    switch (item.kind) {
      case "char":
        return { kind: "char", set: oneChar(item.code) };
      case "class":
        return { kind: "char", set: oneClass(item.name) };
      case "open":
        return { kind: "char", set: ANY_SET };
    }
  };

  const parseGroup = (): Node => {
    index++;
    let look = false;
    if (source[index] === "?") {
      const next = source[index + 1];
      if (next === ":") {
        index += 2;
      } else if (next === "=" || next === "!") {
        index += 2;
        look = true;
      } else if (next === "<") {
        const third = source[index + 2];
        if (third === "=" || third === "!") {
          index += 3;
          look = true;
        } else {
          const close = source.indexOf(">", index + 2);
          if (close === -1) return fail(UNSUPPORTED_SYNTAX);
          index = close + 1;
        }
      } else {
        return fail(UNSUPPORTED_SYNTAX);
      }
    }

    const body = parseAlternation();
    if (failure !== null) return EMPTY_NODE;
    if (source[index] !== ")") return fail(UNSUPPORTED_SYNTAX);
    index++;
    if (!look) return body;
    // The blunt limit. The cost model below reads inside an assertion, and a
    // long chain of assertions is the shape that a wrong answer there costs
    // the most. Refuse the chain, and say so.
    assertions++;
    if (assertions > ASSERTION_LIMIT) return fail(MANY_ASSERTIONS);
    return { kind: "look", body };
  };

  const parseAtom = (): Node => {
    const char = source[index];
    if (char === undefined) return fail(UNSUPPORTED_SYNTAX);
    switch (char) {
      case "(":
        return parseGroup();
      case "[":
        return parseClass();
      case "\\":
        return parseEscape();
      case ".":
        index++;
        return { kind: "char", set: dotAll ? ANY_SET : DOT_SET };
      case "^":
      case "$":
        index++;
        return ANCHOR_NODE;
      case "*":
      case "+":
      case "?":
        return fail(UNSUPPORTED_SYNTAX);
      default:
        return { kind: "char", set: oneChar(readCodePoint()) };
    }
  };

  const parseQuantifier = (atom: Node): Node => {
    const char = source[index];
    let min: number;
    let max: number;

    if (char === "*") {
      min = 0;
      max = Number.POSITIVE_INFINITY;
      index++;
    } else if (char === "+") {
      min = 1;
      max = Number.POSITIVE_INFINITY;
      index++;
    } else if (char === "?") {
      min = 0;
      max = 1;
      index++;
    } else if (char === "{") {
      const counted = COUNTED.exec(source.slice(index));
      if (counted === null) return atom;
      min = Number.parseInt(counted[1] ?? "0", 10);
      const high = counted[2];
      max = high === undefined
        ? min
        : high.length === 0
        ? Number.POSITIVE_INFINITY
        : Number.parseInt(high, 10);
      index += counted[0].length;
    } else {
      return atom;
    }

    // A lazy quantifier backtracks in the other order, and just as long.
    if (source[index] === "?") index++;
    return { kind: "repeat", body: atom, min, max };
  };

  const parseConcat = (): Node => {
    const parts: Node[] = [];
    while (index < source.length) {
      const char = source[index];
      if (char === "|" || char === ")") break;
      parts.push(parseQuantifier(parseAtom()));
      if (failure !== null) return EMPTY_NODE;
    }
    if (parts.length === 0) return EMPTY_NODE;
    return parts.length === 1 ? parts[0] ?? EMPTY_NODE : {
      kind: "concat",
      parts,
    };
  };

  function parseAlternation(): Node {
    const branches: Node[] = [parseConcat()];
    while (failure === null && source[index] === "|") {
      index++;
      branches.push(parseConcat());
    }
    if (failure !== null) return EMPTY_NODE;
    return branches.length === 1 ? branches[0] ?? EMPTY_NODE : {
      kind: "alt",
      branches,
    };
  }

  const node = parseAlternation();
  if (failure !== null) return { ok: false, reason: failure };
  if (index < source.length) return { ok: false, reason: UNSUPPORTED_SYNTAX };
  return { ok: true, node };
};

// ---------------------------------------------------------------------------
// The attributes of a tree
// ---------------------------------------------------------------------------

interface Span {
  readonly min: number;
  readonly max: number;
}

/** The most character sets that one fixed shape holds. */
const SEQUENCE_LIMIT = 64;

/**
 * The most lookaheads and lookbehinds that one pattern may hold.
 *
 * This is a blunt limit, and it does not need the model below to be right. An
 * assertion holds an expression that runs, so a long chain of them is the
 * shape where a wrong answer from the model costs the most. A pattern that a
 * user writes holds a few assertions, and never a chain of this length.
 */
const ASSERTION_LIMIT = 8;

/**
 * The most positions that one quantifier can try inside one window of text.
 *
 * Each caller reads a bounded piece of text: `~/domain/Exclusion.ts` caps the
 * URL, and `~/features/find/Engine.ts` reads the page in windows. A quantifier
 * whose count can vary by more than this value is therefore unbounded in
 * practice, and the check reads it as unbounded.
 */
const WINDOW_WIDTH = 1024;

/**
 * The most ways that one pattern may try to match one piece of text.
 *
 * One unbounded quantifier that competes with the text after it costs one
 * window, and the budget of the caller pays for that. Two of them cost a
 * window times a window. `a.*b.*c` and `.*(?=.*x)` are both that shape.
 */
const PATH_BUDGET = WINDOW_WIDTH;

/**
 * Every answer that the rules ask about one tree.
 *
 * The answers depend on the `i` flag, so one analysis belongs to one call. Each
 * answer is kept in a map, because a rule asks the same question about the same
 * node many times.
 */
interface Analysis {
  /** Can this expression match an empty string? */
  readonly nullable: (node: Node) => boolean;
  /** The shortest and the longest string that this expression matches. */
  readonly span: (node: Node) => Span;
  /** Can this expression match two strings of different lengths? */
  readonly flexible: (node: Node) => boolean;
  /** The characters that a match can start with. */
  readonly first: (node: Node) => CharSet;
  /** The characters that a match can end with. */
  readonly last: (node: Node) => CharSet;
  /** Every character that a match can hold, at any position. */
  readonly anywhere: (node: Node) => CharSet;
  /**
   * How many ways this expression can try to match one piece of text.
   *
   * The number counts the choices that the text can make, and not the
   * characters that the expression reads. A value of `1` means that one text
   * gives one path. `WINDOW_WIDTH` means that one unbounded quantifier can
   * stop at every position of a window.
   */
  readonly cost: (node: Node) => number;
  /**
   * The characters that can make a match longer.
   *
   * A member `c` means: this expression matches some text `u`, and it also
   * matches `u` followed by `c` and more. `a+` gives `a`, because `a` matches
   * and `aa` matches. `\w+\.` gives nothing, because every match ends at the
   * one dot that it holds.
   */
  readonly extend: (node: Node) => CharSet;
  /** The fixed shape of this expression, when it has one. */
  readonly sequence: (node: Node) => Option.Option<ReadonlyArray<CharSet>>;
  /** Can the boundary between `left` and the parts from `from` move? */
  readonly slidesInto: (
    left: Node,
    parts: ReadonlyArray<Node>,
    from: number,
  ) => boolean;
  /** Can one character belong to both sets? */
  readonly intersect: (left: CharSet, right: CharSet) => boolean;
}

const makeAnalysis = (ignoreCase: boolean): Analysis => {
  const nullableCache = new Map<Node, boolean>();
  const spanCache = new Map<Node, Span>();
  const firstCache = new Map<Node, CharSet>();
  const lastCache = new Map<Node, CharSet>();
  const anywhereCache = new Map<Node, CharSet>();
  const extendCache = new Map<Node, CharSet>();
  const costCache = new Map<Node, number>();
  const sequenceCache = new Map<
    Node,
    Option.Option<ReadonlyArray<CharSet>>
  >();

  const memo = <T>(
    cache: Map<Node, T>,
    node: Node,
    make: (node: Node) => T,
  ): T => {
    const found = cache.get(node);
    if (found !== undefined) return found;
    const value = make(node);
    cache.set(node, value);
    return value;
  };

  const intersect = (left: CharSet, right: CharSet): boolean =>
    setsIntersect(left, right, ignoreCase);

  const nullable = (node: Node): boolean =>
    memo(nullableCache, node, (target) => {
      switch (target.kind) {
        case "empty":
        case "anchor":
        case "look":
          return true;
        case "char":
          return false;
        case "concat":
          return target.parts.every(nullable);
        case "alt":
          return target.branches.some(nullable);
        case "repeat":
          return target.min === 0 || nullable(target.body);
      }
    });

  const span = (node: Node): Span =>
    memo(spanCache, node, (target) => {
      switch (target.kind) {
        case "empty":
        case "anchor":
        case "look":
          return { min: 0, max: 0 };
        case "char":
          return { min: 1, max: 1 };
        case "concat":
          return spanOfParts(target.parts, 0);
        case "alt": {
          if (target.branches.length === 0) return { min: 0, max: 0 };
          let min = Number.POSITIVE_INFINITY;
          let max = 0;
          for (const branch of target.branches) {
            const reach = span(branch);
            min = Math.min(min, reach.min);
            max = Math.max(max, reach.max);
          }
          return { min, max };
        }
        case "repeat": {
          const reach = span(target.body);
          const max = reach.max === 0
            ? 0
            : target.max === Number.POSITIVE_INFINITY
            ? Number.POSITIVE_INFINITY
            : reach.max * target.max;
          return { min: reach.min * target.min, max };
        }
      }
    });

  const spanOfParts = (
    parts: ReadonlyArray<Node>,
    from: number,
  ): Span => {
    let min = 0;
    let max = 0;
    for (let index = from; index < parts.length; index++) {
      const part = parts[index];
      if (part === undefined) continue;
      const reach = span(part);
      min += reach.min;
      max += reach.max;
    }
    return { min, max };
  };

  const flexible = (node: Node): boolean => {
    const reach = span(node);
    return reach.min !== reach.max;
  };

  const first = (node: Node): CharSet =>
    memo(firstCache, node, (target) => {
      switch (target.kind) {
        case "empty":
        case "anchor":
          return EMPTY_SET;
        // An assertion reads the text that follows it, or the text before it.
        // Its body therefore competes with the neighbours of the assertion,
        // and its characters must take part in every neighbour test.
        case "look":
          return first(target.body);
        case "char":
          return target.set;
        case "concat":
          return firstOfParts(target.parts, 0);
        case "alt":
          return target.branches.reduce(
            (set, branch) => unionSets(set, first(branch)),
            EMPTY_SET,
          );
        case "repeat":
          return target.max === 0 ? EMPTY_SET : first(target.body);
      }
    });

  const firstOfParts = (
    parts: ReadonlyArray<Node>,
    from: number,
  ): CharSet => {
    let set = EMPTY_SET;
    for (let index = from; index < parts.length; index++) {
      const part = parts[index];
      if (part === undefined) continue;
      set = unionSets(set, first(part));
      if (!nullable(part)) break;
    }
    return set;
  };

  const last = (node: Node): CharSet =>
    memo(lastCache, node, (target) => {
      switch (target.kind) {
        case "empty":
        case "anchor":
          return EMPTY_SET;
        case "look":
          return last(target.body);
        case "char":
          return target.set;
        case "concat": {
          let set = EMPTY_SET;
          for (let index = target.parts.length - 1; index >= 0; index--) {
            const part = target.parts[index];
            if (part === undefined) continue;
            set = unionSets(set, last(part));
            if (!nullable(part)) break;
          }
          return set;
        }
        case "alt":
          return target.branches.reduce(
            (set, branch) => unionSets(set, last(branch)),
            EMPTY_SET,
          );
        case "repeat":
          return target.max === 0 ? EMPTY_SET : last(target.body);
      }
    });

  const anywhere = (node: Node): CharSet =>
    memo(anywhereCache, node, (target) => {
      switch (target.kind) {
        case "empty":
        case "anchor":
          return EMPTY_SET;
        case "look":
          return anywhere(target.body);
        case "char":
          return target.set;
        case "concat":
          return anywhereOfParts(target.parts, 0);
        case "alt":
          return target.branches.reduce(
            (set, branch) => unionSets(set, anywhere(branch)),
            EMPTY_SET,
          );
        case "repeat":
          return target.max === 0 ? EMPTY_SET : anywhere(target.body);
      }
    });

  const anywhereOfParts = (
    parts: ReadonlyArray<Node>,
    from: number,
  ): CharSet => {
    let set = EMPTY_SET;
    for (let index = from; index < parts.length; index++) {
      const part = parts[index];
      if (part === undefined) continue;
      set = unionSets(set, anywhere(part));
    }
    return set;
  };

  const sequence = (
    node: Node,
  ): Option.Option<ReadonlyArray<CharSet>> =>
    memo(sequenceCache, node, (target) => {
      switch (target.kind) {
        case "empty":
        case "anchor":
          return Option.some([]);
        // A lookaround adds a condition that a list of sets cannot hold.
        case "look":
          return Option.none();
        case "char":
          return Option.some([target.set]);
        case "concat": {
          const sets: CharSet[] = [];
          for (const part of target.parts) {
            const shape = sequence(part);
            if (Option.isNone(shape)) return Option.none();
            if (sets.length + shape.value.length > SEQUENCE_LIMIT) {
              return Option.none();
            }
            sets.push(...shape.value);
          }
          return Option.some(sets);
        }
        case "alt": {
          const shapes: ReadonlyArray<CharSet>[] = [];
          for (const branch of target.branches) {
            const shape = sequence(branch);
            if (Option.isNone(shape)) return Option.none();
            shapes.push([...shape.value]);
          }
          const head = shapes[0];
          if (head === undefined) return Option.none();
          if (shapes.some((shape) => shape.length !== head.length)) {
            return Option.none();
          }
          // The union loses which branch gave which set, so the shape holds
          // more strings than the alternation does. That direction refuses
          // more, and never fewer.
          return Option.some(
            head.map((_, position) =>
              shapes.reduce(
                (set, shape) => unionSets(set, shape[position] ?? EMPTY_SET),
                EMPTY_SET,
              )
            ),
          );
        }
        case "repeat": {
          if (target.min !== target.max) return Option.none();
          const shape = sequence(target.body);
          if (Option.isNone(shape)) return Option.none();
          if (shape.value.length * target.min > SEQUENCE_LIMIT) {
            return Option.none();
          }
          const sets: CharSet[] = [];
          for (let round = 0; round < target.min; round++) {
            sets.push(...shape.value);
          }
          return Option.some(sets);
        }
      }
    });

  /**
   * The characters that branch `left` can be followed by inside branch
   * `right`.
   *
   * `a|aa` gives `a`: the first branch matches `a`, and the second matches
   * `aa`, so a match of the alternation can grow. `a|ab` gives `b`, and
   * `cat|car` gives nothing, because neither shape starts the other one.
   */
  const crossExtend = (left: Node, right: Node): CharSet => {
    let set = EMPTY_SET;
    if (nullable(left) && span(right).max > 0) {
      set = unionSets(set, first(right));
    }
    const shapeLeft = sequence(left);
    const shapeRight = sequence(right);
    if (Option.isSome(shapeLeft) && Option.isSome(shapeRight)) {
      const short = shapeLeft.value;
      const long = shapeRight.value;
      if (short.length >= long.length) return set;
      for (let position = 0; position < short.length; position++) {
        const one = short[position];
        const other = long[position];
        if (one === undefined || other === undefined) return set;
        if (!intersect(one, other)) return set;
      }
      return unionSets(set, long[short.length] ?? EMPTY_SET);
    }
    // One of the two shapes is unknown. Say that any character can follow,
    // unless the two branches cannot even start with one character.
    return intersect(first(left), first(right)) ? ANY_SET : set;
  };

  const extend = (node: Node): CharSet =>
    memo(extendCache, node, (target) => {
      switch (target.kind) {
        case "empty":
        case "anchor":
        case "look":
        case "char":
          return EMPTY_SET;
        case "concat": {
          let set = EMPTY_SET;
          // A match ends inside the last part that is not empty. That part can
          // grow, and every part after it can stop being empty.
          for (let index = target.parts.length - 1; index >= 0; index--) {
            const part = target.parts[index];
            if (part === undefined) continue;
            set = unionSets(set, extend(part));
            set = unionSets(set, firstOfParts(target.parts, index + 1));
            if (!nullable(part)) break;
          }
          // A part in the middle can also grow, when the parts after it can
          // start one character later. The match then ends one character
          // later, and this module cannot say with which character.
          for (let index = 0; index < target.parts.length - 1; index++) {
            const part = target.parts[index];
            if (part === undefined) continue;
            if (slidesInto(part, target.parts, index + 1)) return ANY_SET;
          }
          return set;
        }
        case "alt": {
          let set = EMPTY_SET;
          for (const branch of target.branches) {
            set = unionSets(set, extend(branch));
          }
          for (const left of target.branches) {
            for (const right of target.branches) {
              if (left === right) continue;
              set = unionSets(set, crossExtend(left, right));
            }
          }
          return set;
        }
        case "repeat": {
          if (target.max === 0) return EMPTY_SET;
          const set = extend(target.body);
          // One more iteration can follow a complete match, unless the count
          // is fixed.
          return target.max > target.min
            ? unionSets(set, first(target.body))
            : set;
        }
      }
    });

  /**
   * Can the boundary between `left` and the parts from `from` move?
   *
   * Two conditions must hold. `left` must be able to take the character that
   * the parts after it would start with. Those parts must also be able to hold
   * the character that `left` ends with, because the text that `left` takes is
   * text that they gave back.
   *
   * `\w+\.` and `\w+` do not slide: the first ends at a dot, and the second
   * holds no dot. `[a-z]*` and `x` do slide.
   */
  const slidesInto = (
    left: Node,
    parts: ReadonlyArray<Node>,
    from: number,
  ): boolean =>
    intersect(extend(left), firstOfParts(parts, from)) &&
    intersect(last(left), anywhereOfParts(parts, from));

  /** A product that can never grow past the point where it is refused. */
  const capped = (value: number): number =>
    Math.min(value, PATH_BUDGET * PATH_BUDGET);

  /**
   * How many end positions this expression can try.
   *
   * A part whose length cannot vary has one end. `a{0,3}` has four, and `a*`
   * has one for every position of a window.
   */
  const width = (node: Node): number => {
    const reach = span(node);
    const range = reach.max - reach.min;
    return range >= WINDOW_WIDTH ? WINDOW_WIDTH : Math.max(1, range);
  };

  const cost = (node: Node): number =>
    memo(costCache, node, (target) => {
      switch (target.kind) {
        case "empty":
        case "anchor":
        case "char":
          return 1;
        // An assertion runs its body at one position. The body pays its own
        // cost, and the concatenation below multiplies that cost by the ways
        // that the text before the assertion can match.
        case "look":
          return cost(target.body);
        case "alt":
          return target.branches.reduce(
            (most, branch) => Math.max(most, cost(branch)),
            1,
          );
        case "concat":
          return costOfParts(target.parts);
        case "repeat": {
          if (target.max <= 1) return cost(target.body);
          const inner = cost(target.body);
          // Where the loop stops is a choice of the part before it, and the
          // concatenation counts that choice. Only the work inside the body
          // is paid again for each iteration.
          return inner <= 1 ? 1 : capped(inner * width(target));
        }
      }
    });

  /**
   * The cost of a concatenation.
   *
   * Each part that can slide gives the text a choice, and every part after it
   * runs again for each of those choices. The cost of the whole is therefore
   * the product of the choices, and the worst part is the one that runs after
   * the most of them.
   */
  const costOfParts = (parts: ReadonlyArray<Node>): number => {
    let before = 1;
    let worst = 1;
    for (let index = 0; index < parts.length; index++) {
      const part = parts[index];
      if (part === undefined) continue;
      worst = Math.max(worst, capped(before * cost(part)));
      if (slidesInto(part, parts, index + 1)) {
        before = capped(before * width(part));
      }
    }
    return Math.max(worst, before);
  };

  return {
    nullable,
    span,
    flexible,
    first,
    last,
    anywhere,
    cost,
    extend,
    sequence,
    slidesInto,
    intersect,
  };
};

// ---------------------------------------------------------------------------
// The rules
// ---------------------------------------------------------------------------

/**
 * Two neighbours that both flex, and that compete for the same characters.
 *
 * `\s+\s+`, `a*a*b` and `a?a?a?…` are the shape. Each division of the input
 * between the two neighbours is a path that the engine tries, so the work grows
 * with a power of the length. The walk to the right stops after the first
 * neighbour that must match a character, because that neighbour separates the
 * pair.
 */
const hasCompetingNeighbours = (
  parts: ReadonlyArray<Node>,
  analysis: Analysis,
): boolean => {
  for (let left = 0; left < parts.length; left++) {
    const one = parts[left];
    if (one === undefined || !analysis.flexible(one)) continue;
    for (let right = left + 1; right < parts.length; right++) {
      const other = parts[right];
      if (other === undefined) continue;
      if (
        analysis.flexible(other) &&
        analysis.intersect(analysis.extend(one), analysis.first(other)) &&
        analysis.intersect(analysis.last(one), analysis.anywhere(other))
      ) {
        return true;
      }
      if (!analysis.nullable(other)) break;
    }
  }
  return false;
};

/**
 * Two alternatives that can match one text.
 *
 * Then the engine has two paths through one alternation, and a loop around it
 * doubles the number of paths with every iteration. `cat|car` is safe, because
 * the third character keeps the two apart. `a|a` is not.
 *
 * Inside a loop the rule also refuses a pair whose shape this module cannot
 * read, when the two can start with the same character. Outside a loop such a
 * pair costs one extra step, so the rule lets it pass.
 */
const hasAmbiguousBranches = (
  branches: ReadonlyArray<Node>,
  inLoop: boolean,
  analysis: Analysis,
): boolean => {
  const share = (left: Node, right: Node): boolean => {
    const shapeLeft = analysis.sequence(left);
    const shapeRight = analysis.sequence(right);
    if (Option.isSome(shapeLeft) && Option.isSome(shapeRight)) {
      if (shapeLeft.value.length !== shapeRight.value.length) return false;
      return shapeLeft.value.every((set, position) => {
        const other = shapeRight.value[position];
        return other !== undefined && analysis.intersect(set, other);
      });
    }
    return inLoop &&
      analysis.intersect(analysis.first(left), analysis.first(right));
  };

  for (let left = 0; left < branches.length; left++) {
    const one = branches[left];
    if (one === undefined) continue;
    for (let right = left + 1; right < branches.length; right++) {
      const other = branches[right];
      if (other === undefined) continue;
      if (share(one, other)) return true;
    }
  }
  return false;
};

const check = (
  node: Node,
  inLoop: boolean,
  analysis: Analysis,
): Option.Option<string> => {
  switch (node.kind) {
    case "empty":
    case "anchor":
    case "char":
      return Option.none();

    case "look":
      // A lookaround runs at a position and gives back no text, so its cost
      // adds to the cost of the walk. It does not multiply it. The body is
      // therefore held to the same rules as any other expression.
      return check(node.body, inLoop, analysis);

    case "concat": {
      if (hasCompetingNeighbours(node.parts, analysis)) {
        return Option.some(COMPETING_LOOPS);
      }
      for (const part of node.parts) {
        const problem = check(part, inLoop, analysis);
        if (Option.isSome(problem)) return problem;
      }
      return Option.none();
    }

    case "alt": {
      if (hasAmbiguousBranches(node.branches, inLoop, analysis)) {
        return Option.some(AMBIGUOUS_BRANCHES);
      }
      for (const branch of node.branches) {
        const problem = check(branch, inLoop, analysis);
        if (Option.isSome(problem)) return problem;
      }
      return Option.none();
    }

    case "repeat": {
      if (node.max <= 1) return check(node.body, inLoop, analysis);
      // A body that matches nothing can iterate for ever at one position.
      if (analysis.nullable(node.body)) return Option.some(EMPTY_LOOP);
      // A body that can grow past its own end divides one text into
      // iterations in more than one way. `(a+)+` is the known shape.
      if (
        analysis.intersect(
          analysis.extend(node.body),
          analysis.first(node.body),
        )
      ) {
        return Option.some(AMBIGUOUS_LOOP);
      }
      return check(node.body, true, analysis);
    }
  }
};

// ---------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------

/**
 * The longest pattern that this module reads.
 *
 * The work of the check grows with the size of the tree. Both callers already
 * cap the pattern below this limit, so the limit is the third limit on the
 * same value.
 */
export const MAX_PATTERN_LENGTH = 2048;

/**
 * Why is this expression unsafe to run against text that a page controls?
 *
 * A `Some` carries a reason that a user can read. A `None` means that the check
 * found no proof of ambiguity. Read the head of this module for what that does,
 * and does not, promise. The caller must still hold a budget.
 *
 * `source` and `flags` are the two arguments of `new RegExp`. Compile the
 * expression first: a source that does not compile gives a reason here that
 * says nothing about the true fault.
 */
export const regexSafetyError = (
  source: string,
  flags: string,
): Option.Option<string> => {
  if (source.length > MAX_PATTERN_LENGTH) return Option.some(TOO_LONG);
  const outcome = parse(source, flags.includes("s"), flags.includes("u"));
  if (!outcome.ok) return Option.some(outcome.reason);

  const analysis = makeAnalysis(flags.includes("i"));
  const problem = check(outcome.node, false, analysis);
  if (Option.isSome(problem)) return problem;
  // The last rule counts the ways that one piece of text can be divided
  // between the parts of the pattern. It reads inside an assertion as well,
  // so `.*(?=.*x)` costs as much as `a.*b.*c` and is refused with it.
  return analysis.cost(outcome.node) > PATH_BUDGET
    ? Option.some(MANY_LOOPS)
    : Option.none();
};

/** Is this expression free of the ambiguity that this module can prove? */
export const isLinearRegex = (source: string, flags: string): boolean =>
  Option.isNone(regexSafetyError(source, flags));
