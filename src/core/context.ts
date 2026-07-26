/**
 * The application context: the interfaces every feature module programs against.
 *
 * Feature modules must depend on *this* file rather than on each other's
 * implementations. That keeps the import graph acyclic, keeps the bundle
 * tree-shakeable, and — more importantly — makes each subsystem testable
 * against a hand-written stub instead of a live DOM.
 */

import type { Capabilities } from "~/platform/capabilities.ts";
import type { GmSurface } from "~/platform/gm.ts";
import type { ValueGroup, ValueStore } from "~/platform/storage.ts";
import type {
  FindHistory,
  HistoryIndex,
  Marks,
  SessionState,
  Settings,
} from "~/settings/schema.ts";
import type { HandlerStack } from "./handler-stack.ts";
import type { ModeHost } from "./mode.ts";

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

/**
 * Named z-ordered layers inside the single closed shadow root.
 *
 * One host element for the whole extension: every `attachShadow` costs a style
 * recalc scope, and we may be running in twenty frames.
 */
export type UiLayerName = "hud" | "hints" | "find" | "dialog" | "omnibar";

export interface UiRoot {
  /** The closed shadow root. Never handed to page code. */
  readonly shadow: ShadowRoot;
  layer(name: UiLayerName): HTMLElement;
  /** Append CSS via CSSOM; falls back to `<style>` below Safari 16.4. */
  addStyle(css: string): void;
  /**
   * Recompute the overlay's colour scheme.
   *
   * Exposed because `followPageColorScheme` is a live setting and the page's
   * own theme can change under a soft navigation.
   */
  syncColorScheme(): void;
  /**
   * Does this event target belong to our overlay?
   *
   * Necessary because the root is `closed`: an event that originates inside it
   * is **retargeted to the host** by the time a `window`-level listener sees
   * it, so comparing against the inner element always fails. Both forms are
   * accepted — the host (seen from outside) and the real node (seen from a
   * listener attached within the shadow tree).
   */
  owns(target: EventTarget | null): boolean;
  /** Viewport rect to position against — `visualViewport` on iOS. */
  viewport(): ViewportRect;
  destroy(): void;
}

export interface ViewportRect {
  readonly offsetLeft: number;
  readonly offsetTop: number;
  readonly width: number;
  readonly height: number;
  readonly scale: number;
}

export interface HudPromptOptions {
  readonly label: string;
  readonly initialValue?: string;
  readonly placeholder?: string;
  /** Live callback on every keystroke, for incremental find. */
  readonly onInput?: (value: string) => void;
  /** Extra key handling; return `true` to consume. */
  readonly onKeydown?: (event: KeyboardEvent, value: string) => boolean;
}

export interface HudApi {
  show(text: string, durationMs?: number): void;
  error(text: string): void;
  /** Sticky text; pass `null` to clear. Used for mode indicators. */
  setIndicator(text: string | null): void;
  hide(): void;
  /** Resolves with `null` if the user cancels. */
  prompt(options: HudPromptOptions): Promise<string | null>;
  /** True while an input owned by the HUD has focus. */
  ownsFocus(target: EventTarget | null): boolean;
}

// ---------------------------------------------------------------------------
// Features
// ---------------------------------------------------------------------------

export type ScrollAxis = "x" | "y";

export interface ScrollerApi {
  /** `amount` in CSS pixels; negative scrolls up/left. */
  scrollBy(axis: ScrollAxis, amount: number, event: KeyboardEvent | null): void;
  /** Fractions of the viewport, e.g. `0.5` for `d`. */
  scrollByViewport(
    axis: ScrollAxis,
    fraction: number,
    event: KeyboardEvent | null,
  ): void;
  scrollTo(axis: ScrollAxis, position: "start" | "end" | number): void;
  /** Current scroll offsets of the effective scrolling element. */
  position(): { readonly x: number; readonly y: number };
  restore(x: number, y: number): void;
  /** Called when a suppressed keyup arrives, to stop key-repeat animation. */
  noteKeyup(event: KeyboardEvent): void;
  /**
   * Called for every keydown before the handler stack sees it, so key-repeat
   * can be distinguished from a fresh press.
   *
   * Part of the interface because `stage1.ts` calls it on the hot key path;
   * omitting it here made the contract narrower than the one thing that
   * implements it (MNT-15).
   */
  noteKeydown(event: KeyboardEvent): void;
}

export type HintMode =
  | "activate"
  | "activate-new-tab"
  | "activate-new-tab-background"
  | "hover"
  | "focus"
  | "copy-link-url"
  | "copy-link-text"
  | "open-with-omnibar"
  | "download";

export interface HintsApi {
  activate(mode: HintMode): void;
  isActive(): boolean;
  deactivate(): void;
}

export interface FindApi {
  enter(options: { readonly backwards: boolean }): void;
  /** `n` / `N`. */
  step(count: number): void;
  /** `*` / `#`. */
  searchWordUnderCursor(direction: 1 | -1): void;
  clear(): void;
}

export interface VisualApi {
  enterVisual(): void;
  enterVisualLine(): void;
  enterCaret(): void;
}

export interface MarksApi {
  setLocal(letter: string): void;
  jumpLocal(letter: string): void;
  setGlobal(letter: string): void;
  jumpGlobal(letter: string): void;
}

export type OmnibarSource = "url" | "command" | "search" | "bookmark";

