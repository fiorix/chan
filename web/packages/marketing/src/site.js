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
  // Keep the active page in view when the sidebar scrolls on its own.
  const nav = document.querySelector(".manual-nav");
  const current = nav?.querySelector('[aria-current="page"]');
  if (!nav || !current || nav.scrollHeight <= nav.clientHeight) return;
  nav.scrollTop = current.offsetTop - nav.clientHeight / 2;
})();

(function () {
  // Mark the section being read in the "On this page" index.
  const links = Array.from(document.querySelectorAll(".manual-toc a[href^='#']"));
  if (links.length === 0 || !("IntersectionObserver" in window)) return;
  const byId = new Map(links.map((link) => [decodeURIComponent(link.hash.slice(1)), link]));
  const targets = Array.from(byId.keys(), (id) => document.getElementById(id)).filter(Boolean);
  const visible = new Set();
  const mark = () => {
    // The section nearest the top of the viewport wins; above the first one
    // nothing is marked, past the last one it stays.
    const passed = targets.filter((el) => el.getBoundingClientRect().top < window.innerHeight * 0.3);
    const active = targets.find((el) => visible.has(el)) ?? passed[passed.length - 1];
    links.forEach((link) => link.classList.toggle("active", !!active && byId.get(active.id) === link));
  };
  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => (entry.isIntersecting ? visible.add(entry.target) : visible.delete(entry.target)));
      mark();
    },
    { rootMargin: "0px 0px -70% 0px" },
  );
  targets.forEach((el) => observer.observe(el));
})();

(function () {
  // A clip marked data-loop plays muted while it is in view and pauses when
  // it leaves. Without JavaScript, or with reduced motion, it keeps its
  // native controls and plays only when asked.
  const clips = Array.from(document.querySelectorAll("video[data-loop]"));
  if (clips.length === 0 || !("IntersectionObserver" in window)) return;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach(({ target, isIntersecting }) => {
        if (isIntersecting && !target.dataset.paused) target.play().catch(() => {});
        else target.pause();
      });
    },
    { threshold: 0.6 },
  );
  clips.forEach((clip) => {
    clip.muted = true;
    clip.loop = true;
    clip.playsInline = true;
    clip.controls = false;
    clip.tabIndex = 0;
    const toggle = () => {
      if (clip.paused) {
        delete clip.dataset.paused;
        clip.play().catch(() => {});
      } else {
        clip.dataset.paused = "true";
        clip.pause();
      }
    };
    clip.addEventListener("click", toggle);
    clip.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      toggle();
    });
    observer.observe(clip);
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
