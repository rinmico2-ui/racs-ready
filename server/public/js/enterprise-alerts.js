(function enterpriseSweetAlerts(window) {
  "use strict";

  if (!window.Swal || window.Swal.__racsEnterprisePatched) return;

  const Swal = window.Swal;
  const originalFire = Swal.fire.bind(Swal);
  const semanticIconHtml = Object.freeze({
    success: '<span class="racs-alert-glyph" aria-hidden="true"><svg viewBox="0 0 24 24" focusable="false"><path d="M5 12.5l4.25 4.25L19 7.5"></path></svg></span>',
    error: '<span class="racs-alert-glyph" aria-hidden="true"><svg viewBox="0 0 24 24" focusable="false"><path d="M7 7l10 10M17 7L7 17"></path></svg></span>',
  });

  function joinClass(existing, required) {
    return [existing || "", required].filter(Boolean).join(" ").trim();
  }

  function getActiveModalTarget() {
    const document = window.document;
    if (!document || typeof document.querySelectorAll !== "function") return null;
    const activeModals = Array.from(document.querySelectorAll(".modal.show"))
      .filter((modal) => !modal.closest(".swal2-container"));
    return activeModals[activeModals.length - 1] || null;
  }

  function normalizeCustomClass(customClass, toast, icon) {
    const normalized = typeof customClass === "string"
      ? { popup: customClass }
      : { ...(customClass || {}) };
    normalized.popup = joinClass(normalized.popup, toast ? "racs-enterprise-toast" : "racs-enterprise-alert");
    if (!toast && ["success", "warning", "error", "info", "question"].includes(icon)) {
      normalized.popup = joinClass(normalized.popup, `racs-enterprise-${icon}`);
    }
    normalized.confirmButton = joinClass(normalized.confirmButton, "racs-enterprise-confirm");
    normalized.cancelButton = joinClass(normalized.cancelButton, "racs-enterprise-cancel");
    normalized.denyButton = joinClass(normalized.denyButton, "racs-enterprise-deny");
    return normalized;
  }

  function normalizeOptions(args) {
    const options = typeof args[0] === "object" && args[0] !== null
      ? { ...args[0] }
      : { title: args[0], text: args[1], icon: args[2] };
    const toast = options.toast === true;
    const callerDidOpen = options.didOpen;

    options.customClass = normalizeCustomClass(options.customClass, toast, options.icon);
    if (!toast && !options.iconHtml && semanticIconHtml[options.icon]) {
      options.iconHtml = semanticIconHtml[options.icon];
    }
    if (!toast && !options.target) {
      const activeModal = getActiveModalTarget();
      if (activeModal) {
        options.target = activeModal;
        options.customClass.container = joinClass(
          options.customClass.container,
          "racs-enterprise-over-modal",
        );
      }
    }
    const actionLabel = `${options.title || ""} ${options.confirmButtonText || ""}`;
    const explicitDangerColor = /#(?:dc2626|b91c1c|ef4444)|rgb\(\s*(?:220\s*,\s*38\s*,\s*38|185\s*,\s*28\s*,\s*28|239\s*,\s*68\s*,\s*68)\s*\)/i.test(options.confirmButtonColor || "");
    const destructiveAction = options.showCancelButton && /\b(delete|remove|reject|revoke|void|decline)\b/i.test(actionLabel);
    if (!toast && (explicitDangerColor || destructiveAction)) {
      options.customClass.confirmButton = joinClass(options.customClass.confirmButton, "racs-enterprise-danger");
    }
    options.heightAuto = options.heightAuto ?? false;
    options.returnFocus = options.returnFocus ?? true;
    if (!toast && (options.showCancelButton || options.input || options.html)) {
      options.allowOutsideClick = options.allowOutsideClick ?? false;
    }
    options.showClass = options.showClass || { popup: "swal2-show" };
    options.hideClass = options.hideClass || { popup: "swal2-hide" };
    options.didOpen = function didOpen(popup) {
      popup.setAttribute("data-enterprise-dialog", "true");
      if (typeof callerDidOpen === "function") callerDidOpen(popup);
    };
    return options;
  }

  Swal.fire = function enterpriseFire(...args) {
    return originalFire(normalizeOptions(args));
  };
  Swal.__racsEnterprisePatched = true;
})(window);
