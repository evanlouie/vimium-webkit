/**
 * The find engine: a `TreeWalker` and a `Range`.
 *
 * This is not `window.find()`, on purpose. That API is not standard, it gives
 * no match count, it cannot list the matches, it moves the selection of the
 * user as a side effect, and it cannot see into a shadow root. Find needs every
 * one of those. Upstream Vimium writes its own engine for the same reasons.
 *
 * Every function here is a plain function. Each one takes the `Document`, the
 * `Window` or the `CapabilityReport` that it needs, and gives an answer. The
 * service in `Find.ts` calls them inside `dom.probeOrElse`, so a realm that
 * refuses a read costs one search and not the application.
 *
 * A run is the longest sequence of text nodes that share one tree root. A match
 * is only ever built *inside* one run, because a `Range` whose two boundaries
 * are in different node trees is not a range: `setEnd` collapses it without a
 * word.
 *
 * A search reads the text of a run in windows, so that it can stop at a
 * deadline. It still finds the matches that one search over the whole text
 * finds, at the same places, whatever the size of the windows, as long as the
 * pattern reads no more than `LONGEST_SURE_MATCH` (1024) characters ahead of
 * a position where it tries to match, and no more than `LEADING_CONTEXT` (256)
 * characters behind it. The safety check caps a pattern at 512 characters, so a
 * literal query fits with room for the runs of whitespace that it crosses. A
 * longer match is found when a part of it reaches the end of the text that the
 * search read, as `.+` does: the search then reads more, up to
 * `MAX_MATCH_LENGTH`, or reports a stop. Any other longer match can be missed.
 */

import { Array, Boolean, Data, HashSet, Match, Number, Option, Result, flow, pipe } from "effect";
import { constFalse } from "effect/Function";
import type { CapabilityReport } from "~/platform/Capabilities.ts";
import { readClock } from "~/platform/Dom.ts";
import { isElement, isText } from "~/platform/Elements.ts";

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

/**
 * Is `root` a document? It reads the node type, and not `instanceof`, as the
 * guards in `~/platform/Elements.ts` do: a root can come from another realm.
 */
const isDocument = (root: Document | ShadowRoot): root is Document =>
  root.nodeType === Node.DOCUMENT_NODE;

// ---------------------------------------------------------------------------
// The haystack
// ---------------------------------------------------------------------------

/**
 * The whitespace that a layout engine draws as one plain space.
 *
 * Every member is one UTF-16 code unit. That is the whole point: the
 * substitution must keep the length, or a match offset stops mapping back to an
 * offset in a `Text` node.
 */
