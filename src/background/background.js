import { MESSAGE_TYPES } from "../shared/messageTypes.js";
import { validateDownloadUrl } from "../../utils/downloadValidator.js";
import { inferDownloadFilename } from "../../utils/filenameSanitizer.js";
import { rankCandidates } from "../../utils/candidateRanking.js";
import { normalizeQuality } from "../../utils/qualityDetector.js";

const SESSION_STORAGE_KEY = "videoDownloaderState";
const MAX_DOWNLOAD_HISTORY = 20;
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

const DOWNLOAD_STATUS = Object.freeze({
  STARTED: "started",
  COMPLETED: "completed",
  FAILED: "failed",
  INTERRUPTED: "interrupted"
});

const state = {
  initializedAt: Date.now(),
  lastSeenTabId: null,
  videosByTabId: new Map(),
  activeDownloadKeys: new Set(),
  completedDownloadKeys: new Set(),
  downloadsById: new Map(),
  downloadHistory: []
};

initializeExtension().catch((error) => {
  console.error("[background] Initialization failed:", error);
});

chrome.runtime.onInstalled.addListener((details) => {
  console.info("[background] Extension installed/updated:", details.reason);
});

chrome.runtime.onStartup.addListener(() => {
  console.info("[background] Browser startup detected.");
});

chrome.downloads.onChanged.addListener((delta) => {
  handleDownloadChanged(delta);
});

chrome.downloads.onErased.addListener((downloadId) => {
  if (typeof downloadId !== "number") {
    return;
  }

  const record = state.downloadsById.get(downloadId);
  if (record?.downloadKey) {
    state.activeDownloadKeys.delete(record.downloadKey);
    state.completedDownloadKeys.delete(record.downloadKey);
  }
  state.downloadsById.delete(downloadId);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== "string") {
    return false;
  }

  switch (message.type) {
    case MESSAGE_TYPES.CONTENT_SCRIPT_READY:
      handleContentScriptReady(sender, sendResponse);
      return true;
    case MESSAGE_TYPES.CONTENT_CONTEXT_PREPARED:
      handleContentContextPrepared(message.payload, sender, sendResponse);
      return true;
    case MESSAGE_TYPES.CONTENT_CANDIDATES_UPDATED:
      handleContentCandidatesUpdated(message.payload, sender, sendResponse);
      return true;
    case MESSAGE_TYPES.CONTENT_VIDEO_CANDIDATES_FOUND:
      handleContentCandidatesUpdated(message.payload, sender, sendResponse);
      return true;
    case MESSAGE_TYPES.POPUP_GET_STATE:
      handlePopupGetState(message.payload, sendResponse);
      return true;
    case MESSAGE_TYPES.POPUP_DOWNLOAD_REQUEST:
    case MESSAGE_TYPES.POPUP_DOWNLOAD_VARIANT_REQUEST:
      handlePopupDownloadRequest(message.payload, sender, sendResponse);
      return true;
    case MESSAGE_TYPES.POPUP_GET_DOWNLOAD_HISTORY:
      handlePopupGetDownloadHistory(message.payload, sendResponse);
      return true;
    case MESSAGE_TYPES.POPUP_PING:
      sendResponse({ ok: true, initializedAt: state.initializedAt });
      return false;
    default:
      sendResponse({ ok: false, error: "Unknown message type." });
      return false;
  }
});

async function initializeExtension() {
  await hydrateFromStorage();
  reconcileDownloadKeySets();
  console.info("[background] Initialized with in-memory state.");
}

function handleContentScriptReady(sender, sendResponse) {
  const tabId = sender?.tab?.id;

  if (typeof tabId !== "number") {
    sendResponse({ ok: false, error: "Missing sender tab id." });
    return;
  }

  state.lastSeenTabId = tabId;
  ensureTabEntry(tabId);
  persistToStorage().catch((error) => {
    console.error("[background] Failed to persist ready state:", error);
  });

  sendResponse({ ok: true, tabId });
}

function handleContentContextPrepared(payload, sender, sendResponse) {
  const tabId = sender?.tab?.id;

  if (typeof tabId !== "number") {
    sendResponse({ ok: false, error: "Missing sender tab id." });
    return;
  }

  const entry = ensureTabEntry(tabId);
  state.lastSeenTabId = tabId;
  entry.pageContext = {
    url: payload?.url || sender.tab?.url || "",
    title: payload?.title || sender.tab?.title || "",
    preparedAt: Date.now()
  };

  persistToStorage().catch((error) => {
    console.error("[background] Failed to persist page context:", error);
  });

  sendResponse({ ok: true });
}

