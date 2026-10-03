/**
 * The help dialog and the settings dialog.
 *
 * Upstream Vimium draws both in a `web_accessible_resources` iframe. We have no
 * such origin, so both are plain DOM inside the closed shadow root.
 *
 * Everything is built with `createElement` and `textContent`. There is no
 * `innerHTML` in this file. A command description and a key binding are partly
 * text that the user wrote, and a userscript that could be made to put markup
 * into its own overlay would be a true weakness.
 *
 * The dialog owns the keyboard while it is open. It does that with a mode whose
 * key handler answers `SUPPRESS_PROPAGATION`: normal mode and the page see
 * nothing, and the default action stays, so the user can still type into the
 * text areas. Tab is the one exception. Both dialogs say `aria-modal="true"`,
 * which promises that the rest of the page is unavailable, so the mode takes
 * Tab and moves the focus by hand inside the dialog. The dialog also gives the
 * focus back to the element that had it.
 *
 * The settings form is data. `SETTINGS_SECTIONS` names every documented
 * setting, and the build step below draws the controls from that list. The
 * README promises that all of them are editable here, and only a list that a
 * test can read against the schema keeps that promise true.
 */

import {
  Array,
  Boolean,
  Data,
  Deferred,
  Effect,
  FiberHandle,
  flow,
  Function,
  Layer,
  Match,
  Option,
  Record,
  Scope,
  pipe,
  Struct,
} from "effect";
import { Commands } from "~/core/Commands.ts";
import { type HandlerResult, SUPPRESS_EVENT, SUPPRESS_PROPAGATION } from "~/core/HandlerStack.ts";
import { Mappings } from "~/core/Mappings.ts";
import { ExitTrigger, KeyPolicy, Modes } from "~/core/Modes.ts";
import { recoverUnlessInterrupted } from "~/core/Recovery.ts";
import { Report } from "~/core/Report.ts";
import { Settings } from "~/core/Settings.ts";
import {
  CommandAvailability,
  type CommandDef,
  type CommandGroup,
  DEFAULT_MAPPINGS,
} from "~/domain/Command.ts";
import { exclusionProblems, parseExclusionLines } from "~/domain/Exclusion.ts";
import { type CompiledMappings, formatDiagnostics, keysByCommand } from "~/domain/Mapping.ts";
import {
  defaultSettings,
  type ExclusionRule,
  HISTORY_INDEX_LIMIT_BOUNDS,
  MIN_HINT_CHARACTERS,
  SCROLL_STEP_BOUNDS,
  type SettingBounds,
  type Settings as SettingsData,
} from "~/domain/Persisted.ts";
import type { NoFields } from "~/domain/Prelude.ts";
import { Capabilities, formatCapabilities } from "~/platform/Capabilities.ts";
import { Dom } from "~/platform/Dom.ts";
import { deepActiveElement } from "~/platform/Elements.ts";
import type { StoreKind } from "~/platform/Gm.ts";
import { acceptPointerEvents, Ui } from "~/ui/Ui.ts";

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

const STORAGE_PREAMBLE = "There is no options page for a userscript, so settings " + "live here. ";

/**
 * Where the settings in this dialog are kept.
 *
 * The explanation identifies the selected storage surface because it changes
 * persistence. It must agree with `Capabilities`.
 */
const storageExplanation = (backend: StoreKind): string =>
  pipe(
    Match.value(backend),
    Match.tag(
      "GmSync",
      "GmAsync",
      () =>
        `${STORAGE_PREAMBLE}They are stored with your userscript manager, which ` +
        "is durable and survives Safari's seven-day storage purge.",
    ),
    Match.tag(
      "Memory",
      () =>
        `${STORAGE_PREAMBLE}No storage is available at all, so they last only ` +
        "until this page is closed.",
    ),
    Match.exhaustive,
  );

const GROUP_TITLES: Readonly<Record<CommandGroup, string>> = {
  navigation: "Navigating the page",
  scrolling: "Scrolling",
  hints: "Link hints",
  find: "Finding text",
  text: "Text and selection",
  tabs: "Tabs and windows",
  clipboard: "Clipboard",
  marks: "Marks",
  misc: "Miscellaneous",
};

const GROUP_ORDER: readonly CommandGroup[] = [
  "navigation",
  "scrolling",
  "hints",
  "find",
  "text",
  "clipboard",
  "marks",
  "tabs",
  "misc",
];

// ---------------------------------------------------------------------------
// The settings fields
// ---------------------------------------------------------------------------

/** The name of one stored setting. */
export type SettingsKey = keyof SettingsData;

/**
 * How one text control reads the text of the user.
 *
 * - `Line` is a single-line input. A text shorter than `minLength` gives no
 *   value, so `write` keeps the stored one.
 * - `Number` is a numeric input. `write` brings the number into `min` and
 *   `max`, and it drops the decimals.
 * - `Block` is a text area. `problems` names each line that the stored value
 *   drops.
 */
export type EntryInput = Data.TaggedEnum<{
  Line: { readonly minLength: number };
  Number: { readonly min: number; readonly max: number };
  Block: {
    /** The smallest height of the text area, as a CSS length. */
    readonly minHeight: string;
    readonly problems: (text: string) => ReadonlyArray<string>;
  };
}>;
export const EntryInput = Data.taggedEnum<EntryInput>();

interface FieldBase {
  /**
   * The stored setting that this control edits.
   *
   * The key is data, and not a route to the value: a key of a union type
   * cannot be written back into a struct without a cast, and there is no cast
   * in this application. `read` and `write` do the work. The key exists so
   * that a test can compare the form against the schema, which is how eight
   * documented settings came to have no control at all.
   */
  readonly key: SettingsKey;
  readonly label: string;
  /** A remark that the label carries after its text. */
  readonly note: Option.Option<string>;
}

/** How a control reads its value from the settings, and writes it back. */
interface Access<A> {
  readonly read: (settings: SettingsData) => A;
  readonly write: (settings: SettingsData, value: A) => SettingsData;
}

/**
 * One control of the settings dialog.
 *
 * A `Toggle` is one checkbox. An `Entry` is one text control, and `input` says
 * which. Each entry reads and writes text, so a list and a number carry their
 * own conversion in `read` and `write`.
 */
export type SettingsField = Data.TaggedEnum<{
  Toggle: FieldBase & Access<boolean>;
  Entry: FieldBase & Access<string> & { readonly input: EntryInput };
}>;
export const SettingsField = Data.taggedEnum<SettingsField>();

export type ToggleField = Data.TaggedEnum.Value<SettingsField, "Toggle">;
export type EntryField = Data.TaggedEnum.Value<SettingsField, "Entry">;

/** One titled group of controls in the dialog. */
export interface SettingsSection {
  readonly title: string;
  readonly description: Option.Option<string>;
  readonly fields: readonly SettingsField[];
}

