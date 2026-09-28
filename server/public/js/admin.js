document.addEventListener("DOMContentLoaded", function () {
  // Keep modal interactions responsive even when their contents come from an API.
  // Pages can open the shell immediately, then settle/fail the loading state once
  // their request completes. Reusing Bootstrap instances also avoids accumulating
  // duplicate focus and backdrop handlers on frequently opened admin modals.
  window.AdminModalUX = (function () {
    function resolveModal(target) {
      if (typeof target === "string") return document.querySelector(target);
      return target || null;
    }

    function getInstance(target, options) {
      var modal = resolveModal(target);
      if (!modal || !window.bootstrap || !bootstrap.Modal) return null;
      return bootstrap.Modal.getOrCreateInstance(modal, options || {});
    }

    function clearState(target) {
      var modal = resolveModal(target);
      if (!modal) return;
      modal.classList.remove("admin-modal-loading");
      modal.removeAttribute("aria-busy");
      modal.querySelectorAll(".admin-modal-loading-state").forEach(function (state) {
        state.remove();
      });
      modal.querySelectorAll(".admin-modal-loading-host").forEach(function (host) {
        host.classList.remove("admin-modal-loading-host");
      });
    }

    function addState(target, message, failed) {
      var modal = resolveModal(target);
      if (!modal) return;
      clearState(modal);
      var host = modal.querySelector(".modal-body") || modal.querySelector(".modal-content");
      if (!host) return;

      modal.classList.add("admin-modal-loading");
      modal.setAttribute("aria-busy", failed ? "false" : "true");
      host.classList.add("admin-modal-loading-host");

      var state = document.createElement("div");
      state.className = "admin-modal-loading-state" + (failed ? " is-error" : "");
      state.setAttribute("role", failed ? "alert" : "status");
      state.setAttribute("aria-live", "polite");

      var icon = document.createElement("i");
      icon.className = failed
        ? "bi bi-exclamation-circle-fill admin-modal-state-icon"
        : "spinner-border spinner-border-sm admin-modal-state-spinner";
      icon.setAttribute("aria-hidden", "true");

      var label = document.createElement("span");
      label.textContent = message || (failed ? "Unable to load this information." : "Loading details…");
      state.appendChild(icon);
      state.appendChild(label);

      if (failed) {
        var close = document.createElement("button");
        close.type = "button";
        close.className = "btn btn-sm btn-outline-secondary mt-2";
        close.setAttribute("data-bs-dismiss", "modal");
        close.textContent = "Close";
        state.appendChild(close);
      }
      host.appendChild(state);
    }

    function open(target, options) {
      var modal = resolveModal(target);
      var settings = options || {};
      if (!modal) return null;
      if (settings.loadingMessage) addState(modal, settings.loadingMessage, false);
      var instance = getInstance(modal, settings.bootstrapOptions);
      if (instance) instance.show();
      return instance;
    }

    function fail(target, message) {
      addState(target, message || "Unable to load this information. Please try again.", true);
    }

    return { getInstance: getInstance, open: open, settle: clearState, fail: fail };
  })();

  // if AOS is included on the page, init/refresh so animations will run on admin views
  if (window.AOS && typeof AOS.init === "function") {
    AOS.init({
      duration: 800,
      easing: "ease-in-out",
      once: true,
      disable: function () {
        return document.documentElement.classList.contains("perf-lite") ||
          window.matchMedia("(max-width: 767px)").matches;
      },
    });
    if (typeof AOS.refresh === "function") AOS.refresh();
  }

  // Bootstrap is optional in the admin shell. Keep report tabs functional when
  // the vendor bundle is unavailable, while preserving Bootstrap's lifecycle
  // events so charts and other page-specific listeners continue to resize.
  function dispatchAdminTabEvent(element, eventName, relatedTarget) {
    if (!element) return true;
    var event = new CustomEvent(eventName, {
      bubbles: true,
      cancelable: true,
      detail: { relatedTarget: relatedTarget || null },
    });
    Object.defineProperty(event, "relatedTarget", {
      configurable: true,
      value: relatedTarget || null,
    });
    element.dispatchEvent(event);
    return !event.defaultPrevented;
  }

  function adminTabTarget(trigger) {
    var selector = trigger && (
      trigger.getAttribute("data-bs-target") || trigger.getAttribute("href")
    );
    if (!selector || selector.charAt(0) !== "#") return null;
    try { return document.querySelector(selector); } catch (error) { return null; }
  }

  var adminTabSelector = '[data-bs-toggle="tab"], [data-bs-toggle="pill"]';

  function showAdminTab(trigger, options) {
    var target = adminTabTarget(trigger);
    var tablist = trigger && trigger.closest('[role="tablist"]');
    if (!trigger || !target || !tablist) return false;

    var currentTrigger = Array.from(tablist.querySelectorAll(adminTabSelector))
      .find(function (tab) { return tab.classList.contains("active"); }) || null;
    var currentTarget = adminTabTarget(currentTrigger);
    if (currentTrigger === trigger && target.classList.contains("active")) return true;
    if (!dispatchAdminTabEvent(currentTrigger, "hide.bs.tab", trigger)) return false;
    if (!dispatchAdminTabEvent(trigger, "show.bs.tab", currentTrigger)) return false;

    tablist.querySelectorAll(adminTabSelector).forEach(function (tab) {
      var selected = tab === trigger;
      tab.classList.toggle("active", selected);
      tab.setAttribute("aria-selected", selected ? "true" : "false");
      tab.setAttribute("tabindex", selected ? "0" : "-1");
      var pane = adminTabTarget(tab);
      if (pane) {
        pane.classList.toggle("active", selected);
        pane.classList.toggle("show", selected);
        pane.hidden = !selected;
      }
    });

    dispatchAdminTabEvent(currentTrigger, "hidden.bs.tab", trigger);
    dispatchAdminTabEvent(trigger, "shown.bs.tab", currentTrigger);
    if (options && options.focus) trigger.focus({ preventScroll: true });
    return true;
  }

  var adminTabTriggers = Array.from(document.querySelectorAll(adminTabSelector));
  adminTabTriggers.forEach(function (trigger) {
    var pane = adminTabTarget(trigger);
    var selected = trigger.classList.contains("active") || trigger.getAttribute("aria-selected") === "true";
    trigger.setAttribute("tabindex", selected ? "0" : "-1");
    if (pane && !(window.bootstrap && bootstrap.Tab)) pane.hidden = !selected;

    trigger.addEventListener("click", function (event) {
      if (window.bootstrap && bootstrap.Tab) return;
      event.preventDefault();
      event.stopPropagation();
      showAdminTab(trigger);
    });

    trigger.addEventListener("keydown", function (event) {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      var tablist = trigger.closest('[role="tablist"]');
      var tabs = tablist ? Array.from(tablist.querySelectorAll(adminTabSelector)) : [];
      if (!tabs.length) return;
      event.preventDefault();
      var index = tabs.indexOf(trigger);
      var nextIndex = event.key === "Home" ? 0
        : event.key === "End" ? tabs.length - 1
        : event.key === "ArrowRight" ? (index + 1) % tabs.length
        : (index - 1 + tabs.length) % tabs.length;
      var next = tabs[nextIndex];
      if (window.bootstrap && bootstrap.Tab) {
        bootstrap.Tab.getOrCreateInstance(next).show();
        next.focus({ preventScroll: true });
      } else {
        showAdminTab(next, { focus: true });
      }
    });
  });

  document.querySelectorAll("[data-open-tab]").forEach(function (link) {
    link.addEventListener("click", function (event) {
      if (window.bootstrap && bootstrap.Tab) return;
      var trigger = document.getElementById(link.getAttribute("data-open-tab"));
      if (!trigger) return;
      event.preventDefault();
      showAdminTab(trigger, { focus: true });
    });
  });

  window.AdminTabs = { show: showAdminTab };

  // Keep navigation dropdowns usable even if the Bootstrap CDN is temporarily
  // unavailable. This is deliberately inactive when Bootstrap loaded normally.
  var adminDropdownSelector = '[data-bs-toggle="dropdown"]';

  function adminDropdownMenu(trigger) {
    var container = trigger && trigger.closest('.dropdown');
    return container ? container.querySelector('.dropdown-menu') : null;
  }

  function setAdminDropdown(trigger, open, options) {
    var menu = adminDropdownMenu(trigger);
    if (!trigger || !menu) return false;
    trigger.classList.toggle('show', open);
    trigger.setAttribute('aria-expanded', open ? 'true' : 'false');
    menu.classList.toggle('show', open);
    if (!open && options && options.restoreFocus) trigger.focus({ preventScroll: true });
    return true;
  }

  function closeAdminDropdowns(except) {
    document.querySelectorAll(adminDropdownSelector).forEach(function (trigger) {
      if (trigger !== except) setAdminDropdown(trigger, false);
    });
  }

  var adminDropdownTriggers = Array.from(document.querySelectorAll(adminDropdownSelector));
  adminDropdownTriggers.forEach(function (trigger) {
    trigger.addEventListener('click', function (event) {
      if (window.bootstrap && bootstrap.Dropdown) return;
      event.preventDefault();
      event.stopPropagation();
      var menu = adminDropdownMenu(trigger);
      var shouldOpen = !(menu && menu.classList.contains('show'));
      closeAdminDropdowns(trigger);
      setAdminDropdown(trigger, shouldOpen);
    });

    trigger.addEventListener('keydown', function (event) {
      if (window.bootstrap && bootstrap.Dropdown) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        setAdminDropdown(trigger, false, { restoreFocus: true });
        return;
      }
      if (event.key !== 'ArrowDown') return;
      event.preventDefault();
      closeAdminDropdowns(trigger);
      setAdminDropdown(trigger, true);
      var menu = adminDropdownMenu(trigger);
      var firstItem = menu && menu.querySelector('a:not([aria-disabled="true"]), button:not([disabled])');
      if (firstItem) firstItem.focus({ preventScroll: true });
    });
  });

  document.addEventListener('click', function (event) {
    if (window.bootstrap && bootstrap.Dropdown) return;
    if (!event.target.closest('.dropdown')) closeAdminDropdowns();
  });

  document.addEventListener('keydown', function (event) {
    if (window.bootstrap && bootstrap.Dropdown) return;
    if (event.key !== 'Escape') return;
    var openTrigger = adminDropdownTriggers.find(function (trigger) {
      var menu = adminDropdownMenu(trigger);
      return menu && menu.classList.contains('show');
    });
    if (openTrigger) setAdminDropdown(openTrigger, false, { restoreFocus: true });
  });

  window.AdminDropdowns = { closeAll: closeAdminDropdowns, setOpen: setAdminDropdown };

  var toggle = document.getElementById("sidebarToggle");
  var sidebar = document.getElementById("adminSidebar");
  var root = document.querySelector(".admin-root");
  var lastSidebarFocus = null;

  function setToggleAria(expanded) {
    if (toggle)
      toggle.setAttribute("aria-expanded", expanded ? "true" : "false");
  }

  // swap hamburger ↔ close-arrow icon on mobile toggle button
  function setMobileToggleIcon(open) {
    if (!toggle) return;
    var icon = toggle.querySelector("i");
    if (!icon) return;
    icon.classList.remove("bi-list", "bi-x-lg", "bi-arrow-left");
    icon.classList.add(open ? "bi-x-lg" : "bi-list");
    toggle.setAttribute("aria-label", open ? "Close navigation menu" : "Open navigation menu");
  }

  function isMobileSidebar() {
    return window.matchMedia("(max-width: 767px)").matches;
  }

  function setMobileSidebarOpen(open, options) {
    if (!sidebar || !toggle) return;
    options = options || {};

    if (open) {
      lastSidebarFocus = document.activeElement;
      if (window.AdminDropdowns) window.AdminDropdowns.closeAll();
      sidebar.classList.add("open");
      sidebar.removeAttribute("inert");
      sidebar.setAttribute("role", "dialog");
      sidebar.setAttribute("aria-modal", "true");
      sidebar.setAttribute("aria-hidden", "false");
      document.body.classList.add("admin-nav-open");
      showBackdrop();
      window.setTimeout(function () {
        var firstControl = sidebar.querySelector("[data-admin-sidebar-close], a[href], button:not([disabled])");
        if (firstControl) firstControl.focus({ preventScroll: true });
      }, 30);
    } else {
      sidebar.classList.remove("open");
      sidebar.setAttribute("aria-hidden", "true");
      sidebar.setAttribute("inert", "");
      sidebar.removeAttribute("aria-modal");
      document.body.classList.remove("admin-nav-open");
      hideBackdrop();
      if (options.restoreFocus !== false) {
        var returnTarget = toggle || lastSidebarFocus;
        if (returnTarget && typeof returnTarget.focus === "function") {
          returnTarget.focus({ preventScroll: true });
        }
      }
    }

    setToggleAria(open);
    setMobileToggleIcon(open);
  }

  function applyMobileSidebarMode() {
    if (!sidebar || !toggle) return;
    if (isMobileSidebar()) {
      var open = sidebar.classList.contains("open");
      sidebar.setAttribute("role", "dialog");
      sidebar.setAttribute("aria-modal", open ? "true" : "false");
      sidebar.setAttribute("aria-hidden", open ? "false" : "true");
      if (open) sidebar.removeAttribute("inert");
      else sidebar.setAttribute("inert", "");
      setToggleAria(open);
      setMobileToggleIcon(open);
      return;
    }

    sidebar.classList.remove("open");
    sidebar.removeAttribute("role");
    sidebar.removeAttribute("aria-modal");
    sidebar.removeAttribute("aria-hidden");
    sidebar.removeAttribute("inert");
    document.body.classList.remove("admin-nav-open");
    hideBackdrop();
    setToggleAria(!(root && root.classList.contains("sidebar-collapsed")));
    setMobileToggleIcon(false);
  }

  // helper to animate nav items when sidebar opens/closes
  function animateSidebarLinks(sidebarEl, opening) {
    if (!window.gsap) return;
    var items = sidebarEl.querySelectorAll(".nav-item");
    if (opening) {
      gsap.fromTo(
        items,
        { x: -8, autoAlpha: 0 },
        {
          x: 0,
          autoAlpha: 1,
          stagger: 0.02,
          duration: 0.25,
          ease: "power2.out",
        },
      );
    } else {
      gsap.to(items, {
        x: -8,
        autoAlpha: 0,
        stagger: 0.01,
        duration: 0.15,
        ease: "power1.in",
      });
    }
  }

  if (toggle && sidebar) {
    toggle.addEventListener("click", function () {
      if (isMobileSidebar()) {
        setMobileSidebarOpen(!sidebar.classList.contains("open"));
        return;
      }

      // desktop: collapse the sidebar (give more canvas)
      if (root) {
        var collapsed = root.classList.toggle("sidebar-collapsed");
        setToggleAria(!collapsed);
        // show links when expanding
        animateSidebarLinks(sidebar, !collapsed);
        adjustAdminOffsets();
      } else {
        sidebar.classList.toggle("open");
        setToggleAria(sidebar.classList.contains("open"));
      }
    });

    applyMobileSidebarMode();
    window.addEventListener("resize", applyMobileSidebarMode);
  }

  // sidebar section dropdowns — wire Bootstrap collapse toggles to a parent-expanded state and add keyboard support
  // The topbar control sits behind the open drawer on small screens. Keep an
  // obvious close action inside the drawer and support the Escape key.
  var sidebarMobileClose = document.querySelector("[data-admin-sidebar-close]");
  if (sidebarMobileClose && toggle && sidebar) {
    sidebarMobileClose.addEventListener("click", function () {
      if (isMobileSidebar() && sidebar.classList.contains("open")) setMobileSidebarOpen(false);
    });
  }

  document.addEventListener("keydown", function (event) {
    if (
      event.key === "Escape" &&
      isMobileSidebar() &&
      toggle &&
      sidebar &&
      sidebar.classList.contains("open")
    ) {
      setMobileSidebarOpen(false);
    }
  });

  document.addEventListener("keydown", function (event) {
    if (event.key !== "Tab" || !isMobileSidebar() || !sidebar || !sidebar.classList.contains("open")) return;
    var focusable = Array.prototype.slice.call(sidebar.querySelectorAll(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )).filter(function (element) {
      return element.offsetParent !== null && !element.hasAttribute("inert");
    });
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

  function dispatchSidebarCollapseEvent(target, eventName) {
    var event = new CustomEvent(eventName, {
      bubbles: true,
      cancelable: true,
    });
    target.dispatchEvent(event);
    return !event.defaultPrevented;
  }

  function setSidebarCollapseState(btn, target, expanded) {
    var parentItem = btn.closest(".nav-group") || btn.closest(".nav-item");
    target.classList.remove("collapsing");
    target.classList.toggle("show", expanded);
    target.style.removeProperty("height");
    btn.classList.toggle("collapsed", !expanded);
    btn.setAttribute("aria-expanded", expanded ? "true" : "false");
    if (parentItem) parentItem.classList.toggle("expanded", expanded);
    updateSidebarScrollState();
  }

  function toggleSidebarCollapseWithoutBootstrap(btn, target) {
    var expanded = target.classList.contains("show");
    var beforeEvent = expanded ? "hide.bs.collapse" : "show.bs.collapse";
    var afterEvent = expanded ? "hidden.bs.collapse" : "shown.bs.collapse";

    if (!dispatchSidebarCollapseEvent(target, beforeEvent)) return;
    setSidebarCollapseState(btn, target, !expanded);
    dispatchSidebarCollapseEvent(target, afterEvent);
  }

  document
    .querySelectorAll('.btn-toggle[data-bs-toggle="collapse"]')
    .forEach(function (btn) {
      var targetSel =
        btn.getAttribute("data-bs-target") || btn.getAttribute("data-target");
      var parentItem = btn.closest(".nav-group") || btn.closest(".nav-item");
      var target = targetSel ? document.querySelector(targetSel) : null;

      // sync expanded class on parent when Bootstrap collapse shows/hides
      if (target) {
        target.addEventListener("show.bs.collapse", function () {
          if (parentItem) parentItem.classList.add("expanded");
          btn.classList.remove("collapsed");
          btn.setAttribute("aria-expanded", "true");
          updateSidebarScrollState();
          if (window.gsap) {
            gsap.fromTo(
              target,
              { height: target.scrollHeight * 0.55, autoAlpha: 0.35, x: -16 },
              {
                height: target.scrollHeight,
                autoAlpha: 1,
                x: 0,
                duration: 0.35,
                ease: "power2.out",
                clearProps: "height",
              },
            );
            gsap.fromTo(
              target.querySelectorAll("li"),
              { x: -14, autoAlpha: 0 },
              {
                x: 0,
                autoAlpha: 1,
                stagger: 0.04,
                duration: 0.3,
                ease: "power3.out",
              },
            );
          }
        });
        target.addEventListener("hide.bs.collapse", function () {
          if (parentItem) parentItem.classList.remove("expanded");
          btn.classList.add("collapsed");
          btn.setAttribute("aria-expanded", "false");
          updateSidebarScrollState();
          if (window.gsap) {
            gsap.to(target.querySelectorAll("li"), {
              x: -10,
              autoAlpha: 0,
              stagger: {
                each: 0.035,
                from: "end",
              },
              duration: 0.2,
              ease: "power1.in",
            });
          }
        });

        // Admin and secretary pages should remain usable if the optional
        // Bootstrap bundle is unavailable. The current local vendor file can
        // be absent or replaced in deployments, so keep the navigation's
        // essential disclosure behavior independent from that dependency.
        btn.addEventListener("click", function (event) {
          if (window.bootstrap && bootstrap.Collapse) return;
          event.preventDefault();
          event.stopPropagation();
          toggleSidebarCollapseWithoutBootstrap(btn, target);
        });

        // Normalize server-rendered state before the first interaction.
        setSidebarCollapseState(btn, target, target.classList.contains("show"));
      }

      // keyboard support (Enter / Space)
      btn.addEventListener("keydown", function (ev) {
        if (ev.key === "Enter" || ev.key === " ") {
          ev.preventDefault();
          btn.click();
        }
      });
    });

  // mobile sidebar backdrop + outside-click to close
  var sidebarBackdrop = document.getElementById("adminSidebarBackdrop");
  function showBackdrop() {
    if (!sidebarBackdrop) {
      sidebarBackdrop = document.createElement("button");
      sidebarBackdrop.type = "button";
      sidebarBackdrop.id = "adminSidebarBackdrop";
      sidebarBackdrop.className = "sidebar-backdrop admin-sidebar-backdrop";
      sidebarBackdrop.setAttribute("aria-label", "Close navigation menu");
      document.body.appendChild(sidebarBackdrop);
      sidebarBackdrop.addEventListener("click", function () {
        setMobileSidebarOpen(false);
      });
    }
    sidebarBackdrop.hidden = false;
    requestAnimationFrame(function () {
      sidebarBackdrop.classList.add("visible");
    });
  }
  function hideBackdrop() {
    if (!sidebarBackdrop) return;
    sidebarBackdrop.classList.remove("visible");
    setTimeout(function () {
      if (sidebarBackdrop && !sidebarBackdrop.classList.contains("visible")) sidebarBackdrop.hidden = true;
    }, 220);
  }

  if (sidebarBackdrop) {
    sidebarBackdrop.addEventListener("click", function () {
      if (sidebar && sidebar.classList.contains("open")) setMobileSidebarOpen(false);
    });
  }

  // ensure backdrop removed on resize > mobile
  window.addEventListener("resize", function () {
    if (!isMobileSidebar()) hideBackdrop();
  });

  // Simple logout hookup
  var logoutBtn = document.getElementById("logoutBtn");
  if (logoutBtn) {
    logoutBtn.addEventListener("click", function (e) {
      e.preventDefault();
      fetch("/api/auth/secure/logout", {
        method: "POST",
        credentials: "same-origin",
      })
        .then(function () {
          window.location = "/login";
        })
        .catch(function () {
          window.location = "/login";
        });
    });
  }

  /* ensure fixed navbar & sidebar offsets */
  function adjustAdminOffsets() {
    var nav = document.getElementById('adminNavbar');
    if (!nav) return;
    var h = nav.offsetHeight || parseInt(getComputedStyle(nav).height) || 56;
    document.body.style.setProperty('--admin-topbar-height', h + 'px');
    var content = document.querySelector('.admin-content');
    if (content) content.style.paddingTop = h + 'px';
    
    // Sidebar should be full height now
    var adminSide = document.querySelector('.admin-sidebar');
    if (adminSide) {
      adminSide.style.top = '0px';
      adminSide.style.height = '100vh';
    }
    
    updateSidebarScrollState();
  }
  adjustAdminOffsets();

  // The navbar height does not change while the page scrolls. The old scroll
  // listener synchronously read and wrote layout on every swipe frame, causing
  // severe reflow/jank on mobile. Recalculate only when layout can change and
  // coalesce resize bursts into one animation frame.
  var offsetFrame = null;
  function scheduleAdminOffsetUpdate() {
    if (offsetFrame !== null) return;
    offsetFrame = requestAnimationFrame(function () {
      offsetFrame = null;
      adjustAdminOffsets();
    });
  }
  window.addEventListener('resize', scheduleAdminOffsetUpdate, { passive: true });

  var observedNavbar = document.getElementById('adminNavbar');
  if (observedNavbar && 'ResizeObserver' in window) {
    var navbarResizeObserver = new ResizeObserver(scheduleAdminOffsetUpdate);
    navbarResizeObserver.observe(observedNavbar);
  }

  function updateSidebarScrollState() {
    if (!sidebar) return;
    var inner = sidebar.querySelector('.sidebar');
    var contentHeight = inner ? inner.scrollHeight : sidebar.scrollHeight;
    var available = sidebar.clientHeight;
    if (contentHeight > available + 2) {
      sidebar.classList.add('scrollable');
    } else {
      sidebar.classList.remove('scrollable');
    }
  }
  updateSidebarScrollState();
  window.addEventListener('resize', updateSidebarScrollState);

  // content fade transitions on navigation (modern feel)
  function setupPageTransitions() {
    var content = document.querySelector(".admin-content");
    if (!content) return;
    // fade in on load
    if (window.gsap) {
      gsap.fromTo(
        content,
        { autoAlpha: 0 },
        { autoAlpha: 1, duration: 0.5, ease: "expo.out" },
      );
    }
    // intercept sidebar link clicks
    document
      .querySelectorAll(".sidebar-nav a.nav-link")
      .forEach(function (link) {
        link.addEventListener("click", function (e) {
          var href = link.getAttribute("href");
          if (!href || href === "#" || href.startsWith("javascript:")) return;
          // same-origin check
          var loc = new URL(href, location.origin);
          if (loc.origin !== location.origin) return;
          e.preventDefault();
          if (isMobileSidebar() && sidebar && sidebar.classList.contains("open")) {
            setMobileSidebarOpen(false, { restoreFocus: false });
          }
          if (window.gsap) {
            gsap.to(content, {
              autoAlpha: 0,
              duration: 0.4,
              ease: "power1.in",
              onComplete: function () {
                window.location = href;
              },
            });
          } else {
            window.location = href;
          }
        });
      });
  }
  setupPageTransitions();

  // Sidebar right-edge handle: toggles the same behavior as the topbar toggle
  var handle = document.getElementById("sidebarHandle");
  function setHandleState() {
    if (!handle) return;
    var collapsed = root && root.classList.contains("sidebar-collapsed");
    handle.setAttribute("aria-expanded", (!collapsed).toString());
    if (collapsed) handle.classList.add("collapsed");
    else handle.classList.remove("collapsed");
  }
  if (handle) {
    handle.setAttribute("tabindex", "0");
    handle.addEventListener("click", function (e) {
      e.preventDefault();
      // reuse existing topbar toggle if available
      if (toggle) {
        toggle.click();
      } else {
        // fallback: replicate toggle behavior
        if (window.innerWidth <= 767) {
          var isOpen = sidebar.classList.toggle("open");
          if (isOpen) showBackdrop();
          else hideBackdrop();
          setMobileToggleIcon(isOpen);
        } else {
          if (root) root.classList.toggle("sidebar-collapsed");
          else sidebar.classList.toggle("open");
        }
      }
      setHandleState();
      updateSidebarScrollState();
    });
    // keyboard (Enter / Space)
    handle.addEventListener("keydown", function (ev) {
      if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        handle.click();
      }
    });
    // reflect initial state and stay in sync on resize
    setHandleState();
    window.addEventListener("resize", setHandleState);
  }

  // keep wheel scrolling within the sidebar when cursor is inside it
  if (sidebar) {
    const innerSidebar = () => sidebar.querySelector('.sidebar') || sidebar;

    function handleSidebarWheel(ev) {
      if (window.innerWidth <= 767) return;
      if (root && root.classList.contains('sidebar-collapsed')) return;
      const target = innerSidebar();
      if (!target) return;
      const maxScroll = target.scrollHeight - target.clientHeight;
      if (maxScroll <= 0) return;

      const delta = ev.deltaY;
      const next = target.scrollTop + delta;
      const atUpperEdge = target.scrollTop <= 0 && delta < 0;
      const atLowerEdge = target.scrollTop >= maxScroll && delta > 0;

      if (atUpperEdge || atLowerEdge) return; // allow body scroll when capped

      ev.preventDefault();
      target.scrollTop = Math.min(Math.max(next, 0), maxScroll);
    }

    function handleSidebarTouch(ev) {
      if (window.innerWidth <= 767) return;
      if (root && root.classList.contains('sidebar-collapsed')) return;
      if (ev.touches.length !== 1) return;
      const target = innerSidebar();
      if (!target) return;
      const maxScroll = target.scrollHeight - target.clientHeight;
      if (maxScroll <= 0) return;

      const touch = ev.touches[0];
      if (!target._touchStartY) target._touchStartY = touch.clientY;
      const delta = target._touchStartY - touch.clientY;
      const next = target.scrollTop + delta;

      if ((delta < 0 && target.scrollTop <= 0) || (delta > 0 && target.scrollTop >= maxScroll)) {
        target._touchStartY = touch.clientY;
        return;
      }

      ev.preventDefault();
      target.scrollTop = Math.min(Math.max(next, 0), maxScroll);
      target._touchStartY = touch.clientY;
    }

    sidebar.addEventListener('wheel', handleSidebarWheel, { passive: false });
    sidebar.addEventListener('touchstart', function (ev) {
      const target = innerSidebar();
      if (target) target._touchStartY = ev.touches[0].clientY;
    }, { passive: true });
    sidebar.addEventListener('touchmove', handleSidebarTouch, { passive: false });
    updateSidebarScrollState();
  }

  // Placeholder: load notification count (only for admins)
  if (window.USER_ROLE === "admin") {
    try {
      fetch("/api/admin/logs?limit=1", {
        credentials: "same-origin",
        headers: { Accept: "application/json" },
      })
        .then(function (r) {
          return r.json();
        })
        .then(function (d) {
          var c = d && d.logs && d.logs.length ? d.logs.length : 0;
          var el = document.getElementById("notifCount");
          if (el) el.textContent = c;
        })
        .catch(function () {});
    } catch (e) {}
  }
  // --- Sidebar: mark active link and expand parent submenu if needed ---
  try {
    var currentPath = window.location.pathname;
    var sideLinks = document.querySelectorAll(".sidebar-nav .nav-link");
    sideLinks.forEach(function (link) {
      var href = link.getAttribute("href");
      if (!href || href === "#") return; // ignore placeholder links

      // exact match (also treat '/admin' and '/admin/' as equal)
      var normalizedHref = href.replace(/\/$/, "");
      var normalizedPath = currentPath.replace(/\/$/, "");
      if (normalizedHref === normalizedPath) {
        link.classList.add("active");

        // if this link is inside a collapsed submenu, open its parent collapse and mark the toggle
        var parentCollapse = link.closest(".collapse");
        if (parentCollapse) {
          try {
            // The sidebar can already be rendered open by the server. Bootstrap's
            // default `toggle: true` would close it while constructing the instance.
            // Create a non-toggling instance and only request an open transition when
            // the panel is actually closed.
            var bsCollapse = bootstrap.Collapse.getOrCreateInstance(
              parentCollapse,
              { toggle: false },
            );
            if (!parentCollapse.classList.contains("show")) bsCollapse.show();
          } catch (err) {
            parentCollapse.classList.add("show");
          }

          var toggleBtn = document.querySelector(
            '[data-bs-target="#' + parentCollapse.id + '"]',
          );
          if (toggleBtn) toggleBtn.classList.add("active");
          var parentItem = toggleBtn ? toggleBtn.closest(".nav-item") : null;
          if (parentItem) parentItem.classList.add("expanded");
        }

        // ensure parent button (if any) shows active state for top-level matches too
        var topToggle = link.closest(".nav-item")
          ? link.closest(".nav-item").querySelector(".btn-toggle.nav-link")
          : null;
        if (topToggle) topToggle.classList.add("active");
      } else {
        link.classList.remove("active");
      }
    });
  } catch (e) {
    /* ignore */
  }

  // --- sidebar link hover animation (GSAP) ---
  if (window.gsap) {
    document
      .querySelectorAll(".admin-sidebar .nav-link")
      .forEach(function (link) {
        link.addEventListener("mouseenter", function () {
          gsap.to(link, { x: 4, duration: 0.2, ease: "power1.out" });
        });
        link.addEventListener("mouseleave", function () {
          gsap.to(link, { x: 0, duration: 0.2, ease: "power1.in" });
        });
      });
  }

  /* Global notification helpers (toasts, confirm, prompt) — exposed at window.notify */
  window.notify = (function () {
    // ensure container exists
    let container = document.getElementById("globalToastContainer");
    if (!container) {
      container = document.createElement("div");
      container.id = "globalToastContainer";
      container.style.position = "fixed";
      container.style.top = "1rem";
      container.style.right = "1rem";
      container.style.zIndex = 10800;
      document.body.appendChild(container);
    }

    function makeToast(message, type = "info", delay = 4000) {
      const toastEl = document.createElement("div");
      toastEl.className = `toast align-items-center text-bg-${type} border-0 show`;
      toastEl.setAttribute("role", "status");
      toastEl.setAttribute("aria-live", "polite");
      toastEl.innerHTML = `<div class='d-flex'><div class='toast-body'>${message}</div><button type='button' class='btn-close btn-close-white me-2 m-auto' data-bs-dismiss='toast' aria-label='Close'></button></div>`;
      container.appendChild(toastEl);
      const bs = new bootstrap.Toast(toastEl, { autohide: true, delay });
      toastEl.addEventListener("hidden.bs.toast", () => {
        bs.dispose();
        toastEl.remove();
      });
      bs.show();
      return bs;
    }

    function confirm(message, title) {
      return new Promise((resolve) => {
        const modal = document.getElementById("globalConfirmModal");
        if (!modal) {
          resolve(window.confirm(message));
          return;
        }
        modal.querySelector(".modal-body").textContent = message || "";
        const confirmBtn = modal.querySelector(".js-confirm-yes");
        const cancelBtn = modal.querySelector(".js-confirm-no");
        const bsModal = bootstrap.Modal.getOrCreateInstance(modal);
        const onConfirm = () => {
          cleanup();
          resolve(true);
        };
        const onCancel = () => {
          cleanup();
          resolve(false);
        };
        function cleanup() {
          confirmBtn.removeEventListener("click", onConfirm);
          cancelBtn.removeEventListener("click", onCancel);
          bsModal.hide();
        }
        confirmBtn.addEventListener("click", onConfirm);
        cancelBtn.addEventListener("click", onCancel);
        bsModal.show();
      });
    }

    function prompt(message, defaultValue) {
      return new Promise((resolve) => {
        const modal = document.getElementById("globalPromptModal");
        if (!modal) {
          const v = window.prompt(message, defaultValue || "");
          resolve(v);
          return;
        }
        modal.querySelector(".modal-body label").textContent = message || "";
        const input = modal.querySelector(".js-prompt-input");
        input.value = defaultValue || "";
        const okBtn = modal.querySelector(".js-prompt-ok");
        const cancelBtn = modal.querySelector(".js-prompt-cancel");
        const bsModal = bootstrap.Modal.getOrCreateInstance(modal);
        const onOk = () => {
          cleanup();
          resolve(input.value);
        };
        const onCancel = () => {
          cleanup();
          resolve(null);
        };
        function cleanup() {
          okBtn.removeEventListener("click", onOk);
          cancelBtn.removeEventListener("click", onCancel);
          bsModal.hide();
        }
        okBtn.addEventListener("click", onOk);
        cancelBtn.addEventListener("click", onCancel);
        bsModal.show();
        setTimeout(() => input.focus(), 200);
      });
    }

    return {
      toast: (m, t, o) => makeToast(m, t, o && o.delay ? o.delay : 4000),
      success: (m, o) => makeToast(m, "success", o && o.delay ? o.delay : 3500),
      error: (m, o) => makeToast(m, "danger", o && o.delay ? o.delay : 5000),
      info: (m, o) => makeToast(m, "info", o && o.delay ? o.delay : 4000),
      warn: (m, o) => makeToast(m, "warning", o && o.delay ? o.delay : 4500),
      confirm,
      prompt,
    };
  })();
});
