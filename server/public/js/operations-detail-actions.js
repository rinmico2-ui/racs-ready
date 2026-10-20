(function (root) {
  'use strict';

  // Wait for Bootstrap to release its focus trap and backdrop before handing
  // the record to another modal or workflow tab.
  function afterClose(element, work, controller) {
    if (!element) return Promise.resolve().then(work);
    const modal = controller || root.bootstrap?.Modal.getInstance(element);
    if (!modal || (!element.classList.contains('show') && !modal._isTransitioning)) {
      return Promise.resolve().then(work);
    }
    return new Promise((resolve, reject) => {
      element.addEventListener('hidden.bs.modal', () => {
        Promise.resolve().then(work).then(resolve, reject);
      }, { once: true });
      if (modal._isTransitioning && (modal._isShown === true || element.classList.contains('show'))) {
        element.addEventListener('shown.bs.modal', () => modal.hide(), { once: true });
      } else if (!modal._isTransitioning) modal.hide();
    });
  }

  function showTab(selector, reload) {
    const button = root.document.querySelector(selector);
    if (!button) return false;
    if (button.classList.contains('active')) {
      if (reload) reload();
    } else if (root.bootstrap?.Tab) root.bootstrap.Tab.getOrCreateInstance(button).show();
    else if (root.AdminTabs) root.AdminTabs.show(button);
    else button.click();
    return true;
  }

  root.RACSDetailActions = { afterClose, showTab };
})(window);
