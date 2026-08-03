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
 * service in `Find.ts` calls them inside `dom.probeOr`, so a realm that refuses
 * a read costs one search and not the application.
 *
 * A run is the longest sequence of text nodes that share one tree root. A match
 * is only ever built *inside* one run, because a `Range` whose two boundaries
 * are in different node trees is not a range: `setEnd` collapses it without a
 * word.
 */

import { Option } from "effect";
import type { CapabilityReport } from "~/platform/Capabilities.ts";

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
 * The most characters that one `exec` reads.
 *
 * This is the work between two looks at the clock. One `exec` cannot be stopped
 * from JavaScript, so the window is the true limit on how long find can hold
 * the main thread. The slowest expression that the safety check accepts is
 * quadratic at one start position, and 1024 characters of it cost about 2 ms.
 */
export const SEARCH_WINDOW = 1024;

/**
 * The text that each window keeps on both sides.
 *
 * A window is a slice of the haystack, so `\b`, a lookbehind and a lookahead
 * need the text beside it. A match that is longer than this, or a lookaround
 * that reads further than this, is not found at the edge of a window. A find
 * query is far shorter than this in every normal use.
 */
const WINDOW_CONTEXT = 256;

/**
 * The clock for the budget.
 *
 * `performance` is absent in some hosts.
 */
const now = (): number =>
  typeof performance !== "undefined" ? performance.now() : Date.now();

/** What one search of a haystack gave, and whether it read all of it. */
export interface SpanSearch {
  readonly spans: ReadonlyArray<MatchSpan>;
  /** True when the deadline stopped the search before the end of the text. */
  readonly stopped: boolean;
}

/**
 * Every match of `pattern` in `haystack`, up to `limit`.
 *
 * The expression is copied, and not used as it is. `lastIndex` on a `g`
 * expression is state that changes, and a caller that used one expression for
 * two searches would lose the first half of the second search.
 *
 * The text is read in windows of `SEARCH_WINDOW` characters. Each window also
 * holds `WINDOW_CONTEXT` characters of the text on both sides, so that a word
 * boundary and a lookaround still see what is beside them. A match belongs to
 * the window that holds its first character, so no match is counted twice.
 */
