/**
 * The help and settings overlays.
 *
 * Upstream Vimium renders both in `web_accessible_resources` iframes. We have
 * no such origin, so these are plain DOM inside the closed shadow root (§6.3).
 *
 * Everything is built with `createElement` + `textContent`; there is no
 * `innerHTML` anywhere in this file. Command descriptions and key bindings are
 * partly user-supplied, and a userscript that could be made to inject markup
 * into its own privileged overlay would be a genuine vulnerability.
 */

import type {
  AppContext,
  CommandDef,
  CommandGroup,
  UiLayerName,
} from "~/core/context.ts";
import { formatCapabilities } from "~/platform/capabilities.ts";
import { keysByCommand } from "~/core/mappings.ts";
import type { CompiledMappings } from "~/core/mappings.ts";
import { defaultSettings, type Settings } from "~/settings/schema.ts";
import { DEFAULT_MAPPINGS } from "~/core/commands.ts";
import type { ShadowUiRoot } from "./root.ts";

const LAYER: UiLayerName = "dialog";

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

export interface DialogHost {
  readonly root: ShadowUiRoot;
  readonly app: AppContext;
  mappings(): CompiledMappings;
  saveSettings(next: Settings): Promise<void>;
  saveMappings(source: string): Promise<void>;
}

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

export class DialogController {
  readonly #host: DialogHost;
  readonly #doc: Document;
  #open: HTMLElement | null = null;
  #escapeListener: ((event: KeyboardEvent) => void) | null = null;

  constructor(host: DialogHost) {
    this.#host = host;
    this.#doc = host.root.shadow.ownerDocument;
  }

  get isOpen(): boolean {
    return this.#open !== null;
  }

