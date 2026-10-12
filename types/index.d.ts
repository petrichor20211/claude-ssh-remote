export type RemoteEndpoint = { user: string; host: string; port: number; identity?: string }

export type RemoteSession = {
  key: string
  endpoint: RemoteEndpoint
  cwd: string
  home: string
  /** True: Bash/Read/Write/Edit run remotely. False: tunnel only, tools stay local. */
  routing: boolean
  forwards: string[]
  cwdFile: string
}

declare module 'claude-code' {
  interface PluginState {
    'ssh-remote': { session: RemoteSession | null }
  }
}
