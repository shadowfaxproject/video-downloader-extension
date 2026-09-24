// background.js - Service worker for media stream sniffing and download orchestration

// Tab-based cache of detected media streams: tabId -> Map(url -> mediaItem)
const tabMediaMap = new Map();

// Active HLS background download jobs: jobId -> job state
const activeHlsJobs = new Map();

// Regex matching direct video file formats
const VIDEO_EXT_REGEX = /\.(mp4|webm|mkv|mov|m4v|ogv)(\?.*)?$/i;
const HLS_REGEX = /\.m3u8(\?.*)?$/i;

// Keep-alive mechanism to prevent service worker termination during downloads
let keepAliveInterval = null;

function ensureKeepAlive() {
  if (!keepAliveInterval) {
    keepAliveInterval = setInterval(() => {
      chrome.runtime.getPlatformInfo(() => {});
    }, 15000);
  }
}

function clearKeepAliveIfIdle() {
  let hasActive = false;
  for (const job of activeHlsJobs.values()) {
    if (job.status === "downloading") {
      hasActive = true;
      break;
    }
  }
  if (!hasActive && keepAliveInterval) {
    clearInterval(keepAliveInterval);
    keepAliveInterval = null;
  }
}

// Ensure dedicated offscreen document exists for DOM operations (Blob & createObjectURL)
let creatingOffscreenPromise = null;

async function ensureOffscreenDocument() {
  const offscreenPath = "offscreen/offscreen.html";

  if (chrome.offscreen && chrome.offscreen.hasDocument) {
    if (await chrome.offscreen.hasDocument()) return;
  }

  if (creatingOffscreenPromise) {
    await creatingOffscreenPromise;
    return;
  }

  creatingOffscreenPromise = (async () => {
    try {
      await chrome.offscreen.createDocument({
        url: offscreenPath,
        reasons: ["BLOBS"],
        justification: "Assemble video stream and create download blob ObjectURL"
      });
    } catch (err) {
      if (!err.message.includes("Only a single offscreen document may be created")) {
        throw err;
      }
    } finally {
      creatingOffscreenPromise = null;
    }
  })();

  await creatingOffscreenPromise;
}

// Filter and record valid media responses
chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (details.tabId <= 0 || (details.statusCode && details.statusCode >= 400)) {
      return;
    }

    const contentTypeHeader = details.responseHeaders?.find(
      (h) => h.name.toLowerCase() === "content-type"
    );
    const contentLengthHeader = details.responseHeaders?.find(
      (h) => h.name.toLowerCase() === "content-length"
    );

    const contentType = contentTypeHeader?.value?.toLowerCase() || "";
    const isHls = contentType.includes("mpegurl") || HLS_REGEX.test(details.url);
    const isVideoType = contentType.startsWith("video/");
    const isVideoExt = VIDEO_EXT_REGEX.test(details.url);

    if (isVideoType || isVideoExt || isHls) {
      const sizeBytes = contentLengthHeader ? parseInt(contentLengthHeader.value, 10) : null;

      // Filter out 0-byte or tiny asset responses (< 50KB for non-HLS)
      if (sizeBytes === 0) return;
      if (!isHls && sizeBytes !== null && sizeBytes < 51200) return;

      const isSegmentChunk = /\.(ts|m4s)(\?.*)?$/i.test(details.url);

      if (!tabMediaMap.has(details.tabId)) {
        tabMediaMap.set(details.tabId, new Map());
      }

      const mediaList = tabMediaMap.get(details.tabId);

      mediaList.set(details.url, {
        url: details.url,
        type: isHls ? "application/x-mpegURL" : (contentType || "video/mp4"),
        isHls: isHls,
        isSegment: isSegmentChunk,
        sizeBytes: sizeBytes,
        referer: details.initiator || null,
        detectedAt: Date.now()
      });

      // Update badge only if not currently downloading
      const activeJob = activeHlsJobs.get(details.tabId);
      if (!activeJob || activeJob.status !== "downloading") {
        let primaryMediaCount = 0;
        for (const item of mediaList.values()) {
          if (!item.isSegment) primaryMediaCount++;
        }
        if (primaryMediaCount > 0) {
          chrome.action.setBadgeText({ tabId: details.tabId, text: String(primaryMediaCount) }).catch(() => {});
          chrome.action.setBadgeBackgroundColor({ tabId: details.tabId, color: "#2563EB" }).catch(() => {});
        }
      }
    }
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders"]
);

