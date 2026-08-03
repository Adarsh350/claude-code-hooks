import { createInterface } from 'readline';
import { readFileSync, statSync, openSync, readSync, closeSync } from 'fs';

const REMINDER =
  'VERIFICATION REQUIRED before stopping: this session changed MCP config, hooks/settings, or installed a CLI. ' +
  'Run a real test invocation NOW to confirm it works. Do not claim success without proof.';

// Paths whose modification means "hook/settings/MCP change"
const PATH_SIGNAL =
  /(settings\.json|\.mcp\.json|[\\/]hooks[\\/]|[\\/]\.claude[\\/]scripts[\\/]|claude_desktop_config\.json)/i;

// Shell commands that mean "CLI install" or "MCP setup"
const CMD_SIGNAL =
  /(npm\s+(i|install)\s+(-g|--global)|claude\s+mcp\s+(add|remove|install)|pip\s+install|uv\s+tool\s+install|winget\s+install|choco\s+install|cargo\s+install|brew\s+install)/i;

const MUTATING_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit']);
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);

// Read at most the last N bytes — transcripts grow unbounded and this runs every turn.
const TAIL_BYTES = 2 * 1024 * 1024;

function readTail(path) {
  const { size } = statSync(path);
  if (size <= TAIL_BYTES) return readFileSync(path, 'utf8');
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(TAIL_BYTES);
    readSync(fd, buf, 0, TAIL_BYTES, size - TAIL_BYTES);
    return buf.toString('utf8');
  } finally {
    closeSync(fd);
  }
}

function toolUsesIn(entry) {
  const content = entry?.message?.content;
  return Array.isArray(content) ? content.filter(c => c?.type === 'tool_use') : [];
}

function isTrigger(use) {
  const { name, input } = use;
  if (!input) return false;
  if (MUTATING_TOOLS.has(name)) return PATH_SIGNAL.test(String(input.file_path ?? ''));
  if (SHELL_TOOLS.has(name)) return CMD_SIGNAL.test(String(input.command ?? ''));
  return false;
}

function sessionNeedsVerification(path) {
  const text = readTail(path);
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // a truncated first line from the tail read, or a malformed record
    }
    if (toolUsesIn(entry).some(isTrigger)) return true;
  }
  return false;
}

function emit() {
  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'Stop',
        additionalContext: REMINDER,
      },
    })
  );
}

let input = '';
const rl = createInterface({ input: process.stdin });
rl.on('line', line => (input += line));
rl.on('close', () => {
  let data;
  try {
    data = JSON.parse(input || '{}');
  } catch {
    process.exit(0);
  }

  // Already responding to a stop hook — allow stop silently.
  if (data.stop_hook_active) process.exit(0);

  const path = data.transcript_path;
  if (!path) process.exit(0);

  try {
    if (sessionNeedsVerification(path)) emit();
  } catch {
    // Can't read the transcript — fail closed and remind, rather than silently
    // skipping a gate on a session that may genuinely need it.
    emit();
  }
});
