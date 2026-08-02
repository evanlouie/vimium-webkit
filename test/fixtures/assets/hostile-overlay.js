/*
 * Hostile page behaviour: take the overlay host out of the document.
 *
 * A page can name the host, because the host is a normal element of the light
 * DOM. The guard in src/ui/Ui.ts must put it back, or the user keeps a
 * keyboard that answers and an interface that shows nothing.
 */

let removals = 0;

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
