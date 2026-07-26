/**
 * Hint marker CSS.
 *
 * Exported as a string and installed through `app.ui.addStyle()`, which routes
 * it into the shadow root's `adoptedStyleSheets`. **Never build a `<style>`
 * element for this.** Safari applies the *page's* `style-src` to DOM nodes
 * injected by a content script, so a `<style>` tag is blocked outright on any
 * site with a strict CSP — while a constructable stylesheet is not a fetch and
 * is not policed. That is the single reason the overlay works on GitHub, GMail
 * and every bank.
 *
 * The visual language is upstream Vimium's, deliberately: users recognise the
 * yellow box, and a hint marker is a thing you read in 80 ms under time
 * pressure. This is not the place for novelty.
 */

/**
 * `all: initial` is applied by the shadow host, so nothing here has to defend
 * against inherited page styles; only the properties we actively want are set.
 */
export const HINT_CSS = `
.vw-hints {
  position: absolute;
  inset: 0;
  pointer-events: none;
  /* Marker churn during filter mode must not invalidate page layout. */
  contain: layout style;
}

.vw-hint {
  position: absolute;
  top: 0;
  left: 0;
  display: block;
  box-sizing: border-box;
  padding: 1px 3px;
  background: linear-gradient(to bottom, #fff785 0%, #ffc542 100%);
  border: 1px solid #c38a22;
  border-radius: 3px;
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.35);
  color: #302505;
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
  font-size: 11px;
  font-weight: 700;
  line-height: 1.1;
  letter-spacing: 0.5px;
  text-transform: uppercase;
  text-align: left;
  white-space: nowrap;
  pointer-events: none;
  /* Promote once, up front: filter mode re-renders on every keystroke and we
     only ever change the transform. */
  will-change: transform;
}

/*
 * Weak-signal hints (class name, bare span, tabindex). Visibly present but
 * visually quieter, so the eye lands on real links first.
 */
.vw-hint--secondary {
  background: linear-gradient(to bottom, #f6f0c8 0%, #e8d79a 100%);
  border-color: #b9a86a;
}

/* Characters the user has already typed. Dimmed, never removed: the width must
   not change mid-typing or the markers dance. */
.vw-hint__matched {
  color: #c38a22;
  opacity: 0.55;
}

/* Filter mode: the link text beside the number. Lower case and lighter, so it
   never competes with the digits. */
.vw-hint__text {
  margin-left: 4px;
  font-weight: 400;
  text-transform: none;
  letter-spacing: 0;
  opacity: 0.75;
}

/* Filter mode: the candidate Tab/Enter would activate. */
.vw-hint--active {
  border-color: #1a73e8;
  box-shadow: 0 0 0 2px rgba(26, 115, 232, 0.55), 0 2px 4px rgba(0, 0, 0, 0.35);
}

/* Filtered out. \`display: none\` rather than opacity so hidden markers cost
   nothing to lay out — on a link-dense page most markers are hidden most of
   the time. */
.vw-hint--hidden {
  display: none;
}

@media (prefers-reduced-motion: no-preference) {
  .vw-hint {
    transition: opacity 60ms linear;
  }
}
`;

/**
 * The stylesheet for a session, with `userDefinedLinkHintCss` appended.
 *
 * Appended rather than merged so that user rules win on equal specificity, and
 * scoped by being inside our shadow root so a bad user rule can only break our
 * own overlay, never the page.
 */
export const hintCss = (userDefinedLinkHintCss: string): string => {
  const user = userDefinedLinkHintCss.trim();
  return user.length === 0 ? HINT_CSS : `${HINT_CSS}\n/* user */\n${user}\n`;
};
