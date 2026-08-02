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
 * text areas.
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
import { SUPPRESS_PROPAGATION } from "~/core/HandlerStack.ts";
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
// The toggles
// ---------------------------------------------------------------------------

/**
 * One checkbox in the settings dialog.
 *
 * The field is reached with a reader and a writer, and not with a key. A key of
 * a union type cannot be written back into a struct without a cast, and there
 * is no cast in this application.
 */
interface Toggle {
  readonly label: string;
  readonly note?: string;
  readonly read: (settings: SettingsData) => boolean;
  readonly write: (settings: SettingsData, value: boolean) => SettingsData;
}

const TOGGLES: readonly Toggle[] = [
  {
    label: "Smooth scrolling",
    read: (settings) => settings.smoothScroll,
    write: (settings, value) => ({ ...settings, smoothScroll: value }),
  },
  {
    label: "Filter link hints by text instead of by letter",
    read: (settings) => settings.filterLinkHints,
    write: (settings, value) => ({ ...settings, filterLinkHints: value }),
  },
  {
    label: "Require Enter to activate a filtered hint",
    read: (settings) => settings.waitForEnterForFilteredHints,
    write: (settings, value) => ({
      ...settings,
      waitForEnterForFilteredHints: value,
    }),
  },
  {
    label: "Treat find queries as regular expressions",
    read: (settings) => settings.regexFindMode,
    write: (settings, value) => ({ ...settings, regexFindMode: value }),
  },
  {
    label: "Use physical key positions (ignore the keyboard layout)",
    read: (settings) => settings.ignoreKeyboardLayout,
    write: (settings, value) => ({ ...settings, ignoreKeyboardLayout: value }),
  },
  {
    label: "Hide the HUD",
    read: (settings) => settings.hideHud,
    write: (settings, value) => ({ ...settings, hideHud: value }),
  },
  {
    label: "Match the colour scheme of the page",
    note: "When off, the overlay follows your system appearance instead.",
    read: (settings) => settings.followPageColorScheme,
    write: (settings, value) => ({ ...settings, followPageColorScheme: value }),
  },
  {
    label: "Take focus back from a page that steals it on load",
    read: (settings) => settings.grabBackFocus,
    write: (settings, value) => ({ ...settings, grabBackFocus: value }),
  },
  {
    label: "Leave the arrow keys and space to a focused video or audio player",
    note:
      "Turn off to scroll with them everywhere, even while a player has focus.",
    read: (settings) => settings.passMediaKeys,
    write: (settings, value) => ({ ...settings, passMediaKeys: value }),
  },
  {
    label: "Enable CSS zoom",
    note: "Not true browser zoom: it does not change the URL bar, and it " +
      "breaks position:fixed on some sites.",
    read: (settings) => settings.enableCssZoom,
    write: (settings, value) => ({ ...settings, enableCssZoom: value }),
  },
  {
    label: "Build a local history index for the omnibar",
    note: "Recorded on this device only, and readable in the storage viewer " +
      "of your userscript manager.",
    read: (settings) => settings.enableHistoryIndex,
    write: (settings, value) => ({ ...settings, enableHistoryIndex: value }),
  },
  {
    label: "Ask the search engine for omnibar completions",
    note: "Sends what you type in the omnibar to your search engine, with " +
      "your cookies, as you type it.",
    read: (settings) => settings.enableSearchSuggestions,
    write: (settings, value) => ({
      ...settings,
      enableSearchSuggestions: value,
    }),
  },
  {
    label: "Shadow the Find shortcut of the browser",
    note: "May not be preventable on iOS (WebKit bug 191768).",
    read: (settings) => settings.shadowNativeFind,
    write: (settings, value) => ({ ...settings, shadowNativeFind: value }),
  },
];

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

const clampNumber = (
  value: number,
  min: number,
  max: number,
  fallback: number,
): number => {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
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
): ReadonlyArray<string> => {
  const changed: string[] = [];
  if (offered.keyMappings !== stored.keyMappings) changed.push("key mappings");
  if (offered.searchEngines !== stored.searchEngines) {
    changed.push("search engines");
  }
  if (
    formatExclusionRules(offered.exclusionRules) !==
      formatExclusionRules(stored.exclusionRules)
  ) {
    changed.push("excluded sites");
  }
  if (offered.scrollStepSize !== stored.scrollStepSize) {
    changed.push("scroll step size");
  }
  if (offered.linkHintCharacters !== stored.linkHintCharacters) {
    changed.push("link hint characters");
  }
  for (const toggle of TOGGLES) {
    if (toggle.read(offered) !== toggle.read(stored)) {
      changed.push(toggle.label);
    }
  }
  return changed;
};

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

/** The parts of the settings dialog that the save step writes back to. */
interface SettingsForm {
  readonly dialog: HTMLElement;
  readonly mappings: HTMLTextAreaElement;
  readonly engines: HTMLTextAreaElement;
  readonly exclusions: HTMLTextAreaElement;
  readonly step: HTMLInputElement;
  readonly hintCharacters: HTMLInputElement;
  readonly toggles: ReadonlyArray<readonly [Toggle, HTMLInputElement]>;
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

          yield* inScope(acceptPointerEvents(dialogLayer));

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
          const mode = yield* inScope(modes.enter({
            name: "dialog",
            singleton: "dialog",
            exitOnEscape: true,
          }, {
            keydown: () => Effect.succeed(SUPPRESS_PROPAGATION),
          }));
          yield* mode.onExit(() => close);

