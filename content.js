// YT-Reigen Content Script
// Highly optimized browser-compositor-friendly ambient glow engine

const LOG_PREFIX = '[YT-Reigen Client]';
function logInfo(msg) {
  console.log(`${LOG_PREFIX} ${msg}`);
}

// --- HARDCODED OPTIMAL PARAMETERS ---
const CANVAS_WIDTH = 160;
const CANVAS_HEIGHT = 90;
const UPDATE_INTERVAL = 33; // Max ~30 FPS refresh lock

// --- STATE SWITCHES ---
let settings = {
  glowEnabled: true,
  cinematicEnabled: true,
  searchEnabled: true
};

// State trackers
let canvas = null;
let ctx = null;
let glowCanvas = null;
let glowCtx = null;

let prevColors = [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]];
let lastDrawnColors = [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]];
let lastFrameTime = 0;
let lastCurrentTime = -1; // Motion energy tracker

let videoElement = null;
let glowActive = false;
let checkVideoInterval = null;

// Read settings from storage on launch
chrome.storage.local.get(Object.keys(settings), (data) => {
  settings = { ...settings, ...data };
  // Force cinematicEnabled to be true permanently since the toggle is removed
  settings.cinematicEnabled = true;
  logInfo('Settings loaded: ' + JSON.stringify(settings));
  applyVisualSettings();
  initLayoutEngine();
});

// Listen to dynamic settings changes from the popup control panel
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local') {
    for (const key in changes) {
      settings[key] = changes[key].newValue;
    }
    // Force cinematicEnabled to be true permanently since the toggle is removed
    settings.cinematicEnabled = true;
    logInfo('Settings updated: ' + JSON.stringify(settings));
    applyVisualSettings();

    // If ambient glow toggled on/off, trigger accordingly
    if (changes.glowEnabled) {
      if (settings.glowEnabled) {
        startGlowLoop();
      } else {
        stopGlowLoop();
      }
    }

    // Dynamic search engine toggle
    if (changes.searchEnabled) {
      updateSearchVisibility();
    }
  }
});

// Update page body classes and custom properties instantly
function applyVisualSettings() {
  document.body.classList.toggle('reigen-cinematic-active', settings.cinematicEnabled);
  document.body.classList.toggle('reigen-search-active', settings.searchEnabled);
}

// --- AMBIENT GLOW ENGINE ---

function initGlow() {
  const video = document.querySelector('video');
  if (!video) return;

  videoElement = video;

  // Create temporary offscreen sampling canvas (for reading pixels)
  if (!canvas) {
    canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 36;
    // willReadFrequently optimized since we pull imageData every active frame
    ctx = canvas.getContext('2d', { willReadFrequently: true, alpha: false });
  }

  // Create onscreen blurred backdrop canvas (Opaque, detached compositor layer)
  if (!glowCanvas) {
    glowCanvas = document.createElement('canvas');
    glowCanvas.id = 'ambient-fullscreen-glow';
    glowCanvas.width = CANVAS_WIDTH;
    glowCanvas.height = CANVAS_HEIGHT;
    
    // alpha:false -> tells Chromium the layer has no transparent pixels itself (drastically optimizes blending)
    // desynchronized:true -> bypasses double-buffering frames sync loops for lower latency
    glowCtx = glowCanvas.getContext('2d', { alpha: false, desynchronized: true });
    
    // DETACH completely from the body Polymer tree, append directly to HTML root
    document.documentElement.appendChild(glowCanvas);
    logInfo('Canvas engine initialized and detached.');
  }

  startGlowLoop();
}

