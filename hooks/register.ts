import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { RemoteSession } from '../types'
import {
  applyEdit,
  diffHunks,
  emptyConfig,
  endpointKey,
  imageType,
  mayChangeDir,
  memoryKey,
  parseEndpointKey,
  parseForward,
  parseTarget,
  q,
  remoteBashScript,
  resolveRemotePath,
  shellLine,
  shellWords,
  sshArgv,
  type Endpoint,
  type RemoteConfig,
} from './lib'

type $ = EngineInterface

const session = atom({ plugin: 'ssh-remote', key: 'session' } as const, null)

const TOOL = 'remote'
const DEFAULT_READ_LIMIT = 2000
const MAX_LINE_CHARS = 2000
const MAX_READ_BYTES = 256 * 1024
const MAX_IMAGE_BYTES = 3_750_000
const MAX_FILE_BYTES = 4 * 1024 * 1024 - 1024

// Bash commands this module wrapped for the remote host, auto-approved at tool.check.
const wrapped = new Set<string>()

const USAGE = [
  'Usage:',
  '  /ssh ssh [user@]host [-p PORT] [-l USER] [-i KEY]   connect and route tools remotely',
  '  /ssh                         reconnect the active server',
  '  /ssh status | config | use USER@HOST:PORT',
  '  /ssh cd PATH                 change the remote cwd (saved as default)',
  '  /ssh exec COMMAND            run one command remotely',
  '  /ssh note TEXT|--clear       label this server',
  '  /ssh memory [TEXT|--clear]   show / append / clear server memory',
  '  /ssh forward [L:HOST:R ...]  start port forwards, tools stay local',
  '  /ssh unforward | on | off | reload',
].join('\n')

async function loadConfig($: $): Promise<RemoteConfig> {
  const raw = (await $.store.get('config')) as RemoteConfig | undefined
  return { ...emptyConfig(), ...raw }
}

async function saveConfig($: $, config: RemoteConfig): Promise<void> {
  await $.store.set('config', config)
}

async function getSession($: $): Promise<RemoteSession | null> {
  return read($, session)
}

async function setSession($: $, value: RemoteSession | null): Promise<void> {
  await update($, session, () => value)
  showStatus($, value, await loadConfig($))
}

function label(s: RemoteSession, config: RemoteConfig): string {
  const note = config.endpoints[s.key]?.note
  return note ? `${note} (${s.key})` : s.key
}

function showStatus($: $, s: RemoteSession | null, config: RemoteConfig): void {
  if (!s) return $.ui.status(undefined)
  const name = config.endpoints[s.key]?.note ?? s.key
  const fwd = s.forwards.length ? ` ⇆${s.forwards.length}` : ''
  $.ui.status(s.routing ? `⇄ ${name}:${s.cwd}${fwd}` : `⇆ ${name} (tunnel only)${fwd}`)
}

async function ssh($: $, ep: Endpoint, script: string, stdin?: string, timeoutMs = 60_000) {
  return $.process.run(sshArgv(ep, script), { stdin, timeoutMs })
}

function sshError(r: { exitCode: number; stderr: string }): string {
  return r.stderr.trim() || `exit code ${r.exitCode}`
}

// ---------------------------------------------------------------- actions

async function connect($: $, ep: Endpoint, cwd?: string): Promise<string> {
  const config = await loadConfig($)
  const key = endpointKey(ep)
  const saved = config.endpoints[key] ?? {}
  if (!ep.identity && saved.identity) ep = { ...ep, identity: saved.identity }
  const target = cwd ?? saved.cwd
  const goto =
    !target || target === '~' ? 'cd' : target.startsWith('~/') ? `cd "$HOME"/${q(target.slice(2))}` : `cd ${q(target)}`
  const script = `${goto} || exit 2\nprintf '%s\\n%s\\n' "$HOME" "$PWD"`
  const r = await ssh($, ep, script, undefined, 30_000)
  if (r.exitCode !== 0) throw new Error(`cannot connect to ${key}: ${sshError(r)}`)
  const [home = '', pwd = ''] = r.stdout.trim().split('\n')
  const id = crypto.randomUUID().replace(/-/g, '').slice(0, 16)
  const s: RemoteSession = {
    key,
    endpoint: ep,
    cwd: pwd,
    home,
    routing: true,
    forwards: [],
    cwdFile: `/tmp/.cc-remote-cwd-${id}`,
  }
  config.endpoints[key] = { ...saved, identity: ep.identity, cwd: pwd }
  config.active = key
  await saveConfig($, config)
  await setSession($, s)
  return `Connected to ${label(s, config)}. Remote cwd: ${pwd}. Bash, Read, Write and Edit now run on this server.`
}