const COLLAPSIBLE_WHITESPACE =
  /[\n\r\t\f\v\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/g;

/**
 * Change each whitespace character to U+0020, and keep the length.
 *
 * Without this a query of `sign in` does not match `<a>sign\n  in</a>`, which
 * is text that the browser draws as "sign in". The other half of the rule is in
 * `~/domain/FindQuery.ts`, which compiles literal whitespace to ` +`.
 */
export const normaliseHaystack = (text: string): string =>
  text.replace(COLLAPSIBLE_WHITESPACE, " ");

// ---------------------------------------------------------------------------
// Spans
// ---------------------------------------------------------------------------

export interface MatchSpan {
  readonly start: number;
  /** Exclusive. */
  readonly end: number;
}

/** Above this count, the highlight costs more than the matches give. */
export const DEFAULT_MATCH_LIMIT = 500;

/**
 * The time budget for one `matchesInRuns` pass.
 *
 * A pattern from the user in `regexFindMode` runs against the whole page on
 * every keystroke. `~/domain/FindQuery.ts` refuses the shapes that it can prove
 * ambiguous, but that check does not promise a linear match: `[a-z]*x` costs
 * about 2.3 s in one `exec` against 40 000 characters.
 *
 * The search therefore reads the text in windows, and looks at the clock
 * between two of them. A stop gives the matches that are already found, which
 * is what an incremental find wants, and the caller reports the stop.
 */
export const MATCH_BUDGET_MS = 50;

/**
 * The largest window that the search reads in one `exec`.
 *
 * A window grows only after a window of the size below it was measured and was
 * cheap. See `FIRST_WINDOW`.
 */
export const SEARCH_WINDOW = 1024;

/**
 * The first window, and the smallest one.
 *
 * One `exec` cannot be stopped from JavaScript, so the size of one window is
 * the true limit on how long find can hold the main thread. Nothing has
 * measured the pattern when the search starts, so the search starts small and
 * grows only while each window stays cheap.
 */
const FIRST_WINDOW = 32;

/**
 * The most that one window may cost before the next window becomes smaller.
 *
 * The window doubles only when the window before it cost a quarter of this
 * value or less. A pattern whose cost grows with the square of the window
 * therefore stays inside the budget after it doubles, and a slower pattern
 * overruns it once and then shrinks.
 */
const WINDOW_BUDGET_MS = 8;

/**
 * The text that each window keeps before it.
 *
 * A window is a slice of the haystack, so `\b` and a lookbehind need the text
 * before it. That text holds no start position, so it costs one copy.
 */
const LEADING_CONTEXT = 256;

/**
 * The longest match that a search finds whole wherever it starts, and the text
 * that each window keeps after it.
 *
 * A match that starts in a window therefore has this much text ahead of it,
 * whatever the size of the window, and an `exec` on the slice gives what an
 * `exec` on the whole text gives. With less, a match that started late in a
 * window and needed more text did not match in the slice, and the next window
 * began after its start: it was lost, and nothing said so.
 *
 * Twice the longest pattern. The price is the text that each `exec` reads
 * again in the next window. A literal query costs about a fifth more. A
 * pattern whose cost grows with the square of the text, such as `[a-z]*x`,
 * costs about two and a half times as much, so it reaches the deadline
 * sooner, and the search reports the stop.
 */
export const LONGEST_SURE_MATCH = 1024;

/**
 * How much longer a slice becomes when a match reaches its end.
 *
 * The step is measured, exactly as the window is. A slice grows only while the
 * work so far in this window stayed inside `WINDOW_BUDGET_MS`.
 */
const SLICE_GROWTH = 4;

/**
 * The longest match that the search can find.
 *
 * A slice never grows past this length. A match that still reaches the end of
 * such a slice is not reported, and the search reports a stop instead. A wrong
 * span is worse than no span.
 */
export const MAX_MATCH_LENGTH = 65_536;

/** What one search of a haystack gave, and whether it read all of it. */
export interface SpanSearch {
  readonly spans: ReadonlyArray<MatchSpan>;
  /** True when the search stopped before the end of the text. */
  readonly stopped: boolean;
}

const NOTHING_FOUND: SpanSearch = { spans: [], stopped: false };

/**
 * Every match of `pattern` in `haystack`, up to `limit`.
 *
 * The expression is copied, and not used as it is. `lastIndex` on a `g`
 * expression is state that changes, and a caller that used one expression for
 * two searches would lose the first half of the second search.
 *
 * The text is read in windows. Each window also holds `LEADING_CONTEXT`
 * characters of the text before it and `LONGEST_SURE_MATCH` characters after
 * it, so that a word boundary, a lookaround and a long match still see what is
 * beside them. A match belongs to the window that holds its first character,
 * so no match is counted twice.
 *
 * Two limits bound the work:
 *
 * - the clock is read between two windows, and the search stops at `deadline`;
 * - each window is measured, and the next window is smaller when a window cost
 *   more than `windowBudget`, `WINDOW_BUDGET_MS` by default. The first window
 *   is `FIRST_WINDOW` characters, because nothing has measured the pattern
 *   yet.
 *
 * A match that reaches the end of its slice grows the slice, up to
 * `MAX_MATCH_LENGTH`. The search then finds the whole match, or reports a stop.
 */
export const collectSpans = (
  haystack: string,
  pattern: RegExp,
  limit: number = DEFAULT_MATCH_LIMIT,
  deadline: number = readClock() + MATCH_BUDGET_MS,
  windowBudget: number = WINDOW_BUDGET_MS,
): SpanSearch =>
  pipe(
    limit > 0 && haystack.length > 0,
    Boolean.match({
      onFalse: () => NOTHING_FOUND,
      onTrue: () =>
        scanWindows(
          haystack,
          new RegExp(pattern.source, `${pattern.flags.replace("g", "")}g`),
          limit,
          deadline,
          windowBudget,
        ),
    }),
  );

/**
 * The window loop of `collectSpans`.
 *
 * This is a loop with mutable state on purpose. It runs on every keystroke,
 * over the whole text of the page, against `MATCH_BUDGET_MS`. An
 * `Array.unfold` over an immutable state machine found the same spans three to
 * six times slower in JavaScriptCore: 0.97 ms against 0.33 ms over 2 MB of text
 * with no match, and 0.16 ms against 0.03 ms for 500 matches. A `Boolean.match`
 * built in the clock and in `nextWindow` at each call, which happens for each
 * window, made the whole search 1.4 to 1.9 times slower. `nextWindow` stays a
 * plain conditional, and `readClock` builds its matcher once.
 */
const scanWindows = (
  haystack: string,
  regex: RegExp,
  limit: number,
  deadline: number,
  windowBudget: number,
): SpanSearch => {
  const spans: MatchSpan[] = [];
  // Where the next match may begin. A match can end after the window that
  // holds its first character, and the text that it covers is then taken.
  let cursor = 0;
  let window = FIRST_WINDOW;

  while (cursor < haystack.length) {
    // The clock is read between two windows. One `exec` cannot be stopped, so
    // the window is the work that one look at the clock cannot prevent.
    if (readClock() > deadline) return { spans, stopped: true };

    const started = readClock();
    const windowEnd = Math.min(cursor + window, haystack.length);
    const sliceStart = Math.max(0, cursor - LEADING_CONTEXT);
    let sliceEnd = Math.min(haystack.length, windowEnd + LONGEST_SURE_MATCH);
    let slice = haystack.slice(sliceStart, sliceEnd);
    regex.lastIndex = cursor - sliceStart;

    for (;;) {
      const match = regex.exec(slice);
      if (match === null) break;

      const start = sliceStart + match.index;
      // The next window owns this match, and it begins its search there.
      if (start >= windowEnd) break;

      // `exec` leaves `lastIndex` at the end of the match, because the
      // expression is global.
      const length = regex.lastIndex - match.index;
      if (length === 0) {
        // A zero-width pattern such as `^` or `x*` never moves `lastIndex` by
        // itself, so the loop would never end. Such a match also cannot be
        // drawn, so it is stepped over and not recorded.
        regex.lastIndex = match.index + 1;
        if (regex.lastIndex > slice.length) break;
        continue;
      }

      const end = start + length;
      if (end >= sliceEnd && sliceEnd < haystack.length) {
        // The match reaches the end of the slice, so the text beside it could
        // make the match longer, or could take it away: `$` matches at the end
        // of a slice as well. Read the same position again with more text.
        // Nothing is recorded until the whole match is inside the slice.
        if (
          sliceEnd - sliceStart >= MAX_MATCH_LENGTH ||
          readClock() - started > windowBudget ||
          readClock() > deadline
        ) {
          return { spans, stopped: true };
        }
        sliceEnd = Math.min(
          haystack.length,
          sliceStart + Math.min((sliceEnd - sliceStart) * SLICE_GROWTH, MAX_MATCH_LENGTH),
        );
        slice = haystack.slice(sliceStart, sliceEnd);
        regex.lastIndex = start - sliceStart;
        continue;
      }

      spans.push({ start, end });
      cursor = end;
      if (spans.length >= limit) return { spans, stopped: false };
    }

    cursor = Math.max(cursor, windowEnd);
    window = nextWindow(window, readClock() - started, windowBudget);
  }

  return { spans, stopped: false };
};

/**
 * The size of the window that follows a window of `size` that cost `elapsed`.
 *
 * The window doubles only with a margin of four, and it halves as soon as one
 * window overruns the budget. The size therefore follows the cost of the
 * pattern, and one slow pattern costs one slow window.
 *
 * It runs once for each window of `scanWindows`, so it keeps the plain
 * conditionals that the measurement there asks for.
 */
const nextWindow = (size: number, elapsed: number, budget: number): number => {
  if (elapsed > budget) {
    return Math.max(FIRST_WINDOW, Math.floor(size / 2));
  }
  return elapsed * 4 <= budget ? Math.min(SEARCH_WINDOW, size * 2) : size;
};

// ---------------------------------------------------------------------------
// An offset, mapped back to a chunk
// ---------------------------------------------------------------------------

export interface ChunkPosition {
  /** The index in the node list of the run. */
  readonly index: number;
  /** The offset inside that node. */
  readonly offset: number;
}

/**
 * The exclusive prefix sums of `lengths`.
 *
 * `starts[i]` is where chunk `i` begins.
 */
export const chunkStarts: (lengths: ReadonlyArray<number>) => ReadonlyArray<number> = flow(
  Array.scan(0, (total: number, length: number) => total + length),
  Array.dropRight(1),
);

/** Which end of a match an offset marks. */
export type MatchEnd = "start" | "end";

/**
 * Map an offset in the haystack back to a chunk and an offset in it.
 *
 * `end` decides what happens on the boundary between two chunks. The start of
 * a match belongs to the chunk that *begins* there. The end of a match belongs
 * to the chunk that *ends* there. The other way round gives a range with a
 * boundary in an empty node beside it, and such a range draws no client
 * rectangle at all.
 */
export const locateOffset = (
  starts: ReadonlyArray<number>,
  lengths: ReadonlyArray<number>,
  offset: number,
  end: MatchEnd = "start",
): Option.Option<ChunkPosition> =>
  pipe(
    lastIndexWhere(starts, (start) => start <= offset),
    Option.filter(() => offset >= 0),
    Option.map((found) => chunkChooser(end)(starts, lengths, offset, found)),
    Option.flatMap((index) => positionIn(starts, lengths, index, offset)),
  );

/**
 * The chunk that owns `offset`, from `found`, the last chunk that begins at or
 * before it.
 */
type ChunkChooser = (
  starts: ReadonlyArray<number>,
  lengths: ReadonlyArray<number>,
  offset: number,
  found: number,
) => number;

/** The start of a match steps forward over a chunk of length zero. */
const chunkAtStart: ChunkChooser = (starts, lengths, _offset, found) =>
  skipEmpty(lengths, found, starts.length - 1);

/** The end of a match steps back over the boundary, to the chunk that closes there. */
const chunkAtEnd: ChunkChooser = (starts, _lengths, offset) =>
  pipe(
    lastIndexWhere(starts, (start) => start < offset),
    Option.getOrElse(() => 0),
  );

const chunkChooser: (end: MatchEnd) => ChunkChooser = pipe(
  Match.type<MatchEnd>(),
  Match.when("start", () => chunkAtStart),
  Match.when("end", () => chunkAtEnd),
  Match.exhaustive,
);

/**
 * The last index of `sorted` at which `holds` is true.
 *
 * `holds` must be true for a prefix of `sorted` and false after it, so a
 * binary search finds the edge.
 *
 * This is a loop on purpose. It runs for both ends of every match, on every
 * keystroke, over the chunks of the largest run. With a recursive search built
 * from `Boolean.match` and `Array.get`, `locateOffset` took 4.3 ms for 500
 * matches over 50 000 chunks, against 0.66 ms with this loop, and a whole
 * search of a large page in Chrome was six times slower.
 */
const lastIndexWhere = (
  sorted: ReadonlyArray<number>,
  holds: (value: number) => boolean,
): Option.Option<number> => {
  let low = 0;
  let high = sorted.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const value = sorted[middle];
    if (value !== undefined && holds(value)) low = middle + 1;
    else high = middle - 1;
  }
  return pipe(
    high,
    Option.liftPredicate((index) => index >= 0),
  );
};

