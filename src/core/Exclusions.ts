/**
 * Whether this frame is enabled, and which keys still belong to the page.
 *
 * The verdict comes from the *top* frame's URL, and not from this frame's URL.
 * Upstream Vimium does the same, through `sender.tab.url`. It matters: without
 * it an excluded page would still have us live inside its third-party frames.
 *
 * This service owns the verdict in every frame. The top frame matches its own
 * URL, again whenever the rules or the URL change. A child frame cannot read
 * the top frame's URL across origins, so it asks the top frame and listens for
 * what the top frame pushes. It does that through `TopFrameVerdict`, which
 * `frames/Link.ts` gives over the frame bus, so this service imports nothing
 * from `frames/` and the graph stays a tree.
 */

import {
  Array,
  Boolean,
  Context,
  Data,
  Duration,
  Effect,
  Layer,
  Option,
  Predicate,
  Ref,
  type Scope,
  Stream,
  String as Str,
  SubscriptionRef,
  flow,
  pipe,
} from "effect";
import {
  EffectiveRule,
  type ExclusionSet,
  FULLY_ENABLED,
  isRawPattern,
  makeExclusionSet,
  MAX_REGEX_URL_LENGTH,
} from "~/domain/Exclusion.ts";
import { REQUEST_DEADLINE_MS } from "~/domain/FrameMessage.ts";
import type { ExclusionRule } from "~/domain/Persisted.ts";
import { type NoFields, whenSome } from "~/domain/Prelude.ts";
import { Dom } from "~/platform/Dom.ts";
import { FrameRole, Realm } from "~/platform/Realm.ts";
import { Settings } from "./Settings.ts";

/** How long a child frame waits for the top frame before it assumes a verdict. */
const ANSWER_DEADLINE: Duration.Duration = Duration.millis(REQUEST_DEADLINE_MS);

/** The verdict in force for this frame. */
export type Verdict = Data.TaggedEnum<{
  /**
   * The frame does not know the verdict yet. A child frame waits for the top
   * frame. Every key goes to the page meanwhile, because a key that we took on
   * a page that the user excluded cannot be given back.
   */
  Pending: NoFields;
  /**
   * A child frame that can join the session of the top frame, but heard
   * nothing before the deadline, acts fully enabled until it hears.
   *
   * An ancestor can be cross-origin with no injection, and a parent can be
   * sandboxed. Disabling us there would disable us on a page that the user
   * never excluded. It is a guess, and not an answer, so the keys that the
   * guard held during the start are not played under it.
   */
  Assumed: NoFields;
  Known: { readonly rule: EffectiveRule };
}>;
export const Verdict = Data.taggedEnum<Verdict>();

/** The rule that a verdict puts in force. A pending verdict puts none. */
export const ruleOf: (verdict: Verdict) => Option.Option<EffectiveRule> = Verdict.$match({
  Pending: () => Option.none(),
  Assumed: () => Option.some(FULLY_ENABLED),
  Known: ({ rule }) => Option.some(rule),
});

/**
 * How a child frame hears the verdict of the top frame.
 *
 * `frames/Link.ts` gives it over the frame bus. The seam lets `Exclusions` own
 * the verdict without a module of `frames/`.
 */
export class TopFrameVerdict extends Context.Service<
  TopFrameVerdict,
  {
    /**
     * Ask the top frame for its verdict, once this frame joins its session.
     *
     * That can take any time, because the top frame admits a frame whenever
     * it hears it: after a sweep, or after the wake of a hint round. `None`
     * at once when this frame can never join a session.
     */
    readonly ask: Effect.Effect<Option.Option<EffectiveRule>>;
    /** Take every verdict that the top frame pushes, for as long as the scope is open. */
    readonly onPush: (
      adopt: (rule: EffectiveRule) => Effect.Effect<void>,
    ) => Effect.Effect<void, never, Scope.Scope>;
  }
