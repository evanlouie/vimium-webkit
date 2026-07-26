/**
 * Omnibar-lite CSS.
 *
 * Exported as a string and installed through `app.ui.addStyle()`, which routes
 * it into the shadow root's `adoptedStyleSheets`. **Never build a `<style>`
 * element for this.** Safari applies the *page's* `style-src` to DOM nodes
 * injected by a content script, so a `<style>` tag is blocked outright on any
 * site with a strict CSP, while a constructable stylesheet is not a fetch and
 * is not policed (IMPLEMENTATION_PLAN.md §6.3, §7.2).
 *
 * The palette is the hint markers' amber for accents on a neutral panel: the
 * omnibar is read, not glanced at, so unlike a hint marker it needs contrast
 * and rhythm rather than a single loud colour.
 */

export const OMNIBAR_CSS = `
.vw-omnibar {
  position: absolute;
  top: 0;
  left: 0;
  box-sizing: border-box;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  /* The host layer is pointer-events:none; the panel opts back in so the user
     can click a row without the click falling through to the page. */
  pointer-events: none;
  contain: layout style;
}

.vw-omnibar__panel {
  pointer-events: auto;
  box-sizing: border-box;
  width: min(640px, 92%);
  max-height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: #ffffff;
  color: #1c1c1e;
  border: 1px solid rgba(0, 0, 0, 0.14);
  border-radius: 10px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.32);
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif;
  font-size: 14px;
  line-height: 1.35;
}

.vw-omnibar__field {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border-bottom: 1px solid rgba(0, 0, 0, 0.1);
}

.vw-omnibar__prefix {
  flex: none;
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
  font-size: 13px;
  font-weight: 700;
  color: #c38a22;
}

/*
 * A real <input> inside our closed shadow root. It participates in the page's
 * focus, which is why the omnibar mode has to sit on the handler stack and
 * claim the keyboard rather than relying on focus alone.
 */
.vw-omnibar__input {
  flex: 1 1 auto;
  min-width: 0;
  box-sizing: border-box;
  margin: 0;
  padding: 0;
  border: 0;
  outline: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 16px;
  /* 16px: anything smaller makes iOS Safari zoom the page on focus. */
}

.vw-omnibar__input::placeholder {
  color: rgba(0, 0, 0, 0.35);
}

.vw-omnibar__list {
  margin: 0;
  padding: 4px 0;
  list-style: none;
  overflow-y: auto;
  overscroll-behavior: contain;
  -webkit-overflow-scrolling: touch;
}

.vw-omnibar__row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 6px 12px;
  cursor: default;
}

.vw-omnibar__row--selected {
  background: rgba(255, 197, 66, 0.28);
  box-shadow: inset 2px 0 0 #c38a22;
}

/*
 * Tier C. Greyed out but present, with the native shortcut alongside: per §4.3
 * a visible refusal is a discoverability win, not a gap.
 */
.vw-omnibar__row--muted .vw-omnibar__title,
.vw-omnibar__row--muted .vw-omnibar__detail {
  opacity: 0.5;
}

.vw-omnibar__badge {
  flex: none;
  min-width: 62px;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.4px;
  text-transform: uppercase;
  color: rgba(0, 0, 0, 0.45);
  text-align: right;
}

.vw-omnibar__body {
  flex: 1 1 auto;
  min-width: 0;
}

.vw-omnibar__title {
  display: block;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.vw-omnibar__detail {
  display: block;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: 12px;
  color: rgba(0, 0, 0, 0.5);
}

.vw-omnibar__native {
  flex: none;
  padding: 1px 6px;
  border: 1px solid rgba(0, 0, 0, 0.2);
  border-radius: 4px;
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
  font-size: 11px;
  color: rgba(0, 0, 0, 0.6);
  white-space: nowrap;
}

.vw-omnibar__empty {
  padding: 10px 12px;
  font-size: 13px;
  color: rgba(0, 0, 0, 0.45);
}

.vw-omnibar__footer {
  padding: 6px 12px;
  border-top: 1px solid rgba(0, 0, 0, 0.1);
  font-size: 11px;
  color: rgba(0, 0, 0, 0.42);
}

@media (prefers-color-scheme: dark) {
  .vw-omnibar__panel {
    background: #1f1f21;
    color: #f2f2f7;
    border-color: rgba(255, 255, 255, 0.14);
  }

  .vw-omnibar__field,
  .vw-omnibar__footer {
    border-color: rgba(255, 255, 255, 0.12);
  }

  .vw-omnibar__input::placeholder {
    color: rgba(255, 255, 255, 0.35);
  }

  .vw-omnibar__badge {
    color: rgba(255, 255, 255, 0.45);
  }

  .vw-omnibar__detail,
  .vw-omnibar__empty,
  .vw-omnibar__footer {
    color: rgba(255, 255, 255, 0.5);
  }

  .vw-omnibar__native {
    border-color: rgba(255, 255, 255, 0.25);
    color: rgba(255, 255, 255, 0.65);
  }

  .vw-omnibar__row--selected {
    background: rgba(255, 197, 66, 0.22);
  }
}
`;
