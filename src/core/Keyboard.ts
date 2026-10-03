/**
 * Normal mode: the trie walk, the count prefix and the pass keys.
 *
 * The design comes from upstream Vimium's `content_scripts/mode_key_handler.js`
 * and `mode_normal.js` (MIT).
 *
 * The important detail is that the key state is a *list* of trie nodes, and not
 * one node. That is what lets `gg` resolve while `g` is also a live prefix, and
 * what lets a new sequence start inside an abandoned one. `g` and then `j`
 * scrolls down, instead of doing nothing.
 *
 * Every effect in this file must run to completion inside the browser's own
 * dispatch, because `preventDefault` works nowhere else. Nothing here may
 * suspend. Read the section "The keyboard path is synchronous" of
 * `ARCHITECTURE.md`.
 */

import {
  Array,
  Boolean,
  Context,
  Data,
  Effect,
  FiberSet,
  Layer,
  Match,
  Option,
  Record,
  Ref,
  Stream,
  SubscriptionRef,
  flow,
  pipe,
} from "effect";
import { EffectiveRule, isPassKey } from "~/domain/Exclusion.ts";
import {
  appendCountDigit,
  isComposing,
  isCountDigit,
  isModifierKey,
  type KeyContext,
  keyNotation,
} from "~/domain/Key.ts";
import {
  canExtend,
  extendBranches,
  type KeyBinding,
  type KeyBranch,
  openBranch,
  type TrieNode,
} from "~/domain/Mapping.ts";
import { type NoFields, whenSome } from "~/domain/Prelude.ts";
import { Dom } from "~/platform/Dom.ts";
import { Capabilities } from "~/platform/Capabilities.ts";
import { isUserEvent, mediaPlayerHasFocus } from "~/platform/Elements.ts";
import { Commands } from "./Commands.ts";
import { Exclusions, ruleOf, type Verdict } from "./Exclusions.ts";
import { CONTINUE_BUBBLING, type HandlerResult, SUPPRESS_EVENT } from "./HandlerStack.ts";
import { Mappings } from "./Mappings.ts";
import { isEscape, KeyPolicy, Modes, ModeTier } from "./Modes.ts";
import { Report } from "./Report.ts";
import { Settings } from "./Settings.ts";

/**
 * The keys that a focused media player owns.
 *
 * Exactly the set that the browser's own `<video controls>` takes when it has
 * focus. It does not include `j`, `k` or `l`, which YouTube also binds: a Vim
 * user who presses `j` on a video page means "scroll", and always has.
 */
export const MEDIA_KEYS: ReadonlySet<string> = new Set([
  "<up>",
  "<down>",
  "<left>",
  "<right>",
  "<space>",
]);

/**
 * The keys that open our find instead of the find of the browser, while
 * `shadowNativeFind` is on: ⌘F, and Ctrl+F where the platform uses it.
 */
const NATIVE_FIND_KEYS: ReadonlySet<string> = new Set(["<m-f>", "<c-f>"]);

/** What a native find key runs instead. */
const OUR_FIND: Pick<KeyBinding, "command"> = { command: "enterFindMode" };

// ---------------------------------------------------------------------------
// The key state
// ---------------------------------------------------------------------------

/** What the branch walk reads from the key state. */
interface Progress {
  /**
   * Every live branch, shallowest first. Empty at the root, and while the user
   * has typed only a count.
   */
  readonly branches: ReadonlyArray<KeyBranch>;
  /** The count prefix. `0` means that the user typed none. */
  readonly count: number;
  /** The keys that the indicator shows. */
  readonly pending: ReadonlyArray<string>;
}

/** A half-typed command: a count, some keys, or both. */
interface HalfTyped extends Progress {
  readonly pending: Array.NonEmptyReadonlyArray<string>;
}

