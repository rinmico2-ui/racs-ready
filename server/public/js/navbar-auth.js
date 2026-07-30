document.addEventListener("DOMContentLoaded", function () {
  var toggle = document.getElementById("profileToggle");
  var sidebar = document.getElementById("authSidebar");
  var closeBtn = document.getElementById("closeSidebar");
  var logoutBtn = document.getElementById("logoutBtn");

  function openSidebar() {
    if (!sidebar) return;
    sidebar.classList.remove("d-none");
    // animate open using GSAP if available
    if (window.gsap) {
      gsap.fromTo(
        sidebar,
        { x: -16, autoAlpha: 0 },
        { x: 0, autoAlpha: 1, duration: 0.36, ease: "power2.out" },
      );
    } else {
      requestAnimationFrame(function () {
        sidebar.classList.add("open");
      });
    }
    sidebar.setAttribute("aria-hidden", "false");
    document.body.style.overflow = "hidden";
    // focus first visible link for accessibility
    var firstLink = sidebar.querySelector(".sidebar-link");
    if (firstLink) firstLink.focus();
  }
  function closeSidebarFn() {
    if (!sidebar) return;
    if (window.gsap) {
      gsap.to(sidebar, {
        x: -16,
        autoAlpha: 0,
        duration: 0.28,
        ease: "power1.in",
        onComplete: function () {
          sidebar.classList.add("d-none");
          sidebar.setAttribute("aria-hidden", "true");
          sidebar.style.transform = ""; // reset
          sidebar.style.opacity = "";
        },
      });
    } else {
      // animate close then hide
      sidebar.classList.remove("open");
      setTimeout(function () {
        sidebar.classList.add("d-none");
        sidebar.setAttribute("aria-hidden", "true");
      }, 260);
    }
    document.body.style.overflow = "";
  }

  // set active item based on current path
  (function () {
    if (!sidebar) return;
    var links = sidebar.querySelectorAll(".sidebar-link");
    links.forEach(function (a) {
      try {
        var url = new URL(a.href, location.origin);
        if (url.pathname === location.pathname) {
          a.classList.add("active");
          a.setAttribute("aria-current", "page");
        }
      } catch (e) {}
    });
  })();

  if (toggle)
    toggle.addEventListener("click", function () {
      openSidebar();
    });
  if (closeBtn)
    closeBtn.addEventListener("click", function () {
      closeSidebarFn();
    });

  if (logoutBtn)
    logoutBtn.addEventListener("click", function () {
      logoutBtn.disabled = true;
      fetch("/api/auth/logout", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
      })
        .then(function (res) {
          return res.json();
        })
        .then(function () {
          closeSidebarFn();
          window.location.replace("/login");
        })
        .catch(function () {
          window.location.replace("/login");
        });
    });
});
