FROM clamav/clamav:stable@sha256:0e31ce089574268aefa0b543767d66b70240ab51ed49eec53e07f18d5629d817
# Private network only. ClamD has no network authentication.
RUN printf '\nStreamMaxLength 50M\nMaxFileSize 50M\nMaxScanSize 150M\nAlertExceedsMax yes\nAlertEncrypted yes\n' >> /etc/clamav/clamd.conf
EXPOSE 3310
