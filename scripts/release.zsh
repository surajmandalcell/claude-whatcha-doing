#!/bin/zsh
# Ship a new version: bump the patch number in plugin.json, commit, push.
# Installed copies with auto-update pick it up at their next start.
set -e
cd "${0:A:h}/.."
claude plugin validate . >/dev/null
claude plugin test . >/dev/null
v=$(node -e '
  const f = ".claude-plugin/plugin.json", p = JSON.parse(require("fs").readFileSync(f))
  const [a, b, c] = p.version.split(".").map(Number)
  p.version = [a, b, c + 1].join(".")
  require("fs").writeFileSync(f, JSON.stringify(p, null, 2) + "\n")
  console.log(p.version)')
git add -A
git commit -q -m "Release $v"
git push -q
echo "Released $v"
