/* global chrome, communicator */
// debug
let DEBUG = false;
chrome.storage.local.get('enable_debug_logging', function(data) {
  DEBUG = !!data.enable_debug_logging;
  if (DEBUG) {
    console.warn('*** Debug logging enabled ***');
  }
});

function debugLog(...args) {
  if (DEBUG) {
    console.log(...args);
  }
}

/**
 * Utility function to retry a promise-based operation with exponential backoff
 * @param {Function} operation - Function returning a promise to retry
 * @param {Object} options - Retry options
 * @param {number} options.maxRetries - Maximum number of retry attempts
 * @param {number} options.baseDelay - Base delay in ms before retrying
 * @param {number} options.maxDelay - Maximum delay in ms
 * @param {Function} options.shouldRetry - Function to determine if retry should happen
 * @returns {Promise} - The operation promise with retry logic
 */
function retryWithBackoff(operation, options = {}) {
  const maxRetries = options.maxRetries || 3;
  const baseDelay = options.baseDelay || 1000;
  const maxDelay = options.maxDelay || 10000;
  const shouldRetry = options.shouldRetry || (() => true);
  
  return new Promise((resolve, reject) => {
    let attempts = 0;
    
    function attempt() {
      attempts++;
      return operation()
        .then(resolve)
        .catch(error => {
          if (attempts < maxRetries && shouldRetry(error)) {
            console.log(`Operation failed, retrying (${attempts}/${maxRetries})...`, error.message);
            
            // Calculate delay with exponential backoff and jitter
            const delay = Math.min(
              maxDelay,
              baseDelay * Math.pow(2, attempts - 1) * (0.9 + Math.random() * 0.2)
            );
            
            console.log(`Retrying in ${Math.round(delay / 100) / 10} seconds...`);
            setTimeout(attempt, delay);
          } else {
            reject(error);
          }
        });
    }
    
    return attempt();
  });
}

// globals...
const UA = navigator.userAgent;
const COOKIES = {}; // we need to hang onto your cookies so deluge can ask your sites for files directly..

/* BEGIN DelugeConnection */
function DelugeConnection() {
  debugLog('*** new DelugeConnection ***');
  this.state = '';
  this.daemon_hosts = [];
  this.CONNECT_ATTEMPTS = 0;
  this.DAEMON_INFO = {
    status: '',
    port: null,
    ip: null,
    host_id: null,
    version: null
  };
  this.CONNECTION_INFO = [];
  this.SERVER_URL = null;
  this.SERVER_PASS = null;
  this.server_config = {};
  this.plugin_info = {};
}

DelugeConnection.prototype._initState = function() {
  return new Promise((resolve, reject) => {
    console.warn('_initState: Starting initialization');
    
    // First, verify storage access
    chrome.storage.local.get('test', (result) => {
      console.warn('_initState: Storage access test:', result);
      
      // Now try to get connections specifically
      chrome.storage.local.get('connections', data => {
        console.warn('_initState: Raw connections data:', data);
        
        // Debug: List all storage keys
        chrome.storage.local.get(null, allData => {
          console.warn('_initState: All storage keys:', Object.keys(allData));
        });
        
        try {
          if (data && data.connections) {
    if (typeof data.connections === 'string') {
              console.warn('_initState: Parsing connections string');
      try {
        this.CONNECTION_INFO = JSON.parse(data.connections);
              } catch (e) {
                console.error('_initState: JSON parse error:', e);
                this.CONNECTION_INFO = [];
              }
            } else {
              console.warn('_initState: Using connections directly:', data.connections);
              this.CONNECTION_INFO = data.connections;
            }
          } else {
            console.warn('_initState: No connections data found in storage');
            this.CONNECTION_INFO = [];
          }
          
    if (!Array.isArray(this.CONNECTION_INFO)) {
            console.warn('_initState: CONNECTION_INFO is not an array, resetting to empty array');
      this.CONNECTION_INFO = [];
    }

          console.warn('_initState: Final CONNECTION_INFO:', this.CONNECTION_INFO);

    this.SERVER_URL = this.CONNECTION_INFO.length ? this.CONNECTION_INFO[0].url : null;
    this.SERVER_PASS = this.CONNECTION_INFO.length ? this.CONNECTION_INFO[0].pass : null;
          
          console.warn('_initState: Final state:', {
            SERVER_URL: this.SERVER_URL,
            SERVER_PASS: this.SERVER_PASS ? '[REDACTED]' : null,
            CONNECTION_INFO_LENGTH: this.CONNECTION_INFO.length
          });
          
          resolve();
        } catch (error) {
          console.error('_initState: Critical error:', error);
          this.CONNECTION_INFO = [];
          this.SERVER_URL = null;
          this.SERVER_PASS = null;
          resolve(); // Resolve anyway to allow retry logic to work
        }
      });
    });
  });
};

/* public methods */
DelugeConnection.prototype.connectToServer = function() {
  return this._initState().then(() => {
  if (!this.SERVER_URL) {
    notify({
      message: 'Server URL is not set',
      contextMessage: 'Click here to visit the options page!',
      isClickable: true,
      requireInteraction: true
    }, -1, 'needs-settings', 'error');

      return Promise.reject(new Error('Server URL not set'));
  }

  return this._connect();
  });
};

DelugeConnection.prototype.addTorrent = function(url, cookie_domain, plugins, options) {
  console.log('[addTorrent] Called with:', url, cookie_domain, plugins, options);
  
  if (!this.SERVER_URL) {
    const error = new Error('SERVER_URL is not set. Please configure it in the options.');
    console.error('[addTorrent] Rejected due to missing SERVER_URL:', error);
    
    notify({
      message: 'Please visit the options page to get started!'
    }, -1, this._getNotificationId(), 'error');

    return Promise.reject(error);
  }

  notify({
    message: 'Adding torrent' + (plugins?.Label ? ` with label: ${plugins.Label}` : '') + '...',
    contextMessage: url
  }, 3000, this._getNotificationId(url), 'request');

  console.log('[addTorrent] Starting connection...');
  
  return this._connect()
    .then(() => {
      console.log('[addTorrent] Connected, getting cookies...');
      return this._getDomainCookies(url, cookie_domain);
    })
    .then(() => {
      console.log('[addTorrent] Got cookies, adding torrent...');
      return this._addTorrentUrlToServer(url, options, cookie_domain);
    })
    .then((torrentId) => {
      console.log('[addTorrent] Torrent added successfully:', torrentId);
      
      // Process plugins (like labels) if provided
      if (plugins && Object.keys(plugins).length > 0) {
        return this._processPluginOptions(url, plugins, torrentId)
          .then(() => {
            notify({
              message: 'Torrent added successfully' + (plugins.Label ? ` with label: ${plugins.Label}` : ''),
              contextMessage: url
            }, 5000, this._getNotificationId(url), 'added');
            return torrentId;
          });
      }
      
      notify({
        message: 'Torrent added successfully',
        contextMessage: url
      }, 5000, this._getNotificationId(url), 'added');
      
      return torrentId;
    })
    .catch(error => {
      console.error('[addTorrent] Error:', error);
      notify({
        message: 'Error adding torrent',
        contextMessage: error.message || 'Unknown error'
      }, 5000, this._getNotificationId(url), 'error');
      throw error;
    });
};