export const collectSpans = (
  haystack: string,
  pattern: RegExp,
  limit: number = DEFAULT_MATCH_LIMIT,
  deadline: number = now() + MATCH_BUDGET_MS,
): SpanSearch => {
  if (limit <= 0 || haystack.length === 0) return { spans: [], stopped: false };

  const flags = pattern.flags.includes("g")
    ? pattern.flags
    : `${pattern.flags}g`;
  const regex = new RegExp(pattern.source, flags);
  const spans: MatchSpan[] = [];
  // Where the next match may begin. A match can end after the window that
  // holds its first character, and the text that it covers is then taken.
  let cursor = 0;

  for (let from = 0; from < haystack.length; from += SEARCH_WINDOW) {
    // The clock is read between two windows. One `exec` cannot be stopped, so
    // the window is the work that one look at the clock cannot prevent.
    if (now() > deadline) return { spans, stopped: true };

    const windowEnd = Math.min(from + SEARCH_WINDOW, haystack.length);
    if (cursor >= windowEnd) continue;

    const sliceStart = Math.max(0, from - WINDOW_CONTEXT);
    const sliceEnd = Math.min(
      haystack.length,
      from + SEARCH_WINDOW + WINDOW_CONTEXT,
    );
    const isTail = sliceEnd === haystack.length;
    const slice = haystack.slice(sliceStart, sliceEnd);
    regex.lastIndex = Math.max(from, cursor) - sliceStart;

    for (;;) {
      const match = regex.exec(slice);
      if (match === null) break;

      const text = match[0];
      if (text.length === 0) {
        // A zero-width pattern such as `^` or `x*` never moves `lastIndex` by
        // itself, so the loop would never end. Such a match also cannot be
        // drawn, so it is stepped over and not recorded.
        regex.lastIndex = match.index + 1;
        if (regex.lastIndex > slice.length) break;
        continue;
      }

      const start = sliceStart + match.index;
      // The next window owns this match, and it begins its search there.
      if (start >= windowEnd) break;
      const end = start + text.length;
      // A window that is not the end of the text cannot trust a match that
      // touches the end of the window: `$` matches there, and a longer match
      // would be cut there.
      if (!isTail && end >= sliceEnd) break;

      spans.push({ start, end });
      cursor = end;
      if (spans.length >= limit) return { spans, stopped: false };
    }
  }

  return { spans, stopped: false };
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
export const chunkStarts = (
  lengths: ReadonlyArray<number>,
): ReadonlyArray<number> => {
  const starts: number[] = [];
  let total = 0;
  for (const length of lengths) {
    starts.push(total);
    total += length;
  }
  return starts;
};

/**
 * Map an offset in the haystack back to a chunk and an offset in it.
 *
 * `preferEnd` decides what happens on the boundary between two chunks. The
 * start of a match belongs to the chunk that *begins* there. The end of a match
 * belongs to the chunk that *ends* there. The other way round gives a range
 * with a boundary in an empty node beside it, and such a range draws no client
 * rectangle at all.
 */
export const locateOffset = (
  starts: ReadonlyArray<number>,
  lengths: ReadonlyArray<number>,
  offset: number,
  preferEnd = false,
): Option.Option<ChunkPosition> => {
  if (starts.length === 0 || offset < 0) return Option.none();

  let low = 0;
  let high = starts.length - 1;
  let found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const start = starts[mid];
    if (start === undefined) return Option.none();
    if (start <= offset) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  if (found === -1) return Option.none();

  // Step back over a chunk of length zero, and over the boundary itself when
  // the caller asks for the closing side of it.
  let index = found;
  if (preferEnd) {
    while (index > 0) {
      const start = starts[index];
      if (start === undefined || start < offset) break;
      index--;
    }
  } else {
    while (index + 1 < starts.length && (lengths[index] ?? 0) === 0) index++;
  }

  const start = starts[index];
  const length = lengths[index];
  if (start === undefined || length === undefined) return Option.none();
  const local = offset - start;
  if (local < 0 || local > length) return Option.none();
  return Option.some({ index, offset: local });
};

// ---------------------------------------------------------------------------
// The word under an offset
// ---------------------------------------------------------------------------

const WORD_CHARACTER = /[\p{L}\p{N}_]/u;

/**
 * The word around `offset` in `text`, or `""`.
 *
 * This is what `*` and `#` search for. When the caret sits just *after* a word,
 * which is where a click usually leaves it, the character to the left is used.
 * Vim does the same.
 */
export const wordAt = (text: string, offset: number): string => {
  if (text.length === 0) return "";
  const clamped = Math.max(0, Math.min(offset, text.length));

  let start = clamped;
  if (
    (start >= text.length || !WORD_CHARACTER.test(text[start] ?? "")) &&
    start > 0 && WORD_CHARACTER.test(text[start - 1] ?? "")
  ) {
    start--;
  }
  if (!WORD_CHARACTER.test(text[start] ?? "")) return "";

  let end = start;
  while (start > 0 && WORD_CHARACTER.test(text[start - 1] ?? "")) start--;
  while (end < text.length && WORD_CHARACTER.test(text[end] ?? "")) end++;
  return text.slice(start, end);
};

// ---------------------------------------------------------------------------
// The walk
// ---------------------------------------------------------------------------

/** The elements whose text the browser never draws as page content. */
const OPAQUE_TAGS: ReadonlySet<string> = new Set([
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
]);

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
  readonly root?: Document | ShadowRoot;
  /** The host of our own closed shadow root. It is never searched. */
  readonly excludeHost: Option.Option<Element>;
  /**
   * A hard stop, so that one bad page cannot block the keystroke that opened
   * find.
   */
  readonly maxCharacters?: number;
}

/** About the text of one novel. Above this, nobody is reading the page. */
export const DEFAULT_MAX_CHARACTERS = 2_000_000;

interface VisibilityCache {
  readonly visible: (element: Element) => boolean;
}

/**
 * The visibility answers for one walk.
 *
 * `checkVisibility` is used where it exists, which is Safari 17.4 and later. It
 * is the only check that accounts for `content-visibility: auto`, which Safari
 * 18 has, and which makes an answer from `getComputedStyle` wrong. It is called
 * through a narrowed `unknown`, because the DOM library that we compile against
 * does not agree with every Safari version about the option names.
 */
