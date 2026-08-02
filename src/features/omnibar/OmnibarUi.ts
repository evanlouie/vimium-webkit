/**
 * The overlay of the omnibar.
 *
 * It lives in the `"omnibar"` layer of the one closed shadow root, so page CSS
 * cannot reach it and page script cannot walk into it. Two results of that
 * shape the rest of the feature:
 *
 * - The text field is a **true in-page element**, so it takes part in the
 *   focus of the page. Focus alone cannot route the keys here, which is why
 *   the omnibar mode claims the keyboard on the handler stack.
 * - The panel is positioned against `Ui.viewport`, and never against
 *   `window.innerHeight`. On iOS the keyboard makes the visual viewport
 *   smaller while the layout viewport does not change, so a panel that follows
 *   the layout viewport ends below the keyboard that the user types on.
 *
 * Every node, every listener and the stylesheet belong to the scope of the
 * caller. To close that scope removes the overlay and gives the focus back.
 * There is no `dispose` method.
 */

import { Effect, FiberHandle, Option, Ref, type Scope } from "effect";
import { Dom } from "~/platform/Dom.ts";
import { deepActiveElement } from "~/platform/Elements.ts";
import { acceptPointerEvents, Ui } from "~/ui/Ui.ts";
import type { Completion } from "./Completers.ts";

/** Where the top edge of the panel sits, as a part of the viewport height. */
const TOP_FRACTION = 0.12;

/**
 * The stylesheet of the omnibar.
 *
 * It is installed with `Ui.addStyle`, which puts it in the
 * `adoptedStyleSheets` of the shadow root. **Never build a `<style>` element
 * for this.** Safari applies the `style-src` of the *page* to a node that a
 * content script inserts, so a `<style>` element is blocked on any site with a
 * strict policy, and a constructed stylesheet is not a fetch and is not
 * policed.
 *
 * The colours are the tokens of `~/ui/Styles.ts`. The dark palette therefore
 * follows the scheme that `Ui` calculated, which is the scheme of the *page*
 * when `followPageColorScheme` is on, and the scheme of the user agent
 * otherwise.
 */
export const OMNIBAR_CSS: string = `
.vw-omnibar {
  position: absolute;
  top: 0;
  left: 0;
  box-sizing: border-box;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  /*
   * The layer host has pointer-events: none. The panel takes them back, so
   * that a click on a row does not fall through to the page.
   */
  pointer-events: none;
  contain: layout style;
}

.vw-omnibar__panel {
  pointer-events: auto;
  box-sizing: border-box;
  width: min(640px, 92%);
  max-height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--vw-bg-raised);
  color: var(--vw-fg);
  border: 1px solid var(--vw-border);
  border-radius: 10px;
  box-shadow: var(--vw-shadow);
  font-size: 14px;
  line-height: 1.35;
}

.vw-omnibar__field {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--vw-border);
}

.vw-omnibar__prefix {
  flex: none;
  font-family: var(--vw-mono);
  font-size: 13px;
  font-weight: 700;
  color: var(--vw-accent);
}

/*
 * A true <input> inside our closed shadow root. It takes part in the focus of
 * the page, which is why the omnibar mode sits on the handler stack and claims
 * the keyboard instead of trusting the focus.
 */
.vw-omnibar__input {
  flex: 1 1 auto;
  min-width: 0;
  box-sizing: border-box;
  margin: 0;
  padding: 0;
  border: 0;
  outline: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  /* 16px: anything smaller makes Safari on iOS zoom the page on focus. */
  font-size: 16px;
}

.vw-omnibar__input::placeholder {
  color: var(--vw-muted);
}

.vw-omnibar__list {
  margin: 0;
  padding: 4px 0;
  list-style: none;
  overflow-y: auto;
  overscroll-behavior: contain;
  -webkit-overflow-scrolling: touch;
}

.vw-omnibar__row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 6px 12px;
  cursor: default;
}

.vw-omnibar__row--selected {
  background: var(--vw-bg);
  box-shadow: inset 2px 0 0 var(--vw-accent);
}

/*
 * Tier C. Grey, and present, with the shortcut of the browser beside it. A
 * refusal that the user can see is a way to find the function, and not a gap.
 */
.vw-omnibar__row--muted .vw-omnibar__title,
.vw-omnibar__row--muted .vw-omnibar__detail {
  opacity: 0.5;
}

.vw-omnibar__badge {
  flex: none;
  min-width: 62px;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.4px;
  text-transform: uppercase;
  color: var(--vw-muted);
  text-align: right;
}

.vw-omnibar__body {
  flex: 1 1 auto;
  min-width: 0;
}

.vw-omnibar__title {
  display: block;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.vw-omnibar__detail {
  display: block;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: 12px;
  color: var(--vw-muted);
}

.vw-omnibar__native {
  flex: none;
  padding: 1px 6px;
  border: 1px solid var(--vw-border);
  border-radius: 4px;
  font-family: var(--vw-mono);
  font-size: 11px;
  color: var(--vw-muted);
  white-space: nowrap;
}

.vw-omnibar__empty {
  padding: 10px 12px;
  font-size: 13px;
  color: var(--vw-muted);
}

.vw-omnibar__footer {
  padding: 6px 12px;
  border-top: 1px solid var(--vw-border);
  font-size: 11px;
  color: var(--vw-muted);
}
`;