DelugeConnection.prototype.getTorrentInfo = function(url, cookie_domain) {
  if (!this.SERVER_URL) {
    notify({
      message: 'Please visit the options page to get started!'
    }, -1, this._getNotificationId(), 'error');
    return Promise.reject(new Error('Server URL not set'));
  }

  notify({ message: 'Getting torrent info...' }, 3000, this._getNotificationId(url), null);

  return this._connect()
    .then(() => this._getDomainCookies(url, cookie_domain))
    .then(() => this._getPlugins())
    .then(() => this._downloadTorrent(url, cookie_domain))
    .then(result => this._getTorrentInfo(result));
};

DelugeConnection.prototype.getPluginInfo = function(silent) {
  return this._connect(silent).then(() => this._getPlugins());
};

/* helpers */
DelugeConnection.prototype._serverError = function(payload, silent) {
  if (payload.error) {
    console.error('_serverError', payload);
    const contextMessage = String(payload.error.message || this.state);
    if (!silent && contextMessage) {
      notify({ 
        message: 'Deluge server error', 
        contextMessage 
      }, -1, this._getNotificationId(), 'error');
    }
    return true;
  }
  return false;
};

DelugeConnection.prototype._getNotificationId = function(torrent_url) {
  return torrent_url ? String(torrent_url.hashCode()) : `server-${Date.now()}`;
};

/* Promise helpers */
DelugeConnection.prototype._connect = function(silent) {
  // Always ensure state is initialized first
  return this._initState()
    .then(() => {
      console.log('State initialized:', {
        SERVER_URL: this.SERVER_URL,
        CONNECTION_INFO: this.CONNECTION_INFO
      });
      
      if (!this.SERVER_URL) {
        return Promise.reject(new Error('Server URL not set after initialization'));
      }
      
      return this._getSession()
        .catch(() => this._doLogin(silent))
        .then(() => this._checkDaemonConnection())
        .catch(() => this._getDaemons()
          .then(daemons => this._getConnectedDaemon(daemons))
        )
        .then(() => this._getServerConfig());
    });
};

DelugeConnection.prototype._request = function(state, params, silent) {
  this.state = state;
  
  console.log('[_request] Starting request:', {
    state,
    params,
    SERVER_URL: this.SERVER_URL ? this.SERVER_URL.replace(/:[^\/]+@/, ':*****@') : null,
    CONNECTION_INFO: this.CONNECTION_INFO ? 'Connection info exists' : 'No connection info'
  });
  
  if (!this.SERVER_URL) {
    // Try to re-initialize state if SERVER_URL is not available
    console.log('[_request] No SERVER_URL, trying to reinitialize state');
    return this._initState().then(() => {
      if (!this.SERVER_URL) {
        console.error('[_request] SERVER_URL still not available after _initState');
        return Promise.reject(new Error('Server URL not available'));
      }
      console.log('[_request] STATE reinitialized, retrying request');
      // Retry the request now that we have initialized
      return this._request(state, params, silent);
    });
  }
  
  let url;
  try {
    // Ensure we have a valid URL by properly joining paths
    const baseUrl = this.SERVER_URL.endsWith('/') ? this.SERVER_URL : this.SERVER_URL + '/';
    url = new URL('json', baseUrl).href;
    console.log('[_request] Request URL (redacted):', url.replace(/:[^\/]+@/, ':*****@'));
  } catch (e) {
    console.error('[_request] Error constructing URL:', e);
    return Promise.reject(new Error('Invalid server URL'));
  }

  let headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json'
  };
  
  if (this.SESSION_COOKIE) {
    console.log('[_request] Adding session cookie to request');
    headers['Cookie'] = this.SESSION_COOKIE;
  }
  
  if (this.CSRF_TOKEN) {
    console.log('[_request] Adding CSRF token to request');
    headers['X-CSRF-Token'] = this.CSRF_TOKEN;
  }

  const fetchOptions = {
    method: 'POST',
    headers: headers,
    body: JSON.stringify(params),
    credentials: 'include'
  };

  console.log('[_request] Making fetch request to Deluge server:', { 
    url: url.replace(/:[^\/]+@/, ':*****@'), 
    method: params.method,
    id: params.id,
    headers: Object.keys(headers)
  });

  const timeoutDuration = 20000;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutDuration);
  fetchOptions.signal = controller.signal;
  
  return fetch(url, fetchOptions)
    .then(response => {
      clearTimeout(timeoutId);
      
      console.log(`[_request] Response received: ${response.status} ${response.statusText}`);
      
      const cookies = response.headers.get('set-cookie');
      if (cookies) {
        console.log('[_request] Received cookies from server');
        this.SESSION_COOKIE = cookies;
      }
      
      const csrfToken = response.headers.get('X-CSRF-Token') || response.headers.get('x-csrf-token');
      if (csrfToken) {
        console.log('[_request] Received CSRF token from server');
        this.CSRF_TOKEN = csrfToken;
      }
      
      if (!response.ok) {
        console.error('[_request] HTTP error:', response.status, response.statusText);
        // Only treat 403 as auth error if it's not a torrent add operation
        if (response.status === 403 && !params.method.includes('add_torrent')) {
          console.log('[_request] 403 Forbidden on non-torrent operation - attempting to re-authenticate');
          this.SESSION_COOKIE = null;
          this.CSRF_TOKEN = null;
          return this._doLogin(silent).then(() => {
            return this._request(state, params, silent);
          });
        }
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      return response.json();
    })
    .then(payload => {
      console.log('[_request] Response payload:', JSON.stringify(payload).substring(0, 200) + '...');
      
      if (this._serverError(payload, silent)) {
        console.error('[_request] Server reported error:', payload.error);
        
        // Check if this is a 403 from a remote server (for torrent operations)
        if (payload.error?.message?.includes('403 Forbidden') && params.method.includes('add_torrent')) {
          console.log('[_request] Remote server returned 403 - this is likely a torrent access issue');
          return Promise.reject(new Error('Remote server denied access - the site may require authentication'));
        }
        
        // Only treat authentication-specific errors as auth issues
        if (payload.error?.message?.includes('Not authenticated')) {
          console.log('[_request] Authentication error detected, attempting to re-authenticate');
          this.SESSION_COOKIE = null;
          this.CSRF_TOKEN = null;
          return this._doLogin(silent).then(() => {
            return this._request(state, params, silent);
          });
        }
        
        return Promise.reject(new Error(payload.error?.message || 'Server error'));
      }
      
      console.log('[_request] Request completed successfully:', state);
      return payload;
    })
    .catch(error => {
      clearTimeout(timeoutId);
      
      console.error('[_request] Request failed:', error);
      
      if (error.name === 'AbortError') {
        console.error('[_request] Request timed out after', timeoutDuration, 'ms');
        if (!silent) {
          notify({
            message: 'Connection to Deluge timed out',
            contextMessage: 'Check if your server is reachable and not overloaded'
          }, 5000, this._getNotificationId(), 'error');
        }
      } else if (!silent) {
        notify({
          message: 'Error connecting to Deluge',
          contextMessage: error.message || 'Check network connection and server URL'
        }, 5000, this._getNotificationId(), 'error');
      }
      throw error;
    });
};

