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

export type CommandTier = "A" | "B" | "C";

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
  readonly tier: CommandTier;
  readonly group: CommandGroup;
  /** Honours the count prefix. */
  readonly repeatable?: boolean;
  /** Runs in the top frame only. A child frame forwards it. */
  readonly topFrameOnly?: boolean;
  /** Hidden from the default help dialog. */
  readonly advanced?: boolean;
  /** Required for tier C: why it cannot work. */
  readonly unavailableReason?: string;
  /** Shown beside a tier C refusal, for example "⌘⇧T". */
  readonly nativeAlternative?: string;
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
  readonly tier: CommandTier;
  readonly group: CommandGroup;
  readonly repeatable?: boolean;
  readonly topFrameOnly?: boolean;
  readonly advanced?: boolean;
  readonly unavailableReason?: string;
  readonly nativeAlternative?: string;
}

/** The reason that every tab command is tier C. */
const NO_TAB_API = "a userscript has no tab-management API";

/** Every command, keyed by name. */
export const COMMANDS = {
  // --- Scrolling ---------------------------------------------------------
  scrollDown: {
    name: "scrollDown",
    group: "scrolling",
    description: "Scroll down",
    tier: "A",
    repeatable: true,
  },
  scrollUp: {
    name: "scrollUp",
    group: "scrolling",
    description: "Scroll up",
    tier: "A",
    repeatable: true,
  },
  scrollLeft: {
    name: "scrollLeft",
    group: "scrolling",
    description: "Scroll left",
    tier: "A",
    repeatable: true,
  },
  scrollRight: {
    name: "scrollRight",
    group: "scrolling",
    description: "Scroll right",
    tier: "A",
    repeatable: true,
  },
  scrollPageDown: {
    name: "scrollPageDown",
    group: "scrolling",
    description: "Scroll a half page down",
    tier: "A",
    repeatable: true,
  },
  scrollPageUp: {
    name: "scrollPageUp",
    group: "scrolling",
    description: "Scroll a half page up",
    tier: "A",
    repeatable: true,
  },
  scrollFullPageDown: {
    name: "scrollFullPageDown",
    group: "scrolling",
    description: "Scroll a full page down",
    tier: "A",
    repeatable: true,
  },
  scrollFullPageUp: {
    name: "scrollFullPageUp",
    group: "scrolling",
    description: "Scroll a full page up",
    tier: "A",
    repeatable: true,
  },
  scrollToTop: {
    name: "scrollToTop",
    group: "scrolling",
    description: "Scroll to the top of the page",
    tier: "A",
  },
  scrollToBottom: {
    name: "scrollToBottom",
    group: "scrolling",
    description: "Scroll to the bottom of the page",
    tier: "A",
  },
  scrollToLeft: {
    name: "scrollToLeft",
    group: "scrolling",
    description: "Scroll all the way left",
    tier: "A",
  },
  scrollToRight: {
    name: "scrollToRight",
    group: "scrolling",
    description: "Scroll all the way right",
    tier: "A",
  },

  // --- Navigation --------------------------------------------------------
  reload: {
    name: "reload",
    group: "navigation",
    description: "Reload the page",
    tier: "A",
  },
  reloadHard: {
    name: "reloadHard",
    group: "navigation",
    description: "Reload, bypassing the cache",
    tier: "C",
    unavailableReason:
      "a userscript cannot ask the browser to bypass its cache",
    nativeAlternative: "⇧⌘R",
  },
  goBack: {
    name: "goBack",
    group: "navigation",
    description: "Go back in history",
    tier: "A",
    repeatable: true,
  },
  goForward: {
    name: "goForward",
    group: "navigation",
    description: "Go forward in history",
    tier: "A",
    repeatable: true,
  },
  goUp: {
    name: "goUp",
    group: "navigation",
    description: "Go up the URL hierarchy",
    tier: "A",
    repeatable: true,
  },
  goToRoot: {
    name: "goToRoot",
    group: "navigation",
    description: "Go to the site root",
    tier: "A",
  },
  goPrevious: {
    name: "goPrevious",
    group: "navigation",
    description: 'Follow the "previous" link',
    tier: "A",
  },
  goNext: {
    name: "goNext",
    group: "navigation",
    description: 'Follow the "next" link',
    tier: "A",
  },

  // --- Hints -------------------------------------------------------------
  "LinkHints.activateMode": {
    name: "LinkHints.activateMode",
    group: "hints",
    description: "Open a link",
    tier: "A",
  },
  "LinkHints.activateModeToOpenInNewTab": {
    name: "LinkHints.activateModeToOpenInNewTab",
    group: "hints",
    description: "Open a link in a new background tab",
    tier: "B",
  },
  "LinkHints.activateModeToOpenInNewForegroundTab": {
    name: "LinkHints.activateModeToOpenInNewForegroundTab",
    group: "hints",
    description: "Open a link in a new foreground tab",
    tier: "B",
  },
  "LinkHints.activateModeToHover": {
    name: "LinkHints.activateModeToHover",
    group: "hints",
    description: "Hover over an element",
    tier: "A",
  },
  "LinkHints.activateModeToFocus": {
    name: "LinkHints.activateModeToFocus",
    group: "hints",
    description: "Focus an element",
    tier: "A",
  },
  "LinkHints.activateModeToCopyLinkUrl": {
    name: "LinkHints.activateModeToCopyLinkUrl",
    group: "hints",
    description: "Copy a link's URL",
    tier: "B",
  },
  "LinkHints.activateModeToCopyLinkText": {
    name: "LinkHints.activateModeToCopyLinkText",
    group: "hints",
    description: "Copy a link's text",
    tier: "B",
  },
  "LinkHints.activateModeWithOmnibar": {
    name: "LinkHints.activateModeWithOmnibar",
    group: "hints",
    description: "Open a link with the omnibar",
    tier: "B",
  },
  "LinkHints.activateModeToDownloadLink": {
    name: "LinkHints.activateModeToDownloadLink",
    group: "hints",
    description: "Download a link",
    tier: "C",
    unavailableReason:
      "WebKit ignores synthetic modifier-clicks, so a script cannot reach the download path",
    nativeAlternative: "right-click → Download Linked File",
  },
  "LinkHints.activateModeToOpenIncognito": {
    name: "LinkHints.activateModeToOpenIncognito",
    group: "hints",
    description: "Open a link in a private window",
    tier: "C",
    unavailableReason: "there is no window-creation API for a userscript",
  },

  // --- Find --------------------------------------------------------------
  enterFindMode: {
    name: "enterFindMode",
    group: "find",
    description: "Search the page",
    tier: "A",
  },
  performFind: {
    name: "performFind",
    group: "find",
    description: "Go to the next match",
    tier: "A",
    repeatable: true,
  },
  performBackwardsFind: {
    name: "performBackwardsFind",
    group: "find",
    description: "Go to the previous match",
    tier: "A",
    repeatable: true,
  },
  searchWordForwards: {
    name: "searchWordForwards",
    group: "find",
    description: "Search for the word under the cursor",
    tier: "A",
  },
  searchWordBackwards: {
    name: "searchWordBackwards",
    group: "find",
    description: "Search backwards for the word under the cursor",
    tier: "A",
  },

  // --- Text --------------------------------------------------------------
  enterVisualMode: {
    name: "enterVisualMode",
    group: "text",
    description: "Enter visual mode",
    tier: "A",
  },
  enterVisualLineMode: {
    name: "enterVisualLineMode",
    group: "text",
    description: "Enter visual line mode",
    tier: "A",
  },
  enterCaretMode: {
    name: "enterCaretMode",
    group: "text",
    description: "Enter caret mode",
    tier: "A",
  },
  enterInsertMode: {
    name: "enterInsertMode",
    group: "text",
    description: "Enter insert mode",
    tier: "A",
  },
  focusInput: {
    name: "focusInput",
    group: "text",
    description: "Focus a text input",
    tier: "A",
    repeatable: true,
  },

  // --- Clipboard ---------------------------------------------------------
  copyCurrentUrl: {
    name: "copyCurrentUrl",
    group: "clipboard",
    description: "Copy this page's URL",
    tier: "B",
  },
  copyCurrentTitle: {
    name: "copyCurrentTitle",
    group: "clipboard",
    description: "Copy this page's title",
    tier: "B",
  },
  openCopiedUrlInCurrentTab: {
    name: "openCopiedUrlInCurrentTab",
    group: "clipboard",
    description: "Open a pasted URL",
    tier: "B",
  },
  openCopiedUrlInNewTab: {
    name: "openCopiedUrlInNewTab",
    group: "clipboard",
    description: "Open a pasted URL in a new tab",
    tier: "B",
  },

  // --- Tabs --------------------------------------------------------------
  createTab: {
    name: "createTab",
    group: "tabs",
    description: "Open a new tab",
    tier: "B",
  },
  removeTab: {
    name: "removeTab",
    group: "tabs",
    description: "Close this tab",
    tier: "B",
  },
  toggleMuteTab: {
    name: "toggleMuteTab",
    group: "tabs",
    description: "Mute or unmute media on this page",
    tier: "B",
  },
  zoomIn: {
    name: "zoomIn",
    group: "tabs",
    description: "Zoom in (CSS zoom)",
    tier: "B",
  },
  zoomOut: {
    name: "zoomOut",
    group: "tabs",
    description: "Zoom out (CSS zoom)",
    tier: "B",
  },
  zoomReset: {
    name: "zoomReset",
    group: "tabs",
    description: "Reset zoom",
    tier: "B",
  },
  toggleViewSource: {
    name: "toggleViewSource",
    group: "navigation",
    description: "View this page's source",
    tier: "B",
  },
  restoreTab: {
    name: "restoreTab",
    group: "tabs",
    description: "Reopen the last closed tab",
    tier: "C",
    unavailableReason: "there is no session API",
    nativeAlternative: "⌘⇧T",
  },
  nextTab: {
    name: "nextTab",
    group: "tabs",
    description: "Go to the next tab",
    tier: "C",
    unavailableReason: NO_TAB_API,
    nativeAlternative: "⌘⇧]",
  },
  previousTab: {
    name: "previousTab",
    group: "tabs",
    description: "Go to the previous tab",
    tier: "C",
    unavailableReason: NO_TAB_API,
    nativeAlternative: "⌘⇧[",
  },
  firstTab: {
    name: "firstTab",
    group: "tabs",
    description: "Go to the first tab",
    tier: "C",
    unavailableReason: NO_TAB_API,
    nativeAlternative: "⌘1",
  },
  lastTab: {
    name: "lastTab",
    group: "tabs",
    description: "Go to the last tab",
    tier: "C",
    unavailableReason: NO_TAB_API,
    nativeAlternative: "⌘9",
  },
  visitPreviousTab: {
    name: "visitPreviousTab",
    group: "tabs",
    description: "Go to the previously visited tab",
    tier: "C",
    unavailableReason: NO_TAB_API,
  },
  moveTabLeft: {
    name: "moveTabLeft",
    group: "tabs",
    description: "Move this tab left",
    tier: "C",
    unavailableReason: NO_TAB_API,
    nativeAlternative: "drag the tab",
  },
  moveTabRight: {
    name: "moveTabRight",
    group: "tabs",
    description: "Move this tab right",
    tier: "C",
    unavailableReason: NO_TAB_API,
    nativeAlternative: "drag the tab",
  },
  moveTabToNewWindow: {
    name: "moveTabToNewWindow",
    group: "tabs",
    description: "Move this tab to a new window",
    tier: "C",
    unavailableReason: NO_TAB_API,
    nativeAlternative: "drag the tab out",
  },
  togglePinTab: {
    name: "togglePinTab",
    group: "tabs",
    description: "Pin or unpin this tab",
    tier: "C",
    unavailableReason: NO_TAB_API,
    nativeAlternative: "right-click the tab",
  },
  duplicateTab: {
    name: "duplicateTab",
    group: "tabs",
    description: "Duplicate this tab",
    tier: "C",
    unavailableReason: NO_TAB_API,
    nativeAlternative: "right-click the tab",
  },
  closeTabsOnLeft: {
    name: "closeTabsOnLeft",
    group: "tabs",
    description: "Close tabs to the left",
    tier: "C",
    unavailableReason: NO_TAB_API,
    nativeAlternative: "right-click the tab",
  },
  closeTabsOnRight: {
    name: "closeTabsOnRight",
    group: "tabs",
    description: "Close tabs to the right",
    tier: "C",
    unavailableReason: NO_TAB_API,
    nativeAlternative: "right-click the tab",
  },
  closeOtherTabs: {
    name: "closeOtherTabs",
    group: "tabs",
    description: "Close all other tabs",
    tier: "C",
    unavailableReason: NO_TAB_API,
    nativeAlternative: "right-click the tab",
  },

  // --- Marks -------------------------------------------------------------
  "Marks.activateCreateMode": {
    name: "Marks.activateCreateMode",
    group: "marks",
    description: "Set a mark",
    tier: "A",
  },
  "Marks.activateGotoMode": {
    name: "Marks.activateGotoMode",
    group: "marks",
    description: "Jump to a mark",
    tier: "A",
  },

  // --- Omnibar -----------------------------------------------------------
  "Vomnibar.activate": {
    name: "Vomnibar.activate",
    group: "navigation",
    description: "Open the omnibar",
    tier: "B",
  },
  "Vomnibar.activateInNewTab": {
    name: "Vomnibar.activateInNewTab",
    group: "navigation",
    description: "Open the omnibar (new tab)",
    tier: "B",
  },
  "Vomnibar.activateCommands": {
    name: "Vomnibar.activateCommands",
    group: "misc",
    description: "Open the command palette",
    tier: "B",
  },
  "Vomnibar.activateSearch": {
    name: "Vomnibar.activateSearch",
    group: "navigation",
    description: "Search with a custom engine",
    tier: "B",
  },
  "Vomnibar.activateBookmarks": {
    name: "Vomnibar.activateBookmarks",
    group: "navigation",
    description: "Search bookmarks",
    tier: "C",
    unavailableReason: "there is no bookmarks API for a userscript",
    nativeAlternative: "⌥⌘B",
  },
  "clear-history": {
    name: "clear-history",
    group: "misc",
    description: "Erase the local history index",
    tier: "B",
    topFrameOnly: true,
  },

  // --- Frames ------------------------------------------------------------
  nextFrame: {
    name: "nextFrame",
    group: "navigation",
    description: "Focus the next frame",
    tier: "B",
  },
  mainFrame: {
    name: "mainFrame",
    group: "navigation",
    description: "Focus the main frame",
    tier: "B",
  },

  // --- Misc --------------------------------------------------------------
  showHelp: {
    name: "showHelp",
    group: "misc",
    description: "Show the help dialog",
    tier: "A",
  },
  showSettings: {
    name: "showSettings",
    group: "misc",
    description: "Open settings",
    tier: "A",
  },
  passNextKey: {
    name: "passNextKey",
    group: "misc",
    description: "Pass the next key to the page",
    tier: "A",
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
# reads the physical key for such a chord, so <a-f> stays the F key.
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
