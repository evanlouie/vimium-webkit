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
 * match. `.*(?=.*x)` therefore costs a window times a window. The check refuses
 * it and `a.*b.*c`.
 *
 * A bounded repeat pays the cost of its body for each possible iteration. The
 * maximum count sets that cost. Saturating arithmetic stops the cost above the
 * limit. Thus, nested fixed repeats cannot hide a large constant cost.
 *
 * `(?=.*foo)(?=.*bar)` costs two windows. Nothing before the assertions can
 * vary, so the two costs are added and both assertions are accepted.
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

import {
  Array,
  Boolean,
  Chunk,
  Data,
  HashSet,
  Iterable,
  Match,
  Option,
  flow,
  pipe,
  Predicate,
  Record as Rec,
  Result,
  String as Str,
  Struct,
} from "effect";

// ---------------------------------------------------------------------------
// The reasons
// ---------------------------------------------------------------------------

const UNSUPPORTED_SYNTAX = "this pattern uses syntax that the safety check does not know";
const TOO_LONG = "this pattern is too long for the safety check";
const BACKREFERENCE = "a backreference can hang the page";
const EMPTY_LOOP = "a quantifier over an expression that matches nothing can hang the page";
const AMBIGUOUS_LOOP = "a quantifier whose body can grow past its own end can hang the page";
const AMBIGUOUS_BRANCHES = "two alternatives that match the same text can hang the page";
const COMPETING_LOOPS = "two quantifiers that match the same characters can hang the page";
const MANY_LOOPS =
  "this pattern can try too many ways to match one piece of text, " + "and that can hang the page";
const MANY_ASSERTIONS =
  "a pattern may hold at most eight lookaheads or lookbehinds; " +
  "divide the query into two searches";
const NESTED_ASSERTIONS =
  "an assertion may hold at most three nested assertions; simplify the " + "assertion";
const PROPERTY_ESCAPE =
  "a property escape such as `\\p{L}` needs the `u` flag, which this field " +
  "does not allow; write a character class such as `[a-zA-Z]` instead";
const LONG_ESCAPE =
  "`\\u{…}` needs the `u` flag, which this field does not allow; write " +
  "`\\uFFFF` with four digits instead";

/** A variant that carries no data. */
type Mark = Record<never, never>;

// ---------------------------------------------------------------------------
// Character sets
// ---------------------------------------------------------------------------

/** The most members that this module lists for one set. */
const MEMBER_LIMIT = 256;

/** The characters from `low` to `high`, both included. */
interface Range {
  readonly low: number;
  readonly high: number;
}

/** A class escape: `\d`, `\D`, `\w`, `\W`, `\s` or `\S`. */
interface ClassEscape {
  readonly holds: (code: number) => boolean;
  /** The members of the class. `\D`, `\W` and `\S` have too many to list. */
  readonly members: Option.Option<HashSet.HashSet<number>>;
}

/** The pieces that describe a set that this module does not list. */
interface Terms {
  readonly chars: HashSet.HashSet<number>;
  readonly ranges: ReadonlyArray<Range>;
  readonly classes: ReadonlyArray<ClassEscape>;
}

/**
 * The characters that one atom can match.
 *
 * A set of at most `MEMBER_LIMIT` characters lists them. A larger set keeps the
 * terms that describe it, and `Negated` inverts its terms, as `[^…]` does. A
 * set that the module cannot describe becomes `ANY_SET`, which intersects
 * everything and therefore refuses more.
 */
type CharSet = Data.TaggedEnum<{
  Listed: { readonly members: HashSet.HashSet<number> };
  Unlisted: Terms;
  Negated: Terms;
}>;
const CharSet = Data.taggedEnum<CharSet>();

const NO_TERMS: Terms = { chars: HashSet.empty(), ranges: [], classes: [] };

const EMPTY_SET: CharSet = CharSet.Listed({ members: HashSet.empty() });

const ANY_SET: CharSet = CharSet.Negated(NO_TERMS);

/** `.` matches everything except the line terminators, without the `s` flag. */
const DOT_SET: CharSet = CharSet.Negated({
  chars: HashSet.make(0x0a, 0x0d, 0x2028, 0x2029),
  ranges: [],
  classes: [],
});

const oneChar = (code: number): CharSet => CharSet.Listed({ members: HashSet.make(code) });

/** The characters from `low` to `high`, and none when `low` is above `high`. */
const codesFrom = ({ low, high }: Range): ReadonlyArray<number> =>
  pipe(
    high - low + 1,
    Option.liftPredicate((count) => count > 0),
    Option.map(Array.makeBy((offset) => low + offset)),
    Option.getOrElse(() => Array.empty<number>()),
  );

/** The characters of `\s`, as the specification lists them. */
const WHITESPACE: ReadonlyArray<number> = [
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005,
  0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff,
];
const WHITESPACE_SET = HashSet.fromIterable(WHITESPACE);

const DIGITS = codesFrom({ low: 0x30, high: 0x39 });
const WORD_CHARS = pipe(
  [DIGITS, codesFrom({ low: 0x41, high: 0x5a }), codesFrom({ low: 0x61, high: 0x7a }), [0x5f]],
  Array.flatten,
  HashSet.fromIterable,
);

const isDigit = (code: number): boolean => code >= 0x30 && code <= 0x39;

const isWord = (code: number): boolean =>
  isDigit(code) ||
  (code >= 0x41 && code <= 0x5a) ||
  (code >= 0x61 && code <= 0x7a) ||
  code === 0x5f;

const isSpace = (code: number): boolean => pipe(WHITESPACE_SET, HashSet.has(code));

const DIGIT: ClassEscape = { holds: isDigit, members: Option.some(HashSet.fromIterable(DIGITS)) };
const NOT_DIGIT: ClassEscape = { holds: Predicate.not(isDigit), members: Option.none() };
const WORD: ClassEscape = { holds: isWord, members: Option.some(WORD_CHARS) };
const NOT_WORD: ClassEscape = { holds: Predicate.not(isWord), members: Option.none() };
const SPACE: ClassEscape = { holds: isSpace, members: Option.some(WHITESPACE_SET) };
const NOT_SPACE: ClassEscape = { holds: Predicate.not(isSpace), members: Option.none() };

/** The class that a letter names, as `d` names `\d`. */
const classEscape = pipe(
  Match.type<string>(),
  Match.when("d", () => DIGIT),
  Match.when("D", () => NOT_DIGIT),
  Match.when("w", () => WORD),
  Match.when("W", () => NOT_WORD),
  Match.when("s", () => SPACE),
  Match.when("S", () => NOT_SPACE),
  Match.option,
);

/** The characters of a range that is narrow enough to list. */
const rangeMembers: (range: Range) => Option.Option<ReadonlyArray<number>> = flow(
  Option.liftPredicate(({ low, high }: Range) => high - low <= MEMBER_LIMIT),
  Option.map(codesFrom),
);

/**
 * List the members of `terms`, when there are few enough of them.
 *
 * A `None` means "too many, or an unlimited number". A range that is wider
 * than the limit, and `\D`, `\W` and `\S`, are unlimited.
 */
const listTerms = ({ chars, ranges, classes }: Terms): Option.Option<HashSet.HashSet<number>> =>
  pipe(
    Option.all([
      pipe(ranges, Array.map(rangeMembers), Option.all, Option.map(Array.flatten)),
      pipe(
        classes,
        Array.map(({ members }) => members),
        Option.all,
        Option.map(Array.flatMap((members) => Array.fromIterable(members))),
      ),
    ]),
    Option.map(([rangeCodes, classCodes]) =>
      pipe(
        chars,
        HashSet.union(HashSet.fromIterable(rangeCodes)),
        HashSet.union(HashSet.fromIterable(classCodes)),
      ),
    ),
    Option.filter((members) => HashSet.size(members) <= MEMBER_LIMIT),
  );

/** The set that `terms` describe, listed when it is small enough. */
const described = (terms: Terms): CharSet =>
  pipe(
    listTerms(terms),
    Option.match({
      onNone: () => CharSet.Unlisted(terms),
      onSome: (members) => CharSet.Listed({ members }),
    }),
  );

/** The set of one class escape, as `[\d]` has. */
const escapeSet = (escape: ClassEscape): CharSet =>
  pipe(
    escape.members,
    Option.match({
      onNone: () => CharSet.Unlisted({ chars: HashSet.empty(), ranges: [], classes: [escape] }),
      onSome: (members) => CharSet.Listed({ members }),
    }),
  );

