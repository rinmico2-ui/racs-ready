/**
 * CALIDRO RACS — customer sidebar controller.
 *
 * Two modes, chosen by viewport:
 *
 *   Desktop and mobile use the same on-demand account drawer. This avoids a
 *   permanent page gutter and prevents a persistent rail from covering page
 *   controls. The navbar button is the single entry point at every size.
 *
 * Also owns badge counts from /api/customer/nav-summary, the account dropdown,
 * active-page marking, and sign out.
 */
(function () {
  "use strict";

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  function init() {
    var DESKTOP_QUERY = window.matchMedia("(min-width: 992px)");

    var sidebar = document.getElementById("authSidebar");
    if (!sidebar) return;

    var menuTrigger = document.getElementById("racsMenuTrigger");
    var triggerCartBadge = document.getElementById("racsTriggerCartBadge");
    var closeBtn = document.getElementById("closeSidebar");
    var backdrop = document.getElementById("authSidebarBackdrop");
    var userWrap = document.getElementById("racsSidebarUser");
    var userBtn = document.getElementById("racsSidebarUserBtn");
    var userMenu = document.getElementById("racsSidebarUserMenu");
    var logoutBtn = document.getElementById("logoutBtn");
    var lastFocused = null;

    /* ── Badges ───────────────────────────────────────────────────────── */

    var BADGE_LABELS = {
      cart: function (n) {
        return n + (n === 1 ? " item in cart" : " items in cart");
      },
      bookings: function (n) {
        return n + (n === 1 ? " booking needs your attention" : " bookings need your attention");
      },
      orders: function (n) {
        return n + (n === 1 ? " order needs your attention" : " orders need your attention");
      },
      aftercare: function (n) {
        return n === 1 ? "1 open aftercare request" : n + " open aftercare requests";
      },
    };

    function setBadge(key, rawValue) {
      var node = sidebar.querySelector('[data-badge="' + key + '"]');
      if (!node) return;

      var value = Number(rawValue) || 0;
      if (value <= 0) {
        // No badge at all when there is nothing worth showing.
        node.textContent = "";
        node.hidden = true;
        node.removeAttribute("aria-label");
        node.removeAttribute("title");
        return;
      }

      node.textContent = value > 99 ? "99+" : String(value);
      node.hidden = false;

      var label = BADGE_LABELS[key] ? BADGE_LABELS[key](value) : value + " items";
      node.setAttribute("aria-label", label);
      node.setAttribute("title", label);

      // Mirror the cart count onto the mobile menu button.
      if (key === "cart" && triggerCartBadge) {
        triggerCartBadge.textContent = node.textContent;
        triggerCartBadge.hidden = false;
        triggerCartBadge.setAttribute("aria-label", label);
      }
    }

    function loadBadges() {
      fetch("/api/customer/nav-summary", {
        credentials: "same-origin",
        headers: { Accept: "application/json" },
        cache: "no-store",
      })
        .then(function (res) {
          return res.ok ? res.json() : null;
        })
        .then(function (data) {
          if (!data) return;
          setBadge("cart", data.cart);
          setBadge("bookings", data.bookings);
          setBadge("orders", data.orders);
          setBadge("aftercare", data.aftercare);
        })
        .catch(function () {
          /* The menu stays fully usable when the counts cannot be loaded. */
        });
    }

    /* ── Account dropdown ─────────────────────────────────────────────── */

    function isMenuOpen() {
      return Boolean(userMenu && !userMenu.hidden);
    }

    function setMenuOpen(open) {
      if (!userBtn || !userMenu) return;
      userMenu.hidden = !open;
      userBtn.setAttribute("aria-expanded", open ? "true" : "false");
    }

    /* ── Responsive account drawer ───────────────────────────────────── */

    function showBackdrop(show) {
      if (!backdrop) return;
      if (show) {
        backdrop.hidden = false;
        requestAnimationFrame(function () {
          backdrop.classList.add("is-visible");
        });
      } else {
        backdrop.classList.remove("is-visible");
        window.setTimeout(function () {
          if (!backdrop.classList.contains("is-visible")) backdrop.hidden = true;
        }, 220);
      }
    }

    function openDrawer() {
      lastFocused = document.activeElement;
      sidebar.classList.add("is-open");
      sidebar.removeAttribute("inert");
      sidebar.setAttribute("aria-hidden", "false");
      // Force a reflow so the transition runs from the hidden state.
      void sidebar.offsetWidth;
      sidebar.classList.add("open");
      if (menuTrigger) menuTrigger.setAttribute("aria-expanded", "true");
      showBackdrop(true);
      document.body.style.overflow = "hidden";

      var firstLink = sidebar.querySelector(".racs-sidebar-link");
      if (firstLink) firstLink.focus();
    }

    function closeDrawer() {
      setMenuOpen(false);
      sidebar.classList.remove("open");
      sidebar.setAttribute("aria-hidden", "true");
      sidebar.setAttribute("inert", "");
      if (menuTrigger) menuTrigger.setAttribute("aria-expanded", "false");
      showBackdrop(false);
      document.body.style.overflow = "";

      window.setTimeout(function () {
        if (!sidebar.classList.contains("open")) sidebar.classList.remove("is-open");
      }, 260);

      var returnTo = menuTrigger || lastFocused;
      if (returnTo && typeof returnTo.focus === "function") returnTo.focus();
    }

    function drawerIsOpen() {
      return sidebar.classList.contains("open");
    }

    if (menuTrigger) {
      menuTrigger.setAttribute("aria-expanded", "false");
      menuTrigger.setAttribute("aria-controls", "authSidebar");
      menuTrigger.addEventListener("click", function () {
        if (drawerIsOpen()) closeDrawer();
        else openDrawer();
      });
    }
    if (closeBtn) closeBtn.addEventListener("click", closeDrawer);
    if (backdrop) backdrop.addEventListener("click", closeDrawer);

    document.addEventListener("keydown", function (event) {
      if (!drawerIsOpen()) return;
      if (event.key === "Escape") {
        if (isMenuOpen()) {
          setMenuOpen(false);
          if (userBtn) userBtn.focus();
          return;
        }
        closeDrawer();
        return;
      }
      if (event.key !== "Tab") return;
      var focusable = Array.prototype.slice.call(sidebar.querySelectorAll(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )).filter(function (node) { return node.offsetParent !== null; });
      if (!focusable.length) return;
      var first = focusable[0];
      var last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    });

    /* ── Viewport mode ────────────────────────────────────────────────── */

    // Changing viewport mode always leaves the drawer closed. The same navbar
    // control reopens it with the correct responsive width.
    function applyMode() {
      setMenuOpen(false);
      document.body.style.overflow = "";
      sidebar.classList.remove("open", "is-open");
      sidebar.setAttribute("aria-hidden", "true");
      sidebar.setAttribute("inert", "");
      if (menuTrigger) menuTrigger.setAttribute("aria-expanded", "false");
      hideBackdrop();
    }

    function hideBackdrop() {
      if (!backdrop) return;
      backdrop.classList.remove("is-visible");
      backdrop.hidden = true;
    }

    if (typeof DESKTOP_QUERY.addEventListener === "function") {
      DESKTOP_QUERY.addEventListener("change", applyMode);
    } else if (typeof DESKTOP_QUERY.addListener === "function") {
      DESKTOP_QUERY.addListener(applyMode);
    }

    /* ── Active page ──────────────────────────────────────────────────── */

    sidebar.querySelectorAll(".racs-sidebar-link").forEach(function (link) {
      var href;
      try {
        href = new URL(link.href, window.location.origin).pathname.replace(/\/+$/, "") || "/";
      } catch (e) {
        return;
      }
      if (href !== (window.location.pathname.replace(/\/+$/, "") || "/")) return;
      link.classList.add("active");
      link.setAttribute("aria-current", "page");
    });

    /* ── Wiring ───────────────────────────────────────────────────────── */

    // Close after choosing a destination at every size so the drawer never
    // remains over the page while navigation starts.
    sidebar.querySelectorAll(".racs-sidebar-link").forEach(function (link) {
      link.addEventListener("click", function () {
        closeDrawer();
      });
    });

    if (userBtn && userMenu) {
      userBtn.addEventListener("click", function (event) {
        event.stopPropagation();
        setMenuOpen(!isMenuOpen());
      });

      userMenu.addEventListener("click", function (event) {
        // A menu entry that navigates should not leave the menu hanging open.
        if (event.target.closest("a[href]")) setMenuOpen(false);
      });

      document.addEventListener("click", function (event) {
        if (!isMenuOpen()) return;
        if (userWrap && !userWrap.contains(event.target)) setMenuOpen(false);
      });
    }

    if (logoutBtn) {
      logoutBtn.addEventListener("click", function () {
        logoutBtn.disabled = true;
        window.dispatchEvent(new Event("racs:logout"));
        fetch("/api/auth/logout", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
        })
          .then(function () {
            window.location.replace("/login");
          })
          .catch(function () {
            window.location.replace("/login");
          });
      });
    }

    // Bootstrap's dropdown/collapse handlers must not fight the panel.
    sidebar.addEventListener("click", function (event) {
      if (event.target.closest("[data-bs-toggle]")) event.preventDefault();
    });

    applyMode();
    loadBadges();

    // Re-read counts when the customer returns to the tab, so badges stay fresh.
    document.addEventListener("visibilitychange", function () {
      if (!document.hidden) loadBadges();
    });
  }
})();
