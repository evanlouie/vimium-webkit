# Privacy

What Vimium-WebKit stores, what it sends, and what it does neither of.

Nothing here is a promise about the _browser_ or about your userscript manager;
it is an account of what this script does.

## What leaves your device

**By default: nothing.** Not your keystrokes, not the pages you visit, not the
text on them, not any identifier. There is no telemetry, no error reporting, no
update ping beyond the one your userscript manager makes on its own.

There is exactly one feature that makes a network request, and it is off until
you turn it on:

| Feature                | Default | What is sent                                              | To whom                                                                |
| ---------------------- | ------- | --------------------------------------------------------- | ---------------------------------------------------------------------- |
| **Search suggestions** | **Off** | The text you type in the omnibar, when it is a web search | Your configured search engine's suggestion endpoint, with your cookies |

Details, because "a search engine" is doing a lot of work in that sentence:

- It fires only for queries classified as **searches**. A URL you type is
  navigated to, never searched for — so an internal hostname, a staging box, or
  a one-time link pasted from an email does not become a search query.
- The script can reach exactly five hosts. They are named individually in the
  `@connect` metadata, derived from the endpoint table in
  `src/features/omnibar/suggest.ts`, and your manager enforces the list:
  `suggestqueries.google.com`, `duckduckgo.com`, `api.bing.com`,
  `en.wikipedia.org`.
- Responses are cached in memory for two hours and never persisted.
- Turn it on in **Settings → Ask the search engine for omnibar completions**.

## What is stored on your device

All of it goes to your userscript manager's value store, under keys prefixed
`vimium-webkit:`. Your manager's own UI can read and edit it, and so can you.

| Group          | Contents                                                     | Default          |
| -------------- | ------------------------------------------------------------ | ---------------- |
| `settings`     | Your configuration: key mappings, search engines, exclusions | Shipped defaults |
| `marks`        | Scroll positions you saved with `m`, keyed by URL            | Empty            |
| `find-history` | Your recent find queries, capped at 50                       | Empty            |
| `history`      | A local frecency index of pages you visit                    | **Off**          |
| `session`      | Tabs this script opened, per-origin zoom, dismissed warnings | Empty            |

### The local history index

Off by default, and it should stay off unless you want it. When enabled it
records the pages you visit so the omnibar can rank them. It:

- honours a per-origin denylist you control;
- skips private browsing where that is detectable;
- skips pages carrying `<meta name="robots" content="noindex">`;
- keeps only `http:`/`https:` pages;
- **strips the query string** except for a short allowlist of keys that identify
  a page rather than a session (`id`, `page`, `q`, `v`, and similar), so tokens,
  signatures and one-time links are not persisted;
- drops the fragment and any embedded credentials;
- is capped with LRU eviction at `historyIndexLimit` entries;
- can be erased at any time with `:clear-history`;
- **never leaves your device**. The suggestion feature above does not consult
  it.

### If your manager has no storage

Some managers expose no value store. The script then keeps your settings, your
marks and your history in memory only, and says so in the settings dialog and in
a one-time warning. They last until the page closes.

The cross-frame session is off as well. The credential that admits a frame lives
in the value store of the manager and nowhere else, so with no such store the
frames of a page cannot form a session. Link hints across frames and frame focus
stop working, and a frame inside the page does not learn that you excluded the
page.

The script does **not** fall back to `localStorage`. The page owns that store,
so your settings, your marks, your history — and the credential that admits a
frame to the cross-frame session — would be readable and writable by every
script on the site.

## What crosses a frame boundary

The script runs in every frame and coordinates them so that a hint in an iframe
can be typed from the top of the page. Over that channel travel: frame
identifiers, hint labels, hint indices, and the enabled/disabled verdict for the
page.

Every message on that channel is encrypted and authenticated. The two frames
derive the key from a credential that only the value store of your userscript
manager holds, so a page that takes a copy of the channel reads nothing and can
send nothing. Where the manager gives no value store there is no credential, and
the channel does not exist at all: see "If your manager has no storage" above.

Your settings do **not**. Neither do the contents of text fields: a hint's label
is derived from an element's text, its `aria-label`, its `<label>`, or its
`placeholder` — never from its `value`.

## Clipboard

`yy`, `yf` and friends write the clipboard, and `p` reads it, only in response
to a key you pressed. A request arriving from another frame is refused.

## Questions

Anything that looks like an inaccuracy in this document is a bug; please report
it. Anything that looks like a way to defeat it is a security issue — see
[SECURITY.md](./SECURITY.md).