DelugeConnection.prototype._getDomainCookies = function(url, cookie_domain) {
  return new Promise((resolve) => {
    chrome.storage.local.get('send_cookies', data => {
      if (!data.send_cookies) {
        console.log('_getDomainCookies', 'Sending cookies is disabled');
        resolve('');
        return;
      }

      try {
        const hostname = new URL(url).hostname;
        // Remove any leading dots from cookie_domain for comparison
        const cleanCookieDomain = cookie_domain?.replace(/^\./, '');
        if (!cleanCookieDomain || !hostname.endsWith(cleanCookieDomain)) {
          console.log('_getDomainCookies', cookie_domain, '!=', hostname);
          resolve('');
          return;
        }

        // Get cookies for all possible domain variants:
        // 1. Exact domain
        // 2. Domain with leading dot
        // 3. Domain parts (for subdomains)
        const domains = new Set([cookie_domain]);
        
        // Add dot-prefixed version if not already present
        if (!cookie_domain.startsWith('.')) {
          domains.add('.' + cookie_domain);
        }
        
        // Add domain parts for subdomain cookies
        const parts = cleanCookieDomain.split('.');
        for (let i = 1; i < parts.length - 1; i++) {
          const parentDomain = parts.slice(i).join('.');
          domains.add(parentDomain);
          domains.add('.' + parentDomain);
        }

        console.log('_getDomainCookies', 'Fetching cookies for domains:', Array.from(domains));

        // Get cookies for all domain variants
        Promise.all(Array.from(domains).map(domain => 
          new Promise(resolveInner => {
            chrome.cookies.getAll({ domain }, cookies => {
              const validCookies = (cookies || []).filter(cookie => {
                // Only include cookies that:
                // 1. Match our domain or its subdomains
                const cookieDomainMatches = cookie.domain.replace(/^\./, '') === cleanCookieDomain ||
                                          cleanCookieDomain.endsWith('.' + cookie.domain.replace(/^\./, ''));
                return cookieDomainMatches;
              });
              console.log('_getDomainCookies', 'Found cookies:', validCookies, 'for domain:', domain);
              resolveInner(validCookies);
            });
          })
        )).then(cookieArrays => {
          // First, collect all cookies by name, keeping track of their domain specificity
          const cookiesByName = {};
          
          // Flatten and process all cookies
          cookieArrays.flat().forEach(cookie => {
            const name = cookie.name;
            const currentCookie = cookiesByName[name];
            
            // Calculate domain specificity score
            // Higher score = more specific domain
            let score = 0;
            const domain = cookie.domain.replace(/^\./, '');
            
            // Most specific match gets highest score
            if (domain === cleanCookieDomain) {
              score = 4;
            } 
            // Next most specific is dot-prefixed exact domain
            else if (cookie.domain === '.' + cleanCookieDomain) {
              score = 3;
            }
            // Parent domain exact match
            else if (cleanCookieDomain.endsWith('.' + domain)) {
              score = 2;
            }
            // Dot-prefixed parent domain
            else if (cookie.domain.startsWith('.') && cleanCookieDomain.endsWith(domain)) {
              score = 1;
            }

            // Log the cookie we're processing
            console.log('Processing cookie:', {
              name: cookie.name,
              domain: cookie.domain,
              score,
              secure: cookie.secure,
              httpOnly: cookie.httpOnly,
              sameSite: cookie.sameSite
            });

            // Only replace if we don't have this cookie yet or if this one is more specific
            if (!currentCookie || score > currentCookie.score) {
              cookiesByName[name] = {
                cookie,
                score
              };
            }
          });

          // Convert the collected cookies into a string
          const cookieString = Object.values(cookiesByName)
            .map(({ cookie }) => `${cookie.name}=${cookie.value}`)
            .join('; ');

          if (!cookieString) {
            console.log('_getDomainCookies', 'No valid cookies found');
            resolve('');
            return;
          }

          COOKIES[cookie_domain] = cookieString;
          console.log('_getDomainCookies', 'Final cookies:', Object.keys(cookiesByName));
          resolve(cookieString);
        });

      } catch (e) {
        console.error('_getDomainCookies error:', e);
        resolve('');
      }
    });
  });
};

DelugeConnection.prototype._getSession = function() {
  console.log('[_getSession] Checking if session is valid');
  
  return this._request('getsession', {
    method: 'auth.check_session',
    params: [],
    id: '-16990.' + Date.now()
  }).then(payload => {
    if (payload?.result) {
      console.log('[_getSession] Session is valid');
      return payload.result;
    }
    console.error('[_getSession] Session is invalid:', payload);
    throw new Error('Invalid session');
  });
};

