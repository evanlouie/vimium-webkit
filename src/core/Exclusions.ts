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

import {
  Array,
  Boolean,
  Context,
  Effect,
  Layer,
  Option,
  Ref,
  Stream,
  String as Str,
  SubscriptionRef,
  pipe,
} from "effect";
import {
  EffectiveRule,
  type ExclusionRule,
  type ExclusionSet,
  FULLY_ENABLED,
  isRawPattern,
  makeExclusionSet,
  MAX_REGEX_URL_LENGTH,
} from "~/domain/Exclusion.ts";
import { Dom } from "~/platform/Dom.ts";
import { FrameRole, Realm } from "~/platform/Realm.ts";
import { Settings } from "./Settings.ts";

export type { EffectiveRule };

/**
 * Say which rules did not compile.
 *
 * A dropped rule stops protecting the page, and the page then becomes active
 * again where the user turned it off. Silence there is the fault. The settings
 * dialog lists the same rules. The log also records each drop for diagnosis.
 */
const warnAboutDropped = (set: ExclusionSet): Effect.Effect<void> =>
  pipe(
    set.dropped,
    Effect.forEach(
      (rule) =>
        Effect.logWarning(`the exclusion rule "${rule.pattern}" was dropped: ${rule.reason}`),
      { discard: true },
    ),
  );

/**
 * What names the dropped rules of a set. `None` when the set dropped none.
 *
 * The signature changes only when the user changes the rules.
 */
const droppedSignature = (set: ExclusionSet): Option.Option<string> =>
  pipe(
    set.dropped,
    Array.map((rule) => rule.pattern),
    Array.join("\n"),
    Option.liftPredicate(Str.isNonEmpty),
  );

/**
 * Does a raw expression lose this URL to its cap?
 *
 * A raw expression reads a capped length of URL, because the static safety
 * check does not promise a linear match.
 */
const beyondRegexCap = (url: string, rules: ReadonlyArray<ExclusionRule>): boolean =>
  url.length > MAX_REGEX_URL_LENGTH &&
  pipe(
    rules,
    Array.some((rule) => isRawPattern(rule.pattern)),
  );

const REGEX_CAP_WARNING =
  `this URL is longer than ${MAX_REGEX_URL_LENGTH} characters, ` +
  "so an exclusion rule that holds a raw expression cannot match it";

export class Exclusions extends Context.Service<
  Exclusions,
  {
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
  }
>()("vimium/core/Exclusions") {
  static readonly layer: Layer.Layer<Exclusions, never, Settings | Dom | Realm> = Layer.effect(
    Exclusions,
    Effect.gen(function* () {
      const settings = yield* Settings;
      const dom = yield* Dom;
      const realm = yield* Realm;

      const effective = yield* SubscriptionRef.make(FULLY_ENABLED);

      // The same set of dropped rules must not fill the console.
      const warned = yield* Ref.make("");

      /** Remember the signature, and say whether it differs from the last one. */
      const isNewSignature = (signature: string): Effect.Effect<boolean> =>
        pipe(
          warned,
          Ref.getAndSet(signature),
          Effect.map((last) => last !== signature),
        );

      const warnOnce = (set: ExclusionSet): Effect.Effect<void> =>
        pipe(
          droppedSignature(set),
          Option.match({
            onNone: () => Effect.void,
            onSome: (signature) =>
              pipe(warnAboutDropped(set), Effect.when(isNewSignature(signature)), Effect.asVoid),
          }),
        );

      const match = Effect.fn("Exclusions.match")(function* (url: string) {
        const { exclusionRules } = yield* settings.current;
        const set = makeExclusionSet(exclusionRules);
        yield* warnOnce(set);
        // Say when the cap takes effect, so that a rule which stops matching
        // is not silent.
        yield* pipe(
          beyondRegexCap(url, exclusionRules),
          Boolean.match({
            onFalse: () => Effect.void,
            onTrue: () => Effect.logWarning(REGEX_CAP_WARNING),
          }),
        );
        return set.match(url);
      });

      const adopt = (rule: EffectiveRule): Effect.Effect<void> =>
        pipe(effective, SubscriptionRef.set(rule));

      const resolveLocal = pipe(dom.href, Effect.flatMap(match));

      // The top frame owns the verdict, so it keeps its own up to date when the
      // rules change. A child frame waits to be told.
      const followRules = pipe(
        settings.changes,
        Stream.runForEach(() => pipe(resolveLocal, Effect.flatMap(adopt))),
        Effect.forkScoped,
        Effect.asVoid,
      );

      yield* pipe(
        realm.role,
        FrameRole.$match({
          Top: () => followRules,
          Child: () => Effect.void,
        }),
      );

      return Exclusions.of({
        effective,
        effectiveUnsafe: () => SubscriptionRef.getUnsafe(effective),
        resolveLocal,
        match,
        adopt,
        isEnabled: pipe(SubscriptionRef.get(effective), Effect.map(EffectiveRule.guards.Enabled)),
      });
    }),
  );
}
