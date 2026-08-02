/**
 * Search-engine config parsing.
 *
 * The behaviours worth pinning down: a malformed line must cost the user that
 * line and nothing else, an engine without `%s` is a trap rather than a
 * convenience, and the URL-versus-search decision has to agree with what every
 * other address bar does or the omnibar becomes unpredictable.
 */

import { test } from "vitest";
import {
  buildSearchUrl,
  classifyQuery,
  enginesMatchingPrefix,
  isSafeTemplate,
  parseSearchEngines,
  resolveQuery,
  splitKeyword,
  toNavigableUrl,
} from "~/features/omnibar/engines.ts";
import { assertEquals } from "./support/assert.ts";

const DEFAULT_SEARCH = "https://www.google.com/search?q=%s";

test("parseSearchEngines reads keyword, url and description", () => {
  const parsed = parseSearchEngines(
    "w: https://en.wikipedia.org/w/index.php?search=%s Wikipedia",
  );
  assertEquals(parsed.diagnostics, []);
  assertEquals(parsed.engines, [{
    keyword: "w",
    url: "https://en.wikipedia.org/w/index.php?search=%s",
    description: "Wikipedia",
  }]);
});

test("parseSearchEngines falls back to the keyword as the description", () => {
  const parsed = parseSearchEngines("g: https://example.com/?q=%s");
  assertEquals(parsed.engines[0]?.description, "g");
});

test("parseSearchEngines skips blanks and comments", () => {
  const parsed = parseSearchEngines(
    [
      "# a comment",
      "",
      "   ",
      "  # indented comment",
      "g: https://x.test/?q=%s",
    ]
      .join("\n"),
  );
  assertEquals(parsed.engines.length, 1);
  assertEquals(parsed.diagnostics, []);
});

test("parseSearchEngines tolerates CRLF line endings", () => {
  const parsed = parseSearchEngines(
    "a: https://a.test/?q=%s A\r\nb: https://b.test/?q=%s B\r\n",
  );
  assertEquals(parsed.engines.map((engine) => engine.keyword), ["a", "b"]);
  assertEquals(parsed.diagnostics, []);
});

test("parseSearchEngines reports a malformed line without losing the others", () => {
  const parsed = parseSearchEngines(
    [
      "a: https://a.test/?q=%s A",
      "this line is nonsense",
      "b: https://b.test/?q=%s B",
    ]
      .join("\n"),
  );
  assertEquals(parsed.engines.map((engine) => engine.keyword), ["a", "b"]);
  assertEquals(parsed.diagnostics.length, 1);
  assertEquals(parsed.diagnostics[0]?.line, 2);
  assertEquals(parsed.diagnostics[0]?.text, "this line is nonsense");
});

test("parseSearchEngines rejects a URL without %s", () => {
  const parsed = parseSearchEngines("x: https://example.com/ Example");
  assertEquals(parsed.engines, []);
  assertEquals(parsed.diagnostics.length, 1);
  assertEquals(parsed.diagnostics[0]?.line, 1);
});

test("parseSearchEngines lets a later duplicate win, with a diagnostic", () => {
  const parsed = parseSearchEngines(
    ["g: https://first.test/?q=%s First", "g: https://second.test/?q=%s Second"]
      .join("\n"),
  );
  assertEquals(parsed.engines.length, 1);
  assertEquals(parsed.engines[0]?.description, "Second");
  assertEquals(parsed.diagnostics.length, 1);
  assertEquals(parsed.diagnostics[0]?.line, 2);
});

test("parseSearchEngines keeps the original position of a redefined engine", () => {
  const parsed = parseSearchEngines(
    [
      "a: https://a.test/?q=%s A",
      "b: https://b.test/?q=%s B",
      "a: https://a2.test/?q=%s A2",
    ].join("\n"),
  );
  assertEquals(parsed.engines.map((engine) => engine.keyword), ["a", "b"]);
  assertEquals(parsed.engines[0]?.description, "A2");
});

test("parseSearchEngines accepts a colon with surrounding space", () => {
  const parsed = parseSearchEngines(
    "gh : https://github.com/search?q=%s GitHub",
  );
  assertEquals(parsed.engines[0]?.keyword, "gh");
  assertEquals(parsed.engines[0]?.description, "GitHub");
});

test("parseSearchEngines returns nothing for empty input", () => {
  const parsed = parseSearchEngines("");
  assertEquals(parsed.engines, []);
  assertEquals(parsed.diagnostics, []);
});

test("buildSearchUrl percent-encodes and fills every placeholder", () => {
  assertEquals(
    buildSearchUrl("https://x.test/?a=%s&b=%s", "a b&c"),
    "https://x.test/?a=a%20b%26c&b=a%20b%26c",
  );
});

test("buildSearchUrl does not treat the query as a replacement pattern", () => {
  // `$&` in a naive `replaceAll` would expand to the matched text.
  assertEquals(
    buildSearchUrl("https://x.test/?q=%s", "$& $1"),
    "https://x.test/?q=%24%26%20%241",
  );
});

const ENGINES = parseSearchEngines(
  ["w: https://wiki.test/?q=%s Wikipedia", "gh: https://gh.test/?q=%s GitHub"]
    .join("\n"),
).engines;

test("splitKeyword peels a keyword off the query", () => {
  const split = splitKeyword("w quantum mechanics", ENGINES);
  assertEquals(split?.engine.keyword, "w");
  assertEquals(split?.rest, "quantum mechanics");
});

test("splitKeyword matches a bare keyword with no trailing space", () => {
  const split = splitKeyword("gh", ENGINES);
  assertEquals(split?.engine.keyword, "gh");
  assertEquals(split?.rest, "");
});

