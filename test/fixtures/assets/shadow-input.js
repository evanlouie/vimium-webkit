/*
 * A text field inside an open shadow root.
 *
 * External, and not inline, so that every fixture is served under the same
 * rules. The CSP fixture is the only one that needs it, but a fixture set where
 * only one page is disciplined is a fixture set that drifts.
 */

const host = document.getElementById("widget-host");
if (host !== null) {
  const root = host.attachShadow({ mode: "open" });

  const field = document.createElement("input");
  field.id = "shadow-field";
  field.type = "text";
  field.setAttribute("aria-label", "search inside the shadow root");

  const label = document.createElement("p");
  label.textContent = "A field that lives in an open shadow root:";

  root.append(label, field);
}