/**
 * Step forward from `index` over chunks of length zero, and stop at `last`.
 *
 * A walk never collects an empty text node, so a run has no such chunk.
 */
const skipEmpty = (lengths: ReadonlyArray<number>, index: number, last: number): number =>
  pipe(
    index < last &&
      pipe(
        lengths,
        Array.get(index),
        Option.exists((length) => length === 0),
      ),
    Boolean.match({
      onFalse: () => index,
      onTrue: () => skipEmpty(lengths, index + 1, last),
    }),
  );

/** The position of `offset` inside chunk `index`, when the chunk holds it. */
const positionIn = (
  starts: ReadonlyArray<number>,
  lengths: ReadonlyArray<number>,
  index: number,
  offset: number,
): Option.Option<ChunkPosition> =>
  pipe(
    starts,
    Array.get(index),
    Option.map((start) => offset - start),
    Option.filter(
      (local) =>
        local >= 0 &&
        pipe(
          lengths,
          Array.get(index),
          Option.exists((length) => local <= length),
        ),
    ),
    Option.map((local) => ({ index, offset: local })),
  );

// ---------------------------------------------------------------------------
// The word under an offset
// ---------------------------------------------------------------------------

const WORD_CHARACTER = /[\p{L}\p{N}_]/u;

/**
 * Is this one UTF-16 code unit a word character?
 *
 * A code unit, and not a code point, so a letter outside the Basic
 * Multilingual Plane is not part of a word. That is how the search has always
 * read it.
 */
