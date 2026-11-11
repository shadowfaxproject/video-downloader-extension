// background.js - Service worker: stream sniffing, multi-job HLS orchestration

const tabMediaMap = new Map();    // tabId -> Map(url -> mediaItem)
const activeJobs  = new Map();    // downloadId -> job

const VIDEO_EXT_REGEX = /\.(mp4|webm|mkv|mov|m4v|ogv)(\?.*)?$/i;
const HLS_REGEX       = /\.m3u8(\?.*)?$/i;
const MAX_CONCURRENT  = 10;

let jobCounter = 0;
function newDownloadId() { return `dl-${Date.now()}-${++jobCounter}`; }

// ── Keep-alive ──────────────────────────────────────────────────────────────
let keepAliveInterval = null;

function ensureKeepAlive() {
  if (!keepAliveInterval) {
    keepAliveInterval = setInterval(() => chrome.runtime.getPlatformInfo(() => {}), 15000);
  }
}

function clearKeepAliveIfIdle() {
  const hasActive = [...activeJobs.values()].some(j => j.status === "downloading");
  if (!hasActive && keepAliveInterval) {
    clearInterval(keepAliveInterval);
    keepAliveInterval = null;
  }
}

// ── Offscreen document (single, shared for all concurrent jobs) ──────────────
// Create/close are serialized through offscreenOpChain so a job starting up can
// never race a different job's teardown of the shared document (see: a job
// could see offscreenReady=true, skip creating a doc, and send its work to a
// document that's mid-close — silently losing that job).
let offscreenReady = false;
let offscreenOpChain = Promise.resolve();

function withOffscreenLock(fn) {
  const result = offscreenOpChain.then(fn, fn);
  offscreenOpChain = result.catch(() => {});
  return result;
}

function ensureOffscreenDocument() {
  return withOffscreenLock(async () => {
    if (offscreenReady) {
      const exists = await chrome.offscreen.hasDocument().catch(() => false);
      if (exists) return;
      offscreenReady = false;
    }

    try {
      await chrome.offscreen.createDocument({
        url: "offscreen/offscreen.html",
        reasons: ["BLOBS"],
        justification: "Assemble video stream segments and create downloadable Blob ObjectURL"
      });
      offscreenReady = true;
    } catch (err) {
      if (err.message && err.message.includes("Only a single offscreen document")) {
        offscreenReady = true; // already exists
      } else {
        throw err;
      }
    }
  });
}

function closeOffscreenIfIdle() {
  return withOffscreenLock(async () => {
    const hasActive = [...activeJobs.values()].some(j => j.status === "downloading");
    if (!hasActive && offscreenReady) {
      try {
        const exists = await chrome.offscreen.hasDocument().catch(() => false);
        if (exists) await chrome.offscreen.closeDocument();
      } catch {}
      offscreenReady = false;
    }
  });
}

// ── Badge helpers ────────────────────────────────────────────────────────────
function refreshBadge(tabId) {
  const tabJobs = [...activeJobs.values()].filter(j => j.tabId === tabId);
  const downloading = tabJobs.filter(j => j.status === "downloading");

  if (downloading.length === 0) {
    // Show media count or clear
    const mediaList = tabMediaMap.get(tabId);
    const count = mediaList ? [...mediaList.values()].filter(m => !m.isSegment).length : 0;
    chrome.action.setBadgeText({ tabId, text: count > 0 ? String(count) : "" }).catch(() => {});
    chrome.action.setBadgeBackgroundColor({ tabId, color: "#2563EB" }).catch(() => {});
    return;
  }

  // Show overall average progress
  const avgPct = Math.round(downloading.reduce((s, j) => s + j.progress.percent, 0) / downloading.length);
  chrome.action.setBadgeText({ tabId, text: `${avgPct}%` }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ tabId, color: "#2563EB" }).catch(() => {});
}

