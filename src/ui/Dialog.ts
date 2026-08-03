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
  Context,
  Effect,
  Exit,
  FiberHandle,
  Layer,
  Option,
  Ref,
  Scope,
} from "effect";
import { Commands } from "~/core/Commands.ts";
import { SUPPRESS_EVENT, SUPPRESS_PROPAGATION } from "~/core/HandlerStack.ts";
import { Mappings } from "~/core/Mappings.ts";
import { Modes } from "~/core/Modes.ts";
import { Report } from "~/core/Report.ts";
import { Settings } from "~/core/Settings.ts";
import {
  type CommandDef,
  type CommandGroup,
  DEFAULT_MAPPINGS,
} from "~/domain/Command.ts";
import type { ExclusionRule } from "~/domain/Exclusion.ts";
import { formatDiagnostics, keysByCommand } from "~/domain/Mapping.ts";
import {
  defaultSettings,
  type Settings as SettingsData,
} from "~/domain/Persisted.ts";
import { Capabilities, formatCapabilities } from "~/platform/Capabilities.ts";
import { Dom } from "~/platform/Dom.ts";
import { deepActiveElement } from "~/platform/Elements.ts";
import type { KeyValueKind } from "~/platform/KeyValueStore.ts";
import { acceptPointerEvents, Ui } from "~/ui/Ui.ts";

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

/**
 * Where the settings in this dialog are kept.
 *
 * Said out loud, and said truthfully, because it changes what the user must
 * expect. The old text claimed that settings never go to `localStorage`, while
 * the store falls back to exactly that on a manager with no value API, and
 * `Capabilities` warns about it in the same session. Two parts of the interface
 * that disagree about where the data of the user lives are worse than either
 * message alone.
 */
const storageExplanation = (backend: KeyValueKind): string => {
  const preamble = "There is no options page for a userscript, so settings " +
    "live here. ";
  switch (backend) {
    case "gm-sync":
    case "gm-async":
      return `${preamble}They are stored with your userscript manager, which ` +
        "is durable and survives Safari's seven-day storage purge.";
    case "localstorage-fallback":
      return `${preamble}Your userscript manager offers no storage, so they ` +
        "are kept in localStorage, which Safari erases after seven days " +
        "without a visit to this site.";
    case "memory":
      return `${preamble}No storage is available at all, so they last only ` +
        "until this page is closed.";
  }
};

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
  readonly note?: string;
}

/** One checkbox. */
export interface ToggleField extends FieldBase {
  readonly kind: "toggle";
  readonly read: (settings: SettingsData) => boolean;
  readonly write: (settings: SettingsData, value: boolean) => SettingsData;
}

/**
 * One text control.
 *
 * `line` is a single-line input, `number` is a numeric input, and `block` is a
 * text area. Each one reads and writes text, so a list and a number carry
 * their own conversion in `read` and `write`.
 */
export interface ValueField extends FieldBase {
  readonly kind: "line" | "number" | "block";
  /** The smallest height of a text area, as a CSS length. */
  readonly minHeight?: string;
  /**
   * Does the control refuse this text?
   *
   * True means one thing only: `write` keeps the stored value, because it can
   * read no value at all from the text. The user then saw the old value come
   * back with no reason for it. The dialog asks this before it saves, so the
   * message area can name the field. Only a control that can refuse declares
   * it.
   */
  readonly refuses?: (text: string) => boolean;
  /**
   * Does the control bring this text into its range?
   *
   * True means that `write` stores a value, and stores a different one. A
   * refusal and a clamp are two results, and one message cannot describe both:
   * a clamped field does not keep its stored value. Only a control with a
   * range declares it.
   */
  readonly clamps?: (text: string) => boolean;
  readonly read: (settings: SettingsData) => string;
  readonly write: (settings: SettingsData, value: string) => SettingsData;
}

export type SettingsField = ToggleField | ValueField;

/** One titled group of controls in the dialog. */
export interface SettingsSection {
  readonly title: string;
  readonly description?: string;
  readonly fields: readonly SettingsField[];
}

const clampNumber = (
  value: number,
  min: number,
  max: number,
  fallback: number,
): number => {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
};

/** Text that holds no number at all. `write` then keeps the stored value. */
const notANumber = (text: string): boolean =>
  !Number.isFinite(Number.parseInt(text, 10));

/** A number that `clampNumber` brings into the range of this control. */
const outsideRange = (min: number, max: number) => (text: string): boolean => {
  const value = Number.parseInt(text, 10);
  return Number.isFinite(value) && (value < min || value > max);
};

