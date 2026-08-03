/*
 * Hostile page behaviour: take the overlay host out of the document, move it
 * into a container of this page, and take the style declarations off it.
 *
 * A page can name the host, because the host is a normal element of the light
 * DOM. The guard in src/ui/Ui.ts must answer all three, or the user keeps a
 * keyboard that answers and an interface that shows nothing.
 */

let removals = 0;
let moves = 0;

const removeHost = () => {
  const host = document.querySelector("vimium-webkit-overlay");
  if (host === null) return false;
  host.remove();
  removals += 1;
  const readout = document.getElementById("removals");
  if (readout !== null) readout.textContent = String(removals);
  return true;
};

document.getElementById("remove-host")?.addEventListener("click", () => {
  removeHost();
});

// The spec calls this directly, because a click would move the focus.
globalThis.removeVimiumHost = removeHost;

/*
 * Move the host into a container of this page, and hide that container.
 *
 * This attack is quieter than a removal. The host stays connected, so a guard
 * that asks `isConnected` reports nothing to repair. The page keeps its own
 * visibility, because it chose the container, and the overlay keeps the
 * keyboard while the user sees nothing.
 */
const cageHost = () => {
  const host = document.querySelector("vimium-webkit-overlay");
  if (host === null) return false;
  const cage = document.createElement("div");
  cage.id = `cage-${moves}`;
  cage.style.setProperty("opacity", "0", "important");
  cage.style.setProperty("position", "fixed", "important");
  document.body.appendChild(cage);
  cage.appendChild(host);
  moves += 1;
  const readout = document.getElementById("moves");
  if (readout !== null) readout.textContent = String(moves);
  return true;
};

document.getElementById("cage-host")?.addEventListener("click", () => {
  cageHost();
});

globalThis.cageVimiumHost = cageHost;

/*
 * Give the focus to a link of this page.
 *
 * Page script can do this at any time, and it does it while our dialog is
 * open. The guard must then leave the focus where the page put it, even when
 * it puts the host back.
 */
globalThis.focusVimiumTarget = () => {
  const target = document.getElementById("target");
  if (target === null) return false;
  target.focus();
  return document.activeElement === target;
};

/*
 * Take one declaration off the host.
 *
 * One line of page script is enough. The important rule of the stylesheet
 * above then wins for ever, and a guard that compares ten properties only
 * reports nothing to repair.
 */
globalThis.stripVimiumHostProperty = (property) => {
  const host = document.querySelector("vimium-webkit-overlay");
  if (host === null) return false;
  host.style.removeProperty(property);
  return true;
};
