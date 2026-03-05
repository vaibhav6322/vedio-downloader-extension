import { MESSAGE_TYPES } from "../shared/messageTypes.js";

const statusText = document.getElementById("statusText");
const videoList = document.getElementById("videoList");
const refreshButton = document.getElementById("refreshButton");
const downloadStatusText = document.getElementById("downloadStatusText");
const historyList = document.getElementById("downloadHistoryList");
const REFRESH_RELOAD_DELAY_MS = 200;
const STATUS_POLL_INTERVAL_MS = 1500;
let currentTabId = null;
let statusPollTimer = null;

refreshButton.addEventListener("click", handleRefreshClick);
chrome.tabs.onActivated.addListener(() => {
  loadPopupState();
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (tabId !== currentTabId) {
    return;
  }

  if (changeInfo.status === "complete" || typeof changeInfo.url === "string") {
    loadPopupState();
  }
});

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    stopStatusPolling();
    return;
  }

  startStatusPolling();
  loadPopupState({ silent: true });
});

loadPopupState();
startStatusPolling();

async function loadPopupState(options = {}) {
  const tabId = await getActiveTabId();
  currentTabId = tabId;

  if (typeof tabId !== "number") {
    setStatus("No active tab found.");
    renderEmpty();
    renderDownloadHistory([]);
    return;
  }

  if (!options.silent) {
    setStatus("Loading extension state...");
  }

  chrome.runtime.sendMessage(
    { type: MESSAGE_TYPES.POPUP_GET_STATE, payload: { tabId } },
    (response) => {
      if (chrome.runtime.lastError) {
        setStatus(`Error: ${chrome.runtime.lastError.message}`);
        renderEmpty();
        renderDownloadHistory([]);
        return;
      }

      if (!response?.ok) {
        setStatus("Background response was invalid.");
        renderEmpty();
        renderDownloadHistory([]);
        return;
      }

      const pageTitle = response?.pageContext?.title || "Unknown page";
      setStatus(`${response.status} (${pageTitle})`);
      renderVideoGroups(response.videos);
      renderDownloadHistory(response.recentDownloads);
    }
  );
}

async function handleRefreshClick() {
  const tabId = await getActiveTabId();
  currentTabId = tabId;

  if (typeof tabId !== "number") {
    setStatus("No active tab found.");
    renderEmpty();
    return;
  }

  setStatus("Refreshing video detection...");
  const refreshResult = await forceRescan(tabId);
  if (!refreshResult.ok) {
    setStatus(`Refresh failed: ${refreshResult.error}`);
    return;
  }

  setTimeout(() => {
    loadPopupState();
  }, REFRESH_RELOAD_DELAY_MS);
}

function forceRescan(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(
      tabId,
      {
        type: MESSAGE_TYPES.POPUP_FORCE_RESCAN,
        payload: { tabId }
      },
      (response) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }

        if (!response?.ok) {
          resolve({ ok: false, error: response?.error || "Rescan was rejected." });
          return;
        }

        resolve({ ok: true });
      }
    );
  });
}

function getActiveTabId() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (chrome.runtime.lastError) {
        resolve(null);
        return;
      }

      const tabId = tabs?.[0]?.id;
      resolve(typeof tabId === "number" ? tabId : null);
    });
  });
}

function renderVideoGroups(groups) {
  const list = Array.isArray(groups) ? groups : [];

  if (list.length === 0) {
    renderEmpty();
    return;
  }

  videoList.innerHTML = "";
  for (const group of list) {
    const item = document.createElement("li");
    item.className = "popup__item";

    const title = document.createElement("p");
    title.className = "popup__item-title";
    title.textContent = group?.pageTitle || `Video Group ${group?.ranking?.rank || ""}`;

    const subtitle = document.createElement("p");
    subtitle.className = "popup__item-subtitle";
    subtitle.textContent = group?.hostname || "Unknown host";

    const rank = document.createElement("p");
    rank.className = "popup__item-rank";
    const bestQuality = group?.ranking?.bestQualityLabel || "Unknown Quality";
    rank.textContent = `Priority #${group?.ranking?.rank || "-"} (${bestQuality})`;

    const variantsContainer = document.createElement("div");
    variantsContainer.className = "popup__variants";

    const variants = Array.isArray(group?.variants) ? group.variants : [];
    for (const variant of variants) {
      variantsContainer.append(
        buildVariantRow({
          groupId: group?.id || "",
          variant
        })
      );
    }

    item.append(title, subtitle, rank, variantsContainer);
    videoList.append(item);
  }
}

