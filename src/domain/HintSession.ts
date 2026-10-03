/**
 * The keystroke session of link hints, as a pure state machine.
 *
 * Ported from the Vimium `content_scripts/link_hints.js` (`AlphabetHints`,
 * `FilterHints`, and the key handling of `LinkHintsMode`), MIT.
 *
 * A session reads one key at a time. `step` takes the state and the key, and
 * it gives the next state and the commands that the runner must carry out:
 * draw again, say a line, exit, or activate an entry. Every frame of a round
 * runs the same machine over the same list, so the frames agree on what each
 * key selects without sending anything but the key.
 */

import { Array, Boolean, Data, Duration, Match, Option, pipe, String, Struct } from "effect";
import type { FrameId } from "~/domain/FrameId.ts";
import { type FilterCandidate, filterHints, type FilterOutcome } from "~/domain/HintFilter.ts";
import { hintStrings, matchByPrefix, normaliseHintCharacters } from "~/domain/HintString.ts";
import type { Settings } from "~/domain/Persisted.ts";
import type { NoFields } from "~/domain/Prelude.ts";

/** The alphabet that is used when the setting cannot give a usable one. */
const DEFAULT_HINT_CHARACTERS = "sadfjklewcmpgh";

/** The digits that are used when the setting cannot give a usable set. */
const DEFAULT_HINT_NUMBERS = "0123456789";

/** The settings that shape a session. */
export type SessionSettings = Pick<
  Settings,
  "filterLinkHints" | "linkHintCharacters" | "linkHintNumbers" | "waitForEnterForFilteredHints"
>;

/** What a session reads of one entry of the list. Filter mode matches the link text. */
export interface SessionEntry {
  readonly linkText: string;
}

/** Who drives a session, and who follows it. */
export type SessionRole = Data.TaggedEnum<{
  /**
   * This frame drives the session.
   *
   * `crossFrame` sends each keystroke to the other frames, so they stay in
   * step. `buffered` holds the keys that arrived while the round was collected.
   */
  Origin: { readonly crossFrame: boolean; readonly buffered: readonly string[] };
  /** Another frame drives the session, and this frame draws and follows. */
  Participant: { readonly driver: FrameId };
}>;

export const SessionRole = Data.taggedEnum<SessionRole>();

/** Is the session driven by this frame? */
export const drivenBy = (from: FrameId): ((role: SessionRole) => boolean) =>
  SessionRole.$match({
    Origin: () => false,
    Participant: ({ driver }) => driver === from,
  });

/** What one key does in a hint session. */
export type SessionKey = Data.TaggedEnum<{
  Escape: NoFields;
  /** Backspace, or Delete. */
  Erase: NoFields;
  Enter: NoFields;
  /** Tab, or Shift-Tab. */
  Cycle: { readonly direction: 1 | -1 };
  /** A printable character. */
  Type: { readonly char: string };
  Ignore: NoFields;
}>;

const SessionKey = Data.taggedEnum<SessionKey>();

/** `"a"` types `"a"`, `"<space>"` types `" "`, and `"<c-a>"` does nothing. */
export const readKey = (notation: string): SessionKey =>
  pipe(
    Match.value(notation),
    Match.withReturnType<SessionKey>(),
    Match.when("<esc>", () => SessionKey.Escape()),
    Match.whenOr("<backspace>", "<delete>", () => SessionKey.Erase()),
    Match.when("<enter>", () => SessionKey.Enter()),
    Match.when("<tab>", () => SessionKey.Cycle({ direction: 1 })),
    Match.when("<s-tab>", () => SessionKey.Cycle({ direction: -1 })),
    Match.when("<space>", () => SessionKey.Type({ char: " " })),
    // A key notation is one Unicode code point, or a token inside brackets.
    Match.when(
      (key) => Array.fromIterable(key).length === 1,
      (char) => SessionKey.Type({ char }),
    ),
    Match.orElse(() => SessionKey.Ignore()),
  );

/**
 * What filter mode does with the one candidate that the query names without
 * doubt. `waitForEnterForFilteredHints` asks for `Confirm`.
 */
export type SoleMatch = Data.TaggedEnum<{
  /** Activate it at once. */
  Activate: NoFields;
  /** Activate it on Enter, or after a pause in the typing. */
  Confirm: NoFields;
}>;

const SoleMatch = Data.taggedEnum<SoleMatch>();

/** Where a session stands, and the rules of its mode. */
export type SessionState = Data.TaggedEnum<{
  /** Alphabet mode. `typed` is the queue of keystrokes, matched by prefix. */
  Alphabet: {
    readonly alphabet: string;
    readonly hints: readonly string[];
    readonly typed: string;
  };
  /**
   * Filter mode. `text` is the queue of keystrokes for the link text, and
   * `digits` is the queue of digit keystrokes. `activeIndex` is the candidate
   * that Tab moved to.
   */
  Filter: {
    readonly numbers: string;
    readonly candidates: readonly FilterCandidate[];
    readonly soleMatch: SoleMatch;
    readonly text: string;
    readonly digits: string;
    readonly activeIndex: number;
    readonly outcome: FilterOutcome;
  };
}>;

