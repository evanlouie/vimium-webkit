/**
 * Base styles for the overlay.
 *
 * Everything here is installed through CSSOM (`adoptedStyleSheets`), never as a
 * `<style>` element: Safari applies the *page's* `style-src` to DOM nodes
 * injected by content scripts, and a constructed stylesheet is not a
 * `style-src` fetch. This is the single trick that keeps the UI alive on
 * strict-CSP sites (IMPLEMENTATION_PLAN.md §6.3, §7.2).
 *
 * `all: initial` on the host means nothing inherits in from the page. That in
 * turn means *every* property we rely on must be set explicitly — there is no
 * useful cascade to lean on.
 */

export const BASE_CSS = `
:host {
  all: initial;
  --vw-fg: #1b1b1b;
  --vw-bg: #f5f5f4;
  --vw-bg-raised: #ffffff;
  --vw-border: rgba(0, 0, 0, 0.22);
  --vw-shadow: 0 6px 24px rgba(0, 0, 0, 0.24);
  --vw-accent: #1a5fb4;
  --vw-accent-fg: #ffffff;
  --vw-muted: #6a6a6a;
  --vw-danger: #b3261e;
  --vw-mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  --vw-radius: 6px;
}

@media (prefers-color-scheme: dark) {
  :host {
    --vw-fg: #ececec;
    --vw-bg: #23232a;
    --vw-bg-raised: #2e2e37;
    --vw-border: rgba(255, 255, 255, 0.18);
    --vw-shadow: 0 6px 24px rgba(0, 0, 0, 0.55);
    --vw-accent: #7aa2f7;
    --vw-accent-fg: #16161e;
    --vw-muted: #9a9aa5;
    --vw-danger: #f28b82;
  }
}

/*
 * The resolved scheme, decided in JS (\`ui/root.ts\`).
 *
 * \`followPageColorScheme\` means "match the page", and no media query can
 * express that — a light overlay on a dark page is the thing the setting
 * exists to prevent. \`:host([data-scheme])\` outranks the bare \`:host\` rules
 * above on specificity, so it wins over the user-agent preference whichever
 * order the sheets are adopted in.
 */
:host([data-scheme="light"]) {
  --vw-fg: #1b1b1b;
  --vw-bg: #f5f5f4;
  --vw-bg-raised: #ffffff;
  --vw-border: rgba(0, 0, 0, 0.22);
  --vw-shadow: 0 6px 24px rgba(0, 0, 0, 0.24);
  --vw-accent: #1a5fb4;
  --vw-accent-fg: #ffffff;
  --vw-muted: #6a6a6a;
  --vw-danger: #b3261e;
}

:host([data-scheme="dark"]) {
  --vw-fg: #ececec;
  --vw-bg: #23232a;
  --vw-bg-raised: #2e2e37;
  --vw-border: rgba(255, 255, 255, 0.18);
  --vw-shadow: 0 6px 24px rgba(0, 0, 0, 0.55);
  --vw-accent: #7aa2f7;
  --vw-accent-fg: #16161e;
  --vw-muted: #9a9aa5;
  --vw-danger: #f28b82;
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
 * Only the layers that own the keyboard take pointer events. A layer that
 * swallowed clicks page-wide would break the page for every user who never
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
   * Opacity + a short CSS transition rather than a rAF loop: cross-origin
   * frames are throttled to 30fps until the user interacts with them, so a
   * JS-driven animation there stutters where a compositor-driven one does not.
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
 * Tier C is rendered, not hidden. A greyed-out row with the native Safari
 * shortcut alongside turns a missing capability into a discoverability win
 * (§4.3).
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

.vw-field input[type="number"] {
  width: 90px;
  padding: 3px 6px;
  background: var(--vw-bg);
  color: var(--vw-fg);
  border: 1px solid var(--vw-border);
  border-radius: 4px;
  font: inherit;
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

/* --- Frame indicator (gf / gF) ------------------------------------------ */

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