/** Every character of both code sets. The union walks the smaller one. */
const mergeCodes = (
  left: HashSet.HashSet<number>,
  right: HashSet.HashSet<number>,
): HashSet.HashSet<number> =>
  pipe(
    HashSet.size(left) >= HashSet.size(right),
    Boolean.match({
      onFalse: () => pipe(right, HashSet.union(left)),
      onTrue: () => pipe(left, HashSet.union(right)),
    }),
  );

const withChars = (terms: Terms, codes: HashSet.HashSet<number>): Terms =>
  pipe(terms, Struct.assign({ chars: mergeCodes(terms.chars, codes) }));

const mergeTerms = (left: Terms, right: Terms): Terms => ({
  chars: mergeCodes(left.chars, right.chars),
  ranges: pipe(left.ranges, Array.appendAll(right.ranges)),
  classes: pipe(
    left.classes,
    Array.unionWith(right.classes, (one, other) => one === other),
  ),
});

/** A listed set, or the same characters as terms when there are too many. */
const listedOrTerms = (members: HashSet.HashSet<number>): CharSet =>
  pipe(
    HashSet.size(members) <= MEMBER_LIMIT,
    Boolean.match({
      onFalse: () => CharSet.Unlisted({ chars: members, ranges: [], classes: [] }),
      onTrue: () => CharSet.Listed({ members }),
    }),
  );

/**
 * Every character of both sets.
 *
 * A negated set on either side gives `ANY_SET`. A set that one side cannot
 * list stays unlisted, because the union holds at least as many characters.
 */
const unionSets = (left: CharSet, right: CharSet): CharSet =>
  pipe(
    left,
    CharSet.$match({
      Listed: ({ members }) =>
        pipe(
          right,
          CharSet.$match({
            Listed: (other) => listedOrTerms(mergeCodes(members, other.members)),
            Unlisted: (terms) => CharSet.Unlisted(withChars(terms, members)),
            Negated: () => ANY_SET,
          }),
        ),
      Unlisted: (terms) =>
        pipe(
          right,
          CharSet.$match({
            Listed: ({ members }) => CharSet.Unlisted(withChars(terms, members)),
            Unlisted: (other) => CharSet.Unlisted(mergeTerms(terms, other)),
            Negated: () => ANY_SET,
          }),
        ),
      Negated: () => ANY_SET,
    }),
  );

const inTerms = (terms: Terms, code: number): boolean =>
  pipe(terms.chars, HashSet.has(code)) ||
  pipe(
    terms.ranges,
    Array.some(({ low, high }) => code >= low && code <= high),
  ) ||
  pipe(
    terms.classes,
    Array.some((escape) => escape.holds(code)),
  );

/** Does `set` hold this character? */
type Holds = (set: CharSet, code: number) => boolean;

/** The answer is exact. */
const holdsExactly: Holds = (set, code) =>
  pipe(
    set,
    CharSet.$match({
      Listed: ({ members }) => pipe(members, HashSet.has(code)),
      Unlisted: (terms) => inTerms(terms, code),
      Negated: (terms) => !inTerms(terms, code),
    }),
  );

/** The one-character upper and lower cases of `code`. */
const caseVariants = (code: number): ReadonlyArray<number> => {
  const char = String.fromCharCode(code);
  return pipe(
    [char.toUpperCase(), char.toLowerCase()],
    Array.filter((variant) => variant.length === 1),
    Array.map((variant) => variant.charCodeAt(0)),
  );
};

/** The same question, with the case folding of the `i` flag. */
const holdsFolded: Holds = (set, code) =>
  holdsExactly(set, code) ||
  pipe(
    caseVariants(code),
    Array.some((variant) => holdsExactly(set, variant)),
  );

/** Can one character belong to both sets? */
type Intersect = (left: CharSet, right: CharSet) => boolean;

/**
 * The answer is exact when one of the two sets is small enough to list. Two
 * unlimited sets give `true`, which refuses the pattern.
 */
const intersectWith = (holds: Holds): Intersect => {
  /** Does a member of `listed` belong to `other`? A set that is not listed may meet anything. */
  const meets = (listed: CharSet, other: CharSet): boolean =>
    pipe(
      listed,
      CharSet.$match({
        Listed: ({ members }) =>
          pipe(
            members,
            HashSet.some((code) => holds(other, code)),
          ),
        Unlisted: () => true,
        Negated: () => true,
      }),
    );
  return (left, right) =>
    pipe(
      left,
      CharSet.$match({
        Listed: () => meets(left, right),
        Unlisted: () => meets(right, left),
        Negated: () => meets(right, left),
      }),
    );
};

// ---------------------------------------------------------------------------
// The flags
// ---------------------------------------------------------------------------

/**
 * How the engine reads the text of a pattern.
 *
 * With the `u` flag it reads code points, and `\u{…}` and `\p{…}` are
 * escapes. Without the flag it reads code units, and they are literal text.
 */
type Reading = Data.TaggedEnum<{ CodePoints: Mark; CodeUnits: Mark }>;
const Reading = Data.taggedEnum<Reading>();

/** What the flags of a pattern change in this module. */
interface Flags {
  /** The characters that `.` matches: line terminators too with the `s` flag. */
  readonly dot: CharSet;
  readonly reading: Reading;
  /** The set intersection, with the case folding of the `i` flag or without it. */
  readonly intersect: Intersect;
}

const readFlags = (flags: string): Flags => ({
  dot: pipe(flags.includes("s"), Boolean.match({ onFalse: () => DOT_SET, onTrue: () => ANY_SET })),
  reading: pipe(
    flags.includes("u"),
    Boolean.match({ onFalse: () => Reading.CodeUnits(), onTrue: () => Reading.CodePoints() }),
  ),
  intersect: pipe(
    flags.includes("i"),
    Boolean.match({
      onFalse: () => intersectWith(holdsExactly),
      onTrue: () => intersectWith(holdsFolded),
    }),
  ),
});

// ---------------------------------------------------------------------------
// The syntax tree
// ---------------------------------------------------------------------------

type Shape = Data.TaggedEnum<{
  /** Nothing at all, as between the two bars of `a||b`. */
  Empty: Mark;
  /** One character, from a literal, a class escape or a `[…]` class. */
  Char: Mark;
  /** `^`, `$`, `\b` and `\B`. They match a position and no character. */
  Anchor: Mark;
  Look: { readonly body: Node };
  Concat: { readonly parts: ReadonlyArray<Node> };
  Alt: { readonly branches: ReadonlyArray<Node> };
  Repeat: { readonly body: Node; readonly max: number };
}>;
const Shape = Data.taggedEnum<Shape>();

interface Span {
  readonly min: number;
  readonly max: number;
}

/**
 * One node of the tree, with every answer that the rules ask about it.
 *
 * The parser builds the tree from the leaves up, so each node computes its
 * answers once, from the answers of its children. Nothing walks the tree to
 * find them again. The answers that compare two sets depend on the `i` flag,
 * so one tree belongs to one call.
 */
interface Node {
  readonly shape: Shape;
  /** Can this expression match an empty string? */
  readonly nullable: boolean;
  /** The shortest and the longest string that this expression matches. */
  readonly span: Span;
  /** The characters that a match can start with. */
  readonly first: CharSet;
  /** The characters that a match can end with. */
  readonly last: CharSet;
  /** Every character that a match can hold, at any position. */
  readonly anywhere: CharSet;
  /**
   * The characters that can make a match longer.
   *
   * A member `c` means: this expression matches some text `u`, and it also
   * matches `u` followed by `c` and more. `a+` gives `a`, because `a` matches
   * and `aa` matches. `\w+\.` gives nothing, because every match ends at the
   * one dot that it holds.
   */
  readonly extend: CharSet;
  /** The fixed shape of this expression, when it has one. */
  readonly sequence: Option.Option<ReadonlyArray<CharSet>>;
  /**
   * How many ways this expression can try to match one piece of text.
   *
   * The number counts the choices that the text can make, and not the
   * characters that the expression reads. A value of `1` means that one text
   * gives one path. `WINDOW_WIDTH` means that one unbounded quantifier can
   * stop at every position of a window.
   */
  readonly cost: number;
}

/** Can this expression match two strings of different lengths? */
const isFlexible = (node: Node): boolean => node.span.min !== node.span.max;

const isNullable = (node: Node): boolean => node.nullable;

/** How many times a quantifier lets its atom run. */
interface Count {
  readonly min: number;
  readonly max: number;
}

