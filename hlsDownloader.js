// hlsDownloader.js - Robust HLS (.m3u8) parser, segment downloader, and merger

/**
 * Downloads and assembles an HLS stream into a single playable video Blob (.ts or .mp4)
 * @param {string} m3u8Url - The URL of the master or media playlist
 * @param {Object} options - { onProgress, referer }
 * @returns {Promise<{ blob: Blob, extension: string, sizeBytes: number }>}
 */
async function assembleHlsStream(m3u8Url, options = {}) {
  const onProgress = options.onProgress || (() => {});
  const referer = options.referer || null;

  const fetchOptions = {
    mode: "cors",
    credentials: "omit"
  };
  if (referer) {
    fetchOptions.referrer = referer;
  }

  // 1. Fetch manifest
  const playlistRes = await fetch(m3u8Url, fetchOptions);
  if (!playlistRes.ok) {
    throw new Error(`Failed to fetch playlist (HTTP ${playlistRes.status})`);
  }
  const playlistText = await playlistRes.text();

  let mediaPlaylistUrl = m3u8Url;
  let mediaText = playlistText;

  // 2. Handle Master Playlist: select variant with highest bandwidth / resolution
  if (playlistText.includes("#EXT-X-STREAM-INF")) {
    const lines = playlistText.split("\n");
    let maxBandwidth = -1;
    let selectedUri = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.startsWith("#EXT-X-STREAM-INF")) {
        const bwMatch = line.match(/BANDWIDTH=(\d+)/);
        const bw = bwMatch ? parseInt(bwMatch[1], 10) : 0;

        let j = i + 1;
        while (j < lines.length && (!lines[j].trim() || lines[j].trim().startsWith("#"))) {
          j++;
        }
        if (j < lines.length && bw > maxBandwidth) {
          maxBandwidth = bw;
          selectedUri = lines[j].trim();
        }
      }
    }

    if (!selectedUri) {
      throw new Error("Could not parse variant stream from HLS master manifest.");
    }

    mediaPlaylistUrl = new URL(selectedUri, m3u8Url).href;
    const variantRes = await fetch(mediaPlaylistUrl, fetchOptions);
    if (!variantRes.ok) {
      throw new Error(`Failed to fetch variant playlist (HTTP ${variantRes.status})`);
    }
    mediaText = await variantRes.text();
  }

  // 3. Parse media playlist for segments, encryption, and init segments
  const lines = mediaText.split("\n");
  const segmentUrls = [];
  let initSegmentUrl = null;
  let keyInfo = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    // Initialization segment for fragmented MP4
    if (line.startsWith("#EXT-X-MAP:")) {
      const uriMatch = line.match(/URI="([^"]+)"/);
      if (uriMatch) {
        initSegmentUrl = new URL(uriMatch[1], mediaPlaylistUrl).href;
      }
    }

    // AES-128 Encryption key
    if (line.startsWith("#EXT-X-KEY:")) {
      const methodMatch = line.match(/METHOD=([^,]+)/);
      if (methodMatch && methodMatch[1] === "AES-128") {
        const uriMatch = line.match(/URI="([^"]+)"/);
        const ivMatch = line.match(/IV=0x([0-9a-fA-F]+)/);
        if (uriMatch) {
          keyInfo = {
            url: new URL(uriMatch[1], mediaPlaylistUrl).href,
            ivHex: ivMatch ? ivMatch[1] : null
          };
        }
      }
    }

    // Media segment URL
    if (!line.startsWith("#")) {
      try {
        segmentUrls.push(new URL(line, mediaPlaylistUrl).href);
      } catch (err) {
        console.warn("Invalid segment URL:", line);
      }
    }
  }

  if (segmentUrls.length === 0) {
    throw new Error("No video segments found in HLS playlist.");
  }

  // 4. Fetch encryption key if needed
  let cryptoKey = null;
  if (keyInfo) {
    const keyRes = await fetch(keyInfo.url, fetchOptions);
    if (!keyRes.ok) {
      throw new Error(`Failed to fetch decryption key (HTTP ${keyRes.status})`);
    }
    const keyBuffer = await keyRes.arrayBuffer();
    cryptoKey = await crypto.subtle.importKey(
      "raw",
      keyBuffer,
      { name: "AES-CBC" },
      false,
      ["decrypt"]
    );
  }

  // 5. Download Init Segment if present
  const chunks = [];
  if (initSegmentUrl) {
    onProgress({ current: 0, total: segmentUrls.length, percent: 0, stage: "init" });
    const initRes = await fetch(initSegmentUrl, fetchOptions);
    if (!initRes.ok) {
      throw new Error(`Failed to fetch stream header (HTTP ${initRes.status})`);
    }
    chunks.push(await initRes.arrayBuffer());
  }

  // 6. Concurrently download segments (pool of 4 workers)
  const total = segmentUrls.length;
  let completed = 0;
  let successfulSegments = 0;
  let totalBytes = 0;
  const downloadedBuffers = new Array(total);
  const CONCURRENCY = 4;

  let queueIndex = 0;
  let lastError = null;

  async function worker() {
    while (queueIndex < total) {
      const idx = queueIndex++;
      const url = segmentUrls[idx];

      let attempts = 0;
      let success = false;

      while (!success && attempts < 3) {
        try {
          attempts++;
          const segRes = await fetch(url, fetchOptions);
          if (!segRes.ok) throw new Error(`HTTP ${segRes.status}`);
          let buffer = await segRes.arrayBuffer();

          if (buffer.byteLength === 0) {
            throw new Error("Received 0 bytes from segment");
          }

          // Decrypt if AES-128
          if (cryptoKey) {
            let iv = new Uint8Array(16);
            if (keyInfo.ivHex) {
              for (let b = 0; b < 16; b++) {
                iv[b] = parseInt(keyInfo.ivHex.substr(b * 2, 2), 16);
              }
            } else {
              const view = new DataView(iv.buffer);
              view.setUint32(12, idx);
            }
            buffer = await crypto.subtle.decrypt({ name: "AES-CBC", iv }, cryptoKey, buffer);
          }

          downloadedBuffers[idx] = buffer;
          totalBytes += buffer.byteLength;
          successfulSegments++;
          success = true;
          completed++;

          const percent = Math.round((completed / total) * 100);
          onProgress({
            current: completed,
            total: total,
            percent: percent,
            stage: "segments",
            bytes: totalBytes
          });
        } catch (err) {
          lastError = err;
          if (attempts >= 3) {
            console.error(`Failed to download segment ${idx}:`, err.message);
            downloadedBuffers[idx] = new ArrayBuffer(0);
            completed++;
          } else {
            await new Promise(r => setTimeout(r, 400));
          }
        }
      }
    }
  }

  const workers = [];
  for (let w = 0; w < Math.min(CONCURRENCY, total); w++) {
    workers.push(worker());
  }
  await Promise.all(workers);

  // STRICT VALIDATION: Do not allow empty files
  if (successfulSegments === 0 || totalBytes === 0) {
    const errDetails = lastError ? ` (${lastError.message})` : "";
    throw new Error(`Download failed: All segments returned 0 bytes${errDetails}. The site may block hotlinking or require an active login session.`);
  }

  if (successfulSegments < total * 0.5) {
    throw new Error(`Download failed: Over 50% of video segments could not be fetched.`);
  }

  // 7. Combine all valid buffers
  const validBuffers = downloadedBuffers.filter(b => b && b.byteLength > 0);
  const finalChunks = initSegmentUrl ? chunks.concat(validBuffers) : validBuffers;

  const isFmp4 = Boolean(initSegmentUrl || segmentUrls[0].includes(".m4s"));
  const mimeType = isFmp4 ? "video/mp4" : "video/mp2t";
  const extension = isFmp4 ? "mp4" : "ts";

  const assembledBlob = new Blob(finalChunks, { type: mimeType });

  if (assembledBlob.size === 0) {
    throw new Error("Assembled video file is empty (0 bytes).");
  }

  return {
    blob: assembledBlob,
    extension: extension,
    sizeBytes: assembledBlob.size
  };
}

// Export for service worker or window context
if (typeof self !== "undefined") {
  self.assembleHlsStream = assembleHlsStream;
}