/**
 * The key state, in the per-branch model. `Option.none()` means that nothing
 * is half-typed.
 *
 * A branch is one live attempt at a mapping. It holds the trie node that the
 * keys of the attempt reached, and the binding that the attempt accepted.
 *
 * A branch starts when the root opens a child for the key. The accepted binding
 * of a new branch is the binding of that child alone. A key extends a branch
 * when the node of the branch has a child for the key. A binding on that child
 * replaces the accepted binding of the branch.
 *
 * A branch dies when its node has no child for the key. Its accepted binding
 * dies with it. When every branch dies, the accepted binding of the branch that
 * lived longest runs. The key then starts again at the root.
 *
 * `map g scrollUp` together with `map gg scrollToTop` puts `scrollUp` in the
 * branch `g`. The next key decides: `g` extends that branch and runs
 * `scrollToTop`, and any other key runs `scrollUp` first.
 *
 * With `map a`, `map abc` and `map b`, the key `b` after `a` opens two
 * branches. The branch `ab` carries on the attempt at `abc`, and the branch `b`
 * is new. The attempt at `abc` consumes the keystroke `b`: the walk holds the
 * key, and the pending indicator shows it. The binding of `b` therefore never
 * runs, and a stray key after it runs the binding of `a`.
 */
type KeyState = Option.Option<HalfTyped>;

const AT_ROOT: Progress = { branches: [], count: 0, pending: [] };

/** The count that a binding runs with. No count means one. */
const runCount = (count: number): number => Math.max(1, count);

// ---------------------------------------------------------------------------
// The rules before the walk
// ---------------------------------------------------------------------------

/** What normal mode does with a key before the branch walk. */
type Arrival = Data.TaggedEnum<{
  /** The key belongs to the page, and the key state stays. */
  Page: NoFields;
  /** `passNextKey` promised this key to the page. One pass is spent. */
  Passed: NoFields;
  /** Escape ends the half-typed command. */
  Cancelled: NoFields;
  /** A key that a focused media player owns, if a player has focus. */
  Media: { readonly raw: string };
  /** The key is ours. */
  Ours: { readonly raw: string };
}>;
const Arrival = Data.taggedEnum<Arrival>();

/** Everything that the rules before the walk read. */
interface Intake {
  readonly event: KeyboardEvent;
  readonly state: KeyState;
  /** The keys that `passNextKey` still owes the page. */
  readonly passes: number;
  readonly context: KeyContext;
  readonly verdict: Verdict;
  readonly passMediaKeys: boolean;
}

/**
 * The rules for a key at the root.
 *
 * A pass key applies to a new sequence only. Once the user has committed to
 * `g`, the next key is ours even if it is in the set. A count starts a
 * sequence as well, so `3 j` runs our binding for `j` even when the user gave
 * `j` to the page.
 */
const rootArrival = ({ passMediaKeys }: Intake, rule: EffectiveRule, raw: string): Arrival =>
  pipe(
    Match.value(raw),
    Match.withReturnType<Arrival>(),
    Match.when(
      (key) => isPassKey(rule, key),
      () => Arrival.Page(),
    ),
    // The same rule for the keys that a focused media player owns. The check
    // of the focus walks the document, so the runner makes it only for a key
    // that passes these cheap tests.
    Match.when(
      (key) => passMediaKeys && MEDIA_KEYS.has(key),
      (key) => Arrival.Media({ raw: key }),
    ),
    Match.orElse((key) => Arrival.Ours({ raw: key })),
  );

/**
 * The rules for a key that has a notation.
 *
 * Every pass-through rule reads the *raw* notation, and not the remapped one.
 * The user gives a physical key to the page, and `mapkey` describes what the
 * key does for us. A test against the remapped notation captured a key that
 * the exclusion promised to the page. It also gave away a key that no rule
 * named.
 */
const keyArrival = (intake: Intake, rule: EffectiveRule, raw: string): Arrival =>
  pipe(
    Match.value({
      owed: intake.passes > 0,
      escape: isEscape(intake.event),
      atRoot: Option.isNone(intake.state),
    }),
    Match.withReturnType<Arrival>(),
    // The pass counter comes before every other rule, so Escape goes to the
    // page and spends one pass. That is the point of the command: it gives any
    // key to the page, and Escape is a key.
    Match.when({ owed: true }, () => Arrival.Passed()),
    Match.when({ escape: true, atRoot: true }, () => Arrival.Page()),
    Match.when({ escape: true }, () => Arrival.Cancelled()),
    Match.when({ atRoot: true }, () => rootArrival(intake, rule, raw)),
    Match.orElse(() => Arrival.Ours({ raw })),
  );