const visibilityCache = (
  view: Window,
  capabilities: CapabilityReport,
): VisibilityCache => {
  const cache = new WeakMap<Element, boolean>();

  const check = (element: Element): boolean => {
    if (capabilities.checkVisibility) {
      const host = element as unknown as {
        checkVisibility?: (options?: Record<string, boolean>) => boolean;
      };
      if (typeof host.checkVisibility === "function") {
        return host.checkVisibility({
          contentVisibilityAuto: true,
          visibilityProperty: true,
        });
      }
    }
    const style = view.getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden";
  };

  return {
    visible: (element: Element): boolean => {
      const cached = cache.get(element);
      if (cached !== undefined) return cached;
      let result: boolean;
      try {
        result = check(element);
      } catch {
        // A detached element, or an element of another document. Treat it as
        // searchable, instead of dropping half of the page for one bad node.
        result = true;
      }
      cache.set(element, result);
      return result;
    },
  };
};

/**
 * Collect the searchable text of `root`, and descend into every **open** shadow
 * root.
 *
 * A closed root is invisible to us by design. `element.shadowRoot` is `null`,
 * and a patch of `attachShadow` needs a `document-start` that WebKit does not
 * give a userscript. The content of such a root does not appear.
 *
 * Slotted content is collected exactly once, from the light DOM of the host. A
 * `TreeWalker` over a shadow root never visits the assigned nodes of a slot,
 * because those are not its children. Nothing is counted twice, and nothing is
 * lost.
 */
export const collectTextRuns = (
  options: CollectOptions,
): ReadonlyArray<TextRun> => {
  const budget = options.maxCharacters ?? DEFAULT_MAX_CHARACTERS;
  const visibility = visibilityCache(options.view, options.capabilities);

  const runs: TextRun[] = [];
  const pending: Array<Document | ShadowRoot> = [
    options.root ?? options.document,
  ];
  const seen = new Set<Document | ShadowRoot>();
  let remaining = budget;

  while (pending.length > 0 && remaining > 0) {
    const root = pending.shift();
    if (root === undefined || seen.has(root)) continue;
    seen.add(root);

    const collected = collectFromRoot(root, {
      document: options.document,
      visibility,
      excludeHost: options.excludeHost,
      remaining,
    });
    remaining -= collected.consumed;
    if (Option.isSome(collected.run)) runs.push(collected.run.value);
    pending.push(...collected.shadowRoots);
  }

  return runs;
};

interface RootCollection {
  readonly run: Option.Option<TextRun>;
  readonly shadowRoots: ReadonlyArray<ShadowRoot>;
  readonly consumed: number;
}

interface RootContext {
  readonly document: Document;
  readonly visibility: VisibilityCache;
  readonly excludeHost: Option.Option<Element>;
  readonly remaining: number;
}

const collectFromRoot = (
  root: Document | ShadowRoot,
  context: RootContext,
): RootCollection => {
  const shadowRoots: ShadowRoot[] = [];
  const nodes: Text[] = [];
  const lengths: number[] = [];
  const parts: string[] = [];
  let consumed = 0;

  // A `ShadowRoot` is a `DocumentFragment`, and it has no `createTreeWalker`.
  // The factory is on `Document`, and the root of a walker may be any node.
  const scope: Node = root instanceof Document ? (root.body ?? root) : root;

  const walker = context.document.createTreeWalker(
    scope,
    NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
    {
      acceptNode: (node: Node): number => {
        if (node.nodeType === Node.TEXT_NODE) {
          return node.nodeValue !== null && node.nodeValue.length > 0
            ? NodeFilter.FILTER_ACCEPT
            : NodeFilter.FILTER_REJECT;
        }
        const element = node as Element;
        if (
          Option.isSome(context.excludeHost) &&
          element === context.excludeHost.value
        ) {
          return NodeFilter.FILTER_REJECT;
        }
        if (OPAQUE_TAGS.has(element.tagName)) return NodeFilter.FILTER_REJECT;
        if (element.hasAttribute("hidden")) return NodeFilter.FILTER_REJECT;
        // A reject cuts the whole subtree. That is what makes one visibility
        // check for each element affordable *and* correct: a `display: none` on
        // an ancestor is never derived again from a descendant.
        if (!context.visibility.visible(element)) {
          return NodeFilter.FILTER_REJECT;
        }
        // Accepted only so that the loop below can queue the shadow root. The
        // light children are still walked, and that is where slotted text is.
        return element.shadowRoot !== null
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_SKIP;
      },
    },
  );

  for (
    let node = walker.nextNode();
    node !== null && consumed < context.remaining;
    node = walker.nextNode()
  ) {
    if (node.nodeType !== Node.TEXT_NODE) {
      const shadow = (node as Element).shadowRoot;
      if (shadow !== null) shadowRoots.push(shadow);
      continue;
    }
    const text = node as Text;
    const data = text.data;
    nodes.push(text);
    lengths.push(data.length);
    parts.push(normaliseHaystack(data));
    consumed += data.length;
  }

  if (nodes.length === 0) {
    return { run: Option.none(), shadowRoots, consumed };
  }

  return {
    run: Option.some({
      nodes,
      lengths,
      starts: chunkStarts(lengths),
      haystack: parts.join(""),
    }),
    shadowRoots,
    consumed,
  };
};

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
  readonly rect: Option.Option<DOMRect>;
}

