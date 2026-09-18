// background.js - Service worker for media stream sniffing and download execution

// Tab-based cache of detected media streams: tabId -> Map(url -> mediaItem)
const tabMediaMap = new Map();

// Regex matching direct video file formats
const VIDEO_EXT_REGEX = /\.(mp4|webm|mkv|mov|m4v|ogv)(\?.*)?$/i;
const HLS_REGEX = /\.m3u8(\?.*)?$/i;

// Filter and record valid media responses
chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    // Only process valid responses (HTTP 200, 206)
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

      // STRICT FILTER: Ignore 0-byte responses or tiny asset pings (< 50KB for non-HLS)
      if (sizeBytes === 0) return;
      if (!isHls && sizeBytes !== null && sizeBytes < 51200) return;

      // Ignore single HLS segment chunks (.ts / .m4s) in the main list if they are just streaming fragments
      const isSegmentChunk = /\.(ts|m4s)(\?.*)?$/i.test(details.url);

      if (!tabMediaMap.has(details.tabId)) {
        tabMediaMap.set(details.tabId, new Map());
      }

      const mediaList = tabMediaMap.get(details.tabId);

      // Store media metadata
      mediaList.set(details.url, {
        url: details.url,
        type: isHls ? "application/x-mpegURL" : (contentType || "video/mp4"),
        isHls: isHls,
        isSegment: isSegmentChunk,
        sizeBytes: sizeBytes,
        referer: details.initiator || null,
        detectedAt: Date.now()
      });

      // Filter out isolated segments when counting for toolbar badge
      let primaryMediaCount = 0;
      for (const item of mediaList.values()) {
        if (!item.isSegment) primaryMediaCount++;
      }

      if (primaryMediaCount > 0) {
        chrome.action.setBadgeText({ tabId: details.tabId, text: String(primaryMediaCount) }).catch(() => {});
        chrome.action.setBadgeBackgroundColor({ tabId: details.tabId, color: "#2563EB" }).catch(() => {});
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
    chrome.action.setBadgeText({ tabId: tabId, text: "" }).catch(() => {});
  }
});

// Clean up cache when tab is closed
chrome.tabs.onRemoved.addListener((tabId) => {
  tabMediaMap.delete(tabId);
});

// Message listener
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = sender.tab ? sender.tab.id : null;

  if (message.type === "VIDEO_DETECTED") {
    const targetTabId = tabId || message.tabId;
    if (targetTabId) {
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
      // Prioritize full playlists and direct files over segment chunks
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

    // Sanitize filename
    const safeFilename = (filename || "video.mp4")
      .replace(/[\\/:*?"<>|]/g, "_")
      .trim();

    const downloadOptions = {
      url: url,
      filename: safeFilename,
      saveAs: true
    };

    // Pass Referer header to prevent server anti-hotlinking 403/empty responses
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

    return true; // Asynchronous sendResponse
  }

  return true;
});
