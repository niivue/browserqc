// browserqc.sh contract, with mock executables: the exact brainchop/niimath argv,
// and that the scratch directory is gone after success AND after a failure.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, chmodSync, rmSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const script = join(root, 'browserqc.sh')

// A PATH with fake brainchop + niimath that log their argv and write their output.
function mocks(brainchopExit = 0) {
  const bin = mkdtempSync(join(tmpdir(), 'browserqc-mock-'))
  const log = join(bin, 'argv.log')
  const mock = (name, body) => {
    const p = join(bin, name)
    writeFileSync(p, `#!/bin/sh\necho "${name} $*" >> "${log}"\n${body}\n`)
    chmodSync(p, 0o755)
  }
  mock('brainchop-16chan18cls', `[ "$1" ] && touch "$3"; exit ${brainchopExit}`)
  mock('niimath', 'while [ $# -gt 1 ]; do [ "$1" = --json ] && echo "{}" > "$2"; shift; done')
  return { bin, log }
}

function run(bin, args) {
  return spawnSync('bash', [script, ...args], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, encoding: 'utf8' })
}

test('browserqc.sh: argv contract, output written, scratch removed', (t) => {
  const { bin, log } = mocks()
  t.after(() => rmSync(bin, { recursive: true }))
  const out = join(bin, 'qc.json')
  const r = run(bin, ['T1.nii.gz', out])
  assert.equal(r.status, 0, r.stderr)
  const [bc, nm] = readFileSync(log, 'utf8').trim().split('\n')
  const seg = bc.split(' ')[3]
  assert.match(bc, /^brainchop-16chan18cls T1\.nii\.gz -o .*\/seg\.nii$/)
  assert.equal(nm, `niimath --qc T1.nii.gz --seg ${seg} --csf 3,4,11,12 --wm 1,5 --air ${root}/public/avg152T1.nii.gz --json ${out}`)
  assert.ok(existsSync(out))
  assert.ok(!existsSync(dirname(seg)), 'scratch directory must be removed')
})

test('browserqc.sh: brainchop failure stops the pipeline and still cleans up', (t) => {
  const { bin, log } = mocks(1)
  t.after(() => rmSync(bin, { recursive: true }))
  const r = run(bin, ['T1.nii', join(bin, 'qc.json')])
  assert.notEqual(r.status, 0)
  const lines = readFileSync(log, 'utf8').trim().split('\n')
  assert.equal(lines.length, 1, 'niimath must not run after a failed segmentation')
  assert.ok(!existsSync(dirname(lines[0].split(' ')[3])))
})

test('browserqc.sh: usage error without two arguments', (t) => {
  const { bin } = mocks()
  t.after(() => rmSync(bin, { recursive: true }))
  const r = run(bin, ['only-one'])
  assert.equal(r.status, 1)
  assert.match(r.stderr, /usage/)
})
