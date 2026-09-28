/**
 * The stylesheet of the overlay, and the colour-scheme calculation.
 *
 * This module is pure. It holds no service and no state, and it reads no
 * ambient global. A function that needs the page takes the `Document` as an
 * argument, so a test gives it a document instead of patching `globalThis`.
 *
 * Every rule here is installed through CSSOM (`adoptedStyleSheets`), and never
 * as a `<style>` element. Safari applies the *page's* `style-src` to a DOM node
 * that a content script inserts, and a constructed stylesheet is not a
 * `style-src` fetch. This is what keeps the interface alive on a site with a
 * strict Content Security Policy.
 *
 * `all: initial` on the host means that nothing is inherited from the page.
 * Therefore every property that we depend on is set here. There is no cascade
 * to build on.
 */

import { Array, Boolean, Option, pipe, Predicate, Schema } from "effect";

// ---------------------------------------------------------------------------
// Colour scheme
// ---------------------------------------------------------------------------

/** The two schemes of the overlay palette. */
export const ColorScheme = Schema.Literals(["light", "dark"]);

export type ColorScheme = typeof ColorScheme.Type;

/** The scheme for a surface that reads as dark, or as light. */
export const schemeOf: (dark: boolean) => ColorScheme = Boolean.match({
  onFalse: () => "light",
  onTrue: () => "dark",
});

/** Below this luminance a surface reads as dark. Halfway, on purpose. */
const DARK_THRESHOLD = 0.4;

/** A background with less alpha than this says nothing about what is behind it. */
const OPAQUE_ENOUGH = 0.5;

const channelToLinear = (value: number): number => {
  const channel = value / 255;
  return pipe(
    channel <= 0.04045,
    Boolean.match({
      onFalse: () => ((channel + 0.055) / 1.055) ** 2.4,
      onTrue: () => channel / 12.92,
    }),
  );
};

const RGB_COLOR = /^rgba?\(([^)]+)\)$/;

/** The channels of an `rgb()` or `rgba()` colour, as the engine wrote them. */
const colorChannels = (color: string): Option.Option<ReadonlyArray<string>> =>
  pipe(
    RGB_COLOR.exec(color.trim()),
    Option.fromNullishOr,
    Option.flatMap(Array.get(1)),
    Option.map((body) =>
      pipe(
        body.split(/[\s,/]+/),
        Array.filter((part) => part !== ""),
      ),
    ),
  );

/** A finite number, or `None` for text that holds none. */
const finiteNumber = (text: string): Option.Option<number> =>
  pipe(
    Number(text),
    Option.liftPredicate((value: number) => Number.isFinite(value)),
  );

/** One colour channel, by its position. */
const channelOf =
  (channels: ReadonlyArray<string>) =>
  (index: number): Option.Option<number> =>
    pipe(channels, Array.get(index), Option.flatMap(finiteNumber));

/**
 * The relative luminance of a computed `background-color`.
 *
 * `None` for a colour that is not in `rgb()` or `rgba()` form. That includes
 * the wide-gamut `color(srgb ...)` form that some engines now give back. It is
 * also `None` for a colour that is almost transparent, because a transparent
 * background tells us nothing about the surface behind it.
 */
export const backgroundLuminance = (color: string): Option.Option<number> =>
  Option.gen(function* () {
    const channels = yield* colorChannels(color);
    const channel = channelOf(channels);
    const red = yield* channel(0);
    const green = yield* channel(1);
    const blue = yield* channel(2);
    // A colour with no alpha channel is opaque.
    yield* pipe(
      channels,
      Array.get(3),
      Option.match({ onNone: () => Option.some(1), onSome: finiteNumber }),
      Option.filter((alpha) => alpha >= OPAQUE_ENOUGH),
    );
    return (
      0.2126 * channelToLinear(red) +
      0.7152 * channelToLinear(green) +
      0.0722 * channelToLinear(blue)
    );
  });

