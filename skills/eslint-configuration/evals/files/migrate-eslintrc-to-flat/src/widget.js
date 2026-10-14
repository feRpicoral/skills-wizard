export function renderWidget(el, options) {
  const heading = document.createElement("h2");
  heading.textContent = options.title;
  el.appendChild(heading);
}