export interface OmnibarApi {
  open(source: OmnibarSource, initialQuery?: string): void;
  close(): void;
  /**
   * Wipe the local history index.
   *
   * On the user-facing surface rather than the wiring surface because it is a
   * user-facing verb: the README documents it as the only way to purge the
   * index, which makes it a privacy control, not plumbing.
   */
  clearHistory(): Promise<void>;
}

export interface InsertApi {
  /** Enter insert mode explicitly (`i`). */
  enter(): void;
  exit(): void;
  isActive(): boolean;
  /** `gi` — focus the first/nth text input, with hints if ambiguous. */
  focusInput(count: number): void;
}

// ---------------------------------------------------------------------------
// Frames
// ---------------------------------------------------------------------------

export type FrameId = string;

export interface FrameLinkApi {
  readonly frameId: FrameId;
  readonly isTop: boolean;
  /** Resolves once this frame is registered with the coordinator (or times out). */
  ready(): Promise<boolean>;
  /** Frames currently known to the coordinator, in document order. */
  knownFrames(): readonly FrameId[];
  /** Ask every frame for hint descriptors and return the merged, ordered set. */
  collectHints(mode: HintMode): Promise<readonly RemoteHintDescriptor[]>;
  /** Tell a specific frame to act on one of its own hints. */
  activateHint(frameId: FrameId, localIndex: number, mode: HintMode): void;
  /** Broadcast a keystroke during a cross-frame hint session. */
  broadcastKey(notation: string): void;
  /** Move focus to the next/previous frame (`gf` / `gF`). */
  focusFrame(direction: 1 | -1): void;
  /** The effective exclusion rule for the *top* frame's URL. */
  effectiveExclusion(): Promise<
    { readonly enabled: boolean; readonly passKeys: string }
  >;
  dispose(): void;
}

/**
 * A lightweight, cross-frame handle to a hint.
 *
 * Deliberately *not* the local hint: the element reference and its rect never
 * leave the owning frame. Upstream measured stripping each frame's own
 * descriptors out of its reply as a 150% speedup on link-dense pages.
 */
export interface RemoteHintDescriptor {
  readonly frameId: FrameId;
  readonly localIndex: number;
  readonly linkText: string;
  /** Upstream's "second-class citizen" flag; sorts these hints later. */
  readonly secondary: boolean;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/**
 * - **A** — full parity, pure DOM, works everywhere.
 * - **B** — degraded or dependent on a GM capability.
 * - **C** — not implementable in a userscript; shows the native alternative.
 */
export type CommandTier = "A" | "B" | "C";

export type CommandGroup =
  | "navigation"
  | "scrolling"
  | "hints"
  | "find"
  | "text"
  | "tabs"
  | "clipboard"
  | "marks"
  | "misc";

export interface CommandInvocation {
  /** The count prefix, defaulting to 1. */
  readonly count: number;
  /** Options from the `map` line, e.g. `LinkHints.activate swap=true`. */
  readonly options: Readonly<Record<string, string | boolean>>;
  /** The originating event, when there is one. Needed for clipboard activation. */
  readonly event: KeyboardEvent | null;
  readonly app: AppContext;
}

export interface CommandDef {
  readonly name: string;
  readonly description: string;
  readonly tier: CommandTier;
  readonly group: CommandGroup;
  /** Honours the count prefix. */
  readonly repeatable?: boolean;
  /** Runs only in the top frame; child frames forward it. */
  readonly topFrameOnly?: boolean;
  /** Hidden from the default help dialog. */
  readonly advanced?: boolean;
  /** Required for Tier C: why it cannot work. */
  readonly unavailableReason?: string;
  /** Shown alongside a Tier C refusal, e.g. `"⌘⇧T"`. */
  readonly nativeAlternative?: string;
  run(invocation: CommandInvocation): void;
}

export interface CommandRegistry {
  get(name: string): CommandDef | undefined;
  all(): readonly CommandDef[];
  byGroup(): ReadonlyMap<CommandGroup, readonly CommandDef[]>;
  run(name: string, invocation: CommandInvocation): void;
}

// ---------------------------------------------------------------------------
// The context itself
// ---------------------------------------------------------------------------

export interface StorageGroups {
  readonly settings: ValueGroup<Settings>;
  readonly marks: ValueGroup<Marks>;
  readonly findHistory: ValueGroup<FindHistory>;
  readonly history: ValueGroup<HistoryIndex>;
  readonly session: ValueGroup<SessionState>;
}

export interface AppContext {
  readonly caps: Capabilities;
  readonly gm: GmSurface;
  readonly handlerStack: HandlerStack;
  readonly modeHost: ModeHost;
  readonly store: ValueStore;
  readonly groups: StorageGroups;
  settings(): Settings;

  readonly ui: UiRoot;
  readonly hud: HudApi;

  readonly commands: CommandRegistry;
  readonly scroller: ScrollerApi;
  readonly hints: HintsApi;
  readonly find: FindApi;
  readonly visual: VisualApi;
  readonly marks: MarksApi;
  readonly insert: InsertApi;
  readonly omnibar: OmnibarApi;
  readonly frames: FrameLinkApi;

  /** Re-read settings, recompile the key trie, re-evaluate exclusions. */
  refresh(): Promise<void>;
  /** Open the help dialog. */
  showHelp(): void;
  /** Open the settings overlay. */
  showSettings(): void;
}