function handleContentCandidatesUpdated(payload, sender, sendResponse) {
  const tabId = sender?.tab?.id;

  if (typeof tabId !== "number") {
    sendResponse({ ok: false, error: "Missing sender tab id." });
    return;
  }

  const entry = ensureTabEntry(tabId);
  state.lastSeenTabId = tabId;
  const incomingVideos = Array.isArray(payload?.videos) ? payload.videos : [];
  entry.videos = rankCandidates(mergeCandidates(entry.videos, incomingVideos));

  if (payload?.pageTitle || payload?.pageUrl) {
    entry.pageContext = {
      ...(entry.pageContext || {}),
      title: payload?.pageTitle || entry.pageContext?.title || sender.tab?.title || "",
      url: payload?.pageUrl || entry.pageContext?.url || sender.tab?.url || "",
      preparedAt: Date.now()
    };
  }

  entry.lastUpdatedAt = Date.now();

  persistToStorage().catch((error) => {
    console.error("[background] Failed to persist candidate updates:", error);
  });

  sendResponse({ ok: true, count: entry.videos.length });
}

function handlePopupGetState(payload, sendResponse) {
  const requestedTabId = payload?.tabId;
  const tabId = typeof requestedTabId === "number" ? requestedTabId : null;

  if (typeof tabId !== "number") {
    sendResponse({
      ok: true,
      tabId: null,
      videos: [],
      pageContext: null,
      recentDownloads: [],
      status: "No tab context available yet."
    });
    return;
  }

  const entry = ensureTabEntry(tabId);
  const rankedVideos = rankCandidates(Array.isArray(entry.videos) ? entry.videos : []);
  const videosWithStatus = rankedVideos.map((video) => ({
    ...video,
    variants: (Array.isArray(video?.variants) ? video.variants : []).map((variant) => {
      const latest = getLatestDownloadForVariant(tabId, video?.id, variant);
      return {
        ...variant,
        downloadStatus: latest?.status || null,
        downloadUpdatedAt: latest?.timestamp || null,
        lastFilename: latest?.filename || ""
      };
    })
  }));

  sendResponse({
    ok: true,
    tabId,
    videos: videosWithStatus,
    pageContext: entry.pageContext,
    recentDownloads: getRecentDownloadsForTab(tabId),
    status:
      entry.videos.length > 0
        ? `Detected ${entry.videos.length} video group(s).`
        : "No videos detected yet."
  });
}

function handlePopupGetDownloadHistory(payload, sendResponse) {
  const requestedTabId = payload?.tabId;
  const tabId = typeof requestedTabId === "number" ? requestedTabId : null;

  sendResponse({
    ok: true,
    tabId,
    downloads: getRecentDownloadsForTab(tabId)
  });
}

async function handlePopupDownloadRequest(payload, sender, sendResponse) {
  const tabId =
    typeof payload?.tabId === "number"
      ? payload.tabId
      : typeof sender?.tab?.id === "number"
        ? sender.tab.id
        : state.lastSeenTabId;

  if (typeof tabId !== "number") {
    sendResponse({ ok: false, error: "No active tab context available." });
    return;
  }

  const candidateId = typeof payload?.candidateId === "string" ? payload.candidateId : "";
  const variantId = typeof payload?.variantId === "string" ? payload.variantId : "";
  const url = typeof payload?.url === "string" ? payload.url : "";

  const validation = validateDownloadUrl(url);
  if (!validation.ok) {
    console.warn("[background] Download validation failed:", validation.error, { candidateId, variantId, url });
    sendResponse({ ok: false, error: validation.error });
    return;
  }

  const downloadKey = buildDownloadKey(validation.normalizedUrl);
  if (state.activeDownloadKeys.has(downloadKey) || state.completedDownloadKeys.has(downloadKey)) {
    sendResponse({
      ok: false,
      error: "This video variant was already requested for download in the current session."
    });
    return;
  }

  const entry = ensureTabEntry(tabId);
  const candidateIndex = findCandidateIndex(entry.videos, candidateId, variantId, validation.normalizedUrl);
  const pageTitle = entry.pageContext?.title || "";
  const filename = inferDownloadFilename({
    url: validation.normalizedUrl,
    pageTitle,
    candidateIndex,
    timestamp: Date.now()
  });

  const qualityLabel = findQualityLabel(entry.videos, candidateId, variantId, validation.normalizedUrl);
  state.activeDownloadKeys.add(downloadKey);

  try {
    const downloadId = await triggerDownload(validation.normalizedUrl, filename);
    const metadata = {
      downloadId,
      downloadKey,
      tabId,
      candidateId,
      variantId,
      qualityLabel,
      url: validation.normalizedUrl,
      filename,
      status: DOWNLOAD_STATUS.STARTED,
      timestamp: Date.now()
    };

    state.downloadsById.set(downloadId, metadata);
    upsertDownloadHistory(metadata);

    await persistToStorage();
    sendResponse({ ok: true, status: "Download started.", downloadId, filename });
  } catch (error) {
    state.activeDownloadKeys.delete(downloadKey);
    const message = error instanceof Error ? error.message : "Failed to start download.";
    console.error("[background] Download request failed:", message, { candidateId, variantId, url: validation.normalizedUrl });
    sendResponse({ ok: false, error: message });
  }
}