/** A hint alphabet needs two characters, or it can label one hint only. */
const shorterThanTwo = (text: string): boolean => text.length < 2;

/** One entry for each line. An empty line is not an entry. */
export const parseLines = (text: string): ReadonlyArray<string> =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

/** One rule for each line: `pattern [passKeys]`. `#` starts a comment. */
export const parseExclusionText = (
  text: string,
): ReadonlyArray<ExclusionRule> => {
  const out: ExclusionRule[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const space = trimmed.search(/\s/);
    out.push(
      space === -1 ? { pattern: trimmed, passKeys: "" } : {
        pattern: trimmed.slice(0, space),
        passKeys: trimmed.slice(space + 1).trim(),
      },
    );
  }
  return out;
};

export const formatExclusionRules = (
  rules: ReadonlyArray<ExclusionRule>,
): string =>
  rules.map((rule) => `${rule.pattern} ${rule.passKeys}`.trimEnd()).join("\n");

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
    fields: [
      {
        kind: "block",
        key: "keyMappings",
        label: "Your map, unmap, unmapAll and mapkey lines",
        minHeight: "220px",
        // The defaults are written out when there is nothing stored, so that
        // the user can see what to change instead of an empty box.
        read: (settings) =>
          settings.keyMappings.length > 0
            ? settings.keyMappings
            : DEFAULT_MAPPINGS.trim(),
        write: (settings, value) => ({ ...settings, keyMappings: value }),
      },
    ],
  },
  {
    title: "Scrolling",
    fields: [
      {
        kind: "number",
        key: "scrollStepSize",
        label: "Scroll step size (px)",
        refuses: notANumber,
        clamps: outsideRange(1, 10_000),
        read: (settings) => String(settings.scrollStepSize),
        write: (settings, value) => ({
          ...settings,
          scrollStepSize: clampNumber(
            Number.parseInt(value, 10),
            1,
            10_000,
            settings.scrollStepSize,
          ),
        }),
      },
      {
        kind: "toggle",
        key: "smoothScroll",
        label: "Smooth scrolling",
        read: (settings) => settings.smoothScroll,
        write: (settings, value) => ({ ...settings, smoothScroll: value }),
      },
    ],
  },
  {
    title: "Link hints",
    fields: [
      {
        kind: "line",
        key: "linkHintCharacters",
        label: "Link hint characters",
        note: "Two or more, and all different.",
        refuses: shorterThanTwo,
        read: (settings) => settings.linkHintCharacters,
        write: (settings, value) => ({
          ...settings,
          linkHintCharacters: value.length >= 2
            ? value
            : settings.linkHintCharacters,
        }),
      },
      {
        kind: "line",
        key: "linkHintNumbers",
        label: "Digits that choose among filtered hints",
        note: "Two or more.",
        refuses: shorterThanTwo,
        read: (settings) => settings.linkHintNumbers,
        write: (settings, value) => ({
          ...settings,
          linkHintNumbers: value.length >= 2
            ? value
            : settings.linkHintNumbers,
        }),
      },
      {
        kind: "toggle",
        key: "filterLinkHints",
        label: "Filter link hints by text instead of by letter",
        read: (settings) => settings.filterLinkHints,
        write: (settings, value) => ({ ...settings, filterLinkHints: value }),
      },
      {
        kind: "toggle",
        key: "waitForEnterForFilteredHints",
        label: "Require Enter to activate a filtered hint",
        read: (settings) => settings.waitForEnterForFilteredHints,
        write: (settings, value) => ({
          ...settings,
          waitForEnterForFilteredHints: value,
        }),
      },
      {
        kind: "block",
        key: "userDefinedLinkHintCss",
        label: "Extra CSS for the hint markers",
        note: "Applied inside our shadow root only. No @import and no url().",
        minHeight: "100px",
        read: (settings) => settings.userDefinedLinkHintCss,
        write: (settings, value) => ({
          ...settings,
          userDefinedLinkHintCss: value,
        }),
      },
    ],
  },
  {
    title: "Finding text",
    fields: [
      {
        kind: "toggle",
        key: "regexFindMode",
        label: "Treat find queries as regular expressions",
        read: (settings) => settings.regexFindMode,
        write: (settings, value) => ({ ...settings, regexFindMode: value }),
      },
      {
        kind: "toggle",
        key: "shadowNativeFind",
        label: "Shadow the Find shortcut of the browser",
        note: "May not be preventable on iOS (WebKit bug 191768).",
        read: (settings) => settings.shadowNativeFind,
        write: (settings, value) => ({ ...settings, shadowNativeFind: value }),
      },
    ],
  },
  {
    title: "Searching and new tabs",
    fields: [
      {
        kind: "line",
        key: "searchUrl",
        label: "Default search URL",
        note: "It must contain %s, which is where your words go.",
        read: (settings) => settings.searchUrl,
        write: (settings, value) => ({ ...settings, searchUrl: value }),
      },
      {
        kind: "block",
        key: "searchEngines",
        label: "Search engines",
        note: "One `keyword: url-with-%s Description` for each line.",
        minHeight: "120px",
        read: (settings) => settings.searchEngines,
        write: (settings, value) => ({ ...settings, searchEngines: value }),
      },
      {
        kind: "line",
        key: "newTabUrl",
        label: "Page that a new tab opens",
        read: (settings) => settings.newTabUrl,
        write: (settings, value) => ({ ...settings, newTabUrl: value }),
      },
      {
        kind: "toggle",
        key: "enableSearchSuggestions",
        label: "Ask the search engine for omnibar completions",
        note:
          "Sends what you type in the omnibar to your search engine, with " +
          "your cookies, as you type it.",
        read: (settings) => settings.enableSearchSuggestions,
        write: (settings, value) => ({
          ...settings,
          enableSearchSuggestions: value,
        }),
      },
    ],
  },
  {
    title: "Navigating the page",
    description: "The link text that [ and ] look for. Separate the words " +
      "with a comma.",
    fields: [
      {
        kind: "line",
        key: "previousPatterns",
        label: "Words for the previous page",
        read: (settings) => settings.previousPatterns,
        write: (settings, value) => ({ ...settings, previousPatterns: value }),
      },
      {
        kind: "line",
        key: "nextPatterns",
        label: "Words for the next page",
        read: (settings) => settings.nextPatterns,
        write: (settings, value) => ({ ...settings, nextPatterns: value }),
      },
    ],
  },
  {
    title: "The overlay",
    fields: [
      {
        kind: "toggle",
        key: "hideHud",
        label: "Hide the HUD",
        read: (settings) => settings.hideHud,
        write: (settings, value) => ({ ...settings, hideHud: value }),
      },
      {
        kind: "toggle",
        key: "followPageColorScheme",
        label: "Match the colour scheme of the page",
        note: "When off, the overlay follows your system appearance instead.",
        read: (settings) => settings.followPageColorScheme,
        write: (settings, value) => ({
          ...settings,
          followPageColorScheme: value,
        }),
      },
    ],
  },
  {
    title: "Behaviour",
    fields: [
      {
        kind: "toggle",
        key: "ignoreKeyboardLayout",
        label: "Use physical key positions (ignore the keyboard layout)",
        read: (settings) => settings.ignoreKeyboardLayout,
        write: (settings, value) => ({
          ...settings,
          ignoreKeyboardLayout: value,
        }),
      },
      {
        kind: "toggle",
        key: "grabBackFocus",
        label: "Take focus back from a page that steals it on load",
        read: (settings) => settings.grabBackFocus,
        write: (settings, value) => ({ ...settings, grabBackFocus: value }),
      },
      {
        kind: "toggle",
        key: "passMediaKeys",
        label:
          "Leave the arrow keys and space to a focused video or audio player",
        note:
          "Turn off to scroll with them everywhere, even while a player has " +
          "focus.",
        read: (settings) => settings.passMediaKeys,
        write: (settings, value) => ({ ...settings, passMediaKeys: value }),
      },
      {
        kind: "toggle",
        key: "enableCssZoom",
        label: "Enable CSS zoom",
        note: "Not true browser zoom: it does not change the URL bar, and it " +
          "breaks position:fixed on some sites.",
        read: (settings) => settings.enableCssZoom,
        write: (settings, value) => ({ ...settings, enableCssZoom: value }),
      },
    ],
  },
  {
    title: "Omnibar history",
    fields: [
      {
        kind: "toggle",
        key: "enableHistoryIndex",
        label: "Build a local history index for the omnibar",
        note: "Recorded on this device only, and readable in the storage " +
          "viewer of your userscript manager.",
        read: (settings) => settings.enableHistoryIndex,
        write: (settings, value) => ({
          ...settings,
          enableHistoryIndex: value,
        }),
      },
      {
        kind: "block",
        key: "historyIndexDenylist",
        label: "URLs that the index never records",
        note: "One URL pattern for each line, for example " +
          "https://mail.example.com/*",
        minHeight: "80px",
        read: (settings) => settings.historyIndexDenylist.join("\n"),
        write: (settings, value) => ({
          ...settings,
          historyIndexDenylist: [...parseLines(value)],
        }),
      },
      {
        kind: "number",
        key: "historyIndexLimit",
        label: "Entries kept in the index",
        note: "0 stops the recording.",
        refuses: notANumber,
        clamps: outsideRange(0, 50_000),
        read: (settings) => String(settings.historyIndexLimit),
        write: (settings, value) => ({
          ...settings,
          historyIndexLimit: clampNumber(
            Number.parseInt(value, 10),
            0,
            50_000,
            settings.historyIndexLimit,
          ),
        }),
      },
    ],
  },
  {
    title: "Excluded sites",
    description: "One rule for each line: a URL pattern, and then the keys " +
      "to pass to the page. An empty key list turns Vimium-WebKit off for " +
      "that site.",
    fields: [
      {
        kind: "block",
        key: "exclusionRules",
        label: "Excluded sites",
        minHeight: "100px",
        read: (settings) => formatExclusionRules(settings.exclusionRules),
        write: (settings, value) => ({
          ...settings,
          exclusionRules: [...parseExclusionText(value)],
        }),
      },
    ],
  },
];

