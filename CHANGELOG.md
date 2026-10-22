# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- Jump hosts: `/ssh -J user@jump[:port][,...] -p PORT user@host` connects through `ssh -J`. The jump is part of the saved server key (`JUMP>user@host:port`), so `/ssh use` and the picker reconnect through it.
- Password login: when a server refuses key auth and offers a password, `/ssh` asks for it in a dialog (up to three tries) and logs in through `SSH_ASKPASS`. The password is kept in process memory only and reopens a dropped connection.
- Global memory: `/ssh memory --global [TEXT|--clear]` (or the `remote` tool's `memory` action with `global: true`) keeps memory that applies on every server. It joins the system prompt alongside the server memory and shows in `/ssh status`.

### Changed

- Bare `/ssh` now opens a picker, like pi's `/remote` prompt: choose one of up to three saved servers (the active one first), or type `user@host -p PORT` under Other. The `remote` tool's `connect` action without a target still reconnects the active server.
- `/ssh HOST` connects directly, including ssh config aliases like `/ssh train8`; the `ssh` word is no longer needed (`/ssh ssh HOST` still works).

### Fixed

- None

## [0.1.0] - 2026-10-12

### Added

- `/ssh` command: connect, switch servers, `cd`, `exec`, notes, server memory, port forwarding, `on`, `off`, `reload`, `status` and `config`.
- Routes Bash, Read, Write and Edit to the connected server. Bash is rewritten into an SSH call; Read, Write and Edit are answered over SSH and return the native result shapes.
- A shared OpenSSH ControlMaster connection that reconnects on the next call.
- Remote cwd tracking across Bash calls that change directory.
- A system-prompt section naming the server and its `user@host` memory, and a status-line entry.
- A `remote` tool (`mcp__ssh-remote__remote`) for managing the workspace in natural language.
- SSH commands built by the plugin are approved automatically, so remote work runs without approval prompts.

### Changed

- None

### Fixed

- None

[Unreleased]: https://github.com/petrichor20211/claude-ssh-remote/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/petrichor20211/claude-ssh-remote/releases/tag/v0.1.0
