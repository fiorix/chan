(function () {
  const key = "chan-site-mode";
  const button = document.getElementById("theme-toggle");
  const saved = window.localStorage.getItem(key);
  if (saved === "dark" || saved === "light") {
    document.body.dataset.mode = saved;
  } else if (window.matchMedia("(prefers-color-scheme: dark)").matches) {
    document.body.dataset.mode = "dark";
  }
  if (button) {
    button.addEventListener("click", () => {
      const next = document.body.dataset.mode === "dark" ? "light" : "dark";
      document.body.dataset.mode = next;
      window.localStorage.setItem(key, next);
    });
  }
})();

(function () {
  document.querySelectorAll("[data-copy-block]").forEach((block) => {
    const button = block.querySelector("button");
    const value = block.querySelector("[data-copy-value]");
    if (!button || !value) return;
    button.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(value.textContent || "");
        block.classList.add("copied");
        window.setTimeout(() => {
          block.classList.remove("copied");
        }, 1400);
      } catch (_err) {
      }
    });
  });
})();

(function () {
  const metadataUrl = "/dl/releases.json";
  const fallbackUrl = "https://github.com/fiorix/chan/releases";
  const links = Array.from(document.querySelectorAll("[data-release-download]"));
  if (links.length === 0) return;

  const applyFallback = () => {
    links.forEach((link) => {
      link.href = fallbackUrl;
      link.dataset.releaseState = "fallback";
    });
  };

  fetch(metadataUrl, { cache: "no-store" })
    .then((response) => {
      if (!response.ok) throw new Error(`metadata HTTP ${response.status}`);
      return response.json();
    })
    .then((metadata) => {
      const release = latestRelease(metadata);
      const downloads = new Map(
        (release.downloads || [])
          .filter((download) => isSafeDownload(download))
          .map((download) => [download.id, download]),
      );
      links.forEach((link) => {
        const download = downloads.get(link.dataset.releaseDownload || "");
        if (!download) return;
        link.href = download.url;
        link.dataset.releaseState = "ready";
        if (download.asset) {
          link.dataset.releaseAsset = download.asset;
        }
      });
    })
    .catch(() => {
      applyFallback();
    });

  function latestRelease(metadata) {
    const releases = Array.isArray(metadata?.releases) ? metadata.releases : [];
    return releases.find((release) => release.version === metadata.latest) || releases[0] || {};
  }

  function isSafeDownload(download) {
    if (!download || typeof download.id !== "string" || typeof download.url !== "string") {
      return false;
    }
    if (!download.url.startsWith("https://")) return false;
    if (download.url.includes("/releases/latest/download/")) return false;
    return true;
  }
})();

(function () {
  // Click (or Enter/Space) a product screenshot to view it larger in a
  // lightbox; click the backdrop or press Escape to close.
  const shots = Array.from(document.querySelectorAll(".hero-shot img, .inline-shot img"));
  if (shots.length === 0) return;

  let overlay = null;

  function close() {
    if (!overlay) return;
    overlay.remove();
    overlay = null;
    document.body.classList.remove("lightbox-open");
    document.removeEventListener("keydown", onKey);
  }

  function onKey(event) {
    if (event.key === "Escape") close();
  }

  function open(src, alt) {
    close();
    overlay = document.createElement("div");
    overlay.className = "lightbox";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", alt || "Screenshot");
    const large = document.createElement("img");
    large.src = src;
    large.alt = alt || "";
    overlay.appendChild(large);
    overlay.addEventListener("click", close);
    document.body.appendChild(overlay);
    document.body.classList.add("lightbox-open");
    document.addEventListener("keydown", onKey);
  }

  shots.forEach((img) => {
    img.classList.add("zoomable");
    img.setAttribute("role", "button");
    img.setAttribute("tabindex", "0");
    img.setAttribute("aria-label", `View larger: ${img.alt || "screenshot"}`);
    img.addEventListener("click", () => open(img.currentSrc || img.src, img.alt));
    img.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        open(img.currentSrc || img.src, img.alt);
      }
    });
  });
})();

(function () {
  // The home hero carousel: play one silent product video at a time, advancing
  // after it finishes. Reduced-motion visitors opt in with the native controls;
  // arrows and dots remain available to everyone.
  document.querySelectorAll("[data-carousel]").forEach((carousel) => {
    const slides = Array.from(carousel.querySelectorAll("[data-carousel-slide]"));
    const caption = carousel.querySelector(".carousel-caption");
    const dotsHost = carousel.querySelector(".carousel-dots");
    if (slides.length < 2 || !dotsHost) return;

    const dots = slides.map((_slide, i) => {
      const dot = document.createElement("button");
      dot.type = "button";
      dot.className = "carousel-dot";
      dot.setAttribute("aria-label", `Video ${i + 1} of ${slides.length}`);
      dot.addEventListener("click", () => show(i));
      dotsHost.appendChild(dot);
      return dot;
    });

    let index = Math.max(
      slides.findIndex((slide) => slide.classList.contains("active")),
      0,
    );

    function show(i) {
      const next = (i + slides.length) % slides.length;
      const changed = next !== index;
      index = next;
      slides.forEach((slide, n) => {
        const active = n === index;
        slide.classList.toggle("active", active);
        if (!(slide instanceof HTMLVideoElement)) return;
        if (!active) {
          slide.pause();
          if (slide.currentTime !== 0) slide.currentTime = 0;
        } else if (changed && slide.currentTime !== 0) {
          slide.currentTime = 0;
        }
      });
      dots.forEach((dot, n) => {
        if (n === index) dot.setAttribute("aria-current", "true");
        else dot.removeAttribute("aria-current");
      });
      if (caption) caption.textContent = slides[index].dataset.caption || "";
      const active = slides[index];
      if (autoPlay && active instanceof HTMLVideoElement) {
        void active.play().catch(() => {});
      }
    }

    const autoPlay = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    slides.forEach((slide, i) => {
      if (!(slide instanceof HTMLVideoElement)) return;
      slide.addEventListener("ended", () => {
        if (autoPlay && i === index) show(index + 1);
      });
    });

    carousel.querySelector(".carousel-prev")?.addEventListener("click", () => show(index - 1));
    carousel.querySelector(".carousel-next")?.addEventListener("click", () => show(index + 1));
    carousel.addEventListener("keydown", (event) => {
      if (event.target instanceof HTMLVideoElement) return;
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        show(index - 1);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        show(index + 1);
      }
    });

    show(index);
  });
})();
