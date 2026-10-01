(function () {
  "use strict";
  const target = document.getElementById("deferredOrderReport");
  if (!target) return;
  const reportRole = target.dataset && target.dataset.reportRole === "secretary" ? "secretary" : "admin";
  async function load() {
    target.setAttribute("aria-busy", "true");
    try {
      const response = await fetch("/" + reportRole + "/reports/orders/data" + window.location.search, {
        credentials: "same-origin", headers: { Accept: "text/html" },
      });
      if (!response.ok || response.redirected) throw new Error("Report unavailable. Check your session and try again.");
      const source = new DOMParser().parseFromString(await response.text(), "text/html");
      const scripts = Array.from(source.querySelectorAll("script"));
      scripts.forEach(script => script.remove());
      const fragment = document.createDocumentFragment();
      Array.from(source.head.childNodes).concat(Array.from(source.body.childNodes))
        .forEach(node => fragment.appendChild(document.importNode(node, true)));
      target.replaceChildren(fragment);
      target.setAttribute("aria-busy", "false");
      // Preserve dependency ordering: the report's charts and drilldowns must
      // initialize after their libraries. Scripts are from our authenticated view.
      for (const original of scripts) {
        if (original.type && !["text/javascript", "application/javascript", "module"].includes(original.type)) {
          target.appendChild(document.importNode(original, true));
          continue;
        }
        const script = document.createElement("script");
        Array.from(original.attributes).forEach(attribute => script.setAttribute(attribute.name, attribute.value));
        if (original.src) {
          await new Promise((resolve, reject) => {
            script.onload = resolve;
            script.onerror = () => reject(new Error("A report library could not load. Please retry."));
            target.appendChild(script);
          });
        } else { script.textContent = original.textContent; target.appendChild(script); }
      }
    } catch (error) {
      target.setAttribute("aria-busy", "false");
      const message = document.createElement("p");
      message.className = "alert alert-warning";
      message.setAttribute("role", "alert");
      message.textContent = error.message;
      const retry = document.createElement("button");
      retry.className = "btn btn-outline-primary";
      retry.textContent = "Retry report";
      retry.addEventListener("click", () => window.location.reload());
      target.append(message, retry);
    }
  }
  load();
})();
