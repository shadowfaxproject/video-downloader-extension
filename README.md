# Main Video Downloader - Chrome Extension (Manifest V3)

A lightweight Chrome Extension that intelligently detects the primary/main video on any webpage and provides direct one-click downloading without altering page context menus or interaction handlers.

## Features

- **Primary Video Detection**: Ranks video candidates based on display dimensions, playback status, duration, and controls to pinpoint the main video.
- **Network Stream Sniffing**: Uses `chrome.webRequest` background interception to catch videos streamed via JavaScript/fetch.
- **Toolbar Counter**: Displays a live badge counter on the extension icon when media is detected.
- **Clean Popup UI**:
  - Automatically identifies resolution, duration, and format (`MP4`, `WebM`).
  - Allows custom filename renaming before download.
  - One-click **Download Video**, **Copy Link**, and **Preview** buttons.
  - Fallback list for secondary videos detected on the page.

## Installation Instructions

1. Open Google Chrome.
2. Navigate to `chrome://extensions`.
3. Enable **Developer mode** using the toggle in the upper-right corner.
4. Click the **Load unpacked** button in the upper-left.
5. Select the `video-downloader-extension` directory:
   ```
   /Users/vivektawde/local/code/video-downloader-extension
   ```
6. The extension is now installed and ready to use!

## Testing

Open `test/test_page.html` in Chrome to test detection and downloading on a sample video.