/** A number of the text, or `None` for a text that holds no number at all. */
const wholeNumber = (text: string): Option.Option<number> =>
  pipe(
    Number.parseInt(text, 10),
    Option.liftPredicate((value: number) => Number.isFinite(value)),
  );

/** Text that holds no number at all. `write` then keeps the stored value. */
const notANumber = (text: string): boolean => Option.isNone(wholeNumber(text));

/** A number that `write` brings into the range of this control. */
const outsideRange = (min: number, max: number, text: string): boolean =>
  pipe(
    wholeNumber(text),
    Option.exists((value) => value < min || value > max),
  );

/**
 * Text that holds a number with decimals. `write` truncates it.
 *
 * `Number.parseFloat` reads the whole number, and `Number.parseInt` reads the
 * part before the point. The two differ exactly when the control truncated
 * what the user typed.
 */
const notWhole = (text: string): boolean => {
  const full = Number.parseFloat(text);
  return Number.isFinite(full) && !Number.isInteger(full);
};

/** What the table below says about each control, before the defaults apply. */
interface FieldSpec {
  readonly key: SettingsKey;
  readonly label: string;
  readonly note?: string;
}

/** One checkbox. */
const toggle = ({ key, label, note, read, write }: FieldSpec & Access<boolean>): SettingsField =>
  SettingsField.Toggle({ key, label, note: Option.fromNullishOr(note), read, write });

/** One single-line input. A text shorter than `minLength` keeps the stored value. */
const line = ({
  key,
  label,
  note,
  minLength = 0,
  read,
  write,
}: FieldSpec & Access<string> & { readonly minLength?: number }): SettingsField =>
  SettingsField.Entry({
    key,
    label,
    note: Option.fromNullishOr(note),
    input: EntryInput.Line({ minLength }),
    read,
    write: (settings, text) =>
      pipe(
        text,
        Option.liftPredicate((offered: string) => offered.length >= minLength),
        Option.match({
          onNone: () => settings,
          onSome: (offered) => write(settings, offered),
        }),
      ),
  });

/**
 * One numeric input, for a whole number inside `bounds`.
 *
 * `write` brings the number into range and drops its decimals. A text with no
 * number keeps the stored value.
 */
const whole = ({
  key,
  label,
  note,
  bounds: { min, max },
  read,
  write,
}: FieldSpec & Access<number> & { readonly bounds: SettingBounds }): SettingsField =>
  SettingsField.Entry({
    key,
    label,
    note: Option.fromNullishOr(note),
    input: EntryInput.Number({ min, max }),
    read: (settings) => String(read(settings)),
    write: (settings, text) =>
      pipe(
        wholeNumber(text),
        Option.map((value) => Math.min(max, Math.max(min, value))),
        Option.getOrElse(() => read(settings)),
        (value) => write(settings, value),
      ),
  });

/** A text area gives no report of its own. */
const noProblems = (): ReadonlyArray<string> => [];

/** One text area. */
const block = ({
  key,
  label,
  note,
  minHeight,
  problems = noProblems,
  read,
  write,
}: FieldSpec &
  Access<string> & {
    readonly minHeight: string;
    readonly problems?: (text: string) => ReadonlyArray<string>;
  }): SettingsField =>
  SettingsField.Entry({
    key,
    label,
    note: Option.fromNullishOr(note),
    input: EntryInput.Block({ minHeight, problems }),
    read,
    write,
  });

/** One entry for each line. An empty line is not an entry. */
export const parseLines = (text: string): ReadonlyArray<string> =>
  pipe(
    text.split(/\r?\n/),
    Array.map((entry) => entry.trim()),
    Array.filter((entry) => entry.length > 0),
  );

/**
 * One rule for each line: `pattern [passKeys]`. `#` starts a comment.
 *
 * The exclusion reader does the work, so the dialog and the list of dropped
 * rules cannot read one text in two ways.
 */
export const parseExclusionText = (text: string): ReadonlyArray<ExclusionRule> =>
  pipe(
    parseExclusionLines(text),
    Array.map(({ rule }) => rule),
  );

/** The text of a list of lines. */
const joinLines = Array.join("\n");

export const formatExclusionRules: (rules: ReadonlyArray<ExclusionRule>) => string = flow(
  Array.map((rule: ExclusionRule) => `${rule.pattern} ${rule.passKeys}`.trimEnd()),
  joinLines,
);

/**
 * Every documented setting, in the order that the dialog draws it.
 *
 * The README says that all of these are editable here, and for eight of them
 * that was not true. `settings-form_test.ts` compares this list against the
 * schema, so a new setting must arrive with a control or the test fails.
 */
