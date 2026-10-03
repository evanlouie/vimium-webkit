/**
 * Shared, stateless DOM questions.
 *
 * Every function here takes the nodes that it needs and gives an answer. None
 * of them holds state, and none of them reads an ambient global, so a feature
 * can use them from inside an `Effect.sync` on the key path.
 */

import { Array, Option, flow, pipe } from "effect";

// The node type, and not `instanceof`: a node can come from another realm, and
// `instanceof` is false for it there.

/** Is `node` a text node, whichever realm made it? */
export const isText = (node: Node): node is Text => node.nodeType === Node.TEXT_NODE;

/** Is `node` an element, whichever realm made it? */
export const isElement = (node: Node): node is Element => node.nodeType === Node.ELEMENT_NODE;

/** `node` when it is an element, and its parent element when it is not. */
export const elementAt = (node: Node): Option.Option<Element> =>
  pipe(
    node,
    Option.liftPredicate(isElement),
    Option.orElse(() => Option.fromNullishOr(node.parentElement)),
  );

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

export const MEDIA_SELECTOR = "video, audio";

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

const isShadowRoot = (node: Node): node is ShadowRoot => node instanceof ShadowRoot;

/** The host of the shadow root that holds `node`, when a shadow root holds it. */
export const shadowHostOf = (node: Node): Option.Option<Element> =>
  pipe(
    node.getRootNode(),
    Option.liftPredicate(isShadowRoot),
    Option.map((root) => root.host),
  );

/**
 * Does `ancestor` hold `node`, across an open shadow boundary?
 *
 * `Node.contains` stops at a shadow root, so a node inside the own open shadow
 * root of an element would look like an unrelated element that is painted on
 * top of it.
 */
export const containsDeep = (ancestor: Element, node: Node): boolean =>
  ancestor.contains(node) ||
  pipe(
    shadowHostOf(node),
    Option.exists((host) => containsDeep(ancestor, host)),
  );

/** Every shadow host above `node`, nearest first. */
export const shadowHostChain = (node: Node): ReadonlyArray<Element> =>
  pipe(
    shadowHostOf(node),
    Option.match({
      onNone: () => Array.empty<Element>(),
      onSome: (host) => pipe(shadowHostChain(host), Array.prepend(host)),
    }),
  );

/** Can the user type into this element? */
export const isEditable = (target: EventTarget | null): boolean =>
  target instanceof Element &&
  (pipe(FIELD_TAGS, Array.contains(target.tagName)) ||
    (target instanceof HTMLElement && target.isContentEditable));