async function disconnect($: $): Promise<string> {
  const s = await getSession($)
  if (!s) return 'Not connected.'
  await $.process.run(sshArgv(s.endpoint, undefined, ['-O', 'exit']), { timeoutMs: 10_000 }).catch(() => undefined)
  await setSession($, null)
  return `Disconnected from ${s.key}. Tools run locally again.`
}

async function changeDir($: $, path: string): Promise<string> {
  const s = await requireSession($)
  const target = resolveRemotePath(s.cwd, path, s.home)
  const r = await ssh($, s.endpoint, `cd ${q(target)} && pwd`)
  if (r.exitCode !== 0) throw new Error(sshError(r))
  const cwd = r.stdout.trim()
  await setSession($, { ...s, cwd })
  const config = await loadConfig($)
  config.endpoints[s.key] = { ...config.endpoints[s.key], cwd }
  await saveConfig($, config)
  return `Remote cwd: ${cwd}`
}

async function requireSession($: $): Promise<RemoteSession> {
  const s = await getSession($)
  if (!s) throw new Error('Not connected. Use /ssh ssh user@host -p PORT first.')
  return s
}

async function status($: $): Promise<string> {
  const s = await getSession($)
  if (!s) return 'Not connected; tools run locally.'
  const config = await loadConfig($)
  const memory = config.memories[memoryKey(s.endpoint)]
  return [
    `Server: ${label(s, config)}`,
    `Remote cwd: ${s.cwd}`,
    `Routing: ${s.routing ? 'Bash/Read/Write/Edit run remotely' : 'tunnel only (tools local)'}`,
    `Forwards: ${s.forwards.length ? s.forwards.join(', ') : 'none'}`,
    `Memory: ${memory ? '\n' + memory : 'none'}`,
  ].join('\n')
}

async function showConfig($: $): Promise<string> {
  const config = await loadConfig($)
  const keys = Object.keys(config.endpoints)
  if (!keys.length) return 'No saved servers.'
  return keys
    .map(k => {
      const c = config.endpoints[k] ?? {}
      const ep = parseEndpointKey(k)
      const mem = ep && config.memories[memoryKey(ep)]
      return [
        `${k === config.active ? '*' : ' '} ${k}${c.note ? `  — ${c.note}` : ''}`,
        c.cwd && `    cwd: ${c.cwd}`,
        c.identity && `    key: ${c.identity}`,
        c.forwards?.length && `    forwards: ${c.forwards.join(' ')}`,
        mem && `    memory: ${mem.replace(/\n/g, ' ').slice(0, 100)}`,
      ].filter(Boolean).join('\n')
    })
    .join('\n')
}

async function setNote($: $, text: string): Promise<string> {
  const s = await requireSession($)
  const config = await loadConfig($)
  const note = text === '--clear' ? undefined : text.trim() || undefined
  config.endpoints[s.key] = { ...config.endpoints[s.key], note }
  await saveConfig($, config)
  showStatus($, s, config)
  return note ? `Note for ${s.key}: ${note}` : `Note cleared for ${s.key}.`
}

/** Without text: reads. With text: appends (deduplicated). `--clear`: clears. */
async function memory($: $, text?: string): Promise<string> {
  const s = await requireSession($)
  const config = await loadConfig($)
  const key = memoryKey(s.endpoint)
  const current = config.memories[key]
  if (text === undefined || text.trim() === '') return current ? `Memory for ${key}:\n${current}` : `No memory for ${key}.`
  if (text.trim() === '--clear') {
    delete config.memories[key]
    await saveConfig($, config)
    return `Memory cleared for ${key}.`
  }
  const add = text.trim()
  if (current?.endsWith(add)) return `Memory for ${key} already ends with that.`
  config.memories[key] = current ? `${current}\n${add}` : add
  await saveConfig($, config)
  return `Memory for ${key}:\n${config.memories[key]}`
}