DelugeConnection.prototype._doLogin = function(silent) {
  console.log('[_doLogin] Attempting to login with saved credentials');
  
  if (!this.SERVER_PASS) {
    console.error('[_doLogin] No password available');
    return Promise.reject(new Error('No password available'));
  }
  
  return this._request('dologin', {
    method: 'auth.login',
    params: [this.SERVER_PASS],
    id: '-17000.' + Date.now()
  }, silent).then(payload => {
    console.log('[_doLogin] Login response:', payload?.result ? 'Success' : 'Failed');
    
    if (payload.result) {
      // Check for any cookies or CSRF tokens in the response headers
      // (This would be handled in the _request method now)
      
      // Check that we can actually use the session
      return this._getSession().then(() => {
        console.log('[_doLogin] Successfully verified session after login');
        return payload.result;
      });
    }
    
    if (!silent) {
      notify({
        message: 'Login failed',
        contextMessage: 'Check your Deluge password in the extension options',
        isClickable: true,
        requireInteraction: true
      }, -1, 'needs-settings', 'error');
    }
    
    throw new Error('Login failed - check your Deluge password');
  });
};

DelugeConnection.prototype._checkDaemonConnection = function() {
  console.log('Checking daemon connection');
  
  return this._request('check-daemon', {
    method: 'web.connected',
    params: [],
    id: 1
  })
  .then(response => {
    if (response.result === true) {
      console.log('Daemon is connected');
      return true;
    }
    console.log('Daemon is not connected, will try to connect to one');
    return false;
  });
};

DelugeConnection.prototype._getDaemons = function() {
  return this._request('getdaemons', {
    method: 'web.get_hosts',
    params: [],
    id: '-16992'
  }).then(payload => {
    if (payload.result) {
      this.daemon_hosts = payload.result;
      console.log('_getDaemons__callback', payload);
      return payload.result;
    }
    this.daemon_hosts = [];
    console.error('_getDaemons failed', payload);
    notify({ message: 'Error: cannot connect to deluge server' }, 3000, this._getNotificationId(), 'error');
    return Promise.reject(new Error('Failed to get daemons'));
  });
};

DelugeConnection.prototype._getHostStatus = function(hostId, ip, port) {
  console.log('_getHostStatus', hostId);

  return this._request('gethoststatus', {
    method: 'web.get_host_status',
    params: [hostId],
    id: '-16992.' + hostId
  }).then(payload => {
    if (!payload.result) {
      console.error('_getHostStatus__callback', hostId, 'failed', payload);
      notify({ message: 'Error: cannot connect to deluge server' }, 3000, this._getNotificationId(), 'error');
      return Promise.reject(new Error('Failed to get host status'));
    }

    // ["c6099253ba83ea059adb7f6db27cd80228572721", "127.0.0.1", 52039, "Connected", "1.3.5"]
    // ["c6099253ba83ea059adb7f6db27cd80228572721", "Connected", "2.0.0"]
    const daemon_info = {};
    daemon_info.host_id = payload.result.shift();
    if (payload.result.length > 2) {
      daemon_info.ip = payload.result.shift();
      daemon_info.port = payload.result.shift();
  } else {
      daemon_info.ip = ip;
      daemon_info.port = port;
    }
    daemon_info.status = payload.result.shift();
    daemon_info.version = payload.result.shift();

    console.log('_getHostStatus__callback', daemon_info);
    return daemon_info;
  });
};

DelugeConnection.prototype._getConnectedDaemon = function(daemon_hosts) {
  if (this.DAEMON_INFO?.host_id) {
    return Promise.resolve(this.DAEMON_INFO);
  }

  if (!daemon_hosts?.length) {
    console.error('No daemons available:', daemon_hosts);
    return Promise.reject(new Error('No daemons available'));
  }

  // Process each daemon host sequentially until we find one that works
  return daemon_hosts.reduce((promise, daemon_host) => {
    return promise.catch(() => {
      return this._getHostStatus(daemon_host[0], daemon_host[1], daemon_host[2])
        .then(daemon_info => {
          switch (daemon_info.status) {
            case 'Connected':
              console.log('_getConnectedDaemon__callback', 'Connected', daemon_info);
              return daemon_info;
            
            case 'Online':
              console.log('_getConnectedDaemon__callback', 'Connecting');
              return this._connectDaemon(daemon_info);
            
            case 'Offline':
              console.log('_getConnectedDaemon__callback', 'Starting');
              return this._startDaemon(daemon_info)
                .then(info => this._connectDaemon(info));
            
            default:
              console.warn('_getConnectedDaemon__callback', 'UNKNOWN STATUS: ' + daemon_info.status);
              notify({
                message: `Error: failed to connect to deluge server: '${daemon_info.ip}:${daemon_info.port}'`
              }, 3000, this._getNotificationId(), 'error');
              return Promise.reject(new Error(`Unknown daemon status: ${daemon_info.status}`));
          }
        })
        .then(daemon_info => {
          this.DAEMON_INFO = daemon_info;
          this.CONNECT_ATTEMPTS = 1;
          return daemon_info;
        });
    });
  }, Promise.reject(new Error('Starting daemon connection attempts')));
};

DelugeConnection.prototype._startDaemon = function(daemon_info) {
  console.log('_startDaemon', daemon_info);

  return this._request('startdaemon', {
    method: 'web.start_daemon',
    params: [daemon_info.port],
    id: '-16993'
  }).then(payload => {
    console.log('_startDaemon__callback', payload);
    if (!payload.error) {
      notify({ message: `Starting server ${daemon_info.ip}:${daemon_info.port}` }, 1500, this._getNotificationId());
      return daemon_info;
    }
    console.error(this.state, 'ERROR', payload);
    return Promise.reject(new Error('Failed to start daemon'));
  });
};

DelugeConnection.prototype._connectDaemon = function(daemon_info) {
  console.log('_connectDaemon', daemon_info);

  if (daemon_info.status === 'Online') {
    return this._request('connectdaemon', {
      method: 'web.connect',
      params: [daemon_info.host_id],
      id: '-16994'
    }).then(payload => {
      console.log('_connectDaemon__callback', payload);
      if (!payload.error) {
        notify({ message: 'Reconnected to server' }, 1500, this._getNotificationId());
        return daemon_info;
      }
      console.error('_connectDaemon__callback', this.state, 'ERROR', payload);
      return Promise.reject(new Error('Failed to connect to daemon'));
    });
  }

  if (this.CONNECT_ATTEMPTS >= 5) {
    notify({
      contextMessage: `Gave up on ${daemon_info.ip}:${daemon_info.port} after ${this.CONNECT_ATTEMPTS} attempts`,
      message: "Only supported in Classic Mode",
      priority: 2,
      requireInteraction: true
    }, -1, this._getNotificationId(), 'error');
    return Promise.reject(new Error('Max connection attempts reached'));
  }

  this.CONNECT_ATTEMPTS += 1;

  notify({
    contextMessage: `Server ${daemon_info.ip}:${daemon_info.port} not ready`,
    message: 'Trying again in 5 seconds'
  }, 3500, this._getNotificationId());

  return new Promise((resolve, reject) => {
    setTimeout(() => {
      this._getHostStatus(daemon_info.host_id)
        .then(info => this._connectDaemon(info))
        .then(resolve)
        .catch(reject);
    }, 5000);
});
};

