import { expect, mock, test } from 'claude-code/testing'

import { applyEdit, connectChoices, diffHunks, mayChangeDir, parseTarget, remoteBashScript, resolveRemotePath, shellWords } from './lib'

const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })

test('parses ssh targets like pi does', async () => {
  expect(parseTarget('ssh root@10.26.6.88 -p 30470')).toEqual({ user: 'root', host: '10.26.6.88', port: 30470, identity: undefined })
  expect(parseTarget('box -l ubuntu -i ~/.ssh/id')).toEqual({ user: 'ubuntu', host: 'box', port: 22, identity: '~/.ssh/id' })
  expect(() => parseTarget('host -J jump')).toThrow()
  expect(shellWords(`a 'b c' "d\\"e"`)).toEqual(['a', 'b c', 'd"e'])
})

test('resolves remote paths and edits', async () => {
  expect(resolveRemotePath('/srv/app', 'src/../a.py', '/root')).toBe('/srv/app/a.py')
  expect(resolveRemotePath('/srv/app', '~/x', '/root')).toBe('/root/x')
  expect(applyEdit('a b a', 'a', 'c', true)).toBe('c b c')
  expect(() => applyEdit('a b a', 'a', 'c', false)).toThrow()
  expect(() => applyEdit('abc', 'z', 'c', false)).toThrow()
  expect(diffHunks('1\n2\n3', '1\nX\n3')[0]?.lines).toEqual([' 1', '-2', '+X', ' 3'])
  expect(mayChangeDir('cd /tmp && ls')).toBe(true)
  expect(mayChangeDir('echo abcd')).toBe(false)
  expect(remoteBashScript('/srv', 'ls')).toBe(`cd '/srv' || exit 1\nls`)
})

test('routes Read and Bash to the server once connected', async ($, on) => {
  mock.store(on)
  const scripts: string[] = []
  on('process.run', ($, e) => {
    const argv = (e as { argv: readonly string[] }).argv
    const script = argv[argv.length - 1] ?? ''
    scripts.push(script)
    if (script.includes('printf')) return ok('/root\n/srv/app\n')
    if (script.includes('awk')) return ok('3\nl1\nl2\nl3\n')
    return ok('')
  })
  let ranCommand = ''
  on('tool.call', { tool: 'Bash' }, ($, e) => {
    ranCommand = e.command
    return { result: { stdout: 'hi', stderr: '', interrupted: false } }
  })

  const connected = await $.command.run({ command: 'ssh', args: 'root@box -p 2202' })
  expect(connected.text).toContain('/srv/app')

  const read = await $.tool.call({ tool: 'Read', file_path: 'a.txt' })
  expect(read.result).toEqual({
    type: 'text',
    file: { filePath: '/srv/app/a.txt', content: 'l1\nl2\nl3', numLines: 3, startLine: 1, totalLines: 3 },
  })

  await $.tool.call({ tool: 'Bash', command: 'echo hi' })
  expect(ranCommand.startsWith('ssh -p 2202')).toBe(true)
  expect(ranCommand).toContain('root@box')
  expect(ranCommand).toContain('echo hi')

  const off = await $.command.run({ command: 'ssh', args: 'off' })
  expect(off.text).toContain('Disconnected')
  await $.tool.call({ tool: 'Bash', command: 'echo local' })
  expect(ranCommand).toBe('echo local')
})

test('lists saved servers for the bare /ssh picker', async () => {
  expect(connectChoices({ endpoints: {}, memories: {} })).toEqual([{ label: 'Help' }, { label: 'Cancel' }])
  const config = {
    active: 'root@b:22',
    endpoints: { 'root@a:22': {}, 'root@b:22': { note: 'gpu' }, 'root@c:22': {}, 'root@d:22': {} },
    memories: {},
  }
  expect(connectChoices(config)).toEqual([
    { label: 'root@b:22 (gpu)', key: 'root@b:22' },
    { label: 'root@a:22', key: 'root@a:22' },
    { label: 'root@c:22', key: 'root@c:22' },
    { label: 'Cancel' },
  ])
})

test('bare /ssh asks which server and connects to the answer', async ($, on) => {
  mock.store(on)
  const targets: string[] = []
  on('process.run', ($, e) => {
    const argv = (e as { argv: readonly string[] }).argv
    targets.push(argv.find(a => a.includes('@')) ?? '')
    return ok('/root\n/srv/app\n')
  })
  const answers = ['root@box -p 2202', 'root@box:2202', 'Cancel']
  const asked: string[][] = []
  on('tool.call', { tool: 'AskUserQuestion' }, ($, e) => {
    const question = e.questions[0]!
    asked.push(question.options.map(o => o.label))
    return { result: { questions: e.questions, answers: { [question.question]: answers.shift()! } } }
  })

  expect((await $.command.run({ command: 'ssh', args: '' })).text).toContain('Connected to root@box:2202')
  expect(asked[0]).toEqual(['Help', 'Cancel'])

  targets.length = 0
  expect((await $.command.run({ command: 'ssh', args: '' })).text).toContain('Connected to root@box:2202')
  expect(asked[1]).toEqual(['root@box:2202', 'Cancel'])
  expect(targets[0]).toBe('root@box')

  expect((await $.command.run({ command: 'ssh', args: '' })).text).toBe('Cancelled.')
})
