/*
 * A deliberately hostile single-page app.
 *
 * Two behaviours the extension has to survive: a URL that changes without a
 * document load, and a DOM that is replaced wholesale underneath any cached
 * element references.
 */

const content = document.getElementById("content");
const status = document.getElementById("status");

let generation = 0;

const render = (view) => {
  if (content === null) return;
  generation += 1;
  content.replaceChildren();

  const heading = document.createElement("h2");
  heading.textContent = `View: ${view} (render ${generation})`;
  content.appendChild(heading);

  for (const name of ["Alpha", "Beta", "Gamma"]) {
    const paragraph = document.createElement("p");
    const link = document.createElement("a");
    link.href = `#${view}-${name.toLowerCase()}`;
    link.textContent = `${view} ${name} link`;
    paragraph.appendChild(link);
    content.appendChild(paragraph);
  }

  if (status !== null) status.textContent = `${view}:${generation}`;
};

const navigate = (view) => {
  history.pushState({ view }, "", `?view=${view}`);
  render(view);
};

document.getElementById("go-detail")?.addEventListener("click", () => {
  navigate("detail");
});
document.getElementById("go-home")?.addEventListener("click", () => {
  navigate("home");
});

/* Churn: replace the whole subtree repeatedly, as a badly behaved router would. */
document.getElementById("churn")?.addEventListener("click", () => {
  const view = new URL(location.href).searchParams.get("view") ?? "home";
  for (let index = 0; index < 20; index++) render(view);
});

globalThis.addEventListener("popstate", () => {
  render(new URL(location.href).searchParams.get("view") ?? "home");
});

/* Exposed so a test can push state without a click, bypassing the click sampler. */
globalThis.spaNavigate = navigate;

render(new URL(location.href).searchParams.get("view") ?? "home");
