/*
 * The page lifecycle, made observable.
 *
 * A page that the browser keeps never runs its scripts again, so the identity
 * below is made once for each document. The same identity after a "go back"
 * proves that the document came out of the back/forward cache.
 *
 * `restored` reports what the browser said on the last `pageshow`.
 */

const documentId = `doc-${Math.random().toString(36).slice(2)}`;
const idField = document.getElementById("document-id");
const restoredField = document.getElementById("restored");
const child = document.getElementById("child");
const dropChild = document.getElementById("drop-child");
const removeChild = document.getElementById("remove-child");

if (idField !== null) idField.textContent = documentId;
if (restoredField !== null) restoredField.textContent = "no";

globalThis.addEventListener("pageshow", (event) => {
  if (restoredField === null) return;
  restoredField.textContent = event.persisted ? "yes" : "no";
});

// The child document goes away, and the top document stays. This is the one
// case where "final page exit" means one frame only.
//
// A frame goes away in two ways, and the browser sends `pagehide` for both.
// The first button navigates the child. The second takes the element out of
// the tree, which is the case that the name "goes away" promises.
if (dropChild !== null && child !== null) {
  dropChild.addEventListener("click", () => {
    child.src = "frames/remote.html";
  });
}

if (removeChild !== null && child !== null) {
  removeChild.addEventListener("click", () => {
    child.remove();
  });
}
