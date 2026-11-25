// Short lines from Apple's on-device model (FoundationModels, macOS 26+), via helper/ondevice.swift.
// The helper compiles on first use with the Command Line Tools' swiftc and is reused after.
// Any missing piece (no tools, old macOS, Apple Intelligence off) answers undefined.
import type { EngineInterface } from 'claude-code'

type Host = Pick<EngineInterface, 'process' | 'fs' | 'env' | 'plugin'>

// FNV-1a: a new helper source gets a new binary name, so a mod update recompiles.
export const hashOf = (s: string) => {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193)
  return (h >>> 0).toString(16)
}

let helper: Promise<string | undefined> | undefined
let off = false // shortcut: one "model unavailable" turns it off until restart, re-check when settings can change mid-session.
const replies = new Map<string, string>()

async function build($: Host): Promise<string | undefined> {
  try {
    // xcode-select first: a bare /usr/bin/swiftc without the tools pops an install dialog.
    if ((await $.process.run(['xcode-select', '-p'])).exitCode !== 0) return undefined
    const src = `${$.plugin.root}/helper/ondevice.swift`
    const dir = `${await $.env.get('HOME')}/Library/Caches/whatcha-doing`
    const bin = `${dir}/ondevice-${hashOf(await $.fs.read(src))}`
    if (await $.fs.exists(bin)) return bin
    await $.process.run(['mkdir', '-p', dir])
    const made = await $.process.run(['swiftc', '-O', src, '-o', bin], { timeoutMs: 180_000 })
    return made.exitCode === 0 ? bin : undefined
  } catch {
    return undefined
  }
}

export async function onDevice($: Host, system: string, text: string): Promise<string | undefined> {
  const key = system + '\0' + text
  const hit = replies.get(key)
  if (hit !== undefined || off) return hit
  const bin = await (helper ??= build($))
  if (!bin) return undefined
  try {
    const r = await $.process.run([bin], { stdin: JSON.stringify({ system, text }), timeoutMs: 15_000 })
    if (r.exitCode === 2) off = true
    const reply = r.stdout.trim()
    if (r.exitCode !== 0 || !reply) return undefined
    if (replies.size >= 100) replies.delete(replies.keys().next().value!)
    replies.set(key, reply)
    return reply
  } catch {
    return undefined // timeout or crash: no model line this time
  }
}

// Test hook: forget the built helper, the cache and the off switch.
export const resetOnDevice = () => {
  helper = undefined
  off = false
  replies.clear()
}