const isWordUnit = (unit: string): boolean => WORD_CHARACTER.test(unit);

/**
 * The word around `offset` in `text`, or `""`.
 *
 * This is what `*` and `#` search for. When the caret sits just *after* a word,
 * which is where a click usually leaves it, the character to the left is used.
 * Vim does the same.
 */
export const wordAt = (text: string, offset: number): string => {
  const units = text.split("");
  const clamped = Math.max(0, Math.min(offset, text.length));
  return pipe(
    [clamped, clamped - 1],
    Array.findFirst((index) =>
      pipe(units, Array.get(index), Option.filter(isWordUnit), Option.as(index)),
    ),
    Option.map((anchor) => {
      const before = pipe(units, Array.take(anchor), Array.reverse, Array.takeWhile(isWordUnit));
      const after = pipe(units, Array.drop(anchor), Array.takeWhile(isWordUnit));
      return text.slice(anchor - before.length, anchor + after.length);
    }),
    Option.getOrElse(() => ""),
  );
};

// ---------------------------------------------------------------------------
// The walk
// ---------------------------------------------------------------------------

/** The elements whose text the browser never draws as page content. */
const OPAQUE_TAGS = HashSet.make(
  "SCRIPT",
  "STYLE",
  "NOSCRIPT",
  "TEXTAREA",
  "TEMPLATE",
  "TITLE",
  "HEAD",
  "SELECT",
  "OPTION",
  "OPTGROUP",
  "IFRAME",
  "OBJECT",
  "EMBED",
  "CANVAS",
  "AUDIO",
  "VIDEO",
);

