# Security policy

Vimium-WebKit runs in **every frame of every page you visit**, holds `GM_*`
grants for storage, tabs, the clipboard and the network, and speaks a
cross-frame protocol over `postMessage`. That is a large surface, and a report
about it is welcome.

## Reporting a vulnerability

Open a
[private security advisory](https://github.com/evanlouie/vimium-webkit/security/advisories/new)
on GitHub. Please do not open a public issue for anything you believe is
exploitable.

Include the userscript manager and version, the browser and version, and a page
that reproduces it if you can — the frame protocol behaves differently on each
manager, and "which world was the script injected into" is usually the first
question.

You should get an acknowledgement within a week. There is no bounty.

## What is in scope

- Anything that lets a page read or write data belonging to a **different
  origin** on the same tab: hint descriptors, link text, input values, frame
  focus, synthetic clicks.
- Anything that lets a page read or modify the user's **settings**, exclusion
  rules, marks, or local history index.
- Anything that lets a page obtain a `GM_*` capability: opening tabs, writing
  the clipboard, making network requests.
- Anything that makes the script **execute page-supplied text as code** — a
  `javascript:` URL reaching a navigation sink, a string reaching a CSS or HTML
  sink.
- Denial of service that a page can trigger _without user interaction_.

## What is out of scope, and why

**Page-world injection.** Tampermonkey infers the injection world from the
`@grant` list and does not honour `@inject-into`, so on some managers the script
shares a realm with the page. In that configuration the page can read anything
the script can, including the frame-protocol session nonce, and no in-script
measure changes that. The frame protocol is designed so the _content-world_ case
is sound; the page-world case is documented rather than defended.

**A page that hides its own root element.** The overlay host is a child of
`documentElement`, and CSS gives a descendant no way out of its ancestors.
`documentElement` is the only ancestor that the host has. The removal guard
keeps the host a child of it. A page that moves the host into a container of its
own therefore loses it again at once. Five rules still win:
`html { opacity: 0 }`, `html { transform: scale(0) }`,
`html { filter: opacity(0) }`, `html { content-visibility: hidden }` and
`html { display: none }`. No measure inside the script changes that. Three facts
bound the risk:

- The page hides itself as well. Each one of those five rules paints the page
  itself as nothing, so the user sees a blank page and not a hidden interface
  that takes the keyboard.
- We could only answer with a rule on the page itself, and a userscript that
  wrote `html { opacity: 1 !important }` would break every page that animates
  its root element.
- The top layer is not an answer either. `showModal` makes the page inert, which
  the overlay must never do, and a `popover` is still skipped inside an ancestor
  with `content-visibility: hidden`.

What the script does defend is the host itself: every inline declaration on the
host carries the important priority, the guard in `src/ui/Ui.ts` compares each
of those declarations and writes them again when the page changed one, and a
mutation observer puts the host back under `documentElement` after a removal or
a move. A page that names `vimium-webkit-overlay` in a selector, removes the
element, or moves it into a container of its own, does not win.

**Detectability.** The overlay is an element in the page's own DOM and the
script installs `keydown` listeners on `window`. A page can tell it is there.
This is not treated as a vulnerability.

**A page interfering with its own frames.** A page-controlled `srcdoc` or
same-origin iframe is legitimately part of the frames tree and legitimately runs
the script. It can join the frame protocol, and it can already do everything to
itself that it could do through us. What it must _not_ be able to do is reach a
**cross-origin** frame — that is in scope.

**Storage tampering by the user.** Every userscript manager exposes its value
store for editing. Stored data is validated on read and on write, and a
hand-edited value should degrade rather than escalate; a report that it
escalates _is_ in scope, but "I edited my own marks and my own settings changed"
is not.

## Design notes a reporter may find useful

- `src/frames/protocol.ts` documents the trust model in full: admission is
  challenge-response, the port is transferred to a known origin, and
  authorization precedes validation so an unauthorized sender cannot make the
  top frame parse a payload.
- No settings ever cross a frame boundary. Only the exclusion decision does, and
  it is two booleans' worth of information.
- `build/invariants.ts` enforces the disciplines that are easy to regress: no
  dynamic code evaluation, no HTML sinks, no `<style>` elements, all manager
  access through the capability shim.
