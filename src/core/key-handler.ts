/**
 * Normal mode: the trie walk, the count prefix, and pass keys.
 *
 * Ported from upstream Vimium's `content_scripts/mode_key_handler.js` and
 * `mode_normal.js` (MIT).
 *
 * The load-bearing detail is that `keyState` is a **list** of trie nodes rather
 * than a single node. That is what lets `gg` resolve while `g` is also a live
 * prefix, and what lets a fresh sequence start in the middle of an abandoned
 * one (`g` then `j` scrolls down instead of doing nothing).
 */

import {
  CONTINUE_BUBBLING,
  type Handler,
  type HandlerResult,
  SUPPRESS_EVENT,
} from "./handler-stack.ts";
import { isEscape, Mode, type ModeHost } from "./mode.ts";
import { isComposing, isModifierKey, keyNotation } from "./key-notation.ts";
import type { CompiledMappings, TrieNode } from "./mappings.ts";
import { type EffectiveRule, isPassKey } from "./exclusions.ts";
import { appendCountDigit, isCountDigit } from "./count.ts";

export interface KeyHandlerCallbacks {
  mappings(): CompiledMappings;
  exclusion(): EffectiveRule;
  ignoreKeyboardLayout(): boolean;
  /**
   * Should the keys in `MEDIA_KEYS` be left to the page right now?
   *
   * Injected rather than computed here because answering it means asking what
   * has focus, and this module is deliberately DOM-free.
   */
  mediaKeysBelongToPage(): boolean;
  /** Echoed into the HUD so a half-typed `g` is visible. `null` clears it. */
  showPending(keys: string | null): void;
  run(
    command: string,
    options: Readonly<Record<string, string | boolean>>,
    count: number,
    event: KeyboardEvent,
  ): void;
}

/**
 * The keys a focused media player owns.
 *
 * Exactly the set the browser's native `<video controls>` consumes when it has
 * focus. Deliberately *not* `j`/`k`/`l`, which YouTube also binds: a Vim user
 * pressing `j` on a video page means "scroll", and always has.
 */
export const MEDIA_KEYS: ReadonlySet<string> = new Set([
  "<up>",
  "<down>",
  "<left>",
  "<right>",
  "<space>",
]);

export class NormalMode extends Mode {
  readonly #callbacks: KeyHandlerCallbacks;

  /** Always non-empty; element 0 is the trie root. */
  #keyState: TrieNode[] = [];
  #countPrefix = 0;
  #pendingKeys: string[] = [];
  #passNextKeyCount = 0;

  /**
   * `event.code`s whose `keydown` we swallowed.
   *
   * A page listening for `keyup` must not see a phantom release for a press it
   * never saw. Keyed on `code` rather than `key` because modifier state can
   * change between press and release.
   *
   * `forgetSuppressed()` must be called whenever we stop being able to observe
   * releases — a window blur during Cmd-Tab is the everyday case. A stale entry
   * means the *next* release of that physical key is swallowed, and by then the
   * user may be typing into a text field that was entitled to it.
   */
  readonly #suppressedCodes = new Set<string>();

  constructor(host: ModeHost, callbacks: KeyHandlerCallbacks) {
    super(host, { name: "normal" });
    this.#callbacks = callbacks;
    this.#reset();
  }

  /**
   * Forget which presses we swallowed.
   *
   * Wired to `blur` and `visibilitychange` by the boot layer rather than here:
   * this module is deliberately DOM-free, which is what makes the whole key
   * pipeline unit-testable.
   */
  forgetSuppressed(): void {
    this.#suppressedCodes.clear();
  }

  /** Consume the next keystroke as a literal, passing it to the page. */
  passNextKey(count: number): void {
    this.#passNextKeyCount = Math.max(1, count);
  }

  protected override handlers(): Omit<Handler, "name"> {
    return {
      keydown: (event) => this.#onKeydown(event),
      keyup: (event) => this.#onKeyup(event),
    };
  }

