// background.js - Service worker for media stream sniffing and background download execution
importScripts("hlsDownloader.js");

// Tab-based cache of detected media streams: tabId -> Map(url -> mediaItem)
const tabMediaMap = new Map();

// Active HLS background download jobs: tabId -> job state
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

// Background HLS downloader and segment assembler
async function runHlsDownload(tabId, url, filename, referer) {
  const job = {
    tabId,
    url,
    filename,
    status: "downloading",
    progress: { current: 0, total: 0, percent: 0, bytes: 0, stage: "init" },
    error: null,
    startedAt: Date.now()
  };
  activeHlsJobs.set(tabId, job);
  ensureKeepAlive();

  chrome.action.setBadgeText({ tabId, text: "0%" }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ tabId, color: "#2563EB" }).catch(() => {});

  try {
    const result = await assembleHlsStream(url, {
      referer: referer,
      onProgress: (progress) => {
        job.progress = progress;
        const pctText = `${progress.percent}%`;
        chrome.action.setBadgeText({ tabId, text: pctText }).catch(() => {});

        // Broadcast to popup if open
        chrome.runtime.sendMessage({
          type: "HLS_PROGRESS_UPDATE",
          tabId,
          progress
        }).catch(() => {});
      }
    });

    if (!result.blob || result.blob.size === 0) {
      throw new Error("Assembled stream is empty (0 bytes received).");
    }

    job.status = "completed";
    job.progress.percent = 100;
    job.sizeBytes = result.sizeBytes;

    chrome.action.setBadgeText({ tabId, text: "100%" }).catch(() => {});
    chrome.action.setBadgeBackgroundColor({ tabId, color: "#10B981" }).catch(() => {});

    const blobUrl = URL.createObjectURL(result.blob);
    const finalFilename = filename.replace(/\.(ts|mp4|m3u8)$/i, "") + `.${result.extension}`;

    chrome.downloads.download(
      {
        url: blobUrl,
        filename: finalFilename,
        saveAs: true
      },
      (dlId) => {
        if (chrome.runtime.lastError) {
          console.error("Save error:", chrome.runtime.lastError.message);
        }
        setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
      }
    );

    // Reset badge after 5 seconds
    setTimeout(() => {
      if (activeHlsJobs.get(tabId)?.status === "completed") {
        chrome.action.setBadgeText({ tabId, text: "" }).catch(() => {});
      }
    }, 5000);

    chrome.runtime.sendMessage({
      type: "HLS_COMPLETED",
      tabId,
      filename: finalFilename,
      sizeBytes: result.sizeBytes
    }).catch(() => {});

  } catch (err) {
    console.error("[HLS Download Error]:", err);
    job.status = "error";
    job.error = err.message;
    chrome.action.setBadgeText({ tabId, text: "ERR" }).catch(() => {});
    chrome.action.setBadgeBackgroundColor({ tabId, color: "#EF4444" }).catch(() => {});

    chrome.runtime.sendMessage({
      type: "HLS_ERROR",
      tabId,
      error: err.message
    }).catch(() => {});
  } finally {
    clearKeepAliveIfIdle();
  }
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

      // Update badge only if not currently actively downloading
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
    activeHlsJobs.delete(tabId);
    chrome.action.setBadgeText({ tabId: tabId, text: "" }).catch(() => {});
  }
});

// Clean up cache when tab is closed
chrome.tabs.onRemoved.addListener((tabId) => {
  tabMediaMap.delete(tabId);
  activeHlsJobs.delete(tabId);
});

// Message listener
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = sender.tab ? sender.tab.id : null;

  if (message.type === "VIDEO_DETECTED") {
    const targetTabId = tabId || message.tabId;
    const activeJob = activeHlsJobs.get(targetTabId);
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
    const job = activeHlsJobs.get(requestedTabId) || null;
    sendResponse({ job });
  }

  else if (message.type === "START_HLS_DOWNLOAD") {
    const { url, filename, referer, tabId: requestedTabId } = message;
    runHlsDownload(requestedTabId, url, filename, referer);
    sendResponse({ success: true });
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