function getColor(x, y, w, h, prevColor) {
  if (!ctx) return prevColor;
  try {
    const img = ctx.getImageData(x, y, w, h).data;
    let r = 0, g = 0, b = 0, c = 0;
    
    // Sample every 4th pixel (step of 16 indices in RGBA data) to keep it fast
    for (let i = 0; i < img.length; i += 16) {
      r += img[i];
      g += img[i + 1];
      b += img[i + 2];
      c++;
    }
    
    const targetColor = [(r / c) | 0, (g / c) | 0, (b / c) | 0];
    
    // Mild EMA smoothing (0.5) to replace CSS transition: background 0.5s ease
    // This gives us buttery-smooth color changes without CSS transition overhead
    const speed = 0.5;
    return [
      prevColor[0] * (1 - speed) + targetColor[0] * speed,
      prevColor[1] * (1 - speed) + targetColor[1] * speed,
      prevColor[2] * (1 - speed) + targetColor[2] * speed
    ];
  } catch (e) {
    return prevColor;
  }
}

// Lightweight color boost — equivalent to CSS saturate(150%) brightness(110%)
// Applied in JS to avoid expensive CSS filter passes on the fullscreen canvas
function adjustColor(rgb) {
  let [r, g, b] = rgb;
  
  const gray = 0.299 * r + 0.587 * g + 0.114 * b;
  
  // Mild saturation boost (1.5x) — matches CSS saturate(150%)
  r = gray + (r - gray) * 1.5;
  g = gray + (g - gray) * 1.5;
  b = gray + (b - gray) * 1.5;
  
  // Mild brightness boost (1.1x) — matches CSS brightness(110%)
  r *= 1.1;
  g *= 1.1;
  b *= 1.1;
  
  return [
    Math.max(0, Math.min(255, r)) | 0,
    Math.max(0, Math.min(255, g)) | 0,
    Math.max(0, Math.min(255, b)) | 0
  ];
}