function buildVariantRow({ groupId, variant }) {
  const row = document.createElement("div");
  row.className = "popup__variant-row";

  const quality = document.createElement("span");
  quality.className = "popup__variant-quality";
  quality.textContent = variant?.quality?.label || "Unknown Quality";

  const statusBadge = document.createElement("span");
  const candidateStatus = normalizeCandidateStatus(variant?.downloadStatus);
  statusBadge.className = `popup__badge popup__badge--${candidateStatus.variant}`;
  statusBadge.textContent = candidateStatus.label;

  const downloadButton = document.createElement("button");
  downloadButton.type = "button";
  downloadButton.className = "popup__download-button";
  downloadButton.textContent = "Download";

  const isLocked = candidateStatus.variant === "downloading" || candidateStatus.variant === "completed";
  if (isLocked) {
    downloadButton.disabled = true;
  }

  downloadButton.addEventListener("click", () =>
    handleDownloadClick({
      candidateId: groupId,
      variantId: variant?.id || "",
      qualityLabel: variant?.quality?.label || "Unknown Quality",
      url: variant?.url || "",
      button: downloadButton
    })
  );

  row.append(quality, statusBadge, downloadButton);
  return row;
}

function renderDownloadHistory(downloads) {
  if (!historyList) {
    return;
  }

  const list = Array.isArray(downloads) ? downloads : [];
  if (list.length === 0) {
    historyList.innerHTML = '<li class="popup__empty">No recent download activity.</li>';
    return;
  }

  historyList.innerHTML = "";
  for (const item of list) {
    const row = document.createElement("li");
    row.className = "popup__history-item";

    const filename = document.createElement("p");
    filename.className = "popup__item-title";
    filename.textContent = item?.filename || item?.url || "Unknown file";

    const status = document.createElement("p");
    status.className = "popup__item-subtitle";
    const qualityText = item?.qualityLabel ? ` | ${item.qualityLabel}` : "";
    status.textContent = `Status: ${normalizeCandidateStatus(item?.status).label}${qualityText}`;

    row.append(filename, status);
    historyList.append(row);
  }
}

function normalizeCandidateStatus(status) {
  if (status === "completed") {
    return { label: "Completed", variant: "completed" };
  }

  if (status === "failed" || status === "interrupted") {
    return { label: "Failed", variant: "failed" };
  }

  if (status === "started") {
    return { label: "Downloading", variant: "downloading" };
  }

  return { label: "Ready", variant: "ready" };
}

function renderEmpty() {
  videoList.innerHTML = '<li class="popup__empty">No videos detected yet.</li>';
}

function setStatus(text) {
  statusText.textContent = text;
}

function setDownloadStatus(text) {
  if (!downloadStatusText) {
    return;
  }
  downloadStatusText.textContent = text;
}

function startStatusPolling() {
  stopStatusPolling();
  statusPollTimer = setInterval(() => {
    if (document.hidden) {
      return;
    }

    loadPopupState({ silent: true });
  }, STATUS_POLL_INTERVAL_MS);
}

function stopStatusPolling() {
  if (!statusPollTimer) {
    return;
  }

  clearInterval(statusPollTimer);
  statusPollTimer = null;
}

async function handleDownloadClick({ candidateId, variantId, qualityLabel, url, button }) {
  const tabId = await getActiveTabId();

  if (!button || typeof tabId !== "number") {
    setDownloadStatus("Download failed: active tab not found.");
    return;
  }

  currentTabId = tabId;
  button.disabled = true;
  const originalLabel = button.textContent;
  button.textContent = "Downloading...";
  setDownloadStatus(`Downloading ${qualityLabel}...`);

  chrome.runtime.sendMessage(
    {
      type: MESSAGE_TYPES.POPUP_DOWNLOAD_VARIANT_REQUEST,
      payload: { candidateId, variantId, url, tabId }
    },
    (response) => {
      button.disabled = false;
      button.textContent = originalLabel;

      if (chrome.runtime.lastError) {
        setDownloadStatus(`Download failed: ${chrome.runtime.lastError.message}`);
        return;
      }

      if (!response?.ok) {
        setDownloadStatus(`Download failed: ${response?.error || "Unknown error."}`);
        return;
      }

      setDownloadStatus(`Download started (${qualityLabel}): ${response.filename}`);
      loadPopupState({ silent: true });
      setTimeout(() => setDownloadStatus(""), 3500);
    }
  );
}