// ── webRequest sniffing ──────────────────────────────────────────────────────
chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (details.tabId <= 0 || (details.statusCode && details.statusCode >= 400)) return;

    const ctHeader  = details.responseHeaders?.find(h => h.name.toLowerCase() === "content-type");
    const clHeader  = details.responseHeaders?.find(h => h.name.toLowerCase() === "content-length");
    const contentType = ctHeader?.value?.toLowerCase() || "";

    const isHls      = contentType.includes("mpegurl") || HLS_REGEX.test(details.url);
    const isVideoType= contentType.startsWith("video/");
    const isVideoExt = VIDEO_EXT_REGEX.test(details.url);

    if (!isVideoType && !isVideoExt && !isHls) return;

    const sizeBytes = clHeader ? parseInt(clHeader.value, 10) : null;
    if (sizeBytes === 0) return;
    if (!isHls && sizeBytes !== null && sizeBytes < 51200) return;

    const isSegment = /\.(ts|m4s)(\?.*)?$/i.test(details.url);

    if (!tabMediaMap.has(details.tabId)) tabMediaMap.set(details.tabId, new Map());
    tabMediaMap.get(details.tabId).set(details.url, {
      url: details.url,
      type: isHls ? "application/x-mpegURL" : (contentType || "video/mp4"),
      isHls, isSegment,
      sizeBytes,
      referer: details.initiator || null,
      detectedAt: Date.now()
    });

    const hasDownloading = [...activeJobs.values()]
      .some(j => j.tabId === details.tabId && j.status === "downloading");

    if (!hasDownloading) refreshBadge(details.tabId);
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders"]
);

// ── Tab lifecycle ─────────────────────────────────────────────────────────────
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") {
    tabMediaMap.delete(tabId);
    for (const [id, job] of activeJobs) {
      if (job.tabId === tabId && job.status === "downloading") {
        job.status = "cancelled";
        activeJobs.delete(id);
        if (job.type === "direct" && job.chromeDownloadId) {
          chrome.downloads.cancel(job.chromeDownloadId, () => {});
        } else {
          chrome.runtime.sendMessage({
            type: "OFFSCREEN_CANCEL_HLS",
            downloadId: id,
            tabId
          }).catch(() => {});
        }
      }
    }
    chrome.action.setBadgeText({ tabId, text: "" }).catch(() => {});
    clearKeepAliveIfIdle();
    closeOffscreenIfIdle();
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabMediaMap.delete(tabId);
  for (const [id, job] of activeJobs) {
    if (job.tabId === tabId) {
      job.status = "cancelled";
      activeJobs.delete(id);
      if (job.type === "direct" && job.chromeDownloadId) {
        chrome.downloads.cancel(job.chromeDownloadId, () => {});
      } else {
        chrome.runtime.sendMessage({
          type: "OFFSCREEN_CANCEL_HLS",
          downloadId: id,
          tabId
        }).catch(() => {});
      }
    }
  }
  clearKeepAliveIfIdle();
  closeOffscreenIfIdle();
});

