/**
 * A static safety check for a regular expression that a user wrote.
 *
 * The platform gives one regular expression engine, and that engine
 * backtracks. A pattern such as `(a|a|a|a)*$` against twenty characters takes
 * minutes, and no code in JavaScript can stop an `exec` that is inside such a
 * pattern. The tab is lost.
 *
 * A measurement cannot protect the page, because the measurement is the hang:
 * the time is known only after the expression returns. This module therefore
 * decides on the *text* of the pattern, before any input touches it. It parses
 * the source and permits only the syntax whose match is linear in the length
 * of the input:
 *
 * - a quantifier never contains another quantifier;
 * - a quantifier never repeats an expression that can match nothing;
 * - a quantifier repeats an expression of one fixed length;
 * - two alternatives inside a quantifier never start with the same character;
 * - two quantifiers that can match the same characters never stand together;
 * - a backreference is refused;
 * - a lookaround holds no quantifier.
 *
 * Each rule removes one way to make a position ambiguous. With no ambiguity
 * the engine has one path through the pattern at each position, so the work is
 * proportional to the input.
 *
 * The check refuses more than it must. That direction is the safe one: a
 * refused pattern costs the user one search, and an accepted bad pattern costs
 * the user the tab. The refusal comes with a reason, so the HUD can say what
 * is wrong while the user still types.
 *
 * Everything here is a pure function of the pattern text. Nothing throws.
 */

import { Option } from "effect";

// ---------------------------------------------------------------------------
// The reasons
// ---------------------------------------------------------------------------

const UNSUPPORTED_SYNTAX =
  "this pattern uses syntax that the safety check does not know";
const BACKREFERENCE = "a backreference can hang the page";
const NESTED_LOOP = "a quantifier inside another quantifier can hang the page";
const EMPTY_LOOP =
  "a quantifier over an expression that matches nothing can hang the page";
const VARIABLE_LOOP =
  "a quantifier over an expression of two lengths can hang the page";
const AMBIGUOUS_BRANCHES =
  "a quantifier over two alternatives with the same start can hang the page";
const COMPETING_LOOPS =
  "two quantifiers that match the same characters can hang the page";
const LOOKAROUND_LOOP = "a quantifier inside a lookaround can hang the page";

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

/**
 * List the members of `set`, when there are few enough of them.
 *
 * A `None` means "too many, or an unlimited number". A negated set and `\D`,
 * `\W` and `\S` are unlimited.
 */