/** The notation of a key that the user made, and that is a whole keystroke. */
const typedNotation = ({ event, context }: Intake): Option.Option<string> =>
  pipe(
    event,
    // A key that the page made. It gives no command, and it does not touch
    // the pending sequence.
    Option.liftPredicate(isUserEvent),
    // Composition, from an input method or from a dead key. Without this
    // guard we eat keystrokes in the middle of composition, which is the most
    // damaging failure for a user of a CJK language, and one that the user
    // cannot work around.
    Option.filter((key) => !isComposing(key) && !isModifierKey(key)),
    Option.flatMap((key) => keyNotation(key, context)),
  );

/**
 * The rule that lets normal mode act on a key.
 *
 * `None` while the verdict is pending, and on a page that the user excluded.
 * The page keeps every key in both cases.
 */
const activeRule = (verdict: Verdict): Option.Option<EffectiveRule> =>
  pipe(verdict, ruleOf, Option.filter(EffectiveRule.guards.Enabled));

/**
 * What normal mode does with a key.
 *
 * The verdict is read for each key. Normal mode itself never leaves the stack,
 * because a mode that is entered again goes on top of insert mode, and a key
 * typed into a text field then ran a command.
 */
const arrivalOf = (intake: Intake): Arrival =>
  pipe(
    Option.all({ rule: activeRule(intake.verdict), raw: typedNotation(intake) }),
    Option.match({
      onNone: () => Arrival.Page(),
      onSome: ({ rule, raw }) => keyArrival(intake, rule, raw),
    }),
  );

// ---------------------------------------------------------------------------
// The branch walk
// ---------------------------------------------------------------------------

/** What the branch walk does with one key. */
type Step = Data.TaggedEnum<{
  /** The key extends the half-typed command, which waits for more keys. */
  Hold: { readonly next: HalfTyped };
  /** The deepest branch can take no other key, and it accepted a binding. */
  Fire: { readonly binding: KeyBinding; readonly count: number };
  /**
   * The key ended every live attempt, and the attempt that lived longest
   * accepted a binding. The binding runs, and the key starts again at the
   * root.
   */
  Restart: { readonly binding: KeyBinding; readonly count: number };
  /** A half-typed command ran out. The key is still ours. */
  Drop: NoFields;
  /** A key at the root that starts nothing. */
  Miss: NoFields;
}>;
const Step = Data.taggedEnum<Step>();

/**
 * `0` is a count digit only once a count is under way. Otherwise it is a
 * key that a user may bind, and upstream binds it to `scrollToLeft`.
 *
 * `1` to `9` give way to an explicit binding for the same reason. They
 * used to be taken unconditionally, so `map 1 scrollDown` compiled with no
 * diagnostic and could never fire — and it also ate the keystroke and held
 * `1` in the HUD until the user pressed Escape.
 */
const isCountKey = (trie: TrieNode, { branches, count }: Progress, notation: string): boolean =>
  Array.isReadonlyArrayEmpty(branches) &&
  isCountDigit(notation, count > 0) &&
  (count > 0 || !pipe(trie.children, Record.has(notation)));

const countStep = (
  trie: TrieNode,
  progress: Progress,
  notation: string,
  typed: Array.NonEmptyReadonlyArray<string>,
): Option.Option<Step> =>
  pipe(
    notation,
    Option.liftPredicate((digit) => isCountKey(trie, progress, digit)),
    Option.map((digit) =>
      Step.Hold({
        next: { branches: [], count: appendCountDigit(progress.count, digit), pending: typed },
      }),
    ),
  );

/**
 * The key ended every live attempt, and the attempt that lived longest
 * accepted a binding.
 *
 * The binding runs with the count that the user typed in front of it.
 * Without this, `map g scrollUp` could never run while `map gg scrollToTop`
 * also existed. The deepest dead branch decides even when it accepted
 * nothing, and a shallower dead branch with a binding is then dropped in
 * silence.
 */
const restartStep = (progress: Progress, extended: ReadonlyArray<KeyBranch>): Option.Option<Step> =>
  pipe(
    extended,
    Array.match({
      onEmpty: () =>
        pipe(
          Array.last(progress.branches),
          Option.flatMap((branch) => branch.accepted),
        ),
      onNonEmpty: () => Option.none<KeyBinding>(),
    }),
    Option.map((binding) => Step.Restart({ binding, count: runCount(progress.count) })),
  );

