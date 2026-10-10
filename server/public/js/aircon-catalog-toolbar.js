(function () {
  'use strict';
  var toolbar = document.querySelector('.products-aircons-premium .enterprise-filter-bar');
  var navbar = document.getElementById('publicNavbar');
  if (!toolbar) return;

  function updateOffset() {
    var offset = 0;
    if (navbar) {
      var position = window.getComputedStyle(navbar).position;
      if (position === 'fixed' || position === 'sticky') {
        offset = Math.max(0, navbar.getBoundingClientRect().bottom);
      }
    }
    toolbar.style.setProperty('--aircon-catalog-nav-offset', Math.ceil(offset) + 'px');
  }

  updateOffset();
  window.addEventListener('resize', updateOffset, { passive: true });
  if (navbar && window.ResizeObserver) {
    new ResizeObserver(updateOffset).observe(navbar, { box: 'border-box' });
  }
})();