DelugeConnection.prototype._getServerConfig = function() {
  console.log('_getServerConfig');

  return this._request('getconfig', {
    method: 'core.get_config_values',
    params: [[
      'allow_remote',
      'download_location',
      'move_completed',
      'move_completed_path',
      'add_paused'
    ]],
    id: '-17001'
  }).then(payload => {
    console.log('_getServerConfig__callback', payload.result);
    this.server_config = { ...payload.result };

    if (!this.server_config.allow_remote) {
      console.error('_getServerConfig__error', 'Remote connections disabled');
      notify({
        message: 'Enable this in Preferences -> Daemon',
        contextMessage: 'Remote connections must be allowed',
        priority: 2,
        requireInteraction: true
      }, -1, this._getNotificationId(), 'error');
      return Promise.reject(new Error('Remote connections disabled'));
    }

    return [this.server_config];
  }).catch(error => {
    console.error('_getServerConfig__error', error);
    throw error;
  });
};

DelugeConnection.prototype._getPlugins = function() {
    console.log('Requesting plugins from server...');
    return this._request('getplugins', {
        method: 'web.get_plugins',
        params: [],
        id: '-17002'
    }).then(payload => {
        console.log('Raw plugin response:', payload);
        
        if (!payload.result) {
            console.error('_getPlugins failed - no result:', payload);
            return Promise.reject(new Error('Failed to get plugins'));
        }
        
        // Try different methods to get plugins based on server response
        let plugins;
        if (Array.isArray(payload.result)) {
            console.log('Plugin result is array:', payload.result);
            plugins = payload.result;
        } else if (typeof payload.result === 'object') {
            console.log('Plugin result is object:', payload.result);
            // Some Deluge versions return {plugin: enabled} format
            plugins = Object.entries(payload.result)
                .filter(([_, enabled]) => enabled)
                .map(([name]) => name);
        } else {
            console.warn('Unexpected plugin result format:', payload.result);
            plugins = [];
        }
        
        console.log('Processed plugin list:', plugins);
        
        // If Label plugin is enabled, get the labels
        let labelPromise = Promise.resolve({});
        if (plugins.includes('Label')) {
            console.log('Label plugin found, requesting labels...');
            labelPromise = this._request('getlabels', {
                method: 'label.get_labels',
                params: [],
                id: '-17003'
            }).then(labelPayload => {
                console.log('Label list response:', labelPayload);
                if (labelPayload.error) {
                    console.warn('Error getting labels, trying alternative method:', labelPayload.error);
                    throw new Error('Label plugin error');
                }
                
                // Return a properly structured object with the Label plugin information
                return {
                    Label: labelPayload.result || []
                };
            }).catch(error => {
                console.log('Trying alternative label method...');
                // Try alternative method for older Deluge versions
                return this._request('getlabels-alt', {
                    method: 'core.get_config_value',
                    params: ['label_prefs'],
                    id: '-17004'
                }).then(altPayload => {
                    console.log('Alternative label response:', altPayload);
                    if (altPayload.result && Array.isArray(altPayload.result.labels)) {
                        return {
                            Label: altPayload.result.labels
                        };
                    } else {
                        console.warn('No valid labels found in alternative response');
                        return { Label: [] };
                    }
                }).catch(err => {
                    console.error('All label retrieval methods failed:', err);
                    return { Label: [] };
                });
            });
        } else if (plugins.includes('label')) {
            // Try lowercase 'label' plugin (some Deluge versions use this)
            console.log('lowercase label plugin found, requesting labels...');
            labelPromise = this._request('getlabels-lowercase', {
                method: 'label.get_labels',
                params: [],
                id: '-17005'
            }).then(labelPayload => {
                console.log('lowercase label list response:', labelPayload);
                if (labelPayload.error) {
                    throw new Error('lowercase label plugin error');
                }
                return {
                    Label: labelPayload.result || []
                };
            }).catch(err => {
                console.error('lowercase label retrieval failed:', err);
                return { Label: [] };
            });
        }
        
        return labelPromise.then(pluginInfo => {
            console.log('Final plugin info structure:', pluginInfo);
            this.plugin_info = pluginInfo;
            return pluginInfo;
        });
    });
};

// Add a new method to get labels with fallbacks
DelugeConnection.prototype._getLabelsWithFallbacks = function() {
  console.log('Getting labels with fallbacks...');
  
  // Try the standard method first
  return this._request('getlabels-standard', {
    method: 'label.get_labels',
    params: [],
    id: '-17010'
  })
  .then(labelPayload => {
    console.log('Standard label response:', labelPayload);
    if (labelPayload && Array.isArray(labelPayload.result)) {
      return labelPayload.result;
    }
    if (labelPayload && labelPayload.error) {
      console.warn('Standard label method failed, trying fallback 1');
      throw new Error('Standard method failed: ' + labelPayload.error);
    }
    return [];
  })
  .catch(err => {
    // Fallback 1: Try with alternative method for older Deluge versions
    console.log('Trying label fallback method 1...');
    return this._request('getlabels-fallback1', {
      method: 'core.get_config_value',
      params: ['label_prefs'],
      id: '-17011'
    })
    .then(altPayload => {
      console.log('Fallback 1 label response:', altPayload);
      if (altPayload.result && Array.isArray(altPayload.result.labels)) {
        return altPayload.result.labels;
      }
      console.warn('Fallback 1 failed, trying fallback 2');
      throw new Error('Fallback 1 failed');
    });
  })
  .catch(err => {
    // Fallback 2: Try with the LabelPlus plugin
    console.log('Trying label fallback method 2 (LabelPlus)...');
    return this._request('getlabels-fallback2', {
      method: 'labelplus.get_labels',
      params: [],
      id: '-17012'
    })
    .then(labelPlusPayload => {
      console.log('Fallback 2 (LabelPlus) response:', labelPlusPayload);
      if (labelPlusPayload.result) {
        // LabelPlus returns an object with label IDs as keys
        return Object.values(labelPlusPayload.result)
          .filter(label => typeof label === 'object' && label.name)
          .map(label => label.name);
      }
      console.warn('All label fallbacks failed');
      return [];
    });
  })
  .catch(err => {
    console.error('All label retrieval methods failed:', err);
    return [];
  });
};

