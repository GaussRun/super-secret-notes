import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, chmod } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { sharedOperators } from '../src/backends/index.js'

test('one account per provider: shared operators are found, independent ones are not', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ssn-op-'))
  const fakeRclone = path.join(dir, 'rclone')
  await writeFile(fakeRclone, '#!/bin/sh\nprintf "pd:  protondrive\\nkoofr: koofr\\n"\n')
  await chmod(fakeRclone, 0o755)
  const groups = await sharedOperators([
    { name: 'mega', type: 'mega', email: 'a@example.com' },
    { name: 'mega2', type: 'mega', email: 'b@example.com' },
    { name: 'proton', type: 'proton-cli' },
    { name: 'proton-rclone', type: 'rclone', remote: 'pd', bin: fakeRclone },
    { name: 'koofr', type: 'rclone', remote: 'koofr', bin: fakeRclone },
    { name: 'filen', type: 'filen' },
    { name: 'pb-a', type: 'privatebin', url: 'https://pb.envs.net' },
    { name: 'pb-b', type: 'privatebin', url: 'https://paste.systemli.org' },
    { name: 'pb-a-again', type: 'privatebin', url: 'https://pb.envs.net/' },
    { name: 'usb', type: 'local', path: '/a' },
    { name: 'usb2', type: 'local', path: '/b' }
  ])
  assert.deepEqual(groups, [
    { operator: 'MEGA', names: ['mega', 'mega2'] },
    { operator: 'Proton', names: ['proton', 'proton-rclone'] },
    { operator: 'PrivateBin pb.envs.net', names: ['pb-a', 'pb-a-again'] }
  ])
})
