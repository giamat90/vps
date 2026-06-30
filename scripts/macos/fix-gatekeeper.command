#!/bin/bash
# Vocal Practice Studio isn't notarized yet, so macOS Gatekeeper blocks it
# after download. This removes the quarantine flag so it can open normally.
set -u

APP_NAME="Vocal Practice Studio.app"
CANDIDATES=(
  "/Applications/$APP_NAME"
  "$HOME/Downloads/$APP_NAME"
  "$HOME/Desktop/$APP_NAME"
)
for vol in /Volumes/*/; do
  CANDIDATES+=("${vol}${APP_NAME}")
done

FOUND=""
for path in "${CANDIDATES[@]}"; do
  if [ -d "$path" ]; then
    FOUND="$path"
    break
  fi
done

echo "Vocal Practice Studio — Gatekeeper fix"
echo "======================================="
echo

if [ -z "$FOUND" ]; then
  echo "Couldn't find \"$APP_NAME\" in Applications, Downloads, Desktop, or a mounted disk image."
  echo "Drag the app onto this window now, then press Return:"
  read -r DRAGGED
  DRAGGED="${DRAGGED%\'}"
  DRAGGED="${DRAGGED#\'}"
  if [ -d "$DRAGGED" ]; then
    FOUND="$DRAGGED"
  else
    echo "Still couldn't find it. Move the app to Applications and re-run this script."
    read -r -p "Press Return to close..." _
    exit 1
  fi
fi

echo "Found: $FOUND"
xattr -cr "$FOUND"
echo
echo "Done. Quarantine flag removed — Vocal Practice Studio should now open normally."
read -r -p "Press Return to close..." _
