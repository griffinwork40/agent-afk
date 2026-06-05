import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { upsertEnvVar } from './commands/login-command.js';

describe('upsertEnvVar', () => {
  let tmpDir: string;
  let envFilePath: string;

  beforeEach(() => {
    // Create a temporary directory for each test
    tmpDir = join(tmpdir(), `afk-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
    envFilePath = join(tmpDir, 'test.env');
  });

  afterEach(() => {
    // Clean up temporary directory
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('writes a new env var to an empty file', () => {
    upsertEnvVar(envFilePath, 'TEST_KEY', 'test_value');
    const contents = readFileSync(envFilePath, 'utf-8');
    expect(contents).toBe('TEST_KEY=test_value\n');
  });

  it('replaces an existing env var', () => {
    writeFileSync(envFilePath, 'TEST_KEY=old_value\n');
    upsertEnvVar(envFilePath, 'TEST_KEY', 'new_value');
    const contents = readFileSync(envFilePath, 'utf-8');
    expect(contents).toBe('TEST_KEY=new_value\n');
  });

  it('preserves other env vars when updating one', () => {
    writeFileSync(envFilePath, 'KEY1=value1\nKEY2=value2\n');
    upsertEnvVar(envFilePath, 'KEY2', 'updated_value2');
    const contents = readFileSync(envFilePath, 'utf-8');
    expect(contents).toBe('KEY1=value1\nKEY2=updated_value2\n');
  });

  it('removes stale conflicting keys when saving API key', () => {
    writeFileSync(envFilePath, 'CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-xxx\nOTHER_KEY=value\n');
    upsertEnvVar(envFilePath, 'ANTHROPIC_API_KEY', 'sk-ant-api03-yyy', ['CLAUDE_CODE_OAUTH_TOKEN']);
    const contents = readFileSync(envFilePath, 'utf-8');
    expect(contents).toBe('OTHER_KEY=value\nANTHROPIC_API_KEY=sk-ant-api03-yyy\n');
  });

  it('removes stale conflicting keys when saving OAuth token', () => {
    writeFileSync(envFilePath, 'ANTHROPIC_API_KEY=sk-ant-api03-yyy\nOTHER_KEY=value\n');
    upsertEnvVar(envFilePath, 'CLAUDE_CODE_OAUTH_TOKEN', 'sk-ant-oat01-xxx', ['ANTHROPIC_API_KEY']);
    const contents = readFileSync(envFilePath, 'utf-8');
    expect(contents).toBe('OTHER_KEY=value\nCLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-xxx\n');
  });

  it('handles removal of keys with no matching entries gracefully', () => {
    writeFileSync(envFilePath, 'EXISTING_KEY=value\n');
    upsertEnvVar(envFilePath, 'NEW_KEY', 'new_value', ['NON_EXISTENT_KEY']);
    const contents = readFileSync(envFilePath, 'utf-8');
    expect(contents).toBe('EXISTING_KEY=value\nNEW_KEY=new_value\n');
  });

  it('removes trailing newline when removing a key at the end', () => {
    writeFileSync(envFilePath, 'KEY1=value1\nKEY2_TO_REMOVE=value2\n');
    upsertEnvVar(envFilePath, 'KEY1', 'updated_value1', ['KEY2_TO_REMOVE']);
    const contents = readFileSync(envFilePath, 'utf-8');
    expect(contents).toBe('KEY1=updated_value1\n');
  });

  it('creates parent directories if they do not exist', () => {
    const nestedPath = join(tmpDir, 'nested', 'dirs', 'test.env');
    upsertEnvVar(nestedPath, 'TEST_KEY', 'test_value');
    const contents = readFileSync(nestedPath, 'utf-8');
    expect(contents).toBe('TEST_KEY=test_value\n');
  });

  it('sets restrictive file permissions (0o600)', () => {
    upsertEnvVar(envFilePath, 'SENSITIVE_KEY', 'sensitive_value');
    const stats = require('fs').statSync(envFilePath);
    // 0o600 = rw------- (owner read/write only)
    expect((stats.mode & 0o777).toString(8)).toBe('600');
  });
});

describe('Token type detection in login flow', () => {
  let tmpDir: string;
  let envFilePath: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `afk-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
    envFilePath = join(tmpDir, 'test.env');
  });

  afterEach(() => {
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('saves sk-ant-api03-* token as ANTHROPIC_API_KEY', () => {
    const token = 'sk-ant-api03-aAbBcCdDeEfFgGhH';
    upsertEnvVar(envFilePath, 'ANTHROPIC_API_KEY', token, ['CLAUDE_CODE_OAUTH_TOKEN']);
    const contents = readFileSync(envFilePath, 'utf-8');
    expect(contents).toContain('ANTHROPIC_API_KEY=sk-ant-api03-aAbBcCdDeEfFgGhH');
    expect(contents).not.toContain('CLAUDE_CODE_OAUTH_TOKEN');
  });

  it('saves sk-ant-oat01-* token as CLAUDE_CODE_OAUTH_TOKEN', () => {
    const token = 'sk-ant-oat01-xXyYzZ123456';
    upsertEnvVar(envFilePath, 'CLAUDE_CODE_OAUTH_TOKEN', token, ['ANTHROPIC_API_KEY']);
    const contents = readFileSync(envFilePath, 'utf-8');
    expect(contents).toContain('CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-xXyYzZ123456');
    expect(contents).not.toContain('ANTHROPIC_API_KEY');
  });

  it('upgrades from API key to OAuth token by removing old key', () => {
    // Start with API key
    writeFileSync(envFilePath, 'ANTHROPIC_API_KEY=sk-ant-api03-old\n');
    // Upgrade to OAuth token
    upsertEnvVar(envFilePath, 'CLAUDE_CODE_OAUTH_TOKEN', 'sk-ant-oat01-new', ['ANTHROPIC_API_KEY']);
    const contents = readFileSync(envFilePath, 'utf-8');
    expect(contents).toBe('CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-new\n');
  });

  it('downgrades from OAuth token to API key by removing old token', () => {
    // Start with OAuth token
    writeFileSync(envFilePath, 'CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-old\n');
    // Downgrade to API key
    upsertEnvVar(envFilePath, 'ANTHROPIC_API_KEY', 'sk-ant-api03-new', ['CLAUDE_CODE_OAUTH_TOKEN']);
    const contents = readFileSync(envFilePath, 'utf-8');
    expect(contents).toBe('ANTHROPIC_API_KEY=sk-ant-api03-new\n');
  });
});