export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  {
    title: "Key mappings",
    description: Option.none(),
    fields: [
      block({
        key: "keyMappings",
        label: "Your map, unmap, unmapAll and mapkey lines",
        minHeight: "220px",
        // The defaults are written out when there is nothing stored, so that
        // the user can see what to change instead of an empty box.
        read: (settings) =>
          pipe(
            settings.keyMappings,
            Option.liftPredicate((mappings: string) => mappings.length > 0),
            Option.getOrElse(() => DEFAULT_MAPPINGS.trim()),
          ),
        write: (settings, value) => pipe(settings, Struct.assign({ keyMappings: value })),
      }),
    ],
  },
  {
    title: "Scrolling",
    description: Option.none(),
    fields: [
      whole({
        key: "scrollStepSize",
        label: "Scroll step size (px)",
        bounds: SCROLL_STEP_BOUNDS,
        read: (settings) => settings.scrollStepSize,
        write: (settings, value) => pipe(settings, Struct.assign({ scrollStepSize: value })),
      }),
      toggle({
        key: "smoothScroll",
        label: "Smooth scrolling",
        read: (settings) => settings.smoothScroll,
        write: (settings, value) => pipe(settings, Struct.assign({ smoothScroll: value })),
      }),
    ],
  },
  {
    title: "Link hints",
    description: Option.none(),
    fields: [
      // A hint alphabet needs two characters, or it can label one hint only.
      // This control counts the length of the text, and the schema counts the
      // distinct characters that it keeps, so `aa` passes here and storage
      // then puts the default back.
      line({
        key: "linkHintCharacters",
        label: "Link hint characters",
        note: "Two or more, and all different.",
        minLength: MIN_HINT_CHARACTERS,
        read: (settings) => settings.linkHintCharacters,
        write: (settings, value) => pipe(settings, Struct.assign({ linkHintCharacters: value })),
      }),
      line({
        key: "linkHintNumbers",
        label: "Digits that choose among filtered hints",
        note: "Two or more.",
        minLength: MIN_HINT_CHARACTERS,
        read: (settings) => settings.linkHintNumbers,
        write: (settings, value) => pipe(settings, Struct.assign({ linkHintNumbers: value })),
      }),
      toggle({
        key: "filterLinkHints",
        label: "Filter link hints by text instead of by letter",
        read: (settings) => settings.filterLinkHints,
        write: (settings, value) => pipe(settings, Struct.assign({ filterLinkHints: value })),
      }),
      toggle({
        key: "waitForEnterForFilteredHints",
        label: "Require Enter to activate a filtered hint",
        read: (settings) => settings.waitForEnterForFilteredHints,
        write: (settings, value) =>
          pipe(settings, Struct.assign({ waitForEnterForFilteredHints: value })),
      }),
      block({
        key: "userDefinedLinkHintCss",
        label: "Extra CSS for the hint markers",
        note: "Applied inside our shadow root only. No @import and no url().",
        minHeight: "100px",
        read: (settings) => settings.userDefinedLinkHintCss,
        write: (settings, value) =>
          pipe(settings, Struct.assign({ userDefinedLinkHintCss: value })),
      }),
    ],
  },
  {
    title: "Finding text",
    description: Option.none(),
    fields: [
      toggle({
        key: "regexFindMode",
        label: "Treat find queries as regular expressions",
        read: (settings) => settings.regexFindMode,
        write: (settings, value) => pipe(settings, Struct.assign({ regexFindMode: value })),
      }),
      toggle({
        key: "shadowNativeFind",
        label: "Shadow the Find shortcut of the browser",
        note: "May not be preventable on iOS (WebKit bug 191768).",
        read: (settings) => settings.shadowNativeFind,
        write: (settings, value) => pipe(settings, Struct.assign({ shadowNativeFind: value })),
      }),
    ],
  },
  {
    title: "Searching and new tabs",
    description: Option.none(),
    fields: [
      line({
        key: "searchUrl",
        label: "Default search URL",
        note: "It must contain %s, which is where your words go.",
        read: (settings) => settings.searchUrl,
        write: (settings, value) => pipe(settings, Struct.assign({ searchUrl: value })),
      }),
      block({
        key: "searchEngines",
        label: "Search engines",
        note: "One `keyword: url-with-%s Description` for each line.",
        minHeight: "120px",
        read: (settings) => settings.searchEngines,
        write: (settings, value) => pipe(settings, Struct.assign({ searchEngines: value })),
      }),
      line({
        key: "newTabUrl",
        label: "Page that a new tab opens",
        read: (settings) => settings.newTabUrl,
        write: (settings, value) => pipe(settings, Struct.assign({ newTabUrl: value })),
      }),
      toggle({
        key: "enableSearchSuggestions",
        label: "Ask the search engine for omnibar completions",
        note:
          "Sends what you type in the omnibar to your search engine, with " +
          "your cookies, as you type it.",
        read: (settings) => settings.enableSearchSuggestions,
        write: (settings, value) =>
          pipe(settings, Struct.assign({ enableSearchSuggestions: value })),
      }),
    ],
  },
  {
    title: "Navigating the page",
    description: Option.some(
      "The link text that [ and ] look for. Separate the words " + "with a comma.",
    ),
    fields: [
      line({
        key: "previousPatterns",
        label: "Words for the previous page",
        read: (settings) => settings.previousPatterns,
        write: (settings, value) => pipe(settings, Struct.assign({ previousPatterns: value })),
      }),
      line({
        key: "nextPatterns",
        label: "Words for the next page",
        read: (settings) => settings.nextPatterns,
        write: (settings, value) => pipe(settings, Struct.assign({ nextPatterns: value })),
      }),
    ],
  },
  {
    title: "The overlay",
    description: Option.none(),
    fields: [
      toggle({
        key: "hideHud",
        label: "Hide the HUD",
        read: (settings) => settings.hideHud,
        write: (settings, value) => pipe(settings, Struct.assign({ hideHud: value })),
      }),
      toggle({
        key: "followPageColorScheme",
        label: "Match the colour scheme of the page",
        note: "When off, the overlay follows your system appearance instead.",
        read: (settings) => settings.followPageColorScheme,
        write: (settings, value) => pipe(settings, Struct.assign({ followPageColorScheme: value })),
      }),
    ],
  },
  {
    title: "Behaviour",
    description: Option.none(),
    fields: [
      toggle({
        key: "ignoreKeyboardLayout",
        label: "Use physical key positions (ignore the keyboard layout)",
        read: (settings) => settings.ignoreKeyboardLayout,
        write: (settings, value) => pipe(settings, Struct.assign({ ignoreKeyboardLayout: value })),
      }),
      toggle({
        key: "grabBackFocus",
        label: "Take focus back from a page that steals it on load",
        read: (settings) => settings.grabBackFocus,
        write: (settings, value) => pipe(settings, Struct.assign({ grabBackFocus: value })),
      }),
      toggle({
        key: "passMediaKeys",
        label: "Leave the arrow keys and space to a focused video or audio player",
        note: "Turn off to scroll with them everywhere, even while a player has " + "focus.",
        read: (settings) => settings.passMediaKeys,
        write: (settings, value) => pipe(settings, Struct.assign({ passMediaKeys: value })),
      }),
      toggle({
        key: "enableCssZoom",
        label: "Enable CSS zoom",
        note:
          "Not true browser zoom: it does not change the URL bar, and it " +
          "breaks position:fixed on some sites.",
        read: (settings) => settings.enableCssZoom,
        write: (settings, value) => pipe(settings, Struct.assign({ enableCssZoom: value })),
      }),
    ],
  },
  {
    title: "Omnibar history",
    description: Option.none(),
    fields: [
      toggle({
        key: "enableHistoryIndex",
        label: "Build a local history index for the omnibar",
        note:
          "Recorded on this device only, and readable in the storage " +
          "viewer of your userscript manager.",
        read: (settings) => settings.enableHistoryIndex,
        write: (settings, value) => pipe(settings, Struct.assign({ enableHistoryIndex: value })),
      }),
      block({
        key: "historyIndexDenylist",
        label: "URLs that the index never records",
        note: "One URL pattern for each line, for example " + "https://mail.example.com/*",
        minHeight: "80px",
        read: (settings) => pipe(settings.historyIndexDenylist, Array.join("\n")),
        write: (settings, value) =>
          pipe(settings, Struct.assign({ historyIndexDenylist: [...parseLines(value)] })),
      }),
      whole({
        key: "historyIndexLimit",
        label: "Entries kept in the index",
        note: "0 stops the recording.",
        bounds: HISTORY_INDEX_LIMIT_BOUNDS,
        read: (settings) => settings.historyIndexLimit,
        write: (settings, value) => pipe(settings, Struct.assign({ historyIndexLimit: value })),
      }),
    ],
  },
  {
    title: "Excluded sites",
    description: Option.some(
      "One rule for each line: a URL pattern, and then the keys " +
        "to pass to the page. An empty key list turns Vimium-WebKit off for " +
        "that site.",
    ),
    fields: [
      block({
        key: "exclusionRules",
        label: "Excluded sites",
        minHeight: "100px",
        problems: exclusionProblems,
        read: (settings) => formatExclusionRules(settings.exclusionRules),
        write: (settings, value) =>
          pipe(settings, Struct.assign({ exclusionRules: [...parseExclusionText(value)] })),
      }),
    ],
  },
];

