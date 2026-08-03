/**
 * The command catalogue.
 *
 * The catalogue is pure data, and the help dialog and the mapping compiler
 * read it. A wrong entry there is silent, so these invariants are checked
 * against the data itself.
 */

import { assert, describe, it } from "@effect/vitest";
import { Effect, Option } from "effect";
import {
  type CommandDef,
  type CommandGroup,
  type CommandName,
  COMMANDS,
  DEFAULT_MAPPINGS,
} from "~/domain/Command.ts";
import { type KeyEventLike, keyNotation } from "~/domain/Key.ts";
import { compileMappings } from "~/domain/Mapping.ts";

const entries: readonly (readonly [string, CommandDef])[] = Object.entries(
  COMMANDS,
);

const names: ReadonlySet<string> = new Set(Object.keys(COMMANDS));

const GROUPS: ReadonlySet<CommandGroup> = new Set<CommandGroup>([
  "navigation",
  "scrolling",
  "hints",
  "find",
  "text",
  "tabs",
  "clipboard",
  "marks",
  "misc",
]);

describe("Command", () => {
  it.effect("holds a catalogue that is not empty", () =>
    Effect.sync(() => {
      assert.isAbove(entries.length, 40);
    }));

  it.effect("gives every command a valid tier", () =>
    Effect.sync(() => {
      for (const [key, definition] of entries) {
        assert.include(
          ["A", "B", "C"],
          definition.tier,
          `${key} has no valid tier`,
        );
      }
    }));

  it.effect("gives every tier C command a reason", () =>
    Effect.sync(() => {
      // A press of `J` must explain why tab control is impossible. Silence is
      // the worst answer.
      for (const [key, definition] of entries) {
        if (definition.tier !== "C") continue;
        assert.isString(
          definition.unavailableReason,
          `the tier C command ${key} needs an unavailableReason`,
        );
        assert.isAbove(
          (definition.unavailableReason ?? "").length,
          0,
          `the reason of ${key} is empty`,
        );
      }
    }));

  it.effect("keys every entry by its own name", () =>
    Effect.sync(() => {
      for (const [key, definition] of entries) {
        assert.strictEqual(
          definition.name,
          key,
          `the entry for ${key} carries the name ${definition.name}`,
        );
      }
    }));

  it.effect("gives every command a known group and a description", () =>
    Effect.sync(() => {
      for (const [key, definition] of entries) {
        assert.isTrue(
          GROUPS.has(definition.group),
          `${key} has the unknown group ${definition.group}`,
        );
        assert.isAbove(definition.description.length, 0, `${key} has no text`);
      }
    }));

  it.effect("names only commands that exist in DEFAULT_MAPPINGS", () =>
    Effect.sync(() => {
      const compiled = compileMappings(DEFAULT_MAPPINGS, {
        knownCommands: names,
        rejectReservedShortcuts: true,
      });
      assert.deepEqual(
        compiled.diagnostics.filter((entry) => entry.severity === "error"),
        [],
      );
      for (const binding of compiled.bindings) {
        assert.isTrue(
          names.has(binding.command),
          `${binding.command} is bound but is not in the catalogue`,
        );
      }
    }));

  it.effect("binds a large part of the catalogue by default", () =>
    Effect.sync(() => {
      const compiled = compileMappings(DEFAULT_MAPPINGS, {
        knownCommands: names,
        rejectReservedShortcuts: true,
      });
      const bound = new Set(
        compiled.bindings.map((binding) => binding.command),
      );
      assert.isAbove(bound.size, 40);
    }));

  it.effect("types the name of each entry as a command name", () =>
    Effect.sync(() => {
      // The type and the data must agree. `scrollDown` is in both.
      const name: CommandName = "scrollDown";
      assert.strictEqual(COMMANDS[name].name, name);
    }));

  /**
   * The shipped Option bindings, as macOS reports them.
   *
   * macOS applies Option to the character, so the physical key must decide.
   * Each row gives the glyph of a US layout and the command that must run.
   */
  const OPTION_BINDINGS: readonly {
    readonly name: string;
    readonly key: string;
    readonly code: string;
    readonly command: string;
  }[] = [
    {
      name: "Option+F opens a hint in a new foreground tab",
      key: "\u0192",
      code: "KeyF",
      command: "LinkHints.activateModeToOpenInNewForegroundTab",
    },
    {
      name: "Option+H hovers a hint",
      key: "\u02d9",
      code: "KeyH",
      command: "LinkHints.activateModeToHover",
    },
    {
      name: "Option+O opens the omnibar on a hint",
      key: "\u00f8",
      code: "KeyO",
      command: "LinkHints.activateModeWithOmnibar",
    },
    {
      name: "Option+M mutes the tab",
      key: "\u00b5",
      code: "KeyM",
      command: "toggleMuteTab",
    },
    {
      name: "Option+P pins the tab",
      key: "\u03c0",
      code: "KeyP",
      command: "togglePinTab",
    },
  ];

  for (const row of OPTION_BINDINGS) {
    it.effect(`runs a default Option binding: ${row.name}`, () =>
      Effect.sync(() => {
        const event: KeyEventLike = {
          key: row.key,
          code: row.code,
          altKey: true,
          ctrlKey: false,
          metaKey: false,
          shiftKey: false,
        };
        const notation = Option.getOrNull(keyNotation(event));
        const compiled = compileMappings(DEFAULT_MAPPINGS, {
          knownCommands: names,
          rejectReservedShortcuts: true,
        });
        const binding = compiled.bindings.find(
          (entry) => entry.keys.length === 1 && entry.keys[0] === notation,
        );
        assert.strictEqual(
          binding?.command,
          row.command,
          `${notation} runs no default binding`,
        );
      }));
  }
});
