// YT-Reigen Control Panel Script

document.addEventListener('DOMContentLoaded', () => {
  // Elements
  const glowEnabled = document.getElementById('glowEnabled');
  const searchEnabled = document.getElementById('searchEnabled');
  const statusBadge = document.getElementById('statusBadge');

  // Load current settings from storage
  chrome.storage.local.get([
    'glowEnabled',
    'searchEnabled'
  ], (result) => {
    // Set default fallbacks if undefined
    const defaults = {
      glowEnabled: true,
      searchEnabled: true
    };

    const current = { ...defaults, ...result };

    // Apply values to UI inputs
    glowEnabled.checked = current.glowEnabled;
    searchEnabled.checked = current.searchEnabled;

    updateStatusText();
  });

  // Set active tab status
  function updateStatusText() {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const activeTab = tabs[0];
      if (activeTab && activeTab.url && activeTab.url.includes('youtube.com')) {
        statusBadge.innerHTML = `<span class="status-dot pulsing"></span><span class="status-text">Active on YouTube</span>`;
        statusBadge.style.background = 'rgba(16, 185, 129, 0.08)';
        statusBadge.style.borderColor = 'rgba(16, 185, 129, 0.15)';
      } else {
        statusBadge.innerHTML = `<span class="status-dot" style="background-color: #9ca3af; box-shadow: none;"></span><span class="status-text" style="color: #9ca3af;">Open YouTube</span>`;
        statusBadge.style.background = 'rgba(156, 163, 175, 0.08)';
        statusBadge.style.borderColor = 'rgba(156, 163, 175, 0.15)';
      }
    });
  }

  // Event Listeners for Toggles
  glowEnabled.addEventListener('change', (e) => {
    chrome.storage.local.set({ glowEnabled: e.target.checked });
  });


  searchEnabled.addEventListener('change', (e) => {
    chrome.storage.local.set({ searchEnabled: e.target.checked });
  });
});
