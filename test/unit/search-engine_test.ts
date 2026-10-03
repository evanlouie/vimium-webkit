/**
 * The search-engine configuration.
 *
 * A malformed line must cost the user that line and nothing else. An engine
 * with no `%s` is a trap and not a convenience. The URL-or-search decision must
 * agree with every other address bar, or the omnibar becomes unpredictable.
 */

import { assert, describe, it } from "@effect/vitest";
import { Array, Effect, Option, pipe } from "effect";
import {
  buildSearchUrl,
  classifyQuery,
  Destination,
  destinationOf,
  enginesMatchingPrefix,
  isSafeTemplate,
  parseSearchEngines,
  type SearchEngine,
  splitKeyword,
  toNavigableUrl,
} from "~/domain/SearchEngine.ts";

const DEFAULT_SEARCH = "https://www.google.com/search?q=%s";

const ENGINES: readonly SearchEngine[] = parseSearchEngines(
  ["w: https://wiki.test/?q=%s Wikipedia", "gh: https://gh.test/?q=%s GitHub"].join("\n"),
).engines;

const keywordOf = ({ keyword }: SearchEngine): string => keyword;

/** The first item, or a failed test. */
const first = <A>(items: readonly A[]) => pipe(items, Array.head, Effect.fromOption);

/** The engine keyword and the rest, which is what a split is checked for. */
const splitOf = (
  query: string,
): Option.Option<{ readonly keyword: string; readonly rest: string }> =>
  pipe(
    splitKeyword(query, ENGINES),
    Option.map(({ engine, rest }) => ({ keyword: engine.keyword, rest })),
  );

/** The URL that Enter opens for a query that is an address, and not a search. */
const addressOf = (query: string): Option.Option<string> =>
  pipe(
    destinationOf(query, ENGINES, DEFAULT_SEARCH),
    Option.liftPredicate(Destination.$is("Address")),
    Option.map(({ url }) => url),
  );

