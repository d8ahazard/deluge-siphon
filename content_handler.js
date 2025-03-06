/* global stopEvent, communicator, chrome, registerEventListener */
( function ( window, document ) {
  console.log('[delugesiphon] Content handler script loaded');

  /* env check */
  if (!document || !document.addEventListener || !document.body || !document.body.addEventListener) {
    console.warn('[delugesiphon] Environment check failed:', {
      document: !!document,
      addEventListener: !!document?.addEventListener,
      body: !!document?.body,
      bodyAddEventListener: !!document?.body?.addEventListener
    });
    return;
  }

  console.log('[delugesiphon] Environment check passed');

  var CONTROL_KEY_DEPRESSED = false,
    SITE_META = {
      DOMAIN: window.location.host,
      TORRENT_REGEX:
      '^magnet:' 
      + '|(\\/|^)(torrent|torrents)(?=.*action=download)'
      + '|(\\/|^)(index|download)(\\.php)?(\\&|\\?|\\/)(?=.*torrent)'
      // + '|\\/(torrent|download)(\\.php)?(\\/|\\?).+'
      + '|\\.torrent', // eslint-disable-line no-useless-escape
      TORRENT_URL_ATTRIBUTE: 'href',
      INSTALLED: false
    };

  console.log('[delugesiphon] SITE_META initialized:', SITE_META);

  const log = function (...args) {
    console.log('[delugesiphon]', `[${SITE_META.DOMAIN}]`, ...args);
  };

  const warn = function (...args) {
    console.log('[delugesiphon]', `[${SITE_META.DOMAIN}]`, ...args);
  };

  // Verify communicator is available
  if (!communicator) {
    console.error('[delugesiphon] Communicator not found in global scope');
    return;
  }

  console.log('[delugesiphon] Communicator found:', {
    isObject: typeof communicator === 'object',
    hasInit: typeof communicator.init === 'function',
    hasObserveConnect: typeof communicator.observeConnect === 'function'
  });

  // Queue for messages that need to be sent when connection is restored
  let messageQueue = [];
  let isReconnecting = false;

  // Safe message sender that queues messages when disconnected
  function safeSendMessage(message, callback) {
    log('Attempting to send message:', message);
    
    if (!communicator || !communicator._Connected) {
      warn('Connection not available, queueing message:', message);
      messageQueue.push({ message, callback });
      if (!isReconnecting) {
        reconnect();
      }
      return;
    }

    try {
      log('Sending message via communicator:', message);
      communicator.sendMessage(message, function(response) {
        log('Received response from background:', response);
        if (callback) {
          callback(response);
        }
      }, function(error) {
        warn('Message send failed:', error);
        messageQueue.push({ message, callback });
        if (!isReconnecting) {
          reconnect();
        }
      });
    } catch (e) {
      warn('Error sending message:', e);
      messageQueue.push({ message, callback });
      if (!isReconnecting) {
        reconnect();
      }
    }
  }

  // Process queued messages
  function processMessageQueue() {
    while (messageQueue.length > 0 && communicator && communicator._Connected) {
      const { message, callback } = messageQueue.shift();
      try {
        communicator.sendMessage(message, callback);
      } catch (e) {
        warn('Error processing queued message:', e);
        messageQueue.unshift({ message, callback }); // Put it back at the start
        break;
      }
    }
  }

  // Attempt to reconnect
  function reconnect() {
    if (isReconnecting) return;
    isReconnecting = true;
    
    log('Attempting to reconnect...');
    
    // Reset communicator state
    if (communicator) {
      communicator._Connected = false;
      communicator._port = null;
    }

    // Try to reinitialize
    initialize().then(() => {
      isReconnecting = false;
      log('Reconnection successful');
      processMessageQueue();
    }).catch(e => {
      isReconnecting = false;
      warn('Reconnection failed:', e);
      // Try again after a delay
      setTimeout(reconnect, 2000);
    });
  }

  // Initialize communication with background page
  function initCommunication() {
    return new Promise((resolve, reject) => {
      log('Starting communication initialization');
      
      if (!communicator) {
        warn('Communicator not available at init time');
        reject(new Error('Communicator not available'));
        return;
      }

      log('Communicator state:', {
        isConnected: communicator._Connected,
        hasPort: !!communicator._port,
        observerCounts: {
          connect: communicator._connect_observers.length,
          disconnect: communicator._disconnect_observers.length,
          message: communicator._message_observers.length
        }
      });

      // Set up observers before initializing
      communicator
        .observeConnect(function() {
          log('Connect observer triggered');
          connected = true;
          clearTimeout(timeout);
          resolve();
        })
        .observeDisconnect(function() {
          warn('Disconnect observer triggered');
          cleanup_handlers();
          if (!connected) {
            reject(new Error('Connection failed'));
          } else if (!isReconnecting) {
            reconnect();
          }
        })
        .observeMessage(function(request, sendResponse) {
          log('Message observer received:', request);
          
          // Handle context menu click specifically
          if (request.method === "context-menu-click") {
            log('Processing context menu click with data:', request);
            
            // Show modal directly for context menu clicks
            showModal({
                method: 'addlink-todeluge:withoptions',
                url: request.url,
                domain: SITE_META.DOMAIN,
                info: { name: 'Add Torrent' }
            });
            
            if (typeof sendResponse === 'function') {
                sendResponse({ success: true });
            }
            return true;
          }
          
          // Handle direct modal requests
          if (request.method === "add_dialog" || request.method === "addlink-todeluge:withoptions") {
            log('Showing add dialog for:', request);
            try {
                showModal(request);
                if (typeof sendResponse === 'function') {
                    sendResponse({ success: true });
                }
            } catch (e) {
                warn('Error showing modal:', e);
                if (typeof sendResponse === 'function') {
                    sendResponse({ error: e.message });
                }
            }
            return true;
          }
          
          // Log unhandled messages
          log('Unhandled message:', request);
          if (typeof sendResponse === 'function') {
            sendResponse({ error: 'Unhandled message type' });
          }
          return true;
        });

      let connected = false;
      let retryCount = 0;
      const maxRetries = 3;
      const retryDelay = 1000; // 1 second between retries
      
      function tryConnect() {
        if (connected) return;
        
        try {
          log('Attempting connection, try #' + (retryCount + 1));
          communicator.init(true);
          log('Communicator initialized');
          
          // Test connection immediately
          setTimeout(() => {
            if (!connected) {
              safeSendMessage({ method: 'ping' }, function(response) {
                log('Ping response received:', response);
                if (response) {
                  log('Connection verified via ping');
                  connected = true;
                  clearTimeout(timeout);
                  resolve();
                } else if (retryCount < maxRetries) {
                  retryCount++;
                  setTimeout(tryConnect, retryDelay);
                }
              });
            }
          }, 100);
        } catch (e) {
          warn('Error during connection attempt:', e);
          if (retryCount < maxRetries) {
            retryCount++;
            setTimeout(tryConnect, retryDelay);
          } else {
            reject(new Error('Max retries reached'));
          }
        }
      }
      
      // Set a timeout to reject if connection takes too long
      const timeout = setTimeout(() => {
        if (!connected) {
          warn('Communication initialization timed out');
          reject(new Error('Connection timeout'));
        }
      }, 5000);

      // Start connection attempt
      tryConnect();
    });
  }

  // Initialize the site functionality
  async function initialize() {
    try {
      log('Starting initialization...');
      
      // First establish communication
      await initCommunication();
      
      // Initialize site functionality immediately
      site_init();
      
      // Initialize modal container
      modal_init();
      
      // Initialize toast notification system
      initToastSystem();      
      
      log('Initialization complete');
    } catch (e) {
      warn('Initialization error:', e);
      
      if (!initialize.retrying) {
        initialize.retrying = true;
        setTimeout(() => {
          warn('Retrying initialization...');
          initialize.retrying = false;
          initialize();
        }, 2000);
      } else {
        warn('Max retries reached - please refresh the page');
      }
    }
  }

  function cleanup_handlers() {
    document.removeEventListener('keydown', handle_keydown);
    document.removeEventListener('keyup', handle_keyup);
    document.removeEventListener('contextmenu', handle_contextmenu);
    document.body.removeEventListener('click', handle_leftclick);
  }

  function extract_torrent_url(target) {
    log('Attempting to extract torrent URL from:', target);
    var element = target, torrent_match, torrent_url,
      attr = SITE_META.TORRENT_URL_ATTRIBUTE,
      regex = new RegExp(SITE_META.TORRENT_REGEX);

    log('Initial element:', element, 'with attribute:', attr);
    
    // Try the target element first
    if (element.getAttribute(attr)) {
      log('Found attribute on target element');
    } else {
      // Try parent if no attribute on target
      element = target.parentElement;
      log('Trying parent element:', element);
    }
    
    if (!element.getAttribute(attr)) {
      // Try finding first anchor tag
      element = target.closest('a');
      if (!element) {
      element = target.querySelector('a');
      }
      log('Trying anchor element:', element);
    }
    
    if (!element) {
      log('No suitable element found');
      return;
    }

    // Get the URL value
    val = attr === 'href' ? element.href : element.getAttribute(attr);
    log('Found URL value:', val);
    
    if (val) {
      // First try exact regex match
      torrent_match = val.match(regex);
      log('Regex match result:', torrent_match);
      
      if (!torrent_match) {
        // Fallback: check if it ends with .torrent
        if (val.endsWith('.torrent')) {
          log('URL ends with .torrent, using as fallback');
          torrent_match = { input: val };
        }
        // Fallback: check if it contains 'download.php' or similar
        else if (val.includes('download.php') || val.includes('dl.php') || val.includes('get.php')) {
          log('URL contains download pattern, using as fallback');
          torrent_match = { input: val };
        }
      }
    }
    
    if (torrent_match) {
      torrent_url = torrent_match.input;
      log('Successfully extracted torrent URL:', torrent_url);
    } else {
      log('No torrent URL pattern matched');
    }
    
    return torrent_url;
  }

  function process_event(e, with_options) {
    log('Processing event:', e, 'with options:', with_options);
    var torrent_url = extract_torrent_url(e.target);
    if (!torrent_url) {
      log('No torrent URL found in event target');
      return;
    }
    
    log('Processing torrent URL:', torrent_url, 'with options:', with_options);
    stopEvent(e);
  }

  function handle_keydown ( e ) {
    if ( e.ctrlKey ) {
      CONTROL_KEY_DEPRESSED = true;
      log('Control key pressed');
    }
  }

  function handle_keyup ( /*e*/ ) {
    if (CONTROL_KEY_DEPRESSED) {
      log('Control key released');
    Control_KEY_DEPRESSED = false;
    }
  }

  function handle_contextmenu ( e ) {
    log( 'Processing context menu event' );
    var torrentUrl = extract_torrent_url(e.target);
    log('Extracted torrent URL:', torrentUrl);
  }

  function handle_leftclick(e) {
    log('LEFT CLICK', 'CTRL:', CONTROL_KEY_DEPRESSED);
    
    // Ignore clicks on the modal itself
    if (e.target.closest('.delugesiphon-modal')) {
        log('Click inside modal, ignoring');
        return;
    }
    
    if (CONTROL_KEY_DEPRESSED) {
        log('Control + left click detected, processing with options');
        var torrentUrl = extract_torrent_url(e.target);
        log('Extracted torrent URL:', torrentUrl);
        if (torrentUrl) {
            stopEvent(e);
            showModal({
                method: 'addlink-todeluge:withoptions',
                url: torrentUrl,
                domain: SITE_META.DOMAIN,
                info: { name: 'Add Torrent' }
            }, e);
        }
    } else {
        process_event(e, false);
    }
  }

  function handle_visibilityChange () {
    if ( !document.webkitHidden && document.webkitVisibilityState != 'prerender' ) {
      site_init();
    }
  }

  function modal_init() {
    log('Initializing modal...');
    var modalId = 'delugesiphon-modal-' + chrome.runtime.id;
    
    // Create or get modal container and overlay
    var modal = document.getElementById(modalId);
    var overlay = document.getElementById(modalId + '-overlay');
    
    if (!modal) {
        modal = document.createElement('div');
        modal.id = modalId;
        modal.className = 'delugesiphon-modal';
        document.body.appendChild(modal);
        
        overlay = document.createElement('div');
        overlay.id = 'delugesiphon-backdrop-' + chrome.runtime.id;
        overlay.className = 'delugesiphon-modal-overlay';
        document.body.appendChild(overlay);
        
        log('Created modal container');
    }

    // Verify modal exists
    const addedModal = document.getElementById(modalId);
    if (!addedModal) {
        warn('Failed to find modal in DOM after creation');
        return;
    }
    
    log('Modal initialization complete');
    return modal;
  }

  function showModal(req, clickEvent) {
    log('Showing modal with config:', req);
    
    // Ensure we have a URL to work with
    if (!req.url) {
        warn('No URL provided for modal');
        return;
    }

    var modalId = 'delugesiphon-modal-' + chrome.runtime.id;
    var modal = document.getElementById(modalId);
    var overlay = document.getElementById("delugesiphon-backdrop-" + chrome.runtime.id);
    
    if (!modal) {
        warn('Modal container not found, initializing...');
        modal = modal_init();
        overlay = document.getElementById("delugesiphon-backdrop-" + chrome.runtime.id);
        if (!modal) {
            warn('Failed to initialize modal');
            return;
        }
    }

    // Show the modal immediately with loading state
    modal.innerHTML = `
        <form action="javascript:void(0);">
            <h3>${req.info?.name || 'Add Torrent'}</h3>
            <div class="note">${req.url}</div>
            <input type="hidden" name="url" value="${req.url}"/>
            <div class="loading">Loading options...</div>
        </form>
    `;
    
    // Show the modal and overlay immediately
    modal.classList.add('displayed');
    overlay.classList.add('displayed');
    log('Modal displayed with loading state');

    // Default data structure
    const defaultData = {
        plugins: {},
        defaultLabel: '',
        config: {
            add_paused: false,
            download_location: '',
            move_completed: false,
            move_completed_path: ''
        }
    };

    // Get plugin info with timeout
    log('Requesting plugin info...');
    const pluginInfoPromise = new Promise((resolve, reject) => {
        const timeoutId = setTimeout(() => {
            warn('Plugin info request timed out');
            resolve(defaultData);
        }, 5000);

        safeSendMessage({
            method: 'plugins-getinfo'
        }, function(response) {
            clearTimeout(timeoutId);
            log('Plugin info response received:', response);
            
            if (!response || response.error) {
                warn('Plugin info request failed:', response?.error || 'No response');
                resolve(defaultData);
                return;
            }

            // Extract plugins and config from response
            const { plugins, config } = response.value || {};
            
            // Debug plugin info structure
            log('Plugin info structure:', JSON.stringify(plugins));
            log('Label plugin data:', JSON.stringify(plugins?.Label));
            
            // Get default label
            log('Processing server response...');
            resolve({
                plugins: plugins || {},
                config: config || defaultData.config,
                defaultLabel: ''  // We'll get this next
            });
        });
    });

    // Render the modal with whatever data we have after the timeout or successful response
    pluginInfoPromise.then(data => {
        // Get default label if we have plugin data
        if (data.plugins?.Label?.length > 0) {
            return new Promise(resolve => {
                safeSendMessage({
                    method: 'storage-get-default_label'
                }, function(labelResponse) {
                    log('Default label response received:', labelResponse);
                    data.defaultLabel = labelResponse?.value || '';
                    resolve(data);
                });
            });
        }
        return data;
    }).then(data => {
        log('Final data for rendering:', data);
        // Ensure plugins structure is correct
        if (!data.plugins) {
            data.plugins = {};
        }
        if (!data.plugins.Label && Array.isArray(data.plugins.labels)) {
            // Handle case where labels might be under a different property
            data.plugins.Label = data.plugins.labels;
        }
        renderModalContent(data);
    }).catch(error => {
        warn('Error during data loading:', error);
        renderModalContent(defaultData);
    });

    function renderModalContent(data) {
        try {
            log('Starting modal content render with:', data);
            
            modal.innerHTML = `
                <form action="javascript:void(0);" class="delugesiphon-form">
                    <h3>${req.info?.name || 'Add Torrent'}</h3>
                    <div class="note">${req.url}</div>
                    <input type="hidden" name="url" value="${req.url}"/>
                    
                    ${data.plugins?.Label?.length > 0 ? `
                    <div class="form-group">
                        <label>Label:</label>
                        <select name="plugins[Label]">
                            <option value="">No Label</option>
                            ${data.plugins.Label.map(label => 
                                `<option value="${label}" ${label === data.defaultLabel ? 'selected' : ''}>${label}</option>`
                            ).join('\n')}
                        </select>
                    </div>
                    ` : '<!-- No Label plugin data available -->'}
                    
                    ${data.plugins?.AutoAdd?.length > 0 ? `
                    <div class="form-group">
                        <label>Watch Directory:</label>
                        <select name="plugins[AutoAdd]">
                            <option value="">Default Location</option>
                            ${data.plugins.AutoAdd.map(path => 
                                `<option value="${path}">${path}</option>`
                            ).join('\n')}
                        </select>
                    </div>
                    ` : ''}

                    <div class="form-group">
                        <label>Download Location:</label>
                        <input type="text" name="options[download_location]" value="${data.config?.download_location || ''}"/>
                    </div>

                    <div class="form-group">
                        <label>
                            <input type="checkbox" name="options[add_paused]" ${data.config?.add_paused ? 'checked' : ''}/>
                            Add Paused
                        </label>
                    </div>
                    
                    <div class="form-group">
                        <label>
                            <input type="checkbox" name="options[move_completed]" ${data.config?.move_completed ? 'checked' : ''}/>
                            Move on Completion
                        </label>
                    </div>

                    ${data.config?.move_completed ? `
                    <div class="form-group">
                        <label>Move Completed To:</label>
                        <input type="text" name="options[move_completed_path]" value="${data.config?.move_completed_path || ''}"/>
                    </div>
                    ` : ''}
                    
                    <div class="actions">
                        <button type="button" class="cancel">Cancel</button>
                        <button type="submit">Add</button>
                    </div>
                </form>
            `;
            
            log('Modal content rendered, setting up event listeners...');
            setupModalEventListeners();
            
            // Show/hide move completed path field based on checkbox
            const moveCompletedCheck = modal.querySelector('input[name="options[move_completed]"]');
            if (moveCompletedCheck) {
                moveCompletedCheck.addEventListener('change', function() {
                    const pathGroup = modal.querySelector('input[name="options[move_completed_path]"]')?.closest('.form-group');
                    if (pathGroup) {
                        pathGroup.style.display = this.checked ? 'block' : 'none';
                    }
                });
            }
        } catch (e) {
            warn('Error rendering modal content:', e);
            modal.innerHTML = `
                <form action="javascript:void(0);" class="delugesiphon-form">
                    <h3>Add Torrent</h3>
                    <div class="note">${req.url}</div>
                    <input type="hidden" name="url" value="${req.url}"/>
                    <div class="form-group">
                        <label>Error loading options. Add anyway?</label>
                    </div>
                    <div class="actions">
                        <button type="button" class="cancel">Cancel</button>
                        <button type="submit">Add</button>
                    </div>
                </form>
            `;
            setupModalEventListeners();
        }
        
        log('Modal setup complete');
    }

    function setupModalEventListeners() {
        const form = modal.querySelector('form');
        if (!form) return;

        // Stop propagation of all events within the modal
        modal.addEventListener('click', function(e) {
            e.stopPropagation();
        });
        
        // Add form submit handler
        form.addEventListener('submit', handleFormSubmit);

        // Handle move completed checkbox
        const moveCompletedCheckbox = form.querySelector('input[name="options[move_completed]"]');
        const moveCompletedPath = form.querySelector('input[name="options[move_completed_path]"]');
        if (moveCompletedCheckbox && moveCompletedPath) {
            moveCompletedCheckbox.addEventListener('change', function() {
                moveCompletedPath.disabled = !this.checked;
            });
        }
        
        // Handle cancel button
        const cancelBtn = form.querySelector('button.cancel');
        if (cancelBtn) {
            cancelBtn.addEventListener('click', hideModal);
        }

        // Handle overlay click
        overlay.addEventListener('click', hideModal);
        
        // Handle escape key
        const escapeHandler = function(e) {
            if (e.key === 'Escape') {
                hideModal();
            }
        };
        document.addEventListener('keydown', escapeHandler);
        
        // Store the escape handler for cleanup
        modal.escapeHandler = escapeHandler;
    }

    function handleFormSubmit(e) {
        e.preventDefault();
        
        // Close modal immediately
        hideModal();
        
        const formData = new FormData(e.target);
        const data = {
            method: 'addlink-todeluge',
            url: formData.get('url'),
            domain: SITE_META.DOMAIN,
            options: {},
            plugins: {}
        };

        // Process options and plugins
        for (let [key, value] of formData.entries()) {
            if (key.startsWith('options[')) {
                const optionKey = key.match(/options\[(.*?)\]/)[1];
                data.options[optionKey] = value === 'on' ? true : value;
            } else if (key.startsWith('plugins[')) {
                const pluginKey = key.match(/plugins\[(.*?)\]/)[1];
                if (value) {
                    data.plugins[pluginKey] = value;
                }
            }
        }

        log('Submitting form data:', data);

        // Save selected label as default if one was chosen
        if (data.plugins.Label) {
            safeSendMessage({
                method: 'storage-set',
                key: 'default_label',
                value: data.plugins.Label
            });
        }

        // Show a loading toast
        const loadingToastId = showToast('Adding torrent to Deluge...', 'info', 0);

        // Send the torrent add request
        safeSendMessage(data, function(response) {
            // Remove the loading toast
            removeToast(loadingToastId);
            
            if (response?.error) {
                log('Error adding torrent:', response.error);
                showToast(`Error adding torrent: ${response.error}`, 'error', 5000);
            } else {
                log('Torrent added successfully');
                
                // Build success message with details
                let successMsg = 'Torrent added successfully';
                
                // Add label info if available
                if (data.plugins.Label) {
                    successMsg += ` with label "${data.plugins.Label}"`;
                }
                
                // Add paused state if set
                if (data.options.add_paused) {
                    successMsg += ' (paused)';
                }
                
                // Show success toast
                showToast(successMsg, 'success', 5000);
            }
        });
    }

    function hideModal() {
        log('Hiding modal');
        modal.classList.remove('displayed');
        overlay.classList.remove('displayed');
        
        // Remove event listeners
        overlay.removeEventListener('click', hideModal);
        if (modal.escapeHandler) {
            document.removeEventListener('keydown', modal.escapeHandler);
            delete modal.escapeHandler;
        }
        
        // Clear content
        modal.innerHTML = '';
    }
  }

  function install_configurable_handlers () {
    log('Installing configurable handlers');

    /* install control + rightclick keyboard macro */
    safeSendMessage({
      method: "storage-get-enable_keyboard_macro"
    }, function ( response ) {
      if ( response.value ) {
        log('Enabling keyboard macro handlers');
        document.addEventListener( 'keydown', handle_keydown );
        document.addEventListener( 'keyup', handle_keyup );
        document.addEventListener( 'contextmenu', handle_contextmenu );
      } else {
        log('Disabling keyboard macro handlers');
        document.removeEventListener( 'keydown', handle_keydown );
        document.removeEventListener( 'keyup', handle_keyup );
        document.removeEventListener( 'contextmenu', handle_contextmenu );
      }
    } );

    /* send a test message to get the cookies */
    safeSendMessage( {
      action: "getCookies",
      url: window.location.href
    }, function ( response ) {
      if (response?.cookies) {
        log('Cookies received:', response.cookies);
      } else if (response?.error) {
        warn('Error getting cookies:', response.error);
      }
    } );
    
    /* install leftclick handling */
    safeSendMessage( {
      method: "storage-get-enable_leftclick"
    }, function ( response ) {
      if ( !!response.value ) {
        log('Enabling left click handler');
        document.body.addEventListener( 'click', handle_leftclick );
      } else {
        log('Disabling left click handler');
        document.body.removeEventListener( 'click', handle_leftclick );
      }
    } );
  }

  function site_init() {
    if (!communicator._Connected) {
      warn('Cannot initialize site - communicator not connected');
      return;
    }

    log('Initializing site functionality');
    
    // Initialize the modal container
    modal_init();
    
    // Set default regex if none provided
    const defaultRegex = '^magnet:|(\\/|^)(torrent|torrents|dl|download|get)(\\.php)?(?=.*action=download|\\.torrent)|(\\/|^)(index|download)(\\.php)?(\\&|\\?|\\/)(?=.*torrent)|\\.torrent';
    
    // Get regex for link checking from settings
    safeSendMessage({
      method: 'storage-get-link_regex'
    }, function(response) {
      if (!response) {
        warn('No response from link regex request, using default');
        SITE_META.TORRENT_REGEX = defaultRegex;
        install_configurable_handlers();
        return;
      }
      
      log('Link regex configuration:', response);
      
      // Use provided regex or fall back to default
      SITE_META.TORRENT_REGEX = response.value || defaultRegex;
      log('Using torrent regex pattern:', SITE_META.TORRENT_REGEX);

      // Check if we're on Deluge UI before installing handlers
      safeSendMessage({
        method: 'storage-get-connections'
      }, function(response) {
        try {
          var conns = response.value || [];
          var currentUrl = new URL(window.location.href);
          var currentPathname = currentUrl.pathname.replace(/\/$/, "");
          
        for (var i = 0, l = conns.length; i < l; i++) {
            try {
              var connUrl = new URL(conns[i].url);
          var connPathname = connUrl.pathname.replace(/\/$/, "");
              
              if (currentUrl.hostname === connUrl.hostname && currentPathname === connPathname) {
                warn('On Deluge web UI page - not installing handlers');
                return;
              }
            } catch (e) {
              warn('Error parsing connection URL:', e);
              continue;
            }
          }
          
          // Not on Deluge UI, install handlers
          install_configurable_handlers();
        } catch (e) {
          warn('Error checking Deluge UI:', e);
          // Install handlers anyway if check fails
          install_configurable_handlers();
        }
      });
    });
  }

  // Start initialization immediately and also set up for document ready
  initialize().catch(e => {
    warn('Initial initialization failed:', e);
    if (document.readyState !== 'complete') {
      log('Document not ready, will retry on DOMContentLoaded');
      document.addEventListener('DOMContentLoaded', () => {
        log('DOMContentLoaded fired, retrying initialization');
        initialize();
      });
    }
  });
  
  // Re-initialize when the page becomes visible, but only if we're not already connected
  document.addEventListener('webkitvisibilitychange', function() {
    log('Visibility changed:', {
      hidden: document.webkitHidden,
      state: document.webkitVisibilityState
    });
    if (!document.webkitHidden && document.webkitVisibilityState !== 'prerender' && (!communicator || !communicator._Connected)) {
      log('Page became visible and not connected, reinitializing');
      initialize();
    }
  });
  
  log('Content handler setup complete');
  
  // Toast notification system
  function initToastSystem() {
    // Create container if it doesn't exist
    let toastContainer = document.querySelector('.delugesiphon-toast-container');
    if (!toastContainer) {
      toastContainer = document.createElement('div');
      toastContainer.className = 'delugesiphon-toast-container';
      document.body.appendChild(toastContainer);
    }
    
    // Store reference for later use
    window.delugesiphonToastContainer = toastContainer;
  }

  // Show a toast notification
  function showToast(message, type = 'info', duration = 5000) {
    if (!window.delugesiphonToastContainer) {
      initToastSystem();
    }
    
    // Generate unique ID for this toast
    const toastId = 'toast-' + Date.now() + '-' + Math.floor(Math.random() * 1000);
    
    // Create icons based on type
    const icons = {
      success: '✓',
      error: '✗',
      warning: '⚠',
      info: 'ℹ'
    };
    
    // Create toast element
    const toast = document.createElement('div');
    toast.className = `delugesiphon-toast ${type}`;
    toast.id = toastId;
    toast.style.opacity = '1'; // Ensure it's visible
    toast.style.transform = 'translateX(0)'; // Start in correct position
    toast.innerHTML = `
      <div class="delugesiphon-toast-icon">${icons[type] || icons.info}</div>
      <div class="delugesiphon-toast-content">${message}</div>
      <div class="delugesiphon-toast-close">×</div>
    `;
    
    // Add to container
    window.delugesiphonToastContainer.appendChild(toast);
    
    // Set up close button
    const closeBtn = toast.querySelector('.delugesiphon-toast-close');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => {
        removeToast(toastId);
      });
    }
    
    // Auto-remove after duration
    if (duration > 0) {
      setTimeout(() => {
        removeToast(toastId);
      }, duration);
    }
    
    // Log toast
    log('Toast notification shown:', { message, type, duration });
    
    return toastId;
  }

  // Remove a toast by ID
  function removeToast(toastId) {
    const toast = document.getElementById(toastId);
    if (!toast) return;
    
    // Add the remove class to trigger the slide-out animation
    toast.classList.add('remove');
    
    // Remove element after animation completes
    setTimeout(() => {
      if (toast.parentNode) {
        toast.parentNode.removeChild(toast);
      }
    }, 300);
  }
} )( window, document );
