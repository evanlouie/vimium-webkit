/**
 * The overlay host under a page that fights it.
 *
 * These are the pure parts of `ui/Ui.ts`. A unit test runs in Node with no
 * DOM, so the guard takes a reader as an argument instead of an element. The
 * behaviour that needs a browser is in `test/e2e/overlay.spec.ts`.
 *
 * The reads below imitate `CSSStyleDeclaration`: a property that nobody wrote
 * gives an empty value and an empty priority, which is exactly what
 * `style.removeProperty` leaves behind.
 */

import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import {
  comparableHostProperties,
  HOST_STYLE,
  hostDeclarations,
  hostNeedsAttachment,
  outOfDateHostProperties,
} from "~/ui/Ui.ts";

/** A style that holds exactly what the overlay wrote. */
const intact = (
  property: string,
): readonly [string, string] => [
  HOST_STYLE.find(([name]) => name === property)?.[1] ?? "",
  "important",
];

/** Nothing is owned by the viewport sync until that sync runs. */
const NO_OWNED: ReadonlyMap<string, string> = new Map();

/**
 * A style whose shorthands serialise back in another form, as a browser does.
 *
 * `all` reads back empty as soon as a later declaration changes one of its
 * longhands, and `margin: 0` reads back as `0px`.
 */
const asBrowser = (property: string): readonly [string, string] => {
  if (property === "all") return ["", ""];
  if (property === "margin" || property === "padding") {
    return ["0px", "important"];
  }
  if (property === "border") return ["0px none currentcolor", "important"];
  return intact(property);
};

/** The properties that this engine can compare, read from the style itself. */
const guardedIntact = (): ReadonlySet<string> =>
  comparableHostProperties(asBrowser);

describe("the guarded set", () => {
  it.effect("drops a shorthand that the engine gives back in another form", () =>
    Effect.sync(() => {
      const guarded = comparableHostProperties(asBrowser);
      for (const shorthand of ["all", "margin", "padding", "border"]) {
        assert.isFalse(
          guarded.has(shorthand),
          `${shorthand} cannot be compared`,
        );
      }
    }));

  it.effect("drops a property that this engine does not know", () =>
    Effect.sync(() => {
      // An engine that refuses `clip-path` keeps nothing, so the property
      // reads back empty. Guarding it would make the guard write for ever.
      const guarded = comparableHostProperties((property) =>
        property === "clip-path" ? ["", ""] : asBrowser(property)
      );
      assert.isFalse(guarded.has("clip-path"));
      assert.isTrue(guarded.has("filter"));
    }));

  it.effect("guards every property that hides the overlay on its own", () =>
    Effect.sync(() => {
      const guarded = comparableHostProperties(asBrowser);
      for (
        const property of [
          "position",
          "top",
          "right",
          "bottom",
          "left",
          "width",
          "height",
          "pointer-events",
          "z-index",
          "display",
          "transform",
          "visibility",
          "opacity",
          "clip-path",
          "filter",
        ]
      ) {
        assert.isTrue(guarded.has(property), `${property} is not guarded`);
      }
    }));

  it.effect("writes longhands, so that the guard can compare them", () =>
    Effect.sync(() => {
      // `inset` is a shorthand. An engine gives back an empty string for a
      // shorthand whose longhands disagree, and a later `position` declaration
      // makes them disagree, so the guard would rewrite the style for ever.
      const written = HOST_STYLE.map(([property]) => property);
      assert.notInclude(written, "inset");
    }));
});

