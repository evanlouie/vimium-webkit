/**
 * Which colour scheme the overlay should wear.
 *
 * `followPageColorScheme` promises to "blend the overlay with the page's own
 * colour scheme where detectable". No media query can express that — a media
 * query answers a question about the *user agent*, and a light overlay pinned
 * over a dark page is exactly what the setting exists to prevent. So the scheme
 * is resolved here and published as an attribute on the overlay host, which the
 * stylesheets key off.
 */

export type ColorScheme = "light" | "dark";

/** Luminance below this reads as a dark surface. Halfway, deliberately. */
const DARK_THRESHOLD = 0.4;

const channelToLinear = (value: number): number => {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

/**
 * Relative luminance of a computed `background-color`.
 *
 * `null` for anything not in `rgb()`/`rgba()` form — including the wide-gamut
 * `color(srgb …)` some engines now return — and for anything effectively
 * transparent, since a transparent background tells us nothing about what is
 * behind it.
 */
export const backgroundLuminance = (color: string): number | null => {
  const match = /^rgba?\(([^)]+)\)$/.exec(color.trim());
  if (match === null) return null;
  const parts = match[1]?.split(/[\s,/]+/).filter((part) => part !== "") ?? [];
  const red = Number(parts[0]);
  const green = Number(parts[1]);
  const blue = Number(parts[2]);
  if (
    !Number.isFinite(red) || !Number.isFinite(green) || !Number.isFinite(blue)
  ) {
    return null;
  }
  const alpha = parts.length > 3 ? Number(parts[3]) : 1;
  if (!Number.isFinite(alpha) || alpha < 0.5) return null;

  return 0.2126 * channelToLinear(red) +
    0.7152 * channelToLinear(green) +
    0.0722 * channelToLinear(blue);
};

/**
 * The page's own scheme, or `null` when the page has not said and its
 * background does not tell us.
 *
 * Two sources, in order of authority: the declarative `color-scheme` property,
 * and the luminance of whatever actually paints the page background. The second
 * matters because the overwhelming majority of dark-themed pages never declare
 * `color-scheme` at all.
 */
export const detectPageScheme = (doc: Document): ColorScheme | null => {
  const root = doc.documentElement;
  if (root === null) return null;

  try {
    const declared = getComputedStyle(root).colorScheme.trim();
    if (declared === "dark") return "dark";
    if (declared === "light") return "light";

    for (const element of [doc.body, root]) {
      if (element === null) continue;
      const luminance = backgroundLuminance(
        getComputedStyle(element).backgroundColor,
      );
      if (luminance === null) continue;
      return luminance < DARK_THRESHOLD ? "dark" : "light";
    }
  } catch {
    // A detached or hostile document. Fall through to "no opinion".
  }

  return null;
};
