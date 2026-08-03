#!/usr/bin/env node
// Stop hook: at the END of each run, check exact context usage and nudge the
// user to run /compact at this clean boundary if it's high. This is the
// practical stand-in for "compact only at run-end" -- Claude Code has no native
// way to defer auto-compaction to the Stop event, so instead we let the user
// compact between runs (never mid-task) before the ~83% auto-compact safety net
// is ever reached.
//
// Context size is read EXACTLY from the last assistant message's usage object
// in the transcript (the same numbers /context reports), so this is not a
// file-size guess. After a /compact the next assistant usage drops, so it
// self-resets with no compaction-marker parsing needed.
//
// Output: JSON {systemMessage} shown to the user. Exit 0 always -- this hook
// must never block a run from stopping.
import fs from "node:fs";

const THRESHOLD_PCT = 65;          // nudge when context >= this % of the window
const EFFECTIVE_WINDOW = 200000;   // 1M context is disabled -> 200K window

function main() {
  let raw = "";
  try { raw = fs.readFileSync(0, "utf8"); } catch { return; }
  let input;
  try { input = JSON.parse(raw); } catch { return; }

  const tp = input && input.transcript_path;
  if (!tp || !fs.existsSync(tp)) return;

  let lines;
  try { lines = fs.readFileSync(tp, "utf8").trim().split("\n"); } catch { return; }

  let usage = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    let o;
    try { o = JSON.parse(lines[i]); } catch { continue; }
    if (o && o.type === "assistant" && o.message && o.message.usage) {
      usage = o.message.usage;
      break;
    }
  }
  if (!usage) return;

  const ctx = (usage.input_tokens || 0)
            + (usage.cache_creation_input_tokens || 0)
            + (usage.cache_read_input_tokens || 0);
  const pct = Math.round((ctx / EFFECTIVE_WINDOW) * 100);
  if (pct < THRESHOLD_PCT) return;

  const msg =
    `Context ~${pct}% (${ctx.toLocaleString()} / ${EFFECTIVE_WINDOW.toLocaleString()} tokens). ` +
    `Clean run boundary reached -- run /compact now to avoid a mid-task compaction during the next run.`;
  process.stdout.write(JSON.stringify({ systemMessage: msg }));
}

try { main(); } catch { /* never break the Stop flow */ }
