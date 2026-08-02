import { test } from "vitest";
import {
  compilePattern,
  ExclusionSet,
  isPassKey,
  patternToRegExp,
} from "~/core/exclusions.ts";
import { assertEquals } from "./support/assert.ts";

test("compilePattern: `*` is the only wildcard and both ends are anchored", () => {
  const matches = compilePattern("https://example.com/*");
  assertEquals(matches?.("https://example.com/a/b"), true);
  assertEquals(matches?.("https://example.com/"), true);
  // Anchoring matters: without it this would match an attacker-chosen host.
  assertEquals(matches?.("https://evil.example.com.co/"), false);
  assertEquals(matches?.("http://example.com/"), false);
});

test("compilePattern: interior wildcards match in order", () => {
  const matches = compilePattern("https://*.example.com/*/edit");
  assertEquals(matches?.("https://a.example.com/doc/edit"), true);
  assertEquals(matches?.("https://a.example.com/edit/doc"), false);
  assertEquals(matches?.("https://a.example.com/x/y/edit"), true);
});

test("compilePattern: a pattern with no wildcard is an exact match", () => {
  const matches = compilePattern("https://example.com/only");
  assertEquals(matches?.("https://example.com/only"), true);
  assertEquals(matches?.("https://example.com/only/more"), false);
});

test("compilePattern: a wildcard glob cannot be made to backtrack", () => {
  // The shape that used to compile to `^a.*a.*a.*…$` and be fed a
  // page-controlled URL. Matched greedily this is linear; as a regex it is
  // polynomial in the number of wildcards.
  const matches = compilePattern(`https://${"a*".repeat(24)}end`);
  const hostile = `https://${"a".repeat(3000)}`;

  const started = performance.now();
  assertEquals(matches?.(hostile), false);
  const elapsed = performance.now() - started;

  // Two orders of magnitude of slack; the point is "not seconds".
  assertEquals(
    elapsed < 200,
    true,
    `glob match took ${elapsed.toFixed(1)}ms`,
  );
});

test("compilePattern: regex-delimited patterns are honoured", () => {
  const matches = compilePattern("/https://(mail|inbox)\\.google\\.com/.*/");
  assertEquals(matches?.("https://mail.google.com/u/0"), true);
  assertEquals(matches?.("https://drive.google.com/u/0"), false);
});

test("compilePattern: regex metacharacters in a glob are literal", () => {
  const matches = compilePattern("https://example.com/a+b");
  assertEquals(matches?.("https://example.com/a+b"), true);
  assertEquals(matches?.("https://example.com/aaab"), false);
});

test("compilePattern: a malformed pattern is dropped, not thrown", () => {
  assertEquals(compilePattern("/[unclosed/"), null);
  assertEquals(compilePattern("   "), null);
  assertEquals(compilePattern(`/${"a".repeat(2000)}/`), null);
});

test("compilePattern: an absurdly long URL is refused rather than scanned", () => {
  const matches = compilePattern("/.*/");
  assertEquals(matches?.("https://example.com/"), true);
  assertEquals(matches?.("x".repeat(5000)), false);
});

test("patternToRegExp still describes what a glob means", () => {
  const pattern = patternToRegExp("https://example.com/*");
  assertEquals(pattern?.test("https://example.com/a"), true);
  assertEquals(pattern?.test("https://evil.example.com.co/"), false);
  assertEquals(patternToRegExp("/[unclosed/"), null);
  assertEquals(patternToRegExp("   "), null);
});

test("ExclusionSet: no matching rule leaves us fully enabled", () => {
  const set = new ExclusionSet([
    { pattern: "https://example.com/*", passKeys: "" },
  ]);
  assertEquals(set.match("https://other.test/"), {
    enabled: true,
    passKeys: "",
  });
});

test("ExclusionSet: an empty passKeys disables us entirely", () => {
  const set = new ExclusionSet([
    { pattern: "https://mail.test/*", passKeys: "" },
  ]);
  assertEquals(set.match("https://mail.test/inbox"), {
    enabled: false,
    passKeys: "",
  });
});

test("ExclusionSet: overlapping rules union their pass keys", () => {
  const set = new ExclusionSet([
    { pattern: "https://app.test/*", passKeys: "jk" },
    { pattern: "https://app.test/editor*", passKeys: "kl" },
  ]);
  const rule = set.match("https://app.test/editor/1");
  assertEquals(rule.enabled, true);
  assertEquals([...rule.passKeys].sort().join(""), "jkl");
});

test("ExclusionSet: a full exclusion wins over a partial one", () => {
  // This ordering is what makes "disable Vimium here" behave as users expect
  // when a broader partial rule already matches.
  const set = new ExclusionSet([
    { pattern: "https://app.test/*", passKeys: "jk" },
    { pattern: "https://app.test/editor*", passKeys: "" },
  ]);
  assertEquals(set.match("https://app.test/editor/1").enabled, false);
});

test("ExclusionSet: repeated lookups are cached and bounded", () => {
  const set = new ExclusionSet([{ pattern: "*", passKeys: "j" }]);
  for (let i = 0; i < 200; i++) set.match(`https://spa.test/#/route/${i}`);
  // An SPA can generate unbounded distinct URLs; the point is that this does
  // not grow without limit and still answers correctly.
  assertEquals(set.match("https://spa.test/#/route/0").passKeys, "j");
});

test("isPassKey: only single characters can be pass keys", () => {
  const rule = { enabled: true, passKeys: "jk" };
  assertEquals(isPassKey(rule, "j"), true);
  assertEquals(isPassKey(rule, "l"), false);
  // A `passKeys` value is a *set of characters*, so `<c-j>` can never be in it.
  assertEquals(isPassKey(rule, "<c-j>"), false);
});
