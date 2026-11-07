'use strict';

// drive.js now delegates to rclone.js
// The old net-use/WebDAV-client approach is replaced by rclone + WinFsp.
module.exports = require('./rclone');