// Reset media cache on page navigation
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") {
    tabMediaMap.delete(tabId);
    for (const [jobId, job] of activeHlsJobs.entries()) {
      if (job.tabId === tabId) {
        activeHlsJobs.delete(jobId);
      }
    }
    chrome.action.setBadgeText({ tabId: tabId, text: "" }).catch(() => {});
  }
});

// Clean up cache when tab is closed
chrome.tabs.onRemoved.addListener((tabId) => {
  tabMediaMap.delete(tabId);
  for (const [jobId, job] of activeHlsJobs.entries()) {
    if (job.tabId === tabId) {
      activeHlsJobs.delete(jobId);
    }
  }
});

// Message listener
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = sender.tab ? sender.tab.id : null;

  if (message.type === "VIDEO_DETECTED") {
    const targetTabId = tabId || message.tabId;
    const activeJob = Array.from(activeHlsJobs.values()).find(
      j => j.tabId === targetTabId && j.status === "downloading"
    );
    if (targetTabId && (!activeJob || activeJob.status !== "downloading")) {
      chrome.action.setBadgeText({ tabId: targetTabId, text: "1" }).catch(() => {});
      chrome.action.setBadgeBackgroundColor({ tabId: targetTabId, color: "#2563EB" }).catch(() => {});
    }
    sendResponse({ status: "ok" });
  }

  else if (message.type === "GET_NETWORK_VIDEOS") {
    const requestedTabId = message.tabId;
    let media = [];
    if (tabMediaMap.has(requestedTabId)) {
      media = Array.from(tabMediaMap.get(requestedTabId).values());
      media.sort((a, b) => {
        if (a.isHls && !b.isHls) return -1;
        if (!a.isHls && b.isHls) return 1;
        if (a.isSegment && !b.isSegment) return 1;
        if (!a.isSegment && b.isSegment) return -1;
        return (b.sizeBytes || 0) - (a.sizeBytes || 0);
      });
    }
    sendResponse({ videos: media });
  }

  else if (message.type === "GET_HLS_STATUS") {
    const requestedTabId = message.tabId;
    const url = message.url;
    let job = null;
    if (url) {
      job = Array.from(activeHlsJobs.values())
        .filter(j => j.tabId === requestedTabId && j.url === url)
        .sort((a, b) => b.startedAt - a.startedAt)[0] || null;
    } else {
      job = Array.from(activeHlsJobs.values())
        .filter(j => j.tabId === requestedTabId && j.status === "downloading")
        .sort((a, b) => b.startedAt - a.startedAt)[0] || null;
      if (!job) {
        job = Array.from(activeHlsJobs.values())
          .filter(j => j.tabId === requestedTabId)
          .sort((a, b) => b.startedAt - a.startedAt)[0] || null;
      }
    }
    sendResponse({ job });
  }

  else if (message.type === "START_HLS_DOWNLOAD") {
    const { url, filename, referer, tabId: requestedTabId } = message;
    const jobId = typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${requestedTabId}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    const job = {
      jobId,
      tabId: requestedTabId,
      url,
      filename,
      status: "downloading",
      progress: { current: 0, total: 0, percent: 0, bytes: 0, stage: "init" },
      error: null,
      startedAt: Date.now()
    };
    activeHlsJobs.set(jobId, job);
    ensureKeepAlive();

    chrome.action.setBadgeText({ tabId: requestedTabId, text: "0%" }).catch(() => {});
    chrome.action.setBadgeBackgroundColor({ tabId: requestedTabId, color: "#2563EB" }).catch(() => {});

    // Spin up offscreen document to handle DOM Blob creation & assembly
    ensureOffscreenDocument().then(() => {
      chrome.runtime.sendMessage({
        type: "OFFSCREEN_START_HLS",
        jobId,
        tabId: requestedTabId,
        url,
        filename,
        referer
      }).catch((err) => {
        console.error("[Background] Failed to send job to offscreen document:", err);
      });
    }).catch((err) => {
      console.error("[Background] Offscreen creation error:", err);
      job.status = "error";
      job.error = err.message;
      clearKeepAliveIfIdle();
    });

    sendResponse({ success: true, jobId });
  }

  else if (message.type === "OFFSCREEN_BLOB_READY") {
    const { jobId, tabId, url, blobUrl, filename, sizeBytes } = message;

    chrome.downloads.download(
      {
        url: blobUrl,
        filename: filename,
        saveAs: true
      },
      (downloadId) => {
        if (chrome.runtime.lastError) {
          const err = chrome.runtime.lastError.message;
          console.error("[Background] Download trigger failed:", err);
          const job = activeHlsJobs.get(jobId);
          if (job) {
            job.status = "error";
            job.error = err;
          }
          chrome.action.setBadgeText({ tabId, text: "ERR" }).catch(() => {});
          chrome.action.setBadgeBackgroundColor({ tabId, color: "#EF4444" }).catch(() => {});
          chrome.runtime.sendMessage({
            type: "HLS_ERROR",
            jobId,
            tabId,
            url,
            error: err
          }).catch(() => {});
        } else {
          const job = activeHlsJobs.get(jobId);
          if (job) {
            job.status = "completed";
            job.progress.percent = 100;
            job.sizeBytes = sizeBytes;
          }
          chrome.action.setBadgeText({ tabId, text: "100%" }).catch(() => {});
          chrome.action.setBadgeBackgroundColor({ tabId, color: "#10B981" }).catch(() => {});

          chrome.runtime.sendMessage({
            type: "HLS_COMPLETED",
            jobId,
            tabId,
            url,
            filename,
            sizeBytes
          }).catch(() => {});

          setTimeout(() => {
            if (activeHlsJobs.get(jobId)?.status === "completed") {
              const hasActiveOnTab = Array.from(activeHlsJobs.values()).some(
                j => j.tabId === tabId && j.status === "downloading"
              );
              if (!hasActiveOnTab) {
                chrome.action.setBadgeText({ tabId, text: "" }).catch(() => {});
              }
            }
          }, 5000);
        }

        clearKeepAliveIfIdle();
      }
    );
  }

  else if (message.type === "HLS_PROGRESS_UPDATE") {
    const job = activeHlsJobs.get(message.jobId);
    if (job) {
      job.progress = message.progress;
      const pctText = `${message.progress.percent}%`;
      chrome.action.setBadgeText({ tabId: message.tabId, text: pctText }).catch(() => {});
    }
  }

  else if (message.type === "HLS_COMPLETED") {
    const job = activeHlsJobs.get(message.jobId);
    if (job) {
      job.status = "completed";
      job.progress.percent = 100;
      job.sizeBytes = message.sizeBytes;
    }
    chrome.action.setBadgeText({ tabId: message.tabId, text: "100%" }).catch(() => {});
    chrome.action.setBadgeBackgroundColor({ tabId: message.tabId, color: "#10B981" }).catch(() => {});

    setTimeout(() => {
      if (activeHlsJobs.get(message.jobId)?.status === "completed") {
        const hasActiveOnTab = Array.from(activeHlsJobs.values()).some(
          j => j.tabId === message.tabId && j.status === "downloading"
        );
        if (!hasActiveOnTab) {
          chrome.action.setBadgeText({ tabId: message.tabId, text: "" }).catch(() => {});
        }
      }
    }, 5000);

    clearKeepAliveIfIdle();
  }

  else if (message.type === "HLS_ERROR") {
    const job = activeHlsJobs.get(message.jobId);
    if (job) {
      job.status = "error";
      job.error = message.error;
    }
    chrome.action.setBadgeText({ tabId: message.tabId, text: "ERR" }).catch(() => {});
    chrome.action.setBadgeBackgroundColor({ tabId: message.tabId, color: "#EF4444" }).catch(() => {});
    clearKeepAliveIfIdle();
  }

  else if (message.type === "DOWNLOAD_VIDEO") {
    const { url, filename, referer } = message;

    if (!url) {
      sendResponse({ success: false, error: "No video URL found." });
      return true;
    }

    if (url.startsWith("blob:")) {
      sendResponse({
        success: false,
        error: "This site uses dynamic streaming. Please play the video to capture stream segments."
      });
      return true;
    }

    const safeFilename = (filename || "video.mp4")
      .replace(/[\\/:*?"<>|]/g, "_")
      .trim();

    const downloadOptions = {
      url: url,
      filename: safeFilename,
      saveAs: true
    };

    if (referer) {
      downloadOptions.headers = [
        { name: "Referer", value: referer }
      ];
    }

    try {
      chrome.downloads.download(downloadOptions, (downloadId) => {
        if (chrome.runtime.lastError) {
          const err = chrome.runtime.lastError.message;
          console.error("[Video Downloader] Download failed:", err);
          sendResponse({ success: false, error: err });
        } else {
          sendResponse({ success: true, downloadId });
        }
      });
    } catch (err) {
      sendResponse({ success: false, error: err.message });
    }

    return true;
  }

  return true;
});
