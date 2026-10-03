/**
 * URLs as values.
 *
 * `new URL` throws on text that is not a URL. A URL from the page, from
 * storage or from the user is untrusted text, so the parse gives an `Option`
 * instead.
 */

import { Option } from "effect";

/** The URL that the text names, or nothing when it names none. */
export const parseUrl: (href: string) => Option.Option<URL> = Option.liftThrowable(
  (href: string) => new URL(href),
);