// ---------------------------------------------------------------------------
// The answers of each node
// ---------------------------------------------------------------------------

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

/** The most assertions that can contain each other. */
const ASSERTION_DEPTH_LIMIT = 3;

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
 * One unbounded quantifier that competes with later text costs one window. The
 * factor of eight lets a small fixed loop repeat that cost. Two unbounded
 * choices still cost a window times a window. The check refuses that cost.
 */
const PATH_BUDGET = WINDOW_WIDTH * ASSERTION_LIMIT;
const OVER_PATH_BUDGET = PATH_BUDGET + 1;

/** Multiply two costs, and stop at the first value above the limit. */
const multiplyCosts = (left: number, right: number): number =>
  pipe(
    left > PATH_BUDGET || right > PATH_BUDGET || left > Math.floor(PATH_BUDGET / right),
    Boolean.match({ onFalse: () => left * right, onTrue: () => OVER_PATH_BUDGET }),
  );

/**
 * How many end positions an expression of this span can try.
 *
 * A part whose length cannot vary has one end. `a{0,3}` has four, and `a*`
 * has one for every position of a window.
 */
const width = ({ min, max }: Span): number => Math.min(WINDOW_WIDTH, Math.max(1, max - min + 1));

const EMPTY_NODE: Node = {
  shape: Shape.Empty(),
  nullable: true,
  span: { min: 0, max: 0 },
  first: EMPTY_SET,
  last: EMPTY_SET,
  anywhere: EMPTY_SET,
  extend: EMPTY_SET,
  sequence: Option.some([]),
  cost: 1,
};

const ANCHOR_NODE: Node = pipe(EMPTY_NODE, Struct.assign({ shape: Shape.Anchor() }));

const charNode = (set: CharSet): Node => ({
  shape: Shape.Char(),
  nullable: false,
  span: { min: 1, max: 1 },
  first: set,
  last: set,
  anywhere: set,
  extend: EMPTY_SET,
  sequence: Option.some([set]),
  cost: 1,
});

/**
 * A lookahead or a lookbehind.
 *
 * An assertion reads the text that follows it, or the text before it. Its
 * body therefore competes with the neighbours of the assertion, and its
 * characters take part in every neighbour test. A list of sets cannot hold
 * the condition that it adds, so it has no fixed shape.
 *
 * An assertion runs its body at one position. The body pays its own cost, and
 * a concatenation multiplies that cost by the ways that the text before the
 * assertion can match.
 */
const lookNode = (body: Node): Node => ({
  shape: Shape.Look({ body }),
  nullable: true,
  span: { min: 0, max: 0 },
  first: body.first,
  last: body.last,
  anywhere: body.anywhere,
  extend: EMPTY_SET,
  sequence: Option.none(),
  cost: body.cost,
});

/** The longest text that `max` runs of a body of this length match. */
const longestRepeat = (longest: number, max: number): number =>
  pipe(
    Match.value({ longest, max }),
    Match.when({ longest: 0 }, () => 0),
    Match.when({ max: Number.POSITIVE_INFINITY }, () => Number.POSITIVE_INFINITY),
    Match.orElse(() => longest * max),
  );

/** `shape`, `count` times over. */
const repeatShape = (shape: ReadonlyArray<CharSet>, count: number): ReadonlyArray<CharSet> =>
  pipe(
    count,
    Option.liftPredicate((rounds) => rounds > 0),
    Option.map(Array.makeBy(() => shape)),
    Option.getOrElse(() => Array.empty<ReadonlyArray<CharSet>>()),
    Array.flatten,
  );

/**
 * The cost of a loop whose body costs `inner`, when the loop can stop in
 * `choices` ways.
 *
 * The choices count the possible end positions, or the iterations when there
 * are more of them. A fixed count has one end position, but its body still
 * runs once for each iteration.
 */
const loopCost = (inner: number, choices: number): number =>
  pipe(
    inner <= 1,
    Boolean.match({ onFalse: () => multiplyCosts(inner, choices), onTrue: () => 1 }),
  );

const repeatNode = (body: Node, { min, max }: Count): Node => {
  const span = { min: body.span.min * min, max: longestRepeat(body.span.max, max) };
  // `a{0}` never runs its body, so no character of the body can appear.
  const reach = pipe(max === 0, Boolean.match({ onFalse: () => body, onTrue: () => EMPTY_NODE }));
  return {
    shape: Shape.Repeat({ body, max }),
    nullable: min === 0 || body.nullable,
    span,
    first: reach.first,
    last: reach.last,
    anywhere: reach.anywhere,
    // One more iteration can follow a complete match, unless the count is
    // fixed.
    extend: pipe(
      max > min,
      Boolean.match({
        onFalse: () => reach.extend,
        onTrue: () => unionSets(reach.extend, reach.first),
      }),
    ),
    sequence: pipe(
      body.sequence,
      Option.filter((sets) => min === max && sets.length * min <= SEQUENCE_LIMIT),
      // An empty shape stays empty however many times it runs.
      Option.map(
        Array.match({
          onEmpty: () => Array.empty<CharSet>(),
          onNonEmpty: (shape) => repeatShape(shape, min),
        }),
      ),
    ),
    cost: pipe(
      max <= 1,
      Boolean.match({
        onFalse: () => loopCost(body.cost, Math.max(width(span), Math.min(max, WINDOW_WIDTH))),
        onTrue: () => body.cost,
      }),
    ),
  };
};

/** The first and the anywhere sets of the parts from one position to the end. */
interface Suffix {
  readonly first: CharSet;
  readonly anywhere: CharSet;
}

const NO_SUFFIX: Suffix = { first: EMPTY_SET, anywhere: EMPTY_SET };

/** One part of a concatenation, and what follows it. */
interface Link {
  readonly part: Node;
  /** The parts after this one. */
  readonly after: Suffix;
  /**
   * Can the boundary between this part and the parts after it move?
   *
   * Two conditions must hold. The part must be able to take the character
   * that the parts after it would start with. Those parts must also be able
   * to hold the character that the part ends with, because the text that the
   * part takes is text that they gave back.
   *
   * `\w+\.` and `\w+` do not slide: the first ends at a dot, and the second
   * holds no dot. `[a-z]*` and `x` do slide.
   */
  readonly slides: boolean;
}

/** The items up to the first one that must match a character, and that one too. */
const throughFirstSolid =
  <A>(nodeOf: (item: A) => Node) =>
  (items: ReadonlyArray<A>): ReadonlyArray<A> => {
    const [open, rest] = pipe(
      items,
      Array.span((item) => nodeOf(item).nullable),
    );
    const solid = pipe(rest, Array.take(1));
    return pipe(open, Array.appendAll(solid));
  };

/** The choices that the parts so far give the text, and the most paths that one part runs. */
interface Paths {
  readonly before: number;
  readonly worst: number;
}

/** The paths after one more part of a concatenation. */
const addLink = (paths: Paths, { part, slides }: Link): Paths => ({
  before: pipe(
    slides,
    Boolean.match({
      onFalse: () => paths.before,
      onTrue: () => multiplyCosts(paths.before, width(part.span)),
    }),
  ),
  worst: Math.max(paths.worst, multiplyCosts(paths.before, part.cost)),
});

/**
 * The cost of a concatenation.
 *
 * Each part that can slide gives the text a choice, and every part after it
 * runs again for each of those choices. The cost of the whole is therefore
 * the product of the choices, and the worst part is the one that runs after
 * the most of them.
 */
const costOfLinks: (links: ReadonlyArray<Link>) => number = flow(
  Array.reduce({ before: 1, worst: 1 }, addLink),
  ({ before, worst }) => Math.max(worst, before),
);

/**
 * What can start the parts from `part` to the end: the start of `part`, and
 * the start of the parts after it when `part` can be empty.
 */
const startFrom = (after: Suffix, part: Node): Suffix => ({
  first: pipe(
    part.nullable,
    Boolean.match({ onFalse: () => EMPTY_SET, onTrue: () => after.first }),
    (rest) => unionSets(part.first, rest),
  ),
  anywhere: unionSets(part.anywhere, after.anywhere),
});

