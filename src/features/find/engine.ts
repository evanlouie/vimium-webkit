/**
 * The find engine: `TreeWalker` + `Range`.
 *
 * Deliberately **not** `window.find()`. That API is non-standard, reports no
 * match count, cannot enumerate matches, mutates the user's selection as a side
 * effect, and cannot see into shadow DOM — every one of which this subsystem
 * needs. Upstream Vimium rolls its own for the same reasons.
 *
 * The module is split so that the interesting half is testable without a DOM:
 *
 * - *pure*: haystack normalisation, span collection, offset → chunk mapping,
 *   word extraction. All exported and unit-tested.
 * - *impure*: the walk that produces `TextRun`s and the `Range`s built from
 *   spans.
 *
 * A run is a maximal sequence of text nodes sharing one tree root. Matches are
 * only ever assembled *within* a run, because a `Range` whose boundaries lie in
 * different node trees is not a range at all — `setEnd` silently collapses it.
 */

import type { Capabilities } from "~/platform/capabilities.ts";

// ---------------------------------------------------------------------------
// Pure: haystack normalisation
// ---------------------------------------------------------------------------

/**
 * Whitespace that a layout engine renders as a plain space.
 *
 * Every member is a single UTF-16 code unit, which is the whole point: the
 * substitution must be length-preserving or match offsets stop mapping back to
 * `Text` node offsets.
 */
