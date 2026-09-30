(function (root) {
  "use strict";
  let dispose = null;
  root.closeAoImage = function () { if (dispose) dispose(); };
  root.openAoImage = function (src) {
    if (typeof src !== "string" || !src.trim()) return;
    src = src.trim();
    // Older uploads sometimes omitted the leading slash. These are app-root
    // paths, not paths relative to /admin/appointments/orders.
    if (/^uploads\//i.test(src)) src = "/" + src;
    root.closeAoImage();
    const details = document.getElementById("aoDetailsModal");
    // Keeping the viewer inside the active modal makes Bootstrap's focus trap
    // include its close button. Do not open a second Bootstrap backdrop.
    const host = details?.classList.contains("show") ? details : document.body;
    const previousFocus = document.activeElement;
    const overlay = document.createElement("div");
    overlay.id = "aoImageOverlay";
    overlay.className = "ao-lightbox-overlay";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", "Order receipt and evidence viewer");
    overlay.setAttribute("aria-busy", "true");
    const content = document.createElement("div");
    content.className = "ao-lightbox-content";
    const close = document.createElement("button");
    close.type = "button";
    close.className = "ao-lightbox-close";
    close.setAttribute("aria-label", "Close image viewer");
    close.textContent = "\u00d7";
    const message = document.createElement("p");
    message.className = "text-white text-center p-3 mb-0";
    message.setAttribute("role", "status");
    message.setAttribute("aria-live", "polite");
    message.textContent = "Loading image...";
    const image = document.createElement("img");
    image.alt = "Order receipt or uploaded evidence";
    image.className = "d-none";
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "btn btn-outline-light d-none";
    retry.textContent = "Retry image";
    let diagnosticController = null;
    let diagnosticTimer = null;
    let imageAttempt = 0;
    function stopDiagnostic() {
      diagnosticController?.abort();
      diagnosticController = null;
      if (diagnosticTimer !== null) root.clearTimeout(diagnosticTimer);
      diagnosticTimer = null;
    }
    function showError(text) {
      image.classList.add("d-none");
      message.classList.remove("d-none");
      retry.classList.remove("d-none");
      message.textContent = text;
      message.setAttribute("role", "alert");
      overlay.setAttribute("aria-busy", "false");
    }
    async function diagnoseFailure(attempt) {
      if (/^data:/i.test(src)) {
        showError("Image unavailable: the saved image is invalid or damaged. Upload the original photo again.");
        return;
      }
      // Do not proxy arbitrary remote URLs or send credentials to other hosts.
      // A same-origin HEAD identifies missing files/auth failures without
      // downloading a second copy of a multi-megabyte image.
      let url;
      try { url = new URL(src, root.location.href); } catch (_) { return; }
      if (url.origin !== root.location.origin || typeof root.fetch !== "function") return;
      const controller = new AbortController();
      diagnosticController = controller;
      diagnosticTimer = root.setTimeout(() => controller.abort(), 10000);
      try {
        const response = await root.fetch(url.href, { method: "HEAD", credentials: "same-origin", cache: "no-store", signal: controller.signal });
        if (closed || attempt !== imageAttempt) return;
        if (response.status === 404 || response.status === 410) {
          showError("Image unavailable: the saved file is missing from this server. If it was uploaded on Railway, view it there. Otherwise, restore or re-upload the original receipt/photo.");
        } else if (response.status === 401) {
          showError("Image unavailable: your session has expired. Sign in again, then reopen this photo.");
        } else if (response.status === 403) {
          showError("Image unavailable: your account does not have permission to view this photo.");
        } else if (response.status === 429) {
          showError("Image unavailable: too many requests. Wait a moment, then retry.");
        } else if (!response.ok) {
          showError("Image unavailable: the server returned HTTP " + response.status + ". Please retry.");
        } else {
          showError("Image unavailable: this address did not return a readable image. Check the original upload or the browser Console for a blocked image request.");
        }
      } catch (_) {
        // Keep the original error and usable close/retry controls.
      } finally {
        if (diagnosticController === controller) stopDiagnostic();
      }
    }
    image.addEventListener("load", () => {
      stopDiagnostic();
      image.classList.remove("d-none");
      message.classList.add("d-none");
      retry.classList.add("d-none");
      overlay.setAttribute("aria-busy", "false");
    });
    image.addEventListener("error", () => {
      if (closed) return;
      stopDiagnostic();
      showError("Image unavailable. Retry below. If it still fails, the original upload may need to be restored.");
      void diagnoseFailure(imageAttempt);
    });
    let closed = false;
    function closeViewer() {
      if (closed) return;
      closed = true;
      stopDiagnostic();
      document.removeEventListener("keydown", onKey, { capture: true });
      details?.removeEventListener("hidden.bs.modal", closeViewer);
      overlay.remove();
      image.removeAttribute("src");
      if (dispose === closeViewer) dispose = null;
      if (previousFocus?.isConnected && (host === document.body || host.classList.contains("show"))) previousFocus.focus();
    }
    function onKey(event) {
      if (event.key !== "Escape" && event.key !== "Tab") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.key === "Escape") closeViewer();
      else {
        const retryVisible = !retry.classList.contains("d-none");
        if (retryVisible && document.activeElement === close) retry.focus();
        else close.focus();
      }
    }
    dispose = closeViewer;
    close.addEventListener("click", closeViewer);
    overlay.addEventListener("click", event => { if (event.target === overlay) closeViewer(); });
    document.addEventListener("keydown", onKey, { capture: true });
    details?.addEventListener("hidden.bs.modal", closeViewer, { once: true });
    function loadImage() {
      imageAttempt++;
      stopDiagnostic();
      retry.classList.add("d-none");
      image.classList.add("d-none");
      message.classList.remove("d-none");
      message.setAttribute("role", "status");
      message.textContent = "Loading image...";
      overlay.setAttribute("aria-busy", "true");
      image.removeAttribute("src");
      image.src = src;
      close.focus();
    }
    retry.addEventListener("click", loadImage);
    content.append(close, message, image, retry);
    overlay.appendChild(content);
    host.appendChild(overlay);
    loadImage();
    close.focus();
  };
})(window);