  close(): void {
    if (this.#open === null) return;
    this.#open.remove();
    this.#open = null;
    this.#host.root.setInteractive(LAYER, false);
    if (this.#escapeListener) {
      globalThis.removeEventListener("keydown", this.#escapeListener, true);
      this.#escapeListener = null;
    }
  }

  #present(dialog: HTMLElement): void {
    this.close();
    const backdrop = el(this.#doc, "div", "vw-dialog-backdrop");
    backdrop.appendChild(dialog);
    backdrop.addEventListener("click", (event) => {
      if (event.target === backdrop) this.close();
    });

    this.#host.root.layer(LAYER).appendChild(backdrop);
    this.#host.root.setInteractive(LAYER, true);
    this.#open = backdrop;

    // Registered directly on `window` in the capture phase rather than on the
    // handler stack: the dialog owns the keyboard outright while it is up, and
    // routing through the stack would let normal mode see keystrokes typed into
    // the settings textarea.
    this.#escapeListener = (event: KeyboardEvent) => {
      event.stopPropagation();
      if (event.key === "Escape") {
        event.preventDefault();
        this.close();
      }
    };
    globalThis.addEventListener("keydown", this.#escapeListener, true);

    dialog.tabIndex = -1;
    dialog.focus({ preventScroll: true });
  }

  // -------------------------------------------------------------------------
  // Help
  // -------------------------------------------------------------------------

  showHelp(): void {
    const doc = this.#doc;
    const app = this.#host.app;
    const dialog = el(doc, "div", "vw-dialog");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-label", "Vimium-WebKit help");

    dialog.appendChild(el(doc, "h1", undefined, "Vimium-WebKit"));
    dialog.appendChild(
      el(
        doc,
        "p",
        undefined,
        "Struck-through commands cannot be implemented by a userscript; the " +
          "native browser shortcut is shown alongside. Press Escape to close.",
      ),
    );

    const bound = keysByCommand(this.#host.mappings());
    const grouped = app.commands.byGroup();

    for (const group of GROUP_ORDER) {
      const commands = grouped.get(group);
      if (!commands || commands.length === 0) continue;
      dialog.appendChild(el(doc, "h2", undefined, GROUP_TITLES[group]));
      dialog.appendChild(this.#commandTable(commands, bound));
    }

    dialog.appendChild(el(doc, "h2", undefined, "Diagnostics"));
    const diagnostics = el(doc, "pre", "vw-diagnostics");
    diagnostics.textContent = [
      formatCapabilities(app.caps),
      "",
      `frame                    ${app.frames.frameId}${
        app.frames.isTop ? " (top)" : ""
      }`,
      `known frames             ${app.frames.knownFrames().length}`,
    ].join("\n");
    dialog.appendChild(diagnostics);

    const mappingProblems = this.#host.mappings().diagnostics;
    if (mappingProblems.length > 0) {
      dialog.appendChild(el(doc, "h2", undefined, "Mapping problems"));
      const problems = el(doc, "div", "vw-problem");
      problems.textContent = mappingProblems
        .map((entry) =>
          `line ${entry.line}: ${entry.severity}: ${entry.message}`
        )
        .join("\n");
      dialog.appendChild(problems);
    }

    const row = el(doc, "div", "vw-button-row");
    const settingsButton = el(doc, "button", "vw-button", "Settings…");
    settingsButton.addEventListener("click", () => this.showSettings());
    const closeButton = el(doc, "button", "vw-button", "Close");
    closeButton.dataset["variant"] = "primary";
    closeButton.addEventListener("click", () => this.close());
    row.append(settingsButton, closeButton);
    dialog.appendChild(row);

    this.#present(dialog);
  }

  #commandTable(
    commands: readonly CommandDef[],
    bound: ReadonlyMap<string, readonly string[]>,
  ): HTMLElement {
    const doc = this.#doc;
    const table = el(doc, "div", "vw-cmd-table");

    for (const command of commands) {
      if (command.advanced === true) continue;
      const keys = bound.get(command.name) ?? [];

      const keysCell = el(doc, "span", "vw-cmd-keys", keys.join("  ") || "—");
      const descCell = el(doc, "span", "vw-cmd-desc", command.description);
      const nativeCell = el(
        doc,
        "span",
        "vw-cmd-native",
        command.tier === "C" ? command.nativeAlternative ?? "" : "",
      );

      for (const cell of [keysCell, descCell, nativeCell]) {
        cell.classList.add("vw-cmd-row");
        cell.dataset["tier"] = command.tier;
      }

      if (command.tier === "C" && command.unavailableReason !== undefined) {
        descCell.title = command.unavailableReason;
      }
      table.append(keysCell, descCell, nativeCell);
    }

    return table;
  }

  // -------------------------------------------------------------------------
  // Settings
  // -------------------------------------------------------------------------

  showSettings(): void {
    const doc = this.#doc;
    const app = this.#host.app;
    const current = app.settings();

    const dialog = el(doc, "div", "vw-dialog");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-label", "Vimium-WebKit settings");
    dialog.appendChild(el(doc, "h1", undefined, "Settings"));
    dialog.appendChild(
      el(
        doc,
        "p",
        undefined,
        "There is no options page for a userscript, so settings live here. " +
          "They are stored with your userscript manager, not in localStorage — " +
          "Safari erases localStorage after seven idle days.",
      ),
    );

    dialog.appendChild(el(doc, "h2", undefined, "Key mappings"));
    const mappings = el(doc, "textarea", "vw-textarea");
    mappings.value = current.keyMappings.length > 0
      ? current.keyMappings
      : DEFAULT_MAPPINGS.trim();
    mappings.spellcheck = false;
    dialog.appendChild(mappings);
    const mappingProblems = el(doc, "div", "vw-problem");
    dialog.appendChild(mappingProblems);

    dialog.appendChild(el(doc, "h2", undefined, "Search engines"));
    const engines = el(doc, "textarea", "vw-textarea");
    engines.value = current.searchEngines;
    engines.spellcheck = false;
    engines.style.minHeight = "120px";
    dialog.appendChild(engines);

    dialog.appendChild(el(doc, "h2", undefined, "Excluded sites"));
    dialog.appendChild(
      el(
        doc,
        "p",
        undefined,
        "One rule per line: a URL pattern, then optionally the keys to pass " +
          "through to the page. An empty key list disables Vimium-WebKit entirely.",
      ),
    );
    const exclusions = el(doc, "textarea", "vw-textarea");
    exclusions.value = current.exclusionRules
      .map((rule) => `${rule.pattern} ${rule.passKeys}`.trimEnd())
      .join("\n");
    exclusions.spellcheck = false;
    exclusions.style.minHeight = "100px";
    dialog.appendChild(exclusions);

    dialog.appendChild(el(doc, "h2", undefined, "Behaviour"));
    const toggles: Array<[keyof Settings, string, string?]> = [
      ["smoothScroll", "Smooth scrolling"],
      ["filterLinkHints", "Filter link hints by text instead of by letter"],
      [
        "waitForEnterForFilteredHints",
        "Require Enter to activate a filtered hint",
      ],
      ["regexFindMode", "Treat find queries as regular expressions"],
      [
        "ignoreKeyboardLayout",
        "Use physical key positions (ignore the keyboard layout)",
      ],
      ["hideHud", "Hide the HUD"],
      ["grabBackFocus", "Take focus back from pages that steal it on load"],
      [
        "enableCssZoom",
        "Enable CSS zoom",
        "Not real browser zoom: it does not affect the URL bar and breaks position:fixed on some sites.",
      ],
      [
        "enableHistoryIndex",
        "Build a local history index for the omnibar",
        "Recorded on this device only, and readable in your userscript manager's storage viewer.",
      ],
      [
        "shadowNativeFind",
        "Shadow the browser's own Find shortcut",
        "May not be preventable on iOS (WebKit bug 191768).",
      ],
    ];

    const checkboxes = new Map<keyof Settings, HTMLInputElement>();
    for (const [key, label, note] of toggles) {
      const field = el(doc, "div", "vw-field");
      const input = doc.createElement("input");
      input.type = "checkbox";
      input.checked = current[key] === true;
      const labelEl = doc.createElement("label");
      labelEl.textContent = label;
      if (note !== undefined) {
        const hint = el(doc, "span", "vw-cmd-native", ` ${note}`);
        labelEl.appendChild(hint);
      }
      labelEl.prepend(input);
      field.appendChild(labelEl);
      dialog.appendChild(field);
      checkboxes.set(key, input);
    }

    const stepField = el(doc, "div", "vw-field");
    const stepLabel = doc.createElement("label");
    stepLabel.textContent = "Scroll step size (px)";
    const stepInput = doc.createElement("input");
    stepInput.type = "number";
    stepInput.min = "1";
    stepInput.max = "10000";
    stepInput.value = String(current.scrollStepSize);
    stepField.append(stepLabel, stepInput);
    dialog.appendChild(stepField);

    const hintCharsField = el(doc, "div", "vw-field");
    const hintCharsLabel = doc.createElement("label");
    hintCharsLabel.textContent = "Link hint characters";
    const hintCharsInput = doc.createElement("input");
    hintCharsInput.type = "text";
    hintCharsInput.value = current.linkHintCharacters;
    hintCharsField.append(hintCharsLabel, hintCharsInput);
    dialog.appendChild(hintCharsField);

    const row = el(doc, "div", "vw-button-row");
    const resetButton = el(doc, "button", "vw-button", "Reset to defaults");
    resetButton.addEventListener("click", () => {
      void this.#host.saveSettings(defaultSettings()).then(() => this.close());
    });
    const cancelButton = el(doc, "button", "vw-button", "Cancel");
    cancelButton.addEventListener("click", () => this.close());
    const saveButton = el(doc, "button", "vw-button", "Save");
    saveButton.dataset["variant"] = "primary";

    saveButton.addEventListener("click", () => {
      const next: Settings = {
        ...current,
        keyMappings: mappings.value,
        searchEngines: engines.value,
        exclusionRules: [...parseExclusionText(exclusions.value)],
        scrollStepSize: clampNumber(
          Number.parseInt(stepInput.value, 10),
          1,
          10_000,
          current.scrollStepSize,
        ),
        linkHintCharacters: hintCharsInput.value.length >= 2
          ? hintCharsInput.value
          : current.linkHintCharacters,
        ...booleansFrom(checkboxes),
      };

      void this.#host.saveSettings(next).then(() => {
        const problems = this.#host.mappings().diagnostics.filter(
          (entry) => entry.severity === "error",
        );
        if (problems.length > 0) {
          // Keep the dialog open: closing it would hide the only place the user
          // can fix the line we just rejected.
          mappingProblems.textContent = problems
            .map((entry) => `line ${entry.line}: ${entry.message}`)
            .join("\n");
          return;
        }
        this.close();
        this.#host.app.hud.show("Settings saved");
      });
    });

    row.append(resetButton, cancelButton, saveButton);
    dialog.appendChild(row);

    this.#present(dialog);
  }
}

const booleansFrom = (
  checkboxes: ReadonlyMap<keyof Settings, HTMLInputElement>,
): Partial<Settings> => {
  const out: Record<string, boolean> = {};
  for (const [key, input] of checkboxes) out[key] = input.checked;
  // The cast is narrow and safe: every key came from a `keyof Settings` whose
  // value type is `boolean`, and no other keys are added.
  return out as Partial<Settings>;
};

const clampNumber = (
  value: number,
  min: number,
  max: number,
  fallback: number,
): number => {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
};

/** `pattern [passKeys]` per line; blank lines and `#` comments ignored. */
export const parseExclusionText = (
  text: string,
): ReadonlyArray<{ pattern: string; passKeys: string }> => {
  const out: Array<{ pattern: string; passKeys: string }> = [];
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

export const createDialogs = (host: DialogHost): DialogController =>
  new DialogController(host);