const concatNode =
  (intersect: Intersect) =>
  (parts: ReadonlyArray<Node>): Node => {
    const suffixes = pipe(parts, Array.scanRight(NO_SUFFIX, startFrom));
    const links = pipe(
      parts,
      Array.zip(Array.tailNonEmpty(suffixes)),
      Array.map(([part, after]): Link => ({
        part,
        after,
        slides: intersect(part.extend, after.first) && intersect(part.last, after.anywhere),
      })),
    );
    // A match ends inside the last part that is not empty. That part can
    // grow, and every part after it can stop being empty.
    const ending = pipe(
      links,
      Array.reverse,
      throughFirstSolid(({ part }) => part),
    );
    return {
      shape: Shape.Concat({ parts }),
      nullable: pipe(parts, Array.every(isNullable)),
      span: pipe(
        parts,
        Array.reduce({ min: 0, max: 0 }, (sum, { span }) => ({
          min: sum.min + span.min,
          max: sum.max + span.max,
        })),
      ),
      first: Array.headNonEmpty(suffixes).first,
      last: pipe(
        ending,
        Array.map(({ part }) => part.last),
        Array.reduce(EMPTY_SET, unionSets),
      ),
      anywhere: Array.headNonEmpty(suffixes).anywhere,
      // A part in the middle can also grow, when the parts after it can start
      // one character later. The match then ends one character later, and
      // this module cannot say with which character.
      extend: pipe(
        links,
        Array.some(({ slides }) => slides),
        Boolean.match({
          onFalse: () =>
            pipe(
              ending,
              Array.map(({ part, after }) => unionSets(part.extend, after.first)),
              Array.reduce(EMPTY_SET, unionSets),
            ),
          onTrue: () => ANY_SET,
        }),
      ),
      sequence: pipe(
        parts,
        Array.map(({ sequence }) => sequence),
        Option.all,
        Option.map(Array.flatten),
        Option.filter((sets) => sets.length <= SEQUENCE_LIMIT),
      ),
      cost: costOfLinks(links),
    };
  };

/** Does every set of `short` meet the set at its position in `long`? */
const overlaps = (
  intersect: Intersect,
  short: ReadonlyArray<CharSet>,
  long: ReadonlyArray<CharSet>,
): boolean =>
  pipe(
    short,
    Array.zip(long),
    Array.every(([one, other]) => intersect(one, other)),
  );

/** The union of two shapes of one length, position by position. */
const unionAt = (sets: ReadonlyArray<CharSet>, shape: ReadonlyArray<CharSet>) =>
  pipe(sets, Array.zipWith(shape, unionSets));

/**
 * The union of shapes of one length, position by position, or `None` when two
 * lengths differ.
 *
 * The union loses which branch gave which set, so the shape holds more
 * strings than the alternation does. That direction refuses more, and never
 * fewer.
 */
const unionShapes: (
  shapes: ReadonlyArray<ReadonlyArray<CharSet>>,
) => Option.Option<ReadonlyArray<CharSet>> = Array.matchLeft({
  onEmpty: () => Option.none(),
  onNonEmpty: (head, rest) =>
    pipe(
      rest,
      Array.every((shape) => shape.length === head.length),
      Boolean.match({
        onFalse: () => Option.none(),
        onTrue: () => pipe(rest, Array.reduce(head, unionAt), Option.some),
      }),
    ),
});

/** The known shapes of the branches, by their length. */
type ShapesByLength = Rec.ReadonlyRecord<string, ReadonlyArray<ReadonlyArray<CharSet>>>;

/**
 * The sets of `long` that can follow a shorter shape.
 *
 * The set at position `k` follows when a shape of length `k` can start
 * `long`. Each position counts once, however many shapes start `long` there.
 */
const followersIn =
  (intersect: Intersect, byLength: ShapesByLength) =>
  (long: ReadonlyArray<CharSet>): ReadonlyArray<CharSet> =>
    pipe(
      long,
      Array.filter((_, length) =>
        pipe(
          byLength,
          Rec.get(String(length)),
          Option.exists(Array.some((short) => overlaps(intersect, short, long))),
        ),
      ),
    );

/** Can the two branches start with one character, when one of their shapes is unknown? */
const meetsUnknown =
  (intersect: Intersect, branches: ReadonlyArray<Node>) =>
  (one: Node): boolean =>
    Option.isNone(one.sequence) &&
    pipe(
      branches,
      Array.some(
        (other) =>
          other !== one && (intersect(one.first, other.first) || intersect(other.first, one.first)),
      ),
    );

/**
 * The characters that one branch can be followed by inside another branch,
 * for every pair of branches in both orders.
 *
 * `a|aa` gives `a`: the first branch matches `a`, and the second matches
 * `aa`, so a match of the alternation can grow. `a|ab` gives `b`, and
 * `cat|car` gives nothing, because neither shape starts the other one.
 *
 * A branch that can be empty is followed by the start of every other branch.
 * A shape that starts a longer shape is followed by the next set of the
 * longer one. When the shape of one of the two branches is unknown, any
 * character can follow, unless the two branches cannot even start with one
 * character.
 */
const crossExtend = (intersect: Intersect, branches: ReadonlyArray<Node>): CharSet => {
  const shapes = pipe(
    branches,
    Array.map(({ sequence }) => sequence),
    Array.getSomes,
  );
  const byLength: ShapesByLength = pipe(
    shapes,
    Array.groupBy((shape) => String(shape.length)),
  );
  const followers = pipe(shapes, Array.flatMap(followersIn(intersect, byLength)));
  // A branch that can be empty lets every other branch start the match again.
  const empties = pipe(branches, Array.filter(isNullable));
  const starts = pipe(
    branches,
    Array.filter(
      (other) =>
        other.span.max > 0 &&
        pipe(
          empties,
          Array.some((empty) => empty !== other),
        ),
    ),
    Array.map(({ first }) => first),
  );
  return pipe(
    branches,
    Array.some(meetsUnknown(intersect, branches)),
    Boolean.match({
      onFalse: () => pipe(followers, Array.appendAll(starts), Array.reduce(EMPTY_SET, unionSets)),
      onTrue: () => ANY_SET,
    }),
  );
};

const altNode =
  (intersect: Intersect) =>
  (branches: ReadonlyArray<Node>): Node => ({
    shape: Shape.Alt({ branches }),
    nullable: pipe(branches, Array.some(isNullable)),
    span: pipe(
      branches,
      Array.reduce({ min: Number.POSITIVE_INFINITY, max: 0 }, (reach, { span }) => ({
        min: Math.min(reach.min, span.min),
        max: Math.max(reach.max, span.max),
      })),
    ),
    first: pipe(
      branches,
      Array.map(({ first }) => first),
      Array.reduce(EMPTY_SET, unionSets),
    ),
    last: pipe(
      branches,
      Array.map(({ last }) => last),
      Array.reduce(EMPTY_SET, unionSets),
    ),
    anywhere: pipe(
      branches,
      Array.map(({ anywhere }) => anywhere),
      Array.reduce(EMPTY_SET, unionSets),
    ),
    extend: pipe(
      branches,
      Array.map(({ extend }) => extend),
      Array.append(crossExtend(intersect, branches)),
      Array.reduce(EMPTY_SET, unionSets),
    ),
    sequence: pipe(
      branches,
      Array.map(({ sequence }) => sequence),
      Option.all,
      Option.flatMap(unionShapes),
    ),
    cost: pipe(
      branches,
      Array.reduce(1, (most, { cost }) => Math.max(most, cost)),
    ),
  });

// ---------------------------------------------------------------------------
// The lexer
// ---------------------------------------------------------------------------

/** The text of a pattern, and what its flags change. */
interface Text {
  readonly source: string;
  readonly flags: Flags;
}

/** A value that the lexer read, and the index after it. */
interface Read<A> {
  readonly value: A;
  readonly next: number;
}

/** Read one value from an index, or give the reason that the text cannot be read. */
type Reader<A> = (text: Text, index: number) => Result.Result<Read<A>, string>;

/** What a `(` opens. */
type Opener = Data.TaggedEnum<{ Group: Mark; Look: Mark }>;
const Opener = Data.taggedEnum<Opener>();

/**
 * One piece of the pattern text.
 *
 * An atom carries the quantifier that follows it. A `)` ends a group, and the
 * group is an atom too, so the `)` carries the quantifier of the group.
 */
type Token = Data.TaggedEnum<{
  Atom: { readonly node: Node; readonly count: Option.Option<Count> };
  Open: { readonly opener: Opener };
  Close: { readonly count: Option.Option<Count> };
  Bar: Mark;
}>;
const Token = Data.taggedEnum<Token>();

/** One element inside a `[…]` class. `Open` is an element that we cannot list. */
type ClassItem = Data.TaggedEnum<{
  Code: { readonly code: number };
  Range: Range;
  Class: { readonly escape: ClassEscape };
  Open: Mark;
}>;
const ClassItem = Data.taggedEnum<ClassItem>();

