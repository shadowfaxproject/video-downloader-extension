# Main Video Downloader (Chrome Extension - Manifest V3)

[![Manifest V3](https://img.shields.io/badge/Chrome%20Extension-Manifest%20V3-blue.svg)](https://developer.chrome.com/docs/extensions/mv3/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A lightweight, high-performance Chrome Extension that intelligently detects the primary/main video on any webpage and provides direct one-click downloading. It supports both direct video files (`.mp4`, `.webm`) and fragmented streaming protocols (**HLS / `.m3u8`**), all without modifying page event handlers or interfering with right-click functionality.

---

## Features

- 🎯 **Primary Video Detection Algorithm**:
  - Automatically identifies the main video by analyzing rendered screen area (`width * height`), active playback state (`!paused`), audio volume, and user controls.
  - Filters out background loops, advertising animations, and placeholder elements.
- 📡 **Network Stream Sniffing**:
  - Background service worker listens to `video/*` and HLS MIME types using `chrome.webRequest`.
  - Captures video streams loaded dynamically via JavaScript `fetch` / XHR that never expose their source directly in the DOM.
- 🧩 **In-Browser HLS (.m3u8) Stream Assembly**:
  - Automatically parses Master and Variant HLS playlists to select the highest resolution stream.
  - Concurrently downloads all `.ts` / `.m4s` video segments with parallel worker threads.
  - Built-in AES-128 stream decryption using Web Crypto API (`crypto.subtle`).
  - Stitches segments directly into a continuous, playable video file (`.ts` or `.mp4`).
  - Displays a real-time progress bar with segment count and downloaded byte sizes.
- 🛡️ **Anti-Hotlinking Referer Forwarding**:
  - Automatically captures and attaches the host webpage's `Referer` header to direct downloads and segment requests, preventing CDN 403 Forbidden errors and 0-byte responses.
- 🚫 **Zero-Byte Download Guard**:
  - Rejects empty server responses and ensures files are fully validated before writing to disk.
- ⚡ **One-Click FFmpeg Command**:
  - For massive livestreams or power users, one click copies the exact CLI command:
    ```bash
    ffmpeg -headers "Referer: ..." -i "<stream.m3u8>" -c copy -bsf:a aac_adtstoasc "video.mp4"
    ```
- 🎛️ **Polished Dark-Mode Popup UI**:
  - View resolution, duration, format tag, and file size.
  - Rename the file prior to download.
  - Quick buttons for **Download Video**, **Copy Link**, and **Preview in New Tab**.
  - Fallback list for secondary videos discovered on the page.

---

## Project Structure

```
video-downloader-extension/
├── manifest.json         # Extension configuration & Manifest V3 permissions
├── background.js         # Service worker: network sniffing & download manager
├── content.js            # Content script: primary video detection & DOM analyzer
├── hlsDownloader.js      # In-browser HLS playlist parser, segment fetcher & merger
├── popup/
│   ├── popup.html        # Extension UI layout
│   ├── popup.css         # Modern dark-mode styling
│   └── popup.js          # Controller: candidate ranking, progress tracking & actions
├── icons/
│   ├── icon16.png        # Toolbar icon (16x16)
│   ├── icon48.png        # Extensions manager icon (48x48)
│   └── icon128.png       # Chrome Web Store icon (128x128)
├── test/
│   ├── test_page.html    # Standalone test page (Direct MP4 & HLS stream players)
│   └── sample.mp4        # Offline fallback sample video
├── .gitignore
└── README.md
```

---

## Installation Instructions

1. Clone or download this repository:
   ```bash
   git clone https://github.com/shadowfaxproject/video-downloader-extension.git
   ```
2. Open Google Chrome and go to:
   ```
   chrome://extensions
   ```
3. Enable **Developer mode** using the toggle switch in the top-right corner.
4. Click the **Load unpacked** button in the top-left corner.
5. Select the `video-downloader-extension` directory.
6. The extension is now active and will appear in your Chrome extensions toolbar!

---

## Testing

A local testing environment is bundled in [`test/test_page.html`](test/test_page.html).

1. In Chrome, open the file:
   ```
   file:///Users/vivektawde/local/code/video-downloader-extension/test/test_page.html
   ```
2. Test both scenarios:
   - **Test 1 (Direct MP4 Video)**: Play the video, click the extension icon, and click **Download Video**.
   - **Test 2 (HLS Stream)**: Play the Mux HLS stream, click the extension icon, and click **Download & Assemble Video**. Observe the live progress bar as it fetches and stitches the segments into a playable video.

---

## Permissions Overview

| Permission | Purpose |
| :--- | :--- |
| `downloads` | Required to save video files to your system via Chrome's download manager. |
| `activeTab` | Accesses the active webpage to detect `<video>` elements and metadata when you open the popup. |
| `webRequest` | Inspects response headers to detect streaming video URLs loaded in the background. |
| `<all_urls>` | Allows video stream detection across arbitrary websites. |

---

## License

This project is licensed under the MIT License.