/** The scheme of one surface of the page, read from its background. */
const surfaceScheme =
  (view: Window) =>
  (surface: Element): Option.Option<ColorScheme> =>
    pipe(
      view.getComputedStyle(surface).backgroundColor,
      backgroundLuminance,
      Option.map((luminance) => schemeOf(luminance < DARK_THRESHOLD)),
    );

/**
 * The scheme of the page itself, or `None` when the page does not say.
 *
 * The setting is called "match the page". No media query can answer that,
 * because a media query is a question about the *user agent*. A light overlay
 * on a dark page is the result that the setting exists to prevent. Therefore
 * the scheme is calculated here, and `Ui.ts` publishes it as an attribute on
 * the host. The stylesheet above keys on that attribute.
 *
 * There are two sources, in order of authority: the declared `color-scheme`
 * property, and the luminance of the surface that paints the page background.
 * The second one matters, because most dark pages never declare
 * `color-scheme`. The body is asked before the root, and the first surface
 * that answers decides.
 *
 * The caller must protect this call. `getComputedStyle` belongs to the page,
 * and a page can replace it with an accessor that throws. `Ui.ts` therefore
 * calls this inside `dom.probeOrElse`.
 */
export const detectPageScheme = (doc: Document): Option.Option<ColorScheme> =>
  Option.gen(function* () {
    const view = yield* Option.fromNullishOr(doc.defaultView);
    const root = yield* Option.fromNullishOr<Element | null>(doc.documentElement);
    const surfaces: ReadonlyArray<Element | null> = [doc.body, root];
    return yield* pipe(
      view.getComputedStyle(root).colorScheme.trim(),
      Schema.decodeUnknownOption(ColorScheme),
      Option.orElse(() =>
        pipe(surfaces, Array.filter(Predicate.isNotNull), Array.findFirst(surfaceScheme(view))),
      ),
    );
  });

// ---------------------------------------------------------------------------
// The stylesheet
// ---------------------------------------------------------------------------

