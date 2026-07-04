#!/bin/bash
# Vocal Practice Studio isn't notarized yet, so macOS Gatekeeper blocks it
# after download. This removes the quarantine flag so it can open normally.
#
# NOTE: This .command file will itself carry a quarantine flag when
# downloaded, so the first launch may require right-click -> Open instead
# of a double-click. That's expected macOS behavior, not a bug here.
set -u

APP_NAME="Vocal Practice Studio.app"
CANDIDATE_PATHS=(
  "/Applications/$APP_NAME"
  "$HOME/Downloads/$APP_NAME"
  "$HOME/Desktop/$APP_NAME"
)
CANDIDATE_LABELS=(
  "in Applications"
  "in your Downloads folder"
  "on your Desktop"
)
for vol in /Volumes/*/; do
  VOL_NAME="$(basename "$vol")"
  CANDIDATE_PATHS+=("${vol}${APP_NAME}")
  CANDIDATE_LABELS+=("on the disk \"$VOL_NAME\"")
done

FOUND_PATHS=()
FOUND_LABELS=()
for i in "${!CANDIDATE_PATHS[@]}"; do
  if [ -d "${CANDIDATE_PATHS[$i]}" ]; then
    FOUND_PATHS+=("${CANDIDATE_PATHS[$i]}")
    FOUND_LABELS+=("${CANDIDATE_LABELS[$i]}")
  fi
done

echo "Vocal Practice Studio — Gatekeeper fix"
echo "======================================="
echo

if [ ${#FOUND_PATHS[@]} -eq 0 ]; then
  echo "Couldn't find \"$APP_NAME\" in Applications, Downloads, Desktop, or a mounted disk image."
  echo
  echo "Let's find it together:"
  echo "1. Open Finder."
  echo "2. Look in Downloads, Desktop, or wherever you saved \"Vocal Practice Studio.app\"."
  echo "3. Click and hold the app's icon with your mouse."
  echo "4. While still holding the button, move your mouse over this window."
  echo "5. Let go of the mouse button."
  echo "6. Some text will appear above — that's expected, not an error."
  echo "7. Press Return (Enter) to continue."
  echo
  read -r DRAGGED
  # Strip a surrounding pair of quotes, if present (some terminals quote the path).
  DRAGGED="${DRAGGED%\"}"
  DRAGGED="${DRAGGED#\"}"
  DRAGGED="${DRAGGED%\'}"
  DRAGGED="${DRAGGED#\'}"
  # ...then unescape backslash-escaped characters. Terminal.app's drag-and-drop
  # inserts paths like /Users/tester/Desktop/Vocal\ Practice\ Studio.app —
  # backslash-escaped, not quoted — so a backslash followed by any character
  # means "take that character literally."
  DRAGGED="${DRAGGED//\\/}"
  if [ -d "$DRAGGED" ]; then
    DRAGGED_NAME="$(basename "$DRAGGED")"
    if [ "$DRAGGED_NAME" != "$APP_NAME" ]; then
      echo "Hmm, that doesn't look like \"$APP_NAME\"."
      echo "What you dragged was: \"$DRAGGED_NAME\""
      echo "Please try again with \"$APP_NAME\" and re-run this script."
      read -r -p "Press Return to close..." _
      exit 1
    fi
    FOUND_PATHS=("$DRAGGED")
    FOUND_LABELS=("where you dragged it from")
  else
    echo "Still couldn't find it. Move the app to Applications and re-run this script."
    read -r -p "Press Return to close..." _
    exit 1
  fi
fi

TOTAL=${#FOUND_PATHS[@]}
if [ "$TOTAL" -eq 1 ]; then
  echo "Found 1 copy: one ${FOUND_LABELS[0]}."
else
  SUMMARY=""
  for i in "${!FOUND_LABELS[@]}"; do
    if [ -z "$SUMMARY" ]; then
      SUMMARY="one ${FOUND_LABELS[$i]}"
    else
      SUMMARY="$SUMMARY, one ${FOUND_LABELS[$i]}"
    fi
  done
  echo "Found $TOTAL copies: $SUMMARY."
fi
echo

FIXED=0
for i in "${!FOUND_PATHS[@]}"; do
  PATH_I="${FOUND_PATHS[$i]}"
  echo "Fixing: $PATH_I"
  if xattr -cr "$PATH_I"; then
    echo "  Done — quarantine flag removed."
    FIXED=$((FIXED + 1))
  else
    XATTR_STATUS=$?
    echo "  Couldn't remove the quarantine flag (xattr exited with status $XATTR_STATUS)."
    echo "  Try running this command yourself in Terminal:"
    echo "    xattr -cr \"$PATH_I\""
  fi
  echo
done

if [ "$FIXED" -eq "$TOTAL" ]; then
  echo "Fixed $FIXED of $TOTAL copies. Vocal Practice Studio should now open normally."
  read -r -p "Press Return to close..." _
else
  echo "Fixed $FIXED of $TOTAL copies — see above for the one(s) that failed."
  read -r -p "Press Return to close..." _
  exit 1
fi
