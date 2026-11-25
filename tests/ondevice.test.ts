import { expect, test } from 'claude-code/testing'

import { hashOf, onDevice, resetOnDevice } from '../hooks/ondevice'

// A fake host: records every command, answers from `answer`.
const host = (answer: (argv: readonly string[]) => { exitCode: number; stdout?: string }, built = false) => {
  const calls: string[] = []
  const $ = {
    plugin: { name: 'whatcha-doing', root: '/mod' },
    env: { get: async () => '/Users/me' },
    fs: { read: async () => 'swift source', exists: async () => built },
    process: {
      run: async (argv: readonly string[]) => {
        calls.push(argv[0]!.split('/').pop()!)
        return { stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false, ...answer(argv) }
      },
    },
  }
  return { $: $ as any, calls }
}

test('compiles once, asks the model, and answers the same text from the cache', async () => {
  resetOnDevice()
  const { $, calls } = host(argv => (argv[0]!.includes('ondevice-') ? { exitCode: 0, stdout: 'Fixing the tax test.\n' } : { exitCode: 0 }))
  expect(await onDevice($, 'sys', 'ran 11 tests')).toBe('Fixing the tax test.')
  expect(await onDevice($, 'sys', 'ran 11 tests')).toBe('Fixing the tax test.')
  expect(calls).toEqual(['xcode-select', 'mkdir', 'swiftc', `ondevice-${hashOf('swift source')}`])
})

test('no command line tools means no model line and no swiftc call', async () => {
  resetOnDevice()
  const { $, calls } = host(() => ({ exitCode: 2 }))
  expect(await onDevice($, 'sys', 'x')).toBeUndefined()
  expect(calls).toEqual(['xcode-select'])
})

test('Apple Intelligence off answers undefined and stops asking', async () => {
  resetOnDevice()
  const { $, calls } = host(argv => ({ exitCode: argv[0]!.includes('ondevice-') ? 2 : 0 }), true)
  expect(await onDevice($, 'sys', 'a')).toBeUndefined()
  expect(await onDevice($, 'sys', 'b')).toBeUndefined()
  expect(calls.filter(c => c.startsWith('ondevice-')).length).toBe(1)
})
