/**
 * CALIDRO RACS — customer sidebar controller.
 *
 * Two modes, chosen by viewport:
 *
 *   Desktop (>=992px) — a 60px icon rail floats at the right edge. The arrow
 *   expands it without resizing or offsetting page content.
 *
 *   Mobile (<992px) — the same markup is a slide-out drawer opened from the
 *   navbar menu button.
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
    var COLLAPSE_KEY = "racsSidebarCollapsed";
    var DESKTOP_QUERY = window.matchMedia("(min-width: 992px)");

    var sidebar = document.getElementById("authSidebar");
    if (!sidebar) return;

    var menuTrigger = document.getElementById("racsMenuTrigger");
    var triggerCartBadge = document.getElementById("racsTriggerCartBadge");
    var closeBtn = document.getElementById("closeSidebar");
    var backdrop = document.getElementById("authSidebarBackdrop");
    var collapseBtn = document.getElementById("racsSidebarCollapse");
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

    /* ── Docked (desktop) state ───────────────────────────────────────── */

    // The rail is always collapsed by default: the customer clicks the arrow to
    // view the labels. Only an explicit "0" (an expand the customer chose)
    // overrides that, so a first-time visitor sees the icons-only rail.
    var collapsedPref = readStoredCollapsed();

    function readStoredCollapsed() {
      try {
        return window.localStorage.getItem(COLLAPSE_KEY) !== "0";
      } catch (e) {
        return true;
      }
    }

    function isCollapsed() {
      return sidebar.classList.contains("is-collapsed");
    }

    function applyCollapsed(collapsed) {
      collapsedPref = collapsed;
      sidebar.classList.toggle("is-collapsed", collapsed);
      if (collapseBtn) {
        collapseBtn.setAttribute("aria-label", collapsed ? "Expand menu" : "Collapse menu");
        collapseBtn.setAttribute("data-tip", collapsed ? "Expand menu" : "Collapse menu");
        collapseBtn.setAttribute("aria-expanded", collapsed ? "false" : "true");
      }
      if (!collapsed) hideTip();
    }

    function writeCollapsed(collapsed) {
      applyCollapsed(collapsed);
      try {
        window.localStorage.setItem(COLLAPSE_KEY, collapsed ? "1" : "0");
      } catch (e) {
        /* Storage can be unavailable in private modes; the rail still works. */
      }
    }

    if (collapseBtn) {
      collapseBtn.hidden = false;
      collapseBtn.addEventListener("click", function () {
        writeCollapsed(!collapsedPref);
      });
    }

    /* ── Drawer (mobile) ──────────────────────────────────────────────── */

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
      hideTip();
      sidebar.classList.remove("open");
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
      return sidebar.classList.contains("is-open");
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
      if (event.key !== "Escape" || !drawerIsOpen()) return;
      if (isMenuOpen()) {
        setMenuOpen(false);
        if (userBtn) userBtn.focus();
        return;
      }
      closeDrawer();
    });

    /* ── Viewport mode ────────────────────────────────────────────────── */

    // Desktop: dock the rail permanently. Mobile: hide it and let the navbar
    // button drive the drawer.
    function applyMode() {
      setMenuOpen(false);
      hideTip();

      if (DESKTOP_QUERY.matches) {
        // Docked rail: never an overlay, never locks page scroll, so the fixed
        // navbar stays visible and clickable.
        document.body.style.overflow = "";
        hideBackdrop();
        sidebar.classList.remove("is-open", "open");
        applyCollapsed(collapsedPref);
        return;
      }

      document.body.style.overflow = "";
      sidebar.classList.remove("is-collapsed", "open", "is-open");
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

    /* ── Collapsed tooltips ───────────────────────────────────────────── */

    // The rail scrolls, so an in-flow tooltip would be clipped. One shared
    // fixed element is positioned against the trigger's bounding box.
    var tip = document.createElement("div");
    tip.className = "racs-sidebar-tip";
    tip.setAttribute("role", "tooltip");
    tip.hidden = true;
    document.body.appendChild(tip);

    function showTip(trigger) {
      var text = trigger.getAttribute("data-tip");
      if (!text || !DESKTOP_QUERY.matches || !isCollapsed()) return hideTip();

      tip.textContent = text;
      tip.hidden = false;

      var box = trigger.getBoundingClientRect();
      var width = tip.offsetWidth;
      var height = tip.offsetHeight;
      var left = box.right + 10;
      var top = box.top + box.height / 2 - height / 2;

      // Keep the tooltip on screen on narrow desktop windows.
      if (left + width > window.innerWidth - 8) left = box.left - width - 10;
      if (left < 8) left = 8;
      top = Math.max(8, Math.min(top, window.innerHeight - height - 8));

      tip.style.left = Math.round(left) + "px";
      tip.style.top = Math.round(top) + "px";
    }

    function hideTip() {
      tip.hidden = true;
    }

    sidebar.querySelectorAll("[data-tip]").forEach(function (trigger) {
      trigger.addEventListener("mouseenter", function () {
        showTip(trigger);
      });
      trigger.addEventListener("mouseleave", hideTip);
      trigger.addEventListener("focus", function () {
        showTip(trigger);
      });
      trigger.addEventListener("blur", hideTip);
    });

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

    // Mobile drawer: close right after the customer picks a destination so they
    // are not left with a menu covering the page they just opened. On desktop
    // the rail stays put and the new page simply re-marks the active item.
    sidebar.querySelectorAll(".racs-sidebar-link").forEach(function (link) {
      link.addEventListener("click", function () {
        if (!DESKTOP_QUERY.matches) closeDrawer();
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
