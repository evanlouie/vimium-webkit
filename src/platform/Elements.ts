/**
 * Shared, stateless DOM questions.
 *
 * Every function here takes the nodes that it needs and gives an answer. None
 * of them holds state, and none of them reads an ambient global, so a feature
 * can use them from inside an `Effect.sync` on the key path.
 */

/**
 * The element that truly has focus, through every shadow root.
 *
 * `document.activeElement` stops at the host of a shadow tree. A page that puts
 * its search box inside a web component therefore looks unfocused.
 */
export const deepActiveElement = (root: Document): Element | null => {
  let active: Element | null = root.activeElement;
  while (active !== null) {
    const shadow = active.shadowRoot;
    const inner = shadow?.activeElement ?? null;
    if (inner === null) return active;
    active = inner;
  }
  return active;
};

const MEDIA_SELECTOR = "video, audio";

const containsMedia = (element: Element): boolean => {
  if (element.querySelector(MEDIA_SELECTOR) !== null) return true;
  const shadow = element.shadowRoot;
  return shadow !== null && shadow.querySelector(MEDIA_SELECTOR) !== null;
};

/**
 * Does a media player have focus?
 *
 * A player shell is the usual case, and not the media element itself. YouTube
 * focuses `#movie_player`, which is a `tabindex="-1"` element around the
 * `<video>`, and sends its own shortcuts from there.
 */
export const mediaPlayerHasFocus = (root: Document): boolean => {
  const active = deepActiveElement(root);
  if (!(active instanceof HTMLElement)) return false;
  // `<body>` is the absence of focus, and not a player, even on a page that
  // has a video somewhere below it.
  if (active === root.body || active === root.documentElement) return false;
  if (active instanceof HTMLMediaElement) return true;
  return containsMedia(active);
};

/** Can the user type into this element? */
export const isEditable = (target: EventTarget | null): boolean => {
  if (!(target instanceof Element)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return target instanceof HTMLElement && target.isContentEditable;
};
