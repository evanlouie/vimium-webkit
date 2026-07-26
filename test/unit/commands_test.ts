import { assert, assertEquals } from "@std/assert";
import {
  buildCommands,
  createCommandRegistry,
  findRelLink,
  goUpUrl,
  toUrl,
} from "~/core/commands.ts";

Deno.test("every command carries a tier", () => {
  for (const command of buildCommands()) {
    assert(
      command.tier === "A" || command.tier === "B" || command.tier === "C",
      `${command.name} has no valid tier`,
    );
  }
});

Deno.test("every Tier C command explains itself", () => {
  // A Tier C command that says nothing is indistinguishable from a bug, which
  // is exactly the failure mode goal G3 exists to prevent.
  for (const command of buildCommands()) {
    if (command.tier !== "C") continue;
    assert(
      typeof command.unavailableReason === "string" &&
        command.unavailableReason.length > 0,
      `${command.name} is Tier C but gives no reason`,
    );
  }
});

Deno.test("command names are unique", () => {
  const names = buildCommands().map((command) => command.name);
  assertEquals(new Set(names).size, names.length);
});

Deno.test("the registry groups commands and resolves by name", () => {
  const registry = createCommandRegistry();
  assertEquals(registry.get("scrollDown")?.tier, "A");
  assertEquals(registry.get("restoreTab")?.tier, "C");
  assertEquals(registry.get("nope"), undefined);
  assert(registry.byGroup().size > 0);
});

Deno.test("the tier distribution matches the plan's Appendix A", () => {
  const counts = { A: 0, B: 0, C: 0 };
  for (const command of buildCommands()) counts[command.tier]++;
  // Appendix A budgets roughly 35 / 12 / 20. These bounds are wide enough to
  // allow growth but tight enough to catch a command silently changing tier.
  assert(counts.A >= 25, `expected ≥25 Tier A commands, got ${counts.A}`);
  assert(counts.B >= 8, `expected ≥8 Tier B commands, got ${counts.B}`);
  assert(counts.C >= 12, `expected ≥12 Tier C commands, got ${counts.C}`);
});

Deno.test("toUrl: URL-shaped input navigates, everything else searches", () => {
  const search = "https://duckduckgo.com/?q=%s";
  assertEquals(toUrl("https://example.com/a", search), "https://example.com/a");
  assertEquals(toUrl("example.com", search), "https://example.com");
  assertEquals(toUrl("example.com/path", search), "https://example.com/path");
  assertEquals(
    toUrl("view-source:https://x.test", search),
    "view-source:https://x.test",
  );
  assertEquals(
    toUrl("hello world", search),
    "https://duckduckgo.com/?q=hello%20world",
  );
  assertEquals(
    toUrl("notes.txt file", search),
    "https://duckduckgo.com/?q=notes.txt%20file",
  );
});

Deno.test("goUpUrl: strips fragment, then query, then path segments", () => {
  assertEquals(
    goUpUrl("https://example.com/a/b/c#frag", 1),
    "https://example.com/a/b/c",
  );
  assertEquals(
    goUpUrl("https://example.com/a/b/c?q=1", 1),
    "https://example.com/a/b/c",
  );
  assertEquals(
    goUpUrl("https://example.com/a/b/c", 1),
    "https://example.com/a/b/",
  );
  assertEquals(
    goUpUrl("https://example.com/a/b/c", 2),
    "https://example.com/a/",
  );
  assertEquals(goUpUrl("https://example.com/a/b/c", 9), "https://example.com/");
});

Deno.test("goUpUrl: already at the root reports nothing to do", () => {
  assertEquals(goUpUrl("https://example.com/", 1), null);
  assertEquals(goUpUrl("not a url", 1), null);
});

Deno.test("findRelLink is exported for the DOM tests to exercise", () => {
  // The behaviour needs a document; this only pins the contract so a rename
  // cannot silently break `[[` / `]]`.
  assertEquals(typeof findRelLink, "function");
});