/** Every field of the dialog, in the order that the dialog draws it. */
export const SETTINGS_FIELDS: readonly SettingsField[] = SETTINGS_SECTIONS
  .flatMap((section) => section.fields);

/** The text of one field, whatever its kind. */
const fieldText = (
  field: SettingsField,
  settings: SettingsData,
): string =>
  field.kind === "toggle"
    ? String(field.read(settings))
    : field.read(settings);

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

const el = <K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] => {
  const node = doc.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
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
  SETTINGS_FIELDS
    .filter((field) => fieldText(field, offered) !== fieldText(field, stored))
    .map((field) => field.label);

/** One control, as the refusal check reads it. */
export interface OfferedText {
  readonly field: SettingsField;
  readonly text: string;
}

/** Does this field refuse this text? A toggle never refuses. */
const refusesText = (field: SettingsField, text: string): boolean =>
  field.kind !== "toggle" && field.refuses !== undefined &&
  field.refuses(text);

/** Does this field bring this text into its range? A toggle never does. */
const clampsText = (field: SettingsField, text: string): boolean =>
  field.kind !== "toggle" && field.clamps !== undefined &&
  field.clamps(text);

/** What the controls did with the text of the user, before the save. */
export interface FormNotes {
  /** The fields that keep their stored value, because `write` read nothing. */
  readonly refused: ReadonlyArray<string>;
  /** The fields whose number `write` brought into range. */
  readonly clamped: ReadonlyArray<string>;
}

/** Nothing to report: the reset button offers the defaults. */
export const NO_FORM_NOTES: FormNotes = { refused: [], clamped: [] };

/**
 * What the dialog must tell the user about the text that it read.
 *
 * `write` gives the stored settings, and the stored settings alone say
 * nothing: a refused field keeps its stored value, so `adjustedFields` finds
 * no difference, and a clamped field stores the bound, so `adjustedFields`
 * finds no difference either. The user typed, pressed Save, saw another value
 * and got no reason. This names each field, and it separates the two results,
 * because a clamped field does **not** keep its stored value.
 */
export const formNotes = (
  offered: ReadonlyArray<OfferedText>,
): FormNotes => ({
  refused: offered
    .filter((entry) => refusesText(entry.field, entry.text))
    .map((entry) => entry.field.label),
  clamped: offered
    .filter((entry) => clampsText(entry.field, entry.text))
    .map((entry) => entry.field.label),
});

// ---------------------------------------------------------------------------
// The focus trap
// ---------------------------------------------------------------------------

/**
 * Which control takes the focus for one Tab press.
 *
 * `current` is the position of the focused control, or -1 while the focus is
 * on the dialog box itself. The answer wraps at both ends, because
 * `aria-modal="true"` promises that nothing outside the dialog is available.
 * -1 means that the dialog holds no control, so the box itself keeps the
 * focus.
 */
export const nextFocusIndex = (
  count: number,
  current: number,
  backwards: boolean,
): number => {
  if (count <= 0) return -1;
  if (current < 0) return backwards ? count - 1 : 0;
  return (current + (backwards ? -1 : 1) + count) % count;
};

/**
 * The controls of one dialog, in document order.
 *
 * The order of the list is the order of the nodes, which is the tab order for
 * both dialogs: neither one holds a positive `tabindex`. A disabled control
 * and a control with `tabindex="-1"` drop out, because neither takes a Tab
 * press.
 */
const FOCUSABLE_SELECTOR =
  "a[href], button, input, select, textarea, [tabindex]";

const focusableIn = (dialog: HTMLElement): readonly HTMLElement[] =>
  [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)]
    .filter((element) =>
      !element.hasAttribute("disabled") && element.tabIndex >= 0
    );

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