/**
 * The live branches decide.
 *
 * A new branch is one key deep, so it goes in front of the others. The
 * cursor stays shallowest first, and the deepest branch stays last.
 *
 * The deepest branch decides, because it is the longest attempt. While its
 * node can take another key, the attempt is not finished. Firing the shorter
 * binding here is what made `map gg` unreachable behind `map g`.
 */
const branchStep = (
  trie: TrieNode,
  state: KeyState,
  { count }: Progress,
  extended: ReadonlyArray<KeyBranch>,
  notation: string,
  typed: Array.NonEmptyReadonlyArray<string>,
): Step =>
  pipe(
    openBranch(trie, notation),
    Option.toArray,
    Array.appendAll(extended),
    Array.match({
      // A sequence that ran out is still ours. The user typed `g` on purpose,
      // so giving the next key to the page would be a surprise. A key that
      // never matched anything passes straight through.
      onEmpty: () =>
        pipe(
          state,
          Option.match({
            onNone: () => Step.Miss(),
            onSome: () => Step.Drop(),
          }),
        ),
      onNonEmpty: (live) =>
        pipe(
          Array.last(live),
          Option.filter((deepest) => !canExtend(deepest)),
          Option.flatMap((deepest) => deepest.accepted),
          Option.match({
            onNone: () => Step.Hold({ next: { branches: live, count, pending: typed } }),
            onSome: (binding) => Step.Fire({ binding, count: runCount(count) }),
          }),
        ),
    }),
  );

/**
 * Take one key into the branch walk.
 *
 * The key extends every live branch. A branch that has no child for the
 * key dies, and its accepted binding dies with it. The root opens a new
 * branch, which has accepted nothing that an earlier key typed.
 *
 * The count prefix comes first. A digit is a count only at the root, or
 * behind another digit.
 */
const walk = (trie: TrieNode, state: KeyState, notation: string): Step => {
  const progress = pipe(
    state,
    Option.getOrElse((): Progress => AT_ROOT),
  );
  // The keys that the indicator shows if this key holds.
  const typed = pipe(progress.pending, Array.append(notation));
  // Every live branch takes the key, or it dies here.
  const extended = extendBranches(progress.branches, notation);
  return pipe(
    countStep(trie, progress, notation, typed),
    Option.orElse(() => restartStep(progress, extended)),
    Option.getOrElse(() => branchStep(trie, state, progress, extended, notation, typed)),
  );
};

export class Keyboard extends Context.Service<
  Keyboard,
  {
    /** The half-typed sequence, for the HUD. `None` when there is none. */
    readonly pending: {
      readonly get: Effect.Effect<Option.Option<string>>;
      /** The sequence now, and then every change of it. */
      readonly changes: Stream.Stream<Option.Option<string>>;
    };

    /** Give the next `count` keystrokes to the page, without reading them. */
    readonly passNextKey: (count: number) => Effect.Effect<void>;
  }