const members = (set: CharSet): Option.Option<ReadonlyArray<number>> => {
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
const parse = (source: string, dotAll: boolean): ParseOutcome => {
  let index = 0;
  let failure: string | null = null;

  const fail = (reason: string): Node => {
    failure ??= reason;
    return EMPTY_NODE;
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
        // A property escape such as `\p{L}`. We cannot list its members.
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
    const code = source.charCodeAt(index);
    index++;
    return { kind: "char", code };
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
    return look ? { kind: "look", body } : body;
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
        index++;
        return { kind: "char", set: oneChar(char.charCodeAt(0)) };
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

/** Can this expression match an empty string? */
const isNullable = (node: Node): boolean => {
  switch (node.kind) {
    case "empty":
    case "anchor":
    case "look":
      return true;
    case "char":
      return false;
    case "concat":
      return node.parts.every(isNullable);
    case "alt":
      return node.branches.some(isNullable);
    case "repeat":
      return node.min === 0 || isNullable(node.body);
  }
};

interface Span {
  readonly min: number;
  readonly max: number;
}

/** The shortest and the longest string that this expression matches. */
const spanOf = (node: Node): Span => {
  switch (node.kind) {
    case "empty":
    case "anchor":
    case "look":
      return { min: 0, max: 0 };
    case "char":
      return { min: 1, max: 1 };
    case "concat": {
      let min = 0;
      let max = 0;
      for (const part of node.parts) {
        const span = spanOf(part);
        min += span.min;
        max += span.max;
      }
      return { min, max };
    }
    case "alt": {
      let min = Number.POSITIVE_INFINITY;
      let max = 0;
      for (const branch of node.branches) {
        const span = spanOf(branch);
        min = Math.min(min, span.min);
        max = Math.max(max, span.max);
      }
      return node.branches.length === 0 ? { min: 0, max: 0 } : { min, max };
    }
    case "repeat": {
      const span = spanOf(node.body);
      const max = span.max === 0
        ? 0
        : node.max === Number.POSITIVE_INFINITY
        ? Number.POSITIVE_INFINITY
        : span.max * node.max;
      return { min: span.min * node.min, max };
    }
  }
};

/** The characters that this expression can start with. */
const firstOf = (node: Node): CharSet => {
  switch (node.kind) {
    case "empty":
    case "anchor":
    case "look":
      return EMPTY_SET;
    case "char":
      return node.set;
    case "concat": {
      let set = EMPTY_SET;
      for (const part of node.parts) {
        set = unionSets(set, firstOf(part));
        if (!isNullable(part)) break;
      }
      return set;
    }
    case "alt":
      return node.branches.reduce(
        (set, branch) => unionSets(set, firstOf(branch)),
        EMPTY_SET,
      );
    case "repeat":
      return node.max === 0 ? EMPTY_SET : firstOf(node.body);
  }
};

/** Does this expression hold a quantifier that can repeat? */
const hasLoop = (node: Node): boolean => {
  switch (node.kind) {
    case "empty":
    case "anchor":
    case "char":
      return false;
    case "look":
      return hasLoop(node.body);
    case "concat":
      return node.parts.some(hasLoop);
    case "alt":
      return node.branches.some(hasLoop);
    case "repeat":
      return node.max > 1 || hasLoop(node.body);
  }
};

/** Can this expression match nothing *and* something? */
const isOptional = (node: Node): boolean =>
  isNullable(node) && spanOf(node).max > 0;

// ---------------------------------------------------------------------------
// The rules
// ---------------------------------------------------------------------------

/**
 * Two neighbours that both may match nothing and may start with the same
 * character.
 *
 * `a*a*b` and `a?a?a?…` are the shape. Each split of the input between the two
 * neighbours is a path that the engine tries, so the work grows with a power
 * of the length. Only nullable expressions stand between the pair, because a
 * part that must match a character separates them.
 */
const hasCompetingNeighbours = (
  parts: ReadonlyArray<Node>,
  ignoreCase: boolean,
): boolean => {
  for (let left = 0; left < parts.length; left++) {
    const first = parts[left];
    if (first === undefined || !isOptional(first)) continue;
    for (let right = left + 1; right < parts.length; right++) {
      const second = parts[right];
      if (second === undefined || !isNullable(second)) break;
      if (
        isOptional(second) &&
        setsIntersect(firstOf(first), firstOf(second), ignoreCase)
      ) {
        return true;
      }
    }
  }
  return false;
};

/** Two alternatives that can start with the same character. */
const hasAmbiguousBranches = (
  branches: ReadonlyArray<Node>,
  ignoreCase: boolean,
): boolean => {
  for (let left = 0; left < branches.length; left++) {
    const first = branches[left];
    if (first === undefined) continue;
    for (let right = left + 1; right < branches.length; right++) {
      const second = branches[right];
      if (second === undefined) continue;
      if (setsIntersect(firstOf(first), firstOf(second), ignoreCase)) {
        return true;
      }
    }
  }
  return false;
};

const check = (
  node: Node,
  inLoop: boolean,
  ignoreCase: boolean,
): Option.Option<string> => {
  switch (node.kind) {
    case "empty":
    case "anchor":
    case "char":
      return Option.none();

    case "look":
      // A lookaround runs at every position, so its own cost multiplies the
      // cost of the walk. A body with no quantifier costs a constant.
      return hasLoop(node.body)
        ? Option.some(LOOKAROUND_LOOP)
        : check(node.body, inLoop, ignoreCase);

    case "concat": {
      if (hasCompetingNeighbours(node.parts, ignoreCase)) {
        return Option.some(COMPETING_LOOPS);
      }
      for (const part of node.parts) {
        const problem = check(part, inLoop, ignoreCase);
        if (Option.isSome(problem)) return problem;
      }
      return Option.none();
    }

    case "alt": {
      // Two alternatives with the same start are two paths through one
      // iteration, and the number of paths doubles with every iteration.
      if (inLoop && hasAmbiguousBranches(node.branches, ignoreCase)) {
        return Option.some(AMBIGUOUS_BRANCHES);
      }
      for (const branch of node.branches) {
        const problem = check(branch, inLoop, ignoreCase);
        if (Option.isSome(problem)) return problem;
      }
      return Option.none();
    }

    case "repeat": {
      if (node.max <= 1) return check(node.body, inLoop, ignoreCase);
      if (isNullable(node.body)) return Option.some(EMPTY_LOOP);
      if (hasLoop(node.body)) return Option.some(NESTED_LOOP);
      const span = spanOf(node.body);
      if (span.min !== span.max) return Option.some(VARIABLE_LOOP);
      return check(node.body, true, ignoreCase);
    }
  }
};

// ---------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------

/**
 * Why is this expression unsafe to run against text that a page controls?
 *
 * A `None` means that the match takes time proportional to the length of the
 * input. A `Some` carries a reason that a user can read.
 *
 * `source` and `flags` are the two arguments of `new RegExp`. Compile the
 * expression first: a source that does not compile gives a reason here that
 * says nothing about the true fault.
 */
export const regexSafetyError = (
  source: string,
  flags: string,
): Option.Option<string> => {
  const outcome = parse(source, flags.includes("s"));
  return outcome.ok
    ? check(outcome.node, false, flags.includes("i"))
    : Option.some(outcome.reason);
};

/** Is this expression safe to run against text that a page controls? */
export const isLinearRegex = (source: string, flags: string): boolean =>
  Option.isNone(regexSafetyError(source, flags));
