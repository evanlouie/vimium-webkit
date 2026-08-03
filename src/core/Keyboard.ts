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
 * suspend. Read `ARCHITECTURE.md` section 3.
 */

import {
  Context,
  Effect,
  Exit,
  Layer,
  Option,
  Ref,
  Scope,
  Stream,
  SubscriptionRef,
} from "effect";
import { isPassKey } from "~/domain/Exclusion.ts";
import { appendCountDigit, isCountDigit } from "~/domain/Key.ts";
import { isComposing, isModifierKey, keyNotation } from "~/domain/Key.ts";
import {
  canExtend,
  deepestBranch,
  extendBranches,
  type KeyBranch,
  openBranch,
} from "~/domain/Mapping.ts";
import { Dom } from "~/platform/Dom.ts";
import { mediaPlayerHasFocus } from "~/platform/Elements.ts";
import { Realm } from "~/platform/Realm.ts";
import { Commands } from "./Commands.ts";
import { Exclusions } from "./Exclusions.ts";
import {
  CONTINUE_BUBBLING,
  type HandlerResult,
  SUPPRESS_EVENT,
} from "./HandlerStack.ts";
import { Mappings } from "./Mappings.ts";
import { isEscape, Modes } from "./Modes.ts";
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
 * Did the browser make this event, or did the page?
 *
 * A page can call `dispatchEvent` with a `KeyboardEvent` that names any key.
 * The browser marks such an event `isTrusted === false`, and only the browser
 * can set the flag to `true`. A synthetic key must therefore never reach a
 * command. A command can open a tab, navigate, close a tab or write the
 * clipboard, and the user pressed nothing.
 *
 * The test is strict on purpose. `dispatchEvent` refuses an object that is not
 * an `Event`, but other paths do not. A page can hand such an object to a
 * handler of ours directly, so every value except `true` is refused.
 */
export const isUserEvent = (event: Pick<Event, "isTrusted">): boolean =>
  event.isTrusted === true;

/**
 * The key state, in the per-branch model.
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
 * is new. The attempt at `abc` consumes the keystroke `b`: `advance` suppresses
 * the key, and the pending indicator shows it. The binding of `b` therefore
 * never runs, and a stray key after it runs the binding of `a`.
 */
interface KeyState {
  /** Every live branch, shallowest first. Empty means "at the root". */
  readonly branches: ReadonlyArray<KeyBranch>;
  readonly count: number;
  readonly pending: ReadonlyArray<string>;
}

export class Keyboard extends Context.Service<Keyboard, {
  /** The half-typed sequence, for the HUD. `null` when there is none. */
  readonly pending: SubscriptionRef.SubscriptionRef<string | null>;

  /**
   * Enter or leave normal mode, to match the exclusion verdict now.
   *
   * A fiber already follows the verdict, and a fiber runs later. The start path
   * replays the keys that the user pressed while the application was building,
   * so it must know that normal mode is live *before* it replays them.
   */
  readonly syncExclusion: Effect.Effect<void>;

  /** Give the next `count` keystrokes to the page, without reading them. */
  readonly passNextKey: (count: number) => Effect.Effect<void>;