export const SessionState = Data.taggedEnum<SessionState>();

export type AlphabetState = Data.TaggedEnum.Value<SessionState, "Alphabet">;
export type FilterState = Data.TaggedEnum.Value<SessionState, "Filter">;

/** How long "No matching hint" stays on screen. */
const NO_MATCH_DURATION = Duration.millis(800);

/** Why a session asks to end: the user left it, or it has nothing more to do. */
export type SessionExit = "escape" | "explicit";

/** What a session asks its runner to do after a key. */
export type SessionCommand = Data.TaggedEnum<{
  /** Take away the confirmation that waits. */
  CancelConfirm: NoFields;
  Render: NoFields;
  /**
   * A line for the HUD. Only the origin speaks, so the page gets one line.
   * `None` keeps the line for the usual time of the HUD.
   */
  Say: { readonly text: string; readonly duration: Option.Option<Duration.Duration> };
  Exit: { readonly reason: SessionExit };
  /** Act on the entry at `index` now. */
  Activate: { readonly index: number };
  /** Act on the entry at `index` after a pause in the typing. */
  Confirm: { readonly index: number };
}>;

export const SessionCommand = Data.taggedEnum<SessionCommand>();

export interface Transition {
  readonly state: SessionState;
  readonly commands: readonly SessionCommand[];
}

const stay = (state: SessionState): Transition => ({ state, commands: [] });

const leave = (state: SessionState): Transition => ({
  state,
  commands: [SessionCommand.Exit({ reason: "escape" })],
});

const alphabetSession = (
  settings: SessionSettings,
  entries: readonly SessionEntry[],
): SessionState => {
  const alphabet = normaliseHintCharacters(settings.linkHintCharacters, DEFAULT_HINT_CHARACTERS);
  return SessionState.Alphabet({
    alphabet,
    hints: hintStrings(entries.length, alphabet),
    typed: "",
  });
};

const filterSession = (
  settings: SessionSettings,
  entries: readonly SessionEntry[],
): SessionState => {
  const numbers = normaliseHintCharacters(settings.linkHintNumbers, DEFAULT_HINT_NUMBERS);
  const candidates = pipe(
    entries,
    Array.map((entry, index) => ({ index, linkText: entry.linkText })),
  );
  return SessionState.Filter({
    numbers,
    candidates,
    soleMatch: pipe(
      settings.waitForEnterForFilteredHints,
      Boolean.match({ onFalse: () => SoleMatch.Activate(), onTrue: () => SoleMatch.Confirm() }),
    ),
    text: "",
    digits: "",
    activeIndex: 0,
    outcome: filterHints(candidates, { text: "", digits: "", numberCharacters: numbers }),
  });
};

/** The session that the settings ask for. */
export const initialState = (
  settings: SessionSettings,
  entries: readonly SessionEntry[],
): SessionState =>
  pipe(
    settings.filterLinkHints,
    Boolean.match({
      onFalse: () => alphabetSession(settings, entries),
      onTrue: () => filterSession(settings, entries),
    }),
  );

/**
 * The buffered keys that a new session replays.
 *
 * Filter mode only. In alphabet mode the buffered characters were typed
 * against hint strings that did not exist yet, so a replay would activate a
 * link that is as good as random.
 */
export const replayable = (state: SessionState, keys: readonly string[]): readonly string[] =>
  pipe(
    state,
    SessionState.$match({
      Alphabet: () => Array.empty<string>(),
      Filter: () => keys,
    }),
  );

/** Is the hint at `index` exactly the keys that were typed? */
const isTypedHint =
  (hints: readonly string[], typed: string) =>
  (index: number): boolean =>
    pipe(hints, Array.get(index), Option.contains(typed));

/** What alphabet mode does with the keys typed so far. */
const alphabetFeedback = ({ hints, typed }: AlphabetState): readonly SessionCommand[] =>
  pipe(
    matchByPrefix(hints, typed),
    Array.match({
      onEmpty: () => [
        SessionCommand.Say({ text: "No matching hint", duration: Option.some(NO_MATCH_DURATION) }),
        SessionCommand.Exit({ reason: "explicit" }),
      ],
      onNonEmpty: (matches) =>
        pipe(
          matches,
          Option.liftPredicate((matches) => matches.length === 1),
          Option.map(Array.headNonEmpty),
          Option.filter(isTypedHint(hints, typed)),
          Option.match({
            onNone: () => [SessionCommand.Render()],
            onSome: (index) => [SessionCommand.Activate({ index })],
          }),
        ),
    }),
  );

const retype = (state: AlphabetState, typed: string): Transition => {
  const next = pipe(state, Struct.assign({ typed }));
  return {
    state: next,
    commands: pipe(alphabetFeedback(next), Array.prepend(SessionCommand.CancelConfirm())),
  };
};