/** The control escapes that name one character. */
const controlEscape = pipe(
  Match.type<string>(),
  Match.when("n", () => 0x0a),
  Match.when("r", () => 0x0d),
  Match.when("t", () => 0x09),
  Match.when("f", () => 0x0c),
  Match.when("v", () => 0x0b),
  Match.option,
);

/** The terms of a class with `item` added, or `None` when we cannot list it. */
const addItem =
  (item: ClassItem) =>
  (terms: Terms): Option.Option<Terms> =>
    pipe(
      item,
      ClassItem.$match({
        Code: ({ code }) =>
          Option.some({
            chars: pipe(terms.chars, HashSet.add(code)),
            ranges: terms.ranges,
            classes: terms.classes,
          }),
        Range: ({ low, high }) =>
          Option.some({
            chars: terms.chars,
            ranges: pipe(terms.ranges, Array.append({ low, high })),
            classes: terms.classes,
          }),
        Class: ({ escape }) =>
          Option.some({
            chars: terms.chars,
            ranges: terms.ranges,
            classes: pipe(terms.classes, Array.append(escape)),
          }),
        Open: () => Option.none(),
      }),
    );

/**
 * The set of a class.
 *
 * `wrap` makes the set from the terms, and inverts it for `[^…]`. An element
 * that we cannot list gives `ANY_SET`, with or without the `^`.
 */
const classSet = (items: ReadonlyArray<ClassItem>, wrap: (terms: Terms) => CharSet): CharSet =>
  pipe(
    items,
    Array.reduce(Option.some(NO_TERMS), (terms, item) =>
      pipe(terms, Option.flatMap(addItem(item))),
    ),
    Option.match({ onNone: () => ANY_SET, onSome: wrap }),
  );

/** The set of one escape outside a class, as `\d` or `\n`. */
const itemSet: (item: ClassItem) => CharSet = ClassItem.$match({
  Code: ({ code }) => oneChar(code),
  Range: (range) => described({ chars: HashSet.empty(), ranges: [range], classes: [] }),
  Class: ({ escape }) => escapeSet(escape),
  Open: () => ANY_SET,
});

/** `{2}`, `{2,}` and `{2,4}`. Anything else after a `{` is a literal `{`. */
const COUNTED = /^\{(\d+)(,?)(\d*)\}/;

const HEX = /^[0-9a-fA-F]+$/;

const LETTER = /[A-Za-z]/;

const readHex: (text: string) => Option.Option<number> = flow(
  Option.liftPredicate((digits: string) => HEX.test(digits)),
  Option.map((digits) => Number.parseInt(digits, 16)),
);

/** The text of one group of a match, or `""` when it matched nothing. */
const groupText = (match: RegExpMatchArray, group: number): string =>
  pipe(
    match,
    Array.get(group),
    Option.flatMap(Option.fromNullishOr),
    Option.getOrElse(() => ""),
  );

/** The count of a `{…}` quantifier that `COUNTED` matched. */
const countOf = (counted: RegExpMatchArray): Count => {
  const min = Number.parseInt(groupText(counted, 1), 10);
  const high = groupText(counted, 3);
  return {
    min,
    max: pipe(
      Match.value({ comma: groupText(counted, 2), high }),
      Match.when({ comma: "" }, () => min),
      Match.when({ high: "" }, () => Number.POSITIVE_INFINITY),
      Match.orElse(() => Number.parseInt(high, 10)),
    ),
  };
};

/** A backreference repeats an earlier group, as `\1` and `\k<name>` do. */
const isBackreference = (char: string): boolean => char === "k" || (char >= "1" && char <= "9");

const charAt = ({ source }: Text, index: number): Option.Option<string> =>
  pipe(source, Str.charAt(index));

const isAt = ({ source }: Text, index: number, char: string): boolean =>
  source.startsWith(char, index);

const indexFrom = ({ source }: Text, index: number, char: string): Option.Option<number> =>
  pipe(
    source.indexOf(char, index),
    Option.liftPredicate((found) => found >= 0),
  );

const succeed = <A>(value: A, next: number): Result.Result<Read<A>, string> =>
  Result.succeed({ value, next });

/**
 * The character at `index`.
 *
 * With the `u` flag the engine reads one code point, so `😀+` repeats one
 * character. Without the flag it reads two code units, and `😀+` repeats the
 * second one. The model must say what the engine does.
 */
const readCodePoint = ({ source, flags }: Text, index: number): Read<number> => {
  const value = pipe(
    flags.reading,
    Reading.$match({
      CodePoints: () =>
        pipe(
          source,
          Str.codePointAt(index),
          Option.getOrElse(() => 0),
        ),
      CodeUnits: () => source.charCodeAt(index),
    }),
  );
  return {
    value,
    next: index + pipe(value > 0xffff, Boolean.match({ onFalse: () => 1, onTrue: () => 2 })),
  };
};

/** `\x41` and `\u0041`: a fixed number of hex digits from `index`. */
const readHexItem =
  (digits: number): Reader<ClassItem> =>
  ({ source }, index) =>
    pipe(
      source.slice(index, index + digits),
      readHex,
      Result.fromOption(() => UNSUPPORTED_SYNTAX),
      Result.map((code) => ({ value: ClassItem.Code({ code }), next: index + digits })),
    );

/** The item of the digits of `\u{…}`: a character, or an element that we cannot list. */
const longUnicodeItem: (digits: string) => ClassItem = flow(
  readHex,
  Option.match({ onNone: () => ClassItem.Open(), onSome: (code) => ClassItem.Code({ code }) }),
);

/** `\u{41}`, from the index of its `{`. */
const readLongUnicodeItem: Reader<ClassItem> = (text, index) =>
  pipe(
    text.flags.reading,
    Reading.$match({
      CodePoints: () =>
        pipe(
          indexFrom(text, index, "}"),
          Result.fromOption(() => UNSUPPORTED_SYNTAX),
          Result.map((close) => ({
            value: longUnicodeItem(text.source.slice(index + 1, close)),
            next: close + 1,
          })),
        ),
      // `\u{41}` is one character with the `u` flag, and the five literal
      // characters `u{41}` without it. Refuse the second reading: a model
      // that does not match the engine is not a safe model.
      CodeUnits: () => Result.fail(LONG_ESCAPE),
    }),
  );

/** `\u0041` and `\u{41}`, from the index after the `u`. */
const readUnicodeItem: Reader<ClassItem> = (text, index) =>
  pipe(
    isAt(text, index, "{"),
    Boolean.match({
      onFalse: () => readHexItem(4)(text, index),
      onTrue: () => readLongUnicodeItem(text, index),
    }),
  );

/** `\cA`, from the index after the `c`. */
const readControlItem: Reader<ClassItem> = (text, index) =>
  pipe(
    charAt(text, index),
    Option.filter((letter) => LETTER.test(letter)),
    Option.match({
      onNone: () => succeed(ClassItem.Open(), index),
      onSome: (letter) => succeed(ClassItem.Code({ code: letter.charCodeAt(0) % 32 }), index + 1),
    }),
  );

/** The index after the `{…}` of a property escape, or `index` when it has none. */
const afterBraces = (text: Text, index: number): number =>
  pipe(
    isAt(text, index, "{"),
    Boolean.match({
      onFalse: () => index,
      onTrue: () =>
        pipe(
          indexFrom(text, index, "}"),
          Option.match({ onNone: () => text.source.length, onSome: (close) => close + 1 }),
        ),
    }),
  );

/** `\p{L}` and `\P{L}`, from the index after the `p`. */
const readPropertyItem: Reader<ClassItem> = (text, index) =>
  pipe(
    text.flags.reading,
    Reading.$match({
      // We cannot list the members of the property.
      CodePoints: () => succeed(ClassItem.Open(), afterBraces(text, index)),
      // A property escape such as `\p{L}` is one character with the `u`
      // flag, and the four literal characters `p{L}` without it. Refuse the
      // second reading, so that the model always says what the engine does.
      CodeUnits: () => Result.fail(PROPERTY_ESCAPE),
    }),
  );

/** `\d`, `\n` and `\.`: one letter that names a class, a control character or itself. */
const letterItem = (letter: string): ClassItem =>
  pipe(
    classEscape(letter),
    Option.map((escape) => ClassItem.Class({ escape })),
    Option.orElse(() =>
      pipe(
        controlEscape(letter),
        Option.map((code) => ClassItem.Code({ code })),
      ),
    ),
    Option.getOrElse(() => ClassItem.Code({ code: letter.charCodeAt(0) })),
  );

