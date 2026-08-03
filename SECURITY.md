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

**A page that writes a rule on the root element.** The overlay host is a child
of `documentElement`, and CSS gives a descendant no way out of its ancestors.
The removal guard keeps the host a child of `documentElement`, so `html` is the
only ancestor that it has. There are exactly two classes of such rule, and the
class decides both the result and the answer.

_Class 1: a rule that makes `html` the containing block of a fixed descendant._
The overlay then holds a place in the document instead of the viewport, so it
scrolls away with the page. **The page itself stays fully readable**, which
makes this the dangerous class. Example: `html { will-change: transform }`. The
property is not the definition; the effect is. Every property that gives an
element a transform, a containment, a filter or a perspective belongs to this
class — `transform`, `translate`, `rotate`, `scale`, `will-change`, `contain`,
`container-type`, `perspective`, `filter` and `backdrop-filter` — and so does
any future property with the same effect. `will-change: transform` and
`transform: translateZ(0)` are also normal performance code, so this is not only
an attack.

The script answers this class with a measurement, and not with a list of
properties. `alignHost` in `src/ui/Ui.ts` reads the box of the host, compares it
with the viewport, and adds the difference to the transform that the host
already carries. It repeats that after each scroll, because a host under such an
ancestor moves with the document. A measurement in WebKit shows the result, with
the page scrolled to 2759 px: `will-change: transform`,
`transform: translateZ(0)`, `contain: paint` and `perspective: 1px` each put the
dialog box at -2711, and the correction puts it back at 48, which is where it
sits with no rule at all.

_Class 2: a rule that makes `html` paint nothing._ The overlay disappears, and
the page disappears with it, so the user sees a blank page and not a hidden
interface. Example: `html { opacity: 0 }`. `display: none`,
`visibility: hidden`, `content-visibility: hidden`, `filter: opacity(0)` and
`transform: scale(0)` belong here as well. No measure inside the script answers
this class:

- We could only answer with a rule of our own on `html`, and a userscript that
  wrote `html { opacity: 1 !important }` would break every page that animates
  its root element.
- The top layer is not an answer either. `showModal` makes the page inert, which
  the overlay must never do, and a `popover` is still skipped inside an ancestor
  with `content-visibility: hidden`.

**The invariant that holds for both classes.** The overlay never holds the
keyboard while the user cannot see it. `ui.visibilityFault` repairs the style,
the place and the offset, and then measures what is left. A fault closes the
dialog, which gives every key back to the page, and the reason goes to the
console of the browser. The HUD cannot carry that message, because the HUD is
inside the overlay that the fault hides.

Both dialogs ask that question today, because a dialog is the mode that holds
every key for a long time. Link hints, the find prompt and the omnibar do not
ask yet. Each one holds the keyboard as well, so each one must make the same
call, and that is the next change.

What the script does defend is the host itself: every inline declaration on the
host carries the important priority, the guard in `src/ui/Ui.ts` compares each
of those declarations and writes them again when the page changed one, and a
mutation observer puts the host back under `documentElement` after a removal or
a move.

That repair has a budget of 32 writes for each quiet second, because a page that
removes the host inside its own mutation observer would otherwise fight us in a
loop of microtasks, and that loop would starve the page. The loop needs our
write, so the guard stops writing when the budget is gone. It does **not** stop
watching, and it does not stay silent: it says in the console that the overlay
is not visible, the overlay gives the keyboard back, and one quiet second gives
back both the count and the repair. A page that spends more than the budget
therefore keeps the host until it stops, and it never keeps a user who cannot
leave.

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
