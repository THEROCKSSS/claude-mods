import { describe, expect, mock, test } from 'claude-code/testing'

import { classify, classifyPowerShell, resetBandOrder, timeoutFrom } from '../hooks/register'

const PANE = { component: 'Pane', requestId: 'blast-radius-win', props: { title: 'Blast Radius', isFocused: true, bodyColumns: 100, placement: 'dock' } }

// Stands for the engine beneath the mod: tools run, a 9-file build folder, panes that open, a terminal that draws.
// The test's clock: $.clock.now reads a time only advance() moves, so a deadline passes when the test says,
// while $.clock.sleep takes a real 5 ms, so the hold loop yields as it does in a session.
function fakeClock(on: any, { now = 0 } = {}) {
  let at = now
  on('clock.now', () => ({ value: at }))
  on('clock.sleep', async () => {
    await new Promise(done => (globalThis as any).setTimeout(done, 5))
    return { value: undefined }
  })
  return {
    advance: async (ms: number) => {
      at += ms
      await new Promise(done => (globalThis as any).setTimeout(done, 20)) // let the loop see the new time
    },
  }
}

// Its clock is the test's: pass one from mock.clock to move it, or the engine makes its own.
function engine(on: any, ran: string[], { surfaces = ['terminal'], opened = [] as unknown[], clock = undefined as unknown, isPlaced = true, previews = [] as string[][] } = {}) {
  resetBandOrder()
  if (!clock) fakeClock(on)
  on('env.get', (_$: any, e: any) => ({ value: e.name === 'HOME' ? '/home/me' : undefined }))
  on('session.surfaces', () => ({ value: surfaces }))
  on('tool.call', (_$: any, e: any) => {
    ran.push(e.command)
    return { result: {}, text: 'ok' }
  })
  on('process.run', async (_$: any, e: any) => {
    const argv: string[] = e.argv
    if (/bash(.exe)?$/.test(argv[0])) previews.push(argv.slice(4)) // the targets the preview looks at
    if (argv[0] === 'sleep') await new Promise(done => (globalThis as any).setTimeout(done, 5)) // a real wait, so the hold loop yields
    const stdout = /bash(.exe)?$/.test(argv[0])
      ? ['S 1126', ...Array.from({ length: 9 }, (_, i) => `F build/chunk-${i}.js`)].join('\n')
      : ''
    return { value: { exitCode: 0, stdout, stderr: '' } }
  })
  on('ui.open', (_$: any, e: any) => {
    opened.push(e)
    return { value: { isPlaced } }
  })
  on('ui.close', () => ({ value: undefined }))
}

// Mounts the pane until it shows text matching `text` (the hold loop runs on its own).
async function paneShowing($: any, text: RegExp) {
  for (let i = 0; i < 50; i++) {
    const ui = await $.ui.mount({ plugin: 'blast-radius-win', surface: 'terminal', ...PANE })
    if (await ui.find({ type: 'Text', text })) return ui
    await ui.unmount()
    await new Promise(done => (globalThis as any).setTimeout(done, 5))
  }
  throw new Error(`the pane never showed ${text}`)
}

async function heldPane($: any) {
  for (let i = 0; i < 50; i++) {
    const ui = await $.ui.mount({ plugin: 'blast-radius-win', surface: 'terminal', ...PANE })
    if (await ui.find({ type: 'Text', text: /held a command/ })) return ui
    await ui.unmount()
  }
  throw new Error('nothing was held')
}

