/**
 * Marks the matching top-level navbar link as active.
 *
 * The customer sidebar (drawer, collapsed state, badges, sign out) is owned by
 * navbar-auth.js — this file only handles the static navbar underline.
 */
document.addEventListener("DOMContentLoaded", function () {
  function normalize(path) {
    return path.replace(/\/+$/, "") || "/";
  }

  var current = normalize(window.location.pathname);

  document.querySelectorAll(".navbar-nav .nav-link").forEach(function (link) {
    var candidate;
    try {
      candidate = normalize(new URL(link.href, window.location.origin).pathname);
    } catch (e) {
      return;
    }
    if (current === candidate || (candidate !== "/" && current.indexOf(candidate + "/") === 0)) {
      link.classList.add("active");
      link.setAttribute("aria-current", "page");
    }
  });
});