/** Build a `Range` for `span` inside `run`. */
export const rangeForSpan = (
  document: Document,
  run: TextRun,
  span: MatchSpan,
): Option.Option<Range> => {
  const start = locateOffset(run.starts, run.lengths, span.start);
  const end = locateOffset(run.starts, run.lengths, span.end, true);
  if (Option.isNone(start) || Option.isNone(end)) return Option.none();

  const startNode = run.nodes[start.value.index];
  const endNode = run.nodes[end.value.index];
  if (startNode === undefined || endNode === undefined) return Option.none();

  try {
    const range = document.createRange();
    range.setStart(startNode, start.value.offset);
    range.setEnd(endNode, end.value.offset);
    return range.collapsed ? Option.none() : Option.some(range);
  } catch {
    // The DOM moved under us between the walk and this call.
    return Option.none();
  }
};

/** What one walk of the runs gave, and whether it read all of them. */
export interface RunSearch {
  readonly matches: ReadonlyArray<FindMatch>;
  /** True when the deadline stopped the search before the end of the text. */
  readonly stopped: boolean;
}

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
  deadline: number = now() + MATCH_BUDGET_MS,
): RunSearch => {
  const matches: FindMatch[] = [];
  let stopped = false;

  for (const run of runs) {
    if (matches.length >= limit) break;
    if (now() > deadline) {
      stopped = true;
      break;
    }
    const found = collectSpans(
      run.haystack,
      pattern,
      limit - matches.length,
      deadline,
    );
    if (found.stopped) stopped = true;
    for (const span of found.spans) {
      const range = rangeForSpan(document, run, span);
      if (Option.isNone(range)) continue;
      const measured = measure(range.value);
      if (Option.isNone(measured)) continue;
      matches.push({
        range: range.value,
        text: run.haystack.slice(span.start, span.end),
        rect: measured,
      });
    }
  }

  return { matches, stopped };
};

/** The bounding rectangle of a range that the browser still draws. */
const measure = (range: Range): Option.Option<DOMRect> => {
  try {
    if (range.getClientRects().length === 0) return Option.none();
    return Option.some(range.getBoundingClientRect());
  } catch {
    return Option.none();
  }
};

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
export const firstMatchInView = (
  matches: ReadonlyArray<{ readonly rect: Option.Option<RectLike> }>,
): number => {
  for (let index = 0; index < matches.length; index++) {
    const match = matches[index];
    if (match === undefined) continue;
    if (Option.isSome(match.rect) && match.rect.value.bottom >= 0) return index;
  }
  return 0;
};

/**
 * The index of the match that holds the caret, or of the one just after it.
 *
 * `comparePoint` throws when the point is in another tree, which is usual once
 * a shadow root is involved. A failure therefore means "no opinion".
 */
export const indexAtSelection = (
  selection: Selection,
  matches: ReadonlyArray<FindMatch>,
): Option.Option<number> => {
  const node = selection.focusNode;
  if (node === null) return Option.none();
  const offset = selection.focusOffset;

  for (let index = 0; index < matches.length; index++) {
    const match = matches[index];
    if (match === undefined) continue;
    try {
      if (match.range.comparePoint(node, offset) >= 0) {
        return Option.some(index);
      }
    } catch {
      continue;
    }
  }
  return Option.none();
};

/** The word under the caret, or the selected text. This backs `*` and `#`. */
export const wordUnderCursor = (selection: Selection): string => {
  const selected = selection.toString().trim();
  if (selected.length > 0) return selected;

  const node = selection.focusNode;
  if (node === null || node.nodeType !== Node.TEXT_NODE) return "";
  return wordAt(node.nodeValue ?? "", selection.focusOffset);
};
