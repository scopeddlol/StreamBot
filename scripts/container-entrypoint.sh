#!/bin/sh
set -eu
# Initialize only the application's directories; never recursively chown media libraries.
if [ "$(id -u)" = 0 ]; then
  mkdir -p /data/database /data/security /data/videos /data/preview-cache /data/cache
  chown root:root /data/database /data/security
  chmod 700 /data/database /data/security
  chown node:node /data /data/database /data/security /data/videos /data/preview-cache /data/cache
  find /data/database /data/security -xdev -type f -exec chown node:node {} +
  exec gosu node:node "$@"
fi
exec "$@"
