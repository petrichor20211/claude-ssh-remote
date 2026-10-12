// Pure helpers for ssh-remote: parsing, quoting, ssh argv, diffs. No `$` here.

export type Endpoint = { user: string; host: string; port: number; identity?: string }

export type EndpointConfig = {
  identity?: string
  cwd?: string
  note?: string
  forwards?: string[]
}

export type RemoteConfig = {
  active?: string
  endpoints: Record<string, EndpointConfig>
  memories: Record<string, string>
}

export type Hunk = {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: string[]
}

/** Splits a command line into words, honouring single and double quotes. */
export function shellWords(input: string): string[] {
  const words: string[] = []
  let word = ''
  let quote: '"' | "'" | undefined
  let isWord = false
  for (let i = 0; i < input.length; i++) {
    const c = input[i] ?? ''
    if (quote) {
      if (c === quote) quote = undefined
      else if (c === '\\' && quote === '"' && i + 1 < input.length) word += input[++i]
      else word += c
    } else if (c === '"' || c === "'") {
      quote = c
      isWord = true
    } else if (c === '\\' && i + 1 < input.length) {
      word += input[++i]
      isWord = true
    } else if (/\s/.test(c)) {
      if (isWord) words.push(word)
      word = ''
      isWord = false
    } else {
      word += c
      isWord = true
    }
  }
  if (quote) throw new Error('unterminated quote')
  if (isWord) words.push(word)
  return words
}