function drawGlowCanvas(colors) {
  if (!glowCtx || !glowCanvas) return;

  const w = CANVAS_WIDTH;
  const h = CANVAS_HEIGHT;

  // Delta-Threshold skip: Check if color change distance is below drawing threshold
  let delta = 0;
  for (let j = 0; j < 4; j++) {
    delta += Math.abs(colors[j][0] - lastDrawnColors[j][0]) +
             Math.abs(colors[j][1] - lastDrawnColors[j][1]) +
             Math.abs(colors[j][2] - lastDrawnColors[j][2]);
  }
  
  if (delta < 2) {
    return; // Completely bypass Canvas API writes and GPU updates
  }

  // Save last drawn colors
  lastDrawnColors = [
    [colors[0][0], colors[0][1], colors[0][2]],
    [colors[1][0], colors[1][1], colors[1][2]],
    [colors[2][0], colors[2][1], colors[2][2]],
    [colors[3][0], colors[3][1], colors[3][2]]
  ];

  // Opaque solid background rendering (Clears to solid black)
  glowCtx.fillStyle = '#000000';
  glowCtx.fillRect(0, 0, w, h);
  
  glowCtx.globalCompositeOperation = 'source-over';

  const [left, right, top, bottom] = colors;
  
  // Single radial gradient per edge — matches Electron's exact gradient structure:
  //   radial-gradient(circle at 15% 50%, rgba(r,g,b, 0.8), transparent 70%)
  //   radial-gradient(circle at 85% 50%, rgba(r,g,b, 0.8), transparent 70%)
  //   radial-gradient(circle at 50% 10%, rgba(r,g,b, 0.7), transparent 70%)
  //   radial-gradient(circle at 50% 90%, rgba(r,g,b, 0.7), transparent 70%)
  function drawGradient(x, y, radius, color, alpha) {
    const [r, g, b] = adjustColor(color);
    const rad = glowCtx.createRadialGradient(x, y, 0, x, y, radius);
    rad.addColorStop(0, `rgba(${r}, ${g}, ${b}, ${alpha})`);
    rad.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`);
    glowCtx.fillStyle = rad;
    glowCtx.fillRect(0, 0, w, h);
  }
  
  // Exact positions and alphas from the Electron version
  // Note: Top/bottom use w*0.7 radius (not h*0.7) so the glow spreads proportionally
  // on the wide 160x90 canvas. Y positions at 15%/85% compensate for the CSS -10vh offset.
  drawGradient(w * 0.15, h * 0.5, w * 0.7, left, 0.8);     // Left edge
  drawGradient(w * 0.85, h * 0.5, w * 0.7, right, 0.8);    // Right edge
  drawGradient(w * 0.5,  h * 0.15, w * 0.7, top, 0.7);     // Top edge
  drawGradient(w * 0.5,  h * 0.85, w * 0.7, bottom, 0.7);  // Bottom edge
}

function startGlowLoop() {
  if (glowActive || !settings.glowEnabled) return;
  glowActive = true;
  logInfo('Ambient Glow Engine Loop started');

  function update() {
    if (!glowActive || !settings.glowEnabled) return;

    // 1. Throttling Lock Check
    const now = performance.now();
    const elapsed = now - lastFrameTime;
    if (elapsed < UPDATE_INTERVAL) {
      if (videoElement && videoElement.requestVideoFrameCallback) {
        videoElement.requestVideoFrameCallback(update);
      } else {
        setTimeout(update, 5);
      }
      return;
    }

    const isWatch = window.location.pathname === '/watch';
    const isGlowVisible = isWatch && document.body.classList.contains('reigen-cinematic-active');

        // 2. Playback / Visiblity state check: smoothly fade to black on non-watch pages
    if (!isGlowVisible || !videoElement) {
      const colorsAreBlack = prevColors.every(col => col[0] < 1 && col[1] < 1 && col[2] < 1);
      if (!colorsAreBlack) {
        // Fade colors gradually to zero using EMA
        prevColors = prevColors.map(col => [
          col[0] * 0.72,
          col[1] * 0.72,
          col[2] * 0.72
        ]);
        drawGlowCanvas(prevColors);
      }
      
      // Request next frame at low frequency
      if (videoElement && videoElement.requestVideoFrameCallback) {
        videoElement.requestVideoFrameCallback(update);
      } else {
        setTimeout(update, 100);
      }
      return;
    }

    // 3. Motion Energy Lock Check: Skip calculations entirely if frame is static
    if (videoElement.currentTime === lastCurrentTime) {
      if (videoElement.requestVideoFrameCallback) {
        videoElement.requestVideoFrameCallback(update);
      } else {
        setTimeout(update, UPDATE_INTERVAL);
      }
      return;
    }
    
    lastCurrentTime = videoElement.currentTime;
    lastFrameTime = now;

    try {
      ctx.drawImage(videoElement, 0, 0, 64, 36);
      const left = getColor(0, 0, 16, 36, prevColors[0]);
      const right = getColor(48, 0, 16, 36, prevColors[1]);
      const top = getColor(0, 0, 64, 8, prevColors[2]);
      const bottom = getColor(0, 28, 64, 8, prevColors[3]);
      
      prevColors = [left, right, top, bottom];
      drawGlowCanvas(prevColors);
    } catch (e) {
      // Silent catch
    }

    if (videoElement && videoElement.requestVideoFrameCallback) {
      videoElement.requestVideoFrameCallback(update);
    } else {
      setTimeout(update, UPDATE_INTERVAL);
    }
  }

  if (videoElement && videoElement.requestVideoFrameCallback) {
    videoElement.requestVideoFrameCallback(update);
  } else {
    update();
  }
}

function stopGlowLoop() {
  glowActive = false;
  
  // Fade colors to black
  prevColors = [[0,0,0], [0,0,0], [0,0,0], [0,0,0]];
  drawGlowCanvas(prevColors);
  
  logInfo('Ambient Glow Engine Loop stopped');
}

// --- MINIMALIST SEARCH & LAYOUT ---

function setupCustomSearch() {
  if (!settings.searchEnabled) return;

  const mastheadEnd = document.querySelector('ytd-masthead #end');
  if (!mastheadEnd || document.getElementById('custom-search-trigger')) return;

  const trigger = document.createElement('div');
  trigger.id = 'custom-search-trigger';
  trigger.title = 'Search (S)';
  
  // Custom Search SVG
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M15.5 14h-.79l-.28-.27A6.471 6.471 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z');
  svg.appendChild(path);
  trigger.appendChild(svg);

  const toggleSearch = (state) => {
    if (!settings.searchEnabled) return;
    const isActive = state !== undefined ? state : !document.body.classList.contains('search-expanded');
    document.body.classList.toggle('search-expanded', isActive);
    
    if (isActive) {
      const input = document.querySelector('ytd-searchbox input');
      if (input) setTimeout(() => input.focus(), 50);
    }
  };

  trigger.onclick = (e) => {
    e.stopPropagation();
    toggleSearch();
  };

  // Close search overlay on click outside masthead
  document.addEventListener('mousedown', (e) => {
    if (document.body.classList.contains('search-expanded')) {
      const masthead = document.querySelector('ytd-masthead');
      if (masthead && !masthead.contains(e.target)) {
        toggleSearch(false);
      }
    }
  });

  // Close search overlay on Escape
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && document.body.classList.contains('search-expanded')) {
      toggleSearch(false);
    }
  });

  mastheadEnd.prepend(trigger);
  logInfo('Custom search trigger injected');
}

function updateSearchVisibility() {
  const trigger = document.getElementById('custom-search-trigger');
  if (settings.searchEnabled) {
    document.body.classList.add('reigen-search-active');
    if (!trigger) setupCustomSearch();
  } else {
    document.body.classList.remove('reigen-search-active', 'search-expanded');
    if (trigger) trigger.remove();
  }
}

// Global hotkey 'S' to activate search when not typing
document.addEventListener('keydown', (e) => {
  if (!settings.searchEnabled) return;

  const active = document.activeElement;
  const isTyping = active && (
    active.tagName === 'INPUT' || 
    active.tagName === 'TEXTAREA' || 
    active.isContentEditable
  );

  if (e.key.toLowerCase() === 's' && !isTyping && !e.ctrlKey && !e.metaKey && !e.altKey) {
    e.preventDefault();
    document.body.classList.add('search-expanded');
    const input = document.querySelector('ytd-searchbox input');
    if (input) setTimeout(() => input.focus(), 50);
  }
});

// Run layout engine to manage active paths and transparent classes
function initLayoutEngine() {
  function checkPath() {
    const path = window.location.pathname;
    const isWatch = path === '/watch' || path === '/results';
    document.body.classList.toggle('reigen-watching', isWatch);
    // Also toggle html transparency so no dark gaps show at page edges
    document.documentElement.classList.toggle('reigen-html-transparent', isWatch && settings.cinematicEnabled);
  }

  // Poll paths and inject components recursively (No layout checks)
  setInterval(checkPath, 500);
  checkPath();

  // Continually verify search injection
  setInterval(setupCustomSearch, 1000);
  setupCustomSearch();

  // Search for video to bind glow
  checkVideoInterval = setInterval(() => {
    const video = document.querySelector('video');
    if (video) {
      initGlow();
      clearInterval(checkVideoInterval);
    }
  }, 1000);
}

// --- BOOTSTRAP ---
function init() {
  if (window.__ytReigenInitialized) return;

  if (!document.body || !document.head) {
    setTimeout(init, 50);
    return;
  }

  // Ensure critical layout elements are ready before activating transparent engines
  const criticalElements = ['ytd-masthead', '#content'];
  const isReady = criticalElements.every(selector => !!document.querySelector(selector));

  if (!isReady) {
    setTimeout(init, 200);
    return;
  }

  window.__ytReigenInitialized = true;
  logInfo('Initializing layouts...');
  applyVisualSettings();
  initLayoutEngine();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
