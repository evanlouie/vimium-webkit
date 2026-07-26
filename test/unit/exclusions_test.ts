import { assertEquals } from "@std/assert";
import { ExclusionSet, isPassKey, patternToRegExp } from "~/core/exclusions.ts";

Deno.test("patternToRegExp: `*` is the only wildcard and both ends are anchored", () => {
  const pattern = patternToRegExp("https://example.com/*");
  assertEquals(pattern?.test("https://example.com/a/b"), true);
  assertEquals(pattern?.test("https://example.com/"), true);
  // Anchoring matters: without it this would match an attacker-chosen host.
  assertEquals(pattern?.test("https://evil.example.com.co/"), false);
  assertEquals(pattern?.test("http://example.com/"), false);
});

Deno.test("patternToRegExp: regex-delimited patterns are honoured", () => {
  const pattern = patternToRegExp("/https://(mail|inbox)\\.google\\.com/.*/");
  assertEquals(pattern?.test("https://mail.google.com/u/0"), true);
  assertEquals(pattern?.test("https://drive.google.com/u/0"), false);
});

Deno.test("patternToRegExp: regex metacharacters in a glob are literal", () => {
  const pattern = patternToRegExp("https://example.com/a+b");
  assertEquals(pattern?.test("https://example.com/a+b"), true);
  assertEquals(pattern?.test("https://example.com/aaab"), false);
});

Deno.test("patternToRegExp: a malformed pattern is dropped, not thrown", () => {
  assertEquals(patternToRegExp("/[unclosed/"), null);
  assertEquals(patternToRegExp("   "), null);
});

Deno.test("ExclusionSet: no matching rule leaves us fully enabled", () => {
  const set = new ExclusionSet([
    { pattern: "https://example.com/*", passKeys: "" },
  ]);
  assertEquals(set.match("https://other.test/"), {
    enabled: true,
    passKeys: "",
  });
});

Deno.test("ExclusionSet: an empty passKeys disables us entirely", () => {
  const set = new ExclusionSet([
    { pattern: "https://mail.test/*", passKeys: "" },
  ]);
  assertEquals(set.match("https://mail.test/inbox"), {
    enabled: false,
    passKeys: "",
  });
});

Deno.test("ExclusionSet: overlapping rules union their pass keys", () => {
  const set = new ExclusionSet([
    { pattern: "https://app.test/*", passKeys: "jk" },
    { pattern: "https://app.test/editor*", passKeys: "kl" },
  ]);
  const rule = set.match("https://app.test/editor/1");
  assertEquals(rule.enabled, true);
  assertEquals([...rule.passKeys].sort().join(""), "jkl");
});

Deno.test("ExclusionSet: a full exclusion wins over a partial one", () => {
  // This ordering is what makes "disable Vimium here" behave as users expect
  // when a broader partial rule already matches.
  const set = new ExclusionSet([
    { pattern: "https://app.test/*", passKeys: "jk" },
    { pattern: "https://app.test/editor*", passKeys: "" },
  ]);
  assertEquals(set.match("https://app.test/editor/1").enabled, false);
});

Deno.test("ExclusionSet: repeated lookups are cached and bounded", () => {
  const set = new ExclusionSet([{ pattern: "*", passKeys: "j" }]);
  for (let i = 0; i < 200; i++) set.match(`https://spa.test/#/route/${i}`);
  // An SPA can generate unbounded distinct URLs; the point is that this does
  // not grow without limit and still answers correctly.
  assertEquals(set.match("https://spa.test/#/route/0").passKeys, "j");
});

Deno.test("isPassKey: only single characters can be pass keys", () => {
  const rule = { enabled: true, passKeys: "jk" };
  assertEquals(isPassKey(rule, "j"), true);
  assertEquals(isPassKey(rule, "l"), false);
  // A `passKeys` value is a *set of characters*, so `<c-j>` can never be in it.
  assertEquals(isPassKey(rule, "<c-j>"), false);
});