/** The reader for the rest of an escape, from the letter after its backslash. */
const escapeReader = pipe(
  Match.type<string>(),
  Match.when("x", (): Reader<ClassItem> => readHexItem(2)),
  Match.when("u", (): Reader<ClassItem> => readUnicodeItem),
  Match.when("c", (): Reader<ClassItem> => readControlItem),
  Match.whenOr("p", "P", (): Reader<ClassItem> => readPropertyItem),
  Match.orElse(
    (letter): Reader<ClassItem> =>
      (_text, index) =>
        succeed(letterItem(letter), index),
  ),
);

/** One escape, from the index after its backslash. */
const readEscapeItem: Reader<ClassItem> = (text, index) =>
  pipe(
    charAt(text, index),
    Result.fromOption(() => UNSUPPORTED_SYNTAX),
    Result.flatMap((letter) => escapeReader(letter)(text, index + 1)),
  );

/** One element of a `[…]` class: an escape, or one plain character. */
const readClassItem: Reader<ClassItem> = (text, index) =>
  pipe(
    isAt(text, index, "\\"),
    Boolean.match({
      onFalse: () => {
        const { value, next } = readCodePoint(text, index);
        return succeed(ClassItem.Code({ code: value }), next);
      },
      onTrue: () => readEscapeItem(text, index + 1),
    }),
  );

/** A `-` between two elements, and not the last character of the class. */
const isRangeDash = (text: Text, index: number): boolean =>
  isAt(text, index, "-") &&
  pipe(
    charAt(text, index + 1),
    Option.exists((char) => char !== "]"),
  );

/** The elements that a range from `low` to `upper` gives. */
const rangeItems = (low: number, upper: ClassItem): ReadonlyArray<ClassItem> =>
  pipe(
    upper,
    Option.liftPredicate(ClassItem.$is("Code")),
    Option.match({
      onSome: ({ code }) => [ClassItem.Range({ low, high: code })],
      // `[a-\d]` is a literal dash between two elements.
      onNone: () => [ClassItem.Code({ code: low }), ClassItem.Code({ code: 0x2d }), upper],
    }),
  );

/** A range from `low`, with its upper end read from the index after the `-`. */
const readRange = (
  text: Text,
  low: number,
  index: number,
): Result.Result<Read<ReadonlyArray<ClassItem>>, string> =>
  pipe(
    readClassItem(text, index),
    Result.map(({ value, next }) => ({ value: rangeItems(low, value), next })),
  );

/** One element of a class, or a range of two of them. */
const readClassPiece: Reader<ReadonlyArray<ClassItem>> = (text, index) =>
  pipe(
    readClassItem(text, index),
    Result.flatMap(({ value, next }) =>
      pipe(
        value,
        Option.liftPredicate(ClassItem.$is("Code")),
        Option.filter(() => isRangeDash(text, next)),
        Option.match({
          onNone: () => succeed([value], next),
          onSome: ({ code }) => readRange(text, code, next + 1),
        }),
      ),
    ),
  );

/**
 * The values that `read` finds one after another from `start`.
 *
 * `read` gives nothing where the values end. A value that cannot be read ends
 * them too, as their last element.
 */
const readEach = <A>(
  start: number,
  read: (index: number) => Option.Option<Result.Result<Read<A>, string>>,
): Iterable<Result.Result<Read<A>, string>> =>
  Iterable.unfold(
    Option.some(start),
    flow(
      Option.flatMap(read),
      Option.map(
        (step) =>
          [
            step,
            pipe(
              step,
              Result.getSuccess,
              Option.map(({ next }) => next),
            ),
          ] as const,
      ),
    ),
  );

/**
 * The elements of a class from `start` up to its `]`.
 *
 * The reading stops at the `]`, at the end of the text, or at a piece that
 * cannot be read.
 */
const readClassItems: Reader<ReadonlyArray<ClassItem>> = (text, start) =>
  pipe(
    readEach(start, (index) =>
      pipe(
        charAt(text, index),
        Option.filter((char) => char !== "]"),
        Option.map(() => readClassPiece(text, index)),
      ),
    ),
    Result.all,
    Result.map((pieces) => ({
      value: pipe(
        pieces,
        Array.flatMap(({ value }) => value),
      ),
      next: pipe(
        pieces,
        Array.last,
        Option.match({ onNone: () => start, onSome: ({ next }) => next }),
      ),
    })),
  );

/** The rest of a class from `start`, with the `wrap` that its `^` chose. */
const readClassBody = (
  text: Text,
  start: number,
  wrap: (terms: Terms) => CharSet,
): Result.Result<Read<CharSet>, string> =>
  pipe(
    readClassItems(text, start),
    Result.filterOrFail(
      ({ next }) => isAt(text, next, "]"),
      () => UNSUPPORTED_SYNTAX,
    ),
    Result.map(({ value, next }) => ({ value: classSet(value, wrap), next: next + 1 })),
  );

/** A `[…]` class, from the index after its `[`. */
const readClass: Reader<CharSet> = (text, index) =>
  pipe(
    isAt(text, index, "^"),
    Boolean.match({
      onFalse: () => readClassBody(text, index, described),
      onTrue: () => readClassBody(text, index + 1, (terms) => CharSet.Negated(terms)),
    }),
  );

/** The reader for an escape outside a class, from the letter after its backslash. */
const atomEscapeReader = pipe(
  Match.type<string>(),
  Match.whenOr("b", "B", (): Reader<Node> => (_text, index) => succeed(ANCHOR_NODE, index + 1)),
  // A backreference repeats an earlier group, so the engine can revisit the
  // same position with a different group content.
  Match.when(isBackreference, (): Reader<Node> => () => Result.fail(BACKREFERENCE)),
  Match.orElse(
    (): Reader<Node> => (text, index) =>
      pipe(
        readEscapeItem(text, index),
        Result.map(({ value, next }) => ({ value: charNode(itemSet(value)), next })),
      ),
  ),
);

/** An escape outside a class, from the index after its backslash. */
const readAtomEscape: Reader<Node> = (text, index) =>
  pipe(
    charAt(text, index),
    Result.fromOption(() => UNSUPPORTED_SYNTAX),
    Result.flatMap((letter) => atomEscapeReader(letter)(text, index)),
  );

const opened = (opener: Opener, next: number): Result.Result<Read<Token>, string> =>
  succeed(Token.Open({ opener }), next);

/** `(?<=`, `(?<!` and `(?<name>`, from the index after the `<`. */
const readAngleGroup: Reader<Token> = (text, index) =>
  pipe(
    isAt(text, index, "=") || isAt(text, index, "!"),
    Boolean.match({
      onFalse: () =>
        pipe(
          indexFrom(text, index, ">"),
          Result.fromOption(() => UNSUPPORTED_SYNTAX),
          Result.flatMap((close) => opened(Opener.Group(), close + 1)),
        ),
      onTrue: () => opened(Opener.Look(), index + 1),
    }),
  );

/** The reader for a group, from the character after its `(?`. */
const groupReader = pipe(
  Match.type<string>(),
  Match.when(":", (): Reader<Token> => (_text, index) => opened(Opener.Group(), index + 1)),
  Match.whenOr("=", "!", (): Reader<Token> => (_text, index) => opened(Opener.Look(), index + 1)),
  Match.when("<", (): Reader<Token> => (text, index) => readAngleGroup(text, index + 1)),
  Match.orElse((): Reader<Token> => () => Result.fail(UNSUPPORTED_SYNTAX)),
);

/** `(`, `(?:`, `(?=`, `(?!`, `(?<=`, `(?<!` and `(?<name>`, from the index after the `(`. */
const readGroup: Reader<Token> = (text, index) =>
  pipe(
    isAt(text, index, "?"),
    Boolean.match({
      onFalse: () => opened(Opener.Group(), index),
      onTrue: () =>
        pipe(
          charAt(text, index + 1),
          Result.fromOption(() => UNSUPPORTED_SYNTAX),
          Result.flatMap((kind) => groupReader(kind)(text, index + 1)),
        ),
    }),
  );

const unbounded = (min: number, next: number): Option.Option<Read<Count>> =>
  Option.some({ value: { min, max: Number.POSITIVE_INFINITY }, next });

