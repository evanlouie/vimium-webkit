# Vimium-WebKit

> Vim-style keyboard navigation for the web, as a single userscript — built for
> **WebKit** first, and working everywhere else as a consequence.

Vimium-WebKit is an independent reimplementation of
[Vimium](https://github.com/philc/vimium) that runs as a userscript under
Tampermonkey, Violentmonkey, and the Safari-native userscript managers. It
exists because Vimium is a browser extension and Safari's extension model — plus
a handful of WebKit-specific behaviours — makes a straight port impossible.

The full engineering rationale, including every WebKit limitation and how it is
worked around, is in [`ARCHITECTURE.md`](./ARCHITECTURE.md).

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
2. Install the userscript:
   [`vimium-webkit.user.js`](https://github.com/evanlouie/vimium-webkit/releases/latest/download/vimium-webkit.user.js)
   from the latest release. Your manager will offer to install it and will check
   that URL for updates afterwards.

   Building it yourself gives a byte-for-byte identical file: `npm run build`
   writes `dist/vimium-webkit.user.js`. `dist/` is not committed, deliberately —
   a build output in version control is a second source of truth that goes stale
   the first time someone forgets to rebuild.
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

| Tier | Count | Behaviour |

| Tier  | Count | Meaning                                                               |
| ----- | ----- | --------------------------------------------------------------------- |
| **A** | 37    | Full parity. No `GM_*` capability needed; identical on every manager. |
| **B** | 22    | Works, with a documented caveat, or depends on a `GM_*` capability.   |
| **C** | 18    | Not implementable. Greyed out in `?`; pressing the key explains why.  |

> [!NOTE]
> Tier A means "needs no manager capability", not "pure DOM". Marks are Tier A
> and are persisted through the manager's value store, because losing a mark on
> a manager without one is a degraded feature rather than an absent one.

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
| `o` `O`        | `Vomnibar.activate`, `…InNewTab`                 | Both open the omnibar in this tab: a userscript cannot pre-focus a new tab's address bar       |
| `:`            | `Vomnibar.activateCommands`                      | Full parity — the command palette needs no browser API                                         |
| `s`            | `Vomnibar.activateSearch`                        | Suggestions are opt-in and need `@connect`, which quoid does not implement                     |
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

### A focused video player keeps its own keys

The defaults bind `<up>`, `<down>`, `<left>`, `<right>` and `<space>` — and
those are also the five keys every media player uses for seek, volume and
play/pause, including the browser's own `<video controls>`. While a `<video>` or
`<audio>` element (or the focusable shell around one, which is what a site like
YouTube actually focuses) holds the focus, those five go to the page instead of
scrolling. Everything else stays ours: `j`/`k` scroll a watch page even though
YouTube binds them too.

Move the focus anywhere else — click a comment, press `Escape` — and they scroll
again. Set `passMediaKeys` to `false` to always scroll with them.

### An Option chord on macOS names your own key

macOS applies Option to the character: `Option+F` reports the character `ƒ`, and
`Option+E` reports `Dead`. No mapping file can name those. On macOS, iOS and
iPadOS a chord with Option is therefore read as **the character that the key
makes with no modifier**, so `<a-f>` is the F key of _your_ layout — the Y
position on Dvorak, and the A position of an AZERTY keyboard for `<a-a>`.

Three limits:

- The rule applies on Apple platforms only. On Windows and on Linux, Alt leaves
  the character alone, so `Alt+ф` stays `<a-ф>`.
- On a macOS layout that is not Latin, no field of this Option event carries the
  unmodified letter. The application can read the letter from a separate plain
  event, but it does not remember it. The same key is `ф` alone and `<a-a>` with
  Option. Issue [#64](https://github.com/evanlouie/vimium-webkit/issues/64)
  tracks a learned session map.
- With Shift, only a letter is translated. `Option+Shift+1` keeps the character
  that it makes, because a fold to `<a-1>` would take the binding of `Option+1`.

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

Settings are stored with your userscript manager wherever it offers a value
store, which is durable. A manager that offers none leaves your settings, your
marks and your history in memory for the life of the page, and the script tells
you so, in the settings dialog and in a one-time warning. The frames of a page
also stay apart on such a manager: link hints across frames and frame focus are
off, and a frame does not learn that you excluded the page. The script never
writes your settings, marks or history to `localStorage`: the page owns that
store, so every script on the site could read and change them, and it could also
read the credential that admits a frame to the cross-frame session.

### Every setting

All of these are editable in the settings overlay. There is no hidden
configuration and no config file.

| Setting                        | Default                | What it does                                                                   |
| ------------------------------ | ---------------------- | ------------------------------------------------------------------------------ |
| `scrollStepSize`               | `60`                   | Pixels one `j`/`k` moves. 1–10000.                                             |
| `smoothScroll`                 | `true`                 | Animate scrolling. Ignored when `prefers-reduced-motion` is set.               |
| `linkHintCharacters`           | `sadfjklewcmpgh`       | Alphabet for hint labels. Characters must be distinct and visible.             |
| `linkHintNumbers`              | `0123456789`           | Digits used to select among filtered hints.                                    |
| `filterLinkHints`              | `false`                | Match hints by link text instead of by hint string.                            |
| `waitForEnterForFilteredHints` | `true`                 | In filter mode, require Enter rather than activating on a pause.               |
| `userDefinedLinkHintCss`       | empty                  | Extra CSS for hint markers, inside our shadow root. No `@import` or `url()`.   |
| `regexFindMode`                | `false`                | Treat a bare find query as a regular expression.                               |
| `ignoreKeyboardLayout`         | `false`                | Bind physical key positions, so Dvorak and Cyrillic drive QWERTY bindings.     |
| `shadowNativeFind`             | `false`                | Shadow the browser's own ⌘F. Off because it may be unpreventable on iOS.       |
| `previousPatterns`             | `prev,previous,back,…` | Link text `[` looks for.                                                       |
| `nextPatterns`                 | `next,more,newer,…`    | Link text `]` looks for.                                                       |
| `searchUrl`                    | Google                 | Default search template. Must contain `%s`.                                    |
| `searchEngines`                | 5 engines              | One `keyword: url-with-%s Description` per line. Templates must be `http(s)`.  |
| `newTabUrl`                    | `about:blank`          | What `t` opens.                                                                |
| `enableSearchSuggestions`      | **`false`**            | Send omnibar searches to your engine as you type. See [Privacy](./PRIVACY.md). |
| `hideHud`                      | `false`                | Suppress the corner HUD entirely.                                              |
| `followPageColorScheme`        | `true`                 | Match the overlay to the page's theme rather than your system appearance.      |
| `grabBackFocus`                | `false`                | Blur a field the page autofocused on load — unless you have already typed.     |
| `passMediaKeys`                | `true`                 | Leave the arrow keys and space to a focused `<video>`/`<audio>` player.        |
| `enableCssZoom`                | `false`                | Enable `zi`/`zo`. CSS zoom, not browser zoom; breaks `position: fixed` sites.  |
| `enableHistoryIndex`           | **`false`**            | Build a local frecency index for the omnibar. See [Privacy](./PRIVACY.md).     |
| `historyIndexDenylist`         | empty                  | URL globs never recorded in that index.                                        |
| `historyIndexLimit`            | `5000`                 | Entries kept before LRU eviction. `0` disables recording.                      |
| `exclusionRules`               | empty                  | URL glob → pass-key set. An empty pass-key set disables us on matching pages.  |
| `keyMappings`                  | empty                  | Your `map`/`unmap`/`unmapAll`/`mapkey` lines, applied over the defaults.       |

A value the script cannot make sense of falls back to its own default — that one
setting, not the whole configuration.

### What can be a hint character

`linkHintCharacters` and `linkHintNumbers` hold characters, and each character
is one label of one link. Each accepted character is one independent NFC code
point. Each ordered pair stays separate and has one unique matching key.

A character must be a letter, a number, a punctuation mark or a symbol. The set
is composed with NFC first, so `é` is one character however it was pasted.

A character is refused when it is one of these:

| Refused                            | Example              | Why                                         |
| ---------------------------------- | -------------------- | ------------------------------------------- |
| a variation selector               | the U+FE0F in `❤️`    | it draws nothing, so the label is invisible |
| a zero width joiner                | the joiner in `👨‍👩` | the same                                    |
| a combining mark                   | a combining acute    | it draws on the character before it         |
| a Hangul jamo                      | `ᄀ` or `ᅡ`           | it can compose with an adjacent jamo        |
| a regional indicator               | the letters in `🇩🇪`  | two indicators draw as one flag             |
| an emoji modifier                  | the tone in `👍🏽`   | it joins the emoji before it                |
| a control or format character      | a soft hyphen        | it has no shape                             |
| white space                        | a no-break space     | the label looks empty                       |
| half of a surrogate pair           | a cut emoji          | it is half of a character                   |
| a character that a case fold grows | `ß`, `İ`, `ﬁ`        | the label would need two keystrokes         |
| a repeat of an earlier character   | `a` and `A`          | two links would show one label              |

A refused character is dropped, and the rest of your set stays in use. A joined
symbol that uses a join control refuses the complete set. Thus, a family emoji
selects the shipped set instead of becoming separate person emoji.

The shipped set is also used when fewer than two characters remain. Issue
[#63](https://github.com/evanlouie/vimium-webkit/issues/63) tracks a report that
tells the user about this repair once per session.

The script cannot read the fonts that CoreText selects. A code point with no
installed font can still show the LastResort glyph.

One consequence: a Turkish user cannot use the whole Turkish alphabet for hints.
`İ` grows to two characters in the fold, and `ı` has the fold of `i`. The case
fold is the invariant one, and not the one of your locale, so one setting gives
the same labels on every machine.

### Omnibar-lite

`o` opens a completion overlay. It is deliberately **not** a ⌘L clone, because
the two APIs that would make it one do not exist for a userscript:

| Source             | Availability                                                  |
| ------------------ | ------------------------------------------------------------- |
| Commands (`:`)     | ✅ Full parity, including greyed-out Tier C entries           |
| Search engines     | ✅ Vimium-compatible `keyword: url %s Description` config     |
| Search suggestions | ⚠️ **Opt-in, off by default** — see below                      |
| Local history      | ⚠️ **Opt-in, off by default** — see below                      |
| Browser history    | ❌ No `chrome.history`                                        |
| Bookmarks          | ❌ No `chrome.bookmarks`                                      |
| Open tabs          | ⚠️ Only tabs _we_ opened, labelled "Recent" rather than "Tabs" |

> [!WARNING]
> **Privacy.** Two things in the omnibar are off by default, and both stay off
> until you say otherwise.
>
> **Search suggestions** send what you type to your configured search engine as
> you type it, with your cookies, over `GM_xmlhttpRequest`. That is the same
> request the engine's own search box makes, but you did not open the engine's
> search box — so it is a decision, not a default. Only queries classified as
> searches are sent; a URL you type is navigated to, never searched for. The
> script can reach exactly five hosts (`@connect` names them individually), and
> nothing is sent at all unless **Ask the search engine for omnibar
> completions** is enabled in Settings.
>
> **The local history index** records the pages you visit into
> userscript-manager storage, which the manager's own UI can read. It honours a
> per-origin denylist, skips private browsing where detectable, is capped with
> LRU eviction, can be wiped with `:clear-history`, and never leaves your
> device.

---

## Development

```
npm run check      # type-check src/ and build/ + test/ as separate projects
npm run test       # unit tests
npm run test:e2e   # Playwright, against WebKit + Chromium + Firefox
npm run coverage   # line coverage over every file in src/, not just the loaded ones
npm run lint
npm run build      # dist/vimium-webkit.user.js + invariant checks
npm run verify     # everything above except coverage
```

`npm run test:e2e:install` fetches the browser binaries the first time.

`npm run coverage` reports over **all** of `src/`, because `coverage.include`
names the whole directory rather than only the files a run happened to load — so
an untested file appears in the denominator instead of vanishing from the
report. Note that `test/unit/module-graph_test.ts` imports every module, so a
file reached only by that test is counted for its import-time statements; the
headline is a little kinder than the tested-behaviour figure.

Unit tests use `@effect/vitest` and provide a stub layer instead of patching a
global. There is no `globalThis` patching in the unit suite.

### Build invariants

`npm run build` fails the build on any of these, because each one is a way the
project could quietly stop working on WebKit:

1. No `eval`, `new Function`, `document.write`, or inline event-handler strings
   — all of them are blocked by a page CSP.
2. No `<style>` elements outside the documented Safari <16.4 fallback. Safari
   applies the **page's** `style-src` to nodes a content script injects; only
   CSSOM (`adoptedStyleSheets`) escapes it.
3. Bundle ≤ 1.5 MB unminified (Greasy Fork's ceiling is 2 MB, measured
   unminified).
4. `@version` matches `package.json`.
5. Every `GM_*` / `GM.*` reference goes through `src/platform/Gm.ts`.
6. Every command carries a tier, and every Tier C command carries a user-facing
   explanation.
7. Every read of `navigator` or `unsafeWindow` goes through `Dom.probe`. A page,
   an extension, or a sandboxing manager can replace a global with an accessor
   that _throws_, and neither a `typeof` guard nor `?.` survives that — both
   perform the read.
8. Nothing that a `keydown` listener reaches may suspend. `preventDefault()`
   works only during synchronous dispatch, and a fiber yield becomes a macrotask
   on Safari.
9. No HTML sinks. Link text, page titles and search suggestions are all
   page-supplied and all end up inside our own overlay.
10. Every Tier A and Tier B command has a body somewhere in `src/`. The
    catalogue is pure data and the bodies live in feature layers, so a command
    can otherwise be carried over with nothing to run it, and answer
    "unavailable" to the user.

### Releasing

Releases are cut by CI, from a tag. The install link above resolves to
`/releases/latest/download/`, so until a tag exists it 404s.

1. Bump `version` in `package.json` and commit it.
2. Tag it `v<version>` and push the tag.

Pushing the tag runs the full pipeline — static checks, unit tests, build
invariants, and Playwright against all three engines — and only then attaches
`vimium-webkit.user.js` and `vimium-webkit.meta.js` to a GitHub release.

The tag must match `package.json`; CI refuses the release otherwise. The
mismatch is worth failing over because it is invisible when it happens: managers
decide whether to update by fetching `@updateURL` and comparing `@version` to
the one they already have. A release tagged `v0.2.0` carrying `@version 0.1.0`
reports no newer version, so every existing install silently stays where it is.

### Architecture

The whole extension is one [Effect](https://effect.website) application: every
capability is a service, every service is provided by a layer, every failure is
a typed value, and there is no `Promise` and no `any` in `src/`.
[`ARCHITECTURE.md`](./ARCHITECTURE.md) is the reference; it is short, and you
should read it before you add a file.

```
src/
  main.ts     Claim the realm, wait to be wanted, build the application
  App.ts      The one layer graph, and the runtime for one frame
  domain/     Pure data and schemas. No services, no DOM
  platform/   The browser and the userscript manager
  core/       Settings, keys, modes, commands, exclusions
  ui/         One closed shadow root, styled through CSSOM
  frames/     The cross-frame bus and its protocol
  features/   Hints, find, visual/caret, scroller, marks, insert, omnibar,
              navigation, tab control, URL clipboard
  boot/       The injection guard, the lifecycle and the key bridge
```

Five decisions carry most of the weight:

- **The runtime owns a scope.** Every listener, observer, port, stylesheet and
  fiber is acquired inside it, so teardown is the close of that scope. Nothing
  keeps a list of things to undo.
- **The frame bus breaks every cycle.** Hints needs remote frames and a remote
  frame needs hints; exclusions needs the top frame and the top frame needs
  exclusions. Neither depends on the other: each publishes on the bus and
  subscribes to what it can answer, so the layer graph stays a tree.
- **Features register commands; nothing imports a feature.** The catalogue is
  pure data, the bodies live in a registry, and the key handler reads the
  registry.

- **Content world, not page world.** quoid's GM API only exists there, and the
  choice does not affect keyboard interception at all.
- **One closed shadow root, styled with `adoptedStyleSheets`.** This solves page
  CSP, page CSS bleed, and detectability in a single move — and it is the reason
  the overlay survives on strict-CSP sites where a `<style>` element would not.
- **The top frame elects itself coordinator.** There is no background page to
  broker cross-frame link hints, so frames hand it a transferred `MessagePort`.
  Page code sees that transfer, so every message on the port is sealed with a
  key that both frames derive from a manager-private credential.
- **The keyboard path is synchronous.** `preventDefault()` works nowhere else. A
  key decision runs through `runSyncExit`, and a command that must wait
  continues on its own fiber afterwards.

---

## Licence

MIT. See [`LICENSE`](./LICENSE).

Behaviour is ported from [Vimium](https://github.com/philc/vimium) (MIT, © 2010
Phil Crosby, Ilya Sukhar). Each source file names the upstream file it derives
from; see [`THIRD-PARTY-NOTICES.md`](./THIRD-PARTY-NOTICES.md).
