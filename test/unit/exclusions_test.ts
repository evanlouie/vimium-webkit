/**
 * The exclusion verdict for this frame.
 *
 * The verdict comes from the URL of the *top* frame, and not from the URL of
 * this frame. A child frame cannot read that URL across origins, so it takes
 * the answer of the top frame, and every verdict that the top frame pushes.
 *
 * The layers below are the real ones. `Dom` and `Realm` are built once and
 * then given a fixed URL and a fixed frame role, so no test touches a global.
 * `TopFrameVerdict` is the one stub: the test plays the top frame.
 */

import { assert, describe, it } from "@effect/vitest";
import { Deferred, Effect, Equal, Layer, Option, Queue, Stream, pipe, Struct } from "effect";
import { TestClock } from "effect/testing";
import { Exclusions, TopFrameVerdict, Verdict } from "~/core/Exclusions.ts";
import { Settings } from "~/core/Settings.ts";
import { EffectiveRule, FULLY_ENABLED } from "~/domain/Exclusion.ts";
import { REQUEST_DEADLINE_MS } from "~/domain/FrameMessage.ts";
import {
  defaultSettings,
  type ExclusionRule,
  SETTINGS_SCHEMA_VERSION,
} from "~/domain/Persisted.ts";
import { Dom } from "~/platform/Dom.ts";
import { StoreKind } from "~/platform/Gm.ts";
import { KeyValueStore, STORAGE_PREFIX } from "~/platform/KeyValueStore.ts";
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

/** The top frame, as a child frame hears it. The test answers, and pushes. */
interface TopFrame {
  readonly answer: Deferred.Deferred<Option.Option<EffectiveRule>>;
  readonly pushes: Queue.Queue<EffectiveRule>;
}

/** A top frame that a test plays. A test that never touches it leaves the child waiting. */
const topFrame: Effect.Effect<TopFrame> = Effect.all({
  answer: Deferred.make<Option.Option<EffectiveRule>>(),
  pushes: Queue.unbounded<EffectiveRule>(),
});

const topFrameVerdict = ({ answer, pushes }: TopFrame): Layer.Layer<TopFrameVerdict> =>
  Layer.succeed(
    TopFrameVerdict,
    TopFrameVerdict.of({
      ask: Deferred.await(answer),
      onPush: (adopt) =>
        pipe(Stream.fromQueue(pushes), Stream.runForEach(adopt), Effect.forkScoped, Effect.asVoid),
    }),
  );

const layerFor = (options: {
  readonly url: string;
  readonly role: FrameRole;
  readonly rules: readonly ExclusionRule[];
  readonly top: TopFrame;
}): Layer.Layer<Exclusions | Settings | Storage> => {
  const dom = domAt(options.url);
  const realm = pipe(realmAs(options.role), Layer.provide(dom));
  const storage = pipe(Storage.layer, Layer.provide(storedSettings(options.rules)));
  const settings = pipe(Settings.layer, Layer.provide(storage));
  return pipe(
    Exclusions.layer,
    Layer.provideMerge(Layer.mergeAll(dom, realm, settings, storage, topFrameVerdict(options.top))),
  );
};

/** Wait for the verdict `expected`. */
const verdictOf = (expected: Verdict): Effect.Effect<void, never, Exclusions> =>
  pipe(
    Exclusions,
    Effect.flatMap((exclusions) =>
      pipe(
        exclusions.changes,
        Stream.filter((verdict) => Equal.equals(verdict, expected)),
        Stream.runHead,
      ),
    ),
    Effect.asVoid,
  );

const DISABLED: EffectiveRule = EffectiveRule.cases.Disabled.make({});

/** A verdict that keeps us on, and gives the page `passKeys`. */
const passing = (passKeys: string): EffectiveRule => EffectiveRule.cases.Enabled.make({ passKeys });

const known = (rule: EffectiveRule): Verdict => Verdict.Known({ rule });

const EXCLUDED: readonly ExclusionRule[] = [
  { pattern: "https://excluded.test/*", passKeys: "" },
  { pattern: "https://partial.test/*", passKeys: "jk" },
];