async function forward($: $, specs: string[]): Promise<string> {
  const s = await requireSession($)
  const config = await loadConfig($)
  const list = (specs.length ? specs : config.endpoints[s.key]?.forwards ?? []).map(parseForward)
  if (!list.length) throw new Error('No forwards given or saved. Example: /ssh forward 7860:127.0.0.1:7860')
  const started: string[] = []
  for (const spec of list) {
    if (s.forwards.includes(spec)) continue
    const r = await $.process.run(sshArgv(s.endpoint, undefined, ['-O', 'forward', '-L', spec]), { timeoutMs: 15_000 })
    if (r.exitCode !== 0) throw new Error(`forward ${spec} failed: ${sshError(r)}`)
    started.push(spec)
  }
  if (specs.length) {
    config.endpoints[s.key] = { ...config.endpoints[s.key], forwards: [...new Set([...(config.endpoints[s.key]?.forwards ?? []), ...list])] }
    await saveConfig($, config)
  }
  await setSession($, { ...s, routing: false, forwards: [...s.forwards, ...started] })
  return `Forwarding ${[...s.forwards, ...started].join(', ')} (localhost → ${s.key}). Tools now run locally; /ssh on routes them back.`
}

async function unforward($: $): Promise<string> {
  const s = await requireSession($)
  for (const spec of s.forwards) {
    await $.process.run(sshArgv(s.endpoint, undefined, ['-O', 'cancel', '-L', spec]), { timeoutMs: 15_000 }).catch(() => undefined)
  }
  await setSession($, { ...s, forwards: [] })
  return 'Port forwards stopped.'
}

async function exec($: $, command: string): Promise<string> {
  const s = await requireSession($)
  const r = await ssh($, s.endpoint, remoteBashScript(s.cwd, command), undefined, 120_000)
  const out = (r.stdout + (r.stderr ? `\n[stderr]\n${r.stderr}` : '')).trimEnd()
  const tail = out.split('\n').slice(-200).join('\n')
  return `$ ${command}\n${tail}${r.exitCode ? `\n[exit ${r.exitCode}]` : ''}`
}

async function runCommand($: $, args: string): Promise<string> {
  const trimmed = args.trim()
  const [sub = '', ...rest] = shellWords(trimmed)
  const after = trimmed.slice(trimmed.indexOf(sub) + sub.length).trim()
  switch (sub) {
    case '': {
      const config = await loadConfig($)
      const ep = config.active && parseEndpointKey(config.active)
      if (!ep) return USAGE
      return connect($, { ...ep, identity: config.endpoints[config.active!]?.identity })
    }
    case 'ssh': return connect($, parseTarget(after))
    case 'use': {
      const ep = parseEndpointKey(rest[0] ?? '')
      if (!ep) throw new Error('use USER@HOST:PORT')
      return connect($, ep)
    }
    case 'status': return status($)
    case 'config': return showConfig($)
    case 'cd': return changeDir($, after || '~')
    case 'exec': return exec($, after)
    case 'note': return setNote($, after)
    case 'memory': return memory($, after)
    case 'forward': return forward($, rest)
    case 'unforward': return unforward($)
    case 'on': {
      const s = await requireSession($)
      await setSession($, { ...s, routing: true })
      return `Tools route to ${s.key} again (cwd ${s.cwd}).`
    }
    case 'off': return disconnect($)
    case 'reload': {
      const s = await requireSession($)
      await disconnect($)
      return connect($, s.endpoint, s.cwd)
    }
    case 'help': return USAGE
    default:
      // `/ssh user@host -p 22` works without the `ssh` word.
      if (sub.includes('@')) return connect($, parseTarget(trimmed))
      return USAGE
  }
}

// ---------------------------------------------------------------- file tools

async function remoteRead($: $, s: RemoteSession, filePath: string, offset?: number, limit?: number) {
  const path = resolveRemotePath(s.cwd, filePath, s.home)
  const img = imageType(path)
  if (img) {
    const r = await ssh($, s.endpoint, `f=${q(path)}\n[ -f "$f" ] || { echo "File does not exist." >&2; exit 3; }\nsize=$(stat -c %s -- "$f")\n[ "$size" -le ${MAX_IMAGE_BYTES} ] || { echo "Image too large ($size bytes)." >&2; exit 4; }\necho "$size"\nbase64 -w0 -- "$f"`)
    if (r.exitCode !== 0) throw new Error(sshError(r))
    const [size = '0', base64 = ''] = r.stdout.split('\n')
    return { type: 'image' as const, file: { base64: base64.trim(), type: img, originalSize: Number(size) } }
  }
  const start = Math.max(1, Math.floor(offset ?? 1))
  const count = Math.max(1, Math.floor(limit ?? DEFAULT_READ_LIMIT))
  const script = [
    `f=${q(path)}`,
    `[ -e "$f" ] || { echo "File does not exist: $f" >&2; exit 3; }`,
    `[ -d "$f" ] && { echo "EISDIR: $f is a directory; use Bash ls instead." >&2; exit 4; }`,
    `awk 'END{print NR}' "$f"`,
    `awk -v s=${start} -v n=${count} 'NR>=s && NR<s+n {print} NR>=s+n {exit}' "$f" | head -c ${MAX_READ_BYTES}`,
  ].join('\n')
  const r = await ssh($, s.endpoint, script)
  if (r.exitCode !== 0) throw new Error(sshError(r))
  const nl = r.stdout.indexOf('\n')
  const totalLines = Number(r.stdout.slice(0, nl))
  let body = r.stdout.slice(nl + 1)
  if (body.endsWith('\n')) body = body.slice(0, -1)
  const lines = body === '' ? [] : body.split('\n').map(l => (l.length > MAX_LINE_CHARS ? l.slice(0, MAX_LINE_CHARS) + '…' : l))
  return {
    type: 'text' as const,
    file: { filePath: path, content: lines.join('\n'), numLines: lines.length, startLine: start, totalLines },
  }
}

