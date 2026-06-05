# Security Policy

## ⚠️ Important: this tool executes shell commands

Agent AFK **executes shell commands, reads and writes files, and automates a
browser** on behalf of an AI model. It runs with **bypass permissions by
default** and with **your** OS-level access. Treat it like any tool that can run
arbitrary code on your machine: run it on an account you trust, with the model
provider and plugins you trust. Security vulnerabilities in this project can have
serious consequences — please treat disclosures accordingly.

## Reporting a vulnerability

**Do NOT open a public GitHub issue for a security vulnerability.**

Report privately by emailing:

> agentafk@graisol.com

Please include:
- A description of the vulnerability and its potential impact
- Steps to reproduce or a proof-of-concept
- Affected versions (if known)
- Any suggested mitigations

We will make a best effort to acknowledge reports promptly and to communicate
a remediation timeline — but this is a solo-maintained project and we cannot
guarantee specific response times.

## Supported versions

The latest version of `agent-afk` published on npm is the only version that
receives security fixes. Older versions are unsupported.

## Disclosure policy

We follow **coordinated disclosure**. Once a fix is released we will publish a
security advisory. Please give us reasonable time to ship a fix before any
public disclosure.

## Scope / trust model

Agent AFK is a local-first agent runtime. It does not phone home; telemetry is
written to local JSONL files under `~/.afk/`. Particularly sensitive areas:

- Prompt injection leading to unintended shell/file/browser actions
- Credential or token leakage via logs, traces, or IPC
- Authentication bypass in the Telegram bot allowlist
- Plugin / marketplace install path (untrusted git sources)
- MCP server connection handling (SSRF, malicious server responses)