// Add the missing method for adding torrent URLs
DelugeConnection.prototype._addTorrentUrlToServer = function(url, options, cookie_domain) {
    console.log('[_addTorrentUrlToServer] Starting with:', url, options, cookie_domain);
    
    // Form the request parameters
    const cookieHeader = cookie_domain && COOKIES[cookie_domain] ? COOKIES[cookie_domain] : '';
    console.log('[_addTorrentUrlToServer] Cookie header:', cookie_domain, cookieHeader ? 'Cookie exists' : 'No cookie');
    
    // Build parameter object with correct structure for Deluge
    let params = {};
    
    // Add options if provided
    if (options) {
        // Common options that might be provided
        if (options.add_paused !== undefined) {
            params.add_paused = Boolean(options.add_paused);
        }
        
        if (options.download_location) {
            params.download_location = options.download_location;
        }
        
        if (options.move_completed) {
            params.move_completed = Boolean(options.move_completed);
        }
        
        if (options.move_completed_path) {
            params.move_completed_path = options.move_completed_path;
        }
        
        // Add any additional options that were passed
        Object.entries(options).forEach(([key, value]) => {
            if (!params.hasOwnProperty(key)) {
                params[key] = value;
            }
        });
    }

    // Ensure URL is properly encoded if it's not a magnet link
    const encodedUrl = url.startsWith('magnet:') ? url : encodeURI(url);
    
    // For magnet links, use URL method directly
    if (url.startsWith('magnet:')) {
        return this._addTorrentViaUrl(encodedUrl, params);
    }

    // For non-magnet URLs, check if we should send cookies
    return new Promise((resolve, reject) => {
        chrome.storage.local.get('send_cookies', data => {
            // If send_cookies is enabled (default true) and we have cookies, add them to params
            if (data.send_cookies !== false && cookieHeader) {
                params.cookie = cookieHeader;
            }
            
            // Try direct URL method first
            console.log('[_addTorrentUrlToServer] Trying direct URL method with params:', {
                url: encodedUrl,
                hasCookies: !!params.cookie
            });
            
            this._addTorrentViaUrl(encodedUrl, params)
                .then(resolve)
                .catch(error => {
                    console.warn('[_addTorrentUrlToServer] Direct URL method failed:', error);
                    
                    // If we got a 403 and have cookies, try downloading the torrent directly
                    if (error.code === 403 && cookieHeader) {
                        console.log('[_addTorrentUrlToServer] Got 403 with cookies, attempting direct download');
                        this._downloadTorrent(encodedUrl, cookie_domain)
                            .then(torrentData => {
                                return this._request('addtorrent-file', {
                                    method: 'core.add_torrent_file',
                                    params: ['temp.torrent', torrentData, params],
                                    id: '-17004.' + Date.now()
                                });
                            })
                            .then(payload => {
                                if (payload.error) {
                                    throw new Error(payload.error.message || 'Failed to add torrent file');
                                }
                                resolve(payload.result);
                            })
                            .catch(downloadError => {
                                console.error('[_addTorrentUrlToServer] Both methods failed:', downloadError);
                                // Combine error messages to be more informative
                                reject(new Error('Unable to add torrent: Direct access failed (403) and download attempt failed. The site may require authentication or cookies.'));
                            });
                    } else {
                        reject(error);
                    }
                });
        });
    });
};

DelugeConnection.prototype._addTorrentViaUrl = function(url, params) {
    return this._request('addtorrent', {
        method: 'core.add_torrent_url',
        params: [url, params],
        id: '-17003.' + Date.now()
    })
    .then(payload => {
        console.log('[_addTorrentViaUrl] Add torrent response:', payload);
        
        if (!payload) {
            throw new Error('Empty response from server');
        }
        
        if (payload.error) {
            // Special handling for Deluge 1.x API difference
            if (payload.error.message && 
                (payload.error.message.includes('takes exactly 3 arguments') || 
                 payload.error.message.includes('takes exactly three arguments'))) {
                
                console.log('[_addTorrentViaUrl] Detected Deluge 1.x API, retrying with adjusted parameters');
                
                // Deluge 1.x has a different API signature
                return this._request('addtorrent-v1', {
                    method: 'core.add_torrent_url',
                    params: [url, params, {}],
                    id: '-17003.v1.' + Date.now()
                });
            }
            
            // If we get a 403, it's likely the URL is inaccessible to Deluge
            if (payload.error.message && payload.error.message.includes('403 Forbidden')) {
                const error = new Error('Unable to access torrent - the site may require authentication or cookies');
                error.code = 403;
                throw error;
            }
            
            throw new Error(payload.error.message || 'Failed to add torrent');
        }
        
        if (payload.result === false) {
            throw new Error('Server refused torrent');
        }
        
        // Success - return the torrent ID
        return payload.result;
    });
};

// Implement the method to handle plugin options like labels
DelugeConnection.prototype._processPluginOptions = function(url, plugins, torrentId) {
    if (!plugins || !torrentId) {
        return Promise.resolve();
    }
    
    const promises = [];
    
    // Handle Label plugin
    if (plugins.Label) {
        console.log('[_processPluginOptions] Setting label:', plugins.Label);
        promises.push(
            this._request('set-torrent-label', {
                method: 'label.set_torrent',
                params: [torrentId, plugins.Label],
                id: '-17004.' + Date.now()
            })
            .catch(error => {
                console.error('[_processPluginOptions] Error setting label:', error);
                // Don't fail the whole operation if label setting fails
                return Promise.resolve();
            })
        );
    }
    
    // Handle other plugin options here if needed
    
    return Promise.all(promises);
};



/* notification handling */
function notify(opts, decay, id, icon_type) {
  // Convert Chrome notification parameters to toast parameters
  const message = opts.message || '';
  const contextMessage = opts.contextMessage || '';
  const fullMessage = contextMessage ? `${message}\n${contextMessage}` : message;
  const type = icon_type || 'info';
  const duration = decay || 3000;

  // Send message to content script to show toast
  communicator.sendMessage({
    method: 'show-toast',
    message: fullMessage,
    type: type,
    duration: duration
  });
}