/** Reads a whole remote file for editing; `undefined` when it does not exist. */
async function readWhole($: $, s: RemoteSession, path: string): Promise<string | undefined> {
  const r = await ssh($, s.endpoint, `f=${q(path)}\nif [ -f "$f" ]; then size=$(stat -c %s -- "$f"); [ "$size" -le ${MAX_FILE_BYTES} ] || { echo "File too large to edit remotely ($size bytes)." >&2; exit 4; }; printf E; cat -- "$f"; elif [ -e "$f" ]; then echo "Not a regular file: $f" >&2; exit 5; else printf N; fi`)
  if (r.exitCode !== 0) throw new Error(sshError(r))
  return r.stdout.startsWith('E') ? r.stdout.slice(1) : undefined
}

async function writeWhole($: $, s: RemoteSession, path: string, content: string): Promise<void> {
  const r = await ssh($, s.endpoint, `f=${q(path)}\nmkdir -p -- "$(dirname -- "$f")" && cat > "$f"`, content)
  if (r.exitCode !== 0) throw new Error(`write failed: ${sshError(r)}`)
}

function failed(e: unknown) {
  return { deny: `ssh-remote: ${e instanceof Error ? e.message : String(e)}` }
}

const guard = ($: $, e: unknown, next: ((e: any) => any) & { called: boolean }) =>
  next.called ? next(e) : { deny: 'ssh-remote: the remote routing hook failed; nothing ran locally.' }

