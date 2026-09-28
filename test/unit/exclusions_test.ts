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
import { Effect, Layer, Option, Stream, SubscriptionRef, pipe, Struct } from "effect";
import { Exclusions } from "~/core/Exclusions.ts";
import { Settings } from "~/core/Settings.ts";
import { EffectiveRule } from "~/domain/Exclusion.ts";
import {
  defaultSettings,
  type ExclusionRule,
  SETTINGS_SCHEMA_VERSION,
} from "~/domain/Persisted.ts";
import { Dom } from "~/platform/Dom.ts";
import { KeyValueStore, STORAGE_PREFIX, StoreKind } from "~/platform/KeyValueStore.ts";
import { FrameRole, Realm } from "~/platform/Realm.ts";
import { Storage } from "~/platform/Storage.ts";

/** A backend that already holds the settings that a test needs. */
const storedSettings = (rules: readonly ExclusionRule[]): Layer.Layer<KeyValueStore> =>
  Layer.sync(KeyValueStore, () => {
    const map = new Map<string, string>([
      [
        `${STORAGE_PREFIX}settings`,
        JSON.stringify({
          schemaVersion: SETTINGS_SCHEMA_VERSION,
          data: pipe(defaultSettings(), Struct.assign({ exclusionRules: rules })),
        }),
      ],
    ]);
    return KeyValueStore.of({
      kind: StoreKind.Memory(),
      get: (key) => Effect.sync(() => Option.fromNullishOr(map.get(key))),
      set: (key, value) =>
        Effect.sync(() => {
          map.set(key, value);
        }),
      remove: (key) =>
        Effect.sync(() => {
          map.delete(key);
        }),
      setUnsafe: Option.some((key, value) => {
        map.set(key, value);
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
  pipe(
    Dom,
    Effect.map(Struct.assign({ href: Effect.succeed(url) })),
    Layer.effect(Dom),
    Layer.provide(Dom.layer),
  );

/** The real `Realm`, told whether this frame is the top frame or a child. */
const realmAs = (role: FrameRole): Layer.Layer<Realm, never, Dom> =>
  pipe(Realm, Effect.map(Struct.assign({ role })), Layer.effect(Realm), Layer.provide(Realm.layer));

const layerFor = (options: {
  readonly url: string;
  readonly role: FrameRole;
  readonly rules: readonly ExclusionRule[];
}): Layer.Layer<Exclusions | Settings | Storage> => {
  const dom = domAt(options.url);
  const realm = pipe(realmAs(options.role), Layer.provide(dom));
  const storage = pipe(Storage.layer, Layer.provide(storedSettings(options.rules)));
  const settings = pipe(Settings.layer, Layer.provide(storage));
  return pipe(Exclusions.layer, Layer.provideMerge(Layer.mergeAll(dom, realm, settings, storage)));
};

const DISABLED: EffectiveRule = EffectiveRule.cases.Disabled.make({});

/** A verdict that keeps us on, and gives the page `passKeys`. */
const passing = (passKeys: string): EffectiveRule => EffectiveRule.cases.Enabled.make({ passKeys });

const EXCLUDED: readonly ExclusionRule[] = [
  { pattern: "https://excluded.test/*", passKeys: "" },
  { pattern: "https://partial.test/*", passKeys: "jk" },
];

describe("Exclusions", () => {
  it.effect("resolves the verdict from the URL of the top frame", () =>
    pipe(
      Effect.gen(function* () {
        const settings = yield* Settings;
        const exclusions = yield* Exclusions;

        // The frame starts with the defaults, so the stored rules must be read
        // before the verdict means anything.
        yield* settings.reload;

        const local = yield* exclusions.resolveLocal;
        assert.deepEqual(local, DISABLED);

        // The top frame keeps its own verdict up to date from the settings.
        const applied = yield* pipe(
          SubscriptionRef.changes(exclusions.effective),
          Stream.filter(EffectiveRule.guards.Disabled),
          Stream.runHead,
        );
        assert.isTrue(Option.isSome(applied));
        assert.isFalse(yield* exclusions.isEnabled);
        assert.isTrue(EffectiveRule.guards.Disabled(exclusions.effectiveUnsafe()));
      }),
      Effect.provide(
        layerFor({
          url: "https://excluded.test/inbox",
          role: FrameRole.Top(),
          rules: EXCLUDED,
        }),
      ),
    ),
  );

  it.effect("matches any URL against the current rules", () =>
    pipe(
      Effect.gen(function* () {
        const settings = yield* Settings;
        const exclusions = yield* Exclusions;
        yield* settings.reload;

        assert.deepEqual(yield* exclusions.match("https://partial.test/doc"), passing("jk"));
        assert.deepEqual(yield* exclusions.match("https://other.test/"), passing(""));
      }),
      Effect.provide(
        layerFor({
          url: "https://other.test/",
          role: FrameRole.Top(),
          rules: EXCLUDED,
        }),
      ),
    ),
  );

  it.effect("replaces the verdict with the answer of the top frame", () =>
    pipe(
      Effect.gen(function* () {
        const exclusions = yield* Exclusions;

        // A child frame starts fully enabled. It must not read its own URL.
        assert.isTrue(yield* exclusions.isEnabled);

        yield* exclusions.adopt(DISABLED);
        assert.isFalse(yield* exclusions.isEnabled);
        assert.deepEqual(yield* SubscriptionRef.get(exclusions.effective), DISABLED);

        yield* exclusions.adopt(passing("jk"));
        assert.deepEqual(exclusions.effectiveUnsafe(), passing("jk"));
      }),
      Effect.provide(
        layerFor({
          // The URL of the child frame is excluded, and it must be ignored.
          url: "https://excluded.test/advert",
          role: FrameRole.Child(),
          rules: EXCLUDED,
        }),
      ),
    ),
  );
});
