// content.js - Primary video detector (does not alter right-click behavior)

(() => {
  /**
   * Evaluates all <video> elements on the page and selects the primary / main video.
   */
  function detectVideos() {
    const videoElements = Array.from(document.querySelectorAll("video"));
    const candidates = [];

    videoElements.forEach((video, index) => {
      const rect = video.getBoundingClientRect();
      const isVisible = rect.width > 0 && rect.height > 0 && 
                        window.getComputedStyle(video).visibility !== "hidden" && 
                        window.getComputedStyle(video).display !== "none";

      // Collect all potential source URLs
      const directSources = new Set();
      const blobSources = new Set();

      function addSource(src) {
        if (!src) return;
        src = src.trim();
        if (src.startsWith("http://") || src.startsWith("https://") || src.startsWith("file://")) {
          directSources.add(src);
        } else if (src.startsWith("blob:")) {
          blobSources.add(src);
        } else if (src.startsWith("/")) {
          // Resolve relative URLs
          try {
            directSources.add(new URL(src, window.location.href).href);
          } catch {}
        }
      }

      if (video.currentSrc) addSource(video.currentSrc);
      if (video.src) addSource(video.src);

      video.querySelectorAll("source").forEach(s => {
        if (s.src) addSource(s.src);
      });

      const directArr = Array.from(directSources);
      const blobArr = Array.from(blobSources);

      if (directArr.length === 0 && blobArr.length === 0) return;

      // Prefer direct HTTP/HTTPS/file URL over blob URL
      const chosenUrl = directArr.length > 0 ? directArr[0] : blobArr[0];
      const isBlob = directArr.length === 0 && blobArr.length > 0;

      // Calculate priority score
      let score = 0;

      // Area score
      const area = rect.width * rect.height;
      score += Math.min(area / 1000, 500);

      // Active playback bonus
      if (!video.paused && video.currentTime > 0) {
        score += 300;
      }

      // Audio active bonus
      if (!video.muted && video.volume > 0) {
        score += 100;
      }

      // Duration: longer videos are more likely to be the main content
      if (video.duration && !isNaN(video.duration)) {
        if (video.duration > 30) score += 150;
        else if (video.duration > 5) score += 50;
      }

      // Standard user controls present
      if (video.controls) {
        score += 100;
      }

      candidates.push({
        id: `video-${index}`,
        url: chosenUrl,
        directUrl: directArr.length > 0 ? directArr[0] : null,
        isBlob: isBlob,
        allSources: directArr.concat(blobArr),
        score,
        width: video.videoWidth || Math.round(rect.width),
        height: video.videoHeight || Math.round(rect.height),
        duration: !isNaN(video.duration) ? Math.round(video.duration) : null,
        isPlaying: !video.paused && video.currentTime > 0,
        pageTitle: document.title || "Video"
      });
    });

    // Sort descending by score
    candidates.sort((a, b) => b.score - a.score);

    return {
      mainVideo: candidates.length > 0 ? candidates[0] : null,
      allVideos: candidates
    };
  }

  function safeSendMessage(message) {
    try {
      if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.id) {
        chrome.runtime.sendMessage(message).catch(() => {});
      }
    } catch (e) {
      // Ignore "Extension context invalidated" error
    }
  }

  // Notify background script when any video begins playing
  document.addEventListener("play", (event) => {
    if (event.target && event.target.tagName === "VIDEO") {
      const result = detectVideos();
      if (result.mainVideo) {
        safeSendMessage({
          type: "VIDEO_DETECTED",
          data: result
        });
      }
    }
  }, true);

  // Listen for queries from popup or background script
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.type === "GET_MAIN_VIDEO") {
      const result = detectVideos();
      sendResponse(result);
    }
    return true;
  });

  // Initial detection when page is ready
  setTimeout(() => {
    const result = detectVideos();
    if (result.mainVideo) {
      safeSendMessage({
        type: "VIDEO_DETECTED",
        data: result
      });
    }
  }, 1000);
})();
