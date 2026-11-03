# claude-ssh-remote

**让 Claude Code 像操作本地项目一样操作远程服务器。**

[English Docs](README.md)

`ssh-remote` 是一个 Claude Code 插件，由 [pi-ssh-remote](https://github.com/petrichor20211/pi-ssh-remote) 移植而来。连接服务器后，Claude 自带的 `Bash`、`Read`、`Write`、`Edit` 工具会直接在远端执行。Claude 不用反复拼 `ssh user@host "cd ... && ..."` 这样的命令，也不用先把代码下载到本地。

```text
/ssh root@gpu-box -p 2202
/ssh cd /srv/training
检查最近一次训练为什么失败，修复后在后台重新启动。
```

## 安装

```text
/plugin install ssh-remote --marketplace petrichor20211/claude-ssh-remote
```

提示添加 marketplace 时输入 `y`，然后选择安装范围。

环境要求：

- 本地：需要 OpenSSH。推荐密钥登录（`ssh-copy-id -p PORT user@host`），也支持密码登录。
- 远端：需要 `bash`、`awk` 和 coreutils（`stat`、`base64`）。

## 命令

| 命令 | 作用 |
|---|---|
| `/ssh [user@]host [-p PORT] [-l USER] [-i KEY] [-J JUMP]` | 连接并保存服务器，之后工具都在远端执行（`-J` 经跳板机连接，同 `ssh -J`） |
| `/ssh` | 弹出选择框：选已保存的服务器（当前的排第一），或在 Other 里输入 `user@host -p PORT` |
| `/ssh use USER@HOST:PORT` | 切换到已保存的服务器 |
| `/ssh status` · `/ssh config` | 查看当前连接 · 列出已保存的服务器 |
| `/ssh cd PATH` | 切换远程目录，并保存为这台服务器的默认目录 |
| `/ssh exec COMMAND` | 在远端执行一次命令并显示输出 |
| `/ssh note TEXT` · `/ssh note --clear` | 设置或清除服务器备注（显示在输入框下方） |
| `/ssh memory` · `/ssh memory TEXT` · `/ssh memory --clear` | 查看、追加或清除记忆（global 模式下是共享记忆，server 模式下是当前服务器的记忆） |
| `/ssh memory --global [TEXT\|--clear]` | 同上，作用于对所有服务器生效的全局记忆 |
| `/ssh memory --mode [global\|server]` | 查看或切换记忆模式：`global`（默认）所有服务器共享一份记忆，`server` 每台服务器各一份 |
| `/ssh forward [LPORT:HOST:RPORT ...]` | 启动端口转发（不带参数时用已保存的配置），工具切回本地 |
| `/ssh unforward` | 停止端口转发 |
| `/ssh on` | 端口转发后，让工具重新在远端执行 |
| `/ssh reload` · `/ssh off` | 重新连接 · 断开连接并回到本地 |

Claude 也可以通过 `remote` 工具（`mcp__ssh-remote__remote`）完成上面这些操作，所以直接用自然语言说也行，比如“连接 root@10.0.0.21 -p 30470，进入 /srv/app”。

## 实现方式

- **Bash**：命令会被改写成一条 `ssh` 调用，再交给内置的 Bash 工具执行，所以超时、后台运行和大输出处理都照常可用。命令里的 `cd` 会保留到后续命令。
- **Read / Write / Edit**：由插件自己通过 SSH 完成，返回和原生工具相同格式的结果，包括 diff 和行号。支持读取图片，不支持 PDF 和 notebook。
- **连接**：所有调用共用一个 OpenSSH ControlMaster 连接（`~/.ssh/cc-remote-%C`），每次调用都很快。连接断开后，下一次调用会自动重新建立连接。
- **上下文**：连接期间，系统提示里会告诉 Claude 当前操作的是哪台服务器，以及全局记忆（server 记忆模式下还有这台服务器的记忆）。输入框下方的模式标签会显示 `服务器:目录`。
- **默认不弹批准**，和 pi 一样：插件自己生成的 ssh 命令会自动放行。你在本地执行的其他命令仍按原来的权限规则处理。

## 配置保存在哪里

已保存的服务器、备注、默认目录、端口转发和服务器记忆都存在插件的 Claude Code store 里。服务器记忆按 `user@host` 保存，同一台主机的不同端口共用一份。插件不保存密码和私钥，只保存 `-i` 指定的密钥路径。服务器拒绝密钥、允许密码时，`/ssh` 会弹出对话框让你输入密码（在 Other 里输入，输入内容不会被遮挡）。密码只保留在当前 Claude Code 进程内存里，用于连接断开后自动重连。

## 安全

- 首次连接时会自动接受服务器的主机密钥（`StrictHostKeyChecking=accept-new`）。之后如果主机密钥发生变化，连接会被拒绝。
- 连接期间，Claude 可以不经确认在服务器上执行任何命令。请只连接你能接受这一点的服务器。

## 当前限制

- 不读取 `~/.ssh/config` 里的别名（跳板机请用 `-J`）。密码对话框会明文显示输入的密码。
- `/resume` 时不会恢复服务器连接。
- NotebookEdit 仍在本地执行。

## 开发

见 [CLAUDE.md](CLAUDE.md)。版本记录见 [CHANGELOG.md](CHANGELOG.md)。

MIT License。
