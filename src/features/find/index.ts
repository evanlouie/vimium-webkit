/**
 * The find subsystem (IMPLEMENTATION_PLAN.md §6.9).
 *
 * `createFind` owns the session lifecycle and is the only thing outside this
 * directory anyone should need. The engine, the query parser and the overlay
 * are exported alongside it because the command layer and the tests want them,
 * not because they are part of the runtime contract.
 */

import { Effect } from "effect";
import type { AppContext, FindApi } from "~/core/context.ts";
import {
  CONTINUE_BUBBLING,
  type HandlerResult,
  SUPPRESS_EVENT,
} from "~/core/handler-stack.ts";
import { keyNotation } from "~/core/key-notation.ts";
import {
  FindPromptMode,
  findPromptOptions,
  FindRuntime,
  PostFindMode,
  pushHistory,
  type SearchOutcome,
  wordUnderCursor,
} from "./mode.ts";
import { toRegExp, wordQuery } from "./query.ts";

export type { FindMatch, MatchSpan, TextRun } from "./engine.ts";
export {
  chunkStarts,
  collectSpans,
  collectTextRuns,
  firstMatchInView,
  locateOffset,
  matchesInRuns,
  normaliseHaystack,
  wordAt,
} from "./engine.ts";
export type { FindQueryKind, ParsedFindQuery } from "./query.ts";
export {
  escapeRegExp,
  hasUpperCase,
  parseFindQuery,
  toRegExp,
  wordQuery,
} from "./query.ts";
export type { SearchOutcome } from "./mode.ts";
export {
  FindPromptMode,
  FindRuntime,
  PostFindMode,
  pushHistory,
} from "./mode.ts";
export { FIND_CSS } from "./styles.ts";

/** Notations that open find when `shadowNativeFind` is on. */
const NATIVE_FIND_KEYS: ReadonlySet<string> = new Set(["<m-f>", "<c-f>"]);

export const createFind = (app: AppContext): FindApi => {
  const runtime = new FindRuntime(app);

  /** `?` inverts what `n` means for the rest of the session, exactly as in Vim. */
  let backwards = false;
  let prompt: FindPromptMode | null = null;

  const setStatus = (outcome: SearchOutcome, prefix: string): void => {
    const status = runtime.status(outcome);
    app.hud.setIndicator(status.length === 0 ? prefix : `${prefix} ${status}`);
  };

  const enter = (options: { readonly backwards: boolean }): void => {
    runtime.ensureStyles();
    // Cancel any in-flight prompt before replacing it, so its scroll snapshot
    // is applied rather than stranded.
    prompt?.cancel();

    backwards = options.backwards;
    runtime.clear();
    runtime.refreshRuns();

    const indicator = options.backwards ? "Find (backwards)" : "Find";
    const onInput = (value: string): void => {
      const outcome = runtime.search(value);
      setStatus(outcome, indicator);
      if (outcome.count > 0) runtime.scrollToCurrent();
    };

    const mode = new FindPromptMode({
      app,
      runtime,
      backwards: options.backwards,
      onSettled: (query) => {
        prompt = null;
        if (query === null) {
          app.hud.setIndicator(null);
          return;
        }
        commit(query);
      },
    });
    prompt = mode;
    mode.enter();
    app.hud.setIndicator(indicator);

    const history = app.groups.findHistory.current().queries;
    app.hud
      .prompt(
        findPromptOptions({ backwards: options.backwards, history, onInput }),
      )
      .then((value) => {
        if (value === null) mode.cancel();
        else mode.commit(value);
      })
      .catch((cause: unknown) => {
        mode.cancel();
        app.hud.error(
          `Find prompt failed: ${
            cause instanceof Error ? cause.message : String(cause)
          }`,
        );
      });
  };

  const commit = (query: string): void => {
    const trimmed = query.trim();
    if (trimmed.length === 0) {
      runtime.clear();
      app.hud.setIndicator(null);
      return;
    }

    app.runtime.runFork(Effect.ignore(
      app.groups.findHistory.update((current) => ({
        queries: [...pushHistory(current.queries, trimmed)],
      })),
    ));

    const outcome = runtime.search(trimmed, runtime.currentIndex);
    app.hud.setIndicator(null);

    if (outcome.error !== null) {
      app.hud.error(runtime.status(outcome));
      runtime.clear();
      return;
    }
    if (outcome.count === 0) {
      app.hud.show(`No matches for "${trimmed}"`);
      runtime.clear();
      return;
    }

    // Leaving the match selected is what lets `n`/`N`, `y` and visual mode all
    // continue from where find stopped.
    runtime.scrollToCurrent();
    runtime.selectCurrent();
    app.hud.show(runtime.status(outcome));
    new PostFindMode(app, runtime).enter();
  };

  const step = (count: number): void => {
    if (runtime.query === null) {
      app.hud.show("No previous search");
      return;
    }
    runtime.ensureStyles();
    const outcome = runtime.step(backwards ? -count : count);
    if (outcome.count === 0) {
      app.hud.show(`No matches for "${runtime.query.raw}"`);
      return;
    }
    runtime.selectCurrent();
    app.hud.show(runtime.status(outcome));
  };

  const searchWordUnderCursor = (direction: 1 | -1): void => {
    const word = wordUnderCursor();
    if (word.length === 0) {
      app.hud.show("No word under the cursor");
      return;
    }

    const query = wordQuery(word);
    const pattern = toRegExp(query);
    if (pattern === null) {
      app.hud.show("No word under the cursor");
      return;
    }

    runtime.ensureStyles();
    runtime.clear();
    runtime.refreshRuns();
    // `*` and `#` set the direction outright; upstream does the same, and it is
    // what makes a following `n` continue the way the user just went.
    backwards = direction < 0;

    const outcome = runtime.search(query.raw);
    if (outcome.count === 0) {
      app.hud.show(`No matches for "${word}"`);
      runtime.clear();
      return;
    }

    // Land on the occurrence *after* the caret, not the one under it.
    runtime.anchorToSelection();
    const stepped = runtime.step(direction);
    runtime.selectCurrent();
    app.hud.show(`${word}  ${runtime.status(stepped)}`);
    new PostFindMode(app, runtime).enter();
  };

  const clear = (): void => {
    prompt?.cancel();
    runtime.clear();
    app.hud.setIndicator(null);
  };

  /**
   * ⌘F / Ctrl+F, off by default and staying that way.
   *
   * ⌘F *is* preventable on macOS Safari, but
   * [WebKit bug 191768](https://bugs.webkit.org/show_bug.cgi?id=191768) means
   * it may not be on iOS. Stealing the native binding when we cannot reliably
   * deliver a replacement is strictly worse than not offering it, so `/` is the
   * primary binding and this is opt-in via `shadowNativeFind`.
   *
   * Registered at the *bottom* of the handler stack: every live mode gets first
   * refusal, so this can never eat a ⌘F that hint mode wanted.
   */
  app.handlerStack.unshift({
    name: "find-native-shortcut",
    keydown: (event: KeyboardEvent): HandlerResult => {
      // Read the setting per event rather than at install time, so `refresh()`
      // takes effect without re-registering.
      if (!app.settings().shadowNativeFind) return CONTINUE_BUBBLING;
      const notation = keyNotation(event, false);
      if (notation === null || !NATIVE_FIND_KEYS.has(notation)) {
        return CONTINUE_BUBBLING;
      }
      enter({ backwards: false });
      return SUPPRESS_EVENT;
    },
  });

  return { enter, step, searchWordUnderCursor, clear };
};
