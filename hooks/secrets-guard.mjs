#!/usr/bin/env node
// PreToolUse hook: block writing literal API keys / secrets into source code files.
// Does NOT block writing to .env files (those are the correct place for secrets).
// Blocks: known key prefixes embedded in TS/JS/PY/etc. source files.
// Exit 2 = blocked. Exit 0 = allow.
import { createInterface } from 'readline';

// Known API key patterns found in source files (not .env)
const KEY_PATTERNS = [
  /sk-ant-[a-zA-Z0-9\-_]{90,}/,         // Anthropic
  /sk-[a-zA-Z0-9]{48}/,                  // OpenAI
  /AKIA[0-9A-Z]{16}/,                    // AWS access key ID
  /ghp_[a-zA-Z0-9]{36}/,                 // GitHub PAT
  /ghs_[a-zA-Z0-9]{36}/,                 // GitHub Actions token
  /glpat-[a-zA-Z0-9_\-]{20}/,            // GitLab PAT
  /xoxb-[0-9]+-[0-9]+-[a-zA-Z0-9]+/,    // Slack bot token
  /xoxp-[0-9]+-[0-9]+-[0-9]+-[a-zA-Z0-9]+/, // Slack user token
  /AIza[0-9A-Za-z\-_]{35}/,              // Google API key
];

// Only flag these file extensions (source code, not config/env)
const SOURCE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|cs|rb|php|swift|kt|vue|svelte)$/i;

// Tools that write file content
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit']);

let raw = '';
const rl = createInterface({ input: process.stdin });
rl.on('line', line => (raw += line));
rl.on('close', () => {
  let data;
  try { data = JSON.parse(raw || '{}'); } catch { process.exit(0); }

  const tool = data.tool_name || '';
  const input = data.tool_input || {};

  if (!WRITE_TOOLS.has(tool)) process.exit(0);

  const filePath = input.file_path || input.path || '';
  if (!SOURCE_EXT.test(filePath)) process.exit(0);

  // Collect the content being written
  const content = [input.content, input.new_string].filter(Boolean).join('\n');
  if (!content) process.exit(0);

  const hit = KEY_PATTERNS.find(p => p.test(content));
  if (!hit) process.exit(0);

  // Block
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      additionalContext:
        `BLOCKED: Detected what looks like a live API key being written into ${filePath}. ` +
        `Hard rule: no secrets in source code. Move it to a .env file and read via process.env. ` +
        `If this is a placeholder/example (not a real key), confirm and I will proceed.`,
    },
  }));
  process.exit(2);
});
