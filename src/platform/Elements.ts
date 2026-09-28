/**
 * Shared, stateless DOM questions.
 *
 * Every function here takes the nodes that it needs and gives an answer. None
 * of them holds state, and none of them reads an ambient global, so a feature
 * can use them from inside an `Effect.sync` on the key path.
 */

import { Array, Option, flow, pipe } from "effect";

/** The element that has focus inside `active`, through every nested shadow root. */
const innermostActive = (active: Element): Element =>
  pipe(
    active.shadowRoot,
    Option.fromNullishOr,
    Option.flatMapNullishOr((shadow) => shadow.activeElement),
    Option.match({ onNone: () => active, onSome: innermostActive }),
  );

/** The deeply focused element, when anything has focus. */
const deepActive = (root: Document): Option.Option<Element> =>
  pipe(root.activeElement, Option.fromNullishOr, Option.map(innermostActive));

/**
 * The element that truly has focus, through every shadow root.
 *
 * `document.activeElement` stops at the host of a shadow tree. A page that puts
 * its search box inside a web component therefore looks unfocused.
 */
export const deepActiveElement: (root: Document) => Element | null = flow(
  deepActive,
  Option.getOrNull,
);

const MEDIA_SELECTOR = "video, audio";

const hasMedia = (root: ParentNode): boolean => root.querySelector(MEDIA_SELECTOR) !== null;

/** Media below the element, in its light tree or in its open shadow root. */
const containsMedia = (element: Element): boolean =>
  hasMedia(element) || pipe(element.shadowRoot, Option.fromNullishOr, Option.exists(hasMedia));

const isHtmlElement = (value: unknown): value is HTMLElement => value instanceof HTMLElement;

/**
 * Does a media player have focus?
 *
 * A player shell is the usual case, and not the media element itself. YouTube
 * focuses `#movie_player`, which is a `tabindex="-1"` element around the
 * `<video>`, and sends its own shortcuts from there.
 */
export const mediaPlayerHasFocus = (root: Document): boolean =>
  pipe(
    root,
    deepActive,
    Option.filter(isHtmlElement),
    // `<body>` is the absence of focus, and not a player, even on a page that
    // has a video somewhere below it.
    Option.filter((active) => active !== root.body && active !== root.documentElement),
    Option.exists((active) => active instanceof HTMLMediaElement || containsMedia(active)),
  );

/** The form fields, which read the keys that the user types. */
const FIELD_TAGS: ReadonlyArray<string> = ["INPUT", "TEXTAREA", "SELECT"];

/** Can the user type into this element? */
export const isEditable = (target: EventTarget | null): boolean =>
  target instanceof Element &&
  (pipe(FIELD_TAGS, Array.contains(target.tagName)) ||
    (target instanceof HTMLElement && target.isContentEditable));
