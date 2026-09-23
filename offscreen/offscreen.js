// offscreen.js - Runs in a dedicated DOM context with native URL.createObjectURL support

function safeSendMessage(message) {
  try {
    if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.id) {
      chrome.runtime.sendMessage(message).catch(() => {});
    }
  } catch (e) {
    // Ignore "Extension context invalidated" error
  }
}

chrome.runtime.onMessage.addListener(async (message) => {
  if (message.type === "OFFSCREEN_START_HLS") {
    const { jobId, tabId, url, filename, referer } = message;

    try {
      const result = await assembleHlsStream(url, {
        referer: referer,
        onProgress: (progress) => {
          safeSendMessage({
            type: "HLS_PROGRESS_UPDATE",
            jobId,
            tabId,
            url,
            progress
          });
        }
      });

      if (!result.blob || result.blob.size === 0) {
        throw new Error("Assembled video file is empty (0 bytes received).");
      }

      // Generate Blob URL in native DOM context (available to extension origin)
      const blobUrl = URL.createObjectURL(result.blob);
      const finalFilename = filename.replace(/\.(ts|mp4|m3u8)$/i, "") + `.${result.extension}`;

      // Send blobUrl back to background service worker to trigger chrome.downloads
      safeSendMessage({
        type: "OFFSCREEN_BLOB_READY",
        jobId,
        tabId,
        url,
        blobUrl,
        filename: finalFilename,
        sizeBytes: result.sizeBytes
      });

      // Keep blob URL alive until downloaded, clean up after 2 minutes
      setTimeout(() => {
        try {
          URL.revokeObjectURL(blobUrl);
        } catch {}
      }, 120000);

    } catch (err) {
      console.error("[Offscreen HLS Download Error]:", err);
      safeSendMessage({
        type: "HLS_ERROR",
        jobId,
        tabId,
        url,
        error: err.message
      });
    }
  } else if (message.type === "REVOKE_BLOB" && message.blobUrl) {
    try {
      URL.revokeObjectURL(message.blobUrl);
    } catch {}
  }
});
