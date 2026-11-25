#!/bin/zsh
# Make the README images from the raw window captures in docs/src/.
#   docs/src/threads.png  -> docs/cover.png  (window on the wallpaper, rounded corners)
#   docs/src/<name>.png   -> docs/<name>.png (window and shadow on transparent)
# A capture is one terminal window: on a light background, or with alpha
# (`screencapture -o -l <window id> docs/src/<name>.png`). Run: zsh scripts/readme-images.zsh
set -e
cd "${0:A:h}/.."
wall=${WALLPAPER:-$HOME/Pictures/local_wallpapers_gradients/Fractal Maze - 20.jpg}
radius=10   # macOS window corner, in capture pixels
tmp=$(mktemp -d)
trap 'rm -rf -- "$tmp"' EXIT

# Cut the window out of a capture: the box of the dark pixels, with round corners.
window() {
  # A capture with alpha (screencapture -o) already has the window's own round corners: keep them,
  # since flattening on white leaves a white fringe outside the real corner.
  if [[ $(magick "$1" -format '%[opaque]' info:) == False ]]; then
    magick "$1" -trim +repage "$2"; return
  fi
  # The white border keeps -trim from eating dark rows that touch the edge, like a title bar.
  magick "$1" -background white -flatten -bordercolor white -border 1 "$tmp/base.png"
  local box=$(magick "$tmp/base.png" -colorspace gray -threshold 50% -format %@ info:)
  magick "$tmp/base.png" -crop "$box" +repage -write "$tmp/win.png" null:
  local w=$(magick identify -format %w "$tmp/win.png") h=$(magick identify -format %h "$tmp/win.png")
  magick "$tmp/win.png" -alpha set \
    \( -size ${w}x${h} xc:black -fill white -draw "roundrectangle 0,0 $((w-1)),$((h-1)) $radius,$radius" -alpha off \) \
    -compose CopyOpacity -composite "$2"
}

# Soft drop shadow under the window, on transparent.
shadow() {
  magick "$1" \( +clone -background black -shadow "$2" \) +swap -background none -layers merge +repage "$3"
}

for src in docs/src/*.png; do
  name=${src:t:r}
  window "$src" "$tmp/w.png"
  if [[ $name == threads ]]; then
    # Cover: the window fills about 90% of the width, wallpaper around it, 28 px corners.
    shadow "$tmp/w.png" 60x22+0+14 "$tmp/ws.png"
    w=$(magick identify -format %w "$tmp/w.png") h=$(magick identify -format %h "$tmp/w.png")
    cw=$((w * 110 / 100)) ch=$((h + w * 10 / 100))
    magick "$wall" -resize "${cw}x${ch}^" -gravity center -extent "${cw}x${ch}" \
      "$tmp/ws.png" -gravity center -geometry +0+6 -composite \
      -geometry +0+0 -alpha set \( -size ${cw}x${ch} xc:black -fill white -draw "roundrectangle 0,0 $((cw-1)),$((ch-1)) 28,28" -alpha off \) \
      -compose CopyOpacity -composite -strip docs/cover.png
    echo docs/cover.png
  else
    shadow "$tmp/w.png" 45x16+0+10 "$tmp/ws.png"
    magick "$tmp/ws.png" -strip "docs/$name.png"
    echo "docs/$name.png"
  fi
done
