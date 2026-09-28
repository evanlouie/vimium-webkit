/**
 * The command catalogue.
 *
 * This file is pure data. It gives the name, the description, the tier and the
 * group of every command. It holds no body, so the help dialog and the mapping
 * compiler can read it without a feature service.
 *
 * A tier C command stays in the catalogue. It is a command that this userscript
 * cannot do. The help dialog shows it grey, beside the native browser shortcut,
 * and a key press gives an explanation instead of silence.
 */

import { Data, Option } from "effect";

/**
 * Whether this userscript can do a command.
 *
 * A command that works is tier A, with full parity, or tier B, with a caveat.
 * A tier C command is `Unavailable`. It says why, and it names the shortcut of
 * the browser when there is one, for example "⌘⇧T".
 */
export type CommandAvailability = Data.TaggedEnum<{
  Available: { readonly tier: "A" | "B" };
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

export interface CommandDef {
  readonly name: CommandName;
  readonly description: string;
  readonly availability: CommandAvailability;
  readonly group: CommandGroup;
  /** Honours the count prefix. */
  readonly repeatable?: boolean;
  /** Runs in the top frame only. A child frame forwards it. */
  readonly topFrameOnly?: boolean;
  /** Hidden from the default help dialog. */
  readonly advanced?: boolean;
}

/**
 * The shape that each entry of `COMMANDS` must have.
 *
 * `CommandDef` types `name` as `CommandName`, and `CommandName` comes from
 * `COMMANDS`. A `satisfies CommandDef` in the initializer of `COMMANDS` is
 * therefore circular. This local type breaks the cycle. It keeps `name` as a
 * plain string, and `as const` keeps each literal key.
 */
interface CommandSpec {
  readonly name: string;
  readonly description: string;
  readonly availability: CommandAvailability;
  readonly group: CommandGroup;
  readonly repeatable?: boolean;
  readonly topFrameOnly?: boolean;
  readonly advanced?: boolean;
}

/** Tier A: full parity, and no manager capability. */
const TIER_A = CommandAvailability.Available({ tier: "A" });

/** Tier B: it works, with a documented caveat or a manager capability. */
const TIER_B = CommandAvailability.Available({ tier: "B" });

/** The reason that every tab command is tier C. */
const NO_TAB_API = "a userscript has no tab-management API";

/** Every command, keyed by name. */
export const COMMANDS = {
  // --- Scrolling ---------------------------------------------------------
  scrollDown: {
    name: "scrollDown",
    group: "scrolling",
    description: "Scroll down",
    availability: TIER_A,
    repeatable: true,
  },
  scrollUp: {
    name: "scrollUp",
    group: "scrolling",
    description: "Scroll up",
    availability: TIER_A,
    repeatable: true,
  },
  scrollLeft: {
    name: "scrollLeft",
    group: "scrolling",
    description: "Scroll left",
    availability: TIER_A,
    repeatable: true,
  },
  scrollRight: {
    name: "scrollRight",
    group: "scrolling",
    description: "Scroll right",
    availability: TIER_A,
    repeatable: true,
  },
  scrollPageDown: {
    name: "scrollPageDown",
    group: "scrolling",
    description: "Scroll a half page down",
    availability: TIER_A,
    repeatable: true,
  },
  scrollPageUp: {
    name: "scrollPageUp",
    group: "scrolling",
    description: "Scroll a half page up",
    availability: TIER_A,
    repeatable: true,
  },
  scrollFullPageDown: {
    name: "scrollFullPageDown",
    group: "scrolling",
    description: "Scroll a full page down",
    availability: TIER_A,
    repeatable: true,
  },
  scrollFullPageUp: {
    name: "scrollFullPageUp",
    group: "scrolling",
    description: "Scroll a full page up",
    availability: TIER_A,
    repeatable: true,
  },
  scrollToTop: {
    name: "scrollToTop",
    group: "scrolling",
    description: "Scroll to the top of the page",
    availability: TIER_A,
  },
  scrollToBottom: {
    name: "scrollToBottom",
    group: "scrolling",
    description: "Scroll to the bottom of the page",
    availability: TIER_A,
  },
  scrollToLeft: {
    name: "scrollToLeft",
    group: "scrolling",
    description: "Scroll all the way left",
    availability: TIER_A,
  },
  scrollToRight: {
    name: "scrollToRight",
    group: "scrolling",
    description: "Scroll all the way right",
    availability: TIER_A,
  },

  // --- Navigation --------------------------------------------------------
  reload: {
    name: "reload",
    group: "navigation",
    description: "Reload the page",
    availability: TIER_A,
  },
  reloadHard: {
    name: "reloadHard",
    group: "navigation",
    description: "Reload, bypassing the cache",
    availability: CommandAvailability.Unavailable({
      reason: "a userscript cannot ask the browser to bypass its cache",
      nativeAlternative: Option.some("⇧⌘R"),
    }),
  },
  goBack: {
    name: "goBack",
    group: "navigation",
    description: "Go back in history",
    availability: TIER_A,
    repeatable: true,
  },
  goForward: {
    name: "goForward",
    group: "navigation",
    description: "Go forward in history",
    availability: TIER_A,
    repeatable: true,
  },
  goUp: {
    name: "goUp",
    group: "navigation",
    description: "Go up the URL hierarchy",
    availability: TIER_A,
    repeatable: true,
  },
  goToRoot: {
    name: "goToRoot",
    group: "navigation",
    description: "Go to the site root",
    availability: TIER_A,
  },
  goPrevious: {
    name: "goPrevious",
    group: "navigation",
    description: 'Follow the "previous" link',
    availability: TIER_A,
  },
  goNext: {
    name: "goNext",
    group: "navigation",
    description: 'Follow the "next" link',
    availability: TIER_A,
  },

  // --- Hints -------------------------------------------------------------
  "LinkHints.activateMode": {
    name: "LinkHints.activateMode",
    group: "hints",
    description: "Open a link",
    availability: TIER_A,
  },
  "LinkHints.activateModeToOpenInNewTab": {
    name: "LinkHints.activateModeToOpenInNewTab",
    group: "hints",
    description: "Open a link in a new background tab",
    availability: TIER_B,
  },
  "LinkHints.activateModeToOpenInNewForegroundTab": {
    name: "LinkHints.activateModeToOpenInNewForegroundTab",
    group: "hints",
    description: "Open a link in a new foreground tab",
    availability: TIER_B,
  },
  "LinkHints.activateModeToHover": {
    name: "LinkHints.activateModeToHover",
    group: "hints",
    description: "Hover over an element",
    availability: TIER_A,
  },
  "LinkHints.activateModeToFocus": {
    name: "LinkHints.activateModeToFocus",
    group: "hints",
    description: "Focus an element",
    availability: TIER_A,
  },
  "LinkHints.activateModeToCopyLinkUrl": {
    name: "LinkHints.activateModeToCopyLinkUrl",
    group: "hints",
    description: "Copy a link's URL",
    availability: TIER_B,
  },
  "LinkHints.activateModeToCopyLinkText": {
    name: "LinkHints.activateModeToCopyLinkText",
    group: "hints",
    description: "Copy a link's text",
    availability: TIER_B,
  },
  "LinkHints.activateModeWithOmnibar": {
    name: "LinkHints.activateModeWithOmnibar",
    group: "hints",
    description: "Open a link with the omnibar",
    availability: TIER_B,
  },
  "LinkHints.activateModeToDownloadLink": {
    name: "LinkHints.activateModeToDownloadLink",
    group: "hints",
    description: "Download a link",
    availability: CommandAvailability.Unavailable({
      reason:
        "WebKit ignores synthetic modifier-clicks, so a script cannot reach the download path",
      nativeAlternative: Option.some("right-click → Download Linked File"),
    }),
  },
  "LinkHints.activateModeToOpenIncognito": {
    name: "LinkHints.activateModeToOpenIncognito",
    group: "hints",
    description: "Open a link in a private window",
    availability: CommandAvailability.Unavailable({
      reason: "there is no window-creation API for a userscript",
      nativeAlternative: Option.none(),
    }),
  },

  // --- Find --------------------------------------------------------------
  enterFindMode: {
    name: "enterFindMode",
    group: "find",
    description: "Search the page",
    availability: TIER_A,
  },
  performFind: {
    name: "performFind",
    group: "find",
    description: "Go to the next match",
    availability: TIER_A,
    repeatable: true,
  },
  performBackwardsFind: {
    name: "performBackwardsFind",
    group: "find",
    description: "Go to the previous match",
    availability: TIER_A,
    repeatable: true,
  },
  searchWordForwards: {
    name: "searchWordForwards",
    group: "find",
    description: "Search for the word under the cursor",
    availability: TIER_A,
  },
  searchWordBackwards: {
    name: "searchWordBackwards",
    group: "find",
    description: "Search backwards for the word under the cursor",
    availability: TIER_A,
  },

  // --- Text --------------------------------------------------------------
  enterVisualMode: {
    name: "enterVisualMode",
    group: "text",
    description: "Enter visual mode",
    availability: TIER_A,
  },
  enterVisualLineMode: {
    name: "enterVisualLineMode",
    group: "text",
    description: "Enter visual line mode",
    availability: TIER_A,
  },
  enterCaretMode: {
    name: "enterCaretMode",
    group: "text",
    description: "Enter caret mode",
    availability: TIER_A,
  },
  enterInsertMode: {
    name: "enterInsertMode",
    group: "text",
    description: "Enter insert mode",
    availability: TIER_A,
  },
  focusInput: {
    name: "focusInput",
    group: "text",
    description: "Focus a text input",
    availability: TIER_A,
    repeatable: true,
  },

  // --- Clipboard ---------------------------------------------------------
  copyCurrentUrl: {
    name: "copyCurrentUrl",
    group: "clipboard",
    description: "Copy this page's URL",
    availability: TIER_B,
  },
  copyCurrentTitle: {
    name: "copyCurrentTitle",
    group: "clipboard",
    description: "Copy this page's title",
    availability: TIER_B,
  },
  openCopiedUrlInCurrentTab: {
    name: "openCopiedUrlInCurrentTab",
    group: "clipboard",
    description: "Open a pasted URL",
    availability: TIER_B,
  },
  openCopiedUrlInNewTab: {
    name: "openCopiedUrlInNewTab",
    group: "clipboard",
    description: "Open a pasted URL in a new tab",
    availability: TIER_B,
  },

  // --- Tabs --------------------------------------------------------------
  createTab: {
    name: "createTab",
    group: "tabs",
    description: "Open a new tab",
    availability: TIER_B,
  },
  removeTab: {
    name: "removeTab",
    group: "tabs",
    description: "Close this tab",
    availability: TIER_B,
  },
  toggleMuteTab: {
    name: "toggleMuteTab",
    group: "tabs",
    description: "Mute or unmute media on this page",
    availability: TIER_B,
  },
  zoomIn: {
    name: "zoomIn",
    group: "tabs",
    description: "Zoom in (CSS zoom)",
    availability: TIER_B,
  },
  zoomOut: {
    name: "zoomOut",
    group: "tabs",
    description: "Zoom out (CSS zoom)",
    availability: TIER_B,
  },
  zoomReset: {
    name: "zoomReset",
    group: "tabs",
    description: "Reset zoom",
    availability: TIER_B,
  },
  toggleViewSource: {
    name: "toggleViewSource",
    group: "navigation",
    description: "View this page's source",
    availability: TIER_B,
  },
  restoreTab: {
    name: "restoreTab",
    group: "tabs",
    description: "Reopen the last closed tab",
    availability: CommandAvailability.Unavailable({
      reason: "there is no session API",
      nativeAlternative: Option.some("⌘⇧T"),
    }),
  },
  nextTab: {
    name: "nextTab",
    group: "tabs",
    description: "Go to the next tab",
    availability: CommandAvailability.Unavailable({
      reason: NO_TAB_API,
      nativeAlternative: Option.some("⌘⇧]"),
    }),
  },
  previousTab: {
    name: "previousTab",
    group: "tabs",
    description: "Go to the previous tab",
    availability: CommandAvailability.Unavailable({
      reason: NO_TAB_API,
      nativeAlternative: Option.some("⌘⇧["),
    }),
  },
  firstTab: {
    name: "firstTab",
    group: "tabs",
    description: "Go to the first tab",
    availability: CommandAvailability.Unavailable({
      reason: NO_TAB_API,
      nativeAlternative: Option.some("⌘1"),
    }),
  },
  lastTab: {
    name: "lastTab",
    group: "tabs",
    description: "Go to the last tab",
    availability: CommandAvailability.Unavailable({
      reason: NO_TAB_API,
      nativeAlternative: Option.some("⌘9"),
    }),
  },
  visitPreviousTab: {
    name: "visitPreviousTab",
    group: "tabs",
    description: "Go to the previously visited tab",
    availability: CommandAvailability.Unavailable({
      reason: NO_TAB_API,
      nativeAlternative: Option.none(),
    }),
  },
  moveTabLeft: {
    name: "moveTabLeft",
    group: "tabs",
    description: "Move this tab left",
    availability: CommandAvailability.Unavailable({
      reason: NO_TAB_API,
      nativeAlternative: Option.some("drag the tab"),
    }),
  },
  moveTabRight: {
    name: "moveTabRight",
    group: "tabs",
    description: "Move this tab right",
    availability: CommandAvailability.Unavailable({
      reason: NO_TAB_API,
      nativeAlternative: Option.some("drag the tab"),
    }),
  },
  moveTabToNewWindow: {
    name: "moveTabToNewWindow",
    group: "tabs",
    description: "Move this tab to a new window",
    availability: CommandAvailability.Unavailable({
      reason: NO_TAB_API,
      nativeAlternative: Option.some("drag the tab out"),
    }),
  },
  togglePinTab: {
    name: "togglePinTab",
    group: "tabs",
    description: "Pin or unpin this tab",
    availability: CommandAvailability.Unavailable({
      reason: NO_TAB_API,
      nativeAlternative: Option.some("right-click the tab"),
    }),
  },
  duplicateTab: {
    name: "duplicateTab",
    group: "tabs",
    description: "Duplicate this tab",
    availability: CommandAvailability.Unavailable({
      reason: NO_TAB_API,
      nativeAlternative: Option.some("right-click the tab"),
    }),
  },
  closeTabsOnLeft: {
    name: "closeTabsOnLeft",
    group: "tabs",
    description: "Close tabs to the left",
    availability: CommandAvailability.Unavailable({
      reason: NO_TAB_API,
      nativeAlternative: Option.some("right-click the tab"),
    }),
  },
  closeTabsOnRight: {
    name: "closeTabsOnRight",
    group: "tabs",
    description: "Close tabs to the right",
    availability: CommandAvailability.Unavailable({
      reason: NO_TAB_API,
      nativeAlternative: Option.some("right-click the tab"),
    }),
  },
  closeOtherTabs: {
    name: "closeOtherTabs",
    group: "tabs",
    description: "Close all other tabs",
    availability: CommandAvailability.Unavailable({
      reason: NO_TAB_API,
      nativeAlternative: Option.some("right-click the tab"),
    }),
  },

  // --- Marks -------------------------------------------------------------
  "Marks.activateCreateMode": {
    name: "Marks.activateCreateMode",
    group: "marks",
    description: "Set a mark",
    availability: TIER_A,
  },
  "Marks.activateGotoMode": {
    name: "Marks.activateGotoMode",
    group: "marks",
    description: "Jump to a mark",
    availability: TIER_A,
  },

  // --- Omnibar -----------------------------------------------------------
  "Vomnibar.activate": {
    name: "Vomnibar.activate",
    group: "navigation",
    description: "Open the omnibar",
    availability: TIER_B,
  },
  "Vomnibar.activateInNewTab": {
    name: "Vomnibar.activateInNewTab",
    group: "navigation",
    description: "Open the omnibar (new tab)",
    availability: TIER_B,
  },
  "Vomnibar.activateCommands": {
    name: "Vomnibar.activateCommands",
    group: "misc",
    description: "Open the command palette",
    availability: TIER_B,
  },
  "Vomnibar.activateSearch": {
    name: "Vomnibar.activateSearch",
    group: "navigation",
    description: "Search with a custom engine",
    availability: TIER_B,
  },
  "Vomnibar.activateBookmarks": {
    name: "Vomnibar.activateBookmarks",
    group: "navigation",
    description: "Search bookmarks",
    availability: CommandAvailability.Unavailable({
      reason: "there is no bookmarks API for a userscript",
      nativeAlternative: Option.some("⌥⌘B"),
    }),
  },
  "clear-history": {
    name: "clear-history",
    group: "misc",
    description: "Erase the local history index",
    availability: TIER_B,
    topFrameOnly: true,
  },

  // --- Frames ------------------------------------------------------------
  nextFrame: {
    name: "nextFrame",
    group: "navigation",
    description: "Focus the next frame",
    availability: TIER_B,
  },
  mainFrame: {
    name: "mainFrame",
    group: "navigation",
    description: "Focus the main frame",
    availability: TIER_B,
  },

  // --- Misc --------------------------------------------------------------
  showHelp: {
    name: "showHelp",
    group: "misc",
    description: "Show the help dialog",
    availability: TIER_A,
  },
  showSettings: {
    name: "showSettings",
    group: "misc",
    description: "Open settings",
    availability: TIER_A,
  },
  passNextKey: {
    name: "passNextKey",
    group: "misc",
    description: "Pass the next key to the page",
    availability: TIER_A,
    repeatable: true,
    advanced: true,
  },
} as const satisfies Record<string, CommandSpec>;

export type CommandName = keyof typeof COMMANDS;

/**
 * The default `map` lines, compiled before the user's own.
 *
 * These are the default bindings of Vimium. A tier C command keeps its binding.
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