export const BASE_CSS: string = `
:host {
  all: initial;
  /*
   * Important declarations reverse the cascade order between the page and
   * this shadow tree. Page rules can address the host, but they cannot replace
   * these values. The all property does not reset custom properties.
   */
  --vw-fg: #1b1b1b !important;
  --vw-bg: #f5f5f4 !important;
  --vw-bg-raised: #ffffff !important;
  --vw-border: rgba(0, 0, 0, 0.22) !important;
  --vw-shadow: 0 6px 24px rgba(0, 0, 0, 0.24) !important;
  --vw-accent: #1a5fb4 !important;
  --vw-accent-fg: #ffffff !important;
  --vw-muted: #6a6a6a !important;
  --vw-danger: #b3261e !important;
  --vw-mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace !important;
  --vw-radius: 6px !important;
}

@media (prefers-color-scheme: dark) {
  :host {
    --vw-fg: #ececec !important;
    --vw-bg: #23232a !important;
    --vw-bg-raised: #2e2e37 !important;
    --vw-border: rgba(255, 255, 255, 0.18) !important;
    --vw-shadow: 0 6px 24px rgba(0, 0, 0, 0.55) !important;
    --vw-accent: #7aa2f7 !important;
    --vw-accent-fg: #16161e !important;
    --vw-muted: #9a9aa5 !important;
    --vw-danger: #f28b82 !important;
  }
}

/*
 * The scheme that Ui.ts calculated.
 *
 * The setting "match the page" is not a question about the user agent, so no
 * media query can express it. A light overlay on a dark page is the result
 * that the setting exists to prevent. The host attribute has a higher
 * specificity than the bare :host rules above, so it wins whatever order the
 * sheets are adopted in.
 */
:host([data-scheme="light"]) {
  --vw-fg: #1b1b1b !important;
  --vw-bg: #f5f5f4 !important;
  --vw-bg-raised: #ffffff !important;
  --vw-border: rgba(0, 0, 0, 0.22) !important;
  --vw-shadow: 0 6px 24px rgba(0, 0, 0, 0.24) !important;
  --vw-accent: #1a5fb4 !important;
  --vw-accent-fg: #ffffff !important;
  --vw-muted: #6a6a6a !important;
  --vw-danger: #b3261e !important;
}

:host([data-scheme="dark"]) {
  --vw-fg: #ececec !important;
  --vw-bg: #23232a !important;
  --vw-bg-raised: #2e2e37 !important;
  --vw-border: rgba(255, 255, 255, 0.18) !important;
  --vw-shadow: 0 6px 24px rgba(0, 0, 0, 0.55) !important;
  --vw-accent: #7aa2f7 !important;
  --vw-accent-fg: #16161e !important;
  --vw-muted: #9a9aa5 !important;
  --vw-danger: #f28b82 !important;
}

.vw-layer {
  position: fixed;
  inset: 0;
  pointer-events: none;
  contain: layout style;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
    "Helvetica Neue", Arial, sans-serif;
  font-size: 13px;
  line-height: 1.4;
  color: var(--vw-fg);
  -webkit-font-smoothing: antialiased;
}

/*
 * Only a layer that owns the keyboard takes pointer events. A layer that took
 * a click over the whole page would break the page for every user who never
 * presses a key.
 */
.vw-layer[data-interactive="true"] {
  pointer-events: auto;
}

/* --- HUD --------------------------------------------------------------- */

.vw-hud {
  position: absolute;
  left: 0;
  bottom: 0;
  max-width: min(60vw, 640px);
  padding: 4px 10px;
  background: var(--vw-bg);
  color: var(--vw-fg);
  border: 1px solid var(--vw-border);
  border-left: none;
  border-bottom: none;
  border-radius: 0 var(--vw-radius) 0 0;
  box-shadow: var(--vw-shadow);
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  /*
   * Opacity and a short CSS transition, and not an animation loop. A
   * cross-origin frame is limited to 30 frames each second until the user
   * touches it, so an animation that JavaScript drives stutters there. One
   * that the compositor drives does not.
   */
  opacity: 0;
  transition: opacity 90ms ease-out;
}

.vw-hud[data-visible="true"] {
  opacity: 1;
}

.vw-hud[data-tone="error"] {
  color: var(--vw-danger);
}

.vw-hud-input {
  all: unset;
  display: inline-block;
  min-width: 12ch;
  font: inherit;
  font-family: var(--vw-mono);
  color: var(--vw-fg);
  caret-color: var(--vw-accent);
}

.vw-hud-label {
  font-family: var(--vw-mono);
  color: var(--vw-muted);
  margin-right: 4px;
}

.vw-hud-count {
  color: var(--vw-muted);
  margin-left: 8px;
}

/* --- Dialogs ----------------------------------------------------------- */

.vw-dialog-backdrop {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: 6vh 16px;
  background: rgba(0, 0, 0, 0.32);
  overflow: auto;
}

.vw-dialog {
  width: min(880px, 100%);
  max-height: 100%;
  overflow: auto;
  background: var(--vw-bg-raised);
  color: var(--vw-fg);
  border: 1px solid var(--vw-border);
  border-radius: 10px;
  box-shadow: var(--vw-shadow);
  padding: 20px 24px;
  overscroll-behavior: contain;
}

.vw-dialog h1 {
  margin: 0 0 2px;
  font-size: 17px;
  font-weight: 600;
}

.vw-dialog h2 {
  margin: 20px 0 6px;
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--vw-muted);
}

.vw-dialog p {
  margin: 0 0 10px;
  color: var(--vw-muted);
  font-size: 12px;
}

.vw-dialog a {
  color: var(--vw-accent);
}

.vw-cmd-table {
  display: grid;
  grid-template-columns: max-content 1fr max-content;
  gap: 2px 12px;
  align-items: baseline;
}

.vw-cmd-keys {
  font-family: var(--vw-mono);
  font-size: 12px;
  justify-self: end;
  white-space: nowrap;
}

.vw-cmd-desc {
  font-size: 12px;
}

.vw-cmd-native {
  font-family: var(--vw-mono);
  font-size: 11px;
  color: var(--vw-muted);
  white-space: nowrap;
}

/*
 * A tier C command is drawn, and not hidden. A grey row beside the native
 * Safari shortcut turns an absent capability into something that the user can
 * find.
 */
.vw-cmd-row[data-tier="C"] .vw-cmd-keys,
.vw-cmd-row[data-tier="C"] .vw-cmd-desc {
  opacity: 0.45;
}

.vw-badge {
  display: inline-block;
  padding: 0 5px;
  border: 1px solid var(--vw-border);
  border-radius: 4px;
  font-family: var(--vw-mono);
  font-size: 10px;
  color: var(--vw-muted);
}

.vw-diagnostics {
  margin: 0;
  padding: 10px 12px;
  background: var(--vw-bg);
  border: 1px solid var(--vw-border);
  border-radius: var(--vw-radius);
  font-family: var(--vw-mono);
  font-size: 11px;
  white-space: pre;
  overflow: auto;
  max-height: 240px;
  user-select: text;
  -webkit-user-select: text;
}

.vw-textarea {
  width: 100%;
  min-height: 220px;
  box-sizing: border-box;
  padding: 8px 10px;
  background: var(--vw-bg);
  color: var(--vw-fg);
  border: 1px solid var(--vw-border);
  border-radius: var(--vw-radius);
  font-family: var(--vw-mono);
  font-size: 12px;
  resize: vertical;
}

.vw-field {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin: 4px 0;
  font-size: 12px;
}

.vw-field label {
  flex: 1;
}

/*
 * A field whose control is a text area. The label sits on its own line, and
 * the text area follows it at the full width of the dialog.
 */
.vw-field--block {
  display: block;
  margin-top: 10px;
}

.vw-field--block label {
  display: block;
}

.vw-field input[type="number"] {
  width: 90px;
  padding: 3px 6px;
  background: var(--vw-bg);
  color: var(--vw-fg);
  border: 1px solid var(--vw-border);
  border-radius: 4px;
  font: inherit;
}

.vw-field input[type="text"] {
  width: min(360px, 55%);
  padding: 3px 6px;
  background: var(--vw-bg);
  color: var(--vw-fg);
  border: 1px solid var(--vw-border);
  border-radius: 4px;
  font: inherit;
  font-family: var(--vw-mono);
}

/*
 * The focus ring.
 *
 * .vw-button starts from "all: unset", which removes the ring of the user
 * agent as well. A user who moves through the dialog with the keyboard could
 * therefore not tell which button was about to act.
 */
.vw-dialog button:focus-visible,
.vw-dialog input:focus-visible,
.vw-dialog textarea:focus-visible,
.vw-hud-input:focus-visible {
  outline: 2px solid var(--vw-accent);
  outline-offset: 2px;
}

.vw-button-row {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  margin-top: 12px;
  position: sticky;
  bottom: 0;
  padding-top: 12px;
  background: var(--vw-bg-raised);
}

.vw-button {
  all: unset;
  padding: 5px 12px;
  border: 1px solid var(--vw-border);
  border-radius: var(--vw-radius);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  background: var(--vw-bg);
}

.vw-button[data-variant="primary"] {
  background: var(--vw-accent);
  color: var(--vw-accent-fg);
  border-color: transparent;
}

.vw-problem {
  color: var(--vw-danger);
  font-family: var(--vw-mono);
  font-size: 11px;
  margin: 4px 0 0;
  white-space: pre-wrap;
}

/* --- The frame indicator, for gf and gF --------------------------------- */

.vw-frame-flash {
  position: absolute;
  inset: 0;
  border: 3px solid var(--vw-accent);
  border-radius: 2px;
  opacity: 0;
  transition: opacity 140ms ease-out;
}

.vw-frame-flash[data-visible="true"] {
  opacity: 1;
}

@media (prefers-reduced-motion: reduce) {
  .vw-hud,
  .vw-frame-flash {
    transition: none;
  }
}
`;