export interface OmnibarViewOptions {
  readonly placeholder: string;
  /** The text changed. This body may suspend; the view runs it in a fiber. */
  readonly onInput: (value: string) => Effect.Effect<void>;
  /**
   * A row was clicked. `newTab` is the same as Shift and Enter.
   *
   * This body runs inside the dispatch of the browser, so it must not suspend.
   * The caller forks the work, because to act closes this view, and a fiber of
   * this scope would be interrupted with it.
   */
  readonly onActivate: (index: number, newTab: boolean) => Effect.Effect<void>;
  /** The focus left the overlay. It runs in a fiber of this scope. */
  readonly onDismiss: Effect.Effect<void>;
}

export interface OmnibarView {
  /** The text in the field. */
  readonly value: Effect.Effect<string>;
  readonly setValue: (value: string) => Effect.Effect<void>;
  /** The sign in front of the field: `:` in command mode, `›` otherwise. */
  readonly setPrefix: (text: string) => Effect.Effect<void>;
  readonly setFooter: (text: string) => Effect.Effect<void>;
  readonly focus: Effect.Effect<void>;
  readonly render: (
    rows: readonly Completion[],
    selected: number,
  ) => Effect.Effect<void>;
  /** True while the event belongs to our own overlay. */
  readonly ownsFocus: (target: EventTarget | null) => boolean;
}