  #reset(): void {
    this.#keyState = [this.#callbacks.mappings().trie];
    this.#countPrefix = 0;
    if (this.#pendingKeys.length > 0) {
      this.#pendingKeys = [];
      this.#callbacks.showPending(null);
    }
  }

  /** Called when the mapping source changes, so the walk restarts cleanly. */
  recompiled(): void {
    this.#reset();
  }

  #suppress(event: KeyboardEvent): HandlerResult {
    if (event.code) this.#suppressedCodes.add(event.code);
    return SUPPRESS_EVENT;
  }

  #onKeyup(event: KeyboardEvent): HandlerResult {
    if (event.code && this.#suppressedCodes.delete(event.code)) {
      return SUPPRESS_EVENT;
    }
    return CONTINUE_BUBBLING;
  }

  #onKeydown(event: KeyboardEvent): HandlerResult {
    // IME and dead-key composition. Missing this guard means we eat keystrokes
    // mid-composition, which is the single most damaging failure mode for CJK
    // users — and one they cannot work around.
    if (isComposing(event) || isModifierKey(event)) return CONTINUE_BUBBLING;

    const raw = keyNotation(event, this.#callbacks.ignoreKeyboardLayout());
    if (raw === null) return CONTINUE_BUBBLING;

    const mappings = this.#callbacks.mappings();
    const notation = mappings.keyRemap.get(raw) ?? raw;

    if (this.#passNextKeyCount > 0) {
      this.#passNextKeyCount--;
      this.#reset();
      return CONTINUE_BUBBLING;
    }

    const atRoot = this.#keyState.length === 1 && this.#countPrefix === 0;

    if (isEscape(event)) {
      if (atRoot) return CONTINUE_BUBBLING;
      this.#reset();
      return this.#suppress(event);
    }

    // Pass keys only apply to a fresh sequence: once the user has committed to
    // `g`, the follow-up key belongs to us even if it is in the pass set.
    if (atRoot && isPassKey(this.#callbacks.exclusion(), notation)) {
      return CONTINUE_BUBBLING;
    }

    // The same rule for the keys a focused media player owns. The cheap set
    // lookup goes first because the callback behind it walks the DOM.
    if (
      atRoot && MEDIA_KEYS.has(notation) &&
      this.#callbacks.mediaKeysBelongToPage()
    ) {
      return CONTINUE_BUBBLING;
    }

    if (this.#isCountKey(notation)) {
      this.#countPrefix = appendCountDigit(this.#countPrefix, notation);
      this.#pendingKeys.push(notation);
      this.#callbacks.showPending(this.#pendingKeys.join(""));
      return this.#suppress(event);
    }

    return this.#advance(notation, event);
  }

  /**
   * `0` is only a count digit once a count is under way; otherwise it is a
   * bindable key in its own right (upstream binds it to `scrollToLeft`).
   *
   * `1`–`9` yield to an explicit binding for the same reason. They used to be
   * intercepted unconditionally, so `map 1 scrollDown` compiled cleanly,
   * produced no diagnostic, and could never fire — while also eating the
   * keystroke and pinning `1` in the HUD until the user pressed Escape.
   */
  #isCountKey(notation: string): boolean {
    if (this.#keyState.length !== 1) return false;
    if (!isCountDigit(notation, this.#countPrefix > 0)) return false;
    if (this.#countPrefix > 0) return true;
    return !this.#callbacks.mappings().trie.children.has(notation);
  }

  #advance(notation: string, event: KeyboardEvent): HandlerResult {
    const candidates: TrieNode[] = [];
    for (const node of this.#keyState) {
      const child = node.children.get(notation);
      if (child) candidates.push(child);
    }

    if (candidates.length === 0) {
      const wasPartial = this.#keyState.length > 1 || this.#countPrefix > 0;
      this.#reset();
      // A dead-ended sequence is still *ours*: the user typed `g` deliberately,
      // so leaking the follow-up key to the page would be surprising. A key
      // that never matched anything at all passes straight through.
      return wasPartial ? this.#suppress(event) : CONTINUE_BUBBLING;
    }

    // The deepest candidate is the most specific continuation, because
    // `keyState` is ordered shallowest-first. If it can still be extended, this
    // sequence is not finished: firing the shorter binding here is what made
    // `map gg` unreachable behind `map g`, and — at depth ≥ 3 — made a
    // mid-sequence key run a shallower binding instead of continuing.
    const deepest = candidates[candidates.length - 1];
    const stillOpen = deepest !== undefined && deepest.children.size > 0;

    // Later candidates come from deeper `keyState` entries, so the last binding
    // found is the most specific match.
    let terminal: TrieNode | null = null;
    for (const candidate of candidates) {
      if (candidate.binding !== null) terminal = candidate;
    }

    if (!stillOpen && terminal?.binding) {
      const { command, options } = terminal.binding;
      const count = this.#countPrefix === 0 ? 1 : this.#countPrefix;
      this.#reset();
      // Run *after* resetting so that a command which enters another mode sees
      // a clean normal-mode state underneath it.
      this.#callbacks.run(command, options, count, event);
      return this.#suppress(event);
    }

    this.#keyState = [
      this.#keyState[0] ?? this.#callbacks.mappings().trie,
      ...candidates,
    ];
    this.#pendingKeys.push(notation);
    this.#callbacks.showPending(this.#pendingKeys.join(""));
    return this.#suppress(event);
  }
}