/**
 * One unbroken stretch of text nodes that share one tree root.
 *
 * `haystack` is the join of the node data, after normalisation. A match can
 * therefore begin in one node and end in another, which is the usual case on
 * any page that puts part of a phrase in a `<b>`.
 */
export interface TextRun {
  readonly nodes: ReadonlyArray<Text>;
  readonly lengths: ReadonlyArray<number>;
  readonly starts: ReadonlyArray<number>;
  readonly haystack: string;
}

export interface CollectOptions {
  readonly view: Window;
  readonly document: Document;
  readonly capabilities: CapabilityReport;
  /** The host of our own closed shadow root. It is never searched. */
  readonly excludeHost: Option.Option<Element>;
  /**
   * A hard stop, so that one bad page cannot block the keystroke that opened
   * find.
   */
  readonly maxCharacters: number;
}

/** About the text of one novel. Above this, nobody is reading the page. */
export const DEFAULT_MAX_CHARACTERS = 2_000_000;

/** What every walk of one search shares. */
interface WalkContext {
  readonly document: Document;
  readonly visible: (element: Element) => boolean;
  /** Is this the host of our own closed shadow root? */
  readonly excluded: (element: Element) => boolean;
}

const VISIBILITY_OPTIONS: CheckVisibilityOptions = {
  contentVisibilityAuto: true,
  visibilityProperty: true,
};

/**
 * Does the browser draw `element`?
 *
 * `checkVisibility` is used where it exists, which is Safari 17.4 and later. It
 * is the only check that accounts for `content-visibility: auto`, which Safari
 * 18 has, and which makes an answer from `getComputedStyle` wrong. The
 * capability report decides. A method that the page takes away later throws,
 * and the element then counts as searchable.
 */
const isVisible =
  (view: Window, capabilities: CapabilityReport) =>
  (element: Element): boolean =>
    pipe(
      Result.try(() =>
        pipe(
          capabilities.checkVisibility,
          Boolean.match({
            onTrue: () => element.checkVisibility(VISIBILITY_OPTIONS),
            onFalse: () => {
              const style = view.getComputedStyle(element);
              return style.display !== "none" && style.visibility !== "hidden";
            },
          }),
        ),
      ),
      // A detached element, or an element of another document. Treat it as
      // searchable, instead of dropping half of the page for one bad node.
      Result.getOrElse(() => true),
    );

/**
 * Collect the searchable text of the document, and descend into every
 * **open** shadow root.
 *
 * A closed root is invisible to us by design. `element.shadowRoot` is `null`,
 * and a patch of `attachShadow` needs a `document-start` that WebKit does not
 * give a userscript. The content of such a root does not appear.
 *
 * Slotted content is collected exactly once, from the light DOM of the host. A
 * `TreeWalker` over a shadow root never visits the assigned nodes of a slot,
 * because those are not its children. Nothing is counted twice, and nothing is
 * lost. Each root is also walked once: a shadow root has one host, and that
 * host lives in one tree.
 */
export const collectTextRuns = (options: CollectOptions): ReadonlyArray<TextRun> => {
  const context: WalkContext = {
    document: options.document,
    visible: isVisible(options.view, options.capabilities),
    excluded: pipe(
      options.excludeHost,
      Option.match({
        onNone: () => constFalse,
        onSome: (host) => (element: Element) => element === host,
      }),
    ),
  };
  const start: Walk = { pending: [options.document], remaining: options.maxCharacters };
  return pipe(Array.unfold(start, nextRoot(context)), Array.getSomes);
};