describe("SearchEngine", () => {
  it.effect("reads the keyword, the URL and the description", () =>
    Effect.sync(() => {
      const parsed = parseSearchEngines(
        "w: https://en.wikipedia.org/w/index.php?search=%s Wikipedia",
      );
      assert.deepEqual(parsed.diagnostics, []);
      assert.deepEqual(parsed.engines, [
        {
          keyword: "w",
          url: "https://en.wikipedia.org/w/index.php?search=%s",
          description: "Wikipedia",
        },
      ]);
    }),
  );

  it.effect("uses the keyword when the line gives no description", () =>
    Effect.gen(function* () {
      const parsed = parseSearchEngines("g: https://example.com/?q=%s");
      const engine = yield* first(parsed.engines);
      assert.strictEqual(engine.description, "g");
    }),
  );

  it.effect("skips an empty line and a comment", () =>
    Effect.sync(() => {
      const parsed = parseSearchEngines(
        ["# a comment", "", "   ", "  # an indented comment", "g: https://x.test/?q=%s"].join("\n"),
      );
      assert.lengthOf(parsed.engines, 1);
      assert.deepEqual(parsed.diagnostics, []);
    }),
  );

  it.effect("accepts the line endings of an editor on Windows", () =>
    Effect.sync(() => {
      const parsed = parseSearchEngines(
        "a: https://a.test/?q=%s A\r\nb: https://b.test/?q=%s B\r\n",
      );
      const keywords = pipe(parsed.engines, Array.map(keywordOf));
      assert.deepEqual(keywords, ["a", "b"]);
      assert.deepEqual(parsed.diagnostics, []);
    }),
  );

  it.effect("reports a malformed line and keeps the other lines", () =>
    Effect.gen(function* () {
      const parsed = parseSearchEngines(
        ["a: https://a.test/?q=%s A", "this line is nonsense", "b: https://b.test/?q=%s B"].join(
          "\n",
        ),
      );
      const keywords = pipe(parsed.engines, Array.map(keywordOf));
      assert.deepEqual(keywords, ["a", "b"]);
      assert.lengthOf(parsed.diagnostics, 1);
      const diagnostic = yield* first(parsed.diagnostics);
      assert.strictEqual(diagnostic.line, 2);
      assert.strictEqual(diagnostic.text, "this line is nonsense");
    }),
  );

  it.effect("refuses a URL with no %s", () =>
    Effect.gen(function* () {
      const parsed = parseSearchEngines("x: https://example.com/ Example");
      assert.deepEqual(parsed.engines, []);
      assert.lengthOf(parsed.diagnostics, 1);
      const diagnostic = yield* first(parsed.diagnostics);
      assert.strictEqual(diagnostic.line, 1);
    }),
  );

  it.effect("lets a later duplicate win, with a diagnostic", () =>
    Effect.gen(function* () {
      const parsed = parseSearchEngines(
        ["g: https://first.test/?q=%s First", "g: https://second.test/?q=%s Second"].join("\n"),
      );
      assert.lengthOf(parsed.engines, 1);
      const engine = yield* first(parsed.engines);
      assert.strictEqual(engine.description, "Second");
      assert.lengthOf(parsed.diagnostics, 1);
      const diagnostic = yield* first(parsed.diagnostics);
      assert.strictEqual(diagnostic.line, 2);
    }),
  );

  it.effect("keeps the original position of an engine that is redefined", () =>
    Effect.gen(function* () {
      const parsed = parseSearchEngines(
        [
          "a: https://a.test/?q=%s A",
          "b: https://b.test/?q=%s B",
          "a: https://a2.test/?q=%s A2",
        ].join("\n"),
      );
      const keywords = pipe(parsed.engines, Array.map(keywordOf));
      assert.deepEqual(keywords, ["a", "b"]);
      const engine = yield* first(parsed.engines);
      assert.strictEqual(engine.description, "A2");
    }),
  );

  it.effect("accepts a colon with a space around it", () =>
    Effect.gen(function* () {
      const parsed = parseSearchEngines("gh : https://github.com/search?q=%s GitHub");
      const engine = yield* first(parsed.engines);
      assert.strictEqual(engine.keyword, "gh");
      assert.strictEqual(engine.description, "GitHub");
    }),
  );

  it.effect("gives nothing for empty input", () =>
    Effect.sync(() => {
      const parsed = parseSearchEngines("");
      assert.deepEqual(parsed.engines, []);
      assert.deepEqual(parsed.diagnostics, []);
    }),
  );

  it.effect("encodes the query and fills every placeholder", () =>
    Effect.sync(() => {
      assert.strictEqual(
        buildSearchUrl("https://x.test/?a=%s&b=%s", "a b&c"),
        "https://x.test/?a=a%20b%26c&b=a%20b%26c",
      );
    }),
  );

  it.effect("does not treat the query as a replacement pattern", () =>
    Effect.sync(() => {
      // A plain `replaceAll` expands `$&` to the matched text.
      assert.strictEqual(
        buildSearchUrl("https://x.test/?q=%s", "$& $1"),
        "https://x.test/?q=%24%26%20%241",
      );
    }),
  );

  it.effect("takes a keyword off the front of the query", () =>
    Effect.sync(() => {
      assert.deepEqual(
        splitOf("w quantum mechanics"),
        Option.some({ keyword: "w", rest: "quantum mechanics" }),
      );
    }),
  );

  it.effect("matches a bare keyword with no space after it", () =>
    Effect.sync(() => {
      assert.deepEqual(splitOf("gh"), Option.some({ keyword: "gh", rest: "" }));
    }),
  );

  it.effect("gives none for an unknown or partial keyword", () =>
    Effect.sync(() => {
      assert.isTrue(Option.isNone(splitKeyword("g something", ENGINES)));
      assert.isTrue(Option.isNone(splitKeyword("", ENGINES)));
      assert.isTrue(Option.isNone(splitKeyword("   ", ENGINES)));
    }),
  );

  it.effect("narrows the completion list on the keyword", () =>
    Effect.sync(() => {
      const keywords = pipe(enginesMatchingPrefix(ENGINES, "g"), Array.map(keywordOf));
      assert.deepEqual(keywords, ["gh"]);
      assert.lengthOf(enginesMatchingPrefix(ENGINES, ""), 2);
      assert.deepEqual(enginesMatchingPrefix(ENGINES, "zz"), []);
    }),
  );

  it.effect("treats whitespace as a search", () =>
    Effect.sync(() => {
      assert.strictEqual(classifyQuery("example.com foo"), "search");
      assert.strictEqual(classifyQuery("how do i tie a tie"), "search");
      assert.strictEqual(classifyQuery(""), "search");
    }),
  );

  it.effect("recognises a scheme, a host, localhost and an address", () =>
    Effect.sync(() => {
      assert.deepEqual(
        addressOf("https://example.com/a?b=c"),
        Option.some("https://example.com/a?b=c"),
      );
      assert.deepEqual(addressOf("about:blank"), Option.some("about:blank"));
      assert.deepEqual(
        addressOf("view-source:https://x.test/"),
        Option.some("view-source:https://x.test/"),
      );
      assert.deepEqual(addressOf("example.com"), Option.some("https://example.com"));
      assert.deepEqual(
        addressOf("sub.example.co.uk/path"),
        Option.some("https://sub.example.co.uk/path"),
      );
      // A host and a port start with a word and a colon, and name no scheme.
      assert.deepEqual(
        addressOf("localhost:8080/admin"),
        Option.some("https://localhost:8080/admin"),
      );
      assert.deepEqual(addressOf("example.com:8080"), Option.some("https://example.com:8080"));
      assert.deepEqual(addressOf("127.0.0.1:3000"), Option.some("https://127.0.0.1:3000"));
    }),
  );

  it.effect("does not mistake a word or a version for a URL", () =>
    Effect.sync(() => {
      assert.strictEqual(classifyQuery("wikipedia"), "search");
      assert.strictEqual(classifyQuery("1.2.3"), "search");
      assert.strictEqual(classifyQuery("file.txt"), "search");
    }),
  );

  it.effect("never searches for text that carries credentials", () =>
    Effect.sync(() => {
      // A URL with user information that falls through to a search sends the
      // password to the search engine. That result cannot be undone.
      assert.deepEqual(
        addressOf("user:pass@example.com"),
        Option.some("https://user:pass@example.com"),
      );
      assert.deepEqual(
        addressOf("user:pass@example.com/path"),
        Option.some("https://user:pass@example.com/path"),
      );
      assert.deepEqual(
        addressOf("admin@10.0.0.5:8443"),
        Option.some("https://admin@10.0.0.5:8443"),
      );
      // An `@` after the first slash is part of a path, and not user
      // information.
      assert.strictEqual(classifyQuery("why/does@this"), "search");
    }),
  );

  it.effect("recognises an IPv6 literal", () =>
    Effect.sync(() => {
      assert.strictEqual(classifyQuery("[::1]"), "url");
      assert.strictEqual(classifyQuery("[::1]:8080"), "url");
      assert.strictEqual(classifyQuery("[fe80::1]/status"), "url");
    }),
  );

  it.effect("checks the range of every IPv4 octet", () =>
    Effect.sync(() => {
      assert.strictEqual(classifyQuery("192.168.1.1"), "url");
      assert.strictEqual(classifyQuery("999.999.999.999"), "search");
    }),
  );

  it.effect("accepts a fully qualified name with a trailing dot", () =>
    Effect.sync(() => {
      assert.strictEqual(classifyQuery("example.com."), "url");
    }),
  );

  it.effect("refuses a template that is not http or https", () =>
    Effect.sync(() => {
      // `javascript:alert(%s)` parses as a correct engine line, and then every
      // search through that keyword runs text in the current origin. The user
      // is told on the line that they can correct.
      const parsed = parseSearchEngines(
        [
          "bad: javascript:alert(%s) Evil",
          "rel: /search?q=%s Relative",
          "data: data:text/html,%s Data",
          "ok: https://example.com/?q=%s Fine",
        ].join("\n"),
      );

      const keywords = pipe(parsed.engines, Array.map(keywordOf));
      assert.deepEqual(keywords, ["ok"]);
      assert.lengthOf(parsed.diagnostics, 3);
      const messages = pipe(
        parsed.diagnostics,
        Array.map(({ message }) => message),
      );
      const refusal = "the URL must be http:// or https://";
      assert.deepEqual(messages, [refusal, refusal, refusal]);
    }),
  );

  it.effect("accepts only http and https as a safe template", () =>
    Effect.sync(() => {
      assert.isTrue(isSafeTemplate("https://example.com/?q=%s"));
      assert.isTrue(isSafeTemplate("http://example.com/?q=%s"));
      assert.isTrue(isSafeTemplate("HTTPS://example.com/?q=%s"));
      assert.isFalse(isSafeTemplate("javascript:alert(%s)"));
      assert.isFalse(isSafeTemplate("/search?q=%s"));
      assert.isFalse(isSafeTemplate("example.com/?q=%s"));
    }),
  );

  it.effect("adds https and never guesses http", () =>
    Effect.sync(() => {
      assert.strictEqual(toNavigableUrl("example.com"), "https://example.com");
      assert.strictEqual(toNavigableUrl("http://example.com"), "http://example.com");
      assert.strictEqual(toNavigableUrl("about:blank"), "about:blank");
    }),
  );

  it.effect("prefers a keyword engine over the default", () =>
    Effect.gen(function* () {
      const engine = yield* first(ENGINES);
      assert.deepEqual(
        destinationOf("w bohr", ENGINES, DEFAULT_SEARCH),
        Destination.EngineSearch({ engine, query: "bohr", url: "https://wiki.test/?q=bohr" }),
      );
    }),
  );

  it.effect("navigates to a URL and searches for everything else", () =>
    Effect.sync(() => {
      assert.deepEqual(
        destinationOf("example.com", ENGINES, DEFAULT_SEARCH),
        Destination.Address({ url: "https://example.com" }),
      );
      assert.deepEqual(
        destinationOf("hello there", ENGINES, DEFAULT_SEARCH),
        Destination.DefaultSearch({
          query: "hello there",
          url: "https://www.google.com/search?q=hello%20there",
        }),
      );
    }),
  );

  it.effect("treats a bare keyword as a search for that keyword", () =>
    Effect.sync(() => {
      // `w` alone has no query for the engine, so it must not open the search
      // page of Wikipedia for the empty string.
      assert.deepEqual(
        destinationOf("w", ENGINES, DEFAULT_SEARCH),
        Destination.DefaultSearch({ query: "w", url: "https://www.google.com/search?q=w" }),
      );
    }),
  );
});
