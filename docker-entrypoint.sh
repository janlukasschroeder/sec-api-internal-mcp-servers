#!/bin/bash
set -e

# the cloak browser must run headed, thus it needs an x server. the browser
# factory spreads the browsers over one display per proxy, from :99 upwards, so
# that one xvfb cannot hit its client limit.
DISPLAY_COUNT="${DISPLAY_COUNT:-10}"
FIRST_DISPLAY=99

# a restart keeps the filesystem of the container, and a stale lock stops xvfb
# with "server is already active".
rm -f /tmp/.X*-lock
rm -rf /tmp/.X11-unix
mkdir -p /tmp/.X11-unix
chmod 1777 /tmp/.X11-unix

for i in $(seq 0 $((DISPLAY_COUNT - 1))); do
  display=$((FIRST_DISPLAY + i))
  # chrome opens 5 to 10 x connections per process, thus raise the client cap
  Xvfb ":${display}" -screen 0 1920x1080x24 -maxclients 2048 -nolisten tcp -ac \
    >/dev/null 2>&1 &
done

# the server starts a browser at once, thus wait for the first display. the
# socket is the check, because the image has no xdpyinfo.
for i in $(seq 1 100); do
  if [ -S "/tmp/.X11-unix/X${FIRST_DISPLAY}" ]; then
    break
  fi
  sleep 0.1
done

if [ ! -S "/tmp/.X11-unix/X${FIRST_DISPLAY}" ]; then
  echo "entrypoint: display :${FIRST_DISPLAY} did not come up" >&2
  exit 1
fi

echo "entrypoint: $(ls /tmp/.X11-unix | wc -l) displays ready" >&2

exec "$@"
