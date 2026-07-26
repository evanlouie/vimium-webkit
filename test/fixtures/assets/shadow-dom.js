/*
 * Shadow DOM fixture behaviour.
 *
 * External, not inline, so every fixture can be served under the same rules;
 * the CSP fixture is the only one that actually needs it, but a fixture set
 * where only one page is disciplined is a fixture set that drifts.
 */

// --- An open shadow root, with a slot for light-DOM children ---------------

const openHost = document.getElementById("open-host");
if (openHost !== null) {
  const root = openHost.attachShadow({ mode: "open" });

  const shadowLink = document.createElement("a");
  shadowLink.href = "#open-shadow-target";
  shadowLink.textContent = "Open shadow link";

  const paragraph = document.createElement("p");
  paragraph.appendChild(shadowLink);

  root.append(paragraph, document.createElement("slot"));
}

// --- A closed shadow root -------------------------------------------------

/*
 * Deliberately childless in the light DOM and sized by CSS, which is exactly
 * the shape `looksLikeClosedShadowHost` recognises: an upgraded custom element
 * that occupies a box yet has nothing we can walk into.
 */
class ClosedWidget extends HTMLElement {
  constructor() {
    super();
    const root = this.attachShadow({ mode: "closed" });
    const link = document.createElement("a");
    link.href = "#closed-shadow-target";
    link.textContent = "Closed shadow link";
    root.appendChild(link);
  }
}

customElements.define("closed-widget", ClosedWidget);