/** Where the walk of the roots stands. */
interface Walk {
  /** The roots that are still to walk, in the order that they were found. */
  readonly pending: ReadonlyArray<Document | ShadowRoot>;
  /** The characters that the walk may still collect. */
  readonly remaining: number;
}

/** Walk the next root, and queue the shadow roots that it holds. */
const nextRoot =
  (context: WalkContext) =>
  ({ pending, remaining }: Walk): Option.Option<readonly [Option.Option<TextRun>, Walk]> =>
    pipe(
      pending,
      Option.liftPredicate(Array.isReadonlyArrayNonEmpty),
      Option.filter(() => remaining > 0),
      Option.map(Array.unprepend),
      Option.map(([root, rest]) => {
        const collected = collectFromRoot(context, remaining, root);
        const walk: Walk = {
          pending: pipe(rest, Array.appendAll(collected.shadowRoots)),
          remaining: remaining - collected.consumed,
        };
        return [collected.run, walk] as const;
      }),
    );

interface RootCollection {
  readonly run: Option.Option<TextRun>;
  readonly shadowRoots: ReadonlyArray<ShadowRoot>;
  readonly consumed: number;
}

const collectFromRoot = (
  context: WalkContext,
  remaining: number,
  root: Document | ShadowRoot,
): RootCollection => {
  const walker = context.document.createTreeWalker(
    walkScope(root),
    NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
    { acceptNode: nodeVerdict(context) },
  );
  const visited = acceptedNodes(walker, remaining);
  const nodes = pipe(visited, Array.filter(isText));
  const texts = pipe(
    nodes,
    Array.map((node) => node.data),
  );
  const lengths = pipe(
    texts,
    Array.map((text) => text.length),
  );
  return {
    run: pipe(
      nodes,
      Array.match({
        onEmpty: () => Option.none(),
        onNonEmpty: (nodes) =>
          Option.some({
            nodes,
            lengths,
            starts: chunkStarts(lengths),
            haystack: pipe(texts, Array.join(""), normaliseHaystack),
          }),
      }),
    ),
    // Accepted elements are the hosts of open shadow roots.
    shadowRoots: pipe(
      visited,
      Array.filter(isElement),
      Array.map((element) => Option.fromNullishOr(element.shadowRoot)),
      Array.getSomes,
    ),
    consumed: Number.sumAll(lengths),
  };
};

/**
 * The node that a walk of `root` starts from.
 *
 * A `ShadowRoot` is a `DocumentFragment`, and it has no `createTreeWalker`.
 * The factory is on `Document`, and the root of a walker may be any node.
 */
const walkScope = (root: Document | ShadowRoot): Node =>
  pipe(
    root,
    Option.liftPredicate(isDocument),
    Option.flatMapNullishOr((document) => document.body),
    Option.getOrElse((): Node => root),
  );

// The verdicts are built once, and not for each node: the walker asks for one
// on every node of the page.

/** An empty text node holds nothing to find. */
const textVerdict: (nonEmpty: boolean) => number = Boolean.match({
  onTrue: () => NodeFilter.FILTER_ACCEPT,
  onFalse: () => NodeFilter.FILTER_REJECT,
});

/**
 * A searchable element is accepted only so that the walk can queue its shadow
 * root. The light children are still walked, and that is where slotted text is.
 */
const hostVerdict: (hasShadowRoot: boolean) => number = Boolean.match({
  onTrue: () => NodeFilter.FILTER_ACCEPT,
  onFalse: () => NodeFilter.FILTER_SKIP,
});

const elementVerdict: (searchable: Option.Option<Element>) => number = Option.match({
  // A reject cuts the whole subtree. That is what makes one visibility check
  // for each element affordable *and* correct: a `display: none` on an
  // ancestor is never derived again from a descendant.
  onNone: () => NodeFilter.FILTER_REJECT,
  onSome: (element: Element) => hostVerdict(element.shadowRoot !== null),
});

/** What the walker does with each node: take it, skip it, or cut its subtree. */
const nodeVerdict = (context: WalkContext): ((node: Node) => number) =>
  pipe(
    Match.type<Node>(),
    Match.when(isText, (text) => textVerdict(text.data.length > 0)),
    Match.when(
      isElement,
      flow(
        Option.liftPredicate((element: Element) => isSearchable(context, element)),
        elementVerdict,
      ),
    ),
    Match.orElse(() => NodeFilter.FILTER_SKIP),
  );

