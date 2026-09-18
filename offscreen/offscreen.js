// offscreen.js - Runs in a dedicated DOM context with native URL.createObjectURL support

chrome.runtime.onMessage.addListener(async (message) => {
  if (message.type === "OFFSCREEN_START_HLS") {
    const { tabId, url, filename, referer } = message;

    try {
      const result = await assembleHlsStream(url, {
        referer: referer,
        onProgress: (progress) => {
          chrome.runtime.sendMessage({
            type: "HLS_PROGRESS_UPDATE",
            tabId,
            progress
          }).catch(() => {});
        }
      });

      if (!result.blob || result.blob.size === 0) {
        throw new Error("Assembled video file is empty (0 bytes received).");
      }

      // Native DOM URL.createObjectURL is fully supported in offscreen documents
      const blobUrl = URL.createObjectURL(result.blob);
      const finalFilename = filename.replace(/\.(ts|mp4|m3u8)$/i, "") + `.${result.extension}`;

      chrome.downloads.download(
        {
          url: blobUrl,
          filename: finalFilename,
          saveAs: true
        },
        (downloadId) => {
          if (chrome.runtime.lastError) {
            console.error("[Offscreen] Download trigger failed:", chrome.runtime.lastError.message);
            chrome.runtime.sendMessage({
              type: "HLS_ERROR",
              tabId,
              error: chrome.runtime.lastError.message
            }).catch(() => {});
          } else {
            chrome.runtime.sendMessage({
              type: "HLS_COMPLETED",
              tabId,
              filename: finalFilename,
              sizeBytes: result.sizeBytes
            }).catch(() => {});
          }

          // Clean up ObjectURL after 60 seconds
          setTimeout(() => {
            URL.revokeObjectURL(blobUrl);
          }, 60000);
        }
      );

    } catch (err) {
      console.error("[Offscreen HLS Download Error]:", err);
      chrome.runtime.sendMessage({
        type: "HLS_ERROR",
        tabId,
        error: err.message
      }).catch(() => {});
    }
  }
});