describe('blast-radius', () => {
  test('classifies only the risky commands', () => {
    expect(classify('rm -rf build')?.risk).toBe('delete')
    expect(classify('cd web && rm -r dist')).toEqual({ risk: 'delete', shell: 'bash', cwd: 'web', targets: ['dist'] })
    expect(classify('git push --force origin main')?.risk).toBe('force-push')
    expect(classify('git push -f')?.risk).toBe('force-push')
    expect(classify('npx prisma migrate deploy')?.risk).toBe('migration')
    expect(classify('rm file.txt')).toBeNull()
    expect(classify('git push origin main')).toBeNull()
    expect(classify('ls -la && echo rm -rf')).toBeNull()
  })

  test('Cancel refuses the command with the reason', async ($, on) => {
    const ran: string[] = []
    engine(on, ran)
    const call = $.tool.call({ tool: 'Bash', command: 'rm -rf build' } as any)
    const ui = await heldPane($)
    expect(await ui.find({ type: 'Text', text: /delete 9 files \(1\.1 MB\)/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /build\/chunk-0\.js/ })).toBeDefined()
    await ui.press({ key: 'cancel' })
    const r: any = await call
    expect(r.deny).toMatch(/^blast-radius-win: the user pressed Cancel on this command\. It would have: delete 9 files/)
    expect(ran).toEqual([])
    await ui.unmount()
  })

  test('Proceed runs the command as written', async ($, on) => {
    const ran: string[] = []
    engine(on, ran)
    const call = $.tool.call({ tool: 'Bash', command: 'rm -rf build' } as any)
    const ui = await heldPane($)
    await ui.press({ key: 'proceed' })
    await call
    expect(ran).toEqual(['rm -rf build'])
    await ui.unmount()
  })

  test('lists files from the folder being deleted', async ($, on) => {
    on('tool.call', () => ({ result: {}, text: 'ok' }) as any)
    on('process.run', async (_$: any, e: any) => {
      if (e.argv[0] === 'sleep') await new Promise(done => (globalThis as any).setTimeout(done, 5))
      const stdout = /bash(.exe)?$/.test(e.argv[0]) ? 'S 4\nF /tmp/deep/demo/build/chunk-1.js' : ''
      return { value: { exitCode: 0, stdout, stderr: '' } } as any
    })
    on('ui.open', () => ({ value: { isPlaced: true } }) as any)
    on('ui.close', () => ({ value: undefined }) as any)
    on('session.surfaces', () => ({ value: ['terminal'] }) as any)
    fakeClock(on)
    const call = $.tool.call({ tool: 'Bash', command: 'rm -rf /tmp/deep/demo/build' } as any)
    const ui = await heldPane($)
    expect(await ui.find({ type: 'Text', text: /^  build\/chunk-1\.js$/ })).toBeDefined()
    await ui.press({ key: 'cancel' })
    await call
    await ui.unmount()
  })

  test('a path with a shell variable says it cannot preview, never "nothing"', async ($, on) => {
    const ran: string[] = []
    const previews: string[][] = []
    engine(on, ran, { previews })
    const call = $.tool.call({ tool: 'Bash', command: 'rm -rf $S/build' } as any)
    const ui = await heldPane($)
    expect(await ui.find({ type: 'Text', text: /can't preview: a path uses a shell variable, check by hand/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /\$S\/build/ })).toBeDefined()
    expect(previews).toEqual([]) // nothing measured, so no false "nothing"
    await ui.press({ key: 'cancel' })
    const r: any = await call
    expect(r.deny).toMatch(/can't preview/)
    await ui.unmount()
  })

  test('~ and $HOME are expanded before the preview', async ($, on) => {
    const ran: string[] = []
    const previews: string[][] = []
    engine(on, ran, { previews })
    const call = $.tool.call({ tool: 'Bash', command: 'rm -rf ~/build $HOME/cache' } as any)
    const ui = await heldPane($)
    expect(previews[0]).toEqual(['/home/me/build', '/home/me/cache'])
    await ui.press({ key: 'cancel' })
    await call
    await ui.unmount()
  })

  test("a quoted '~' is not previewed as the home folder", async ($, on) => {
    const ran: string[] = []
    const previews: string[][] = []
    engine(on, ran, { previews })
    const call = $.tool.call({ tool: 'Bash', command: "rm -rf '~' \"$HOME/x\"" } as any)
    const ui = await heldPane($)
    expect(await ui.find({ type: 'Text', text: /can't preview: 2 paths use a shell variable/ })).toBeDefined()
    expect(previews).toEqual([])
    await ui.press({ key: 'cancel' })
    await call
    await ui.unmount()
  })

  test('a safe command is never held', async ($, on) => {
    const ran: string[] = []
    engine(on, ran)
    await $.tool.call({ tool: 'Bash', command: 'ls -la' } as any)
    expect(ran).toEqual(['ls -la'])
  })

  test('reads timeoutSeconds as whole seconds, 60 when unset or wrong', () => {
    expect(timeoutFrom(undefined)).toBe(60)
    expect(timeoutFrom(30)).toBe(30)
    expect(timeoutFrom('120')).toBe(120)
    expect(timeoutFrom(0)).toBe(0)
    expect(timeoutFrom(0.4)).toBe(1)
    expect(timeoutFrom(-5)).toBe(60)
    expect(timeoutFrom('soon')).toBe(60)
  })

  test('nobody pressing within 60 s cancels with the reason', async ($, on) => {
    const clock = fakeClock(on, { now: 1_000_000 })
    const ran: string[] = []
    engine(on, ran, { clock })
    const call = $.tool.call({ tool: 'Bash', command: 'rm -rf build' } as any)
    const ui = await paneShowing($, /auto-cancels in 60 s/)
    await ui.unmount()
    await clock.advance(18_000)
    const later = await paneShowing($, /auto-cancels in 42 s/)
    await later.unmount()
    await clock.advance(42_000)
    const r: any = await call
    expect(r.deny).toMatch(/nobody answered within 60 s, so it was cancelled\. It would have: delete 9 files \(1\.1 MB\)\. Don't retry it on your own: ask the user to run it/)
    expect(ran).toEqual([])
  })

  test('a shorter timeoutSeconds cancels sooner', { options: { timeoutSeconds: 30 } }, async ($, on) => {
    const clock = fakeClock(on)
    const ran: string[] = []
    engine(on, ran, { clock })
    const call = $.tool.call({ tool: 'Bash', command: 'git push --force' } as any)
    const ui = await paneShowing($, /auto-cancels in 30 s/)
    await ui.unmount()
    await clock.advance(30_000)
    const r: any = await call
    expect(r.deny).toMatch(/nobody answered within 30 s/)
    expect(ran).toEqual([])
  })

  for (const key of ['cancel', 'proceed'] as const) {
    test(`pressing ${key} before the timeout still decides`, async ($, on) => {
      const clock = fakeClock(on)
      const ran: string[] = []
      engine(on, ran, { clock })
      const call = $.tool.call({ tool: 'Bash', command: 'rm -rf build' } as any)
      const first = await paneShowing($, /auto-cancels in 60 s/)
      await first.unmount()
      await clock.advance(50_000)
      const ui = await paneShowing($, /auto-cancels in 10 s/)
      await ui.press({ key })
      const r: any = await call
      if (key === 'cancel') {
        expect(r.deny).toMatch(/the user pressed Cancel/)
        expect(ran).toEqual([])
      } else {
        expect(ran).toEqual(['rm -rf build'])
      }
      await ui.unmount()
    })
  }

  test('timeoutSeconds 0 waits for a press, with no countdown', { options: { timeoutSeconds: 0 } }, async ($, on) => {
    const clock = fakeClock(on)
    const ran: string[] = []
    engine(on, ran, { clock })
    let isSettled = false
    const call = $.tool.call({ tool: 'Bash', command: 'rm -rf build' } as any).then((r: any) => {
      isSettled = true
      return r
    })
    const ui = await heldPane($)
    expect(await ui.find({ type: 'Text', text: /auto-cancels/ })).toBeUndefined()
    await ui.unmount()
    await clock.advance(10 * 60_000)
    await new Promise(done => (globalThis as any).setTimeout(done, 50))
    expect(isSettled).toBe(false)
    const again = await heldPane($)
    await again.press({ key: 'proceed' })
    await call
    expect(ran).toEqual(['rm -rf build'])
    await again.unmount()
  })

  test('a session with no screen cancels at once', async ($, on) => {
    const ran: string[] = []
    const opened: unknown[] = []
    engine(on, ran, { surfaces: [], opened })
    const r: any = await $.tool.call({ tool: 'Bash', command: 'rm -rf build' } as any)
    expect(r.deny).toMatch(/no screen, so nobody can answer\. It would have: delete 9 files/)
    expect(ran).toEqual([])
    expect(opened).toEqual([])
  })

  test('the countdown shows in the band when the pane cannot open', async ($, on) => {
    const clock = fakeClock(on)
    const ran: string[] = []
    engine(on, ran, { clock, isPlaced: false })
    const call = $.tool.call({ tool: 'Bash', command: 'rm -rf build' } as any)
    // The band draws nothing of its own until the command is held: try again until it does.
    const bandShowing = async (text: RegExp) => {
      for (let i = 0; i < 100; i++) {
        const ui = await $.ui.mount({ plugin: 'blast-radius-win', surface: 'terminal', component: 'AbovePrompt', props: { bodyColumns: 100 } } as any).catch(() => null)
        if (ui && (await ui.find({ type: 'Text', text }))) return ui
        await ui?.unmount()
        await new Promise(done => (globalThis as any).setTimeout(done, 5))
      }
      return undefined
    }
    expect(await bandShowing(/auto-cancels in 60 s/).then(ui => ui?.unmount().then(() => true))).toBe(true)
    await clock.advance(52_000)
    const band: any = await bandShowing(/auto-cancels in 8 s/)
    expect(band).toBeDefined()
    // the held command takes the whole band, keyed so the band order can place it
    const root: any = await band.drawn()
    expect(root.props.key).toBe('bands')
    expect(root.children.map((c: any) => c.props.key)).toEqual(['band:blast-radius-win'])
    await clock.advance(8_000)
    const r: any = await call
    expect(r.deny).toMatch(/nobody answered within 60 s/)
    expect(ran).toEqual([])
    await band.unmount()
  })

  test('classifies risky PowerShell, by cmdlet, alias and parameter prefix', () => {
    expect(classifyPowerShell('Remove-Item -Recurse -Force .\\dist')).toEqual({ risk: 'delete', shell: 'powershell', targets: ['.\\dist'] })
    expect(classifyPowerShell('rm -r build')?.risk).toBe('delete')
    expect(classifyPowerShell('ri -Rec -Force node_modules')?.risk).toBe('delete')
    expect(classifyPowerShell('Set-Location web; Remove-Item dist -Recurse')).toEqual({ risk: 'delete', shell: 'powershell', cwd: 'web', targets: ['dist'] })
    expect(classifyPowerShell('Remove-Item . -Recurse -Include *.log')?.targets).toEqual(['.'])
    expect(classifyPowerShell('git push --force-with-lease')?.risk).toBe('force-push')
    expect(classifyPowerShell('npx prisma migrate reset')?.risk).toBe('migration')
    expect(classifyPowerShell('Remove-Item notes.txt')).toBeNull()
    expect(classifyPowerShell('Get-ChildItem -Recurse | Select-Object Name')).toBeNull()
  })

  test('a recursive PowerShell delete is held, and Cancel refuses it', async ($, on) => {
    const ran: string[] = []
    engine(on, ran)
    const call = $.tool.call({ tool: 'PowerShell', command: 'Remove-Item -Recurse -Force build' } as any)
    const ui = await heldPane($)
    expect(await ui.find({ type: 'Text', text: /delete 9 files/ })).toBeDefined()
    await ui.press({ key: 'cancel' })
    expect(((await call) as any).deny).toMatch(/^blast-radius-win: the user pressed Cancel/)
    expect(ran).toEqual([])
    await ui.unmount()
  })

  test('a guard that fails blocks the command instead of letting it run', async ($, on) => {
    const ran: string[] = []
    fakeClock(on)
    on('session.surfaces', () => {
      throw new Error('no surfaces here')
    })
    on('tool.call', (_$: any, e: any) => {
      ran.push(e.command)
      return { result: {}, text: 'ok' }
    })
    const r: any = await $.tool.call({ tool: 'Bash', command: 'rm -rf build' } as any)
    expect(r.deny).toMatch(/guard failed before it could check this command \(throw: .+\), so it was blocked/) // the reason, for whoever reads the refusal
    expect(ran).toEqual([])
  })

  test('a second held command gets its own full wait', async ($, on) => {
    const clock = fakeClock(on)
    const ran: string[] = []
    engine(on, ran, { clock })
    const first = $.tool.call({ tool: 'Bash', command: 'rm -rf build', tool_use_id: 'one' } as any)
    const second = $.tool.call({ tool: 'Bash', command: 'git push --force', tool_use_id: 'two' } as any)
    const ui = await paneShowing($, /rm -rf build/)
    await ui.unmount()
    await clock.advance(60_000)
    expect(((await first) as any).deny).toMatch(/nobody answered within 60 s/)
    const next = await paneShowing($, /auto-cancels in 60 s/)
    expect(await next.find({ type: 'Text', text: /git push --force/ })).toBeDefined()
    await next.press({ key: 'proceed' })
    await second
    expect(ran).toEqual(['git push --force'])
    await next.unmount()
  })
})
