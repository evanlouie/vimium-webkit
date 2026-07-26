/*
 * 2400 links, generated rather than checked in.
 *
 * A 2400-element HTML file is unreadable and unreviewable, and the thing under
 * test is the detection pipeline's cost per element, not the parser's.
 */

const TOTAL = 2400;

const container = document.getElementById("grid");
if (container !== null) {
  const fragment = document.createDocumentFragment();
  for (let index = 1; index <= TOTAL; index++) {
    const link = document.createElement("a");
    link.href = `#link-${index}`;
    link.className = "cell";
    link.textContent = `Link ${index}`;
    fragment.appendChild(link);
  }
  container.appendChild(fragment);

  const count = document.getElementById("count");
  if (count !== null) count.textContent = String(TOTAL);
}