/** One control of the settings dialog, with the field that it edits. */
type SettingsControl =
  | {
    readonly kind: "toggle";
    readonly field: ToggleField;
    readonly input: HTMLInputElement;
  }
  | {
    readonly kind: "value";
    readonly field: ValueField;
    readonly input: HTMLInputElement | HTMLTextAreaElement;
  };

/** The parts of the settings dialog that the save step writes back to. */
interface SettingsForm {
  readonly dialog: HTMLElement;
  readonly controls: readonly SettingsControl[];
  readonly problems: HTMLElement;
  readonly reset: HTMLButtonElement;
  readonly cancel: HTMLButtonElement;
  readonly save: HTMLButtonElement;
}

export class Dialog extends Context.Service<Dialog, {
  readonly showHelp: Effect.Effect<void>;
  readonly showSettings: Effect.Effect<void>;
  readonly close: Effect.Effect<void>;
}>()("vimium/ui/Dialog") {
  static readonly layer: Layer.Layer<
    Dialog,
    never,
    Ui | Dom | Settings | Mappings | Commands | Modes | Report | Capabilities
  > = Layer.effect(
    Dialog,
    Effect.gen(function*() {
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

      /** The scope of the open dialog. Closing it removes every part of it. */
      const openScope = yield* Ref.make<Option.Option<Scope.Closeable>>(
        Option.none(),
      );

      // One save at a time. A save reaches storage, so it cannot run on the
      // key path; it runs in this fiber instead.
      const saves = yield* FiberHandle.make<void, never>();

      const close: Effect.Effect<void> = Effect.gen(function*() {
        const open = yield* Ref.getAndSet(openScope, Option.none());
        if (Option.isSome(open)) yield* Scope.close(open.value, Exit.void);
      });

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
      const moveFocus = (dialog: HTMLElement, backwards: boolean): void => {
        const targets = focusableIn(dialog);
        const active = ui.shadow.activeElement;
        const current = targets.findIndex((element) => element === active);
        const index = nextFocusIndex(targets.length, current, backwards);
        const target = index < 0 ? dialog : targets[index];
        if (target !== undefined) target.focus();
      };

      /**
       * Put a dialog on screen, in a scope of its own.
       *
       * `build` gets the scope, so a listener that it registers goes away with
       * the dialog.
       */
      const present = Effect.fn("Dialog.present")(
        function*<A extends { readonly dialog: HTMLElement }>(
          build: Effect.Effect<A, never, Scope.Scope>,
        ) {
          yield* close;
          const scope = yield* Scope.make();
          const inScope = <B>(
            effect: Effect.Effect<B, never, Scope.Scope>,
          ): Effect.Effect<B> =>
            Effect.provideService(effect, Scope.Scope, scope);

          // The layer is opened before the dialog is built, so that the
          // release steps run in the other order: the dialog leaves the tree
          // first, and `aria-hidden` arrives on an empty layer. A layer that
          // became hidden while it still held the focused element is the state
          // that browsers warn about, because a screen reader loses the
          // focused node.
          yield* inScope(acceptPointerEvents(dialogLayer));
          // The dialog is a true control, so assistive technology must reach
          // it. The release step hides the layer again.
          yield* inScope(ui.expose(dialogLayer));

          const parts = yield* inScope(build);

          const backdrop = yield* inScope(Effect.acquireRelease(
            Effect.sync(() => {
              const element = el(doc, "div", "vw-dialog-backdrop");
              element.appendChild(parts.dialog);
              dialogLayer.appendChild(element);
              return element;
            }),
            (element) =>
              Effect.sync(() => {
                element.remove();
              }),
          ));

          yield* inScope(
            dom.listenOn(
              backdrop,
              "click",
              (event) => event.target === backdrop ? close : Effect.void,
            ),
          );

          // The dialog owns the keyboard. `SUPPRESS_PROPAGATION` keeps the
          // event from normal mode and from the page, and keeps the default
          // action, so the user can still type into a text area.
          //
          // Tab is the exception. `SUPPRESS_PROPAGATION` calls
          // `stopImmediatePropagation` only, so the default action of Tab took
          // the focus out of the dialog and on to the page behind it. That
          // breaks the promise of `aria-modal="true"`, which tells a screen
          // reader that the rest of the page is unavailable. `SUPPRESS_EVENT`
          // takes the key, and the trap moves the focus by hand.
          const mode = yield* inScope(modes.enter({
            name: "dialog",
            singleton: "dialog",
            exitOnEscape: true,
          }, {
            keydown: (event) =>
              Effect.sync(() => {
                if (event.key !== "Tab") return SUPPRESS_PROPAGATION;
                moveFocus(parts.dialog, event.shiftKey);
                return SUPPRESS_EVENT;
              }),
          }));
          yield* mode.onExit(() => close);

          yield* Ref.set(openScope, Option.some(scope));

          // Acquired last, so that its release step runs first: the focus
          // leaves the dialog before the dialog leaves the tree. A modal that
          // drops the focus leaves the user at the top of the document.
          yield* inScope(Effect.acquireRelease(
            dom.probeOr(
              () => Option.fromNullishOr(deepActiveElement(doc)),
              Option.none<Element>(),
            ),
            (previous) =>
              Effect.ignore(dom.attempt("HTMLElement.focus", () => {
                if (Option.isNone(previous)) return;
                const element = previous.value;
                if (element instanceof HTMLElement && element.isConnected) {
                  element.focus({ preventScroll: true });
                }
              })),
          ));

          yield* Effect.sync(() => {
            parts.dialog.tabIndex = -1;
            parts.dialog.focus({ preventScroll: true });
          });

          return parts;
        },
      );

      // ---------------------------------------------------------------
      // Help
      // ---------------------------------------------------------------

      const commandTable = (
        list: ReadonlyArray<CommandDef>,
        bound: ReadonlyMap<string, readonly string[]>,
      ): HTMLElement => {
        const table = el(doc, "div", "vw-cmd-table");
        for (const command of list) {
          if (command.advanced === true) continue;
          const keys = bound.get(command.name) ?? [];

          const keysCell = el(
            doc,
            "span",
            "vw-cmd-keys",
            keys.length === 0 ? "—" : keys.join("  "),
          );
          const descriptionCell = el(
            doc,
            "span",
            "vw-cmd-desc",
            command.description,
          );
          const nativeCell = el(
            doc,
            "span",
            "vw-cmd-native",
            command.tier === "C" ? command.nativeAlternative ?? "" : "",
          );

          for (const cell of [keysCell, descriptionCell, nativeCell]) {
            cell.classList.add("vw-cmd-row");
            cell.dataset["tier"] = command.tier;
          }

          if (command.tier === "C" && command.unavailableReason !== undefined) {
            descriptionCell.title = command.unavailableReason;
          }
          table.append(keysCell, descriptionCell, nativeCell);
        }
        return table;
      };

      const buildHelp = Effect.fn("Dialog.buildHelp")(function*() {
        // `compiledUnsafe`, because a command body reaches this from the key
        // path, which must not suspend.
        const compiled = mappings.compiledUnsafe();
        const bound = keysByCommand(compiled);

        const parts = yield* Effect.acquireRelease(
          Effect.sync(() => {
            const dialog = el(doc, "div", "vw-dialog");
            dialog.setAttribute("role", "dialog");
            dialog.setAttribute("aria-modal", "true");
            dialog.setAttribute("aria-label", "Vimium-WebKit help");

            dialog.appendChild(el(doc, "h1", undefined, "Vimium-WebKit"));
            dialog.appendChild(el(
              doc,
              "p",
              undefined,
              "A grey command cannot be done by a userscript. The shortcut of " +
                "the browser is beside it. Press Escape to close.",
            ));

            for (const group of GROUP_ORDER) {
              const list = commands.byGroup.get(group);
              if (list === undefined || list.length === 0) continue;
              dialog.appendChild(
                el(doc, "h2", undefined, GROUP_TITLES[group]),
              );
              dialog.appendChild(commandTable(list, bound));
            }

            dialog.appendChild(el(doc, "h2", undefined, "Diagnostics"));
            const diagnostics = el(doc, "pre", "vw-diagnostics");
            diagnostics.textContent = [
              formatCapabilities(capabilities),
              "",
              `commands                 ${commands.all.length}`,
            ].join("\n");
            dialog.appendChild(diagnostics);

            const problems = formatDiagnostics(compiled);
            if (problems.length > 0) {
              dialog.appendChild(el(doc, "h2", undefined, "Mapping problems"));
              const list = el(doc, "div", "vw-problem");
              list.textContent = problems.join("\n");
              dialog.appendChild(list);
            }

            const row = el(doc, "div", "vw-button-row");
            const settingsButton = el(
              doc,
              "button",
              "vw-button",
              "Settings…",
            );
            const closeButton = el(doc, "button", "vw-button", "Close");
            closeButton.dataset["variant"] = "primary";
            row.append(settingsButton, closeButton);
            dialog.appendChild(row);

            return { dialog, settingsButton, closeButton };
          }),
          (built) =>
            Effect.sync(() => {
              built.dialog.remove();
            }),
        );

        yield* dom.listenOn(
          parts.settingsButton,
          "click",
          () => showSettings,
        );
        yield* dom.listenOn(parts.closeButton, "click", () => close);
        return parts;
      });

      const showHelp: Effect.Effect<void> = Effect.asVoid(present(buildHelp()));

      // ---------------------------------------------------------------
      // Settings
      // ---------------------------------------------------------------

      /** Write the stored settings into the controls. */
      const fill = (form: SettingsForm, current: SettingsData): void => {
        for (const control of form.controls) {
          if (control.kind === "toggle") {
            control.input.checked = control.field.read(current);
            continue;
          }
          control.input.value = control.field.read(current);
        }
      };

      const readForm = (
        form: SettingsForm,
        base: SettingsData,
      ): SettingsData => {
        let next: SettingsData = base;
        for (const control of form.controls) {
          next = control.kind === "toggle"
            ? control.field.write(next, control.input.checked)
            : control.field.write(next, control.input.value);
        }
        return next;
      };

      /** What the user offered, as text, for the refusal check. */
      const offeredText = (form: SettingsForm): ReadonlyArray<OfferedText> =>
        form.controls.map((control) => ({
          field: control.field,
          text: control.kind === "toggle"
            ? String(control.input.checked)
            : control.input.value,
        }));

      /**
       * Store the settings, and tell the truth about the result.
       *
       * The dialog stays open when the mapping source still has an error, when
       * a control refused what the user typed, when a control brought a number
       * into range, and when storage repaired a field. In each case the dialog
       * is the only place where the user can see what happened.
       */
      const store = Effect.fn("Dialog.store")(
        function*(
          form: SettingsForm,
          next: SettingsData,
          notes: FormNotes,
        ) {
          const outcome = yield* Effect.catch(
            Effect.asSome(settings.save(next)),
            (error) =>
              Effect.as(
                report.error(`Settings were not saved: ${error.detail}`),
                Option.none<SettingsData>(),
              ),
          );
          // The failure already went to the user. Success must not be claimed
          // over it, and the dialog stays open.
          if (Option.isNone(outcome)) return;
          const stored = outcome.value;

          yield* Effect.sync(() => fill(form, stored));

          const compiled = yield* mappings.check(stored.keyMappings);
          const errors = compiled.diagnostics.filter(
            (entry) => entry.severity === "error",
          );
          if (errors.length > 0) {
            // Keep the dialog open. Closing it would hide the only place where
            // the user can correct the line that we refused.
            yield* Effect.sync(() => {
              form.problems.textContent = errors
                .map((entry) => `line ${entry.line}: ${entry.message}`)
                .join("\n");
            });
            return;
          }

          const changed = adjustedFields(next, stored);
          const lines: string[] = [];
          if (notes.refused.length > 0) {
            lines.push(
              `These fields keep their stored value, because the text was ` +
                `refused: ${notes.refused.join(", ")}.`,
            );
          }
          if (notes.clamped.length > 0) {
            // A clamped field did change. Saying that it kept its stored value
            // would be false, and the user would look for a value that is not
            // there.
            lines.push(
              `These fields were brought into range: ` +
                `${notes.clamped.join(", ")}.`,
            );
          }
          if (changed.length > 0) {
            lines.push(`Stored with changes to: ${changed.join(", ")}.`);
          }
          if (lines.length > 0) {
            lines.push("The values above are the stored ones.");
            yield* Effect.sync(() => {
              form.problems.textContent = lines.join(" ");
            });
            return;
          }

          yield* Effect.sync(() => {
            form.problems.textContent = "";
          });
          yield* close;
          yield* report.info("Settings saved");
        },
      );

      const buildSettings = Effect.fn("Dialog.buildSettings")(function*() {
        // `currentUnsafe`, because a command body reaches this from the key
        // path, which must not suspend.
        const current = settings.currentUnsafe();

        const form = yield* Effect.acquireRelease(
          Effect.sync(() => {
            const dialog = el(doc, "div", "vw-dialog");
            dialog.setAttribute("role", "dialog");
            dialog.setAttribute("aria-modal", "true");
            dialog.setAttribute("aria-label", "Vimium-WebKit settings");
            dialog.appendChild(el(doc, "h1", undefined, "Settings"));
            dialog.appendChild(el(
              doc,
              "p",
              undefined,
              storageExplanation(capabilities.value),
            ));

            const controls: SettingsControl[] = [];

            /** The label of one control, with its note inside it. */
            const labelFor = (
              field: SettingsField,
              id: string,
            ): HTMLLabelElement => {
              const label = doc.createElement("label");
              label.htmlFor = id;
              label.textContent = field.label;
              if (field.note !== undefined) {
                label.appendChild(
                  el(doc, "span", "vw-cmd-native", ` ${field.note}`),
                );
              }
              return label;
            };

            for (const section of SETTINGS_SECTIONS) {
              dialog.appendChild(el(doc, "h2", undefined, section.title));
              if (section.description !== undefined) {
                dialog.appendChild(
                  el(doc, "p", undefined, section.description),
                );
              }

              for (const field of section.fields) {
                // The id joins the label to the control. It is unique inside
                // our shadow root, which no page identifier can reach.
                const id = `vw-set-${field.key}`;

                if (field.kind === "toggle") {
                  const row = el(doc, "div", "vw-field");
                  const input = doc.createElement("input");
                  input.type = "checkbox";
                  input.id = id;
                  const label = labelFor(field, id);
                  row.append(input, label);
                  dialog.appendChild(row);
                  controls.push({ kind: "toggle", field, input });
                  continue;
                }

                if (field.kind === "block") {
                  const row = el(doc, "div", "vw-field vw-field--block");
                  row.appendChild(labelFor(field, id));
                  dialog.appendChild(row);
                  const area = el(doc, "textarea", "vw-textarea");
                  area.id = id;
                  area.spellcheck = false;
                  if (field.minHeight !== undefined) {
                    area.style.minHeight = field.minHeight;
                  }
                  dialog.appendChild(area);
                  controls.push({ kind: "value", field, input: area });
                  continue;
                }

                const row = el(doc, "div", "vw-field");
                const input = doc.createElement("input");
                input.id = id;
                input.type = field.kind === "number" ? "number" : "text";
                input.spellcheck = false;
                row.append(labelFor(field, id), input);
                dialog.appendChild(row);
                controls.push({ kind: "value", field, input });
              }
            }

            // One place for every message about the save: a refusal from
            // storage, a mapping error, and a field that the schema repaired.
            // `role="alert"` makes a screen reader speak it, because the
            // dialog stays open and nothing else says that it did.
            const problems = el(doc, "div", "vw-problem");
            problems.setAttribute("role", "alert");
            dialog.appendChild(problems);

            const row = el(doc, "div", "vw-button-row");
            const reset = el(doc, "button", "vw-button", "Reset to defaults");
            const cancel = el(doc, "button", "vw-button", "Cancel");
            const save = el(doc, "button", "vw-button", "Save");
            save.dataset["variant"] = "primary";
            row.append(reset, cancel, save);
            dialog.appendChild(row);

            const built: SettingsForm = {
              dialog,
              controls,
              problems,
              reset,
              cancel,
              save,
            };
            fill(built, current);
            return built;
          }),
          (built) =>
            Effect.sync(() => {
              built.dialog.remove();
            }),
        );

        // The store call reaches the backend, so it cannot run inside the
        // click dispatch. One fiber holds it, and a second click replaces it.
        const submit = (
          next: SettingsData,
          notes: FormNotes,
        ): Effect.Effect<void> =>
          Effect.asVoid(FiberHandle.run(saves, store(form, next, notes)));

        yield* dom.listenOn(
          form.save,
          "click",
          // The base is read again here, and not at build time. Another frame
          // can store a change while this dialog is open, and a field that
          // this dialog does not edit must keep that change.
          () =>
            submit(
              readForm(form, settings.currentUnsafe()),
              formNotes(offeredText(form)),
            ),
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

      const showSettings: Effect.Effect<void> = Effect.asVoid(
        present(buildSettings()),
      );

      // The commands that this layer owns. A feature registers its own bodies
      // in the same way, so no feature imports another feature.
      yield* commands.register("showHelp", () => showHelp);
      yield* commands.register("showSettings", () => showSettings);

      return Dialog.of({ showHelp, showSettings, close });
    }),
  );
}
