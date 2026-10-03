/**
 * The command catalogue.
 *
 * This file is pure data. It gives the name, the description, the
 * availability and the group of every command. It holds no body, so the help
 * dialog and the mapping compiler can read it without a feature service.
 *
 * A command that this userscript cannot do stays in the catalogue. The help
 * dialog shows it grey, beside the native browser shortcut, and a key press
 * gives an explanation instead of silence.
 */

import { Data, Option, Record, Schema, Struct, pipe } from "effect";
import type { NoFields } from "~/domain/Prelude.ts";

/**
 * Whether this userscript can do a command.
 *
 * A command that cannot work is `Unavailable`. It says why, and it names the
 * shortcut of the browser when there is one, for example "⌘⇧T".
 */
export type CommandAvailability = Data.TaggedEnum<{
  Available: NoFields;
  Unavailable: { readonly reason: string; readonly nativeAlternative: Option.Option<string> };
}>;

export const CommandAvailability = Data.taggedEnum<CommandAvailability>();

export type CommandGroup =
  | "navigation"
  | "scrolling"
  | "hints"
  | "find"
  | "text"
  | "tabs"
  | "clipboard"
  | "marks"
  | "misc";

/** What the catalogue says about one command. The key of the entry is the name. */
interface CommandSpec {
  readonly description: string;
  readonly availability: CommandAvailability;
  readonly group: CommandGroup;
  /** Hidden from the default help dialog. */
  readonly advanced?: boolean;
}

const AVAILABLE = CommandAvailability.Available();

/** The reason that every tab command is unavailable. */
const NO_TAB_API = "a userscript has no tab-management API";