// ── Message router ────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const senderTabId = sender.tab?.id || null;

  // ── Video detected by content script ──
  if (message.type === "VIDEO_DETECTED") {
    const tid = senderTabId || message.tabId;
    const hasDownloading = [...activeJobs.values()]
      .some(j => j.tabId === tid && j.status === "downloading");
    if (tid && !hasDownloading) {
      chrome.action.setBadgeText({ tabId: tid, text: "1" }).catch(() => {});
      chrome.action.setBadgeBackgroundColor({ tabId: tid, color: "#2563EB" }).catch(() => {});
    }
    sendResponse({ status: "ok" });
  }

  // ── Popup queries network-sniffed videos ──
  else if (message.type === "GET_NETWORK_VIDEOS") {
    const media = tabMediaMap.has(message.tabId)
      ? [...tabMediaMap.get(message.tabId).values()].sort((a, b) => {
          if (a.isHls && !b.isHls) return -1;
          if (!a.isHls && b.isHls) return 1;
          if (a.isSegment && !b.isSegment) return 1;
          if (!a.isSegment && b.isSegment) return -1;
          return (b.sizeBytes || 0) - (a.sizeBytes || 0);
        })
      : [];
    sendResponse({ videos: media });
  }

  // ── Popup queries all active download jobs ──
  else if (message.type === "GET_ALL_JOBS") {
    const jobs = [...activeJobs.values()]
      .filter(j => j.tabId === message.tabId)
      .map(j => ({
        downloadId: j.downloadId,
        filename: j.filename,
        status: j.status,
        progress: j.progress,
        error: j.error || null
      }));
    sendResponse({ jobs });
  }

  // ── Popup starts a direct (non-HLS) download ──
  else if (message.type === "DOWNLOAD_VIDEO") {
    const { url, filename, referer, tabId } = message;

    if (!url || url.startsWith("blob:")) {
      sendResponse({ success: false, error: url ? "Blob URLs are not downloadable directly." : "No URL provided." });
      return true;
    }

    let safeFilename = (filename || "video").replace(/[\\/:*?"<>|]/g, "_").trim().replace(/\.m3u8$/i, "");
    console.log("[Background] OFFSCREEN_BLOB_READY filename:", filename, "→ safe:", safeFilename);
    if (!/\.[a-zA-Z0-9]{2,5}$/.test(safeFilename)) {
      safeFilename += ".mp4";
    }
    console.log("[Background] final safeFilename for download:", safeFilename);

    const opts = {
      url,
      filename: safeFilename,
      saveAs: false
    };
    if (referer) opts.headers = [{ name: "Referer", value: referer }];

    const downloadId = newDownloadId();
    const effectiveTabId = tabId || senderTabId;
    const job = {
      downloadId,
      tabId: effectiveTabId,
      url,
      filename: opts.filename,
      type: "direct",
      chromeDownloadId: null,
      status: "downloading",
      progress: { current: 0, total: 100, percent: 0, bytes: 0, stage: "downloading" },
      startedAt: Date.now()
    };
    if (effectiveTabId) activeJobs.set(downloadId, job);

    chrome.downloads.download(opts, (dlId) => {
      if (chrome.runtime.lastError) {
        if (effectiveTabId) activeJobs.delete(downloadId);
        sendResponse({ success: false, error: chrome.runtime.lastError.message });
      } else {
        job.chromeDownloadId = dlId;
        sendResponse({ success: true, downloadId, chromeDownloadId: dlId });
      }
    });
    return true;
  }

  // ── Popup starts an HLS background download ──
  else if (message.type === "START_HLS_DOWNLOAD") {
    const activeCount = [...activeJobs.values()].filter(j => j.status === "downloading").length;
    if (activeCount >= MAX_CONCURRENT) {
      sendResponse({ success: false, error: `Max ${MAX_CONCURRENT} concurrent downloads reached.` });
      return true;
    }

    const downloadId = newDownloadId();
    const job = {
      downloadId,
      tabId: message.tabId,
      url: message.url,
      filename: message.filename,
      referer: message.referer,
      type: "hls",
      status: "downloading",
      progress: { current: 0, total: 0, percent: 0, bytes: 0, stage: "init" },
      error: null,
      startedAt: Date.now()
    };
    activeJobs.set(downloadId, job);
    ensureKeepAlive();
    refreshBadge(message.tabId);

    ensureOffscreenDocument().then(() => {
      chrome.runtime.sendMessage({
        type: "OFFSCREEN_START_HLS",
        downloadId,
        tabId: message.tabId,
        url: message.url,
        filename: message.filename,
        referer: message.referer
      }).catch(err => {
        console.error("[Background] offscreen message failed:", err);
        job.status = "error";
        job.error = err.message;
        clearKeepAliveIfIdle();
        closeOffscreenIfIdle();
      });
    }).catch(err => {
      console.error("[Background] offscreen creation failed:", err);
      job.status = "error";
      job.error = err.message;
      clearKeepAliveIfIdle();
    });

    sendResponse({ success: true, downloadId });
  }

  // ── Cancel active download ──
  else if (message.type === "CANCEL_DOWNLOAD") {
    const { downloadId, tabId } = message;
    let targetJobs = [];

    if (downloadId && activeJobs.has(downloadId)) {
      targetJobs.push(activeJobs.get(downloadId));
    } else if (tabId) {
      targetJobs = [...activeJobs.values()].filter(j => j.tabId === tabId && j.status === "downloading");
    }

    for (const job of targetJobs) {
      job.status = "cancelled";
      if (job.type === "direct" && job.chromeDownloadId) {
        chrome.downloads.cancel(job.chromeDownloadId, () => {
          chrome.downloads.erase({ id: job.chromeDownloadId }, () => {});
        });
      } else {
        chrome.runtime.sendMessage({
          type: "OFFSCREEN_CANCEL_HLS",
          downloadId: job.downloadId,
          tabId: job.tabId
        }).catch(() => {});
      }
      activeJobs.delete(job.downloadId);
    }

    const tid = tabId || targetJobs[0]?.tabId;
    if (tid) refreshBadge(tid);
    clearKeepAliveIfIdle();
    closeOffscreenIfIdle();

    chrome.runtime.sendMessage({
      type: "DOWNLOAD_CANCELLED",
      downloadId,
      tabId: tid
    }).catch(() => {});

    sendResponse({ success: true });
    return true;
  }

  // ── Offscreen: progress update ──
  else if (message.type === "HLS_PROGRESS_UPDATE") {
    const job = activeJobs.get(message.downloadId);
    if (job) {
      job.progress = message.progress;
      refreshBadge(job.tabId);
    }
    // Forward to popup (if open)
    chrome.runtime.sendMessage({ ...message }).catch(() => {});
  }

  // ── Offscreen: blob ready → trigger chrome.downloads ──
  else if (message.type === "OFFSCREEN_BLOB_READY") {
    const { downloadId, tabId, blobUrl, filename, sizeBytes } = message;

    let safeFilename = (filename || "video").replace(/[\\/:*?"<>|]/g, "_").trim().replace(/\.m3u8$/i, "");
    console.log("[Background] OFFSCREEN_BLOB_READY filename:", filename, "→ safe:", safeFilename);
    if (!/\.[a-zA-Z0-9]{2,5}$/.test(safeFilename)) {
      safeFilename += ".mp4";
    }
    console.log("[Background] final safeFilename for download:", safeFilename);

    chrome.downloads.download({ url: blobUrl, filename: safeFilename, saveAs: false }, (dlId) => {
      const job = activeJobs.get(downloadId);

      if (chrome.runtime.lastError) {
        const err = chrome.runtime.lastError.message;
        if (job) { job.status = "error"; job.error = err; }
        chrome.runtime.sendMessage({ type: "HLS_ERROR", downloadId, tabId, error: err }).catch(() => {});
      } else {
        if (job) { job.status = "completed"; job.progress.percent = 100; job.sizeBytes = sizeBytes; }
        chrome.runtime.sendMessage({ type: "HLS_COMPLETED", downloadId, tabId, filename, sizeBytes }).catch(() => {});
        // Remove completed job after 8 s so popup queue clears automatically
        setTimeout(() => activeJobs.delete(downloadId), 8000);
      }

      refreshBadge(tabId);
      clearKeepAliveIfIdle();
      closeOffscreenIfIdle();
      setTimeout(() => { try { URL.revokeObjectURL(blobUrl); } catch {} }, 60000);
    });
  }

  // ── Offscreen: download cancelled ──
  else if (message.type === "HLS_CANCELLED") {
    const job = activeJobs.get(message.downloadId);
    if (job) { job.status = "cancelled"; activeJobs.delete(message.downloadId); }
    if (message.tabId) refreshBadge(message.tabId);
    chrome.runtime.sendMessage({ type: "DOWNLOAD_CANCELLED", ...message }).catch(() => {});
    clearKeepAliveIfIdle();
    closeOffscreenIfIdle();
  }

  // ── Offscreen: download error ──
  else if (message.type === "HLS_ERROR") {
    const job = activeJobs.get(message.downloadId);
    if (job) { job.status = "error"; job.error = message.error; }
    if (message.tabId) refreshBadge(message.tabId);
    chrome.runtime.sendMessage({ ...message }).catch(() => {});
    clearKeepAliveIfIdle();
    closeOffscreenIfIdle();
  }

  return true;
});