test("splitKeyword is null for an unknown or partial keyword", () => {
  assertEquals(splitKeyword("g something", ENGINES), null);
  assertEquals(splitKeyword("", ENGINES), null);
  assertEquals(splitKeyword("   ", ENGINES), null);
});

test("enginesMatchingPrefix narrows on the keyword", () => {
  assertEquals(
    enginesMatchingPrefix(ENGINES, "g").map((engine) => engine.keyword),
    ["gh"],
  );
  assertEquals(enginesMatchingPrefix(ENGINES, "").length, 2);
  assertEquals(enginesMatchingPrefix(ENGINES, "zz"), []);
});

test("classifyQuery treats whitespace as a search", () => {
  assertEquals(classifyQuery("example.com foo"), "search");
  assertEquals(classifyQuery("how do i tie a tie"), "search");
  assertEquals(classifyQuery(""), "search");
});

test("classifyQuery recognises schemes, hosts, localhost and IPs", () => {
  assertEquals(classifyQuery("https://example.com/a?b=c"), "url");
  assertEquals(classifyQuery("about:blank"), "url");
  assertEquals(classifyQuery("view-source:https://x.test/"), "url");
  assertEquals(classifyQuery("example.com"), "url");
  assertEquals(classifyQuery("sub.example.co.uk/path"), "url");
  assertEquals(classifyQuery("localhost:8080/admin"), "url");
  assertEquals(classifyQuery("127.0.0.1:3000"), "url");
});

test("classifyQuery does not mistake a bare word or a version for a URL", () => {
  assertEquals(classifyQuery("wikipedia"), "search");
  assertEquals(classifyQuery("1.2.3"), "search");
  assertEquals(classifyQuery("file.txt"), "search");
});

test("classifyQuery never searches for something carrying credentials", () => {
  // The direction that matters: a URL with embedded userinfo used to fall
  // through to "search", which transmits the password to the search engine.
  // There is no undoing that.
  assertEquals(classifyQuery("user:pass@example.com"), "url");
  assertEquals(classifyQuery("user:pass@example.com/path"), "url");
  assertEquals(classifyQuery("admin@10.0.0.5:8443"), "url");
  // An `@` *after* the first slash is part of a path, not userinfo.
  assertEquals(classifyQuery("why/does@this"), "search");
});

test("classifyQuery recognises IPv6 literals rather than searching for them", () => {
  assertEquals(classifyQuery("[::1]"), "url");
  assertEquals(classifyQuery("[::1]:8080"), "url");
  assertEquals(classifyQuery("[fe80::1]/status"), "url");
});

test("classifyQuery range-checks IPv4 octets", () => {
  assertEquals(classifyQuery("192.168.1.1"), "url");
  assertEquals(classifyQuery("999.999.999.999"), "search");
});

test("classifyQuery accepts a trailing-dot FQDN", () => {
  assertEquals(classifyQuery("example.com."), "url");
});

test("parseSearchEngines refuses a template that is not http(s)", () => {
  // `javascript:alert(%s)` parses perfectly well as an engine line, and every
  // search through that keyword would then be an eval in the current origin.
  // Rejecting it here means the user is told on the line they can fix.
  const parsed = parseSearchEngines(
    [
      "bad: javascript:alert(%s) Evil",
      "rel: /search?q=%s Relative",
      "data: data:text/html,%s Data",
      "ok: https://example.com/?q=%s Fine",
    ].join("\n"),
  );

  assertEquals(parsed.engines.map((engine) => engine.keyword), ["ok"]);
  assertEquals(parsed.diagnostics.length, 3);
  for (const diagnostic of parsed.diagnostics) {
    assertEquals(diagnostic.message, "the URL must be http:// or https://");
  }
});

test("isSafeTemplate accepts only http and https", () => {
  assertEquals(isSafeTemplate("https://example.com/?q=%s"), true);
  assertEquals(isSafeTemplate("http://example.com/?q=%s"), true);
  assertEquals(isSafeTemplate("HTTPS://example.com/?q=%s"), true);
  assertEquals(isSafeTemplate("javascript:alert(%s)"), false);
  assertEquals(isSafeTemplate("/search?q=%s"), false);
  assertEquals(isSafeTemplate("example.com/?q=%s"), false);
});

test("toNavigableUrl adds https and never guesses http", () => {
  assertEquals(toNavigableUrl("example.com"), "https://example.com");
  assertEquals(toNavigableUrl("http://example.com"), "http://example.com");
  assertEquals(toNavigableUrl("about:blank"), "about:blank");
});

test("resolveQuery prefers a keyword engine over the default", () => {
  assertEquals(resolveQuery("w bohr", ENGINES, DEFAULT_SEARCH), {
    url: "https://wiki.test/?q=bohr",
    kind: "search",
  });
});

test("resolveQuery navigates to a URL and searches for anything else", () => {
  assertEquals(resolveQuery("example.com", ENGINES, DEFAULT_SEARCH), {
    url: "https://example.com",
    kind: "url",
  });
  assertEquals(resolveQuery("hello there", ENGINES, DEFAULT_SEARCH), {
    url: "https://www.google.com/search?q=hello%20there",
    kind: "search",
  });
});

test("resolveQuery treats a bare keyword as a search for that keyword", () => {
  // `w` alone has no query to hand the engine, so it must not silently open
  // Wikipedia's search page for the empty string.
  assertEquals(resolveQuery("w", ENGINES, DEFAULT_SEARCH), {
    url: "https://www.google.com/search?q=w",
    kind: "search",
  });
});