>()("vimium/core/TopFrameVerdict") {}

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
    readonly current: Effect.Effect<Verdict>;

    /** The verdict, read synchronously. For the key path only. */
    readonly currentUnsafe: () => Verdict;

    /** The verdict now, and then every verdict that this frame takes. */
    readonly changes: Stream.Stream<Verdict>;

    /** Wait until the verdict is no longer pending, and give it. */
    readonly settled: Effect.Effect<Verdict>;

    /**
     * Work the verdict out again, after the URL of this frame changed.
     *
     * The top frame matches its new URL. A child frame keeps the verdict of the
     * top frame, which pushes a new one when its own URL changes.
     */
    readonly refresh: Effect.Effect<void>;

    /** Match a URL against the current rules. */
    readonly match: (url: string) => Effect.Effect<EffectiveRule>;
  }
>()("vimium/core/Exclusions") {
  static readonly layer: Layer.Layer<Exclusions, never, Settings | Dom | Realm | TopFrameVerdict> =
    Layer.effect(
      Exclusions,
      Effect.gen(function* () {
        const settings = yield* Settings;
        const dom = yield* Dom;
        const realm = yield* Realm;
        const top = yield* TopFrameVerdict;

        const verdict = yield* SubscriptionRef.make<Verdict>(Verdict.Pending());

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
            whenSome((signature) =>
              pipe(warnAboutDropped(set), Effect.when(isNewSignature(signature)), Effect.asVoid),
            ),
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

        /** Take a verdict. */
        const adopt = (rule: EffectiveRule): Effect.Effect<void> =>
          pipe(verdict, SubscriptionRef.set<Verdict>(Verdict.Known({ rule })));

        const resolveLocal = pipe(dom.href, Effect.flatMap(match));

        const resolveHere = pipe(resolveLocal, Effect.flatMap(adopt));

        /**
         * The top frame works the verdict out from its own URL, and again
         * whenever the rules change.
         *
         * The settings at the build are the defaults, because the stored ones
         * are read later, and the defaults exclude nothing. A verdict from
         * them would enable us on a page that the user excluded, and a child
         * frame would hear it. The top frame therefore stays pending until
         * Bootstrap has read storage and asks for a `refresh`, or until the
         * rules change.
         */
        const followRules = pipe(
          settings.changes,
          Stream.drop(1),
          Stream.runForEach(() => resolveHere),
          Effect.forkScoped,
        );

        /** Act fully enabled, unless a verdict came in time. Read `Verdict.Assumed`. */
        const assume = pipe(
          verdict,
          SubscriptionRef.updateSome<Verdict>(
            flow(Option.liftPredicate(Verdict.$is("Pending")), Option.as(Verdict.Assumed())),
          ),
        );

        /**
         * A child frame takes the verdict of the top frame, and every one that
         * it pushes.
         *
         * A frame that can never join a session decides alone, and fully
         * enabled: a manager with no private value store forms no session, and
         * the user excluded nothing that this frame could know of. A frame
         * that can join assumes the same verdict at the deadline, and takes
         * the answer whenever it comes.
         */
        const followTop = Effect.gen(function* () {
          yield* top.onPush(adopt);
          yield* pipe(
            top.ask,
            Effect.flatMap(Option.match({ onNone: () => adopt(FULLY_ENABLED), onSome: adopt })),
            Effect.forkScoped,
          );
          yield* pipe(assume, Effect.delay(ANSWER_DEADLINE), Effect.forkScoped);
        });

        const { follow, refresh } = pipe(
          realm.role,
          FrameRole.$match({
            Top: () => ({ follow: followRules, refresh: resolveHere }),
            Child: () => ({ follow: followTop, refresh: Effect.void }),
          }),
        );

        yield* follow;

        return Exclusions.of({
          current: SubscriptionRef.get(verdict),
          currentUnsafe: () => SubscriptionRef.getUnsafe(verdict),
          changes: SubscriptionRef.changes(verdict),
          settled: pipe(
            SubscriptionRef.changes(verdict),
            Stream.filter(Predicate.not(Verdict.$is("Pending"))),
            Stream.runHead,
            // The changes of a live reference never end, so the head is there.
            Effect.flatMap(Option.match({ onNone: () => Effect.never, onSome: Effect.succeed })),
          ),
          refresh,
          match,
        });
      }),
    );
}
