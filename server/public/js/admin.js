document.addEventListener("DOMContentLoaded", function () {
  // if AOS is included on the page, init/refresh so animations will run on admin views
  if (window.AOS && typeof AOS.init === "function") {
    AOS.init({ duration: 800, easing: "ease-in-out", once: true });
    if (typeof AOS.refresh === "function") AOS.refresh();
  }

  var toggle = document.getElementById("sidebarToggle");
  var sidebar = document.getElementById("adminSidebar");
  var root = document.querySelector(".admin-root");

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
      // mobile behavior: slide-in + backdrop
      if (window.innerWidth <= 767) {
        var isOpen = sidebar.classList.contains("open");
        if (window.gsap) {
          // temporarily disable CSS transitions to avoid conflicts
          const prevTrans = sidebar.style.transition;
          sidebar.style.transition = "none";

          if (isOpen) {
            gsap.to(sidebar, {
              x: "-120%",
              autoAlpha: 0,
              duration: 0.5,
              ease: "expo.in",
              onComplete() {
                sidebar.classList.remove("open");
                sidebar.style.transition = prevTrans;
              },
            });
            hideBackdrop();
            animateSidebarLinks(sidebar, false);
            setToggleAria(false);
            setMobileToggleIcon(false);
          } else {
            sidebar.classList.add("open");
            gsap.fromTo(
              sidebar,
              { x: "-120%", autoAlpha: 0 },
              {
                x: 0,
                autoAlpha: 1,
                duration: 0.5,
                ease: "expo.out",
                onComplete() {
                  sidebar.style.transition = prevTrans;
                },
              },
            );
            showBackdrop();
            animateSidebarLinks(sidebar, true);
            setToggleAria(true);
            setMobileToggleIcon(true);
          }
        } else {
          // fallback to CSS toggle
          var toggled = sidebar.classList.toggle("open");
          setToggleAria(toggled);
          setMobileToggleIcon(toggled);
          if (toggled) {
            showBackdrop();
            animateSidebarLinks(sidebar, true);
          } else {
            hideBackdrop();
            animateSidebarLinks(sidebar, false);
          }
        }
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

    // keep aria in sync on resize
    window.addEventListener("resize", function () {
      if (window.innerWidth > 767 && sidebar.classList.contains("open")) {
        sidebar.classList.remove("open");
        setToggleAria(true);
        setMobileToggleIcon(false);
      }
    });
  }

  // sidebar section dropdowns — wire Bootstrap collapse toggles to a parent-expanded state and add keyboard support
  document
    .querySelectorAll('.btn-toggle[data-bs-toggle="collapse"]')
    .forEach(function (btn) {
      var targetSel =
        btn.getAttribute("data-bs-target") || btn.getAttribute("data-target");
      var parentItem = btn.closest(".nav-item") || btn.closest(".nav-group");

      // sync expanded class on parent when Bootstrap collapse shows/hides
      if (targetSel) {
        var target = document.querySelector(targetSel);
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
        }
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
  var sidebarBackdrop = null;
  function showBackdrop() {
    if (sidebarBackdrop) return;
    sidebarBackdrop = document.createElement("div");
    sidebarBackdrop.id = "sidebarBackdrop";
    sidebarBackdrop.className = "sidebar-backdrop";
    document.body.appendChild(sidebarBackdrop);
    // small delay for transition
    requestAnimationFrame(function () {
      sidebarBackdrop.classList.add("visible");
    });
    sidebarBackdrop.addEventListener("click", function () {
      if (sidebar && sidebar.classList.contains("open")) {
        sidebar.classList.remove("open");
        setToggleAria(false);
        setMobileToggleIcon(false);
      }
      hideBackdrop();
    });
  }
  function hideBackdrop() {
    if (!sidebarBackdrop) return;
    sidebarBackdrop.classList.remove("visible");
    setTimeout(function () {
      if (sidebarBackdrop) {
        sidebarBackdrop.remove();
        sidebarBackdrop = null;
      }
    }, 250);
  }

  // ensure backdrop removed on resize > mobile
  window.addEventListener("resize", function () {
    if (window.innerWidth > 767) hideBackdrop();
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
  window.addEventListener('resize', adjustAdminOffsets);
  window.addEventListener('scroll', adjustAdminOffsets);

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
            // use Bootstrap Collapse API if available
            var bsCollapse =
              bootstrap.Collapse.getOrCreateInstance(parentCollapse);
            bsCollapse.show();
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
        const bsModal = new bootstrap.Modal(modal);
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
        const bsModal = new bootstrap.Modal(modal);
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
