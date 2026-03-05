(function bootstrapContentScript() {
  const DETECTION_SOURCE_TYPE = "html5-video";
  const DETECTION_DEBOUNCE_MS = 250;
  const TRACKING_QUERY_PREFIXES = ["utm_"];
  const TRACKING_QUERY_KEYS = new Set([
    "fbclid",
    "gclid",
    "dclid",
    "igshid",
    "mc_cid",
    "mc_eid",
    "si",
    "feature"
  ]);

  const MESSAGE_TYPES = Object.freeze({
    CONTENT_SCRIPT_READY: "CONTENT_SCRIPT_READY",
    CONTENT_CONTEXT_PREPARED: "CONTENT_CONTEXT_PREPARED",
    CONTENT_CANDIDATES_UPDATED: "CONTENT_CANDIDATES_UPDATED",
    CONTENT_VIDEO_CANDIDATES_FOUND: "CONTENT_VIDEO_CANDIDATES_FOUND",
    POPUP_FORCE_RESCAN: "POPUP_FORCE_RESCAN"
  });

  let detectionTimer = null;
  let lastSentFingerprint = "";

  function init() {
    notifyBackgroundReady();
    sendPageContext();
    runDetectionAndPublish();
    setupRuntimeMessageHandlers();
    setupDynamicDetection();
  }

  function setupRuntimeMessageHandlers() {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (!message || message.type !== MESSAGE_TYPES.POPUP_FORCE_RESCAN) {
        return false;
      }

      runDetectionAndPublish(true);
      sendResponse({ ok: true, rescannedAt: Date.now() });
      return false;
    });
  }

  function notifyBackgroundReady() {
    chrome.runtime.sendMessage(
      { type: MESSAGE_TYPES.CONTENT_SCRIPT_READY },
      (response) => {
        if (chrome.runtime.lastError) {
          console.warn(
            "[content] Could not notify background:",
            chrome.runtime.lastError.message
          );
          return;
        }

        if (!response?.ok) {
          console.warn("[content] Background rejected ready message.");
        }
      }
    );
  }

  function sendPageContext() {
    const payload = {
      url: window.location.href,
      title: document.title
    };

    chrome.runtime.sendMessage(
      { type: MESSAGE_TYPES.CONTENT_CONTEXT_PREPARED, payload },
      () => {
        if (chrome.runtime.lastError) {
          console.warn(
            "[content] Could not send page context:",
            chrome.runtime.lastError.message
          );
          return;
        }
      }
    );
  }

  function setupDynamicDetection() {
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === "childList") {
          if (containsVideoNode(mutation.addedNodes)) {
            scheduleDetection();
            return;
          }
          continue;
        }

        if (
          mutation.type === "attributes" &&
          mutation.target instanceof Element &&
          (mutation.target.tagName === "VIDEO" || mutation.target.tagName === "SOURCE")
        ) {
          scheduleDetection();
          return;
        }
      }
    });

    observer.observe(document.documentElement || document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["src", "type"]
    });

    document.addEventListener("loadedmetadata", scheduleDetection, true);
    document.addEventListener("emptied", scheduleDetection, true);
    document.addEventListener("durationchange", scheduleDetection, true);
  }

  function containsVideoNode(nodes) {
    for (const node of nodes) {
      if (!(node instanceof Element)) {
        continue;
      }

      if (node.tagName === "VIDEO" || node.tagName === "SOURCE") {
        return true;
      }

      if (node.querySelector("video, source")) {
        return true;
      }
    }

    return false;
  }

  function scheduleDetection() {
    if (detectionTimer) {
      clearTimeout(detectionTimer);
    }

    detectionTimer = setTimeout(() => {
      detectionTimer = null;
      runDetectionAndPublish();
    }, DETECTION_DEBOUNCE_MS);
  }

  function runDetectionAndPublish(forced = false) {
    const groups = detectVideoGroups();
    const fingerprint = JSON.stringify(
      groups.map((group) => ({
        id: group.id,
        variants: group.variants.map((variant) => variant.normalizedUrl)
      }))
    );

    if (!forced && fingerprint === lastSentFingerprint) {
      return;
    }

    lastSentFingerprint = fingerprint;
    publishCandidates(groups);
  }

  function detectVideoGroups() {
    const videoElements = Array.from(document.querySelectorAll("video"));
    const groups = [];

    videoElements.forEach((videoElement, elementIndex) => {
      const variants = extractVideoVariants(videoElement, elementIndex);
      if (variants.length === 0) {
        return;
      }

      const sortedVariants = sortVariantsByQuality(variants);
      const primaryVariant = sortedVariants[0];

      groups.push({
        id: `video-group-${elementIndex + 1}`,
        pageTitle: document.title || "",
        hostname: window.location.hostname || "",
        detectedAt: Date.now(),
        sourceType: DETECTION_SOURCE_TYPE,
        elementIndex,
        url: primaryVariant?.url || "",
        normalizedUrl: primaryVariant?.normalizedUrl || "",
        variants: sortedVariants
      });
    });

    return groups;
  }

  function extractVideoVariants(videoElement, elementIndex) {
    const dedupedVariants = new Map();
    const sourceItems = [];

    if (videoElement.currentSrc) {
      sourceItems.push({
        src: videoElement.currentSrc,
        type: videoElement.getAttribute("type") || "",
        sourceIndex: sourceItems.length
      });
    }

    const directSrc = videoElement.getAttribute("src");
    if (directSrc) {
      sourceItems.push({
        src: directSrc,
        type: videoElement.getAttribute("type") || "",
        sourceIndex: sourceItems.length
      });
    }

    const sourceElements = videoElement.querySelectorAll("source[src]");
    for (const sourceElement of sourceElements) {
      const sourceSrc = sourceElement.getAttribute("src");
      if (!sourceSrc) {
        continue;
      }

      sourceItems.push({
        src: sourceSrc,
        type: sourceElement.getAttribute("type") || "",
        sourceIndex: sourceItems.length
      });
    }

    for (const sourceItem of sourceItems) {
      const normalized = normalizeCandidateUrl(sourceItem.src);
      if (!normalized) {
        continue;
      }

      if (!isLikelyDownloadableVideo(normalized.absoluteUrl)) {
        continue;
      }

      if (dedupedVariants.has(normalized.normalizedUrl)) {
        continue;
      }

      const quality = detectQualityFromSource(normalized.absoluteUrl, sourceItem.type);
      const variantId = `video-${elementIndex + 1}-variant-${sourceItem.sourceIndex + 1}`;

      dedupedVariants.set(normalized.normalizedUrl, {
        id: variantId,
        url: normalized.absoluteUrl,
        normalizedUrl: normalized.normalizedUrl,
        type: sourceItem.type,
        quality,
        detectedAt: Date.now(),
        sourceType: DETECTION_SOURCE_TYPE,
        elementIndex,
        sourceIndex: sourceItem.sourceIndex,
        variantOrder: sourceItem.sourceIndex
      });
    }

    return Array.from(dedupedVariants.values());
  }

  function sortVariantsByQuality(variants) {
    return variants
      .slice()
      .sort((left, right) => {
        const qualityDelta = (right?.quality?.height || 0) - (left?.quality?.height || 0);
        if (qualityDelta !== 0) {
          return qualityDelta;
        }

        return (left?.variantOrder || 0) - (right?.variantOrder || 0);
      })
      .map((variant, index) => ({
        ...variant,
        variantOrder: index
      }));
  }

  function normalizeCandidateUrl(inputUrl) {
    if (typeof inputUrl !== "string" || !inputUrl.trim()) {
      return null;
    }

    let parsedUrl;
    try {
      parsedUrl = new URL(inputUrl, window.location.href);
    } catch (error) {
      return null;
    }

    if (!["http:", "https:"].includes(parsedUrl.protocol)) {
      return null;
    }

    const absoluteUrl = parsedUrl.href;
    const normalized = new URL(parsedUrl.href);
    sanitizeTrackingParams(normalized.searchParams);
    normalized.searchParams.sort();
    normalized.hash = "";

    return {
      absoluteUrl,
      normalizedUrl: normalized.href
    };
  }

  function sanitizeTrackingParams(searchParams) {
    const keysToDelete = [];

    for (const key of searchParams.keys()) {
      const lower = key.toLowerCase();
      if (
        TRACKING_QUERY_KEYS.has(lower) ||
        TRACKING_QUERY_PREFIXES.some((prefix) => lower.startsWith(prefix))
      ) {
        keysToDelete.push(key);
      }
    }

    keysToDelete.forEach((key) => searchParams.delete(key));
  }

  function isLikelyDownloadableVideo(url) {
    const lower = url.toLowerCase();
    if (lower.includes(".m3u8") || lower.includes(".mpd")) {
      return false;
    }

    return true;
  }

  function detectQualityFromSource(url, sourceType) {
    const text = `${safeUrlText(url)} ${sourceType || ""}`.toLowerCase();
    const match = text.match(/(?:^|[^0-9])(2160|1440|1080|720|540|480|360|240)p?(?:[^0-9]|$)/);

    if (text.includes("8k")) {
      return { label: "4320p", height: 4320 };
    }

    if (text.includes("4k")) {
      return { label: "2160p", height: 2160 };
    }

    if (match?.[1]) {
      const height = Number(match[1]);
      if (Number.isFinite(height) && height > 0) {
        return { label: `${height}p`, height };
      }
    }

    return {
      label: "Unknown Quality",
      height: 0
    };
  }

  function safeUrlText(url) {
    if (typeof url !== "string" || !url.trim()) {
      return "";
    }

    try {
      const parsed = new URL(url);
      return `${parsed.pathname} ${parsed.search}`;
    } catch (error) {
      return url;
    }
  }

  function publishCandidates(videos) {
    const payload = {
      videos,
      pageTitle: document.title || "",
      pageUrl: window.location.href
    };

    chrome.runtime.sendMessage(
      {
        type: MESSAGE_TYPES.CONTENT_VIDEO_CANDIDATES_FOUND,
        payload
      },
      (response) => {
        if (chrome.runtime.lastError) {
          console.warn(
            "[content] Could not send video candidates:",
            chrome.runtime.lastError.message
          );
          return;
        }

        if (!response?.ok) {
          console.warn("[content] Background rejected candidate update.");
        }
      }
    );

    chrome.runtime.sendMessage({
      type: MESSAGE_TYPES.CONTENT_CANDIDATES_UPDATED,
      payload
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
    return;
  }

  init();
})();
