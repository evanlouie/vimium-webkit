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
