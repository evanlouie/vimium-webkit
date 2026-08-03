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

import { Context, Effect, Layer, Ref, Stream, SubscriptionRef } from "effect";
import {
  type EffectiveRule,
  type ExclusionSet,
  FULLY_ENABLED,
  isRawPattern,
  makeExclusionSet,
  MAX_REGEX_URL_LENGTH,
} from "~/domain/Exclusion.ts";
import { Dom } from "~/platform/Dom.ts";
import { Realm } from "~/platform/Realm.ts";
import { Settings } from "./Settings.ts";

export type { EffectiveRule };

/**
 * Say which rules did not compile.
 *
 * A dropped rule stops protecting the page, and the page then becomes active
 * again where the user turned it off. Silence there is the fault. The settings
 * dialog marks the same rules, and this log line reaches a user who never
 * opens the dialog.
 */
const warnAboutDropped = (set: ExclusionSet): Effect.Effect<void> =>
  Effect.forEach(
    set.dropped,
    (rule) =>
      Effect.logWarning(
        `the exclusion rule "${rule.pattern}" was dropped: ${rule.reason}`,
      ),
    { discard: true },
  );

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

      // The same set of dropped rules must not fill the console. The signature
      // changes only when the user changes the rules.
      const warned = yield* Ref.make("");
      const warnOnce = (set: ExclusionSet): Effect.Effect<void> =>
        Effect.gen(function*() {
          const signature = set.dropped.map((rule) => rule.pattern).join("\n");
          if (signature.length === 0) return;
          const last = yield* Ref.getAndSet(warned, signature);
          if (last === signature) return;
          yield* warnAboutDropped(set);
        });

      const match = (url: string): Effect.Effect<EffectiveRule> =>
        Effect.gen(function*() {
          const current = yield* settings.current;
          const set = makeExclusionSet(current.exclusionRules);
          yield* warnOnce(set);
          // A raw expression reads a capped length of URL, because the static
          // safety check does not promise a linear match. Say when the cap
          // takes effect, so that a rule which stops matching is not silent.
          if (
            url.length > MAX_REGEX_URL_LENGTH &&
            current.exclusionRules.some((rule) => isRawPattern(rule.pattern))
          ) {
            yield* Effect.logWarning(
              `this URL is longer than ${MAX_REGEX_URL_LENGTH} characters, ` +
                "so an exclusion rule that holds a raw expression cannot " +
                "match it",
            );
          }
          return set.match(url);
        });

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