// ---------------------------------------------------------------- register

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'ssh',
      description: 'SSH remote workspace: route Bash/Read/Write/Edit to a server',
      argumentHint: 'ssh user@host -p PORT | status | cd PATH | off | help',
    })
    await $.tool.register({
      name: TOOL,
      isDeferred: false,
      description:
        'Manage the SSH remote workspace. While connected, Bash, Read, Write and Edit already run on the remote server, ' +
        'so do not wrap commands in ssh yourself. Actions: status; connect (target like "root@host -p 2202"); cd (path); ' +
        'off; note (text); memory (no text reads; text appends; "--clear" clears); forward (specs "LPORT:HOST:RPORT", ' +
        'tools return to local); unforward; on (route tools remotely again).',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['status', 'connect', 'cd', 'off', 'note', 'memory', 'forward', 'unforward', 'on'] },
          target: { type: 'string', description: 'connect: [user@]host [-p PORT] [-i KEY]' },
          path: { type: 'string', description: 'cd: remote directory' },
          text: { type: 'string', description: 'note / memory text' },
          specs: { type: 'array', items: { type: 'string' }, description: 'forward: LPORT:HOST:RPORT' },
        },
        required: ['action'],
      },
    })
    showStatus($, await getSession($), await loadConfig($))
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    const s = await getSession($)
    if (s) await $.process.run(sshArgv(s.endpoint, undefined, ['-O', 'exit']), { timeoutMs: 5_000 }).catch(() => undefined)
    return next(e)
  })

  on('command.run', { command: 'ssh' }, async ($, e) => {
    try {
      return { text: await runCommand($, e.args) }
    } catch (err) {
      return { text: `ssh-remote: ${err instanceof Error ? err.message : String(err)}` }
    }
  })

  on('tool.call', { tool: 'mcp__ssh-remote__remote' }, async ($, e) => {
    const input = e as unknown as { action: string; target?: string; path?: string; text?: string; specs?: string[] }
    try {
      const actions: Record<string, () => Promise<string>> = {
        status: () => status($),
        connect: () => (input.target ? connect($, parseTarget(input.target)) : runCommand($, '')),
        cd: () => changeDir($, input.path ?? '~'),
        off: () => disconnect($),
        note: () => setNote($, input.text ?? ''),
        memory: () => memory($, input.text),
        forward: () => forward($, input.specs ?? []),
        unforward: () => unforward($),
        on: () => runCommand($, 'on'),
      }
      const text = (await actions[input.action]?.()) ?? `Unknown action ${input.action}`
      return { result: text }
    } catch (err) {
      return failed(err)
    }
  })

  // Bash: rewrite into an ssh call so the engine's own timeout, background runs and output handling apply.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const s = await getSession($)
    if (!s?.routing) return next(e)
    const track = !e.run_in_background && mayChangeDir(e.command)
    const command = shellLine(sshArgv(s.endpoint, remoteBashScript(s.cwd, e.command, track ? s.cwdFile : undefined)))
    wrapped.add(command)
    try {
      const ran = await next({ ...e, command })
      if (!track) return ran
      const r = await ssh($, s.endpoint, `f=${s.cwdFile}; [ -f "$f" ] && cat "$f" && rm -f "$f"`, undefined, 15_000).catch(() => undefined)
      const cwd = r?.exitCode === 0 ? r.stdout.trim() : ''
      if (!cwd || cwd === s.cwd) return ran
      await setSession($, { ...s, cwd })
      if (ran.deny !== undefined || ran.isError) return ran
      return { ...ran, context: [...(ran.context ?? []), `Remote cwd is now ${cwd}.`] }
    } finally {
      wrapped.delete(command)
    }
  }).catch(guard)

  // Auto-approve exactly the ssh commands this module produced, as pi does.
  on('tool.check', { tool: 'Bash' }, async ($, e, next) => {
    const command = (e.input as { command?: string } | undefined)?.command
    return command && wrapped.has(command) ? { decision: 'allow' as const } : next(e)
  })

  on('tool.call', { tool: 'Read' }, async ($, e, next) => {
    const s = await getSession($)
    if (!s?.routing) return next(e)
    try {
      return { result: await remoteRead($, s, e.file_path, e.offset, e.limit) }
    } catch (err) {
      return failed(err)
    }
  }).catch(guard)

  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    const s = await getSession($)
    if (!s?.routing) return next(e)
    try {
      const path = resolveRemotePath(s.cwd, e.file_path, s.home)
      const original = await readWhole($, s, path)
      await writeWhole($, s, path, e.content)
      return {
        result: {
          type: original === undefined ? ('create' as const) : ('update' as const),
          filePath: path,
          content: e.content,
          structuredPatch: original === undefined ? [] : diffHunks(original, e.content),
          originalFile: original ?? null,
        },
      }
    } catch (err) {
      return failed(err)
    }
  }).catch(guard)

  on('tool.call', { tool: 'Edit' }, async ($, e, next) => {
    const s = await getSession($)
    if (!s?.routing) return next(e)
    try {
      const path = resolveRemotePath(s.cwd, e.file_path, s.home)
      const original = await readWhole($, s, path)
      if (original === undefined && e.old_string !== '') throw new Error(`File does not exist: ${path}`)
      const updated = applyEdit(original ?? '', e.old_string, e.new_string, e.replace_all ?? false)
      await writeWhole($, s, path, updated)
      return {
        result: {
          filePath: path,
          oldString: e.old_string,
          newString: e.new_string,
          originalFile: original ?? '',
          structuredPatch: diffHunks(original ?? '', updated),
          userModified: false,
          replaceAll: e.replace_all ?? false,
        },
      }
    } catch (err) {
      return failed(err)
    }
  }).catch(guard)

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    const s = await getSession($)
    if (!s?.routing) return composed
    const config = await loadConfig($)
    const mem = config.memories[memoryKey(s.endpoint)]
    const text = [
      '# SSH remote workspace (ssh-remote plugin)',
      `You are connected to the remote server ${label(s, config)}.`,
      'The Bash, Read, Write and Edit tools execute ON THAT SERVER, not on the local machine:',
      '- Relative paths and Bash commands resolve against the remote cwd, which tool results and `/ssh status` report; `cd` in Bash persists.',
      '- Do not wrap commands in `ssh` yourself. Local paths from the environment section above do not apply remotely.',
      '- Foreground Bash calls keep their usual timeout; start long jobs with nohup/setsid and redirect output to a log file.',
      '- Use the `mcp__ssh-remote__remote` tool for status, cd, note, memory and port forwarding.',
      mem && `\n## Server memory for ${memoryKey(s.endpoint)} (set by the user, trusted)\n${mem}`,
    ].filter(Boolean).join('\n')
    return { sections: [...composed.sections, { id: 'ssh-remote:workspace', text, scope: 'session' as const }] }
  })
}