function handleDownloadChanged(delta) {
  const downloadId = delta?.id;

  if (typeof downloadId !== "number") {
    return;
  }

  const current = state.downloadsById.get(downloadId);
  if (!current) {
    return;
  }

  const nextStatus = resolveStatusFromDelta(delta, current.status);
  if (!nextStatus) {
    return;
  }

  const updated = {
    ...current,
    status: nextStatus,
    timestamp: Date.now()
  };

  state.downloadsById.set(downloadId, updated);
  upsertDownloadHistory(updated);

  if (nextStatus === DOWNLOAD_STATUS.COMPLETED) {
    state.activeDownloadKeys.delete(updated.downloadKey);
    state.completedDownloadKeys.add(updated.downloadKey);
  } else if (nextStatus === DOWNLOAD_STATUS.FAILED || nextStatus === DOWNLOAD_STATUS.INTERRUPTED) {
    state.activeDownloadKeys.delete(updated.downloadKey);
    state.completedDownloadKeys.delete(updated.downloadKey);
  }

  persistToStorage().catch((error) => {
    console.error("[background] Failed to persist lifecycle update:", error);
  });
}

function resolveStatusFromDelta(delta, currentStatus) {
  const stateValue = delta?.state?.current;
  if (stateValue === "complete") {
    return DOWNLOAD_STATUS.COMPLETED;
  }

  if (stateValue === "interrupted") {
    const errorCode = delta?.error?.current || "";
    if (errorCode && errorCode !== "USER_CANCELED") {
      return DOWNLOAD_STATUS.FAILED;
    }
    return DOWNLOAD_STATUS.INTERRUPTED;
  }

  if (stateValue === "in_progress" && currentStatus !== DOWNLOAD_STATUS.STARTED) {
    return DOWNLOAD_STATUS.STARTED;
  }

  return null;
}

function getLatestDownloadForVariant(tabId, candidateId, variant) {
  const variantId = typeof variant?.id === "string" ? variant.id : "";
  const normalizedUrl = buildVariantKey(variant);

  for (const entry of state.downloadHistory) {
    if (typeof tabId === "number" && entry?.tabId !== tabId) {
      continue;
    }

    if (candidateId && variantId && entry?.candidateId === candidateId && entry?.variantId === variantId) {
      return entry;
    }

    if (normalizedUrl && buildDownloadKey(entry?.url || "") === normalizedUrl) {
      return entry;
    }
  }

  return null;
}

function getRecentDownloadsForTab(tabId) {
  const list = [];

  for (const entry of state.downloadHistory) {
    if (typeof tabId === "number" && entry?.tabId !== tabId) {
      continue;
    }
    list.push(entry);
    if (list.length >= 5) {
      break;
    }
  }

  return list;
}