/** Build the overlay. It exists for as long as the enclosing scope. */
export const makeOmnibarView = (
  options: OmnibarViewOptions,
): Effect.Effect<OmnibarView, never, Dom | Ui | Scope.Scope> =>
  Effect.gen(function*() {
    const dom = yield* Dom;
    const ui = yield* Ui;
    const doc = dom.document;
    const host = yield* ui.layer("omnibar");

    // Taken before the field takes the focus, and given back when the scope
    // closes. To close the omnibar must not steal the focus of the page.
    yield* Effect.acquireRelease(
      dom.probeOr(
        () => Option.fromNullishOr(deepActiveElement(doc)),
        Option.none<Element>(),
      ),
      (previous) =>
        Effect.ignore(dom.attempt("HTMLElement.focus", () => {
          if (Option.isNone(previous)) return;
          const element = previous.value;
          if (element instanceof HTMLElement && element.isConnected) {
            element.focus({ preventScroll: true });
          }
        })),
    );

    const parts = yield* Effect.acquireRelease(
      Effect.sync(() => {
        const container = doc.createElement("div");
        container.className = "vw-omnibar";

        const panel = doc.createElement("div");
        panel.className = "vw-omnibar__panel";
        container.appendChild(panel);

        const field = doc.createElement("div");
        field.className = "vw-omnibar__field";
        panel.appendChild(field);

        const prefix = doc.createElement("span");
        prefix.className = "vw-omnibar__prefix";
        field.appendChild(prefix);

        const input = doc.createElement("input");
        input.className = "vw-omnibar__input";
        input.type = "text";
        input.placeholder = options.placeholder;
        // The autofill and the spellcheck of the page have no business inside
        // our overlay, and a completion list of the browser here would sit on
        // top of our own list.
        input.autocomplete = "off";
        input.spellcheck = false;
        input.setAttribute("autocapitalize", "off");
        input.setAttribute("autocorrect", "off");
        field.appendChild(input);

        const list = doc.createElement("ul");
        list.className = "vw-omnibar__list";
        panel.appendChild(list);

        const footer = doc.createElement("div");
        footer.className = "vw-omnibar__footer";
        panel.appendChild(footer);

        host.appendChild(container);
        return { container, panel, prefix, input, list, footer };
      }),
      (built) =>
        Effect.sync(() => {
          built.container.remove();
        }),
    );

    // The layer takes pointer events while the omnibar is open, and gives them
    // back to the page when the scope closes.
    yield* acceptPointerEvents(host);

    const rowElements = yield* Ref.make<readonly HTMLElement[]>([]);

    // ---------------------------------------------------------------
    // Drawing
    // ---------------------------------------------------------------

    const buildRow = (
      completion: Completion,
      selected: boolean,
    ): HTMLElement => {
      const row = doc.createElement("li");
      const classes = ["vw-omnibar__row"];
      if (selected) classes.push("vw-omnibar__row--selected");
      if (completion.muted) classes.push("vw-omnibar__row--muted");
      row.className = classes.join(" ");

      const badge = doc.createElement("span");
      badge.className = "vw-omnibar__badge";
      badge.textContent = completion.badge;
      row.appendChild(badge);

      const body = doc.createElement("span");
      body.className = "vw-omnibar__body";
      row.appendChild(body);

      // `textContent` everywhere, and never `innerHTML`. A title comes from a
      // page that we visited, and a suggestion comes off the network, so both
      // are text from a third party. Markup here would be a route into our own
      // overlay.
      const title = doc.createElement("span");
      title.className = "vw-omnibar__title";
      title.textContent = completion.title;
      body.appendChild(title);

      if (completion.detail.length > 0) {
        const detail = doc.createElement("span");
        detail.className = "vw-omnibar__detail";
        detail.textContent = completion.detail;
        body.appendChild(detail);
      }

      if (Option.isSome(completion.nativeAlternative)) {
        const native = doc.createElement("span");
        native.className = "vw-omnibar__native";
        native.textContent = completion.nativeAlternative.value;
        row.appendChild(native);
      }

      return row;
    };

    const render = Effect.fn("OmnibarView.render")(
      function*(rows: readonly Completion[], selected: number) {
        if (rows.length === 0) {
          yield* Ref.set(rowElements, []);
          yield* Effect.sync(() => {
            const empty = doc.createElement("li");
            empty.className = "vw-omnibar__empty";
            empty.textContent = "No matches";
            parts.list.replaceChildren(empty);
          });
          return;
        }

        const elements = rows.map((completion, index) =>
          buildRow(completion, index === selected)
        );
        yield* Ref.set(rowElements, elements);
        yield* Effect.sync(() => {
          parts.list.replaceChildren(...elements);
          const active = elements[selected];
          if (active !== undefined) {
            active.scrollIntoView({ block: "nearest", behavior: "instant" });
          }
        });
      },
    );

    // ---------------------------------------------------------------
    // The viewport
    // ---------------------------------------------------------------

    const applyViewport = Effect.gen(function*() {
      const rect = yield* ui.viewport;
      yield* Effect.ignore(
        dom.attempt("CSSStyleDeclaration.setProperty", () => {
          const style = parts.container.style;
          style.transform =
            `translate(${rect.offsetLeft}px, ${rect.offsetTop}px)`;
          style.width = `${rect.width}px`;
          style.height = `${rect.height}px`;
          style.paddingTop = `${Math.round(rect.height * TOP_FRACTION)}px`;
        }),
      );
    });

    // One write for each animation frame. A resize and a scroll arrive many
    // times inside one frame, and a newer one interrupts the fiber that the
    // one before it started.
    const repositionFiber = yield* FiberHandle.make<void, never>();
    const reposition = Effect.asVoid(FiberHandle.run(
      repositionFiber,
      Effect.andThen(dom.nextFrame, applyViewport),
    ));

    yield* dom.listen("window", "resize", () => reposition, { passive: true });

    const visualViewport = yield* dom.probeOr(
      () => Option.fromNullishOr(dom.window.visualViewport),
      Option.none<VisualViewport>(),
    );
    if (Option.isSome(visualViewport)) {
      const visual = visualViewport.value;
      yield* dom.listenOn(visual, "resize", () => reposition, {
        passive: true,
      });
      yield* dom.listenOn(visual, "scroll", () => reposition, {
        passive: true,
      });
    }

    yield* applyViewport;

    // ---------------------------------------------------------------
    // The listeners of the panel
    // ---------------------------------------------------------------

    const ownsFocus = (target: EventTarget | null): boolean =>
      // `Ui.owns` as well as the field itself. The overlay lives in a *closed*
      // shadow root, so an event that a listener on `window` sees has already
      // been retargeted to the host, and it never equals the field.
      target === parts.input || ui.owns(target);

    // The body of `onInput` reads storage and may suspend, and a DOM listener
    // must not. A newer keystroke interrupts the render of the older one.
    const inputFiber = yield* FiberHandle.make<void, never>();
    yield* dom.listenOn(
      parts.input,
      "input",
      () =>
        Effect.asVoid(
          FiberHandle.run(inputFiber, options.onInput(parts.input.value)),
        ),
    );

    /**
     * Keep the focus in the field when the user reaches for a row.
     *
     * Without this, `mousedown` blurs the field, the blur body closes the
     * omnibar, and the `click` then lands on nothing.
     */
    yield* dom.listenOn(parts.panel, "mousedown", (event) =>
      Effect.sync(() => {
        if (event.target !== parts.input) event.preventDefault();
      }));

    yield* dom.listenOn(
      parts.panel,
      "click",
      (event) =>
        Effect.gen(function*() {
          const elements = yield* Ref.get(rowElements);
          const target = event.target;
          const index = elements.findIndex((row) =>
            target instanceof Node && row.contains(target)
          );
          if (index === -1) return;
          const mouse = event instanceof MouseEvent ? event : null;
          yield* options.onActivate(
            index,
            mouse !== null && (mouse.shiftKey || mouse.metaKey),
          );
        }),
    );

    // A click on a row blurs the field for one task before the focus comes
    // back, so only a focus that has truly left our shadow root is a
    // dismissal. The check waits one task, in a fiber of this scope.
    const blurFiber = yield* FiberHandle.make<void, never>();
    yield* dom.listenOn(
      parts.input,
      "blur",
      () =>
        Effect.asVoid(FiberHandle.run(
          blurFiber,
          Effect.gen(function*() {
            yield* dom.yieldToBrowser;
            const active = yield* dom.probeOr(
              () => ui.shadow.activeElement,
              null,
            );
            if (active === parts.input) return;
            yield* options.onDismiss;
          }),
        )),
    );

    return {
      value: Effect.sync(() => parts.input.value),
      setValue: (value) =>
        Effect.ignore(dom.attempt("HTMLInputElement.setSelectionRange", () => {
          parts.input.value = value;
          parts.input.setSelectionRange(value.length, value.length);
        })),
      setPrefix: (text) =>
        Effect.sync(() => {
          parts.prefix.textContent = text;
        }),
      setFooter: (text) =>
        Effect.sync(() => {
          parts.footer.textContent = text;
          parts.footer.hidden = text.length === 0;
        }),
      focus: Effect.ignore(dom.attempt("HTMLElement.focus", () => {
        // `preventScroll`: without it WebKit scrolls the *page* to show an
        // element inside a fixed overlay.
        parts.input.focus({ preventScroll: true });
      })),
      render,
      ownsFocus,
    };
  });
