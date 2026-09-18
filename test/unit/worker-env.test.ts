import { describe, expect, test } from 'bun:test';
import { ClaudeProvider } from '../../src/core/providers/claude.ts';
import { CodexProvider } from '../../src/core/providers/codex.ts';
import { envExports, inheritedEnv } from '../../src/core/worker-env.ts';

// ---------------------------------------------------------------------------
// umbel#93: only what a worker needs travels.
//
// A worker used to receive the caller's whole environment, so every key and
// token in a conductor's shell reached every worker. Now it gets operational
// variables, the ones its own provider reads, and whatever the caller passes
// explicitly. Everything else stays behind.
// ---------------------------------------------------------------------------

const caller = {
  PATH: '/usr/bin',
  HOME: '/home/u',
  LANG: 'en_US.UTF-8',
  LC_ALL: 'en_US.UTF-8',
  XDG_CONFIG_HOME: '/home/u/.config',
  HTTPS_PROXY: 'http://proxy:8080',
  https_proxy: 'http://proxy:8080',
  SSL_CERT_FILE: '/etc/ca.pem',
  SSH_AUTH_SOCK: '/tmp/agent.sock',
  TERM: 'xterm-256color',
  ANTHROPIC_BASE_URL: 'https://api.example.test/anthropic',
  ANTHROPIC_AUTH_TOKEN: 'canary-auth-token',
  OPENAI_API_KEY: 'canary-openai',
  DEEPSEEK_API_KEY: 'canary-deepseek',
  GH_TOKEN: 'canary-gh',
  AWS_SECRET_ACCESS_KEY: 'canary-aws',
  SHELL: '/bin/zsh',
  PROMPT_COMMAND: 'echo x',
};

describe('inheritedEnv', () => {
  const forClaude = inheritedEnv(caller, ClaudeProvider.inheritEnvPrefixes ?? []);

  test('keeps what any worker needs to run', () => {
    for (const k of [
      'PATH',
      'HOME',
      'LANG',
      'LC_ALL',
      'XDG_CONFIG_HOME',
      'HTTPS_PROXY',
      'https_proxy',
      'SSL_CERT_FILE',
      'SSH_AUTH_SOCK',
    ]) {
      expect(forClaude[k]).toBe(caller[k as keyof typeof caller]);
    }
  });

  test("keeps the worker's own provider configuration", () => {
    // The documented custom-endpoint recipe exports these and relies on them
    // reaching the worker.
    expect(forClaude.ANTHROPIC_BASE_URL).toBe(caller.ANTHROPIC_BASE_URL);
    expect(forClaude.ANTHROPIC_AUTH_TOKEN).toBe(caller.ANTHROPIC_AUTH_TOKEN);
  });

  test("withholds every other secret in the caller's environment", () => {
    for (const k of ['OPENAI_API_KEY', 'DEEPSEEK_API_KEY', 'GH_TOKEN', 'AWS_SECRET_ACCESS_KEY']) {
      expect(forClaude[k]).toBeUndefined();
    }
  });

  test("a provider receives its own keys and not another's", () => {
    const forCodex = inheritedEnv(caller, CodexProvider.inheritEnvPrefixes ?? []);
    expect(forCodex.OPENAI_API_KEY).toBe(caller.OPENAI_API_KEY);
    expect(forCodex.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  });

  test('withholds the shell-init variables that race the first keystroke', () => {
    expect(forClaude.SHELL).toBeUndefined();
    expect(forClaude.PROMPT_COMMAND).toBeUndefined();
  });

  test("leaves the terminal's description to the pane tmux creates", () => {
    // Inside tmux, TERM must describe tmux, not the caller's terminal.
    expect(forClaude.TERM).toBeUndefined();
  });

  test('skips unset values', () => {
    expect(inheritedEnv({ PATH: undefined }, [])).toEqual({});
  });
});

describe('envExports', () => {
  test('writes one single-quoted export per variable', () => {
    expect(envExports({ A: 'one', B: 'two words' })).toBe("export A='one'\nexport B='two words'\n");
  });

  test('escapes a single quote inside a value', () => {
    expect(envExports({ A: "it's" })).toBe("export A='it'\\''s'\n");
  });

  test('skips a name no shell can export', () => {
    // A shell cannot hold such a variable, so writing it would only break the
    // exports after it.
    expect(envExports({ 'not-an-identifier': 'x', OK_1: 'y' })).toBe("export OK_1='y'\n");
  });
});
