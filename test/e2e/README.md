# DOM integration tests

Playwright specs that drive the **shipped bundle**
(`dist/vimium-webkit.user.js`) against hand-built fixture pages, in WebKit,
Chromium, and Firefox.

```sh
deno task test:e2e:install      # once: download the three browser builds
deno task test:e2e              # run everything
deno task test:e2e -- --project=webkit --headed
deno task serve:fixtures        # just the fixture server, for poking by hand
deno task check:e2e             # type-check the config and the specs
```

Current status: **156 passing** across the three projects, of which **21 are
`test.fail()`** — seven specs per engine that encode intended behaviour the
product does not yet have. See
[Open defects](#open-defects-found-by-this-suite).

The suite is Deno-hosted — the fixture server, the bundle build, and the harness
all use `Deno.*` — and Playwright's runner is invoked from inside that Deno
process. Running `npx playwright test` directly will fail with a clear message.

---

## ⚠️ Playwright's WebKit build is not Safari

This is the single most important thing to know before reading a green run as
evidence of anything.

Playwright's `webkit` is a build of WebKit driven by Playwright's own embedder.
It shares the rendering and JavaScript engines with Safari, and that is where
the resemblance stops. It has:

- **no Intelligent Tracking Prevention**, so nothing about the seven-day
  `localStorage` eviction rule ([§7.4](../../IMPLEMENTATION_PLAN.md)) can be
  observed here;
- **no reserved-shortcut list** — ⌘T, ⌘W, ⌃Tab and friends are delivered to the
  page in Playwright's build and swallowed by Safari's chrome, so a binding that
  works here may be dead on arrival on a real Mac
  ([§7.3](../../IMPLEMENTATION_PLAN.md));
- **no extension host** and therefore no userscript manager at all: injection
  timing, `@run-at document-start` reliability, the `GM.*` surface, and every
  per-manager difference are _simulated_ by `harness/page-harness.ts`, not
  exercised ([§7.1](../../IMPLEMENTATION_PLAN.md));
- **no Safari-specific page blocklist**, PDF viewer, or Reader mode
  ([§7.11](../../IMPLEMENTATION_PLAN.md)).

It catches web-platform regressions, which is a great deal. It cannot tell you
whether the product works on Safari. **Those answers require real devices**:
macOS Safari and iOS Safari, with each manager installed.

---

## What this suite can and cannot answer

The verification checklist is
[§12 of the implementation plan](../../IMPLEMENTATION_PLAN.md). Every item there
is load-bearing and, until Phase 0 is done on real hardware, unverified.

### Answered here (for these engines)

| Item    | Question                                                                                  | Spec                                   | Caveat                                                                                                                                                                                                                                                                                                                                                                 |
| ------- | ----------------------------------------------------------------------------------------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **V1**  | Does a constructed `CSSStyleSheet` adopted into a shadow root survive a page `style-src`? | `csp.spec.ts`                          | **Yes**, on all three engines: the help dialog and the hint markers are laid out and coloured from the adopted sheet under `default-src 'self'; style-src 'self'`, and nothing blocks a stylesheet. **Not** answered for Safari, and not for GitHub or Google, whose policies are more elaborate than the fixture's. See defect 3 for the one thing that _is_ blocked. |
| **V10** | Does `MessagePort` transfer over cross-origin `postMessage` work?                         | `frames.spec.ts` (cross-origin frames) | **Yes** on all three engines. Says nothing about Safari's content-script world, which is where the plan's doubt actually lies.                                                                                                                                                                                                                                         |

### Partially informative

| Item    | Question                                              | What this suite shows                                                                                                                                                                                      |
| ------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **V3**  | Injection into `srcdoc` / `about:blank` frames        | `frames.spec.ts` pins the _degradation_ contract — no hang, no exception — regardless of whether injection happens. Playwright injects into these frames; Tampermonkey Safari may not.                     |
| **V5**  | Do synthesized modifier-clicks open tabs?             | `hints.spec.ts` asserts that new-tab hints go through `GM_openInTab` and never through a synthetic modifier-click, which is the behaviour the answer to V5 implies. It does not test the premise.          |
| **V11** | Stage 0 cost per frame                                | `perf.spec.ts` asserts a subframe at Stage 0 schedules no rAF and no interval, and that idle scheduling churn is zero. That is a proxy for CPU, not a measurement of it, and it is not measured on Safari. |
| **V12** | Does quoid's async `GM.getValue` delay the first key? | The `gmVariant: "async"` projects in `csp.spec.ts` prove the promise-only path _boots_. Latency is stubbed at zero here, so the perceptibility question is untouched.                                      |

### Not answerable here at all

| Item   | Question                                                           | Why not                                                                       |
| ------ | ------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| **V2** | Is `document-start` reliable on Safari 18+ through Tampermonkey?   | No manager, and no Safari. The harness injects synchronously by construction. |
| **V4** | Is WebKit bug 191768 (iOS `preventDefault` on key commands) fixed? | iOS only, hardware keyboard only.                                             |
| **V6** | Does `GM_openInTab({active:false})` background the tab?            | Requires a real manager and a real browser UI.                                |
| **V7** | Does injection reach Safari's PDF viewer or Reader mode?           | Neither exists in Playwright's WebKit.                                        |
| **V8** | Is there an Apple-domain injection blocklist?                      | A property of Safari's extension host.                                        |
| **V9** | Is the iOS 18 `unlimitedStorage` ~3 MB regression resolved?        | iOS only.                                                                     |

Nothing in this directory should be cited as evidence for a 🔴 item in §12
becoming 🟢. It is evidence that the _web-platform_ half of the design holds on
three engines.

---

## Open defects found by this suite

Three product bugs, all reproducible on **all three engines**. Every one is
marked `test.fail()` with the analysis inline, so fixing it turns the run red
until the annotation is removed. None of them is a test-harness artefact.

### 1. `FindPromptMode` does not own the keyboard — `src/features/find/mode.ts`

Find mode is unusable. `FindPromptMode` sets neither `suppressAllKeyboardEvents`
nor a `keydown` handler, on the stated assumption that "the HUD input has focus
and the prompt's own callbacks do the work". Stage 0 listens for `keydown` on
`globalThis` in the **capture** phase, so it sees every keystroke before the HUD
input's own capture-phase listener can `stopPropagation()`. The event reaches
`NormalMode` and runs commands: typing `hemisphere` executes `h` (scrollLeft),
`m` (create mark), `i` (insert mode) and `s` (`Vomnibar.activateSearch`), and
the omnibar taking focus blurs the prompt, which cancels it.

`InsertMode` does not cover this — it deliberately ignores our own inputs via
`hud.ownsFocus()`, so that focusing the HUD is not mistaken for the page asking
for insert mode.

`OmnibarMode` already has the right shape: `#passIfOurs()` returns
`PASS_EVENT_TO_PAGE` when `ownsFocus(event.target)` and `SUPPRESS_EVENT`
otherwise. `FindPromptMode` needs the same `handlers()` override.

Four specs in `find.spec.ts`.

### 2. Image-map areas are dropped by the occlusion pass — `src/features/hints/detect.ts`

`imageMapHints()` produces a hint per `<area>`, positioned inside the image's
rect. `isHintVisible()` then throws all of them away: it hit-tests with
`document.elementsFromPoint()`, which returns the `<img>`, and an `<area>` lives
in a detached `<map>` — so it neither contains the image nor is contained by it,
and `hitsAtPoint()` is `false` at all five sample points. Upstream Vimium does
not have this problem because it never runs the "is this on top?" test against
an image-map area.

The better fix is for `LocalHint` to carry the element the hit test should
_accept_ (the `<img>`, for an `area` hint) rather than skipping occlusion for
`kind === "area"`: an area under a fixed overlay genuinely is unreachable and
should still be dropped.

Two specs in `hints.spec.ts`.

### 3. The overlay host's `style` attribute is blocked by CSP — `src/ui/root.ts`

`ShadowUiRoot`'s constructor does `host.setAttribute("style", HOST_STYLE)`. A
`style` **attribute** is governed by `style-src-attr`, which falls back to
`style-src`; under `style-src 'self'` the declarations are discarded and a
violation is reported. CSP does not police CSSOM, so setting the same properties
through `host.style.*` makes the overlay CSP-clean.

This does **not** invalidate V1 — the adopted stylesheet applies, and the
sibling specs prove the dialog and the hint markers are correctly styled under
the policy, because every layer inside the shadow root is `position: fixed` in
its own right. What is lost on a strict-CSP site is `all: initial`, the
`z-index: 2147483647`, and the visual-viewport transform: the page-CSS-bleed and
stacking defences, on exactly the sites that need them most.

One spec in `csp.spec.ts`.

---

## How the harness works

### Injection

`harness/fixtures.ts` adds two init scripts to every page, in order:

1. `harness/page-harness.ts` — the GM stub, the recorders, and the shadow-root
   capture.
2. The contents of `dist/vimium-webkit.user.js`, verbatim.

Both run at document start, in the page's own realm, which is the closest
Playwright gets to a userscript manager. `globalSetup` rebuilds the bundle if it
is older than anything in `src/` or `build/`.

### The stubbed manager

Two variants, selected per file or per describe block with
`test.use({ gmVariant: … })`:

- `"sync"` (default) — `GM_getValue`, `GM_setValue`, `GM_deleteValue`,
  `GM_listValues`, `GM_openInTab`, `GM_setClipboard`, `GM_info`. Tampermonkey /
  Violentmonkey / ScriptCat shaped.
- `"async"` — only the promise-flavoured `GM.*` namespace, with no
  `GM_addValueChangeListener` and no `unsafeWindow`. This is quoid's
  Userscripts: the capability floor every decision in the plan has to survive.

Both are backed by one in-memory `Map`, pre-seeded from
`harness/settings-seed.ts`. `GM_openInTab` and `GM_setClipboard` record rather
than act, and the recordings are readable from a spec via `vw.snapshot()`.

> [!NOTE]
> `navigator.clipboard.writeText` is available on `http://127.0.0.1` (a
> potentially-trustworthy origin), so `platform/clipboard.ts` takes the async
> path and `GM_setClipboard` is never reached. Clipboard behaviour is therefore
> **not** covered here; it needs a real browser with a real permission prompt.

### Reading the overlay

The UI lives in a `closed` shadow root, so `page.locator()` cannot pierce it.
`harness/page-harness.ts` patches `Element.prototype.attachShadow` _before the
bundle loads_ and keeps the root that `<vimium-webkit-overlay>` creates.

This is a harness-side monkeypatch of the page's own prototype. It touches
nothing in `src/` and weakens nothing in production: a closed root is a
hardening measure against page script that runs _after_ us, and was never a
boundary against script that runs before us.

It is used sparingly, and almost always only to _discover_ something (are
markers drawn yet? what does the HUD say?). The assertions themselves are
side-effect assertions — the page navigated, the element took focus, the counter
incremented, the container scrolled, nothing happened at all. The one exception
is `csp.spec.ts`, where "the stylesheet applied" genuinely has no observable
proxy outside the root.

### Waking the extension

Stage 0 stays asleep until a key arrives or 1200 ms elapse in the top frame.
Specs use `vw.boot()`, which dispatches the same `vimium-webkit:wake` message a
top frame posts to its subframes, then waits for `<vimium-webkit-overlay>` to
appear in the light DOM.

### Determinism

`harness/settings-seed.ts` seeds settings that differ from the shipped defaults
in exactly two ways, both to remove non-determinism rather than to test
something different:

- `smoothScroll: false`, because the scroll animator calibrates against measured
  frame throughput and an assertion on an exact offset mid-animation is a flake
  generator. (`durationFor` has unit tests.)
- `filterLinkHints: true`, so a spec activates a hint by typing the link's own
  text rather than by predicting a hint string. Hint strings are an
  implementation detail with their own unit tests; link text is the user-facing
  contract.

The seed is typed as `Settings` via a type-only import, so adding a field to
`settings/schema.ts` breaks `deno check` here rather than silently producing a
seed that fails validation and falls back to defaults.

---

## The fixtures

`test/fixtures/`, mirroring upstream Vimium's `test_harnesses/`:

| File                       | Exercises                                                                                       |
| -------------------------- | ----------------------------------------------------------------------------------------------- |
| `nested-frames.html`       | Two levels of same-origin iframes; globally-ordered hint assignment                             |
| `cross-origin-frames.html` | A frame on a second port (a different origin); `MessageChannel` handshake                       |
| `srcdoc-frames.html`       | `srcdoc` and `about:blank` frames; graceful degradation                                         |
| `image-maps.html`          | `<img usemap>` with `rect` and `circle` `<area>`s                                               |
| `shadow-dom.html`          | Open root, closed root, and slotted light-DOM content                                           |
| `content-visibility.html`  | `content-visibility: auto` (rendered and skipped) and `hidden` subtrees                         |
| `overlays.html`            | A fixed bar occluding a link, a sticky footer, an input, and a button                           |
| `strict-csp.html`          | Served with `default-src 'self'; style-src 'self'` — verification item **V1**                   |
| `spa.html`                 | `history.pushState` plus wholesale DOM replacement                                              |
| `scrollables.html`         | Nested scroll containers and one that reports `scrollHeight > clientHeight` and does not scroll |
| `long-text.html`           | Matches split across element boundaries, for the find engine                                    |
| `link-dense.html`          | 2400 links, for the hint-generation budget                                                      |

The server (`harness/server.ts`) binds two ports so cross-origin frames have a
second origin, substitutes `%SECONDARY_ORIGIN%` into `.html` responses so the
port number lives in one place, and adds the CSP response header for
`strict-csp.html`. A `<meta http-equiv>` would not do: the policy has to be in
force before the first byte of the document is parsed, which is when a
`document-start` script installs its overlay.

---

## Adding a spec

```ts
import { expect, test } from "./harness/fixtures.ts";

test("does the thing", async ({ vw, page }) => {
  await vw.open("/my-fixture.html");
  await vw.startHints();
  await vw.activateHint("The link's own text");
  await expect(page).toHaveURL(/#expected$/);
});
```

Rules of thumb:

1. Assert on side effects. If a spec needs `harness/overlay.ts`, ask what the
   user would have observed instead.
2. Never assert on a hint string. They are generated, and the generator has unit
   tests.
3. If a fixture needs a response header or a second origin, it belongs in
   `harness/server.ts`, not in a `<meta>` tag.
