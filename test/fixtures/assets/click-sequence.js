/*
 * Record the properties of every pointer event and mouse event of a click.
 *
 * A spec compares the sequence that a true mouse makes with the sequence that
 * a hint activation makes. Only `type`, `button` and `buttons` are kept,
 * because those are the fields that a control reads to decide whether a click
 * is a click.
 */

globalThis.__events = [];

const TYPES = [
  "pointerover",
  "mouseover",
  "pointerdown",
  "mousedown",
  "pointerup",
  "mouseup",
  "click",
];

const probe = document.getElementById("probe");

for (const type of TYPES) {
  probe?.addEventListener(type, (event) => {
    globalThis.__events.push({
      type: event.type,
      button: event.button,
      buttons: event.buttons,
    });
  });
}

probe?.addEventListener("click", () => {
  const readout = document.getElementById("click-count");
  if (readout !== null) {
    readout.textContent = String(Number(readout.textContent) + 1);
  }
});
