// offscreen.js - Runs in a dedicated DOM context with native URL.createObjectURL support

const activeHlsJobs = new Map(); // downloadId -> { abortController, tabId }

chrome.runtime.onMessage.addListener(async (message) => {
  if (message.type === "OFFSCREEN_START_HLS") {
    const { downloadId, tabId, url, filename, referer } = message;
    const abortController = new AbortController();
    activeHlsJobs.set(downloadId, { abortController, tabId });

    try {
      const result = await assembleHlsStream(url, {
        referer: referer,
        signal: abortController.signal,
        onProgress: (progress) => {
          chrome.runtime.sendMessage({
            type: "HLS_PROGRESS_UPDATE",
            downloadId,
            tabId,
            progress
          }).catch(() => {});
        }
      });

      if (abortController.signal.aborted) {
        return;
      }

      if (!result.blob || result.blob.size === 0) {
        throw new Error("Assembled video file is empty (0 bytes received).");
      }

      // Generate Blob URL in native DOM context (available to extension origin)
      const blobUrl = URL.createObjectURL(result.blob);

      // Preserve extension if provided, otherwise add .mp4
      let finalFilename = (filename || "video").trim().replace(/\.m3u8$/i, "");
      console.log("[Offscreen] filename from message:", filename, "→ after m3u8 strip:", finalFilename);
      if (!/\.[a-zA-Z0-9]{2,5}$/.test(finalFilename)) {
        finalFilename += ".mp4";
      }
      console.log("[Offscreen] finalFilename to send:", finalFilename);

      // Send blobUrl back to background service worker to trigger chrome.downloads
      chrome.runtime.sendMessage({
        type: "OFFSCREEN_BLOB_READY",
        downloadId,
        tabId,
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
      if (err.name === "AbortError" || abortController.signal.aborted) {
        console.log(`[Offscreen] Download ${downloadId} was cancelled.`);
        chrome.runtime.sendMessage({
          type: "HLS_CANCELLED",
          downloadId,
          tabId
        }).catch(() => {});
      } else {
        console.error("[Offscreen HLS Download Error]:", err);
        chrome.runtime.sendMessage({
          type: "HLS_ERROR",
          downloadId,
          tabId,
          error: err.message
        }).catch(() => {});
      }
    } finally {
      activeHlsJobs.delete(downloadId);
    }
  } else if (message.type === "OFFSCREEN_CANCEL_HLS") {
    const { downloadId, tabId } = message;
    if (downloadId && activeHlsJobs.has(downloadId)) {
      const job = activeHlsJobs.get(downloadId);
      job.abortController.abort();
      activeHlsJobs.delete(downloadId);
      chrome.runtime.sendMessage({
        type: "HLS_CANCELLED",
        downloadId,
        tabId: tabId || job.tabId
      }).catch(() => {});
    } else if (!downloadId) {
      // Cancel all active jobs
      for (const [id, job] of activeHlsJobs.entries()) {
        job.abortController.abort();
      }
      activeHlsJobs.clear();
    }
  } else if (message.type === "REVOKE_BLOB" && message.blobUrl) {
    try {
      URL.revokeObjectURL(message.blobUrl);
    } catch {}
  }
});