function upsertDownloadHistory(record) {
  const safeRecord = {
    downloadId: typeof record?.downloadId === "number" ? record.downloadId : null,
    candidateId: typeof record?.candidateId === "string" ? record.candidateId : "",
    variantId: typeof record?.variantId === "string" ? record.variantId : "",
    qualityLabel: typeof record?.qualityLabel === "string" ? record.qualityLabel : "",
    tabId: typeof record?.tabId === "number" ? record.tabId : null,
    filename: typeof record?.filename === "string" ? record.filename : "",
    url: typeof record?.url === "string" ? record.url : "",
    status: typeof record?.status === "string" ? record.status : DOWNLOAD_STATUS.STARTED,
    timestamp: typeof record?.timestamp === "number" ? record.timestamp : Date.now(),
    downloadKey: typeof record?.downloadKey === "string" ? record.downloadKey : ""
  };

  const existingIndex = state.downloadHistory.findIndex(
    (item) => item?.downloadId === safeRecord.downloadId
  );

  if (existingIndex >= 0) {
    state.downloadHistory[existingIndex] = safeRecord;
  } else {
    state.downloadHistory.unshift(safeRecord);
  }

  state.downloadHistory.sort((a, b) => b.timestamp - a.timestamp);
  state.downloadHistory = state.downloadHistory.slice(0, MAX_DOWNLOAD_HISTORY);
}

function reconcileDownloadKeySets() {
  state.activeDownloadKeys.clear();
  state.completedDownloadKeys.clear();

  for (const record of state.downloadHistory) {
    if (!record?.downloadKey) {
      continue;
    }

    if (record.status === DOWNLOAD_STATUS.COMPLETED) {
      state.completedDownloadKeys.add(record.downloadKey);
      continue;
    }

    if (record.status === DOWNLOAD_STATUS.STARTED) {
      state.activeDownloadKeys.add(record.downloadKey);
    }
  }
}

function ensureTabEntry(tabId) {
  if (!state.videosByTabId.has(tabId)) {
    state.videosByTabId.set(tabId, {
      videos: [],
      pageContext: null,
      lastUpdatedAt: Date.now()
    });
  }

  return state.videosByTabId.get(tabId);
}

function buildDownloadKey(url) {
  return normalizeCandidateUrl(url);
}

function findCandidateIndex(videos, candidateId, variantId, normalizedUrl) {
  const safeVideos = Array.isArray(videos) ? videos : [];
  const groupIndex = safeVideos.findIndex((video) => video?.id === candidateId);
  if (groupIndex >= 0) {
    const safeVariants = Array.isArray(safeVideos[groupIndex]?.variants) ? safeVideos[groupIndex].variants : [];
    const variantIndex = safeVariants.findIndex((variant) => variant?.id === variantId);
    if (variantIndex >= 0) {
      return groupIndex + 1;
    }
  }

  const byUrlIndex = safeVideos.findIndex((video) => {
    const safeVariants = Array.isArray(video?.variants) ? video.variants : [];
    return safeVariants.some((variant) => buildVariantKey(variant) === normalizedUrl);
  });
  if (byUrlIndex >= 0) {
    return byUrlIndex + 1;
  }

  return 1;
}

function findQualityLabel(videos, candidateId, variantId, normalizedUrl) {
  const safeVideos = Array.isArray(videos) ? videos : [];

  const byIds = safeVideos.find((video) => video?.id === candidateId);
  if (byIds) {
    const exactVariant = (Array.isArray(byIds?.variants) ? byIds.variants : []).find(
      (variant) => variant?.id === variantId
    );
    if (exactVariant) {
      return normalizeQuality(exactVariant.quality, exactVariant.url, exactVariant.type).label;
    }
  }

  for (const video of safeVideos) {
    const variant = (Array.isArray(video?.variants) ? video.variants : []).find(
      (item) => buildVariantKey(item) === normalizedUrl
    );
    if (variant) {
      return normalizeQuality(variant.quality, variant.url, variant.type).label;
    }
  }

  return "Unknown Quality";
}

function mergeCandidates(existingVideos, incomingVideos) {
  const merged = new Map();
  const safeExisting = Array.isArray(existingVideos) ? existingVideos : [];
  const safeIncoming = Array.isArray(incomingVideos) ? incomingVideos : [];

  for (const candidate of safeExisting) {
    const key = buildGroupKey(candidate);
    if (key) {
      merged.set(key, normalizeGroupCandidate(candidate, key));
    }
  }

  for (const candidate of safeIncoming) {
    const key = buildGroupKey(candidate);
    if (!key) {
      continue;
    }

    const previous = merged.get(key);
    const normalizedIncoming = normalizeGroupCandidate(candidate, key);
    merged.set(key, mergeGroupCandidate(previous, normalizedIncoming, key));
  }

  return Array.from(merged.values());
}