/** Every command, keyed by name. */
const SPECS = {
  // --- Scrolling ---------------------------------------------------------
  scrollDown: {
    group: "scrolling",
    description: "Scroll down",
    availability: AVAILABLE,
  },
  scrollUp: {
    group: "scrolling",
    description: "Scroll up",
    availability: AVAILABLE,
  },
  scrollLeft: {
    group: "scrolling",
    description: "Scroll left",
    availability: AVAILABLE,
  },
  scrollRight: {
    group: "scrolling",
    description: "Scroll right",
    availability: AVAILABLE,
  },
  scrollPageDown: {
    group: "scrolling",
    description: "Scroll a half page down",
    availability: AVAILABLE,
  },
  scrollPageUp: {
    group: "scrolling",
    description: "Scroll a half page up",
    availability: AVAILABLE,
  },
  scrollFullPageDown: {
    group: "scrolling",
    description: "Scroll a full page down",
    availability: AVAILABLE,
  },
  scrollFullPageUp: {
    group: "scrolling",
    description: "Scroll a full page up",
    availability: AVAILABLE,
  },
  scrollToTop: {
    group: "scrolling",
    description: "Scroll to the top of the page",
    availability: AVAILABLE,
  },
  scrollToBottom: {
    group: "scrolling",
    description: "Scroll to the bottom of the page",
    availability: AVAILABLE,
  },
  scrollToLeft: {
    group: "scrolling",
    description: "Scroll all the way left",
    availability: AVAILABLE,
  },
  scrollToRight: {
    group: "scrolling",
    description: "Scroll all the way right",
    availability: AVAILABLE,
  },

  // --- Navigation --------------------------------------------------------
  reload: {
    group: "navigation",
    description: "Reload the page",
    availability: AVAILABLE,
  },
  reloadHard: {
    group: "navigation",
    description: "Reload, bypassing the cache",
    availability: CommandAvailability.Unavailable({
      reason: "a userscript cannot ask the browser to bypass its cache",
      nativeAlternative: Option.some("⇧⌘R"),
    }),
  },
  goBack: {
    group: "navigation",
    description: "Go back in history",
    availability: AVAILABLE,
  },
  goForward: {
    group: "navigation",
    description: "Go forward in history",
    availability: AVAILABLE,
  },
  goUp: {
    group: "navigation",
    description: "Go up the URL hierarchy",
    availability: AVAILABLE,
  },
  goToRoot: {
    group: "navigation",
    description: "Go to the site root",
    availability: AVAILABLE,
  },
  goPrevious: {
    group: "navigation",
    description: 'Follow the "previous" link',
    availability: AVAILABLE,
  },
  goNext: {
    group: "navigation",
    description: 'Follow the "next" link',
    availability: AVAILABLE,
  },

  // --- Hints -------------------------------------------------------------
  "LinkHints.activateMode": {
    group: "hints",
    description: "Open a link",
    availability: AVAILABLE,
  },
  "LinkHints.activateModeToOpenInNewTab": {
    group: "hints",
    description: "Open a link in a new background tab",
    availability: AVAILABLE,
  },
  "LinkHints.activateModeToOpenInNewForegroundTab": {
    group: "hints",
    description: "Open a link in a new foreground tab",
    availability: AVAILABLE,
  },
  "LinkHints.activateModeToHover": {
    group: "hints",
    description: "Hover over an element",
    availability: AVAILABLE,
  },
  "LinkHints.activateModeToFocus": {
    group: "hints",
    description: "Focus an element",
    availability: AVAILABLE,
  },
  "LinkHints.activateModeToCopyLinkUrl": {
    group: "hints",
    description: "Copy a link's URL",
    availability: AVAILABLE,
  },
  "LinkHints.activateModeToCopyLinkText": {
    group: "hints",
    description: "Copy a link's text",
    availability: AVAILABLE,
  },
  "LinkHints.activateModeWithOmnibar": {
    group: "hints",
    description: "Open a link with the omnibar",
    availability: AVAILABLE,
  },
  "LinkHints.activateModeToDownloadLink": {
    group: "hints",
    description: "Download a link",
    availability: CommandAvailability.Unavailable({
      reason:
        "WebKit ignores synthetic modifier-clicks, so a script cannot reach the download path",
      nativeAlternative: Option.some("right-click → Download Linked File"),
    }),
  },
  "LinkHints.activateModeToOpenIncognito": {
    group: "hints",
    description: "Open a link in a private window",
    availability: CommandAvailability.Unavailable({
      reason: "there is no window-creation API for a userscript",
      nativeAlternative: Option.none(),
    }),
  },

  // --- Find --------------------------------------------------------------
  enterFindMode: {
    group: "find",
    description: "Search the page",
    availability: AVAILABLE,
  },
  performFind: {
    group: "find",
    description: "Go to the next match",
    availability: AVAILABLE,
  },
  performBackwardsFind: {
    group: "find",
    description: "Go to the previous match",
    availability: AVAILABLE,
  },
  searchWordForwards: {
    group: "find",
    description: "Search for the word under the cursor",
    availability: AVAILABLE,
  },
  searchWordBackwards: {
    group: "find",
    description: "Search backwards for the word under the cursor",
    availability: AVAILABLE,
  },

  // --- Text --------------------------------------------------------------
  enterVisualMode: {
    group: "text",
    description: "Enter visual mode",
    availability: AVAILABLE,
  },
  enterVisualLineMode: {
    group: "text",
    description: "Enter visual line mode",
    availability: AVAILABLE,
  },
  enterCaretMode: {
    group: "text",
    description: "Enter caret mode",
    availability: AVAILABLE,
  },
  enterInsertMode: {
    group: "text",
    description: "Enter insert mode",
    availability: AVAILABLE,
  },
  focusInput: {
    group: "text",
    description: "Focus a text input",
    availability: AVAILABLE,
  },

  // --- Clipboard ---------------------------------------------------------
  copyCurrentUrl: {
    group: "clipboard",
    description: "Copy this page's URL",
    availability: AVAILABLE,
  },
  copyCurrentTitle: {
    group: "clipboard",
    description: "Copy this page's title",
    availability: AVAILABLE,
  },
  openCopiedUrlInCurrentTab: {
    group: "clipboard",
    description: "Open a pasted URL",
    availability: AVAILABLE,
  },
  openCopiedUrlInNewTab: {
    group: "clipboard",
    description: "Open a pasted URL in a new tab",
    availability: AVAILABLE,
  },

  // --- Tabs --------------------------------------------------------------
  createTab: {
    group: "tabs",
    description: "Open a new tab",
    availability: AVAILABLE,
  },
  removeTab: {
    group: "tabs",
    description: "Close this tab",
    availability: AVAILABLE,
  },
  toggleMuteTab: {
    group: "tabs",
    description: "Mute or unmute media on this page",
    availability: AVAILABLE,
  },
  zoomIn: {
    group: "tabs",
    description: "Zoom in (CSS zoom)",
    availability: AVAILABLE,
  },
  zoomOut: {
    group: "tabs",
    description: "Zoom out (CSS zoom)",
    availability: AVAILABLE,
  },
  zoomReset: {
    group: "tabs",
    description: "Reset zoom",
    availability: AVAILABLE,
  },
  toggleViewSource: {
    group: "navigation",
    description: "View this page's source",
    availability: AVAILABLE,
  },
  restoreTab: {
    group: "tabs",
    description: "Reopen the last closed tab",
    availability: CommandAvailability.Unavailable({
      reason: "there is no session API",
      nativeAlternative: Option.some("⌘⇧T"),
    }),
  },
  nextTab: {
    group: "tabs",
    description: "Go to the next tab",
    availability: CommandAvailability.Unavailable({
      reason: NO_TAB_API,
      nativeAlternative: Option.some("⌘⇧]"),
    }),
  },
  previousTab: {
    group: "tabs",
    description: "Go to the previous tab",
    availability: CommandAvailability.Unavailable({
      reason: NO_TAB_API,
      nativeAlternative: Option.some("⌘⇧["),
    }),
  },
  firstTab: {
    group: "tabs",
    description: "Go to the first tab",
    availability: CommandAvailability.Unavailable({
      reason: NO_TAB_API,
      nativeAlternative: Option.some("⌘1"),
    }),
  },
  lastTab: {
    group: "tabs",
    description: "Go to the last tab",
    availability: CommandAvailability.Unavailable({
      reason: NO_TAB_API,
      nativeAlternative: Option.some("⌘9"),
    }),
  },
  visitPreviousTab: {
    group: "tabs",
    description: "Go to the previously visited tab",
    availability: CommandAvailability.Unavailable({
      reason: NO_TAB_API,
      nativeAlternative: Option.none(),
    }),
  },
  moveTabLeft: {
    group: "tabs",
    description: "Move this tab left",
    availability: CommandAvailability.Unavailable({
      reason: NO_TAB_API,
      nativeAlternative: Option.some("drag the tab"),
    }),
  },
  moveTabRight: {
    group: "tabs",
    description: "Move this tab right",
    availability: CommandAvailability.Unavailable({
      reason: NO_TAB_API,
      nativeAlternative: Option.some("drag the tab"),
    }),
  },
  moveTabToNewWindow: {
    group: "tabs",
    description: "Move this tab to a new window",
    availability: CommandAvailability.Unavailable({
      reason: NO_TAB_API,
      nativeAlternative: Option.some("drag the tab out"),
    }),
  },
  togglePinTab: {
    group: "tabs",
    description: "Pin or unpin this tab",
    availability: CommandAvailability.Unavailable({
      reason: NO_TAB_API,
      nativeAlternative: Option.some("right-click the tab"),
    }),
  },
  duplicateTab: {
    group: "tabs",
    description: "Duplicate this tab",
    availability: CommandAvailability.Unavailable({
      reason: NO_TAB_API,
      nativeAlternative: Option.some("right-click the tab"),
    }),
  },
  closeTabsOnLeft: {
    group: "tabs",
    description: "Close tabs to the left",
    availability: CommandAvailability.Unavailable({
      reason: NO_TAB_API,
      nativeAlternative: Option.some("right-click the tab"),
    }),
  },
  closeTabsOnRight: {
    group: "tabs",
    description: "Close tabs to the right",
    availability: CommandAvailability.Unavailable({
      reason: NO_TAB_API,
      nativeAlternative: Option.some("right-click the tab"),
    }),
  },
  closeOtherTabs: {
    group: "tabs",
    description: "Close all other tabs",
    availability: CommandAvailability.Unavailable({
      reason: NO_TAB_API,
      nativeAlternative: Option.some("right-click the tab"),
    }),
  },

  // --- Marks -------------------------------------------------------------
  "Marks.activateCreateMode": {
    group: "marks",
    description: "Set a mark",
    availability: AVAILABLE,
  },
  "Marks.activateGotoMode": {
    group: "marks",
    description: "Jump to a mark",
    availability: AVAILABLE,
  },

  // --- Omnibar -----------------------------------------------------------
  "Vomnibar.activate": {
    group: "navigation",
    description: "Open the omnibar",
    availability: AVAILABLE,
  },
  "Vomnibar.activateInNewTab": {
    group: "navigation",
    description: "Open the omnibar (new tab)",
    availability: AVAILABLE,
  },
  "Vomnibar.activateCommands": {
    group: "misc",
    description: "Open the command palette",
    availability: AVAILABLE,
  },
  "Vomnibar.activateSearch": {
    group: "navigation",
    description: "Search with a custom engine",
    availability: AVAILABLE,
  },
  "Vomnibar.activateBookmarks": {
    group: "navigation",
    description: "Search bookmarks",
    availability: CommandAvailability.Unavailable({
      reason: "there is no bookmarks API for a userscript",
      nativeAlternative: Option.some("⌥⌘B"),
    }),
  },
  "clear-history": {
    group: "misc",
    description: "Erase the local history index",
    availability: AVAILABLE,
  },

  // --- Frames ------------------------------------------------------------
  nextFrame: {
    group: "navigation",
    description: "Focus the next frame",
    availability: AVAILABLE,
  },
  mainFrame: {
    group: "navigation",
    description: "Focus the main frame",
    availability: AVAILABLE,
  },

  // --- Misc --------------------------------------------------------------
  showHelp: {
    group: "misc",
    description: "Show the help dialog",
    availability: AVAILABLE,
  },
  showSettings: {
    group: "misc",
    description: "Open settings",
    availability: AVAILABLE,
  },
  passNextKey: {
    group: "misc",
    description: "Pass the next key to the page",
    availability: AVAILABLE,
    advanced: true,
  },
} satisfies Record.ReadonlyRecord<string, CommandSpec>;

