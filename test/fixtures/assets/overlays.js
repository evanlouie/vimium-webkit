/*
 * Overlay fixture behaviour: something to click that is not a link, so a spec
 * can assert on a click side effect rather than on navigation.
 */

let clicks = 0;

document.getElementById("counter")?.addEventListener("click", () => {
  clicks += 1;
  const readout = document.getElementById("click-count");
  if (readout !== null) readout.textContent = String(clicks);
});

/*
 * A clickable custom element that paints from inside its own open shadow root.
 *
 * The occlusion probe hit-tests the host but `elementsFromPoint` returns the
 * inner button, and `Node.contains` does not cross a shadow boundary — so the
 * host looked permanently occluded by something it owns.
 */
class ShadowButton extends HTMLElement {
  connectedCallback() {
    if (this.shadowRoot !== null) return;
    const shadow = this.attachShadow({ mode: "open" });
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "Shadow component button";
    button.style.cssText = "padding:6px 12px";
    shadow.appendChild(button);

    this.setAttribute("role", "button");
    this.setAttribute("tabindex", "0");
    this.setAttribute("aria-label", "Shadow component button");
    this.addEventListener("click", () => {
      location.hash = "#shadow-component-target";
    });
  }
}

customElements.define("shadow-button", ShadowButton);
