// YT-Reigen Background Service Worker

// Initialize default settings upon installation
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get([
    'glowEnabled',
    'searchEnabled'
  ], (result) => {
    const defaults = {
      glowEnabled: true,
      searchEnabled: true
    };

    const updates = {};
    for (const key in defaults) {
      if (result[key] === undefined) {
        updates[key] = defaults[key];
      }
    }

    if (Object.keys(updates).length > 0) {
      chrome.storage.local.set(updates, () => {
        console.log('[YT-Reigen] Default settings initialized:', updates);
      });
    }
  });
});