function mergeGroupCandidate(previous, incoming, key) {
  const previousVariants = Array.isArray(previous?.variants) ? previous.variants : [];
  const incomingVariants = Array.isArray(incoming?.variants) ? incoming.variants : [];

  const variantsByKey = new Map();
  for (const variant of previousVariants) {
    const variantKey = buildVariantKey(variant);
    if (!variantKey) {
      continue;
    }
    variantsByKey.set(variantKey, normalizeVariant(variant));
  }

  for (const variant of incomingVariants) {
    const variantKey = buildVariantKey(variant);
    if (!variantKey) {
      continue;
    }
    const existing = variantsByKey.get(variantKey);
    variantsByKey.set(variantKey, normalizeVariant({ ...existing, ...variant }));
  }

  const mergedVariants = sortVariants(Array.from(variantsByKey.values()));
  const primary = mergedVariants[0] || null;

  return {
    ...previous,
    ...incoming,
    id: key,
    variants: mergedVariants,
    url: primary?.url || incoming?.url || previous?.url || "",
    normalizedUrl: primary?.normalizedUrl || incoming?.normalizedUrl || previous?.normalizedUrl || ""
  };
}

function normalizeGroupCandidate(candidate, key) {
  const safeVariants = Array.isArray(candidate?.variants)
    ? candidate.variants
    : buildFallbackVariantFromLegacyCandidate(candidate);

  const normalizedVariants = sortVariants(safeVariants.map((variant) => normalizeVariant(variant)));
  const primary = normalizedVariants[0] || null;

  return {
    ...candidate,
    id: key,
    variants: normalizedVariants,
    url: primary?.url || candidate?.url || "",
    normalizedUrl: primary?.normalizedUrl || candidate?.normalizedUrl || ""
  };
}

function buildFallbackVariantFromLegacyCandidate(candidate) {
  const url = typeof candidate?.url === "string" ? candidate.url : "";
  if (!url) {
    return [];
  }

  return [
    {
      id: `${candidate?.id || "video-group"}-variant-1`,
      url,
      normalizedUrl: buildDownloadKey(url),
      quality: normalizeQuality(candidate?.quality, url),
      variantOrder: 0,
      type: ""
    }
  ];
}

function normalizeVariant(variant) {
  const normalizedUrl =
    typeof variant?.normalizedUrl === "string" && variant.normalizedUrl
      ? variant.normalizedUrl
      : buildDownloadKey(variant?.url || "");

  return {
    ...variant,
    id:
      typeof variant?.id === "string" && variant.id
        ? variant.id
        : normalizedUrl
          ? `variant-${normalizedUrl}`
          : "variant-unknown",
    normalizedUrl,
    quality: normalizeQuality(variant?.quality, variant?.url || "", variant?.type || ""),
    variantOrder:
      typeof variant?.variantOrder === "number" && Number.isFinite(variant.variantOrder)
        ? variant.variantOrder
        : 0
  };
}

