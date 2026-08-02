/**
 * Whether this frame is enabled, and which keys still belong to the page.
 *
 * The verdict comes from the *top* frame's URL, and not from this frame's URL.
 * Upstream Vimium does the same, through `sender.tab.url`. It matters: without
 * it an excluded page would still have us live inside its third-party frames.
 *
 * A child frame cannot read the top frame's URL across origins, so it cannot
 * work the verdict out. It asks over the frame bus instead, and `frames/Link.ts`
 * calls `adopt` with the answer. This service therefore knows nothing about
 * frames, and the graph stays a tree.
 */

import { Context, Effect, Layer, Stream, SubscriptionRef } from "effect";
import {
  type EffectiveRule,
  FULLY_ENABLED,
  makeExclusionSet,
} from "~/domain/Exclusion.ts";
import { Dom } from "~/platform/Dom.ts";
import { Realm } from "~/platform/Realm.ts";
import { Settings } from "./Settings.ts";

export type { EffectiveRule };

export class Exclusions extends Context.Service<Exclusions, {
  /** The verdict in force for this frame. */
  readonly effective: SubscriptionRef.SubscriptionRef<EffectiveRule>;

  /** The verdict, read synchronously. For the key path only. */
  readonly effectiveUnsafe: () => EffectiveRule;

  /**
   * Work the verdict out from this frame's own URL and settings.
   *
   * Correct in the top frame. A child frame uses `adopt` instead.
   */
  readonly resolveLocal: Effect.Effect<EffectiveRule>;

  /** Match a URL against the current rules. The top frame answers with this. */
  readonly match: (url: string) => Effect.Effect<EffectiveRule>;

  /** Take a verdict that the top frame sent. */
  readonly adopt: (rule: EffectiveRule) => Effect.Effect<void>;

  /** True when this frame must act on keys at all. */
  readonly isEnabled: Effect.Effect<boolean>;
}>()("vimium/core/Exclusions") {
  static readonly layer: Layer.Layer<
    Exclusions,
    never,
    Settings | Dom | Realm
  > = Layer.effect(
    Exclusions,
    Effect.gen(function*() {
      const settings = yield* Settings;
      const dom = yield* Dom;
      const realm = yield* Realm;

      const effective = yield* SubscriptionRef.make(FULLY_ENABLED);

      const match = (url: string): Effect.Effect<EffectiveRule> =>
        Effect.map(
          settings.current,
          (current) => makeExclusionSet(current.exclusionRules).match(url),
        );

      const resolveLocal = Effect.flatMap(dom.href, match);

      // The top frame owns the verdict, so it keeps its own up to date when the
      // rules change. A child frame waits to be told.
      if (realm.isTop) {
        yield* Effect.forkScoped(
          Stream.runForEach(settings.changes, () =>
            Effect.flatMap(
              resolveLocal,
              (rule) => SubscriptionRef.set(effective, rule),
            )),
        );
      }

      return Exclusions.of({
        effective,
        effectiveUnsafe: () => SubscriptionRef.getUnsafe(effective),
        resolveLocal,
        match,
        adopt: (rule) => SubscriptionRef.set(effective, rule),
        isEnabled: Effect.map(
          SubscriptionRef.get(effective),
          (rule) => rule.enabled,
        ),
      });
    }),
  );
}
