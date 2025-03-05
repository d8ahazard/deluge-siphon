(() => {
  // Helper function to get elements by ID
  const getEl = id => document.getElementById(id);
  
  // Elements we'll be working with
  const serverUrlDiv = getEl('server-url');
  const serverUrlLink = getEl('server-url-link');
  const reminder = getEl('reminder');

  function updateUI(serverUrl) {
    if (serverUrl) {
      serverUrlDiv.classList.remove('hidden');
      serverUrlLink.href = serverUrl;
      reminder.textContent = '';
    } else {
      serverUrlDiv.classList.add('hidden');
      serverUrlLink.removeAttribute('href');
      reminder.textContent = "Don't forget to configure your server info first!";
    }
  }

  // Remove focus from links after clicking
  document.querySelectorAll('a').forEach(link => {
    link.addEventListener('click', e => e.target.blur());
  });

  // Initialize communication and get server info
  communicator.observeConnect(() => {
    communicator.sendMessage({
      method: "storage-get-connections"
    }, response => {
      try {
        const serverUrl = response?.value?.[0]?.url;
        updateUI(serverUrl);
      } catch (e) {
        console.error('Error getting server URL:', e);
        updateUI(null);
      }
    });
  }).init('popup');
})();
