# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

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
