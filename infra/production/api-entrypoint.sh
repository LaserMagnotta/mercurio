#!/bin/sh
# Fixes ownership of the bind-mounted photo volumes before dropping to the
# unprivileged `node` user, then execs the real command as `node`.
#
# Why this exists: the image creates PHOTO_STORAGE_DIR and
# VENUE_PHOTO_STORAGE_DIR owned by node (api.Dockerfile), which is supposed to
# make Docker seed a freshly created named volume with that same ownership on
# first mount. Observed on a containerd-snapshotter Docker Engine (`docker
# info` -> "driver-type: io.containerd.snapshotter.v1"): only the FIRST volume
# mounted under /var/lib/mercurio is actually seeded from the image: the
# second one comes up as an empty, root-owned directory, and the unprivileged
# `node` process cannot write a single blob into it. Root cause is in Docker's
# volume-seeding, not in this image; the fix is a defensive, idempotent chown
# instead of trusting that seeding happened.
#
# Cheap on every normal restart: a `stat` per directory, no recursive walk
# (only the mount point itself needs to be node-owned for `node` to create new
# files inside it).
set -eu

for dir in "$PHOTO_STORAGE_DIR" "$VENUE_PHOTO_STORAGE_DIR"; do
  [ -d "$dir" ] || continue
  owner_uid="$(stat -c '%u' "$dir")"
  [ "$owner_uid" = "$(id -u node)" ] || chown node:node "$dir"
done

exec su-exec node "$@"