/** Every field of the dialog, in the order that the dialog draws it. */
export const SETTINGS_FIELDS: readonly SettingsField[] = pipe(
  SETTINGS_SECTIONS,
  Array.flatMap((section) => section.fields),
);

/** The text of one field, whatever its kind. */
const fieldText = (field: SettingsField, settings: SettingsData): string =>
  pipe(
    field,
    SettingsField.$match({
      Toggle: ({ read }) => String(read(settings)),
      Entry: ({ read }) => read(settings),
    }),
  );

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Give an element its class. */
const withClass =
  (className: string) =>
  <E extends Element>(element: E): E => {
    element.className = className;
    return element;
  };

/** Give a node its text. */
const withText =
  (text: string) =>
  <N extends Node>(node: N): N => {
    node.textContent = text;
    return node;
  };

/**
 * The fields that storage gave back with a different value.
 *
 * The schema repairs a bad field instead of rejecting the whole object, so what
 * was stored is not always what the user offered. The dialog must show the
 * stored value, and it must say which fields it changed.
 */
export const adjustedFields = (
  offered: SettingsData,
  stored: SettingsData,
): ReadonlyArray<string> =>
  pipe(
    SETTINGS_FIELDS,
    Array.filter((field) => fieldText(field, offered) !== fieldText(field, stored)),
    Array.map((field) => field.label),
  );

/** One control, as the refusal check reads it. */
export interface OfferedText {
  readonly field: SettingsField;
  readonly text: string;
}

/** What the controls did with the text of the user, before the save. */
export interface FormNotes {
  /** The fields that keep their stored value, because `write` read nothing. */
  readonly refused: ReadonlyArray<string>;
  /** The fields whose number `write` brought into range. */
  readonly clamped: ReadonlyArray<string>;
  /** The fields whose decimals `write` dropped. */
  readonly truncated: ReadonlyArray<string>;
  /** The exclusion rules that gave no matcher. */
  readonly dropped: ReadonlyArray<string>;
}

/** Nothing to report: the reset button offers the defaults. */
export const NO_FORM_NOTES: FormNotes = {
  refused: [],
  clamped: [],
  truncated: [],
  dropped: [],
};

/** What one control did with one text. */
interface TextNote {
  readonly refused: boolean;
  readonly clamped: boolean;
  readonly truncated: boolean;
  readonly dropped: ReadonlyArray<string>;
}

/** The control used the text as it stands. */
const USED: TextNote = { refused: false, clamped: false, truncated: false, dropped: [] };

/**
 * What one text control does with one text.
 *
 * A refusal and a clamp are two results, and one message cannot describe both:
 * a refused field keeps its stored value, and a clamped field does not. A
 * control of type `number` also gives back `50.7`, because that text is a
 * valid floating-point number. `write` then stores 50, which is neither a
 * refusal nor a clamp.
 */
const inputNote = (text: string) =>
  EntryInput.$match({
    Line: ({ minLength }): TextNote =>
      pipe(USED, Struct.assign({ refused: text.length < minLength })),
    Number: ({ min, max }): TextNote => ({
      refused: notANumber(text),
      clamped: outsideRange(min, max, text),
      truncated: notWhole(text),
      dropped: [],
    }),
    Block: ({ problems }): TextNote => pipe(USED, Struct.assign({ dropped: problems(text) })),
  });

/** What one control did with its text. A toggle takes every value. */
const textNote = ({ field, text }: OfferedText): TextNote =>
  pipe(
    field,
    SettingsField.$match({
      Toggle: () => USED,
      Entry: ({ input }) => pipe(input, inputNote(text)),
    }),
  );

/**
 * What the dialog must tell the user about the text that it read.
 *
 * `write` gives the stored settings, and the stored settings alone say
 * nothing: a refused field keeps its stored value, so `adjustedFields` finds
 * no difference, and a clamped field stores the bound, so `adjustedFields`
 * finds no difference either. The user typed, pressed Save, saw another value
 * and got no reason. This names each field, and it separates the results.
 * Each result does something else to the value.
 */
export const formNotes = (offered: ReadonlyArray<OfferedText>): FormNotes => {
  const notes = pipe(
    offered,
    Array.map((entry) => ({ label: entry.field.label, note: textNote(entry) })),
  );
  const labelsWhere = (holds: (note: TextNote) => boolean): ReadonlyArray<string> =>
    pipe(
      notes,
      Array.filter(({ note }) => holds(note)),
      Array.map(({ label }) => label),
    );
  return {
    refused: labelsWhere((note) => note.refused),
    clamped: labelsWhere((note) => note.clamped),
    truncated: labelsWhere((note) => note.truncated),
    dropped: pipe(
      notes,
      Array.flatMap(({ note }) => note.dropped),
    ),
  };
};

/** What the dialog does after storage took the settings. */
type SaveOutcome = Data.TaggedEnum<{
  /**
   * The dialog stays open, and the message says why.
   *
   * The dialog is the only place where the user can see what happened: a
   * mapping line that the parser refused, a control that refused or changed
   * what the user typed, or a field that storage repaired.
   */
  Kept: { readonly message: string };
  /** Everything was stored as the user offered it. */
  Saved: NoFields;
}>;
const SaveOutcome = Data.taggedEnum<SaveOutcome>();

/** The mapping lines that the parser refused, one for each line. */
const mappingErrors = (compiled: CompiledMappings): Option.Option<string> =>
  pipe(
    compiled.diagnostics,
    Array.filter((entry) => entry.severity === "error"),
    Array.map((entry) => `line ${entry.line}: ${entry.message}`),
    Option.liftPredicate(Array.isReadonlyArrayNonEmpty),
    Option.map(joinLines),
  );

const commaList = Array.join(", ");

/** One sentence about a list, when the list holds anything. */
const sentence = (
  items: ReadonlyArray<string>,
  say: (items: ReadonlyArray<string>) => string,
): Option.Option<string> =>
  pipe(items, Option.liftPredicate(Array.isReadonlyArrayNonEmpty), Option.map(say));