/**
 * Can the text under `element` be page content?
 *
 * The visibility check comes last, because it is the one that reaches into
 * layout.
 */
const isSearchable = (context: WalkContext, element: Element): boolean =>
  !context.excluded(element) &&
  !pipe(OPAQUE_TAGS, HashSet.has(element.tagName)) &&
  !element.hasAttribute("hidden") &&
  context.visible(element);

/** The nodes that `walker` accepts, until the text among them reaches `budget` characters. */
const acceptedNodes = (walker: TreeWalker, budget: number): ReadonlyArray<Node> => {
  const nextWithin = flow(
    Option.liftPredicate((consumed: number) => consumed < budget),
    Option.flatMapNullishOr(() => walker.nextNode()),
  );
  return Array.unfold(0, (consumed) =>
    pipe(
      consumed,
      nextWithin,
      Option.map((node) => [node, consumed + textLength(node)] as const),
    ),
  );
};

const textLength: (node: Node) => number = pipe(
  Match.type<Node>(),
  Match.when(isText, (text) => text.data.length),
  Match.orElse(() => 0),
);

// ---------------------------------------------------------------------------
// Matches
// ---------------------------------------------------------------------------

export interface FindMatch {
  readonly range: Range;
  readonly text: string;
  /**
   * The bounding rectangle at the time of the walk, in viewport coordinates.
   *
   * It is used only to choose the match that is nearest to the scroll position
   * when a search starts. The highlight always measures again.
   */
  readonly rect: DOMRect;
}

/**
 * A range from one text position to another.
 *
 * `None` when the DOM moved under us between the walk and this call.
 */
const spanRange = Option.liftThrowable(
  (document: Document, start: CaretPosition, end: CaretPosition): Range => {
    const range = document.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    return range;
  },
);

interface CaretPosition {
  readonly node: Text;
  readonly offset: number;
}

/** Build a `Range` for `span` inside `run`. */
export const rangeForSpan = (
  document: Document,
  run: TextRun,
  span: MatchSpan,
): Option.Option<Range> =>
  pipe(
    caretIn(run, span.start, "start"),
    Option.flatMap((start) =>
      pipe(
        caretIn(run, span.end, "end"),
        Option.flatMap((end) => spanRange(document, start, end)),
      ),
    ),
    Option.filter((range) => !range.collapsed),
  );

/** The text node and the offset in it that one end of a match maps to. */
const caretIn = (run: TextRun, offset: number, end: MatchEnd): Option.Option<CaretPosition> =>
  pipe(
    locateOffset(run.starts, run.lengths, offset, end),
    Option.flatMap((position) =>
      pipe(
        run.nodes,
        Array.get(position.index),
        Option.map((node) => ({ node, offset: position.offset })),
      ),
    ),
  );

/** What one walk of the runs gave, and whether it read all of them. */
export interface RunSearch {
  readonly matches: ReadonlyArray<FindMatch>;
  /** True when the deadline stopped the search before the end of the text. */
  readonly stopped: boolean;
}

const NO_RUN_SEARCH: RunSearch = { matches: [], stopped: false };

/**
 * Every match of `pattern` across `runs`, in the order of the runs.
 *
 * A range with no client rectangle is dropped. Such a range is inside a subtree
 * that stopped being drawn after the walk, and counting it would make the
 * `3/17` of the HUD a false statement.
 *
 * One deadline covers the whole call. A page with many runs must not pay the
 * budget again for each run.
 */
export const matchesInRuns = (
  document: Document,
  runs: ReadonlyArray<TextRun>,
  pattern: RegExp,
  limit: number = DEFAULT_MATCH_LIMIT,
  deadline: number = readClock() + MATCH_BUDGET_MS,
): RunSearch =>
  pipe(
    runs,
    Array.reduce(NO_RUN_SEARCH, (search, run) =>
      pipe(
        search,
        // A full search takes no more runs.
        Option.liftPredicate((search) => search.matches.length < limit),
        Option.map(searchRun(document, run, pattern, limit, deadline)),
        Option.getOrElse(() => search),
      ),
    ),
  );

/** Add the matches of one run to `search`, unless the deadline has passed. */
const searchRun =
  (document: Document, run: TextRun, pattern: RegExp, limit: number, deadline: number) =>
  (search: RunSearch): RunSearch =>
    pipe(
      readClock() > deadline,
      Boolean.match({
        onTrue: () => ({ matches: search.matches, stopped: true }),
        onFalse: () => addRun(document, run, pattern, limit, deadline)(search),
      }),
    );

