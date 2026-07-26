/**
 * Find mode: the search runtime and the HUD input wiring.
 *
 * Ported in structure from Vimium's `content_scripts/mode_find.js` and
 * `content_scripts/mode_post_find.js` (MIT). The differences that matter:
 *
 * - matches are enumerated by our own engine, so the HUD can show `3/17`
 *   instead of upstream's best effort;
 * - the document selection is left **untouched** while the user types. Upstream
 *   is forced to move it, because `window.find()` moves it as a side effect;
 *   only committing with `Enter` selects anything here, which is what makes
 *   `Escape` a genuine no-op;
 * - `Escape` restores the scroll position captured on entry.
 */

import type { AppContext, HudPromptOptions } from "~/core/context.ts";
import type { Handler, HandlerResult } from "~/core/handler-stack.ts";
import {
  CONTINUE_BUBBLING,
  PASS_EVENT_TO_PAGE,
  SUPPRESS_EVENT,
  SUPPRESS_PROPAGATION,
} from "~/core/handler-stack.ts";
import { Mode } from "~/core/mode.ts";
import { FIND_HISTORY_LIMIT } from "~/settings/schema.ts";
import {
  collectTextRuns,
  type FindMatch,
  firstMatchInView,
  matchesInRuns,
  type TextRun,
  wordAt,
} from "./engine.ts";
import { FindHighlighter } from "./highlight.ts";
import { type ParsedFindQuery, parseFindQuery, toRegExp } from "./query.ts";
import { FIND_CSS } from "./styles.ts";

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

export interface SearchOutcome {
  readonly count: number;
  /** Zero-based index of the current match, or `-1` when there is none. */
  readonly index: number;
  readonly empty: boolean;
  readonly error: string | null;
}

const NO_QUERY: SearchOutcome = {
  count: 0,
  index: -1,
  empty: true,
  error: null,
};

/**
 * The stateful half of find mode: text runs, matches, highlighting, position.
 *
 * One instance per frame, reused across searches. Text runs are collected once
 * per *session* rather than once per keystroke — the walk is the expensive part
 * (it calls into layout for every element) and re-running it on each character
 * would make incremental find unusable on a large document.
 */
export class FindRuntime {
  readonly #app: AppContext;

  #highlighter: FindHighlighter | null = null;
  #runs: readonly TextRun[] = [];
  #matches: readonly FindMatch[] = [];
  #index = -1;
  #query: ParsedFindQuery | null = null;
  #stylesInstalled = false;

  constructor(app: AppContext) {
    this.#app = app;
  }

  get query(): ParsedFindQuery | null {
    return this.#query;
  }

  get matchCount(): number {
    return this.#matches.length;
  }

  get currentIndex(): number {
    return this.#index;
  }

  currentMatch(): FindMatch | null {
    return this.#matches[this.#index] ?? null;
  }

