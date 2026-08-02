# DOM integration tests

Playwright specs that drive the **shipped bundle**
(`dist/vimium-webkit.user.js`) against hand-built fixture pages, in WebKit,
Chromium, and Firefox.

```sh
npm run test:e2e:install       # once: download the three browser builds
npm run test:e2e               # run everything
npm run test:e2e -- --project=webkit --headed
npm run serve:fixtures         # just the fixture server, for poking by hand
npm run check                  # type-check the config and the specs
```

Current status: **216 passing** across the three projects, and no `test.fail()`
annotations. There is no list of known-broken behaviour here: a spec either
asserts what the product does or it is deleted.

The default configuration is the **shipped** `defaultSettings()`, read from the
build output rather than copied. Specs that need determinism opt into
`DETERMINISTIC` (instant scrolling, filter-mode hints) explicitly, one describe
block at a time, and say so. Forcing those two settings on every spec is how the
default hint pipeline and the default scroll path ended up with no coverage at
all while the suite was green.

The suite runs on Node: the fixture server, the bundle build and the harness all
use Node APIs, and Playwright's runner drives them directly. `npm run test:e2e`
is a thin wrapper around `npx playwright test`; either works.

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

## What this suite is allowed to assert

Every spec asserts on a **side effect** — the page navigated, an element took
focus, the document scrolled, nothing happened at all — rather than on what the
overlay drew. Waiting for markers to exist is the readiness signal, not the
assertion.

The two harness helpers that read the overlay do so to _discover_ which label
sits on which element, never to check that it is there:

- `vw.activateHint(linkText)` types the link text in filter mode, and in
  alphabet mode finds the marker painted on that element and types its label.
- `vw.expectNoHint(linkText)` is the negative form, and is mode-aware for the
  same reason.

Both go through the `attachShadow` capture described below.

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
Specs use `vw.boot()`, which dispatches the structured wake message a top frame
posts to its subframes, then waits for `<vimium-webkit-overlay>` to appear in
the light DOM. Stage 0 honours a wake only from an ancestor, so `bootAllFrames`
wakes subframes the way production does — the top frame posts into the frames
tree — rather than synthesising an event inside each one. Firefox refuses a
cross-origin `WindowProxy` as a `MessageEvent` source, which is what that
synthetic path used to rely on.

### Determinism

The baseline is the shipped `defaultSettings()`, read from
`dist/default-settings.json` — emitted by the same build that produces the
bundle, so it cannot drift from the code under test. It cannot be _imported_:
this module runs under Playwright's own loader, which resolves neither the `~/`
alias nor the bundler's aliases.

`DETERMINISTIC` in `harness/settings-seed.ts` is an opt-in patch, applied per
describe block by the specs that need it:

- `smoothScroll: false`, because the scroll animator calibrates against measured
  frame throughput and an assertion on an exact offset mid-animation is a flake
  generator. The default (animated) path has its own coverage in
  `smooth-scroll.spec.ts`, which asserts on where the scroll _settles_.
- `filterLinkHints: true`, so a spec matches a hint by the link's own text.

Whatever a spec proves under those, it proves about a configuration no user has,
which is why they are opt-in and why every spec that uses them says so.

---

## The fixtures

`test/fixtures/`, mirroring upstream Vimium's `test_harnesses/`:

| File                       | Exercises                                                                                                                          |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `nested-frames.html`       | Two levels of same-origin iframes; globally-ordered hint assignment                                                                |
| `cross-origin-frames.html` | A frame on a second port (a different origin); `MessageChannel` handshake                                                          |
| `srcdoc-frames.html`       | `srcdoc` and `about:blank` frames; graceful degradation                                                                            |
| `image-maps.html`          | `<img usemap>` with `rect` and `circle` `<area>`s                                                                                  |
| `shadow-dom.html`          | Open root, closed root, and slotted light-DOM content                                                                              |
| `content-visibility.html`  | `content-visibility: auto` (rendered and skipped) and `hidden` subtrees                                                            |
| `overlays.html`            | A fixed bar occluding a link, a sticky footer, a clickable custom element, and three ways to be invisible while still having a box |
| `autofocus.html`           | An `<input autofocus>`, as DuckDuckGo and most login pages have                                                                    |
| `strict-csp.html`          | Served with `default-src 'self'; style-src 'self'` — verification item **V1**                                                      |
| `spa.html`                 | `history.pushState` plus wholesale DOM replacement                                                                                 |
| `scrollables.html`         | Nested scroll containers and one that reports `scrollHeight > clientHeight` and does not scroll                                    |
| `media.html`               | A focusable player shell wrapping a `<video>`, as every watch page has                                                             |
| `long-text.html`           | Matches split across element boundaries, for the find engine                                                                       |
| `link-dense.html`          | 2400 links, for the hint-generation budget                                                                                         |

The server (`harness/server.ts`) binds two ports so cross-origin frames have a
second origin, substitutes `%SECONDARY_ORIGIN%` into `.html` responses so the
port number lives in one place, and adds the CSP response header for
`strict-csp.html`. Both ports come from the ephemeral range per run
(`harness/ports.ts`) and `/__ready` answers with a token `globalSetup` checks:
with fixed ports and `reuseExistingServer`, any process listening on 8787 was
silently adopted and the whole suite ran against it. A `<meta http-equiv>` would
not do: the policy has to be in force before the first byte of the document is
parsed, which is when a `document-start` script installs its overlay.

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