const addRun =
  (document: Document, run: TextRun, pattern: RegExp, limit: number, deadline: number) =>
  (search: RunSearch): RunSearch => {
    const found = collectSpans(run.haystack, pattern, limit - search.matches.length, deadline);
    const matches = pipe(
      found.spans,
      Array.map((span) => matchFor(document, run, span)),
      Array.getSomes,
    );
    return {
      matches: pipe(search.matches, Array.appendAll(matches)),
      stopped: search.stopped || found.stopped,
    };
  };

/** The match for `span`, when the browser still draws it. */
const matchFor = (document: Document, run: TextRun, span: MatchSpan): Option.Option<FindMatch> =>
  pipe(
    rangeForSpan(document, run, span),
    Option.flatMap((range) =>
      pipe(
        measure(range),
        Option.map((rect) => ({ range, text: run.haystack.slice(span.start, span.end), rect })),
      ),
    ),
  );

/** The bounding rectangle of a range that the browser still draws. */
const measure = (range: Range): Option.Option<DOMRect> =>
  pipe(
    Result.try(() =>
      pipe(
        range,
        Option.liftPredicate((range) => range.getClientRects().length > 0),
        Option.map((range) => range.getBoundingClientRect()),
      ),
    ),
    Result.getOrElse(() => Option.none()),
  );

/**
 * Just enough of a rectangle for the viewport test.
 *
 * A `DOMRect` satisfies it.
 */
export interface RectLike {
  readonly bottom: number;
}

/**
 * The index of the first match at or below the top of the viewport.
 *
 * The answer falls back to `0`, so a search whose matches are all above the
 * fold still starts somewhere sensible.
 *
 * The parameter is typed by shape, and not against `FindMatch`, so that the
 * function can be exercised without a live `Range`.
 */
export const firstMatchInView = (matches: ReadonlyArray<{ readonly rect: RectLike }>): number =>
  pipe(
    matches,
    Array.findFirstIndex((match) => match.rect.bottom >= 0),
    Option.getOrElse(() => 0),
  );

/** Where the caret is among the matches. */
export type CaretPlace = Data.TaggedEnum<{
  /**
   * Inside the match, or at one of its ends. A caret just after a match is
   * still inside it, which is where a click after a word leaves it.
   */
  Inside: { readonly index: number };
  /** Before the match, and after the one before it. */
  Before: { readonly index: number };
}>;

export const CaretPlace = Data.taggedEnum<CaretPlace>();

/**
 * Where the focus of the selection is among the matches.
 *
 * `comparePoint` throws when the point is in another tree, which is usual once
 * a shadow root is involved. A failure therefore means "no opinion", and no
 * opinion about any match gives `None`.
 *
 * A caret after the last match gives `None` too. The host of our own overlay
 * is at the end of the document, so a focus in the HUD reads as such a caret,
 * and it must not send `n` to the first match of the page.
 */
export const caretPlace = (
  selection: Selection,
  matches: ReadonlyArray<FindMatch>,
): Option.Option<CaretPlace> =>
  pipe(
    selection.focusNode,
    Option.fromNullishOr,
    Option.flatMap((node) => pipe(matches, Array.findFirst(placeOf(node, selection.focusOffset)))),
  );

/**
 * Where a point is against match `index`. `comparePoint` answers `0` for a
 * point inside the range and `-1` for a point before it. A point after the
 * match, and a throw, say nothing.
 */
const placeOf =
  (node: Node, offset: number) =>
  (match: FindMatch, index: number): Option.Option<CaretPlace> =>
    pipe(
      Result.try(() => match.range.comparePoint(node, offset)),
      Result.getSuccess,
      Option.flatMap((side) =>
        pipe(
          Match.value(side),
          Match.when(0, () => CaretPlace.Inside({ index })),
          Match.when(-1, () => CaretPlace.Before({ index })),
          Match.option,
        ),
      ),
    );

/** The word under the caret, or the selected text. This backs `*` and `#`. */
export const wordUnderCursor = (selection: Selection): string =>
  pipe(
    selection.toString().trim(),
    Option.liftPredicate((selected) => selected.length > 0),
    Option.orElse(() =>
      pipe(
        selection.focusNode,
        Option.fromNullishOr,
        Option.filter(isText),
        Option.map((node) => wordAt(node.data, selection.focusOffset)),
      ),
    ),
    Option.getOrElse(() => ""),
  );