describe("the overlay host style", () => {
  it.effect("finds nothing to do while the style is intact", () =>
    Effect.sync(() => {
      assert.deepEqual(
        outOfDateHostProperties(guardedIntact(), asBrowser, NO_OWNED),
        [],
      );
    }));

  it.effect("finds a property that the page overwrote", () =>
    Effect.sync(() => {
      const stale = outOfDateHostProperties(
        guardedIntact(),
        (property) =>
          property === "display" ? ["none", "important"] : asBrowser(property),
        NO_OWNED,
      );
      assert.deepEqual(stale, ["display"]);
    }));

  it.effect("finds a property that lost the important priority", () =>
    Effect.sync(() => {
      // A declaration without the priority loses to `vimium-webkit-overlay {
      // position: static !important }` in the stylesheet of the page.
      const stale = outOfDateHostProperties(
        guardedIntact(),
        (property) =>
          property === "position" ? ["fixed", ""] : asBrowser(property),
        NO_OWNED,
      );
      assert.deepEqual(stale, ["position"]);
    }));

  it.effect("finds each property that page script removed", () =>
    Effect.sync(() => {
      // One line of page script is enough:
      // `host.style.removeProperty("clip-path")`. The page rule then wins for
      // ever, and a guard that watched ten properties only reported nothing.
      for (
        const property of [
          "clip-path",
          "filter",
          "transform",
          "width",
          "height",
        ]
      ) {
        const stale = outOfDateHostProperties(
          guardedIntact(),
          (name) => name === property ? ["", ""] : asBrowser(name),
          NO_OWNED,
        );
        assert.deepEqual(stale, [property]);
      }
    }));

  it.effect("finds every property when the style attribute is gone", () =>
    Effect.sync(() => {
      const stale = outOfDateHostProperties(
        guardedIntact(),
        () => ["", ""],
        NO_OWNED,
      );
      assert.isAbove(stale.length, 4);
    }));
});

describe("the properties that the viewport sync owns", () => {
  const OWNED: ReadonlyMap<string, string> = new Map([
    ["transform", "translate(0px, 84px)"],
    ["width", "390px"],
    ["height", "580px"],
  ]);

  /** The style that the viewport sync left behind. */
  const synced = (property: string): readonly [string, string] => {
    const owned = OWNED.get(property);
    return owned === undefined ? asBrowser(property) : [owned, "important"];
  };

  it.effect("accepts the value that the sync wrote", () =>
    Effect.sync(() => {
      assert.deepEqual(
        outOfDateHostProperties(guardedIntact(), synced, OWNED),
        [],
      );
    }));

  it.effect("repairs with the viewport value, and not with the constant", () =>
    Effect.sync(() => {
      // A repair that wrote `transform: none` would put the overlay out of
      // line with the visual viewport under the toolbar of iOS, and during a
      // pinch zoom, until the next resize or scroll event.
      const written = new Map(hostDeclarations(OWNED));
      assert.strictEqual(written.get("transform"), "translate(0px, 84px)");
      assert.strictEqual(written.get("width"), "390px");
      assert.strictEqual(written.get("height"), "580px");
      assert.strictEqual(written.get("display"), "block");
    }));

  it.effect("still finds the sync value when the page removed it", () =>
    Effect.sync(() => {
      const stale = outOfDateHostProperties(
        guardedIntact(),
        (property) => property === "transform" ? ["", ""] : synced(property),
        OWNED,
      );
      assert.deepEqual(stale, ["transform"]);
    }));
});

describe("the host that the page moved", () => {
  /** A node that stands for an element in these pure tests. */
  const node = (name: string): Node => ({ nodeName: name } as unknown as Node);

  it.effect("puts the host back when the page holds it", () =>
    Effect.sync(() => {
      // The page builds a container of its own, gives it `opacity: 0` and
      // puts the host inside it. The host stays connected, so a guard that
      // asked `isConnected` reported nothing and the page owned the overlay.
      const root = node("HTML");
      const cage = node("DIV");
      assert.isTrue(hostNeedsAttachment(root, cage));
    }));

  it.effect("puts the host back after a removal", () =>
    Effect.sync(() => {
      assert.isTrue(hostNeedsAttachment(node("HTML"), null));
    }));

  it.effect("does nothing while the host is in its place", () =>
    Effect.sync(() => {
      const root = node("HTML");
      assert.isFalse(hostNeedsAttachment(root, root));
    }));

  it.effect("does nothing while the document has no element", () =>
    Effect.sync(() => {
      // At `document-start` there is no `documentElement`. The next `layer`
      // call tries again.
      assert.isFalse(hostNeedsAttachment(null, null));
      assert.isFalse(hostNeedsAttachment(null, node("DIV")));
    }));
});
