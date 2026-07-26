# Vimium-WebKit

> Vim-style keyboard navigation for the web, as a single userscript — built for
> **WebKit** first, and working everywhere else as a consequence.

Vimium-WebKit is an independent reimplementation of
[Vimium](https://github.com/philc/vimium) that runs as a userscript under
Tampermonkey, Violentmonkey, and the Safari-native userscript managers. It
exists because Vimium is a browser extension and Safari's extension model — plus
a handful of WebKit-specific behaviours — makes a straight port impossible.

The full engineering rationale, including every WebKit limitation and how it is
worked around, is in [`IMPLEMENTATION_PLAN.md`](./IMPLEMENTATION_PLAN.md).

---

## Install

1. Install a userscript manager:
   - **macOS / iOS Safari** —
     [Tampermonkey for Safari](https://apps.apple.com/us/app/tampermonkey/id6738342400)
     (paid, the most complete API) or
     [Userscripts by quoid](https://github.com/quoid/userscripts) (free, and our
     capability floor).
   - **Chrome / Edge / Firefox** —
     [Violentmonkey](https://violentmonkey.github.io) or
     [Tampermonkey](https://www.tampermonkey.net).
2. Install `dist/vimium-webkit.user.js`.
3. Press `?` on any page for the full key reference.

> [!NOTE]
> **Violentmonkey has no Safari build** and
> [no plans for one](https://github.com/violentmonkey/violentmonkey/issues/303).
> On WebKit, "Violentmonkey" means "Violentmonkey running inside
> [Orion](https://kagi.com/orion/)".

> [!IMPORTANT]
> Safari's per-site permission model means you must grant the manager access to
> each site (or "Always Allow On Every Website"). Until you do, nothing happens
> — and nothing can, because the script is never injected.

---

## What works, and what cannot

This is the honest accounting, and it is the most useful section of this README.
A userscript is **content-script-only**: there is no service worker, no
`chrome.tabs`, no `chrome.history`, no `chrome.bookmarks`, no options page.
Roughly a fifth of Vimium's command set depends on exactly those APIs.

Commands are classified into three tiers, and **all three are bound**. Pressing
`J` does not silently do nothing — it tells you why tab switching is impossible
and shows you the native Safari shortcut instead.

| Tier  | Count | Behaviour                                                                    |
| ----- | ----- | ---------------------------------------------------------------------------- |
| **A** | 38    | Full parity. Pure DOM; works identically on every browser and every manager. |
| **B** | 22    | Works, with a documented caveat, or depends on a `GM_*` capability.          |
| **C** | 17    | Not implementable. Greyed out in `?`; pressing the key explains why.         |

### Tier A — full parity

| Keys                | Command                         | Description                                    |
| ------------------- | ------------------------------- | ---------------------------------------------- |
| `j` `<down>`        | `scrollDown`                    | Scroll down                                    |
| `k` `<up>`          | `scrollUp`                      | Scroll up                                      |
| `h` `<left>`        | `scrollLeft`                    | Scroll left                                    |
| `l` `<right>`       | `scrollRight`                   | Scroll right                                   |
| `d` `<c-d>`         | `scrollPageDown`                | Scroll a half page down                        |
| `u` `<c-u>`         | `scrollPageUp`                  | Scroll a half page up                          |
| `<c-f>` `<space>`   | `scrollFullPageDown`            | Scroll a full page down                        |
| `<c-b>` `<s-space>` | `scrollFullPageUp`              | Scroll a full page up                          |
| `gg`                | `scrollToTop`                   | Scroll to the top of the page                  |
| `G`                 | `scrollToBottom`                | Scroll to the bottom of the page               |
| `zH` `0`            | `scrollToLeft`                  | Scroll all the way left                        |
| `zL` `$`            | `scrollToRight`                 | Scroll all the way right                       |
| `r`                 | `reload`                        | Reload the page                                |
| `R`                 | `reloadHard`                    | Reload, bypassing the cache¹                   |
| `H`                 | `goBack`                        | Go back in history                             |
| `L`                 | `goForward`                     | Go forward in history                          |
| `gu`                | `goUp`                          | Go up the URL hierarchy                        |
| `gU`                | `goToRoot`                      | Go to the site root                            |
| `[[`                | `goPrevious`                    | Follow the "previous" link                     |
| `]]`                | `goNext`                        | Follow the "next" link                         |
| `f`                 | `LinkHints.activateMode`        | Open a link                                    |
| `<a-h>`             | `LinkHints.activateModeToHover` | Hover over an element                          |
| —                   | `LinkHints.activateModeToFocus` | Focus an element                               |
| `/`                 | `enterFindMode`                 | Search the page                                |
| `n`                 | `performFind`                   | Go to the next match                           |
| `N`                 | `performBackwardsFind`          | Go to the previous match                       |
| `*`                 | `searchWordForwards`            | Search for the word under the cursor           |
| `#`                 | `searchWordBackwards`           | Search backwards for the word under the cursor |
| `v`                 | `enterVisualMode`               | Enter visual mode                              |
| `V`                 | `enterVisualLineMode`           | Enter visual line mode                         |
| `c`                 | `enterCaretMode`                | Enter caret mode                               |
| `i`                 | `enterInsertMode`               | Enter insert mode                              |
| `gi`                | `focusInput`                    | Focus a text input                             |
| `m`                 | `Marks.activateCreateMode`      | Set a mark                                     |
| <code>&#96;</code>  | `Marks.activateGotoMode`        | Jump to a mark                                 |
| `?`                 | `showHelp`                      | Show the help dialog                           |
| —                   | `showSettings`                  | Open settings                                  |
| —                   | `passNextKey`                   | Pass the next key to the page                  |

¹ A userscript cannot request a cache-bypassing reload. `R` approximates it with
a cache-busting query parameter and says so in the HUD.

### Tier B — works, with a caveat

| Keys           | Command                                          | Caveat                                                                                         |
| -------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `F`            | `LinkHints.activateModeToOpenInNewTab`           | Routed through `GM_openInTab`; synthetic ⌘-clicks do not open tabs in WebKit                   |
| `<a-f>`        | `LinkHints.activateModeToOpenInNewForegroundTab` | Same                                                                                           |
| `yf`           | `LinkHints.activateModeToCopyLinkUrl`            | Needs a clipboard API; denied on `http://` without `GM_setClipboard`                           |
| `yt`           | `LinkHints.activateModeToCopyLinkText`           | Same                                                                                           |
| `<a-o>`        | `LinkHints.activateModeWithOmnibar`              | Omnibar-lite has no browser history behind it                                                  |
| `yy`           | `copyCurrentUrl`                                 | Same clipboard caveat                                                                          |
| `yT`           | `copyCurrentTitle`                               | Same                                                                                           |
| `p`            | `openCopiedUrlInCurrentTab`                      | WebKit will not hand a script the clipboard, so this opens a pre-focused input — paste with ⌘V |
| `P`            | `openCopiedUrlInNewTab`                          | Same                                                                                           |
| `t`            | `createTab`                                      | Needs `GM_openInTab`                                                                           |
| `x`            | `removeTab`                                      | Needs `@grant window.close` — **unavailable on quoid and Stay**                                |
| `<a-m>`        | `toggleMuteTab`                                  | Mutes `<audio>`/`<video>` elements only; WebAudio keeps playing                                |
| `zi` `zo` `z0` | `zoomIn` `zoomOut` `zoomReset`                   | CSS zoom, not browser zoom. Off by default; breaks `position: fixed` on some sites             |
| `gs`           | `toggleViewSource`                               | Some managers refuse to open `view-source:`                                                    |
| `o` `O`        | `Vomnibar.activate`, `…InNewTab`                 | See [Omnibar-lite](#omnibar-lite)                                                              |
| `:`            | `Vomnibar.activateCommands`                      | Full parity — the command palette needs no browser API                                         |
| `s`            | `Vomnibar.activateSearch`                        | Search suggestions need `@connect`, which quoid does not implement                             |
| `gf` `gF`      | `nextFrame`, `mainFrame`                         | Cannot see frames the script failed to inject into (CSP-sandboxed, older `about:blank`)        |

### Tier C — not implementable

Bound, so pressing the key explains itself rather than doing nothing.

| Keys        | Command                                   | Why, and what to use instead                                                  |
| ----------- | ----------------------------------------- | ----------------------------------------------------------------------------- |
| `gd`        | `LinkHints.activateModeToDownloadLink`    | WebKit ignores synthetic modifier-clicks → right-click → Download Linked File |
| `gI`        | `LinkHints.activateModeToOpenIncognito`   | No window-creation API                                                        |
| `X`         | `restoreTab`                              | No session API → ⌘⇧T                                                          |
| `K` `gt`    | `nextTab`                                 | No tab-management API → ⌘⇧]                                                   |
| `J` `gT`    | `previousTab`                             | No tab-management API → ⌘⇧[                                                   |
| `g0` / `g$` | `firstTab` / `lastTab`                    | No tab-management API → ⌘1 / ⌘9                                               |
| `^`         | `visitPreviousTab`                        | No tab-management API                                                         |
| `<<` / `>>` | `moveTabLeft` / `moveTabRight`            | No tab-management API → drag the tab                                          |
| `W`         | `moveTabToNewWindow`                      | No tab-management API → drag the tab out                                      |
| `<a-p>`     | `togglePinTab`                            | No tab-management API → right-click the tab                                   |
| `yd`        | `duplicateTab`                            | No tab-management API → right-click the tab                                   |
| —           | `closeTabsOnLeft/Right`, `closeOtherTabs` | No tab-management API → right-click the tab                                   |
| `b`         | `Vomnibar.activateBookmarks`              | No bookmarks API → ⌥⌘B                                                        |

### Safari reserves some keys outright

Safari never dispatches a `keydown` for `⌘N`, `⌘W`, `⌘Q`, `⌘T`, `⌘R`, `⌘L`,
`⌃Tab`, or `⌃⇧Tab` — `preventDefault()` is irrelevant because the event does not
arrive at all. Binding one of these is **rejected at parse time** with an
explanation, rather than silently accepted and dead. `⌘S`, `⌘P`, `⌘F` and `⌘D`
are preventable on macOS but
[possibly not on iOS](https://bugs.webkit.org/show_bug.cgi?id=191768); they are
allowed and flagged.

---

## Configuration

Press `?` → **Settings…**. There is no options page — a userscript cannot have
one — so settings live in an in-page overlay.

Key mappings use Vimium's syntax, so an existing configuration pastes in
unchanged:

```
# Comments start with # or " at the beginning of a line.
unmap j
map <c-j> scrollDown
map gh LinkHints.activateModeToHover
mapkey a b          " remap a physical key
unmapAll            " start from nothing
```

Settings are stored with your userscript manager, **never in `localStorage`** —
Safari's Intelligent Tracking Prevention erases all script-writable storage
after seven days without interaction with a site, which would silently destroy
your mappings and marks.

### Omnibar-lite

`o` opens a completion overlay. It is deliberately **not** a ⌘L clone, because
the two APIs that would make it one do not exist for a userscript:

| Source             | Availability                                                   |
| ------------------ | -------------------------------------------------------------- |
| Commands (`:`)     | ✅ Full parity, including greyed-out Tier C entries            |
| Search engines     | ✅ Vimium-compatible `keyword: url %s Description` config      |
| Search suggestions | ⚠️ Needs `@connect`; silently unavailable on quoid             |
| Local history      | ⚠️ **Opt-in, off by default** — see below                      |
| Browser history    | ❌ No `chrome.history`                                         |
| Bookmarks          | ❌ No `chrome.bookmarks`                                       |
| Open tabs          | ⚠️ Only tabs _we_ opened, labelled "Recent" rather than "Tabs" |

> [!WARNING]
> **Privacy.** The local history index is a real privacy surface: it records the
> pages you visit into userscript-manager storage, which the manager's own UI
> can read. It is **off by default**, honours a per-origin denylist, skips
> private browsing where detectable, is capped with LRU eviction, can be wiped
> with `:clear-history`, and never leaves your device. Turn it on deliberately
> or not at all.

---

## Development

```
deno task check      # type-check src/, build/, test/
deno task test       # unit tests
deno task test:e2e   # Playwright, against WebKit + Chromium + Firefox
deno task lint
deno task build      # dist/vimium-webkit.user.js + invariant checks
deno task verify     # everything above
```

`deno task test:e2e:install` fetches the browser binaries the first time.

### Build invariants

`deno task build` fails the build on any of these, because each one is a way the
project could quietly stop working on WebKit:

1. No `eval`, `new Function`, `document.write`, or inline event-handler strings
   — all of them are blocked by a page CSP.
2. No `<style>` elements outside the documented Safari <16.4 fallback. Safari
   applies the **page's** `style-src` to nodes a content script injects; only
   CSSOM (`adoptedStyleSheets`) escapes it.
3. Stage 0 ≤ 5 KB. It runs in every frame of every page whether or not you ever
   press a key.
4. Bundle ≤ 1.5 MB unminified (Greasy Fork's ceiling is 2 MB, measured
   unminified).
5. `@version` matches `deno.json`.
6. Every `GM_*` / `GM.*` reference goes through `src/platform/gm.ts`.
7. Every command carries a tier, and every Tier C command carries a user-facing
   explanation.
8. Every read of `navigator` or `unsafeWindow` goes through
   `src/platform/ambient.ts`. A page, an extension, or a sandboxing manager can
   replace a global with an accessor that _throws_, and neither a `typeof` guard
   nor `?.` survives that — both perform the read.

### Architecture

```
src/
  boot/       Staged, idempotent, late-safe boot (document-start is unreliable on WebKit)
  platform/   Capability probe, GM shim, storage, clipboard, tabs, scheduler
  core/       Handler stack, modes, key notation, mapping parser, command registry
  features/   Hints, find, visual/caret, scroller, marks, insert, omnibar
  ui/         One closed shadow root, styled through CSSOM
  frames/     Top-frame coordinator over postMessage + transferred MessagePort
  settings/   Zod schema, defaults, migrations
```

Three decisions carry most of the weight:

- **Content world, not page world.** quoid's GM API only exists there, and the
  choice does not affect keyboard interception at all.
- **One closed shadow root, styled with `adoptedStyleSheets`.** This solves page
  CSP, page CSS bleed, and detectability in a single move — and it is the reason
  the overlay survives on strict-CSP sites where a `<style>` element would not.
- **The top frame elects itself coordinator.** There is no background page to
  broker cross-frame link hints, so frames hand it a transferred `MessagePort`.

---

## Licence

MIT. See [`LICENSE`](./LICENSE).

Behaviour is ported from [Vimium](https://github.com/philc/vimium) (MIT, © 2010
Phil Crosby, Ilya Sukhar). Each source file names the upstream file it derives
from; see [`THIRD-PARTY-NOTICES.md`](./THIRD-PARTY-NOTICES.md).