const COLLAPSIBLE_WHITESPACE =
  /[\n\r\t\f\v\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/g;

/**
 * Fold source whitespace to U+0020, preserving length and therefore offsets.
 *
 * Without this, a query of `sign in` fails against `<a>sign\n  in</a>` — text
 * that renders as "sign in" but whose `data` contains a newline. The companion
 * half is in `query.ts`, which compiles literal whitespace to ` +`.
 */
export const normaliseHaystack = (text: string): string =>
  text.replace(COLLAPSIBLE_WHITESPACE, " ");

// ---------------------------------------------------------------------------
// Pure: spans
// ---------------------------------------------------------------------------

export interface MatchSpan {
  readonly start: number;
  /** Exclusive. */
  readonly end: number;
}

/** Above this, highlighting costs more than the matches are worth. */
export const DEFAULT_MATCH_LIMIT = 500;

/**
 * Time budget for one `collectSpans` pass.
 *
 * A user-supplied regex in `regexFindMode` is re-run on every keystroke against
 * the whole page, and a catastrophically-backtracking pattern (`(a+)+$` against
 * a long line) freezes the tab with no way out — find mode owns the keyboard.
 * Bailing out early yields the matches found so far, which is exactly what an
 * incremental find wants anyway.
 */
const MATCH_BUDGET_MS = 50;

/**
 * Every non-empty match of `pattern` in `haystack`, up to `limit`.
 *
 * The regex is cloned rather than used directly: `lastIndex` is mutable state
 * on a `g` regex, and a caller reusing one across two searches would silently
 * skip the first half of the second search.
 */
export const collectSpans = (
  haystack: string,
  pattern: RegExp,
  limit: number = DEFAULT_MATCH_LIMIT,
): readonly MatchSpan[] => {
  if (limit <= 0 || haystack.length === 0) return [];

  const flags = pattern.flags.includes("g")
    ? pattern.flags
    : `${pattern.flags}g`;
  const regex = new RegExp(pattern.source, flags);
  const spans: MatchSpan[] = [];
  const deadline = now() + MATCH_BUDGET_MS;

  for (;;) {
    const match = regex.exec(haystack);
    if (match === null) break;

    const text = match[0];
    if (text.length === 0) {
      // Zero-width patterns (`^`, `x*`) never advance `lastIndex` on their own
      // and would spin here forever. They also cannot be highlighted, so they
      // are skipped rather than recorded.
      regex.lastIndex = match.index + 1;
      if (regex.lastIndex > haystack.length) break;
      continue;
    }

    spans.push({ start: match.index, end: match.index + text.length });
    if (spans.length >= limit) break;
    // Checked between matches, which bounds the *loop*. A single `exec` that
    // backtracks catastrophically cannot be interrupted from JavaScript at all;
    // `query.ts` refuses the patterns that do it before they get here.
    if (now() > deadline) break;
  }

  return spans;
};

const now = (): number =>
  typeof performance !== "undefined" ? performance.now() : Date.now();

// ---------------------------------------------------------------------------
// Pure: offset → chunk
// ---------------------------------------------------------------------------

export interface ChunkPosition {
  /** Index into the run's node list. */
  readonly index: number;
  /** Offset within that node. */
  readonly offset: number;
}

/** Exclusive-prefix sums of `lengths`; `starts[i]` is where chunk `i` begins. */
export const chunkStarts = (lengths: readonly number[]): readonly number[] => {
  const starts: number[] = [];
  let total = 0;
  for (const length of lengths) {
    starts.push(total);
    total += length;
  }
  return starts;
};

/**
 * Map a haystack offset back to a `(chunk, offset)` pair.
 *
 * `preferEnd` decides what happens on a chunk boundary. A match's start belongs
 * to the chunk that *begins* there; a match's end belongs to the chunk that
 * *ends* there. Getting this backwards produces ranges with a boundary in an
 * adjacent empty node, which then render no client rects at all.
 */
export const locateOffset = (
  starts: readonly number[],
  lengths: readonly number[],
  offset: number,
  preferEnd = false,
): ChunkPosition | null => {
  if (starts.length === 0 || offset < 0) return null;

  let low = 0;
  let high = starts.length - 1;
  let found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const start = starts[mid];
    if (start === undefined) return null;
    if (start <= offset) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  if (found === -1) return null;

  // Skip back over zero-length chunks, and over the chunk boundary itself when
  // the caller wants the closing side of it.
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
  if (start === undefined || length === undefined) return null;
  const local = offset - start;
  if (local < 0 || local > length) return null;
  return { index, offset: local };
};

// ---------------------------------------------------------------------------
// Pure: word under an offset
// ---------------------------------------------------------------------------

const WORD_CHARACTER = /[\p{L}\p{N}_]/u;

/**
 * The word surrounding `offset` in `text`, or `""`.
 *
 * Backs `*` / `#`. When the caret sits just *after* a word — which is where a
 * click usually leaves it — the character to the left is used, matching Vim.
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
// DOM: the walk
// ---------------------------------------------------------------------------

/** Elements whose text is never rendered as page content. */
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
 * A contiguous stretch of text nodes sharing one tree root.
 *
 * `haystack` is the concatenation of the (normalised) node data, so a match may
 * begin in one node and end in another — which is the common case on any page
 * that wraps part of a phrase in a `<b>`.
 */
export interface TextRun {
  readonly nodes: readonly Text[];
  readonly lengths: readonly number[];
  readonly starts: readonly number[];
  readonly haystack: string;
}

export interface CollectOptions {
  readonly caps: Capabilities;
  readonly root?: Document | ShadowRoot;
  /** Our own closed-shadow host. Never searched. */
  readonly excludeHost?: Element | null;
  /** Hard stop, so a pathological page cannot wedge the keystroke that opened find. */
  readonly maxCharacters?: number;
}

/** Roughly a novel's worth of text; beyond this the page is not being read. */
export const DEFAULT_MAX_CHARACTERS = 2_000_000;

interface VisibilityCache {
  readonly visible: (element: Element) => boolean;
}

/**
 * Per-collection visibility memo.
 *
 * `checkVisibility` is preferred where it exists (Safari 17.4+) because it is
 * the only check that accounts for `content-visibility: auto`, which Safari 18
 * ships and which makes a `getComputedStyle` answer actively misleading. It is
 * called through a narrowed `unknown` because the DOM lib we compile against
 * does not agree with every Safari version about the option names.
 */
const visibilityCache = (caps: Capabilities): VisibilityCache => {
  const cache = new WeakMap<Element, boolean>();

  const check = (element: Element): boolean => {
    if (caps.checkVisibility) {
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
    const style = globalThis.getComputedStyle(element);
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
        // A detached or cross-document element: assume searchable rather than
        // dropping half the page on one bad node.
        result = true;
      }
      cache.set(element, result);
      return result;
    },
  };
};

/**
 * Collect the searchable text of `root`, descending into **open** shadow roots.
 *
 * Closed roots are invisible to us by design; `element.shadowRoot` is `null`
 * and patching `attachShadow` needs a reliable `document-start` that WebKit
 * does not give a userscript. Their contents simply do not appear.
 *
 * Slotted content is collected exactly once, from the host's light DOM. A
 * `TreeWalker` over a shadow root never visits a slot's assigned nodes, since
 * those are not its children, so there is no double counting and nothing is
 * lost.
 */
export const collectTextRuns = (
  options: CollectOptions,
): readonly TextRun[] => {
  const budget = options.maxCharacters ?? DEFAULT_MAX_CHARACTERS;
  const visibility = visibilityCache(options.caps);
  const excludeHost = options.excludeHost ?? null;

  const runs: TextRun[] = [];
  const pending: Array<Document | ShadowRoot> = [options.root ?? document];
  const seen = new Set<Document | ShadowRoot>();
  let remaining = budget;

  while (pending.length > 0 && remaining > 0) {
    const root = pending.shift();
    if (root === undefined || seen.has(root)) continue;
    seen.add(root);

    const collected = collectFromRoot(
      root,
      { visibility, excludeHost, remaining },
    );
    remaining -= collected.consumed;
    if (collected.run !== null) runs.push(collected.run);
    pending.push(...collected.shadowRoots);
  }

  return runs;
};

