/** A line whose `detail` stays folded away until opened, under the visible `title`. */
export function buildCollapsed(cls: string, title: string, detail: string): HTMLElement {
  const box = document.createElement("details");
  box.className = `line ${cls} collapsed`;
  const summary = document.createElement("summary");
  summary.textContent = title;
  const body = document.createElement("div");
  body.className = "collapsed-detail";
  body.textContent = detail;
  box.append(summary, body);
  return box;
}
