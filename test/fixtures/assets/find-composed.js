/*
 * The open shadow root of `find-composed.html`.
 *
 * External, and not inline, so that every fixture is served under the same
 * rules. The shadow tree holds one occurrence of the word under test, and the
 * slot after it draws the light child that holds another. The reader therefore
 * sees the shadow text *before* the light text of the same host.
 */

const card = document.getElementById("card");
if (card !== null) {
  const root = card.attachShadow({ mode: "open" });

  const head = document.createElement("div");
  head.id = "head";
  head.textContent = "beta widget two";

  const slot = document.createElement("slot");
  slot.name = "body";

  root.append(head, slot);
}
