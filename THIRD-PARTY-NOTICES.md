# Third-party notices

Vimium-WebKit is an independent reimplementation. It bundles no third-party
source at build time other than the npm dependencies listed below, but a
substantial amount of its _behaviour_ is ported from Vimium, and that carries
obligations.

---

## Vimium

<https://github.com/philc/vimium>

Vimium-WebKit ports algorithms and behaviour from Vimium. No Vimium source is
copied verbatim — the implementation is original TypeScript — but the designs
below are derived closely enough that attribution is required, not merely
courteous. Each source file names the upstream file it derives from in a comment
at the top.

Ported designs:

| Vimium source                         | Vimium-WebKit                                   |
| ------------------------------------- | ----------------------------------------------- |
| `lib/handler_stack.js`                | `src/core/handler-stack.ts`                     |
| `lib/keyboard_utils.js`               | `src/core/key-notation.ts`                      |
| `content_scripts/mode.js`             | `src/core/mode.ts`                              |
| `content_scripts/mode_key_handler.js` | `src/core/key-handler.ts`                       |
| `background_scripts/exclusions.js`    | `src/core/exclusions.ts`                        |
| `content_scripts/link_hints.js`       | `src/features/hints/`                           |
| `content_scripts/scroller.js`         | `src/features/scroller.ts`                      |
| `content_scripts/mode_find.js`        | `src/features/find/`                            |
| `content_scripts/mode_visual.js`      | `src/features/visual/`                          |
| `content_scripts/marks.js`            | `src/features/marks.ts`                         |
| `content_scripts/mode_insert.js`      | `src/features/insert.ts`                        |
| `content_scripts/vimium_frontend.js`  | `src/frames/index.ts`, `protocol.ts`            |
| `background_scripts/main.js`          | `src/frames/coordinator.ts`, `registry.ts`      |
| `background_scripts/completion.js`    | `src/features/omnibar/scoring.ts`, `engines.ts` |

> [!NOTE]
> Vimium's `lib/keyboard_utils.js` credits the
> [`vim-like-key-notation`](https://github.com/lydell/vim-like-key-notation)
> project for its key-notation scheme. `src/core/key-notation.ts` implements the
> same notation. Vimium's `tests/vendor/` directory (which vendors `shoulda.js`)
> is **not** used here; no test code was ported.

```
The MIT License (MIT)

Copyright (c) 2010 Phil Crosby, Ilya Sukhar

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

---

## Bundled runtime dependencies

Bundled into the shipping userscript.

### Effect

<https://github.com/Effect-TS/effect> — MIT © 2023 Effectful Technologies Inc

The application framework. `Effect` carries every fallible operation, `Schema`
validates the settings and the cross-frame message protocol, and `Layer` and
`ManagedRuntime` own the lifetime of everything the extension acquires.

---

## Build-time only (not bundled)

- [Vite](https://github.com/vitejs/vite) — MIT © 2019 Evan You & Vite
  contributors
- [Rollup](https://github.com/rollup/rollup) — MIT © 2017 these people
- [esbuild](https://github.com/evanw/esbuild) — MIT © 2020 Evan Wallace
- [TypeScript](https://github.com/microsoft/TypeScript) — Apache-2.0
- [Vitest](https://github.com/vitest-dev/vitest) — MIT
- [ESLint](https://github.com/eslint/eslint) — MIT
- [dprint](https://github.com/dprint/dprint) — MIT
- [Playwright](https://github.com/microsoft/playwright) — Apache-2.0