export type CommandName = keyof typeof SPECS;

/** Is this text the name of a command in the catalogue? */
export const isCommandName = Schema.is(Schema.Literals(Record.keys(SPECS)));

export interface CommandDef extends CommandSpec {
  readonly name: CommandName;
}

/** Every command, keyed by name. Each entry carries its name. */
export const COMMANDS: Record.ReadonlyRecord<CommandName, CommandDef> = pipe(
  SPECS,
  Record.map((spec, name) => pipe(spec, Struct.assign({ name }))),
);

/**
 * The default `map` lines, compiled before the user's own.
 *
 * These are the default bindings of Vimium. An unavailable command keeps its binding.
 * A press of `J` must give the reason why tab control is not possible. It must
 * not do nothing.
 */
export const DEFAULT_MAPPINGS: string = `
# Scrolling
map j scrollDown
map k scrollUp
map h scrollLeft
map l scrollRight
map <down> scrollDown
map <up> scrollUp
map <left> scrollLeft
map <right> scrollRight
map gg scrollToTop
map G scrollToBottom
map zH scrollToLeft
map zL scrollToRight
map 0 scrollToLeft
map $ scrollToRight
map d scrollPageDown
map u scrollPageUp
map <c-d> scrollPageDown
map <c-u> scrollPageUp
map <c-f> scrollFullPageDown
map <c-b> scrollFullPageUp
map <space> scrollFullPageDown
map <s-space> scrollFullPageUp

# Navigation
map r reload
map R reloadHard
map H goBack
map L goForward
map gu goUp
map gU goToRoot
map [[ goPrevious
map ]] goNext
map gs toggleViewSource
map gf nextFrame
map gF mainFrame

# Link hints
# An Option chord on macOS makes a glyph: Option+F reports "ƒ". The key path
# reads the character that the key makes with no modifier, so <a-f> is the F
# key of your own layout, and not the F position of a US keyboard.
map f LinkHints.activateMode
map F LinkHints.activateModeToOpenInNewTab
map <a-f> LinkHints.activateModeToOpenInNewForegroundTab
map yf LinkHints.activateModeToCopyLinkUrl
map yt LinkHints.activateModeToCopyLinkText
map <a-h> LinkHints.activateModeToHover
map <a-o> LinkHints.activateModeWithOmnibar
map gd LinkHints.activateModeToDownloadLink
map gI LinkHints.activateModeToOpenIncognito

# Find
map / enterFindMode
map n performFind
map N performBackwardsFind
map * searchWordForwards
map # searchWordBackwards

# Text
map i enterInsertMode
map v enterVisualMode
map V enterVisualLineMode
map c enterCaretMode
map gi focusInput

# Clipboard
map yy copyCurrentUrl
map yT copyCurrentTitle
map p openCopiedUrlInCurrentTab
map P openCopiedUrlInNewTab

# Omnibar
map o Vomnibar.activate
map O Vomnibar.activateInNewTab
map : Vomnibar.activateCommands
map s Vomnibar.activateSearch
map b Vomnibar.activateBookmarks

# Marks
map m Marks.activateCreateMode
map \` Marks.activateGotoMode

# Tabs
map t createTab
map x removeTab
map <a-m> toggleMuteTab
map zi zoomIn
map zo zoomOut
map z0 zoomReset
map X restoreTab
map J previousTab
map K nextTab
map gT previousTab
map gt nextTab
map g0 firstTab
map g$ lastTab
map ^ visitPreviousTab
map W moveTabToNewWindow
map << moveTabLeft
map >> moveTabRight
map <a-p> togglePinTab
map yd duplicateTab

# Misc
map ? showHelp
`;