/** What the dialog says about a save that did not store what the user offered. */
const adjustmentMessage = (
  notes: FormNotes,
  changed: ReadonlyArray<string>,
): Option.Option<string> =>
  pipe(
    [
      sentence(
        notes.refused,
        (names) =>
          `These fields keep their stored value, because the text was ` +
          `refused: ${commaList(names)}.`,
      ),
      // A clamped field did change. Saying that it kept its stored value
      // would be false, and the user would look for a value that is not
      // there.
      sentence(
        notes.clamped,
        (names) => `These fields were brought into range: ${commaList(names)}.`,
      ),
      // A control of type `number` accepts `50.7`, and the setting holds a
      // whole number. Neither of the two lines above covers that.
      sentence(
        notes.truncated,
        (names) => `These fields keep a whole number only: ${commaList(names)}.`,
      ),
      sentence(
        notes.dropped,
        (rules) =>
          `These exclusion rules were dropped, and they do not exclude a page: ` +
          `${pipe(rules, Array.join("; "))}.`,
      ),
      sentence(changed, (names) => `Stored with changes to: ${commaList(names)}.`),
    ],
    Array.getSomes,
    Option.liftPredicate(Array.isReadonlyArrayNonEmpty),
    Option.map(flow(Array.append("The values above are the stored ones."), Array.join(" "))),
  );

/**
 * What the dialog does after a save that reached storage.
 *
 * A mapping error comes first. Closing the dialog would hide the only place
 * where the user can correct the line that we refused.
 */
const saveOutcome = (
  offered: SettingsData,
  stored: SettingsData,
  compiled: CompiledMappings,
  notes: FormNotes,
): SaveOutcome =>
  pipe(
    mappingErrors(compiled),
    Option.orElse(() => adjustmentMessage(notes, adjustedFields(offered, stored))),
    Option.match({
      onNone: () => SaveOutcome.Saved(),
      onSome: (message) => SaveOutcome.Kept({ message }),
    }),
  );

// ---------------------------------------------------------------------------
// The focus trap
// ---------------------------------------------------------------------------

/** Which way one Tab press moves the focus. Shift+Tab goes backward. */
export type FocusStep = "forward" | "backward";

/** Where a step enters the controls from the dialog box, and how far it moves after that. */
const stepRule = (step: FocusStep, count: number) =>
  pipe(
    Match.value(step),
    Match.when("forward", () => ({ entry: 0, offset: 1 })),
    Match.when("backward", () => ({ entry: count - 1, offset: -1 })),
    Match.exhaustive,
  );

/**
 * Which control takes the focus for one Tab press.
 *
 * `current` is the position of the focused control, or `None` while the focus
 * is on the dialog box itself. The answer wraps at both ends, because
 * `aria-modal="true"` promises that nothing outside the dialog is available.
 * `None` means that the dialog holds no control, so the box itself keeps the
 * focus.
 */
export const nextFocusIndex = (
  count: number,
  current: Option.Option<number>,
  step: FocusStep,
): Option.Option<number> =>
  pipe(
    count,
    Option.liftPredicate((total: number) => total > 0),
    Option.map((total) => {
      const { entry, offset } = stepRule(step, total);
      return pipe(
        current,
        Option.match({
          onNone: () => entry,
          onSome: (index) => (index + offset + total) % total,
        }),
      );
    }),
  );

/**
 * The controls of one dialog, in document order.
 *
 * The order of the list is the order of the nodes, which is the tab order for
 * both dialogs: neither one holds a positive `tabindex`. A disabled control
 * and a control with `tabindex="-1"` drop out, because neither takes a Tab
 * press.
 */
const FOCUSABLE_SELECTOR = "a[href], button, input, select, textarea, [tabindex]";

const focusableIn = (dialog: HTMLElement): ReadonlyArray<HTMLElement> =>
  pipe(
    dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
    Array.fromIterable,
    Array.filter((element) => !element.hasAttribute("disabled") && element.tabIndex >= 0),
  );

/** The step of one Tab press. */
const tabStep = (event: KeyboardEvent): FocusStep =>
  pipe(
    event.shiftKey,
    Boolean.match({
      onFalse: (): FocusStep => "forward",
      onTrue: (): FocusStep => "backward",
    }),
  );

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

/** One control of the settings dialog, with the field that it edits. */
type SettingsControl = Data.TaggedEnum<{
  Check: { readonly field: ToggleField; readonly input: HTMLInputElement };
  Entry: {
    readonly field: EntryField;
    readonly input: HTMLInputElement | HTMLTextAreaElement;
  };
}>;
const SettingsControl = Data.taggedEnum<SettingsControl>();

/** The nodes of one control, in document order, and the control that the save step reads. */
interface BuiltControl {
  readonly nodes: ReadonlyArray<HTMLElement>;
  readonly control: SettingsControl;
}

/** The nodes of one section, in document order, and the controls that it holds. */
interface BuiltSection {
  readonly nodes: ReadonlyArray<HTMLElement>;
  readonly controls: ReadonlyArray<SettingsControl>;
}

/** What every dialog gives the session that shows it. */
interface DialogParts {
  readonly dialog: HTMLElement;
}

/** The parts of the settings dialog that the save step writes back to. */
interface SettingsForm {
  readonly dialog: HTMLElement;
  readonly controls: ReadonlyArray<SettingsControl>;
  readonly problems: HTMLElement;
  readonly reset: HTMLButtonElement;
  readonly cancel: HTMLButtonElement;
  readonly save: HTMLButtonElement;
}

/** Write the stored settings into one control. */
const writeControl = (current: SettingsData) =>
  SettingsControl.$match({
    Check: ({ field, input }) => {
      input.checked = field.read(current);
    },
    Entry: ({ field, input }) => {
      input.value = field.read(current);
    },
  });

/** Write the text of one control into the settings. */
const readControl = (next: SettingsData, control: SettingsControl): SettingsData =>
  pipe(
    control,
    SettingsControl.$match({
      Check: ({ field, input }) => field.write(next, input.checked),
      Entry: ({ field, input }) => field.write(next, input.value),
    }),
  );

/** What the user offered in one control, as text, for the refusal check. */
const offeredIn = SettingsControl.$match({
  Check: ({ field, input }): OfferedText => ({ field, text: String(input.checked) }),
  Entry: ({ field, input }): OfferedText => ({ field, text: input.value }),
});

/** Why a userscript cannot do a command. Tier A and tier B commands work. */
const refusalOf = (command: CommandDef) =>
  pipe(command.availability, Option.liftPredicate(CommandAvailability.$is("Unavailable")));

/** The tier letter of a command, which the style sheet reads. */
const tierOf = (command: CommandDef): string =>
  pipe(
    command.availability,
    CommandAvailability.$match({
      Available: () => "AB",
      Unavailable: () => "C",
    }),
  );

/** The key sequences that are bound to each command, as `keysByCommand` gives them. */
type BoundKeys = Record.ReadonlyRecord<string, Array.NonEmptyReadonlyArray<string>>;

