/**
 * The exclusion verdict for this frame.
 *
 * The verdict comes from the URL of the *top* frame, and not from the URL of
 * this frame. A child frame cannot read that URL across origins, so it takes
 * the answer of the top frame with `adopt`.
 *
 * The layers below are the real ones. `Dom` and `Realm` are built once and
 * then given a fixed URL and a fixed frame role, so no test touches a global.
 */

import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Option, Stream, SubscriptionRef } from "effect";
import { Exclusions } from "~/core/Exclusions.ts";
import { Settings } from "~/core/Settings.ts";
import {
  defaultSettings,
  type ExclusionRule,
  SETTINGS_SCHEMA_VERSION,
} from "~/domain/Persisted.ts";
import { Dom } from "~/platform/Dom.ts";
import { KeyValueStore, STORAGE_PREFIX } from "~/platform/KeyValueStore.ts";
import { Realm } from "~/platform/Realm.ts";
import { Storage } from "~/platform/Storage.ts";

/** A backend that already holds the settings that a test needs. */
const storedSettings = (
  rules: readonly ExclusionRule[],
): Layer.Layer<KeyValueStore> =>
  Layer.sync(KeyValueStore, () => {
    const map = new Map<string, string>([[
      `${STORAGE_PREFIX}settings`,
      JSON.stringify({
        schemaVersion: SETTINGS_SCHEMA_VERSION,
        data: { ...defaultSettings(), exclusionRules: rules },
      }),
    ]]);
    return KeyValueStore.of({
      kind: "memory",
      durable: false,
      watchable: false,
      managerPrivate: false,
      get: (key) =>
        Effect.sync(() => Option.fromNullishOr(map.get(key) ?? null)),
      set: (key, value) =>
        Effect.sync(() => {
          map.set(key, value);
        }),
      remove: (key) =>
        Effect.sync(() => {
          map.delete(key);
        }),
      changes: () => Stream.empty,
    });
  });

/**
 * The real `Dom`, with a fixed URL.
 *
 * The service is built once and then one field is replaced. That keeps the
 * stub honest: every other field is the field that ships.
 */
const domAt = (url: string): Layer.Layer<Dom> =>
  Layer.provide(
    Layer.effect(
      Dom,
      Effect.map(Dom, (dom) => Dom.of({ ...dom, href: Effect.succeed(url) })),
    ),
    Dom.layer,
  );

/** The real `Realm`, told whether this frame is the top frame. */
const realmAs = (isTop: boolean): Layer.Layer<Realm, never, Dom> =>
  Layer.provide(
    Layer.effect(
      Realm,
      Effect.map(Realm, (realm) => Realm.of({ ...realm, isTop })),
    ),
    Realm.layer,
  );

const layerFor = (
  options: {
    readonly url: string;
    readonly isTop: boolean;
    readonly rules: readonly ExclusionRule[];
  },
): Layer.Layer<Exclusions | Settings | Storage> => {
  const dom = domAt(options.url);
  const storage = Layer.provide(Storage.layer, storedSettings(options.rules));
  const settings = Layer.provide(Settings.layer, storage);
  const base = Layer.mergeAll(
    dom,
    Layer.provide(realmAs(options.isTop), dom),
    settings,
    storage,
  );
  return Layer.provideMerge(Exclusions.layer, base);
};

const EXCLUDED: readonly ExclusionRule[] = [
  { pattern: "https://excluded.test/*", passKeys: "" },
  { pattern: "https://partial.test/*", passKeys: "jk" },
];

describe("Exclusions", () => {
  it.effect("resolves the verdict from the URL of the top frame", () =>
    Effect.gen(function*() {
      const settings = yield* Settings;
      const exclusions = yield* Exclusions;

      // The frame starts with the defaults, so the stored rules must be read
      // before the verdict means anything.
      yield* settings.reload;

      const local = yield* exclusions.resolveLocal;
      assert.deepEqual(local, { enabled: false, passKeys: "" });

      // The top frame keeps its own verdict up to date from the settings.
      const applied = yield* Stream.runHead(
        Stream.filter(
          SubscriptionRef.changes(exclusions.effective),
          (rule) => !rule.enabled,
        ),
      );
      assert.isTrue(Option.isSome(applied));
      assert.isFalse(yield* exclusions.isEnabled);
      assert.isFalse(exclusions.effectiveUnsafe().enabled);
    }).pipe(Effect.provide(layerFor({
      url: "https://excluded.test/inbox",
      isTop: true,
      rules: EXCLUDED,
    }))));

  it.effect("matches any URL against the current rules", () =>
    Effect.gen(function*() {
      const settings = yield* Settings;
      const exclusions = yield* Exclusions;
      yield* settings.reload;

      assert.deepEqual(
        yield* exclusions.match("https://partial.test/doc"),
        { enabled: true, passKeys: "jk" },
      );
      assert.deepEqual(
        yield* exclusions.match("https://other.test/"),
        { enabled: true, passKeys: "" },
      );
    }).pipe(Effect.provide(layerFor({
      url: "https://other.test/",
      isTop: true,
      rules: EXCLUDED,
    }))));

  it.effect("stays fully enabled when no rule matches this frame", () =>
    Effect.gen(function*() {
      const settings = yield* Settings;
      const exclusions = yield* Exclusions;
      yield* settings.reload;

      assert.deepEqual(
        yield* exclusions.resolveLocal,
        { enabled: true, passKeys: "" },
      );
      assert.isTrue(yield* exclusions.isEnabled);
    }).pipe(Effect.provide(layerFor({
      url: "https://other.test/",
      isTop: true,
      rules: EXCLUDED,
    }))));

  it.effect("replaces the verdict with the answer of the top frame", () =>
    Effect.gen(function*() {
      const exclusions = yield* Exclusions;

      // A child frame starts fully enabled. It must not read its own URL.
      assert.isTrue(yield* exclusions.isEnabled);

      yield* exclusions.adopt({ enabled: false, passKeys: "" });
      assert.isFalse(yield* exclusions.isEnabled);
      assert.deepEqual(
        yield* SubscriptionRef.get(exclusions.effective),
        { enabled: false, passKeys: "" },
      );

      yield* exclusions.adopt({ enabled: true, passKeys: "jk" });
      assert.deepEqual(exclusions.effectiveUnsafe(), {
        enabled: true,
        passKeys: "jk",
      });
    }).pipe(Effect.provide(layerFor({
      // The URL of the child frame is excluded, and it must be ignored.
      url: "https://excluded.test/advert",
      isTop: false,
      rules: EXCLUDED,
    }))));
});
