/**
 * Find-overlay CSS.
 *
 * Installed through `app.ui.addStyle()`, which routes it into the shadow root's
 * `adoptedStyleSheets`. **Never build a `<style>` element for this.** Safari
 * applies the *page's* `style-src` to DOM nodes injected by a content script,
 * so a `<style>` tag is blocked outright on any CSP-hardened site, while a
 * constructable stylesheet is not a fetch and is not policed.
 *
 * Why overlay rects at all, rather than `::selection` or the CSS Custom
 * Highlight API: page CSS cannot be trusted to leave `::selection` alone —
 * plenty of sites set it to transparent — and `::highlight()` was not usable
 * across the WebKit versions we target. Drawing our own rects is the only way
 * to guarantee the user can see where the match is.
 */

/**
 * The palette is the hint markers' amber, deliberately: this is the same
 * extension speaking, and a user should not have to learn a second colour.
 *
 * The fill is translucent rather than opaque because the rect sits *over* the
 * text — the shadow host is at `z-index: 2147483647` — so anything above about
 * 45% alpha makes the matched word unreadable, which rather defeats the point.
 */
export const FIND_CSS = `
.vw-find {
  position: absolute;
  inset: 0;
  pointer-events: none;
  contain: layout style;
}

.vw-find__rect {
  position: absolute;
  top: 0;
  left: 0;
  box-sizing: border-box;
  background: rgba(255, 197, 66, 0.42);
  border-radius: 2px;
  pointer-events: none;
  will-change: transform;
}

/*
 * The current match. Distinguished by *outline* rather than by a stronger fill:
 * an outline reads at a glance without hiding the glyphs underneath, and it
 * survives being drawn over a dark page where a fill-only difference does not.
 */
.vw-find__rect--current {
  background: rgba(255, 138, 0, 0.45);
  outline: 2px solid #c2410c;
  outline-offset: 1px;
  box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.75);
}

.vw-find__rect--hidden {
  display: none;
}
`;
