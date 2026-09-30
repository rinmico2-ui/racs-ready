(function () {
  "use strict";
  function initialize() {
    const viewer = document.getElementById("paymentImageModal");
    const details = document.getElementById("paymentDetailsModal");
    const image = document.getElementById("paymentImageModalImg");
    const status = document.getElementById("paymentImageStatus");
    if (!viewer || !image || !window.bootstrap?.Modal) return;

    // Escape transformed/overflowing page containers and use the admin shell's
    // modal layering. A custom z-index below its backdrop hides the image.
    [details, viewer].filter(Boolean).forEach(element => {
      if (element.parentElement !== document.body) document.body.appendChild(element);
    });
    const modal = bootstrap.Modal.getOrCreateInstance(viewer);
    let returnToDetails = false;
    let switching = false;
    function setStatus(message, failed = false) {
      if (!status) return;
      status.textContent = message;
      status.setAttribute("role", failed ? "alert" : "status");
      status.classList.toggle("d-none", !message);
    }
    image.addEventListener("load", () => {
      image.classList.remove("d-none");
      viewer.setAttribute("aria-busy", "false");
      setStatus("");
    });
    image.addEventListener("error", () => {
      image.classList.add("d-none");
      viewer.setAttribute("aria-busy", "false");
      setStatus("The receipt image could not load. Close this viewer and try again.", true);
    });
    viewer.addEventListener("shown.bs.modal", () => { switching = false; });
    viewer.addEventListener("hidden.bs.modal", () => {
      const restore = returnToDetails;
      returnToDetails = false;
      switching = false;
      image.removeAttribute("src");
      image.classList.add("d-none");
      viewer.setAttribute("aria-busy", "false");
      setStatus("");
      if (restore && details) {
        details.addEventListener("shown.bs.modal", () => {
          document.getElementById("detailsProofLink")?.focus();
        }, { once: true });
        bootstrap.Modal.getOrCreateInstance(details).show();
      }
    });
    window.openPaymentImage = function (src) {
      if (switching || typeof src !== "string" || !src.trim()) return;
      viewer.setAttribute("aria-busy", "true");
      image.classList.add("d-none");
      setStatus("Loading receipt...");
      image.src = src;
      if (viewer.classList.contains("show")) return;
      switching = true;
      returnToDetails = Boolean(details?.classList.contains("show"));
      // Bootstrap supports one active modal/focus trap at a time. Wait for the
      // details backdrop to finish closing, then open the receipt. Closing the
      // receipt restores the same details without refetching the payment.
      if (returnToDetails) {
        details.addEventListener("hidden.bs.modal", () => modal.show(), { once: true });
        bootstrap.Modal.getOrCreateInstance(details).hide();
      } else modal.show();
    };
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initialize, { once: true });
  else initialize();
})();