  /** Re-walk the document. Call once per session, not once per keystroke. */
  refreshRuns(): void {
    this.#runs = collectTextRuns({
      caps: this.#app.caps,
      excludeHost: this.#app.ui.shadow.host,
    });
  }

  /**
   * Run `raw` against the cached runs and redraw.
   *
   * `anchorIndex` is where the caller would like to land — used so that typing
   * a character does not throw away the match the user was already looking at.
   */
  search(raw: string, anchorIndex: number | null = null): SearchOutcome {
    const parsed = parseFindQuery(raw, {
      regexFindMode: this.#app.settings().regexFindMode,
    });
    this.#query = parsed;

    if (parsed.isEmpty) {
      this.#matches = [];
      this.#index = -1;
      this.#highlight();
      return NO_QUERY;
    }
    if (parsed.error !== null) {
      this.#matches = [];
      this.#index = -1;
      this.#highlight();
      return { count: 0, index: -1, empty: false, error: parsed.error };
    }

    const pattern = toRegExp(parsed);
    this.#matches = pattern === null ? [] : matchesInRuns(this.#runs, pattern);
    this.#index = this.#matches.length === 0 ? -1 : clampIndex(
      anchorIndex ?? firstMatchInView(this.#matches),
      this.#matches.length,
    );
    this.#highlight();

    return {
      count: this.#matches.length,
      index: this.#index,
      empty: false,
      error: null,
    };
  }

  /** Re-run the last query against a freshly walked document. */
  research(): SearchOutcome {
    const query = this.#query;
    if (query === null) return NO_QUERY;
    this.refreshRuns();
    return this.search(query.raw);
  }

  /** `n` / `N`. Wraps, as Vim does. */
  step(delta: number): SearchOutcome {
    if (this.#query === null) return NO_QUERY;
    if (this.#matches.length === 0) {
      const outcome = this.research();
      if (outcome.count === 0) return outcome;
    }

    const count = this.#matches.length;
    if (count === 0) return { count: 0, index: -1, empty: false, error: null };

    const start = this.#index < 0
      ? firstMatchInView(this.#matches)
      : this.#index;
    this.#index = (((start + delta) % count) + count) % count;
    this.#highlight();
    this.scrollToCurrent();

    return { count, index: this.#index, empty: false, error: null };
  }

  /** Move to the match nearest the document selection, without stepping. */
  anchorToSelection(): void {
    const index = indexAtSelection(this.#matches);
    if (index !== null) this.#index = index;
  }

  /**
   * Put the current match in the document selection.
   *
   * Only ever called on commit. It is what lets `y`, visual mode and the user's
   * own ⌘C pick up where find left off.
   */
  selectCurrent(): void {
    const match = this.currentMatch();
    if (match === null) return;
    const selection = globalThis.getSelection();
    if (selection === null) return;
    try {
      selection.removeAllRanges();
      selection.addRange(match.range.cloneRange());
    } catch {
      // A range inside a shadow tree that Safari declines to select; the
      // highlight overlay still shows the user where the match is.
    }
  }

  /**
   * Bring the current match into view.
   *
   * `behavior: "instant"` throughout. Safari's smooth scrolling is not
   * cancellable, so a user holding `n` would queue a second of animation they
   * cannot interrupt.
   */
  scrollToCurrent(): void {
    const match = this.currentMatch();
    if (match === null) return;

    const viewport = this.#app.ui.viewport();
    const inView = (): boolean => {
      const rect = match.range.getBoundingClientRect();
      return rect.bottom >= 0 && rect.top <= viewport.height &&
        rect.right >= 0 && rect.left <= viewport.width;
    };
    if (inView()) return;

    // `scrollIntoView` on the containing element first: it is the only thing
    // that understands nested scroll containers without us reimplementing them.
    const anchor = elementFor(match.range);
    anchor?.scrollIntoView({
      block: "center",
      inline: "nearest",
      behavior: "instant",
    });

    // The element may be far larger than the match (a whole article, say), so
    // correct the residual against the range's own rect.
    if (inView()) {
      this.#highlighter?.render(this.#matches, this.#index);
      return;
    }
    const rect = match.range.getBoundingClientRect();
    globalThis.scrollBy({
      top: rect.top - viewport.height / 3,
      left: 0,
      behavior: "instant",
    });
    this.#highlighter?.render(this.#matches, this.#index);
  }

  /** Drop the highlights but keep the query, so `n` still works afterwards. */
  clearHighlight(): void {
    this.#highlighter?.dispose();
    this.#highlighter = null;
  }

  /** Full reset: highlights, matches and cached runs. */
  clear(): void {
    this.clearHighlight();
    this.#runs = [];
    this.#matches = [];
    this.#index = -1;
  }

  ensureStyles(): void {
    if (this.#stylesInstalled) return;
    this.#stylesInstalled = true;
    // CSSOM only; a `<style>` element would be subject to the page's
    // `style-src` and silently blocked on any CSP-hardened site.
    this.#app.ui.addStyle(FIND_CSS);
  }

  /** `"3/17"`, `"No matches"`, or the regex error. */
  status(outcome: SearchOutcome): string {
    if (outcome.error !== null) return `Bad pattern: ${outcome.error}`;
    if (outcome.empty) return "";
    if (outcome.count === 0) return "No matches";
    return `${outcome.index + 1}/${outcome.count}`;
  }

  #highlight(): void {
    if (this.#matches.length === 0) {
      this.#highlighter?.clear();
      return;
    }
    this.ensureStyles();
    this.#highlighter ??= new FindHighlighter(this.#app);
    this.#highlighter.render(this.#matches, this.#index);
  }
}

const clampIndex = (index: number, count: number): number =>
  count === 0 ? -1 : Math.max(0, Math.min(index, count - 1));

const elementFor = (range: Range): Element | null => {
  const container = range.startContainer;
  return container instanceof Element ? container : container.parentElement;
};

/**
 * Index of the match containing (or immediately after) the caret.
 *
 * `comparePoint` throws when the point is in a different tree — routine once
 * shadow DOM is involved — so a failure just means "no opinion".
 */
const indexAtSelection = (matches: readonly FindMatch[]): number | null => {
  const selection = globalThis.getSelection();
  const node = selection?.focusNode ?? null;
  if (selection === null || node === null) return null;
  const offset = selection.focusOffset;

  for (let index = 0; index < matches.length; index++) {
    const match = matches[index];
    if (match === undefined) continue;
    try {
      if (match.range.comparePoint(node, offset) >= 0) return index;
    } catch {
      continue;
    }
  }
  return null;
};

/** The word under the caret, or the selected text. Backs `*` and `#`. */
export const wordUnderCursor = (): string => {
  const selection = globalThis.getSelection();
  if (selection === null) return "";

  const selected = selection.toString().trim();
  if (selected.length > 0) return selected;

  const node = selection.focusNode;
  if (node === null || node.nodeType !== Node.TEXT_NODE) return "";
  return wordAt(node.nodeValue ?? "", selection.focusOffset);
};

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

/** Most recent first, deduplicated, capped. Pure, so the cap is testable. */
export const pushHistory = (
  history: readonly string[],
  query: string,
): readonly string[] => {
  const trimmed = query.trim();
  if (trimmed.length === 0) return history;
  return [trimmed, ...history.filter((entry) => entry !== trimmed)]
    .slice(0, FIND_HISTORY_LIMIT);
};

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------

export interface FindPromptConfig {
  readonly app: AppContext;
  readonly runtime: FindRuntime;
  readonly backwards: boolean;
  /** Called with the committed query, or `null` when the user cancelled. */
  readonly onSettled: (query: string | null) => void;
}

/**
 * The mode that owns the screen — and the keyboard — while the HUD input is
 * open.
 *
 * It must claim keys explicitly. Stage 0 listens on `globalThis` in the
 * **capture** phase, so it sees every keystroke before the HUD input's own
 * capture listener can `stopPropagation()`; without a handler here, typing
 * `hemisphere` into the find field would run `h` (scroll left), `m` (set
 * mark), `i` (insert mode) and `s` (search omnibar) — and the omnibar taking
 * focus would blur the prompt and cancel the search. `InsertMode` does not
 * cover this: it deliberately ignores our own inputs via `hud.ownsFocus()`.
 *
 * The shape mirrors `OmnibarMode`: pass through what our input should receive,
 * swallow everything else.
 */
export class FindPromptMode extends Mode {
  readonly #config: FindPromptConfig;
  readonly #scroll: { readonly x: number; readonly y: number };
  #settled = false;

  constructor(config: FindPromptConfig) {
    super(config.app.modeHost, {
      name: "find",
      indicator: config.backwards ? "Find (backwards)" : "Find",
      // The HUD input owns Escape: it has to resolve the prompt promise, and a
      // mode-level exit here would leave that promise pending forever.
      exitOnEscape: false,
      singleton: "find",
    });
    this.#config = config;
    this.#scroll = config.app.scroller.position();

    this.onExit(() => {
      if (this.#settled) return;
      // Evicted by another mode rather than by the user; treat as a cancel.
      this.cancel();
    });
  }

  protected override handlers(): Omit<Handler, "name"> {
    return {
      keydown: (event) => this.#passIfOurs(event),
      keypress: (event) => this.#passIfOurs(event),
      keyup: (event) => this.#passIfOurs(event),
      // Stop insert mode, which sits below us, from treating focus on our own
      // input as the page asking for insert mode.
      focus: (event) =>
        this.#config.app.hud.ownsFocus(event.target)
          ? SUPPRESS_PROPAGATION
          : CONTINUE_BUBBLING,
    };
  }

  /**
   * Let the HUD input have the key; swallow anything from elsewhere.
   *
   * `PASS_EVENT_TO_PAGE` stops the stack walk without touching the event, which
   * is exactly "our input types this, nothing else reacts". Page listeners on
   * `document` still observe it, retargeted to our shadow host — unavoidable
   * without the extension-origin iframe upstream Vimium uses and §6.3 rules out.
   */
  #passIfOurs(event: KeyboardEvent): HandlerResult {
    return this.#config.app.hud.ownsFocus(event.target)
      ? PASS_EVENT_TO_PAGE
      : SUPPRESS_EVENT;
  }

  /** Restore everything the search disturbed. Only scroll, by construction. */
  cancel(): void {
    if (this.#settled) return;
    this.#settled = true;
    this.#config.runtime.clear();
    this.#config.app.scroller.restore(this.#scroll.x, this.#scroll.y);
    this.#config.onSettled(null);
    this.exit("explicit");
  }

  commit(query: string): void {
    if (this.#settled) return;
    this.#settled = true;
    this.#config.onSettled(query);
    this.exit("explicit");
  }
}

/**
 * The mode that lives on after `Enter`.
 *
 * Ported from Vimium's `mode_post_find.js`, minus the editable-element
 * handling: upstream drops into insert mode when the match lands inside a text
 * field, which needs an insert-mode handle that `FindApi` does not have. Here
 * the highlights simply persist until `Escape`, a click, or a focus change.
 */
export class PostFindMode extends Mode {
  readonly #runtime: FindRuntime;

  constructor(app: AppContext, runtime: FindRuntime) {
    super(app.modeHost, {
      name: "post-find",
      indicator: null,
      exitOnEscape: true,
      exitOnClick: true,
      exitOnFocus: true,
      singleton: "find",
    });
    this.#runtime = runtime;
    this.onExit(() => this.#runtime.clearHighlight());
  }

  protected override handlers(): Omit<Handler, "name"> {
    // Everything except Escape (handled by the base class) belongs to the page
    // and to the normal-mode key trie, so `n`/`N` keep working.
    return { keydown: (): HandlerResult => CONTINUE_BUBBLING };
  }
}

// ---------------------------------------------------------------------------
// HUD wiring
// ---------------------------------------------------------------------------

/**
 * Build the `HudPromptOptions` for a find session.
 *
 * History cycling writes straight to `event.target`. That looks like a layering
 * violation and is a deliberate one: `HudPromptOptions.onKeydown` can only
 * *consume* a key, not change the input's value, and the input is our own
 * element inside our own closed shadow root — so mutating it is safe, whereas
 * widening the HUD interface for one feature would not be.
 */
export const findPromptOptions = (config: {
  readonly backwards: boolean;
  readonly history: readonly string[];
  readonly onInput: (value: string) => void;
}): HudPromptOptions => {
  let historyIndex = -1;
  let draft = "";

  const applyHistory = (
    event: KeyboardEvent,
    delta: number,
    value: string,
  ): boolean => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement)) return false;
    if (config.history.length === 0) return true;

    if (historyIndex === -1) draft = value;
    const next = historyIndex + delta;
    if (next < -1) return true;

    historyIndex = Math.min(next, config.history.length - 1);
    const entry = historyIndex === -1
      ? draft
      : config.history[historyIndex] ?? draft;
    input.value = entry;
    // The HUD's own `input` listener does not fire for a programmatic write,
    // so the incremental search has to be kicked by hand.
    config.onInput(entry);
    return true;
  };

  return {
    label: config.backwards ? "?" : "/",
    placeholder: "search",
    onInput: config.onInput,
    onKeydown: (event, value): boolean => {
      switch (event.key) {
        case "ArrowUp":
          return applyHistory(event, 1, value);
        case "ArrowDown":
          return applyHistory(event, -1, value);
        default:
          break;
      }
      // `<c-p>` / `<c-n>` as history synonyms, for the same reason readline has
      // them: the arrow keys are a long way from the home row.
      if (event.ctrlKey && event.key === "p") {
        return applyHistory(event, 1, value);
      }
      if (event.ctrlKey && event.key === "n") {
        return applyHistory(event, -1, value);
      }
      return false;
    },
  };
};
