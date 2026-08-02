/**
 * The search-engine configuration.
 *
 * A malformed line must cost the user that line and nothing else. An engine
 * with no `%s` is a trap and not a convenience. The URL-or-search decision must
 * agree with every other address bar, or the omnibar becomes unpredictable.
 */

import { assert, describe, it } from "@effect/vitest";
import { Effect, Option } from "effect";
import {
  buildSearchUrl,
  classifyQuery,
  enginesMatchingPrefix,
  isSafeTemplate,
  parseSearchEngines,
  resolveQuery,
  type SearchEngine,
  splitKeyword,
  toNavigableUrl,
} from "~/domain/SearchEngine.ts";

const DEFAULT_SEARCH = "https://www.google.com/search?q=%s";

const ENGINES: readonly SearchEngine[] = parseSearchEngines(
  ["w: https://wiki.test/?q=%s Wikipedia", "gh: https://gh.test/?q=%s GitHub"]
    .join("\n"),
).engines;

describe("SearchEngine", () => {
  it.effect("reads the keyword, the URL and the description", () =>
    Effect.sync(() => {
      const parsed = parseSearchEngines(
        "w: https://en.wikipedia.org/w/index.php?search=%s Wikipedia",
      );
      assert.deepEqual(parsed.diagnostics, []);
      assert.deepEqual(parsed.engines, [{
        keyword: "w",
        url: "https://en.wikipedia.org/w/index.php?search=%s",
        description: "Wikipedia",
      }]);
    }));

  it.effect("uses the keyword when the line gives no description", () =>
    Effect.sync(() => {
      const parsed = parseSearchEngines("g: https://example.com/?q=%s");
      assert.strictEqual(parsed.engines[0]?.description, "g");
    }));

  it.effect("skips an empty line and a comment", () =>
    Effect.sync(() => {
      const parsed = parseSearchEngines([
        "# a comment",
        "",
        "   ",
        "  # an indented comment",
        "g: https://x.test/?q=%s",
      ].join("\n"));
      assert.lengthOf(parsed.engines, 1);
      assert.deepEqual(parsed.diagnostics, []);
    }));

  it.effect("accepts the line endings of an editor on Windows", () =>
    Effect.sync(() => {
      const parsed = parseSearchEngines(
        "a: https://a.test/?q=%s A\r\nb: https://b.test/?q=%s B\r\n",
      );
      assert.deepEqual(parsed.engines.map((engine) => engine.keyword), [
        "a",
        "b",
      ]);
      assert.deepEqual(parsed.diagnostics, []);
    }));

  it.effect("reports a malformed line and keeps the other lines", () =>
    Effect.sync(() => {
      const parsed = parseSearchEngines([
        "a: https://a.test/?q=%s A",
        "this line is nonsense",
        "b: https://b.test/?q=%s B",
      ].join("\n"));
      assert.deepEqual(parsed.engines.map((engine) => engine.keyword), [
        "a",
        "b",
      ]);
      assert.lengthOf(parsed.diagnostics, 1);
      assert.strictEqual(parsed.diagnostics[0]?.line, 2);
      assert.strictEqual(parsed.diagnostics[0]?.text, "this line is nonsense");
    }));

  it.effect("refuses a URL with no %s", () =>
    Effect.sync(() => {
      const parsed = parseSearchEngines("x: https://example.com/ Example");
      assert.deepEqual(parsed.engines, []);
      assert.lengthOf(parsed.diagnostics, 1);
      assert.strictEqual(parsed.diagnostics[0]?.line, 1);
    }));

  it.effect("lets a later duplicate win, with a diagnostic", () =>
    Effect.sync(() => {
      const parsed = parseSearchEngines([
        "g: https://first.test/?q=%s First",
        "g: https://second.test/?q=%s Second",
      ].join("\n"));
      assert.lengthOf(parsed.engines, 1);
      assert.strictEqual(parsed.engines[0]?.description, "Second");
      assert.lengthOf(parsed.diagnostics, 1);
      assert.strictEqual(parsed.diagnostics[0]?.line, 2);
    }));

  it.effect("keeps the original position of an engine that is redefined", () =>
    Effect.sync(() => {
      const parsed = parseSearchEngines([
        "a: https://a.test/?q=%s A",
        "b: https://b.test/?q=%s B",
        "a: https://a2.test/?q=%s A2",
      ].join("\n"));
      assert.deepEqual(parsed.engines.map((engine) => engine.keyword), [
        "a",
        "b",
      ]);
      assert.strictEqual(parsed.engines[0]?.description, "A2");
    }));

  it.effect("accepts a colon with a space around it", () =>
    Effect.sync(() => {
      const parsed = parseSearchEngines(
        "gh : https://github.com/search?q=%s GitHub",
      );
      assert.strictEqual(parsed.engines[0]?.keyword, "gh");
      assert.strictEqual(parsed.engines[0]?.description, "GitHub");
    }));

  it.effect("gives nothing for empty input", () =>
    Effect.sync(() => {
      const parsed = parseSearchEngines("");
      assert.deepEqual(parsed.engines, []);
      assert.deepEqual(parsed.diagnostics, []);
    }));

  it.effect("encodes the query and fills every placeholder", () =>
    Effect.sync(() => {
      assert.strictEqual(
        buildSearchUrl("https://x.test/?a=%s&b=%s", "a b&c"),
        "https://x.test/?a=a%20b%26c&b=a%20b%26c",
      );
    }));

  it.effect("does not treat the query as a replacement pattern", () =>
    Effect.sync(() => {
      // A plain `replaceAll` expands `$&` to the matched text.
      assert.strictEqual(
        buildSearchUrl("https://x.test/?q=%s", "$& $1"),
        "https://x.test/?q=%24%26%20%241",
      );
    }));

  it.effect("takes a keyword off the front of the query", () =>
    Effect.sync(() => {
      const split = splitKeyword("w quantum mechanics", ENGINES);
      assert.isTrue(Option.isSome(split));
      if (Option.isNone(split)) return;
      assert.strictEqual(split.value.engine.keyword, "w");
      assert.strictEqual(split.value.rest, "quantum mechanics");
    }));

  it.effect("matches a bare keyword with no space after it", () =>
    Effect.sync(() => {
      const split = splitKeyword("gh", ENGINES);
      assert.isTrue(Option.isSome(split));
      if (Option.isNone(split)) return;
      assert.strictEqual(split.value.engine.keyword, "gh");
      assert.strictEqual(split.value.rest, "");
    }));

  it.effect("gives none for an unknown or partial keyword", () =>
    Effect.sync(() => {
      assert.isTrue(Option.isNone(splitKeyword("g something", ENGINES)));
      assert.isTrue(Option.isNone(splitKeyword("", ENGINES)));
      assert.isTrue(Option.isNone(splitKeyword("   ", ENGINES)));
    }));

  it.effect("narrows the completion list on the keyword", () =>
    Effect.sync(() => {
      assert.deepEqual(
        enginesMatchingPrefix(ENGINES, "g").map((engine) => engine.keyword),
        ["gh"],
      );
      assert.lengthOf(enginesMatchingPrefix(ENGINES, ""), 2);
      assert.deepEqual(enginesMatchingPrefix(ENGINES, "zz"), []);
    }));

  it.effect("treats whitespace as a search", () =>
    Effect.sync(() => {
      assert.strictEqual(classifyQuery("example.com foo"), "search");
      assert.strictEqual(classifyQuery("how do i tie a tie"), "search");
      assert.strictEqual(classifyQuery(""), "search");
    }));

  it.effect("recognises a scheme, a host, localhost and an address", () =>
    Effect.sync(() => {
      assert.strictEqual(classifyQuery("https://example.com/a?b=c"), "url");
      assert.strictEqual(classifyQuery("about:blank"), "url");
      assert.strictEqual(classifyQuery("view-source:https://x.test/"), "url");
      assert.strictEqual(classifyQuery("example.com"), "url");
      assert.strictEqual(classifyQuery("sub.example.co.uk/path"), "url");
      assert.strictEqual(classifyQuery("localhost:8080/admin"), "url");
      assert.strictEqual(classifyQuery("127.0.0.1:3000"), "url");
    }));

  it.effect("does not mistake a word or a version for a URL", () =>
    Effect.sync(() => {
      assert.strictEqual(classifyQuery("wikipedia"), "search");
      assert.strictEqual(classifyQuery("1.2.3"), "search");
      assert.strictEqual(classifyQuery("file.txt"), "search");
    }));

  it.effect("never searches for text that carries credentials", () =>
    Effect.sync(() => {
      // A URL with user information that falls through to a search sends the
      // password to the search engine. That result cannot be undone.
      assert.strictEqual(classifyQuery("user:pass@example.com"), "url");
      assert.strictEqual(classifyQuery("user:pass@example.com/path"), "url");
      assert.strictEqual(classifyQuery("admin@10.0.0.5:8443"), "url");
      // An `@` after the first slash is part of a path, and not user
      // information.
      assert.strictEqual(classifyQuery("why/does@this"), "search");
    }));

  it.effect("recognises an IPv6 literal", () =>
    Effect.sync(() => {
      assert.strictEqual(classifyQuery("[::1]"), "url");
      assert.strictEqual(classifyQuery("[::1]:8080"), "url");
      assert.strictEqual(classifyQuery("[fe80::1]/status"), "url");
    }));

  it.effect("checks the range of every IPv4 octet", () =>
    Effect.sync(() => {
      assert.strictEqual(classifyQuery("192.168.1.1"), "url");
      assert.strictEqual(classifyQuery("999.999.999.999"), "search");
    }));

  it.effect("accepts a fully qualified name with a trailing dot", () =>
    Effect.sync(() => {
      assert.strictEqual(classifyQuery("example.com."), "url");
    }));

  it.effect("refuses a template that is not http or https", () =>
    Effect.sync(() => {
      // `javascript:alert(%s)` parses as a correct engine line, and then every
      // search through that keyword runs text in the current origin. The user
      // is told on the line that they can correct.
      const parsed = parseSearchEngines([
        "bad: javascript:alert(%s) Evil",
        "rel: /search?q=%s Relative",
        "data: data:text/html,%s Data",
        "ok: https://example.com/?q=%s Fine",
      ].join("\n"));

      assert.deepEqual(parsed.engines.map((engine) => engine.keyword), ["ok"]);
      assert.lengthOf(parsed.diagnostics, 3);
      for (const diagnostic of parsed.diagnostics) {
        assert.strictEqual(
          diagnostic.message,
          "the URL must be http:// or https://",
        );
      }
    }));

  it.effect("accepts only http and https as a safe template", () =>
    Effect.sync(() => {
      assert.isTrue(isSafeTemplate("https://example.com/?q=%s"));
      assert.isTrue(isSafeTemplate("http://example.com/?q=%s"));
      assert.isTrue(isSafeTemplate("HTTPS://example.com/?q=%s"));
      assert.isFalse(isSafeTemplate("javascript:alert(%s)"));
      assert.isFalse(isSafeTemplate("/search?q=%s"));
      assert.isFalse(isSafeTemplate("example.com/?q=%s"));
    }));

  it.effect("adds https and never guesses http", () =>
    Effect.sync(() => {
      assert.strictEqual(toNavigableUrl("example.com"), "https://example.com");
      assert.strictEqual(
        toNavigableUrl("http://example.com"),
        "http://example.com",
      );
      assert.strictEqual(toNavigableUrl("about:blank"), "about:blank");
    }));

  it.effect("prefers a keyword engine over the default", () =>
    Effect.sync(() => {
      assert.deepEqual(resolveQuery("w bohr", ENGINES, DEFAULT_SEARCH), {
        url: "https://wiki.test/?q=bohr",
        kind: "search",
      });
    }));

  it.effect("navigates to a URL and searches for everything else", () =>
    Effect.sync(() => {
      assert.deepEqual(resolveQuery("example.com", ENGINES, DEFAULT_SEARCH), {
        url: "https://example.com",
        kind: "url",
      });
      assert.deepEqual(resolveQuery("hello there", ENGINES, DEFAULT_SEARCH), {
        url: "https://www.google.com/search?q=hello%20there",
        kind: "search",
      });
    }));

  it.effect("treats a bare keyword as a search for that keyword", () =>
    Effect.sync(() => {
      // `w` alone has no query for the engine, so it must not open the search
      // page of Wikipedia for the empty string.
      assert.deepEqual(resolveQuery("w", ENGINES, DEFAULT_SEARCH), {
        url: "https://www.google.com/search?q=w",
        kind: "search",
      });
    }));
});