  /**
   * Forget which presses we took.
   *
   * A press whose release we will never see leaves normal mode waiting for a
   * `keyup` that never comes. The everyday case is a window switch in the
   * middle of a keystroke. The next release of that physical key would then be
   * taken from a page that was entitled to it.
   */
  readonly forgetSuppressed: Effect.Effect<void>;
}>()("vimium/core/Keyboard") {
  static readonly layer: Layer.Layer<
    Keyboard,
    never,
    | Commands
    | Dom
    | Exclusions
    | Mappings
    | Modes
    | Realm
    | Report
    | Settings
  > = Layer.effect(
    Keyboard,
    Effect.gen(function*() {
      const commands = yield* Commands;
      const dom = yield* Dom;
      const exclusions = yield* Exclusions;
      const mappings = yield* Mappings;
      const modes = yield* Modes;
      const realm = yield* Realm;
      const report = yield* Report;
      const settings = yield* Settings;

      const pending = yield* SubscriptionRef.make<string | null>(null);
      const state = yield* Ref.make<KeyState>({
        branches: [],
        count: 0,
        pending: [],
      });
      const passNext = yield* Ref.make(0);
      // The `event.code` values whose `keydown` we took. A page that listens
      // for `keyup` must not see a release for a press that it never saw. It is
      // keyed on `code` and not on `key`, because the modifier state can change
      // between the press and the release.
      const suppressedCodes = yield* Ref.make<ReadonlySet<string>>(new Set());

      const reset = Effect.gen(function*() {
        const current = yield* Ref.get(state);
        yield* Ref.set(state, { branches: [], count: 0, pending: [] });
        if (current.pending.length > 0) {
          yield* SubscriptionRef.set(pending, null);
        }
      });

      // A new trie must not leave a half-walked sequence behind it.
      yield* Effect.forkScoped(
        Stream.runForEach(Stream.drop(mappings.changes, 1), () => reset),
      );

      const suppress = (event: KeyboardEvent): Effect.Effect<HandlerResult> =>
        Effect.gen(function*() {
          if (event.code) {
            yield* Ref.update(
              suppressedCodes,
              (current) => new Set(current).add(event.code),
            );
          }
          return SUPPRESS_EVENT;
        });

      const showPending = (
        keys: ReadonlyArray<string>,
      ): Effect.Effect<void> =>
        SubscriptionRef.set(
          pending,
          keys.length === 0 ? null : keys.join(""),
        );

      /**
       * `0` is a count digit only once a count is under way. Otherwise it is a
       * key that a user may bind, and upstream binds it to `scrollToLeft`.
       *
       * `1` to `9` give way to an explicit binding for the same reason. They
       * used to be taken unconditionally, so `map 1 scrollDown` compiled with no
       * diagnostic and could never fire — and it also ate the keystroke and held
       * `1` in the HUD until the user pressed Escape.
       */
      const isCountKey = (current: KeyState, notation: string): boolean => {
        if (current.branches.length > 0) return false;
        if (!isCountDigit(notation, current.count > 0)) return false;
        if (current.count > 0) return true;
        return !mappings.compiledUnsafe().trie.children.has(notation);
      };

      /**
       * Run a command from inside the key task.
       *
       * `startImmediately` is what makes this correct. The fiber runs on this
       * stack until it suspends, so a command that only calls the manager — a
       * clipboard write, for example — completes inside the browser's
       * activation window. A command that must wait for storage or for another
       * frame continues on its own afterwards, and the key task returns at
       * once.
       *
       * A plain `yield*` here would be wrong. The listener runs the key path
       * with `runSyncExit`, and a command that suspends would then fail as a
       * defect instead of running.
       */
      const runCommand = (
        name: string,
        options: Readonly<Record<string, string | boolean>>,
        count: number,
        event: KeyboardEvent,
      ): Effect.Effect<void> =>
        Effect.gen(function*() {
          // Woken here, and not eagerly. A child frame must not be forced
          // through a full start unless a cross-frame function needs it.
          if (name.startsWith("LinkHints.")) yield* realm.wakeDescendants;
          yield* Effect.forkDetach(
            Effect.catch(
              commands.run(name, { count, options, event }),
              (error) => report.error(error.detail),
            ),
            { startImmediately: true },
          );
        });

      /**
       * Take one key into the branch walk.
       *
       * The key extends every live branch. A branch that has no child for the
       * key dies, and its accepted binding dies with it. The root opens a new
       * branch, which has accepted nothing that an earlier key typed.
       *
       * When the key ends every live branch, the accepted binding of the branch
       * that lived longest runs. The key then goes back to `onKeydown`, so it
       * truly starts at the root. The pass keys, the media keys and the pass
       * counter all read it as a first key.
       *
       * The recursion is bounded at one call. `reset` clears every branch
       * before the key goes back, so no accepted binding can run twice.
       */
      const advance = (
        notation: string,
        event: KeyboardEvent,
      ): Effect.Effect<HandlerResult> =>
        Effect.gen(function*() {
          const current = yield* Ref.get(state);

          if (isCountKey(current, notation)) {
            const nextPending = [...current.pending, notation];
            yield* Ref.set(state, {
              branches: current.branches,
              count: appendCountDigit(current.count, notation),
              pending: nextPending,
            });
            yield* showPending(nextPending);
            return yield* suppress(event);
          }

          // Every live branch takes the key, or it dies here.
          const extended = extendBranches(current.branches, notation);
          const deepestDead = deepestBranch(current.branches);

          // The key ended every live attempt, and the attempt that lived
          // longest accepted a binding. The binding runs now, with the count
          // that the user typed in front of it. The key then starts again at
          // the root. Without this, `map g scrollUp` could never run while
          // `map gg scrollToTop` also existed.
          if (
            extended.length === 0 && Option.isSome(deepestDead) &&
            Option.isSome(deepestDead.value.accepted)
          ) {
            const { command, options } = deepestDead.value.accepted.value;
            const count = current.count === 0 ? 1 : current.count;
            yield* reset;
            yield* runCommand(command, options, count, event);
            // Back to the top of the rules, and not to the branch walk. A key
            // that the exclusion or a media player owns must go to the page,
            // and `passNextKey` may have just claimed this very key.
            return yield* onKeydown(event);
          }

          // A new branch is one key deep, so it goes in front of the others.
          // The cursor stays shallowest first, and the deepest branch stays
          // last.
          const opened = openBranch(mappings.compiledUnsafe().trie, notation);
          const branches = Option.isSome(opened)
            ? [opened.value, ...extended]
            : extended;

          if (branches.length === 0) {
            const wasPartial = current.branches.length > 0 || current.count > 0;
            yield* reset;
            // A sequence that ran out is still ours. The user typed `g` on
            // purpose, so giving the next key to the page would be a surprise.
            // A key that never matched anything passes straight through.
            return wasPartial ? yield* suppress(event) : CONTINUE_BUBBLING;
          }

          // The deepest branch decides, because it is the longest attempt.
          // While its node can take another key, the attempt is not finished.
          // Firing the shorter binding here is what made `map gg` unreachable
          // behind `map g`.
          const deepest = deepestBranch(branches);

          if (
            Option.isSome(deepest) && !canExtend(deepest.value) &&
            Option.isSome(deepest.value.accepted)
          ) {
            const { command, options } = deepest.value.accepted.value;
            const count = current.count === 0 ? 1 : current.count;
            // Reset first, so that a command which enters another mode finds a
            // clean normal mode underneath it.
            yield* reset;
            yield* runCommand(command, options, count, event);
            return yield* suppress(event);
          }

          const nextPending = [...current.pending, notation];
          yield* Ref.set(state, {
            branches,
            count: current.count,
            pending: nextPending,
          });
          yield* showPending(nextPending);
          return yield* suppress(event);
        });

      const onKeydown = (
        event: KeyboardEvent,
      ): Effect.Effect<HandlerResult> =>
        Effect.gen(function*() {
          // A key that the page made. It gives no command, and it does not
          // touch the pending sequence.
          if (!isUserEvent(event)) return CONTINUE_BUBBLING;

          // Composition, from an input method or from a dead key. Without this
          // guard we eat keystrokes in the middle of composition, which is the
          // most damaging failure for a user of a CJK language, and one that
          // the user cannot work around.
          if (isComposing(event) || isModifierKey(event)) {
            return CONTINUE_BUBBLING;
          }

          const current = yield* Ref.get(state);
          const settingsNow = settings.currentUnsafe();
          const rawKey = keyNotation(event, settingsNow.ignoreKeyboardLayout);
          if (Option.isNone(rawKey)) return CONTINUE_BUBBLING;
          const raw = rawKey.value;

          const remaining = yield* Ref.get(passNext);
          if (remaining > 0) {
            yield* Ref.set(passNext, remaining - 1);
            yield* reset;
            return CONTINUE_BUBBLING;
          }

          const atRoot = current.branches.length === 0 && current.count === 0;

          if (isEscape(event)) {
            if (atRoot) return CONTINUE_BUBBLING;
            yield* reset;
            return yield* suppress(event);
          }

          // Every pass-through rule reads the *raw* notation, and not the
          // remapped one. The user gives a physical key to the page, and
          // `mapkey` describes what the key does for us. A test against the
          // remapped notation captured a key that the exclusion promised to
          // the page. It also gave away a key that no rule named.

          // A pass key applies to a new sequence only. Once the user has
          // committed to `g`, the next key is ours even if it is in the set.
          if (atRoot && isPassKey(exclusions.effectiveUnsafe(), raw)) {
            return CONTINUE_BUBBLING;
          }

          // The same rule for the keys that a focused media player owns. The
          // cheap set lookup goes first, because the check behind it walks the
          // document.
          if (
            atRoot && MEDIA_KEYS.has(raw) &&
            settingsNow.passMediaKeys &&
            mediaPlayerHasFocus(dom.document)
          ) {
            return CONTINUE_BUBBLING;
          }

          // The key is ours. `mapkey` now says which binding it drives.
          const notation = mappings.compiledUnsafe().keyRemap.get(raw) ?? raw;

          // The count prefix and the trie walk both live in `advance`, which
          // reads the state again. A binding that an earlier key accepted can
          // run there first. The key then comes back to this function, where a
          // digit is a count once more and every rule above applies again.
          return yield* advance(notation, event);
        });

      const onKeyup = (event: KeyboardEvent): Effect.Effect<HandlerResult> =>
        Effect.gen(function*() {
          if (!isUserEvent(event)) return CONTINUE_BUBBLING;
          if (!event.code) return CONTINUE_BUBBLING;
          const taken = yield* Ref.modify(
            suppressedCodes,
            (current) => {
              if (!current.has(event.code)) return [false, current];
              const next = new Set(current);
              next.delete(event.code);
              return [true, next as ReadonlySet<string>];
            },
          );
          return taken ? SUPPRESS_EVENT : CONTINUE_BUBBLING;
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
      const onFocus = (): Effect.Effect<HandlerResult> =>
        Effect.as(reset, CONTINUE_BUBBLING);

      /**
       * Normal mode follows the exclusion verdict.
       *
       * The mode lives in its own child scope. Closing that scope removes the
       * handler and every finalizer that the mode registered. Nothing has to
       * remember what to undo.
       */
      const modeScope = yield* Ref.make<Option.Option<Scope.Closeable>>(
        Option.none(),
      );

      const exitNormal = Effect.gen(function*() {
        const open = yield* Ref.getAndSet(modeScope, Option.none());
        if (Option.isSome(open)) yield* Scope.close(open.value, Exit.void);
      });

      const enterNormal = Effect.gen(function*() {
        if (Option.isSome(yield* Ref.get(modeScope))) return;
        const scope = yield* Scope.make();
        yield* reset;
        const handle = yield* Effect.provideService(
          modes.enter({ name: "normal" }, {
            keydown: onKeydown,
            keyup: onKeyup,
            focus: onFocus,
          }),
          Scope.Scope,
          scope,
        );
        yield* Ref.set(modeScope, Option.some(scope));
        // The scope must go when the mode goes. `Modes.exitAll` ends every live
        // mode, and a soft navigation calls it, so normal mode can exit without
        // this service. The scope would then stay, the test above would refuse
        // to build the mode again, and the page would keep no key bindings at
        // all after a `pushState`.
        yield* handle.onExit(() => exitNormal);
      });

      const syncExclusion = Effect.flatMap(
        SubscriptionRef.get(exclusions.effective),
        (rule) => rule.enabled ? enterNormal : exitNormal,
      );

      yield* syncExclusion;
      yield* Effect.forkScoped(
        Stream.runForEach(
          Stream.drop(SubscriptionRef.changes(exclusions.effective), 1),
          (rule) => rule.enabled ? enterNormal : exitNormal,
        ),
      );

      yield* Effect.addFinalizer(() => exitNormal);

      return Keyboard.of({
        pending,
        syncExclusion,
        passNextKey: (count) => Ref.set(passNext, Math.max(1, count)),
        forgetSuppressed: Ref.set(suppressedCodes, new Set()),
      });
    }),
  );
}
