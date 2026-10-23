// node scripts/check-mods.mjs [mod ...]: `claude plugin validate` and `claude plugin test` for every mod
// (or the ones named), with a table at the end. Exits 1 if any mod fails beyond its known failures.
//   CLAUDE_BIN picks the binary (in the desktop app: $CLAUDE_CODE_EXECPATH); default `claude`.
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Failures that also happen on unmodified upstream, so they are not ours to fix here.
const KNOWN_FAILURES = { 'mission-control-win': 2 }

const root = fileURLToPath(new URL('..', import.meta.url))
const bin = process.env.CLAUDE_BIN || process.env.CLAUDE_CODE_EXECPATH || 'claude'
const wanted = process.argv.slice(2)
const mods = readdirSync(join(root, 'mods'), { withFileTypes: true })
  .filter(d => d.isDirectory() && (wanted.length === 0 || wanted.includes(d.name)))
  .map(d => d.name)

const run = args => {
  const r = spawnSync(bin, args, { cwd: root, encoding: 'utf8', shell: process.platform === 'win32' && bin === 'claude' })
  return { code: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? String(r.error) : ''}` }
}

const rows = []
for (const mod of mods) {
  const dir = `mods/${mod}`
  const validate = run(['plugin', 'validate', dir])
  const test = run(['plugin', 'test', dir])
  const pass = Number(test.out.match(/(\d+) pass/)?.[1] ?? 0)
  const fail = Number(test.out.match(/(\d+) fail/)?.[1] ?? (test.code === 0 ? 0 : 1))
  const allowed = KNOWN_FAILURES[mod] ?? 0
  const ok = validate.code === 0 && fail <= allowed && pass > 0
  if (!ok) console.log(`\n--- ${mod} ---\n${validate.out}\n${test.out}`)
  rows.push({ mod, valid: validate.code === 0 ? 'yes' : 'NO', tests: `${pass}/${pass + fail}${allowed && fail ? ` (${fail} known upstream)` : ''}`, ok })
}

console.log('\n| Mod | Valid | Tests |\n| --- | --- | --- |')
for (const r of rows) console.log(`| ${r.mod} | ${r.valid} | ${r.tests}${r.ok ? '' : ' FAIL'} |`)
process.exit(rows.every(r => r.ok) ? 0 : 1)
