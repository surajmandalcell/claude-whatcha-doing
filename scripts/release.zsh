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
# Commit only the version: work in progress stays out of the release.
git commit -q -m "Release $v" .claude-plugin/plugin.json
git push -q
# This Mac's own copy updates now, not only when the marketplace auto-update runs.
claude plugin marketplace update claude-whatcha-doing >/dev/null
claude plugin update whatcha-doing@claude-whatcha-doing >/dev/null
echo "Released $v"
