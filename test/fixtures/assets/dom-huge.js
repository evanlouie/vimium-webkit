/*
 * A very large document, generated and not checked in.
 *
 * The number is the point. Discovery walks every element, and the walk must
 * give the main thread back while it does. A file with this many elements is
 * unreadable, and the parser is not the thing under test.
 *
 * The elements are plain `<div>` boxes with text. A `<div>` takes no hint
 * unless it scrolls, so the size of the *walk* is what grows here, and not the
 * number of hints. Twenty links carry the hints, and one beacon carries the
 * assertion.
 */

const TOTAL = 120_000;
const LEAVES = 4;
const BOXES = 6;

const container = document.getElementById("bulk");
if (container !== null) {
  const fragment = document.createDocumentFragment();
  let made = 0;
  let section = 0;
  while (made < TOTAL) {
    section += 1;
    const group = document.createElement("section");
    made += 1;
    for (let box = 0; box < BOXES; box++) {
      const wrapper = document.createElement("div");
      made += 1;
      for (let leaf = 0; leaf < LEAVES; leaf++) {
        const cell = document.createElement("div");
        cell.textContent = `row ${section}`;
        wrapper.appendChild(cell);
        made += 1;
      }
      group.appendChild(wrapper);
    }
    fragment.appendChild(group);
  }
  container.appendChild(fragment);

  const links = document.getElementById("links");
  if (links !== null) {
    for (let index = 1; index <= 20; index++) {
      const link = document.createElement("a");
      link.href = `#bulk-${index}`;
      link.textContent = `Bulk link ${index}`;
      links.appendChild(link);
      links.appendChild(document.createTextNode(" "));
    }
  }

  const count = document.getElementById("count");
  if (count !== null) {
    count.textContent = String(document.querySelectorAll("*").length);
  }
}