/** The reader for a quantifier, from its first character. */
const countReader = pipe(
  Match.type<string>(),
  Match.when("*", () => (_text: Text, index: number) => unbounded(0, index + 1)),
  Match.when("+", () => (_text: Text, index: number) => unbounded(1, index + 1)),
  Match.when(
    "?",
    () => (_text: Text, index: number) =>
      Option.some({ value: { min: 0, max: 1 }, next: index + 1 }),
  ),
  Match.when(
    "{",
    () =>
      ({ source }: Text, index: number) =>
        pipe(
          source.slice(index),
          Str.match(COUNTED),
          Option.map((counted) => ({
            value: countOf(counted),
            next: index + groupText(counted, 0).length,
          })),
        ),
  ),
  Match.orElse(
    () =>
      (_text: Text, _index: number): Option.Option<Read<Count>> =>
        Option.none(),
  ),
);

/** The quantifier after an atom, if any, and the index after it. */
const readQuantifier = (text: Text, index: number): Read<Option.Option<Count>> =>
  pipe(
    charAt(text, index),
    Option.flatMap((char) => countReader(char)(text, index)),
    Option.match({
      onNone: () => ({ value: Option.none(), next: index }),
      // A lazy quantifier backtracks in the other order, and just as long.
      onSome: ({ value, next }) => ({
        value: Option.some(value),
        next:
          next + pipe(isAt(text, next, "?"), Boolean.match({ onFalse: () => 0, onTrue: () => 1 })),
      }),
    }),
  );

/** An atom that ends before `next`, with the quantifier after it. */
const atom = (text: Text, { value, next }: Read<Node>): Read<Token> => {
  const quantifier = readQuantifier(text, next);
  return { value: Token.Atom({ node: value, count: quantifier.value }), next: quantifier.next };
};

/** The reader for the token that starts with one character. */
const tokenReader = pipe(
  Match.type<string>(),
  Match.when("|", (): Reader<Token> => (_text, index) => succeed(Token.Bar(), index + 1)),
  Match.when(")", (): Reader<Token> => (text, index) => {
    const quantifier = readQuantifier(text, index + 1);
    return succeed(Token.Close({ count: quantifier.value }), quantifier.next);
  }),
  Match.when("(", (): Reader<Token> => (text, index) => readGroup(text, index + 1)),
  Match.when(
    "[",
    (): Reader<Token> => (text, index) =>
      pipe(
        readClass(text, index + 1),
        Result.map(({ value, next }) => atom(text, { value: charNode(value), next })),
      ),
  ),
  Match.when(
    "\\",
    (): Reader<Token> => (text, index) =>
      pipe(
        readAtomEscape(text, index + 1),
        Result.map((read) => atom(text, read)),
      ),
  ),
  Match.when(
    ".",
    (): Reader<Token> => (text, index) =>
      Result.succeed(atom(text, { value: charNode(text.flags.dot), next: index + 1 })),
  ),
  Match.whenOr(
    "^",
    "$",
    (): Reader<Token> => (text, index) =>
      Result.succeed(atom(text, { value: ANCHOR_NODE, next: index + 1 })),
  ),
  Match.whenOr("*", "+", "?", (): Reader<Token> => () => Result.fail(UNSUPPORTED_SYNTAX)),
  Match.orElse((): Reader<Token> => (text, index) => {
    const { value, next } = readCodePoint(text, index);
    return Result.succeed(atom(text, { value: charNode(oneChar(value)), next }));
  }),
);

/**
 * Read `source` into tokens.
 *
 * The lexer stops after the first piece that it cannot read. That piece is a
 * failure with the reason, and the tokens before it are read as usual, so the
 * parser meets every fault in the order of the text.
 */
const lex = (source: string, flags: Flags): Iterable<Result.Result<Token, string>> => {
  const text: Text = { source, flags };
  return pipe(
    readEach(0, (index) =>
      pipe(
        charAt(text, index),
        Option.map((char) => tokenReader(char)(text, index)),
      ),
    ),
    Iterable.map(Result.map(({ value }) => value)),
  );
};

// ---------------------------------------------------------------------------
// The parser
// ---------------------------------------------------------------------------

/**
 * The branches of one group, while the parser reads it.
 *
 * A chunk appends in logarithmic time, so a long branch does not copy its
 * parts once for every part that it adds.
 */
interface Branches {
  /** The branches that a `|` already ended. */
  readonly done: Chunk.Chunk<Node>;
  /** The parts of the branch that the parser reads now. */
  readonly parts: Chunk.Chunk<Node>;
}

const NO_BRANCHES: Branches = { done: Chunk.empty(), parts: Chunk.empty() };

/** A group that a `(` opened, and that no `)` closed yet. */
interface Frame {
  readonly opener: Opener;
  readonly branches: Branches;
}

/** The open groups: the innermost one, and the groups that hold it. */
interface OpenGroups {
  readonly innermost: Frame;
  readonly outer: Option.Option<OpenGroups>;
}

interface Parser {
  readonly open: Option.Option<OpenGroups>;
  /** The branches of the whole pattern. */
  readonly root: Branches;
  /** The lookaheads and lookbehinds that the parser has opened so far. */
  readonly assertions: number;
}

const START: Parser = { open: Option.none(), root: NO_BRANCHES, assertions: 0 };

/** The open groups, the innermost first. */
const framesOf = (open: Option.Option<OpenGroups>): Iterable<Frame> =>
  Iterable.unfold(
    open,
    Option.map(({ innermost, outer }) => [innermost, outer] as const),
  );

/** The constructors of the inner nodes, which compare sets under the flags. */
interface Tree {
  /** No part is the empty node, and one part is that part. */
  readonly concat: (parts: Chunk.Chunk<Node>) => Node;
  /** One branch is that branch. */
  readonly alternation: (branches: Branches) => Node;
}

const makeTree = (intersect: Intersect): Tree => {
  const concat = (chunk: Chunk.Chunk<Node>): Node => {
    const parts = Chunk.toReadonlyArray(chunk);
    return pipe(
      parts,
      Array.matchLeft({
        onEmpty: () => EMPTY_NODE,
        onNonEmpty: (head, rest) =>
          pipe(
            rest,
            Array.match({ onEmpty: () => head, onNonEmpty: () => concatNode(intersect)(parts) }),
          ),
      }),
    );
  };
  const alternation = ({ done, parts }: Branches): Node => {
    const branches = pipe(done, Chunk.append(concat(parts)), Chunk.toReadonlyArray);
    return pipe(
      Array.tailNonEmpty(branches),
      Array.match({
        onEmpty: () => Array.headNonEmpty(branches),
        onNonEmpty: () => altNode(intersect)(branches),
      }),
    );
  };
  return { concat, alternation };
};

const quantified = (node: Node, count: Option.Option<Count>): Node =>
  pipe(count, Option.match({ onNone: () => node, onSome: (bounds) => repeatNode(node, bounds) }));

/** Change the branches of the innermost open group, or of the pattern. */
const modifyCurrent = (parser: Parser, change: (branches: Branches) => Branches): Parser =>
  pipe(
    parser.open,
    Option.match({
      onNone: () => pipe(parser, Struct.assign({ root: change(parser.root) })),
      onSome: ({ innermost: { opener, branches }, outer }) =>
        pipe(
          parser,
          Struct.assign({
            open: Option.some({ innermost: { opener, branches: change(branches) }, outer }),
          }),
        ),
    }),
  );

const addPart =
  (node: Node) =>
  ({ done, parts }: Branches): Branches => ({ done, parts: pipe(parts, Chunk.append(node)) });

const endBranch =
  (tree: Tree) =>
  ({ done, parts }: Branches): Branches => ({
    done: pipe(done, Chunk.append(tree.concat(parts))),
    parts: Chunk.empty(),
  });

const push = (parser: Parser, opener: Opener): Parser =>
  pipe(
    parser,
    Struct.assign({
      open: Option.some({ innermost: { opener, branches: NO_BRANCHES }, outer: parser.open }),
    }),
  );

const lookDepth = (parser: Parser): number =>
  pipe(
    framesOf(parser.open),
    Iterable.filter(({ opener }) => Opener.$is("Look")(opener)),
    Iterable.size,
  );

/** Open a lookahead or a lookbehind, within the two limits on assertions. */
const openLook: (parser: Parser) => Result.Result<Parser, string> = flow(
  Result.liftPredicate(
    ({ assertions }: Parser) => assertions + 1 <= ASSERTION_LIMIT,
    () => MANY_ASSERTIONS,
  ),
  Result.filterOrFail(
    (parser) => lookDepth(parser) + 1 <= ASSERTION_DEPTH_LIMIT,
    () => NESTED_ASSERTIONS,
  ),
  Result.map((parser) =>
    pipe(push(parser, Opener.Look()), Struct.assign({ assertions: parser.assertions + 1 })),
  ),
);

