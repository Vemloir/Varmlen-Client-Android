#!/usr/bin/env bash
# Render the square (1x1) flags of flag-icons -- the set the app shows -- into
# drawables for the home-screen widget, which cannot draw SVG. One WebP per
# two-letter code, named widget_flag_<code>, plus widget_flag_none: a plain
# white flag for a location without a country.
#
# Needs rsvg-convert and ImageMagick. Run from the project root after
# `npm install`; commit the result.
set -euo pipefail

SRC=node_modules/flag-icons/flags/1x1
OUT=src-tauri/gen/android/app/src/main/res/drawable-nodpi
SIZE=192

mkdir -p "$OUT"
rm -f "$OUT"/widget_flag_*.webp
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

for svg in "$SRC"/??.svg; do
  code=$(basename "$svg" .svg)
  rsvg-convert -w "$SIZE" -h "$SIZE" "$svg" -o "$TMP/$code.png"
  magick "$TMP/$code.png" -quality 90 -define webp:method=6 "$OUT/widget_flag_$code.webp"
done
magick -size "${SIZE}x${SIZE}" xc:white -quality 90 "$OUT/widget_flag_none.webp"

echo "$(ls "$OUT"/widget_flag_*.webp | wc -l) widget flags in $OUT ($(du -sh "$OUT" | cut -f1))"