function sortVariants(variants) {
  return (Array.isArray(variants) ? variants : [])
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

function buildGroupKey(candidate) {
  const explicit = candidate?.id;
  if (typeof explicit === "string" && explicit.trim()) {
    return explicit;
  }

  if (typeof candidate?.elementIndex === "number" && candidate.elementIndex >= 0) {
    return `video-group-${candidate.elementIndex + 1}`;
  }

  const legacyUrlKey = buildDownloadKey(candidate?.url || "");
  if (legacyUrlKey) {
    return `video-group-${legacyUrlKey}`;
  }

  return "";
}

function buildVariantKey(variant) {
  const explicit = variant?.normalizedUrl;
  if (typeof explicit === "string" && explicit.trim()) {
    return explicit;
  }

  const url = variant?.url;
  if (typeof url !== "string" || !url.trim()) {
    return "";
  }

  return normalizeCandidateUrl(url);
}

function normalizeCandidateUrl(inputUrl) {
  let parsedUrl;
  try {
    parsedUrl = new URL(inputUrl);
  } catch (error) {
    return "";
  }

  if (!["http:", "https:"].includes(parsedUrl.protocol)) {
    return "";
  }

  const normalized = new URL(parsedUrl.href);
  sanitizeTrackingParams(normalized.searchParams);
  normalized.searchParams.sort();
  normalized.hash = "";
  return normalized.href;
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

async function persistToStorage() {
  const serializable = {
    initializedAt: state.initializedAt,
    lastSeenTabId: state.lastSeenTabId,
    videosByTabId: Object.fromEntries(state.videosByTabId.entries()),
    downloadsById: Object.fromEntries(state.downloadsById.entries()),
    downloadHistory: state.downloadHistory
  };

  await chrome.storage.session.set({ [SESSION_STORAGE_KEY]: serializable });
}

async function hydrateFromStorage() {
  const result = await chrome.storage.session.get(SESSION_STORAGE_KEY);
  const snapshot = result[SESSION_STORAGE_KEY];

  if (!snapshot || typeof snapshot !== "object") {
    return;
  }

  state.initializedAt =
    typeof snapshot.initializedAt === "number"
      ? snapshot.initializedAt
      : state.initializedAt;
  state.lastSeenTabId =
    typeof snapshot.lastSeenTabId === "number" ? snapshot.lastSeenTabId : null;

  if (snapshot.videosByTabId && typeof snapshot.videosByTabId === "object") {
    state.videosByTabId = new Map(
      Object.entries(snapshot.videosByTabId).map(([tabId, value]) => [
        Number(tabId),
        {
          videos: rankCandidates(Array.isArray(value?.videos) ? value.videos : []),
          pageContext: value?.pageContext || null,
          lastUpdatedAt:
            typeof value?.lastUpdatedAt === "number" ? value.lastUpdatedAt : 0
        }
      ])
    );
  }

  if (snapshot.downloadsById && typeof snapshot.downloadsById === "object") {
    state.downloadsById = new Map(
      Object.entries(snapshot.downloadsById)
        .map(([downloadId, value]) => {
          const parsedDownloadId = Number(downloadId);
          if (!Number.isFinite(parsedDownloadId)) {
            return null;
          }

          const normalizedUrl = typeof value?.url === "string" ? value.url : "";
          const downloadKey =
            typeof value?.downloadKey === "string" && value.downloadKey
              ? value.downloadKey
              : buildDownloadKey(normalizedUrl);

          return [
            parsedDownloadId,
            {
              downloadId: parsedDownloadId,
              candidateId: typeof value?.candidateId === "string" ? value.candidateId : "",
              variantId: typeof value?.variantId === "string" ? value.variantId : "",
              qualityLabel: typeof value?.qualityLabel === "string" ? value.qualityLabel : "",
              tabId: typeof value?.tabId === "number" ? value.tabId : null,
              url: normalizedUrl,
              filename: typeof value?.filename === "string" ? value.filename : "",
              status: typeof value?.status === "string" ? value.status : DOWNLOAD_STATUS.STARTED,
              timestamp: typeof value?.timestamp === "number" ? value.timestamp : Date.now(),
              downloadKey
            }
          ];
        })
        .filter(Boolean)
    );
  }

  if (Array.isArray(snapshot.downloadHistory)) {
    state.downloadHistory = snapshot.downloadHistory
      .map((entry) => {
        const normalizedUrl = typeof entry?.url === "string" ? entry.url : "";
        const downloadKey =
          typeof entry?.downloadKey === "string" && entry.downloadKey
            ? entry.downloadKey
            : buildDownloadKey(normalizedUrl);

        return {
          downloadId: typeof entry?.downloadId === "number" ? entry.downloadId : null,
          candidateId: typeof entry?.candidateId === "string" ? entry.candidateId : "",
          variantId: typeof entry?.variantId === "string" ? entry.variantId : "",
          qualityLabel: typeof entry?.qualityLabel === "string" ? entry.qualityLabel : "",
          tabId: typeof entry?.tabId === "number" ? entry.tabId : null,
          filename: typeof entry?.filename === "string" ? entry.filename : "",
          url: normalizedUrl,
          timestamp: typeof entry?.timestamp === "number" ? entry.timestamp : Date.now(),
          status: typeof entry?.status === "string" ? entry.status : DOWNLOAD_STATUS.STARTED,
          downloadKey
        };
      })
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, MAX_DOWNLOAD_HISTORY);
  }
}

async function triggerDownload(url, filename) {
  return new Promise((resolve, reject) => {
    chrome.downloads.download(
      {
        url,
        filename,
        saveAs: false,
        conflictAction: "uniquify"
      },
      (downloadId) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }

        if (typeof downloadId !== "number") {
          reject(new Error("Downloads API returned an invalid download id."));
          return;
        }

        resolve(downloadId);
      }
    );
  });
}