>()("vimium/core/Keyboard") {
  static readonly layer: Layer.Layer<
    Keyboard,
    never,
    Commands | Capabilities | Dom | Exclusions | Mappings | Modes | Report | Settings
  > = Layer.effect(
    Keyboard,
    Effect.gen(function* () {
      const commands = yield* Commands;
      const capabilities = yield* Capabilities;
      const dom = yield* Dom;
      const exclusions = yield* Exclusions;
      const mappings = yield* Mappings;
      const modes = yield* Modes;
      const report = yield* Report;
      const settings = yield* Settings;

      const pending = yield* SubscriptionRef.make(Option.none<string>());
      const state = yield* Ref.make<KeyState>(Option.none());
      // The trie that the half-typed sequence was walked on.
      const walkedOn = yield* Ref.make(mappings.compiledUnsafe());
      const passNext = yield* Ref.make(0);
      // The command bodies that still run. They start at once, on the key task.
      const running = yield* FiberSet.make();

      /** Show the half-typed sequence in the HUD. `None` shows nothing. */
      const show = (text: Option.Option<string>): Effect.Effect<void> =>
        pipe(pending, SubscriptionRef.set(text));

      const showPending = flow(Array.join(""), Option.some, show);

      const reset = pipe(
        state,
        Ref.getAndSet(Option.none<HalfTyped>()),
        Effect.flatMap(whenSome(() => show(Option.none()))),
      );

      // A new trie must not leave a half-walked sequence behind it. A sequence
      // that was walked on the trie in force stays, however late the news: the
      // keys that the guard held play as soon as the settings load, which can
      // be before the news of their trie arrives here.
      yield* pipe(
        mappings.changes,
        Stream.runForEach(() =>
          pipe(
            Ref.get(walkedOn),
            Effect.flatMap((walked) =>
              walked === mappings.compiledUnsafe() ? Effect.void : reset,
            ),
          ),
        ),
        Effect.forkScoped,
      );

      // The release of a key that this takes stays from the page as well.
      // `Modes.bubble` keeps that record, for every mode.
      const suppressed: Effect.Effect<HandlerResult> = Effect.succeed(SUPPRESS_EVENT);

      /**
       * Run a command from inside the key task.
       *
       * The fiber starts at once, and that is what makes this correct. It runs
       * on this stack until it suspends, so a command that only calls the
       * manager — a clipboard write, for example — completes inside the
       * browser's activation window. A command that must wait for storage or
       * for another frame continues on its own afterwards, and the key task
       * returns at once. The fiber belongs to the layer scope, so a command
       * that still runs when the scope closes stops with it.
       *
       * A plain `yield*` here would be wrong. `Dom.listen` runs the key path
       * with `Effect.runSyncExitWith`, and a command that suspends would then
       * fail as a defect instead of running.
       */
      const runCommand = Effect.fnUntraced(function* (
        { command }: Pick<KeyBinding, "command">,
        count: number,
        event: KeyboardEvent,
      ) {
        yield* pipe(
          commands.run(command, { count, event: Option.some(event) }),
          Effect.catch((error) => report.error(error.detail)),
          FiberSet.run(running),
        );
      });

      /**
       * A key at the root that starts nothing.
       *
       * While `shadowNativeFind` is on, ⌘F and Ctrl+F open our find instead
       * of the find of the browser. Only a key that no mapping binds reaches
       * this, so a mapping wins, as the default `<c-f>` does. So do an
       * excluded page, a pass key and every mode above normal mode, insert
       * mode included, because each of them decides before the walk. The
       * setting is read for each key, so a change applies at once.
       *
       * Off by default: Safari on macOS lets a page prevent ⌘F, but WebKit
       * bug 191768 means that iOS may not.
       */
      const miss = (notation: string, event: KeyboardEvent): Effect.Effect<HandlerResult> =>
        pipe(
          notation,
          Option.liftPredicate(
            (key) => settings.currentUnsafe().shadowNativeFind && NATIVE_FIND_KEYS.has(key),
          ),
          Option.match({
            onNone: () => Effect.succeed(CONTINUE_BUBBLING),
            onSome: () => pipe(runCommand(OUR_FIND, 1, event), Effect.andThen(suppressed)),
          }),
        );

      /**
       * Take one key that is ours into the branch walk.
       *
       * When the key ends every live branch, the accepted binding of the branch
       * that lived longest runs. The key then goes back to `onKeydown`, so it
       * truly starts at the root. The pass keys, the media keys and the pass
       * counter all read it as a first key.
       *
       * The recursion is bounded at one call. `reset` clears every branch
       * before the key goes back, so no accepted binding can run twice.
       */
      const advance = Effect.fnUntraced(function* (
        raw: string,
        event: KeyboardEvent,
      ): Effect.fn.Return<HandlerResult> {
        const compiled = mappings.compiledUnsafe();
        // The key is ours. `mapkey` now says which binding it drives.
        const notation = pipe(
          compiled.keyRemap,
          Record.get(raw),
          Option.getOrElse(() => raw),
        );
        const current = yield* Ref.get(state);
        return yield* pipe(
          walk(compiled.trie, current, notation),
          Step.$match({
            Hold: ({ next }) =>
              pipe(
                state,
                Ref.set(Option.some(next)),
                Effect.andThen(Ref.set(walkedOn, compiled)),
                Effect.andThen(showPending(next.pending)),
                Effect.andThen(suppressed),
              ),
            // Reset first, so that a command which enters another mode finds a
            // clean normal mode underneath it.
            Fire: ({ binding, count }) =>
              pipe(
                reset,
                Effect.andThen(runCommand(binding, count, event)),
                Effect.andThen(suppressed),
              ),
            // Back to the top of the rules, and not to the branch walk. A key
            // that the exclusion or a media player owns must go to the page,
            // and `passNextKey` may have just claimed this very key.
            Restart: ({ binding, count }) =>
              pipe(
                reset,
                Effect.andThen(runCommand(binding, count, event)),
                Effect.andThen(onKeydown(event)),
              ),
            Drop: () => pipe(reset, Effect.andThen(suppressed)),
            Miss: () => pipe(reset, Effect.andThen(miss(notation, event))),
          }),
        );
      });

      const onKeydown = Effect.fnUntraced(function* (
        event: KeyboardEvent,
      ): Effect.fn.Return<HandlerResult> {
        const current = yield* Ref.get(state);
        const passes = yield* Ref.get(passNext);
        const settingsNow = settings.currentUnsafe();
        const arrival = arrivalOf({
          event,
          state: current,
          passes,
          // The platform is read once, at the build of this layer. The Option
          // rule of `keyNotation` needs it, and `domain/` may not read it.
          context: {
            ignoreKeyboardLayout: settingsNow.ignoreKeyboardLayout,
            applePlatform: capabilities.applePlatform,
          },
          verdict: exclusions.currentUnsafe(),
          passMediaKeys: settingsNow.passMediaKeys,
        });
        return yield* pipe(
          arrival,
          Arrival.$match({
            Page: () => Effect.succeed(CONTINUE_BUBBLING),
            Passed: () =>
              pipe(
                passNext,
                Ref.set(passes - 1),
                Effect.andThen(reset),
                Effect.as(CONTINUE_BUBBLING),
              ),
            Cancelled: () => pipe(reset, Effect.andThen(suppressed)),
            Media: ({ raw }) =>
              pipe(
                Effect.sync(() => mediaPlayerHasFocus(dom.document)),
                Effect.flatMap(
                  Boolean.match({
                    onFalse: () => advance(raw, event),
                    onTrue: () => Effect.succeed(CONTINUE_BUBBLING),
                  }),
                ),
              ),
            // The count prefix and the trie walk both live in `advance`, which
            // reads the state again. A binding that an earlier key accepted can
            // run there first. The key then comes back to this function, where a
            // digit is a count once more and every rule above applies again.
            Ours: ({ raw }) => advance(raw, event),
          }),
        );
      });

      /**
       * The focus moved, so a half-typed sequence is no longer live.
       *
       * A user presses `g`, clicks a search box, types a query and leaves it
       * again. The prefix stayed behind. The binding that `g` accepted then ran
       * on the next key, and the user typed that `g` minutes before.
       *
       * The reset drops the count prefix as well as the keys and the accepted
       * binding. The three are one half-typed command, and the indicator shows
       * them together. A count that outlived its keys would be invisible, and
       * the next key alone would then scroll 50 steps.
       *
       * Every focus does this, and not a focus into a text field alone. A
       * sequence that survives a focus change is a surprise in each case. The
       * cost is small, because the user types the sequence again.
       */
      const onFocus = (): Effect.Effect<HandlerResult> => pipe(reset, Effect.as(CONTINUE_BUBBLING));

      // Normal mode lives as long as the layer. It reads the exclusion verdict
      // for each key, so an excluded page needs no other mode.
      yield* modes.enter(
        {
          name: "normal",
          indicator: Option.none(),
          exitOn: [],
          keyboard: KeyPolicy.Shared(),
          singleton: Option.none(),
          tier: ModeTier.Base(),
        },
        {
          keydown: onKeydown,
          focus: onFocus,
        },
      );

      return Keyboard.of({
        pending: {
          get: SubscriptionRef.get(pending),
          changes: SubscriptionRef.changes(pending),
        },
        passNextKey: (count) => pipe(passNext, Ref.set(Math.max(1, count))),
      });
    }),
  );
}
