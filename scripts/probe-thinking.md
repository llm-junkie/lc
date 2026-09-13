# `probe-thinking.mjs`

Probe an LLM endpoint to identify the **thinking / reasoning** parameters that
it honors or silently ignores. The probe supports local LM Studio and the
OpenAI, DeepSeek, and Anthropic cloud APIs.

## Quick start

```bash
# Local LM Studio (auto-detects first loaded model)
node scripts/probe-thinking.mjs

# Specific model on local LM Studio
node scripts/probe-thinking.mjs --host http://192.168.31.7:1234 --model qwen/qwen3.6-35b-a3b

# Only test Anthropic-compat endpoint
node scripts/probe-thinking.mjs --api anthropic
```

## Cloud APIs (with API key)

```bash
# DeepSeek
node scripts/probe-thinking.mjs --host https://api.deepseek.com --model deepseek-v4-pro --key $env:DEEPSEEK_API_KEY --api openai

# OpenAI
node scripts/probe-thinking.mjs --host https://api.openai.com --model gpt-4o --key $env:OPENAI_API_KEY --api openai

# Anthropic
node scripts/probe-thinking.mjs --host https://api.anthropic.com --model claude-sonnet-4-6 --key $env:ANTHROPIC_API_KEY --api anthropic
```

If you omit `--key`, the probe reads these environment variables in order:
`DEEPSEEK_API_KEY` → `OPENAI_API_KEY` → `ANTHROPIC_API_KEY`.

## Flags

| Flag | Default | Description |
|---|---|---|
| `--host URL` | `http://192.168.31.7:1234` | API base URL |
| `--model ID` | auto-detect (local) | Model ID (required for cloud) |
| `--key KEY` | from env vars | API key |
| `--api` | `both` | `openai`, `anthropic`, or `both` |

## What it tests

### OpenAI-compat (`/v1/chat/completions`)
- Baseline (no params)
- `thinking: { type: "disabled" }`
- `reasoning_effort`: `none`, `low`, `medium`, `high`, `xhigh`, `max`

### Anthropic-compat (`/v1/messages`)
- Baseline (no params)
- `thinking`: `disabled`, `enabled` (with budget), `adaptive`
- `output_config.effort`: `low`, `medium`, `high`, `xhigh`, `max`

## Interpreting output

Each test shows:
- ✅ / ❌ = HTTP success / error
- 🧠 / 💬 = model produced reasoning/thinking or just text
- The summary shows which parameters **changed behavior** from the baseline

## Example output

```
🔍 Probing http://192.168.31.7:1234 ...
📦 Model: qwen/qwen3.6-35b-a3b

=== OpenAI-compat (/v1/chat/completions) ===
  ✅ 🧠 baseline (no params)           → reasoning_content + ""
  ✅ 🧠 thinking disabled            → reasoning_content + ""
  ✅ 💬 reasoning_effort: none       → "Hi"
  ❌ 💬 reasoning_effort: max        → HTTP 400: Invalid value

OpenAI-compat baseline: 🧠 model reasons by default
  ✅ Params that CHANGED behavior:
     - reasoning_effort: none

=== Anthropic-compat (/v1/messages) ===
  ✅ 💬 baseline (no params)           → 1 text block(s), no thinking
  ✅ 💬 thinking disabled            → 1 text block(s), no thinking
  ✅ 🧠 thinking enabled (budget)    → 1 think + 0 text blocks

Anthropic-compat baseline: 💬 model does NOT think by default
  ✅ Params that CHANGED behavior:
     - thinking enabled (budget)
```