/**
 * The help dialog and the settings dialog.
 *
 * The layer provides no service. It registers `showHelp` and `showSettings`
 * in the command registry, which is the only way that anything opens them.
 */
export const DialogLayer: Layer.Layer<
  never,
  never,
  Ui | Dom | Settings | Mappings | Commands | Modes | Report | Capabilities
> = Layer.effectDiscard(
  Effect.gen(function* () {
    const ui = yield* Ui;
    const dom = yield* Dom;
    const settings = yield* Settings;
    const mappings = yield* Mappings;
    const commands = yield* Commands;
    const modes = yield* Modes;
    const report = yield* Report;
    const capabilities = yield* Capabilities;

    const doc = dom.document;
    const dialogLayer = yield* ui.layer("dialog");

    const el = <K extends keyof HTMLElementTagNameMap>(tag: K): HTMLElementTagNameMap[K] =>
      doc.createElement(tag);

    /** An element that holds one text. */
    const textEl = <K extends keyof HTMLElementTagNameMap>(
      tag: K,
      text: string,
    ): HTMLElementTagNameMap[K] => pipe(el(tag), withText(text));

    /** An element with a class. */
    const classEl = <K extends keyof HTMLElementTagNameMap>(
      tag: K,
      className: string,
    ): HTMLElementTagNameMap[K] => pipe(el(tag), withClass(className));

    /** One button of a dialog. */
    const button = (text: string): HTMLButtonElement =>
      pipe(classEl("button", "vw-button"), withText(text));

    /** The box of one modal dialog, with its name for assistive technology. */
    const dialogBox = (name: string): HTMLDivElement => {
      const dialog = classEl("div", "vw-dialog");
      dialog.setAttribute("role", "dialog");
      dialog.setAttribute("aria-modal", "true");
      dialog.setAttribute("aria-label", name);
      return dialog;
    };

    // One dialog at a time. Its fiber holds the scope of the dialog, so the
    // end of the fiber removes every part of it, whatever ends the fiber.
    const sessions = yield* FiberHandle.make<void, never>();

    // One save at a time. A save reaches storage, so it cannot run on the
    // key path; it runs in this fiber instead.
    const saves = yield* FiberHandle.make<void, never>();

    /**
     * Close the open dialog, if there is one.
     *
     * The fiber of the dialog waits for its mode to exit, so the interruption
     * and every release step run at once, and nothing here suspends.
     */
    const close: Effect.Effect<void> = FiberHandle.clear(sessions);

    /**
     * Move the focus to the next or the previous control of the dialog.
     *
     * The root is closed, so `document.activeElement` is the host from
     * outside. `shadow.activeElement` gives the true node.
     *
     * `focus()` and not `focus({ preventScroll: true })`. The dialog box
     * scrolls, and the settings form is longer than it. With `preventScroll`
     * the ninth Tab press put the focus on a control below the box, and
     * nothing moved: a sighted keyboard user could not find the focus.
     */
    const moveFocus = (dialog: HTMLElement, step: FocusStep): void => {
      const targets = focusableIn(dialog);
      const active = ui.shadow.activeElement;
      const current = pipe(
        targets,
        Array.findFirstIndex((element) => element === active),
      );
      const target = pipe(
        nextFocusIndex(targets.length, current, step),
        Option.flatMap((index) => pipe(targets, Array.get(index))),
        Option.getOrElse(() => dialog),
      );
      target.focus();
    };

    /**
     * What the dialog mode does with one key.
     *
     * `SUPPRESS_PROPAGATION` keeps the event from normal mode and from the
     * page, and keeps the default action, so the user can still type into a
     * text area.
     *
     * Tab is the exception. `SUPPRESS_PROPAGATION` calls
     * `stopImmediatePropagation` only, so the default action of Tab took the
     * focus out of the dialog and on to the page behind it. That breaks the
     * promise of `aria-modal="true"`, which tells a screen reader that the
     * rest of the page is unavailable. `SUPPRESS_EVENT` takes the key, and
     * the trap moves the focus by hand.
     */
    const trapKey = (dialog: HTMLElement, event: KeyboardEvent): Effect.Effect<HandlerResult> =>
      pipe(
        event.key === "Tab",
        Boolean.match({
          onFalse: () => Effect.succeed(SUPPRESS_PROPAGATION),
          onTrue: () =>
            pipe(
              Effect.sync(() => moveFocus(dialog, tabStep(event))),
              Effect.as(SUPPRESS_EVENT),
            ),
        }),
      );

    /**
     * Give the focus back to the element that had it before the dialog.
     *
     * The reads stay inside the attempt, because the element belongs to the
     * page, and page script can replace any accessor of it.
     */
    const focusAgain = (previous: Option.Option<Element>): Effect.Effect<void> =>
      pipe(
        dom.attempt("HTMLElement.focus", () =>
          pipe(
            previous,
            Option.filter(
              (element): element is HTMLElement =>
                element instanceof HTMLElement && element.isConnected,
            ),
            Option.match({
              onNone: Function.constVoid,
              onSome: (element) => element.focus({ preventScroll: true }),
            }),
          ),
        ),
        Effect.ignore,
      );

    /**
     * Show a dialog that `build` draws, until its mode exits.
     *
     * Every part is acquired in the scope of the session, and `build` gets
     * that scope too, so a listener that it registers goes away with the
     * dialog.
     */
    const session = Effect.fnUntraced(function* (
      build: Effect.Effect<DialogParts, never, Scope.Scope>,
    ) {
      // The layer is opened before the dialog is built, so that the
      // release steps run in the other order: the dialog leaves the tree
      // first, and `aria-hidden` arrives on an empty layer. A layer that
      // became hidden while it still held the focused element is the state
      // that browsers warn about, because a screen reader loses the
      // focused node.
      yield* acceptPointerEvents(dialogLayer);
      // The dialog is a true control, so assistive technology must reach
      // it. The release step hides the layer again.
      yield* ui.expose(dialogLayer);

      const parts = yield* build;

      const backdrop = yield* Effect.acquireRelease(
        Effect.sync(() => {
          const element = classEl("div", "vw-dialog-backdrop");
          element.appendChild(parts.dialog);
          dialogLayer.appendChild(element);
          return element;
        }),
        (element) =>
          Effect.sync(() => {
            element.remove();
          }),
      );

      yield* dom.listenOn(backdrop, "click", (event) =>
        pipe(
          event.target === backdrop,
          Boolean.match({
            onFalse: () => Effect.void,
            onTrue: () => close,
          }),
        ),
      );

      // The dialog owns the keyboard. `trapKey` says how.
      const mode = yield* modes.enter(
        {
          name: "dialog",
          indicator: Option.none(),
          exitOn: [ExitTrigger.Escape()],
          keyboard: KeyPolicy.Shared(),
          singleton: Option.some("dialog"),
        },
        { keydown: (event) => trapKey(parts.dialog, event) },
      );
      // The exit of the mode ends the session. An exit body also runs while
      // this scope closes, on this fiber, so it signals the end instead of
      // calling `close`, which would wait for this fiber.
      const exited = yield* Deferred.make<void>();
      yield* mode.onExit(() => pipe(exited, Deferred.succeed<void>(undefined), Effect.asVoid));

      // Acquired last, so that its release step runs first: the focus
      // leaves the dialog before the dialog leaves the tree. A modal that
      // drops the focus leaves the user at the top of the document.
      yield* Effect.acquireRelease(
        dom.probeOrElse(() => Option.fromNullishOr(deepActiveElement(doc)), Option.none),
        focusAgain,
      );

      yield* Effect.sync(() => {
        parts.dialog.tabIndex = -1;
        parts.dialog.focus({ preventScroll: true });
      });

      yield* Deferred.await(exited);
    });

    /**
     * Put a dialog on screen, in place of the one that is open.
     *
     * The open dialog closes first. Its release steps give back the pointer,
     * the exposure of the layer and the focus, so they must run before the
     * new dialog takes them. `FiberHandle.run` starts the session at once,
     * so the dialog holds the keyboard before the key that asked for it is
     * done.
     */
    const present = Effect.fn("Dialog.present")(function* (
      build: Effect.Effect<DialogParts, never, Scope.Scope>,
    ) {
      yield* close;
      yield* pipe(
        session(build),
        Effect.scoped,
        recoverUnlessInterrupted("Dialog.session", Effect.void),
        FiberHandle.run(sessions),
      );
    });

    // ---------------------------------------------------------------
    // Help
    // ---------------------------------------------------------------

    /** The three cells of one command in the help table. */
    const commandRow =
      (bound: BoundKeys) =>
      (command: CommandDef): ReadonlyArray<HTMLElement> => {
        const cell = (className: string, text: string): HTMLSpanElement => {
          const span = pipe(classEl("span", `${className} vw-cmd-row`), withText(text));
          span.dataset["tier"] = tierOf(command);
          return span;
        };
        const refusal = refusalOf(command);
        const keys = pipe(
          bound,
          Record.get(command.name),
          Option.map(Array.join("  ")),
          Option.getOrElse(() => "—"),
        );
        const native = pipe(
          refusal,
          Option.flatMap(({ nativeAlternative }) => nativeAlternative),
          Option.getOrElse(() => ""),
        );
        const description = cell("vw-cmd-desc", command.description);
        pipe(
          refusal,
          Option.match({
            onNone: Function.constVoid,
            onSome: ({ reason }) => {
              description.title = reason;
            },
          }),
        );
        return [cell("vw-cmd-keys", keys), description, cell("vw-cmd-native", native)];
      };

    const commandTable = (list: ReadonlyArray<CommandDef>, bound: BoundKeys): HTMLElement => {
      const table = classEl("div", "vw-cmd-table");
      const cells = pipe(
        list,
        Array.filter((command) => command.advanced !== true),
        Array.flatMap(commandRow(bound)),
      );
      table.append(...cells);
      return table;
    };

    /**
     * The commands of each group, in the order of the catalogue. No group is
     * empty. The key is a `string`, because a key of a literal union makes
     * every group optional.
     */
    const commandsByGroup = pipe(
      commands.all,
      Array.groupBy((command): string => command.group),
    );

    /** The title and the commands of one group, when the group holds a command. */
    const helpGroup = (group: CommandGroup) =>
      pipe(
        commandsByGroup,
        Record.get(group),
        Option.map((list) => ({ title: pipe(GROUP_TITLES, Struct.get(group)), list })),
      );

    /** The heading and the table of every group that holds a command. */
    const helpGroups = (bound: BoundKeys): ReadonlyArray<HTMLElement> =>
      pipe(
        GROUP_ORDER,
        Array.map(helpGroup),
        Array.getSomes,
        Array.flatMap(({ title, list }) => [textEl("h2", title), commandTable(list, bound)]),
      );

    /** The mapping problems, under a heading of their own, when there are any. */
    const problemSection: (problems: ReadonlyArray<string>) => ReadonlyArray<HTMLElement> =
      Array.match({
        onEmpty: () => [],
        onNonEmpty: (lines) => [
          textEl("h2", "Mapping problems"),
          pipe(classEl("div", "vw-problem"), withText(joinLines(lines))),
        ],
      });

    const buildHelp = Effect.fn("Dialog.buildHelp")(function* () {
      // `compiledUnsafe`, because a command body reaches this from the key
      // path, which must not suspend.
      const compiled = mappings.compiledUnsafe();
      const bound = keysByCommand(compiled);

      const parts = yield* Effect.acquireRelease(
        Effect.sync(() => {
          const dialog = dialogBox("Vimium-WebKit help");
          const diagnostics = pipe(
            classEl("pre", "vw-diagnostics"),
            withText(
              joinLines([
                formatCapabilities(capabilities),
                "",
                `commands                 ${commands.all.length}`,
              ]),
            ),
          );
          const settingsButton = button("Settings…");
          const closeButton = button("Close");
          closeButton.dataset["variant"] = "primary";
          const row = classEl("div", "vw-button-row");
          row.append(settingsButton, closeButton);

          dialog.append(
            textEl("h1", "Vimium-WebKit"),
            textEl(
              "p",
              "A grey command cannot be done by a userscript. The shortcut of " +
                "the browser is beside it. Press Escape to close.",
            ),
            ...helpGroups(bound),
            textEl("h2", "Diagnostics"),
            diagnostics,
            ...problemSection(formatDiagnostics(compiled)),
            row,
          );

          return { dialog, settingsButton, closeButton };
        }),
        (built) =>
          Effect.sync(() => {
            built.dialog.remove();
          }),
      );

      yield* dom.listenOn(parts.settingsButton, "click", () => showSettings);
      yield* dom.listenOn(parts.closeButton, "click", () => close);
      return parts;
    });

    const showHelp: Effect.Effect<void> = present(buildHelp());

    // ---------------------------------------------------------------
    // Settings
    // ---------------------------------------------------------------

    /** Write the stored settings into the controls. */
    const fill = (form: SettingsForm, current: SettingsData): Effect.Effect<void> =>
      Effect.sync(() => pipe(form.controls, Array.forEach(writeControl(current))));

    const readForm = (form: SettingsForm, base: SettingsData): SettingsData =>
      pipe(form.controls, Array.reduce(base, readControl));

    /** What the user offered, as text, for the refusal check. */
    const offeredText = (form: SettingsForm): ReadonlyArray<OfferedText> =>
      pipe(form.controls, Array.map(offeredIn));

    const showProblems = (form: SettingsForm, message: string): Effect.Effect<void> =>
      Effect.sync(() => {
        form.problems.textContent = message;
      });

    /**
     * Store the settings, and tell the truth about the result.
     *
     * The dialog stays open when the mapping source still has an error, when
     * a control refused what the user typed, when a control brought a number
     * into range, when a control dropped the decimals of a number, and when
     * storage repaired a field. In each case the dialog is the only place
     * where the user can see what happened.
     */
    const store = Effect.fn("Dialog.store")(
      function* (form: SettingsForm, next: SettingsData, notes: FormNotes) {
        const stored = yield* settings.save(next);
        yield* fill(form, stored);
        const compiled = yield* mappings.check(stored.keyMappings);
        yield* pipe(
          saveOutcome(next, stored, compiled, notes),
          SaveOutcome.$match({
            Kept: ({ message }) => showProblems(form, message),
            Saved: () =>
              pipe(
                showProblems(form, ""),
                Effect.andThen(close),
                Effect.andThen(report.info("Settings saved")),
              ),
          }),
        );
      },
      // The failure goes to the user. Success must not be claimed over it,
      // and the dialog stays open.
      Effect.catch((error) => report.error(`Settings were not saved: ${error.detail}`)),
    );

    /** The label of one control, with its note inside it. */
    const labelFor = (field: SettingsField, id: string): HTMLLabelElement => {
      const label = textEl("label", field.label);
      label.htmlFor = id;
      const note = pipe(
        field.note,
        Option.map((text) => pipe(classEl("span", "vw-cmd-native"), withText(` ${text}`))),
        Option.toArray,
      );
      label.append(...note);
      return label;
    };

    /**
     * The id that joins the label to the control.
     *
     * It is unique inside our shadow root, which no page identifier can
     * reach.
     */
    const controlId = (field: SettingsField): string => `vw-set-${field.key}`;

    const checkControl = (field: ToggleField): BuiltControl => {
      const id = controlId(field);
      const input = el("input");
      input.type = "checkbox";
      input.id = id;
      const row = classEl("div", "vw-field");
      row.append(input, labelFor(field, id));
      return { nodes: [row], control: SettingsControl.Check({ field, input }) };
    };

    const inputControl = (field: EntryField, type: "text" | "number"): BuiltControl => {
      const id = controlId(field);
      const input = el("input");
      input.id = id;
      input.type = type;
      input.spellcheck = false;
      const row = classEl("div", "vw-field");
      row.append(labelFor(field, id), input);
      return { nodes: [row], control: SettingsControl.Entry({ field, input }) };
    };

    /** A text area, below the row of its label, at the full width of the dialog. */
    const areaControl = (field: EntryField, minHeight: string): BuiltControl => {
      const id = controlId(field);
      const row = classEl("div", "vw-field vw-field--block");
      row.appendChild(labelFor(field, id));
      const area = classEl("textarea", "vw-textarea");
      area.id = id;
      area.spellcheck = false;
      area.style.minHeight = minHeight;
      return { nodes: [row, area], control: SettingsControl.Entry({ field, input: area }) };
    };

    const entryControl = (field: EntryField): BuiltControl =>
      pipe(
        field.input,
        EntryInput.$match({
          Line: () => inputControl(field, "text"),
          Number: () => inputControl(field, "number"),
          Block: ({ minHeight }) => areaControl(field, minHeight),
        }),
      );

    const buildControl = SettingsField.$match({
      Toggle: checkControl,
      Entry: entryControl,
    });

    /** The heading, the description and the controls of one section. */
    const buildSection = (section: SettingsSection): BuiltSection => {
      const built = pipe(section.fields, Array.map(buildControl));
      const description = pipe(
        section.description,
        Option.map((text) => textEl("p", text)),
        Option.toArray,
      );
      const fields = pipe(
        built,
        Array.flatMap(({ nodes }) => nodes),
      );
      return {
        nodes: [textEl("h2", section.title), ...description, ...fields],
        controls: pipe(
          built,
          Array.map(({ control }) => control),
        ),
      };
    };

    /** Draw the settings form. */
    const buildForm = (): SettingsForm => {
      const dialog = dialogBox("Vimium-WebKit settings");
      const sections = pipe(SETTINGS_SECTIONS, Array.map(buildSection));

      // One place for every message about the save: a refusal from
      // storage, a mapping error, and a field that the schema repaired.
      // `role="alert"` makes a screen reader speak it, because the
      // dialog stays open and nothing else says that it did.
      const problems = classEl("div", "vw-problem");
      problems.setAttribute("role", "alert");

      const reset = button("Reset to defaults");
      const cancel = button("Cancel");
      const save = button("Save");
      save.dataset["variant"] = "primary";
      const row = classEl("div", "vw-button-row");
      row.append(reset, cancel, save);

      const sectionNodes = pipe(
        sections,
        Array.flatMap(({ nodes }) => nodes),
      );
      dialog.append(
        textEl("h1", "Settings"),
        textEl("p", storageExplanation(capabilities.value)),
        ...sectionNodes,
        problems,
        row,
      );

      return {
        dialog,
        controls: pipe(
          sections,
          Array.flatMap(({ controls }) => controls),
        ),
        problems,
        reset,
        cancel,
        save,
      };
    };

    const buildSettings = Effect.fn("Dialog.buildSettings")(function* () {
      // `currentUnsafe`, because a command body reaches this from the key
      // path, which must not suspend.
      const current = settings.currentUnsafe();

      const form = yield* Effect.acquireRelease(Effect.sync(buildForm), (built) =>
        Effect.sync(() => {
          built.dialog.remove();
        }),
      );
      yield* fill(form, current);

      // The store call reaches the backend, so it cannot run inside the
      // click dispatch. One fiber holds it, and a second click replaces it.
      const submit = (next: SettingsData, notes: FormNotes): Effect.Effect<void> =>
        pipe(store(form, next, notes), FiberHandle.run(saves), Effect.asVoid);

      yield* dom.listenOn(
        form.save,
        "click",
        // The base is read again here, and not at build time. Another frame
        // can store a change while this dialog is open, and a field that
        // this dialog does not edit must keep that change.
        () => submit(readForm(form, settings.currentUnsafe()), formNotes(offeredText(form))),
      );
      yield* dom.listenOn(
        form.reset,
        "click",
        // The defaults replace every control, so nothing of the user is
        // refused here.
        () => submit(defaultSettings(), NO_FORM_NOTES),
      );
      yield* dom.listenOn(form.cancel, "click", () => close);
      return form;
    });

    const showSettings: Effect.Effect<void> = present(buildSettings());

    // The commands that this layer owns. A feature registers its own bodies
    // in the same way, so no feature imports another feature.
    yield* commands.register("showHelp", () => showHelp);
    yield* commands.register("showSettings", () => showSettings);
  }),
);
