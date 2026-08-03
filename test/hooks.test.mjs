// Run: node --test test/
// No framework, no fixtures directory — each case builds its own stdin payload
// and asserts on the hook's exit code and stdout.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOKS = join(dirname(fileURLToPath(import.meta.url)), '..', 'hooks');

function run(hook, payload) {
  const r = spawnSync(process.execPath, [join(HOOKS, hook)], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
  });
  return { code: r.status, stdout: r.stdout ?? '' };
}

function withTranscript(entries, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'hooktest-'));
  const path = join(dir, 'transcript.jsonl');
  writeFileSync(path, entries.map((e) => JSON.stringify(e)).join('\n'));
  try {
    return fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const assistantWithTool = (name, input) => ({
  type: 'assistant',
  message: { content: [{ type: 'tool_use', name, input }] },
});

// ---------------------------------------------------------------- secrets-guard

test('secrets-guard blocks a live-looking key written into source', () => {
  const { code, stdout } = run('secrets-guard.mjs', {
    tool_name: 'Write',
    tool_input: {
      file_path: '/project/src/client.ts',
      content: `const key = "AKIA${'A1B2C3D4E5F6G7H8'}";`,
    },
  });
  assert.equal(code, 2, 'should block with exit 2');
  assert.match(stdout, /BLOCKED/);
});

test('secrets-guard allows secrets in .env files', () => {
  const { code } = run('secrets-guard.mjs', {
    tool_name: 'Write',
    tool_input: {
      file_path: '/project/.env',
      content: `AWS_KEY=AKIA${'A1B2C3D4E5F6G7H8'}`,
    },
  });
  assert.equal(code, 0, '.env is the correct place for secrets');
});

test('secrets-guard ignores non-write tools', () => {
  const { code } = run('secrets-guard.mjs', {
    tool_name: 'Bash',
    tool_input: { command: `echo AKIA${'A1B2C3D4E5F6G7H8'}` },
  });
  assert.equal(code, 0);
});

test('secrets-guard allows clean source', () => {
  const { code } = run('secrets-guard.mjs', {
    tool_name: 'Edit',
    tool_input: {
      file_path: '/project/src/client.ts',
      new_string: 'const key = process.env.AWS_KEY;',
    },
  });
  assert.equal(code, 0);
});

test('secrets-guard exits cleanly on malformed stdin', () => {
  const r = spawnSync(process.execPath, [join(HOOKS, 'secrets-guard.mjs')], {
    input: 'not json',
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, 'must never break the tool call on bad input');
});

// ----------------------------------------------------------- verify-before-stop

test('verify-before-stop fires after a settings.json edit', () => {
  withTranscript([assistantWithTool('Edit', { file_path: '/home/u/.claude/settings.json' })], (p) => {
    const { code, stdout } = run('verify-before-stop.mjs', { transcript_path: p });
    assert.equal(code, 0);
    assert.match(stdout, /VERIFICATION REQUIRED/);
  });
});

test('verify-before-stop fires after a global CLI install', () => {
  withTranscript([assistantWithTool('Bash', { command: 'npm install -g some-cli' })], (p) => {
    const { stdout } = run('verify-before-stop.mjs', { transcript_path: p });
    assert.match(stdout, /VERIFICATION REQUIRED/);
  });
});

test('verify-before-stop stays quiet for ordinary edits', () => {
  withTranscript([assistantWithTool('Edit', { file_path: '/project/src/index.ts' })], (p) => {
    const { stdout } = run('verify-before-stop.mjs', { transcript_path: p });
    assert.equal(stdout.trim(), '', 'no reminder for unrelated work');
  });
});

test('verify-before-stop does not re-fire when already handling a stop', () => {
  withTranscript([assistantWithTool('Edit', { file_path: '/home/u/.claude/settings.json' })], (p) => {
    const { stdout } = run('verify-before-stop.mjs', { transcript_path: p, stop_hook_active: true });
    assert.equal(stdout.trim(), '', 'must not loop');
  });
});

test('verify-before-stop fails closed when the transcript is unreadable', () => {
  const { stdout } = run('verify-before-stop.mjs', { transcript_path: '/nonexistent/transcript.jsonl' });
  assert.match(stdout, /VERIFICATION REQUIRED/, 'unreadable transcript should remind, not skip');
});

// ------------------------------------------------------------------ context-nudge

test('context-nudge warns once usage crosses the threshold', () => {
  withTranscript(
    [{ type: 'assistant', message: { usage: { input_tokens: 150000 } } }],
    (p) => {
      const { stdout } = run('context-nudge.mjs', { transcript_path: p });
      assert.match(stdout, /compact/i);
      assert.match(stdout, /75%/);
    }
  );
});

test('context-nudge sums cache tokens into the total', () => {
  withTranscript(
    [{
      type: 'assistant',
      message: { usage: { input_tokens: 10000, cache_read_input_tokens: 130000, cache_creation_input_tokens: 20000 } },
    }],
    (p) => {
      const { stdout } = run('context-nudge.mjs', { transcript_path: p });
      assert.match(stdout, /80%/, 'cached tokens occupy the window too');
    }
  );
});

test('context-nudge stays silent below the threshold', () => {
  withTranscript([{ type: 'assistant', message: { usage: { input_tokens: 20000 } } }], (p) => {
    const { stdout } = run('context-nudge.mjs', { transcript_path: p });
    assert.equal(stdout.trim(), '');
  });
});