interface RootCollection {
  readonly run: TextRun | null;
  readonly shadowRoots: readonly ShadowRoot[];
  readonly consumed: number;
}

interface RootContext {
  readonly visibility: VisibilityCache;
  readonly excludeHost: Element | null;
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

  // `ShadowRoot` is a `DocumentFragment` and has no `createTreeWalker`; the
  // factory lives on `Document`, but a walker's root may be any node.
  const scope: Node = root instanceof Document ? (root.body ?? root) : root;

  const walker = document.createTreeWalker(
    scope,
    NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
    {
      acceptNode: (node: Node): number => {
        if (node.nodeType === Node.TEXT_NODE) {
          return node.nodeValue && node.nodeValue.length > 0
            ? NodeFilter.FILTER_ACCEPT
            : NodeFilter.FILTER_REJECT;
        }
        const element = node as Element;
        if (element === context.excludeHost) return NodeFilter.FILTER_REJECT;
        if (OPAQUE_TAGS.has(element.tagName)) return NodeFilter.FILTER_REJECT;
        if (element.hasAttribute("hidden")) return NodeFilter.FILTER_REJECT;
        // Rejecting prunes the whole subtree, which is what makes a per-element
        // visibility check affordable *and* correct: an ancestor's
        // `display: none` is never re-derived from a descendant.
        if (!context.visibility.visible(element)) {
          return NodeFilter.FILTER_REJECT;
        }
        // Accepted only so the iteration below can queue the shadow root; the
        // light children are still walked, which is where slotted text lives.
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

  if (nodes.length === 0) return { run: null, shadowRoots, consumed };

  return {
    run: {
      nodes,
      lengths,
      starts: chunkStarts(lengths),
      haystack: parts.join(""),
    },
    shadowRoots,
    consumed,
  };
};

// ---------------------------------------------------------------------------
// DOM: matches
// ---------------------------------------------------------------------------

export interface FindMatch {
  readonly range: Range;
  readonly text: string;
  /**
   * The bounding rect at collection time, in viewport coordinates.
   *
   * Used only to pick the match nearest the current scroll position when a
   * search starts; the highlighter always re-measures.
   */
  readonly rect: DOMRect | null;
}

/** Build a `Range` for `span` inside `run`, or `null` if it cannot be mapped. */
export const rangeForSpan = (run: TextRun, span: MatchSpan): Range | null => {
  const start = locateOffset(run.starts, run.lengths, span.start);
  const end = locateOffset(run.starts, run.lengths, span.end, true);
  if (start === null || end === null) return null;

  const startNode = run.nodes[start.index];
  const endNode = run.nodes[end.index];
  if (startNode === undefined || endNode === undefined) return null;

  try {
    const range = document.createRange();
    range.setStart(startNode, start.offset);
    range.setEnd(endNode, end.offset);
    return range.collapsed ? null : range;
  } catch {
    // The DOM moved underneath us between the walk and here.
    return null;
  }
};

/**
 * Every match of `pattern` across `runs`, in run order.
 *
 * Ranges with no client rects are dropped: they are inside a subtree that
 * became non-rendered after the walk, and counting them would make the HUD's
 * `3/17` a lie.
 */
export const matchesInRuns = (
  runs: readonly TextRun[],
  pattern: RegExp,
  limit: number = DEFAULT_MATCH_LIMIT,
): readonly FindMatch[] => {
  const matches: FindMatch[] = [];

  for (const run of runs) {
    if (matches.length >= limit) break;
    const spans = collectSpans(run.haystack, pattern, limit - matches.length);
    for (const span of spans) {
      const range = rangeForSpan(run, span);
      if (range === null) continue;
      const rects = range.getClientRects();
      if (rects.length === 0) continue;
      matches.push({
        range,
        text: run.haystack.slice(span.start, span.end),
        rect: range.getBoundingClientRect(),
      });
    }
  }

  return matches;
};

/** Just enough of a rect for the viewport test; `DOMRect` satisfies it. */
export interface RectLike {
  readonly bottom: number;
}

/**
 * Index of the first match at or below the top of the viewport.
 *
 * Falls back to `0`, so a search whose every match is above the fold still
 * starts somewhere sensible rather than reporting nothing.
 *
 * Typed structurally rather than against `FindMatch` so it can be exercised
 * without a live `Range`.
 */
export const firstMatchInView = (
  matches: readonly { readonly rect: RectLike | null }[],
): number => {
  for (let index = 0; index < matches.length; index++) {
    const rect = matches[index]?.rect;
    if (rect !== null && rect !== undefined && rect.bottom >= 0) return index;
  }
  return 0;
};
