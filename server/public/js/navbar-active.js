document.addEventListener("DOMContentLoaded", function () {
  var toggle = document.getElementById("profileToggle");
  var sidebar = document.getElementById("authSidebar");
  var closeBtn = document.getElementById("closeSidebar");
  var logoutBtn = document.getElementById("logoutBtn");

  function openSidebar() {
    if (!sidebar) return;
    sidebar.classList.remove("d-none");
    // animate open
    requestAnimationFrame(function () {
      sidebar.classList.add("open");
    });
    sidebar.setAttribute("aria-hidden", "false");
    document.body.style.overflow = "hidden";
    // focus first visible link for accessibility
    var firstLink = sidebar.querySelector(".sidebar-link");
    if (firstLink) firstLink.focus();
  }
  function closeSidebarFn() {
    if (!sidebar) return;
    // animate close then hide
    sidebar.classList.remove("open");
    setTimeout(function () {
      sidebar.classList.add("d-none");
      sidebar.setAttribute("aria-hidden", "true");
    }, 260);
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

  // also highlight the main navbar links so the underline stays
  (function () {
    var navlinks = document.querySelectorAll(".navbar-nav .nav-link");
    function normalize(p) {
      return p.replace(/\/$/, "");
    }
    var current = normalize(location.pathname);
    navlinks.forEach(function (a) {
      try {
        var url = new URL(a.href, location.origin);
        var candidate = normalize(url.pathname);
        if (
          current === candidate ||
          (candidate !== "" && current.indexOf(candidate) === 0)
        ) {
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
          window.location.assign("/login");
        })
        .catch(function () {
          window.location.assign("/login");
        });
    });
});