const alphabetKey = (state: AlphabetState): ((key: SessionKey) => Transition) =>
  SessionKey.$match({
    Escape: () => leave(state),
    Erase: () =>
      pipe(
        state.typed,
        Option.liftPredicate(String.isNonEmpty),
        Option.match({
          onNone: () => leave(state),
          onSome: (typed) => retype(state, typed.slice(0, -1)),
        }),
      ),
    Enter: () => stay(state),
    Cycle: () => stay(state),
    Type: ({ char }) =>
      pipe(
        char.toLowerCase(),
        Option.liftPredicate((lower) => state.alphabet.includes(lower)),
        Option.match({
          onNone: () => stay(state),
          onSome: (lower) => retype(state, state.typed + lower),
        }),
      ),
    Ignore: () => stay(state),
  });

/** The query that the HUD echoes. */
const filterQuery = ({ text, digits }: FilterState): string => `${text}${digits}`.trim();

/**
 * Activate the one candidate that the query names without doubt.
 *
 * Confirmation: Enter activates at once, and so does a pause in the typing.
 * The pause matters, because filter mode narrows to one match long before the
 * user has finished the word.
 */
const exactActivation = ({ outcome, soleMatch }: FilterState): Option.Option<SessionCommand> =>
  pipe(
    outcome.exact,
    Option.filter(() => outcome.candidates.length === 1),
    Option.map(({ index }) =>
      pipe(
        soleMatch,
        SoleMatch.$match({
          Activate: () => SessionCommand.Activate({ index }),
          Confirm: () => SessionCommand.Confirm({ index }),
        }),
      ),
    ),
  );

/** What filter mode says and does after it filtered again. */
const filterFeedback = (state: FilterState): readonly SessionCommand[] =>
  pipe(
    state.outcome.candidates,
    Array.match({
      onEmpty: () => [
        SessionCommand.Say({
          text: `No matches for "${filterQuery(state)}"`,
          duration: Option.none(),
        }),
      ],
      onNonEmpty: () =>
        Array.getSomes([
          pipe(
            filterQuery(state),
            Option.liftPredicate(String.isNonEmpty),
            Option.map((text) => SessionCommand.Say({ text, duration: Option.none() })),
          ),
          exactActivation(state),
        ]),
    }),
  );

/** Filter again after a queue changed. The first candidate becomes active. */
const refilter = (state: FilterState): Transition => {
  const outcome = filterHints(state.candidates, {
    text: state.text,
    digits: state.digits,
    numberCharacters: state.numbers,
  });
  const next = pipe(state, Struct.assign({ outcome, activeIndex: 0 }));
  return {
    state: next,
    commands: pipe(
      [SessionCommand.CancelConfirm(), SessionCommand.Render()],
      Array.appendAll(filterFeedback(next)),
    ),
  };
};

/** Backspace takes the last digit, then the last character of the text, and then leaves. */
const eraseFilter = (state: FilterState): Transition =>
  pipe(
    Match.value(state),
    Match.when(
      ({ digits }) => digits.length > 0,
      (state) => pipe(state, Struct.assign({ digits: state.digits.slice(0, -1) }), refilter),
    ),
    Match.when(
      ({ text }) => text.length > 0,
      (state) => pipe(state, Struct.assign({ text: state.text.slice(0, -1) }), refilter),
    ),
    Match.orElse(leave),
  );

/** A digit goes to the digit queue, and every other character to the text. */
const typeFilter = (state: FilterState, char: string): FilterState =>
  pipe(
    state.numbers.includes(char),
    Boolean.match({
      onFalse: () => pipe(state, Struct.assign({ text: state.text + char })),
      onTrue: () => pipe(state, Struct.assign({ digits: state.digits + char })),
    }),
  );

/** Tab is an explicit "not that one". It takes away any activation that waits. */
const cycleFilter = (state: FilterState, direction: 1 | -1): Transition =>
  pipe(
    state.outcome.candidates.length,
    Option.liftPredicate((count) => count > 0),
    Option.match({
      onNone: () => stay(state),
      onSome: (count) => ({
        state: pipe(
          state,
          Struct.assign({ activeIndex: (state.activeIndex + direction + count) % count }),
        ),
        commands: [SessionCommand.CancelConfirm(), SessionCommand.Render()],
      }),
    }),
  );

const filterKey = (state: FilterState): ((key: SessionKey) => Transition) =>
  SessionKey.$match({
    Escape: () => leave(state),
    Erase: () => eraseFilter(state),
    Enter: () => ({
      state,
      commands: pipe(
        state.outcome.candidates,
        Array.get(state.activeIndex),
        Option.map(({ index }) => SessionCommand.Activate({ index })),
        Option.toArray,
      ),
    }),
    Cycle: ({ direction }) => cycleFilter(state, direction),
    Type: ({ char }) => refilter(typeFilter(state, char)),
    Ignore: () => stay(state),
  });

/** The next state of a session after one key, and what the session must do. */
export const step = (state: SessionState, key: SessionKey): Transition =>
  pipe(
    state,
    SessionState.$match({
      Alphabet: (alphabet) => pipe(key, alphabetKey(alphabet)),
      Filter: (filter) => pipe(key, filterKey(filter)),
    }),
  );