/** Parses `[ssh] [user@]host [-p PORT] [-l USER] [-i KEY]`. */
export function parseTarget(input: string): Endpoint {
  const words = shellWords(input.trim())
  if (words[0] === 'ssh') words.shift()
  let user: string | undefined
  let port = 22
  let identity: string | undefined
  let target: string | undefined
  for (let i = 0; i < words.length; i++) {
    const w = words[i] ?? ''
    const value = () => {
      const v = words[++i]
      if (v === undefined) throw new Error(`${w} needs a value`)
      return v
    }
    if (w === '-p') port = Number(value())
    else if (w.startsWith('-p') && w.length > 2) port = Number(w.slice(2))
    else if (w === '-l') user = value()
    else if (w === '-i') identity = value()
    else if (w.startsWith('-')) throw new Error(`unsupported option ${w} (only -p, -l, -i)`)
    else if (target) throw new Error(`unexpected argument ${w}`)
    else target = w
  }
  if (!target) throw new Error('missing [user@]host')
  const at = target.lastIndexOf('@')
  if (at >= 0) {
    user = target.slice(0, at)
    target = target.slice(at + 1)
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid port')
  if (identity && !identity.startsWith('/') && !identity.startsWith('~/')) {
    throw new Error('-i path must be absolute or start with ~/')
  }
  return { user: user || 'root', host: target, port, identity }
}

export function endpointKey(ep: Endpoint): string {
  return `${ep.user}@${ep.host}:${ep.port}`
}

/** Server memory is shared across ports of the same user@host. */
export function memoryKey(ep: Endpoint): string {
  return `${ep.user}@${ep.host}`
}

export function parseEndpointKey(key: string): Endpoint | undefined {
  const m = /^(.+)@([^@:]+):(\d+)$/.exec(key)
  return m ? { user: m[1] ?? '', host: m[2] ?? '', port: Number(m[3]) } : undefined
}

/** POSIX single-quote. */
export function q(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** The ssh argv that runs `script` with bash on the remote host over a shared master. */
export function sshArgv(ep: Endpoint, script?: string, extra: string[] = []): string[] {
  const argv = [
    'ssh',
    '-p', String(ep.port),
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=10',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=4',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ControlMaster=auto',
    '-o', 'ControlPath=~/.ssh/cc-remote-%C',
    '-o', 'ControlPersist=yes',
  ]
  if (ep.identity) argv.push('-i', ep.identity, '-o', 'IdentitiesOnly=yes')
  argv.push(...extra, `${ep.user}@${ep.host}`)
  if (script !== undefined) argv.push(`bash -lc ${q(script)}`)
  return argv
}

/** Joins an argv into a line a local POSIX shell runs as that argv. */
export function shellLine(argv: readonly string[]): string {
  return argv.map(a => (/^[\w@%+=:,./-]+$/.test(a) ? a : q(a))).join(' ')
}

/** Wraps a Bash tool command so it runs in `cwd`; with `cwdFile`, the final cwd is written there on exit. */
export function remoteBashScript(cwd: string, command: string, cwdFile?: string): string {
  if (cwdFile && !/^[\w./-]+$/.test(cwdFile)) throw new Error('unsafe cwd file path')
  const trap = cwdFile ? `trap 'printf %s "$PWD" > ${cwdFile}' EXIT\n` : ''
  return `${trap}cd ${q(cwd)} || exit 1\n${command}`
}

/** True when a command may change directory, so its final cwd is worth reading back. */
export function mayChangeDir(command: string): boolean {
  return /(^|[\s;&|(])(cd|pushd|popd)(\s|$|;)/.test(command)
}

/** Resolves `path` against the remote cwd (no `~` expansion beyond a leading `~/`). */
export function resolveRemotePath(cwd: string, path: string, home?: string): string {
  if (path === '~' && home) return home
  if (path.startsWith('~/') && home) return joinPath(home, path.slice(2))
  if (path.startsWith('/')) return normalizePath(path)
  return joinPath(cwd, path)
}

function joinPath(a: string, b: string): string {
  return normalizePath(`${a.replace(/\/+$/, '')}/${b}`)
}

function normalizePath(p: string): string {
  const out: string[] = []
  for (const part of p.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return '/' + out.join('/')
}

/** One hunk spanning the changed middle of two texts, with up to 3 lines of context. */
export function diffHunks(before: string, after: string): Hunk[] {
  if (before === after) return []
  const a = before.split('\n')
  const b = after.split('\n')
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head++
  let tail = 0
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) tail++
  const ctx = 3
  const start = Math.max(0, head - ctx)
  const aEnd = a.length - tail
  const bEnd = b.length - tail
  const aCtxEnd = Math.min(a.length, aEnd + ctx)
  const lines = [
    ...a.slice(start, head).map(l => ' ' + l),
    ...a.slice(head, aEnd).map(l => '-' + l),
    ...b.slice(head, bEnd).map(l => '+' + l),
    ...a.slice(aEnd, aCtxEnd).map(l => ' ' + l),
  ]
  const oldLines = aCtxEnd - start
  const newLines = head - start + (bEnd - head) + (aCtxEnd - aEnd)
  return [{
    oldStart: oldLines === 0 ? start : start + 1,
    oldLines,
    newStart: newLines === 0 ? start : start + 1,
    newLines,
    lines,
  }]
}

/** Applies an Edit tool call to `original`, or throws the error the model should read. */
export function applyEdit(
  original: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
): string {
  if (oldString === newString) throw new Error('old_string and new_string are identical.')
  if (oldString === '') {
    if (original !== '') throw new Error('old_string is empty but the file is not.')
    return newString
  }
  const count = original.split(oldString).length - 1
  if (count === 0) throw new Error(`String to replace not found in file.\nString: ${oldString}`)
  if (count > 1 && !replaceAll) {
    throw new Error(
      `Found ${count} matches of the string to replace, but replace_all is false. ` +
        'Provide more context to make it unique, or set replace_all to true.',
    )
  }
  return replaceAll ? original.split(oldString).join(newString) : original.replace(oldString, () => newString)
}

/** Validates a forward spec `[bind:]LPORT:HOST:RPORT`. */
export function parseForward(spec: string): string {
  const parts = spec.split(':')
  const ports: string[] = parts.length === 4 ? [parts[1] ?? '', parts[3] ?? ''] : parts.length === 3 ? [parts[0] ?? '', parts[2] ?? ''] : []
  if (ports.length === 0 || ports.some(p => !/^\d+$/.test(p) || Number(p) < 1 || Number(p) > 65535)) {
    throw new Error(`invalid forward ${spec} (want LPORT:HOST:RPORT)`)
  }
  return spec
}

export function emptyConfig(): RemoteConfig {
  return { endpoints: {}, memories: {} }
}

const IMAGE_TYPES: Record<string, 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
}

export function imageType(path: string) {
  return IMAGE_TYPES[path.split('.').pop()?.toLowerCase() ?? '']
}
