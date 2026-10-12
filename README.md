# claude-ssh-remote

**Let Claude Code work on a remote server as if it were a local project.**

[中文文档](README.zh-CN.md)

`ssh-remote` is a Claude Code plugin, ported from [pi-ssh-remote](https://github.com/petrichor20211/pi-ssh-remote). After you connect, Claude's own `Bash`, `Read`, `Write` and `Edit` tools run on the server. Claude never has to build `ssh user@host "cd ... && ..."` command lines or copy code to your machine first.

```text
/ssh root@gpu-box -p 2202
/ssh cd /srv/training
Find out why the last training run failed, fix it, and restart it in the background.
```

## Install

```text
/plugin install ssh-remote --marketplace petrichor20211/claude-ssh-remote
```

Answer `y` to add the marketplace, then choose a scope.

Requirements:

- Locally: OpenSSH, and key-based login to the server (`ssh-copy-id -p PORT user@host`).
- On the server: `bash`, `awk` and coreutils (`stat`, `base64`).

## Usage

| Command | What it does |
|---|---|
| `/ssh [user@]host [-p PORT] [-l USER] [-i KEY]` | Connect, save the server, and route the tools to it |
| `/ssh` | Pick a saved server (active first), or type `user@host -p PORT` under Other |
| `/ssh use USER@HOST:PORT` | Switch to a saved server |
| `/ssh status` · `/ssh config` | Show the current connection · list saved servers |
| `/ssh cd PATH` | Change the remote working directory (saved as that server's default) |
| `/ssh exec COMMAND` | Run one command remotely and show its output |
| `/ssh note TEXT` · `/ssh note --clear` | Set or clear the server's label (shown in the status line) |
| `/ssh memory` · `/ssh memory TEXT` · `/ssh memory --clear` | Read, append to, or clear the server memory |
| `/ssh forward [LPORT:HOST:RPORT ...]` | Start port forwards (or the saved ones); tools go back to local |
| `/ssh unforward` | Stop the forwards |
| `/ssh on` | Route the tools to the server again after `forward` |
| `/ssh reload` · `/ssh off` | Reconnect · disconnect and return to local |

Claude can do the same things with the `remote` tool (`mcp__ssh-remote__remote`), so plain language works too: "connect to root@10.0.0.21 -p 30470 and go to /srv/app".

## How it works

- **Bash**: the command is rewritten into an `ssh` call and then run by the built-in Bash tool, so its timeout, background runs and large-output handling keep working. A `cd` inside a command carries over to later commands.
- **Read / Write / Edit**: the plugin answers these itself over SSH, returning the tools' native results (diffs and line numbers included). Images can be read; PDFs and notebooks cannot.
- **Connection**: every call shares one OpenSSH ControlMaster socket (`~/.ssh/cc-remote-%C`), so each call is fast. If the connection drops, the next call opens a new one.
- **Context**: while you are connected, a system-prompt section tells Claude which server it is working on, along with that server's memory. The status line shows `⇄ server:cwd`.
- **No approval prompts**, as in pi: the SSH commands the plugin builds are allowed automatically. Anything else you run locally still goes through your normal permission rules.

## Where state is kept

Saved servers, notes, default directories, forwards and memories live in the plugin's Claude Code store. Server memory is keyed by `user@host`, so different ports on the same host share one memory. Passwords and keys are never stored; only the path given to `-i` is saved.

## Security

- On first connect, the server's host key is accepted automatically (`StrictHostKeyChecking=accept-new`). If the key changes later, the connection is refused.
- While you are connected, Claude can run any command on the server without asking. Only connect to servers where that is acceptable.

## Limitations

- Key authentication only: no password prompt, no ProxyJump, and no `~/.ssh/config` aliases.
- Connections are not restored on `/resume`.
- NotebookEdit still runs locally.

## Development

See [CLAUDE.md](CLAUDE.md). Releases are listed in [CHANGELOG.md](CHANGELOG.md).

MIT License.