          yield* Ref.set(openScope, Option.some(scope));

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
        form.mappings.value = current.keyMappings.length > 0
          ? current.keyMappings
          : DEFAULT_MAPPINGS.trim();
        form.engines.value = current.searchEngines;
        form.exclusions.value = formatExclusionRules(current.exclusionRules);
        form.step.value = String(current.scrollStepSize);
        form.hintCharacters.value = current.linkHintCharacters;
        for (const [toggle, input] of form.toggles) {
          input.checked = toggle.read(current);
        }
      };

      const readForm = (
        form: SettingsForm,
        base: SettingsData,
      ): SettingsData => {
        let next: SettingsData = {
          ...base,
          keyMappings: form.mappings.value,
          searchEngines: form.engines.value,
          exclusionRules: [...parseExclusionText(form.exclusions.value)],
          scrollStepSize: clampNumber(
            Number.parseInt(form.step.value, 10),
            1,
            10_000,
            base.scrollStepSize,
          ),
          linkHintCharacters: form.hintCharacters.value.length >= 2
            ? form.hintCharacters.value
            : base.linkHintCharacters,
        };
        for (const [toggle, input] of form.toggles) {
          next = toggle.write(next, input.checked);
        }
        return next;
      };

      /**
       * Store the settings, and tell the truth about the result.
       *
       * The dialog stays open when the mapping source still has an error, and
       * when storage repaired a field. In both cases the dialog is the only
       * place where the user can see what happened.
       */
      const store = Effect.fn("Dialog.store")(
        function*(form: SettingsForm, next: SettingsData) {
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
          if (changed.length > 0) {
            yield* Effect.sync(() => {
              form.problems.textContent =
                `Stored with changes to: ${changed.join(", ")}. ` +
                "The values above are the stored ones.";
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
            dialog.setAttribute("aria-label", "Vimium-WebKit settings");
            dialog.appendChild(el(doc, "h1", undefined, "Settings"));
            dialog.appendChild(el(
              doc,
              "p",
              undefined,
              storageExplanation(capabilities.value),
            ));

            dialog.appendChild(el(doc, "h2", undefined, "Key mappings"));
            const mappingsField = el(doc, "textarea", "vw-textarea");
            mappingsField.spellcheck = false;
            dialog.appendChild(mappingsField);
            const problems = el(doc, "div", "vw-problem");
            dialog.appendChild(problems);

            dialog.appendChild(el(doc, "h2", undefined, "Search engines"));
            const engines = el(doc, "textarea", "vw-textarea");
            engines.spellcheck = false;
            engines.style.minHeight = "120px";
            dialog.appendChild(engines);

            dialog.appendChild(el(doc, "h2", undefined, "Excluded sites"));
            dialog.appendChild(el(
              doc,
              "p",
              undefined,
              "One rule for each line: a URL pattern, and then the keys to " +
                "pass to the page. An empty key list turns Vimium-WebKit off " +
                "for that site.",
            ));
            const exclusions = el(doc, "textarea", "vw-textarea");
            exclusions.spellcheck = false;
            exclusions.style.minHeight = "100px";
            dialog.appendChild(exclusions);

            dialog.appendChild(el(doc, "h2", undefined, "Behaviour"));
            const toggles: Array<readonly [Toggle, HTMLInputElement]> = [];
            for (const toggle of TOGGLES) {
              const field = el(doc, "div", "vw-field");
              const input = doc.createElement("input");
              input.type = "checkbox";
              const label = doc.createElement("label");
              label.textContent = toggle.label;
              if (toggle.note !== undefined) {
                label.appendChild(
                  el(doc, "span", "vw-cmd-native", ` ${toggle.note}`),
                );
              }
              label.prepend(input);
              field.appendChild(label);
              dialog.appendChild(field);
              toggles.push([toggle, input]);
            }

            const stepField = el(doc, "div", "vw-field");
            const stepLabel = doc.createElement("label");
            stepLabel.textContent = "Scroll step size (px)";
            const step = doc.createElement("input");
            step.type = "number";
            step.min = "1";
            step.max = "10000";
            stepField.append(stepLabel, step);
            dialog.appendChild(stepField);

            const hintField = el(doc, "div", "vw-field");
            const hintLabel = doc.createElement("label");
            hintLabel.textContent = "Link hint characters";
            const hintCharacters = doc.createElement("input");
            hintCharacters.type = "text";
            hintField.append(hintLabel, hintCharacters);
            dialog.appendChild(hintField);

            const row = el(doc, "div", "vw-button-row");
            const reset = el(doc, "button", "vw-button", "Reset to defaults");
            const cancel = el(doc, "button", "vw-button", "Cancel");
            const save = el(doc, "button", "vw-button", "Save");
            save.dataset["variant"] = "primary";
            row.append(reset, cancel, save);
            dialog.appendChild(row);

            const built: SettingsForm = {
              dialog,
              mappings: mappingsField,
              engines,
              exclusions,
              step,
              hintCharacters,
              toggles,
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
        const submit = (next: SettingsData): Effect.Effect<void> =>
          Effect.asVoid(FiberHandle.run(saves, store(form, next)));

        yield* dom.listenOn(
          form.save,
          "click",
          // The base is read again here, and not at build time. Another frame
          // can store a change while this dialog is open, and a field that
          // this dialog does not edit must keep that change.
          () => submit(readForm(form, settings.currentUnsafe())),
        );
        yield* dom.listenOn(
          form.reset,
          "click",
          () => submit(defaultSettings()),
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