/* BEGIN Setup */
const notificationTimeouts = {};
const delugeConnection = new DelugeConnection();

function createContextMenu(add, with_options) {
  chrome.contextMenus.removeAll(() => {
    if (with_options) {
      chrome.contextMenus.create({
        id: 'add-with-options',
        title: 'Add with Options',
        contexts: ['link'],
        targetUrlPatterns: [
          'magnet:*',
          '*://*/*.torrent*',
          '*://*/*/torrent*',
          '*://*/*/download*',
          '*://*/*/get*'
        ]
      });
    }

    if (add) {
      chrome.contextMenus.create({
        id: 'add',
        title: with_options ? 'Add' : 'Add to Deluge',
        contexts: ['link'],
        targetUrlPatterns: [
          'magnet:*',
          '*://*/*.torrent*',
          '*://*/*/torrent*',
          '*://*/*/download*',
          '*://*/*/get*'
        ]
      });
    }
  });
}

// Handle context menu clicks
chrome.contextMenus.onClicked.addListener((info, tab) => {
  const torrentUrl = info.linkUrl;
  const s1 = torrentUrl.indexOf('//') + 2;
  let domain = torrentUrl.substring(s1);
  const s2 = domain.indexOf('/');
  if (s2 >= 0) {
    domain = domain.substring(0, s2);
  }

  if (info.menuItemId === 'add-with-options') {
    // Send message to content script in the active tab
    chrome.tabs.sendMessage(tab.id, {
      method: 'add_dialog',
      url: torrentUrl,
      domain: domain
    });
  } else if (info.menuItemId === 'add') {
    delugeConnection.addTorrent(torrentUrl, domain);
  }
});

// Initialize context menu based on settings
chrome.storage.local.get(['enable_context_menu', 'enable_context_menu_with_options'], data => {
  if (data.enable_context_menu) {
    createContextMenu(true, data.enable_context_menu_with_options);
  }
});