const closeGroup = (
  tree: Tree,
  parser: Parser,
  count: Option.Option<Count>,
): Result.Result<Parser, string> =>
  pipe(
    parser.open,
    Option.match({
      // A `)` that no `(` opened.
      onNone: () => Result.fail(UNSUPPORTED_SYNTAX),
      onSome: ({ innermost: { opener, branches }, outer }) => {
        const group = pipe(
          opener,
          Opener.$match({
            Group: () => tree.alternation(branches),
            Look: () => lookNode(tree.alternation(branches)),
          }),
        );
        const closed = pipe(parser, Struct.assign({ open: outer }));
        return Result.succeed(modifyCurrent(closed, addPart(quantified(group, count))));
      },
    }),
  );

const step = (tree: Tree, parser: Parser, token: Token): Result.Result<Parser, string> =>
  pipe(
    token,
    Token.$match({
      Atom: ({ node, count }) =>
        Result.succeed(modifyCurrent(parser, addPart(quantified(node, count)))),
      Bar: () => Result.succeed(modifyCurrent(parser, endBranch(tree))),
      Open: ({ opener }) =>
        pipe(
          opener,
          Opener.$match({
            Group: () => Result.succeed(push(parser, opener)),
            Look: () => openLook(parser),
          }),
        ),
      Close: ({ count }) => closeGroup(tree, parser, count),
    }),
  );

/** The tree of the whole pattern. A group that no `)` closed is a fault. */
const finish = (tree: Tree, parser: Parser): Result.Result<Node, string> =>
  pipe(
    parser.open,
    Option.match({
      onNone: () => Result.succeed(tree.alternation(parser.root)),
      onSome: () => Result.fail(UNSUPPORTED_SYNTAX),
    }),
  );

/**
 * Parse `source` into a tree.
 *
 * The caller compiled the same text with `new RegExp` first, so the text is
 * valid. Syntax that this parser does not know is therefore not a fault of the
 * user: it is a limit of the check, and the pattern is refused.
 */
const parse = (source: string, flags: Flags): Result.Result<Node, string> => {
  const tree = makeTree(flags.intersect);
  return pipe(
    lex(source, flags),
    Array.reduce(Result.succeed(START), (parsed: Result.Result<Parser, string>, token) =>
      pipe(
        Result.all([parsed, token]),
        Result.flatMap(([parser, next]) => step(tree, parser, next)),
      ),
    ),
    Result.flatMap((parser) => finish(tree, parser)),
  );
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
const hasCompetingNeighbours = (parts: ReadonlyArray<Node>, intersect: Intersect): boolean =>
  pipe(
    parts,
    Array.some(
      (one, left) =>
        isFlexible(one) &&
        pipe(
          parts,
          Array.drop(left + 1),
          throughFirstSolid((other) => other),
          Array.some(
            (other) =>
              isFlexible(other) &&
              intersect(one.extend, other.first) &&
              intersect(one.last, other.anywhere),
          ),
        ),
    ),
  );

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
  intersect: Intersect,
): boolean => {
  const share = (left: Node, right: Node): boolean =>
    pipe(
      Option.all([left.sequence, right.sequence]),
      Option.match({
        onSome: ([one, other]) => one.length === other.length && overlaps(intersect, one, other),
        onNone: () => inLoop && intersect(left.first, right.first),
      }),
    );
  return pipe(
    branches,
    Array.some((one, left) =>
      pipe(
        branches,
        Array.drop(left + 1),
        Array.some((other) => share(one, other)),
      ),
    ),
  );
};

/** A body that a loop may run many times, or the reason why it may not. */
const loopBody = (body: Node, intersect: Intersect): Result.Result<Node, string> =>
  pipe(
    body,
    // A body that matches nothing can iterate for ever at one position.
    Result.liftPredicate(Predicate.not(isNullable), () => EMPTY_LOOP),
    // A body that can grow past its own end divides one text into iterations
    // in more than one way. `(a+)+` is the known shape.
    Result.filterOrFail(
      ({ extend, first }) => !intersect(extend, first),
      () => AMBIGUOUS_LOOP,
    ),
  );

/** A node that the walk still has to check, and whether a loop encloses it. */
interface Visit {
  readonly node: Node;
  readonly inLoop: boolean;
}

/** The rules that one node breaks, and the nodes inside it that the walk checks next. */
interface Inspection {
  readonly checked: Result.Result<unknown, string>;
  readonly next: ReadonlyArray<Visit>;
}

/** The visits that the walk has still to make, the next one on top. */
interface Pending {
  readonly top: Visit;
  readonly rest: Option.Option<Pending>;
}

const inspect =
  (intersect: Intersect) =>
  ({ node, inLoop }: Visit): Inspection => {
    const inside = (nodes: ReadonlyArray<Node>, loop: boolean): ReadonlyArray<Visit> =>
      pipe(
        nodes,
        Array.map((child) => ({ node: child, inLoop: loop })),
      );
    return pipe(
      node.shape,
      Shape.$match({
        Empty: (): Inspection => ({ checked: Result.void, next: [] }),
        Anchor: (): Inspection => ({ checked: Result.void, next: [] }),
        Char: (): Inspection => ({ checked: Result.void, next: [] }),
        // A lookaround runs at a position and gives back no text, so its cost
        // adds to the cost of the walk. It does not multiply it. The body is
        // therefore held to the same rules as any other expression.
        Look: ({ body }): Inspection => ({ checked: Result.void, next: inside([body], inLoop) }),
        Concat: ({ parts }): Inspection => ({
          checked: pipe(
            parts,
            Result.liftPredicate(
              (list) => !hasCompetingNeighbours(list, intersect),
              () => COMPETING_LOOPS,
            ),
          ),
          next: inside(parts, inLoop),
        }),
        Alt: ({ branches }): Inspection => ({
          checked: pipe(
            branches,
            Result.liftPredicate(
              (list) => !hasAmbiguousBranches(list, inLoop, intersect),
              () => AMBIGUOUS_BRANCHES,
            ),
          ),
          next: inside(branches, inLoop),
        }),
        Repeat: ({ body, max }) =>
          pipe(
            max <= 1,
            Boolean.match({
              onFalse: (): Inspection => ({
                checked: loopBody(body, intersect),
                next: inside([body], true),
              }),
              onTrue: (): Inspection => ({ checked: Result.void, next: inside([body], inLoop) }),
            }),
          ),
      }),
    );
  };

/** Check the visit on top, and put the nodes inside it above the visits that remain. */
const advance =
  (intersect: Intersect) =>
  ({ top, rest }: Pending): readonly [Result.Result<unknown, string>, Option.Option<Pending>] => {
    const { checked, next } = inspect(intersect)(top);
    const pending = pipe(
      next,
      Array.reduceRight(rest, (below, visit) => Option.some<Pending>({ top: visit, rest: below })),
    );
    return [checked, pending];
  };

/**
 * The tree, or the first rule that it breaks.
 *
 * The walk checks a node before the nodes inside it, and the nodes inside it
 * in order. It keeps the visits that it still has to make in a list of its
 * own, so a deep tree cannot exhaust the call stack, and it stops at the first
 * fault.
 */
const check =
  (intersect: Intersect) =>
  (root: Node): Result.Result<Node, string> =>
    pipe(
      Iterable.unfold(
        Option.some<Pending>({ top: { node: root, inLoop: false }, rest: Option.none() }),
        Option.map(advance(intersect)),
      ),
      Result.all,
      Result.map(() => root),
    );

/** Does this tree try more ways to match one text than the budget allows? */
const isOverBudget = (node: Node): boolean => node.cost > PATH_BUDGET;

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
export const regexSafetyError = (source: string, flags: string): Option.Option<string> => {
  const read = readFlags(flags);
  return pipe(
    source,
    Result.liftPredicate(
      (text) => text.length <= MAX_PATTERN_LENGTH,
      () => TOO_LONG,
    ),
    Result.flatMap((text) => parse(text, read)),
    Result.flatMap(check(read.intersect)),
    // The last rule counts the ways that one piece of text can be divided
    // between the parts of the pattern. It reads inside an assertion as well,
    // so `.*(?=.*x)` costs as much as `a.*b.*c` and is refused with it.
    Result.filterOrFail(Predicate.not(isOverBudget), () => MANY_LOOPS),
    Result.getFailure,
  );
};
