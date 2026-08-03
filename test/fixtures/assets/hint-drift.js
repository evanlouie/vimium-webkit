/*
 * Fill the scroll panel, and give a spec two ways to move the page under a
 * marker.
 *
 * The links have an exact row pitch, so a scroll of a whole number of rows
 * puts one link exactly where another link stood. A marker that does not
 * follow its element then sits on a different link, which is the defect that
 * the spec looks for.
 */

const ROWS = 40;
const panel = document.getElementById("panel");

for (let index = 1; index <= ROWS; index++) {
  const link = document.createElement("a");
  link.href = `#panel-${index}`;
  link.id = `panel-${index}`;
  link.textContent = `Panel link ${index}`;
  panel?.appendChild(link);
}

/** Move a link away from its marker, with no scroll and no resize. */
globalThis.moveShifty = () => {
  const shifty = document.getElementById("shifty");
  if (shifty !== null) shifty.style.transform = "translateY(140px)";
};

/** Move the target from a page handler inside synthetic dispatch. */
globalThis.moveShiftyOnPointerover = () => {
  const shifty = document.getElementById("shifty");
  shifty?.addEventListener("pointerover", () => {
    shifty.style.transform = "translateY(140px)";
  }, { once: true });
};

/** Imitate the fractional reflow that follows a completed font load. */
globalThis.finishFontReflow = () => {
  const link = document.getElementById("font-shifty");
  if (link === null) return;
  link.style.transform = "translateX(123.977px)";
  document.fonts.dispatchEvent(new Event("loadingdone"));
};

/** Put an opaque box over the steady link, where its marker is drawn. */
globalThis.coverSteady = () => {
  const steady = document.getElementById("steady");
  const cover = document.getElementById("cover");
  if (steady === null || cover === null) return;
  const box = steady.getBoundingClientRect();
  cover.style.display = "block";
  cover.style.left = `${box.left - 8}px`;
  cover.style.top = `${box.top - 8}px`;
  cover.style.width = `${box.width + 16}px`;
  cover.style.height = `${box.height + 16}px`;
};
