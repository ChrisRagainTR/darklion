(function () {
  'use strict';
  // Polling remains available when realtime is disabled or its config fails.
  function disabledClient() {
    const channels = new Map();
    return {
      connection: { state: 'disconnected', bind() {}, unbind() {} },
      subscribe(name) {
        if (!channels.has(name)) channels.set(name, { subscribed: false, bind() {}, unbind() {}, trigger() { return false; } });
        return channels.get(name);
      },
      channel: name => channels.get(name),
      unsubscribe: name => channels.delete(name),
      disconnect() {},
    };
  }
  window.DLRealtime = {
    create(options) {
      if (window.DLAuth?.support) return disabledClient();
      const config = window.DL_REALTIME_CONFIG;
      if (!config?.enabled || !config.key || !config.cluster || typeof window.Pusher !== 'function') return disabledClient();
      return new window.Pusher(config.key, { ...options, cluster: config.cluster });
    },
  };
}());
