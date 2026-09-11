(function () {
  "use strict";

  var connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  var lowMemory = typeof navigator.deviceMemory === "number" && navigator.deviceMemory <= 4;
  var lowCpu = typeof navigator.hardwareConcurrency === "number" && navigator.hardwareConcurrency <= 4;
  var saveData = Boolean(connection && connection.saveData);

  if (lowMemory || lowCpu || saveData) {
    document.documentElement.classList.add("perf-lite");
  }

  function optimizeMedia() {
    var images = document.images;
    var viewportFloor = window.innerHeight * 1.25;

    for (var index = 0; index < images.length; index += 1) {
      var image = images[index];
      image.decoding = "async";

      if (image.hasAttribute("loading") || image.getAttribute("fetchpriority") === "high") continue;

      /* Keep likely LCP images eager. Everything below the first viewport can
         wait until the browser is close to it. */
      var rect = image.getBoundingClientRect();
      image.loading = rect.top > viewportFloor ? "lazy" : "eager";
    }

    var videos = document.querySelectorAll("video[autoplay]");
    if (!videos.length || !("IntersectionObserver" in window)) return;

    var videoObserver = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting && !document.hidden) {
          entry.target.play().catch(function () {});
        } else {
          entry.target.pause();
        }
      });
    }, { rootMargin: "100px 0px", threshold: 0.01 });

    videos.forEach(function (video) {
      videoObserver.observe(video);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", optimizeMedia, { once: true });
  } else {
    optimizeMedia();
  }
})();
