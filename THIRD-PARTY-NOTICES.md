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
courteous. Each file below names the upstream file that it derives from in its
header comment.

Ported designs:

| Vimium source                                           | Vimium-WebKit                                                                                                                                                                                               |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lib/handler_stack.js`                                  | `src/core/HandlerStack.ts`, `src/core/Modes.ts`                                                                                                                                                             |
| `lib/keyboard_utils.js`                                 | `src/domain/Key.ts`                                                                                                                                                                                         |
| `lib/dom_utils.js`                                      | `src/features/hints/Detect.ts`                                                                                                                                                                              |
| `lib/utils.js`                                          | `src/domain/FindQuery.ts`                                                                                                                                                                                   |
| `content_scripts/mode.js`                               | `src/core/Modes.ts`                                                                                                                                                                                         |
| `content_scripts/mode_key_handler.js`, `mode_normal.js` | `src/core/Keyboard.ts`                                                                                                                                                                                      |
| `content_scripts/link_hints.js`                         | `src/features/hints/Hints.ts`, `src/features/hints/Detect.ts`, `src/domain/HintSession.ts`, `src/domain/HintRound.ts`, `src/domain/HintString.ts`, `src/domain/HintFilter.ts`, `src/domain/FrameMessage.ts` |
| `content_scripts/scroller.js`                           | `src/features/Scroller.ts`                                                                                                                                                                                  |
| `content_scripts/mode_find.js`                          | `src/features/find/Find.ts`, `src/domain/FindQuery.ts`                                                                                                                                                      |
| `content_scripts/mode_post_find.js`                     | `src/features/find/Find.ts`                                                                                                                                                                                 |
| `content_scripts/mode_visual.js`                        | `src/features/visual/Visual.ts`, `src/features/visual/Movement.ts`                                                                                                                                          |
| `content_scripts/marks.js`                              | `src/features/Marks.ts`                                                                                                                                                                                     |
| `content_scripts/mode_insert.js`                        | `src/features/Insert.ts`                                                                                                                                                                                    |
| `content_scripts/vimium_frontend.js`                    | `src/domain/FrameMessage.ts`                                                                                                                                                                                |
| `background_scripts/main.js`                            | `src/domain/FrameMessage.ts`                                                                                                                                                                                |
| `background_scripts/exclusions.js`                      | `src/domain/Exclusion.ts`                                                                                                                                                                                   |
| `background_scripts/completion.js`                      | `src/domain/Score.ts`                                                                                                                                                                                       |

> [!NOTE]
> Vimium's `lib/keyboard_utils.js` credits the
> [`vim-like-key-notation`](https://github.com/lydell/vim-like-key-notation)
> project for its key-notation scheme. `src/domain/Key.ts` implements the same
> notation. Vimium's `tests/vendor/` directory (which vendors `shoulda.js`)
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
`Scope` own the lifetime of everything the extension acquires.

---

## Build-time only (not bundled)

- [Vite](https://github.com/vitejs/vite) — MIT © 2019 Evan You & Vite
  contributors
- [esbuild](https://github.com/evanw/esbuild) — MIT © 2020 Evan Wallace
- [TypeScript](https://github.com/microsoft/TypeScript) — Apache-2.0
- [Vitest](https://github.com/vitest-dev/vitest) — MIT
- [Oxlint and Oxfmt](https://github.com/oxc-project/oxc) — MIT
- [Effect TypeScript-Go](https://github.com/Effect-TS/tsgo) — MIT
