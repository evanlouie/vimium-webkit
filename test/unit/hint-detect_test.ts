/**
 * The image-map lookup of `features/hints/Detect.ts`.
 *
 * The name in a `usemap` attribute belongs to the page. It can hold a
 * quotation mark, a backslash, a bracket or an emoji. A selector that is built
 * by joining strings then throws, and the throw used to stop the hints of the
 * whole page.
 *
 * A unit test runs in Node with no DOM, so the lookup takes the document as an
 * argument. The fake document below throws from `querySelector`: the lookup
 * must never build a selector at all.
 */

import { assert, describe, it } from "@effect/vitest";
import { Effect, Option } from "effect";
import { findImageMap, mapNameOf } from "~/features/hints/Detect.ts";

/** A `<map>` that answers `getAttribute("name")`, and nothing else. */
const mapElement = (name: string | null): Element =>
  ({
    getAttribute: (attribute: string): string | null =>
      attribute === "name" ? name : null,
  }) as unknown as Element;

/**
 * A document that holds `maps`, and that refuses every selector.
 *
 * `querySelector` throws here because a unit test has no CSS parser, and
 * because the rule under test is exactly that: the lookup takes no selector
 * from a page value. A browser throws a `SyntaxError` for several of the names
 * below, and it matches the wrong element for several more.
 */
const documentWith = (maps: readonly Element[]): Document =>
  ({
    getElementsByTagName: (tag: string): readonly Element[] =>
      tag === "map" ? maps : [],
    querySelector: (selector: string): never => {
      throw new SyntaxError(`the lookup built a selector: ${selector}`);
    },
  }) as unknown as Document;

/** Names that a page may use, and that a joined selector cannot carry. */
const AWKWARD_NAMES: ReadonlyArray<readonly [string, string]> = [
  ["a quotation mark", 'na"v'],
  ["a backslash", "na\\v"],
  ["a trailing backslash", "nav\\"],
  ["a space", "main nav"],
  ["a bracket", "nav[0]"],
  ["a brace", "nav{x}"],
  ["a colon", "nav:hover"],
  ["a comma", "nav,other"],
  ["an emoji", "🗺️nav"],
  ["a newline", "na\nv"],
  ["a digit at the start", "0nav"],
];

describe("the image-map lookup", () => {
  for (const [label, name] of AWKWARD_NAMES) {
    it.effect(`finds the map whose name holds ${label}`, () =>
      Effect.sync(() => {
        const target = mapElement(name);
        const document = documentWith([mapElement("other"), target]);

        const found = findImageMap(document, `#${name}`);

        assert.isTrue(
          Option.isSome(found),
          `no map for ${JSON.stringify(name)}`,
        );
        assert.strictEqual(Option.getOrNull(found), target);
      }));
  }

  it.effect("gives no map for an empty name", () =>
    Effect.sync(() => {
      const document = documentWith([mapElement(""), mapElement("nav")]);
      // The image then gets no hint of its own, and every other element on the
      // page keeps its hint.
      assert.isTrue(Option.isNone(findImageMap(document, "#")));
      assert.isTrue(Option.isNone(findImageMap(document, "")));
      assert.isTrue(Option.isNone(mapNameOf("#")));
      assert.isTrue(Option.isNone(mapNameOf("")));
    }));

  it.effect("takes the first map when the name is on the page two times", () =>
    Effect.sync(() => {
      const first = mapElement("nav");
      const second = mapElement("nav");
      const document = documentWith([first, second]);

      assert.strictEqual(
        Option.getOrNull(findImageMap(document, "#nav")),
        first,
      );
    }));

  it.effect("gives no map for a name that is not on the page", () =>
    Effect.sync(() => {
      const document = documentWith([mapElement("nav")]);
      assert.isTrue(Option.isNone(findImageMap(document, "#missing")));
    }));

  it.effect("compares the name exactly", () =>
    Effect.sync(() => {
      const document = documentWith([mapElement("nav")]);
      assert.isTrue(Option.isNone(findImageMap(document, "#NAV")));
      assert.isTrue(Option.isNone(findImageMap(document, "#nav ")));
      assert.isTrue(Option.isSome(findImageMap(document, "nav")));
      assert.strictEqual(Option.getOrNull(mapNameOf("#nav")), "nav");
    }));

  it.effect("keeps a name that already holds a hash", () =>
    Effect.sync(() => {
      const target = mapElement("#nav");
      const document = documentWith([mapElement("nav"), target]);
      // Only the first `#` is the separator, as `usemap` defines it.
      assert.strictEqual(
        Option.getOrNull(findImageMap(document, "##nav")),
        target,
      );
    }));
});
