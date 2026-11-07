# Private document scanner

Deploy this directory as the service root, or build `scanner/Dockerfile` from the repository root. The base ClamAV image is pinned by digest. Its entrypoint maintains signatures and starts ClamD. Allocate sufficient memory for the signature database and verify readiness before enabling public uploads.

Set the application's `CLAMAV_HOST` to the private service hostname and `CLAMAV_PORT=3310`. No public domain or TCP proxy. [ClamD TCP is unauthenticated](https://docs.clamav.net/manual/Usage/Scanning.html); it belongs exclusively on the private application network.

The adapter uses INSTREAM and only accepts an explicit clean result. It blocks malware, scan-limit/encrypted-file alerts, missing responses and timeouts before writing the object. Validation is capped at 50 MB; individual application routes may have lower limits. Test with a harmless clean fixture and the standard EICAR antivirus test, never customer data.
