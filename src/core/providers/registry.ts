import { ProviderUnknownError } from '../errors.ts';
import { ClaudeProvider } from './claude.ts';
import { CodexProvider } from './codex.ts';
import { GeminiProvider } from './gemini.ts';
import type { AgentProvider } from './types.ts';

// ---------------------------------------------------------------------------
// Provider registry
// ---------------------------------------------------------------------------

export const PROVIDERS: Record<string, AgentProvider> = {
  claude: ClaudeProvider,
  codex: CodexProvider,
  gemini: GeminiProvider,
};

export function getProvider(name: string): AgentProvider {
  const provider = PROVIDERS[name];
  if (provider === undefined) {
    throw new ProviderUnknownError(name);
  }
  return provider;
}