describe("Exclusions", () => {
  it.effect("resolves the verdict from the URL of the top frame", () =>
    Effect.gen(function* () {
      const top = yield* topFrame;
      yield* pipe(
        Effect.gen(function* () {
          const settings = yield* Settings;
          const exclusions = yield* Exclusions;

          // The frame starts with the defaults, so the stored rules must be read
          // before the verdict means anything. Until then the verdict is
          // pending, and not the verdict of the defaults, which exclude
          // nothing.
          yield* pipe(Effect.yieldNow, Effect.replicateEffect(10, { discard: true }));
          assert.deepEqual(yield* exclusions.current, Verdict.Pending());

          yield* settings.reload;

          // The top frame keeps its own verdict up to date from the settings.
          yield* verdictOf(known(DISABLED));
          assert.deepEqual(exclusions.currentUnsafe(), known(DISABLED));
        }),
        Effect.provide(
          layerFor({
            url: "https://excluded.test/inbox",
            role: FrameRole.Top(),
            rules: EXCLUDED,
            top,
          }),
        ),
      );
    }),
  );

  it.effect("matches any URL against the current rules", () =>
    Effect.gen(function* () {
      const top = yield* topFrame;
      yield* pipe(
        Effect.gen(function* () {
          const settings = yield* Settings;
          const exclusions = yield* Exclusions;
          yield* settings.reload;

          assert.deepEqual(yield* exclusions.match("https://partial.test/doc"), passing("jk"));
          assert.deepEqual(yield* exclusions.match("https://other.test/"), passing(""));
        }),
        Effect.provide(
          layerFor({ url: "https://other.test/", role: FrameRole.Top(), rules: EXCLUDED, top }),
        ),
      );
    }),
  );

  it.effect("takes the answer of the top frame, and every verdict that it pushes", () =>
    Effect.gen(function* () {
      const top = yield* topFrame;
      yield* pipe(
        Effect.gen(function* () {
          const exclusions = yield* Exclusions;

          // A child frame waits for the top frame. It must not read its own URL.
          assert.deepEqual(yield* exclusions.current, Verdict.Pending());

          yield* pipe(top.answer, Deferred.succeed(Option.some<EffectiveRule>(DISABLED)));
          yield* exclusions.settled;
          assert.deepEqual(yield* exclusions.current, known(DISABLED));

          yield* pipe(top.pushes, Queue.offer(passing("jk")));
          yield* verdictOf(known(passing("jk")));
          assert.deepEqual(exclusions.currentUnsafe(), known(passing("jk")));
        }),
        Effect.provide(
          layerFor({
            // The URL of the child frame is excluded, and it must be ignored.
            url: "https://excluded.test/advert",
            role: FrameRole.Child(),
            rules: EXCLUDED,
            top,
          }),
        ),
      );
    }),
  );

  it.effect("decides alone, fully enabled, when it can join no session", () =>
    Effect.gen(function* () {
      const top = yield* topFrame;
      yield* pipe(
        Effect.gen(function* () {
          const exclusions = yield* Exclusions;

          // A manager with no private value store forms no session. Disabling
          // us there would disable us on a page that the user never excluded.
          yield* pipe(top.answer, Deferred.succeed(Option.none<EffectiveRule>()));
          assert.deepEqual(yield* exclusions.settled, known(FULLY_ENABLED));
        }),
        Effect.provide(
          layerFor({
            url: "https://excluded.test/advert",
            role: FrameRole.Child(),
            rules: EXCLUDED,
            top,
          }),
        ),
      );
    }),
  );

  it.effect(
    "assumes that it is enabled when the top frame is silent, and takes a late answer",
    () =>
      Effect.gen(function* () {
        const top = yield* topFrame;
        yield* pipe(
          Effect.gen(function* () {
            const exclusions = yield* Exclusions;

            // An ancestor with no injection, or a sandboxed parent. The frame acts
            // fully enabled, but it knows that it guessed.
            yield* TestClock.adjust(REQUEST_DEADLINE_MS);
            assert.deepEqual(yield* exclusions.settled, Verdict.Assumed());

            // The top frame admits a frame whenever it hears it, and the frame
            // asks then.
            yield* pipe(top.answer, Deferred.succeed(Option.some<EffectiveRule>(DISABLED)));
            yield* verdictOf(known(DISABLED));
          }),
          Effect.provide(
            layerFor({
              url: "https://other.test/advert",
              role: FrameRole.Child(),
              rules: EXCLUDED,
              top,
            }),
          ),
        );
      }),
  );
});
