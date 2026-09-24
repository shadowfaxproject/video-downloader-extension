// popup.js - Controls UI interaction, communicates with background downloader

document.addEventListener("DOMContentLoaded", async () => {
  const loadingState = document.getElementById("loading-state");
  const emptyState = document.getElementById("empty-state");
  const detectedState = document.getElementById("detected-state");
  const statusBadge = document.getElementById("status-badge");
  const refreshBtn = document.getElementById("refresh-btn");

  const filenameInput = document.getElementById("filename-input");
  const metaRes = document.getElementById("meta-res");
  const metaDuration = document.getElementById("meta-duration");
  const metaFormat = document.getElementById("meta-format");
  const videoQuality = document.getElementById("video-quality");

  const progressContainer = document.getElementById("progress-container");
  const progressLabel = document.getElementById("progress-label");
  const progressPercent = document.getElementById("progress-percent");
  const progressBarFill = document.getElementById("progress-bar-fill");
  const progressDetails = document.getElementById("progress-details");

  const downloadBtn = document.getElementById("download-btn");
  const copyUrlBtn = document.getElementById("copy-url-btn");
  const copyFfmpegBtn = document.getElementById("copy-ffmpeg-btn");
  const openTabBtn = document.getElementById("open-tab-btn");

  const secondarySection = document.getElementById("secondary-videos-section");
  const secondaryList = document.getElementById("secondary-list");
  const secondaryCount = document.getElementById("secondary-count");
  const toast = document.getElementById("toast");

  let activeVideo = null;
  let activeTab = null;
  let activeHlsUrl = null;
  let activeHlsJobId = null;

  function showToast(message, isError = false) {
    toast.textContent = message;
    toast.style.background = isError ? "#ef4444" : "#10b981";
    toast.classList.remove("hidden");
    setTimeout(() => {
      toast.classList.add("hidden");
    }, 5000);
  }

  function formatDuration(seconds) {
    if (!seconds) return "--";
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}m ${secs.toString().padStart(2, "0")}s`;
  }

  function formatBytes(bytes) {
    if (!bytes || bytes <= 0) return null;
    const sizes = ["Bytes", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${sizes[i]}`;
  }

  function checkIsHls(url, isHlsFlag = false) {
    if (isHlsFlag) return true;
    return Boolean(url && url.match(/\.m3u8(\?.*)?$/i));
  }

  function getFileExtension(url, isHls = false) {
    if (isHls) return "TS";
    try {
      const pathname = new URL(url).pathname;
      const match = pathname.match(/\.(mp4|webm|mkv|mov|m4v)(\?.*)?$/i);
      return match ? match[1].toUpperCase() : "MP4";
    } catch {
      return "MP4";
    }
  }

  function sanitizeFilename(title, ext = "mp4") {
    const clean = (title || "video")
      .replace(/[^a-zA-Z0-9_\-\s]/g, "_")
      .replace(/\s+/g, "_")
      .slice(0, 45);
    return `${clean}.${ext.toLowerCase()}`;
  }

  function updateProgressUI(progress) {
    progressContainer.classList.remove("hidden");
    const pct = `${progress.percent}%`;
    progressPercent.textContent = pct;
    progressBarFill.style.width = pct;
    if (progress.stage === "init") {
      progressLabel.textContent = "Downloading stream header...";
    } else {
      progressLabel.textContent = "Downloading in background...";
      const sizeStr = progress.bytes ? ` (${formatBytes(progress.bytes)})` : "";
      progressDetails.textContent = `${progress.current} / ${progress.total} segments${sizeStr}`;
    }
  }

  // Listen for real-time progress broadcasted by background service worker
  chrome.runtime.onMessage.addListener((msg) => {
    if (!activeTab || msg.tabId !== activeTab.id) return;

    // Filter messages to ensure they match our active downloading job
    const isMatch = (activeHlsJobId && msg.jobId)
      ? (msg.jobId === activeHlsJobId)
      : (msg.url === activeHlsUrl);

    if (!isMatch) return;

    if (msg.type === "HLS_PROGRESS_UPDATE") {
      updateProgressUI(msg.progress);
    } else if (msg.type === "HLS_COMPLETED") {
      progressLabel.textContent = "Download complete!";
      progressPercent.textContent = "100%";
      progressBarFill.style.width = "100%";
      progressDetails.textContent = `Saved: ${formatBytes(msg.sizeBytes)}`;
      // Only enable the main download button if this was the main video
      if (activeVideo && msg.url === activeVideo.url) {
        downloadBtn.disabled = false;
        downloadBtn.style.opacity = "1";
      }
      showToast("Download finished and saved to Downloads folder!");
    } else if (msg.type === "HLS_ERROR") {
      progressLabel.textContent = "Download failed.";
      progressDetails.textContent = msg.error;
      if (activeVideo && msg.url === activeVideo.url) {
        downloadBtn.disabled = false;
        downloadBtn.style.opacity = "1";
      }
      showToast("Download error: " + msg.error, true);
    }
  });

  async function loadVideos() {
    loadingState.classList.remove("hidden");
    emptyState.classList.add("hidden");
    detectedState.classList.add("hidden");
    progressContainer.classList.add("hidden");
    statusBadge.textContent = "Scanning...";
    statusBadge.className = "badge";

    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tabs || tabs.length === 0) {
      loadingState.classList.add("hidden");
      emptyState.classList.remove("hidden");
      return;
    }

    activeTab = tabs[0];

    // Check if background worker is already downloading on this tab
    try {
      const statusRes = await chrome.runtime.sendMessage({
        type: "GET_HLS_STATUS",
        tabId: activeTab.id
      });
      if (statusRes?.job && statusRes.job.status === "downloading") {
        activeHlsUrl = statusRes.job.url;
        activeHlsJobId = statusRes.job.jobId;
        updateProgressUI(statusRes.job.progress);
        downloadBtn.disabled = true;
        downloadBtn.style.opacity = "0.7";
      }
    } catch (err) {
      console.warn("[Popup] Could not get download status:", err);
    }

    // 1. Query DOM video detector from content script
    let domResult = null;
    try {
      domResult = await chrome.tabs.sendMessage(activeTab.id, { type: "GET_MAIN_VIDEO" });
    } catch (err) {
      console.warn("[Popup] Content script not reachable:", err);
    }

    // 2. Query network sniffed videos from background script
    let networkVideos = [];
    try {
      const netResult = await chrome.runtime.sendMessage({
        type: "GET_NETWORK_VIDEOS",
        tabId: activeTab.id
      });
      networkVideos = netResult?.videos || [];
    } catch (err) {
      console.warn("[Popup] Could not query background script:", err);
    }

    loadingState.classList.add("hidden");

    let mainCandidate = null;

    if (domResult?.mainVideo && domResult.mainVideo.directUrl) {
      const domUrl = domResult.mainVideo.directUrl;
      const isHls = checkIsHls(domUrl);
      mainCandidate = {
        url: domUrl,
        pageTitle: domResult.mainVideo.pageTitle || activeTab.title,
        width: domResult.mainVideo.width,
        height: domResult.mainVideo.height,
        duration: domResult.mainVideo.duration,
        isHls: isHls,
        isBlob: false
      };
    } else if (networkVideos.length > 0) {
      const nonSegment = networkVideos.find(n => !n.isSegment);
      const topNetVideo = nonSegment || networkVideos[0];
      const isHls = checkIsHls(topNetVideo.url, topNetVideo.isHls);

      mainCandidate = {
        url: topNetVideo.url,
        pageTitle: activeTab.title || "Video",
        width: domResult?.mainVideo?.width || null,
        height: domResult?.mainVideo?.height || null,
        duration: domResult?.mainVideo?.duration || null,
        sizeBytes: topNetVideo.sizeBytes,
        isHls: isHls,
        isBlob: false
      };
    } else if (domResult?.mainVideo) {
      const isHls = checkIsHls(domResult.mainVideo.url);
      mainCandidate = {
        url: domResult.mainVideo.url,
        pageTitle: domResult.mainVideo.pageTitle || activeTab.title,
        width: domResult.mainVideo.width,
        height: domResult.mainVideo.height,
        duration: domResult.mainVideo.duration,
        isHls: isHls,
        isBlob: domResult.mainVideo.isBlob
      };
    }

    if (!mainCandidate) {
      statusBadge.textContent = "No Video";
      emptyState.classList.remove("hidden");
      return;
    }

    activeVideo = mainCandidate;
    statusBadge.textContent = "Detected";
    statusBadge.className = "badge success";
    detectedState.classList.remove("hidden");

    const isHls = activeVideo.isHls;
    const ext = isHls ? "ts" : getFileExtension(activeVideo.url).toLowerCase();

    metaFormat.textContent = isHls ? "HLS Stream" : ext.toUpperCase();
    filenameInput.value = sanitizeFilename(activeVideo.pageTitle, ext);

    if (isHls) {
      copyFfmpegBtn.classList.remove("hidden");
      downloadBtn.innerHTML = `
        <svg class="btn-icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
          <polyline points="7 10 12 15 17 10"></polyline>
          <line x1="12" y1="15" x2="12" y2="3"></line>
        </svg>
        Download & Assemble Video
      `;
    } else {
      copyFfmpegBtn.classList.add("hidden");
      downloadBtn.innerHTML = `
        <svg class="btn-icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
          <polyline points="7 10 12 15 17 10"></polyline>
          <line x1="12" y1="15" x2="12" y2="3"></line>
        </svg>
        Download Video
      `;
    }

    if (activeVideo.width && activeVideo.height) {
      metaRes.textContent = `${activeVideo.width}×${activeVideo.height}`;
      videoQuality.textContent = activeVideo.height >= 720 ? `${activeVideo.height}p` : "SD";
    } else if (activeVideo.sizeBytes) {
      metaRes.textContent = formatBytes(activeVideo.sizeBytes);
      videoQuality.textContent = ext.toUpperCase();
    } else {
      metaRes.textContent = isHls ? "Adaptive" : "Auto";
      videoQuality.textContent = isHls ? "HLS" : ext.toUpperCase();
    }

    metaDuration.textContent = formatDuration(activeVideo.duration);

    if (activeVideo.isBlob && !activeVideo.isHls) {
      downloadBtn.disabled = true;
      downloadBtn.style.opacity = "0.6";
      showToast("Play the video for a few seconds to capture the stream.", true);
    } else if (activeHlsUrl && activeHlsUrl !== activeVideo.url) {
      downloadBtn.disabled = false;
      downloadBtn.style.opacity = "1";
    }

    // Render secondary videos
    const secondaryCandidates = (domResult?.allVideos || [])
      .filter(v => v.url && v.url !== activeVideo.url)
      .map(v => ({ url: v.directUrl || v.url, isHls: checkIsHls(v.url) }))
      .concat(
        networkVideos
          .filter(n => n.url !== activeVideo.url)
          .map(n => ({ url: n.url, isHls: checkIsHls(n.url, n.isHls), sizeBytes: n.sizeBytes }))
      );

    if (secondaryCandidates.length > 0) {
      secondarySection.classList.remove("hidden");
      secondaryCount.textContent = secondaryCandidates.length;
      secondaryList.innerHTML = "";

      secondaryCandidates.forEach((vid, idx) => {
        const item = document.createElement("div");
        item.className = "secondary-item";

        const titleSpan = document.createElement("span");
        titleSpan.className = "secondary-item-title";
        const vidExt = vid.isHls ? "HLS Stream" : getFileExtension(vid.url);
        const sizeInfo = vid.sizeBytes ? ` (${formatBytes(vid.sizeBytes)})` : "";
        titleSpan.textContent = `#${idx + 2} ${vidExt}${sizeInfo}`;

        const dlBtn = document.createElement("button");
        dlBtn.className = "btn btn-secondary btn-mini";
        dlBtn.textContent = vid.isHls ? "Assemble" : "Download";
        dlBtn.addEventListener("click", () => {
          if (vid.isHls) {
            startHlsBackgroundDownload(vid.url, `video_${idx + 2}.ts`);
          } else {
            triggerDirectDownload(vid.url, sanitizeFilename(`video_${idx + 2}`, vidExt));
          }
        });

        item.appendChild(titleSpan);
        item.appendChild(dlBtn);
        secondaryList.appendChild(item);
      });
    } else {
      secondarySection.classList.add("hidden");
    }
  }

  function triggerDirectDownload(url, filename) {
    showToast("Starting download...");
    chrome.runtime.sendMessage(
      {
        type: "DOWNLOAD_VIDEO",
        url: url,
        filename: filename,
        referer: activeTab ? activeTab.url : null
      },
      (response) => {
        if (response && response.success) {
          showToast("Download launched in Chrome!");
        } else {
          showToast(response?.error || "Download failed. Check connection.", true);
        }
      }
    );
  }

  // Hand off HLS stream assembly to persistent background service worker
  function startHlsBackgroundDownload(m3u8Url, targetFilename) {
    downloadBtn.disabled = true;
    downloadBtn.style.opacity = "0.7";
    progressContainer.classList.remove("hidden");
    progressLabel.textContent = "Starting background download...";
    progressPercent.textContent = "0%";
    progressBarFill.style.width = "0%";
    progressDetails.textContent = "Connecting...";

    showToast("Download running in background! Safe to switch windows or apps.");

    activeHlsUrl = m3u8Url;
    activeHlsJobId = null;

    chrome.runtime.sendMessage(
      {
        type: "START_HLS_DOWNLOAD",
        tabId: activeTab.id,
        url: m3u8Url,
        filename: targetFilename,
        referer: activeTab ? activeTab.url : null
      },
      (response) => {
        if (chrome.runtime.lastError) {
          showToast("Could not start background job: " + chrome.runtime.lastError.message, true);
          // Only enable the main button if we were trying to download the main video
          if (activeVideo && m3u8Url === activeVideo.url) {
            downloadBtn.disabled = false;
            downloadBtn.style.opacity = "1";
          }
        } else if (response && response.success) {
          activeHlsJobId = response.jobId;
        }
      }
    );
  }

  // Action listeners
  downloadBtn.addEventListener("click", () => {
    if (!activeVideo || !activeVideo.url) return;
    const filename = filenameInput.value.trim() || "video.mp4";

    if (activeVideo.isHls) {
      startHlsBackgroundDownload(activeVideo.url, filename);
    } else {
      triggerDirectDownload(activeVideo.url, filename);
    }
  });

  copyUrlBtn.addEventListener("click", async () => {
    if (!activeVideo || !activeVideo.url) return;
    try {
      await navigator.clipboard.writeText(activeVideo.url);
      showToast("Video URL copied!");
    } catch {
      showToast("Could not copy URL", true);
    }
  });

  copyFfmpegBtn.addEventListener("click", async () => {
    if (!activeVideo || !activeVideo.url) return;
    const outName = (filenameInput.value.trim() || "video").replace(/\.[^/.]+$/, "") + ".mp4";
    const refHeader = activeTab ? ` -headers "Referer: ${activeTab.url}"` : "";
    const cmd = `ffmpeg${refHeader} -i "${activeVideo.url}" -c copy -bsf:a aac_adtstoasc "${outName}"`;
    try {
      await navigator.clipboard.writeText(cmd);
      showToast("FFmpeg command copied!");
    } catch {
      showToast("Failed to copy command", true);
    }
  });

  openTabBtn.addEventListener("click", () => {
    if (!activeVideo || !activeVideo.url) return;
    chrome.tabs.create({ url: activeVideo.url });
  });

  refreshBtn.addEventListener("click", () => {
    loadVideos();
  });

  // Initial scan
  loadVideos();
});