// Message handling
communicator
  .observeMessage((request, sendResponse) => {
    console.log('Message received by background script:', request);
    
    if (!request || !request.method) {
      console.error('Invalid message received', request);
      sendResponse({ error: 'Invalid message format' });
      return;
    }
    
    const [prefix, ...parts] = request.method.split('-');
    const method = parts.join('-');

    console.log('Processing message:', prefix, method, request);

    if (request.method === "settings-changed") {
      console.log('~~~ MESSAGE ~~~ Settings Changed');
      delugeConnection._initState().then(() => {
        chrome.storage.local.get(['enable_context_menu', 'enable_context_menu_with_options'], data => {
          if (data.enable_context_menu) {
            createContextMenu(true, data.enable_context_menu_with_options);
          }
        });
      });
    } else if (request.method === "notify") {
      console.log('~~~ MESSAGE ~~~ Send Notification');
      notify(request.opts, request.decay, 'content', request.type);
    } else if (prefix === "storage") {
      const [action, ...keyParts] = parts;
      const key = keyParts.join('-');

      if (action === 'set') {
        chrome.storage.local.set({ [key]: request.value });
      } else {
        chrome.storage.local.get(key, data => {
          try {
            sendResponse({ value: JSON.parse(data[key]) });
          } catch (e) {
            sendResponse({ value: data[key] });
          }
        });
      }
    } else if (prefix === "addlink") {
      const addtype = parts[0];
      const { url, domain, plugins, options } = request;

      console.log('==== ADDLINK REQUEST ====', addtype, url, domain);

      if (!url) {
        console.error('Empty URL in addlink request');
        notify({ message: 'Error: Empty URL' }, 3000, delugeConnection._getNotificationId(), 'error');
        sendResponse({ error: 'Empty URL' });
        return;
      }

      const url_match = url.match(/^(magnet:)|((file|(ht|f)tp(s?)):\/\/).+/);
      if (!url_match) {
        console.error('Invalid URL format:', url);
        notify({ message: `Error: Invalid URL '${url}'` }, 3000, delugeConnection._getNotificationId(), 'error');
        sendResponse({ error: 'Invalid URL format' });
        return;
      }

      if (addtype === 'todeluge') {
        console.log('<<<< PROCESSING ADDLINK-TODELUGE >>>>', url, domain, plugins, options);
        try {
          delugeConnection.addTorrent(url, domain, plugins, options)
            .then((result) => {
              console.log('Torrent add successful, sending response:', result);
              sendResponse({ success: true, result });
            })
            .catch((error) => {
              console.error('Error adding torrent:', error);
              sendResponse({ error: error.message || 'Unknown error adding torrent' });
            });
            
          // Return true to indicate we'll send the response asynchronously
          return true;
        } catch (e) {
          console.error('Exception in addTorrent:', e);
          sendResponse({ error: e.message || 'Exception in addTorrent' });
        }
      } else if (addtype === 'todeluge:withoptions') {
        console.log('Processing addlink-todeluge:withoptions request');
        // First get plugin info and server config
        delugeConnection._connect(true)
          .then(() => {
            console.log('Connected to server, getting plugin info and config');
            return Promise.all([
              delugeConnection._getPlugins(),
              delugeConnection._getServerConfig()
            ]);
          })
          .then(([plugins, [config]]) => {
            console.log('Got plugin info and config:', { plugins, config });
            sendResponse({
              method: 'add_dialog',
              url,
              domain,
              config: config || {},
              plugins: plugins || {}
            });
          })
          .catch(error => {
            console.error('Error getting plugin info or config:', error);
            // Send response with empty data so modal can still show
            sendResponse({
              method: 'add_dialog',
              url,
              domain,
              config: {},
              plugins: {}
            });
          });
      } else {
        notify({ message: `Unknown server type: '${addtype}'` }, 3000, delugeConnection._getNotificationId(), 'error');
      }
    } else if (request.method === 'connect') {
      delugeConnection.connectToServer();
    } else if (prefix === "plugins") {
      const actiontype = parts[0];

      switch(actiontype) {
        case 'getinfo':
          console.log('Handling plugins-getinfo request');
          // First connect and get both plugin info and server config
          delugeConnection._connect(true)
            .then(() => {
              console.log('Connected to server, getting data...');
              return Promise.all([
                delugeConnection._request('getplugins', {
                  method: 'web.get_plugins',
                  params: [],
                  id: '-17002'
                }),
                delugeConnection._request('getconfig', {
                  method: 'core.get_config_values',
                  params: [[
                    'allow_remote',
                    'download_location',
                    'move_completed',
                    'move_completed_path',
                    'add_paused',
                    'compact_allocation',
                    'max_connections_per_torrent',
                    'max_upload_slots_per_torrent',
                    'max_upload_speed_per_torrent',
                    'max_download_speed_per_torrent',
                    'prioritize_first_last_pieces',
                    'remove_seed_at_ratio',
                    'stop_seed_at_ratio',
                    'stop_seed_ratio'
                  ]],
                  id: '-17001'
                }),
                // Always try to get labels regardless of plugin list
                delugeConnection._getLabelsWithFallbacks(),
                // Try to get AutoAdd plugin paths if available
                delugeConnection._request('get-autoadd-paths', {
                  method: 'autoadd.get_watchdirs',
                  params: [],
                  id: '-17020'
                }).catch(err => {
                  console.log('AutoAdd plugin not available:', err);
                  return { result: {} };
                })
              ]);
            })
            .then(([pluginsPayload, configPayload, labels, autoaddPayload]) => {
              console.log('Raw plugin response:', pluginsPayload);
              console.log('Raw config response:', configPayload);
              console.log('Labels retrieved:', labels);
              console.log('AutoAdd paths:', autoaddPayload);
              
              // Process the plugins list
              let enabledPlugins = [];
              if (Array.isArray(pluginsPayload.result)) {
                enabledPlugins = pluginsPayload.result;
              } else if (typeof pluginsPayload.result === 'object') {
                enabledPlugins = Object.entries(pluginsPayload.result)
                  .filter(([_, enabled]) => enabled)
                  .map(([name]) => name);
              }
              console.log('Enabled plugins:', enabledPlugins);
              
              // Process AutoAdd plugin data
              let watchDirs = [];
              if (autoaddPayload && autoaddPayload.result && typeof autoaddPayload.result === 'object') {
                watchDirs = Object.keys(autoaddPayload.result).map(path => ({
                  path,
                  enabled: autoaddPayload.result[path].enabled
                })).filter(dir => dir.enabled).map(dir => dir.path);
              }
              
              // Create final response structure
              const response = {
                value: {
                  plugins: {
                    Label: labels || [],
                    AutoAdd: watchDirs,
                    EnabledPlugins: enabledPlugins
                  },
                  config: configPayload?.result || {}
                }
              };
              
              console.log('Sending final response structure:', response);
              sendResponse(response);
            })
            .catch(error => {
              console.error('Failed to get data:', error);
              sendResponse({
                error: error.message,
                value: {
                  plugins: { Label: [], AutoAdd: [], EnabledPlugins: [] },
                  config: {}
                }
              });
            });
          break;
        default:
          console.error('Unknown plugin action:', actiontype);
          sendResponse({ error: `unknown plugin action: '${actiontype}'` });
      }
    } else if (request.method === "storage-get-default_label") {
      // Get default label from storage
      chrome.storage.local.get(['default_label'], function(result) {
        sendResponse({ value: result.default_label || '' });
      });
      
      return true;
    } else if (request.method === "torrent-list") {
      // Get list of active torrents for the popup
      delugeConnection._connect(true)
        .then(() => {
          console.log('Connected, getting torrent list');
          return delugeConnection._request('get-torrents', {
            method: 'web.update_ui',
            params: [
              ['name', 'progress', 'state', 'download_payload_rate', 'upload_payload_rate', 'eta'],
              {}
            ],
            id: '-17100'
          });
        })
        .then(response => {
          console.log('Torrent list response:', response);
          if (response && response.result && response.result.torrents) {
            // Format the torrent data for the popup
            const torrents = Object.entries(response.result.torrents).map(([id, data]) => ({
              id,
              name: data.name || 'Unknown',
              progress: data.progress / 100 || 0,
              state: data.state || 'Unknown',
              download_speed: data.download_payload_rate || 0,
              upload_speed: data.upload_payload_rate || 0,
              eta: data.eta || -1
            }));
            
            sendResponse({ value: torrents });
          } else {
            sendResponse({ value: [] });
          }
        })
        .catch(error => {
          console.error('Error getting torrent list:', error);
          sendResponse({ error: error.message, value: [] });
        });
      
      return true;
    } else if (prefix === "add") {
      const addtype = parts[0];
      const { url, domain, plugins, options } = request;

      if (!url) {
        notify({ message: 'Error: Empty URL' }, 3000, delugeConnection._getNotificationId(), 'error');
        return;
      }

      const url_match = url.match(/^(magnet:)|((file|(ht|f)tp(s?)):\/\/).+/);
      if (!url_match) {
        notify({ message: `Error: Invalid URL '${url}'` }, 3000, delugeConnection._getNotificationId(), 'error');
        return;
      }

      if (addtype === 'todeluge') {
        console.log('<<<< ADDLINK >>>>', url, domain, plugins, options);
        delugeConnection.addTorrent(url, domain, plugins, options);
      } else if (addtype === 'todeluge:withoptions') {
        console.log('Processing addlink-todeluge:withoptions request');
        // First get plugin info and server config
        delugeConnection._connect(true)
          .then(() => {
            console.log('Connected to server, getting plugin info and config');
            return Promise.all([
              delugeConnection._getPlugins(),
              delugeConnection._getServerConfig()
            ]);
          })
          .then(([plugins, [config]]) => {
            console.log('Got plugin info and config:', { plugins, config });
            sendResponse({
              method: 'add_dialog',
              url,
              domain,
              config: config || {},
              plugins: plugins || {}
            });
          })
          .catch(error => {
            console.error('Error getting plugin info or config:', error);
            // Send response with empty data so modal can still show
            sendResponse({
              method: 'add_dialog',
              url,
              domain,
              config: {},
              plugins: {}
            });
          });
      } else {
        notify({ message: `Unknown server type: '${addtype}'` }, 3000, delugeConnection._getNotificationId(), 'error');
      }
    } else {
      console.error('Unknown method:', request.method);
      sendResponse({ error: `unknown method: '${request.method}'` });
    }
    
    // Return true to indicate we'll send a response asynchronously
    return true;
  })
  .init();

// Handle notification clicks
chrome.notifications.onClicked.addListener(notId => {
  if (notId === 'needs-settings') {
    chrome.tabs.create({ url: chrome.runtime.getURL('options.html') });
    chrome.notifications.clear(notId);
  }
});

// Handle extension installation/updates
chrome.runtime.onInstalled.addListener(install => {
  const manifest = chrome.runtime.getManifest();
  console.log('[INSTALLED: ' + manifest.version + ']', install);
});

/* Daemon methods */

