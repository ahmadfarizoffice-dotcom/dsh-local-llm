# Local model

Runs a llama.cpp model on this computer and offers it to the Harness as one
selectable model provider. The left sidebar gains a **Local model** panel whose
**Models** card holds everything in one place: the models already on this
computer, the ones you pull from Hugging Face, and a hand-picked file — one
grid, one select control per card. The local grid pages four models at a time;
the Hugging Face grid pages twenty repositories at a time.

## Install

One command, then wait for two downloads:

```
plugin_manager  action: install_bundle  target: github:<your-name>/<your-repo>
```

On first activation the plugin installs the llama.cpp runtime (~25 MB) and the
model named by `autoModel` (by default `LFM3-1.7B-Q4_K_M`, ~1.1 GB), then starts
the server. Progress appears in the panel's download banner and in the server
log; nothing else needs pressing. Requirements: DeepSeek Harness
**0.2.2-rc.3 or newer**, Windows x64 for the built-in runtime installer, and
network access for those two downloads.

Ship it without the big download by setting `autoModel: ''` in
`cordis.patch.yml`; the panel then offers the Hugging Face browser and the model
is chosen by hand. `autoSetup: false` disables the runtime download too.

From a local checkout instead:

```
plugin_manager  action: install_bundle  target: <absolute path to this folder>
```

Status is **pushed**, not polled. The panel opens one `text/event-stream` on
`/local-llm/events` and every state change, log line and download tick arrives
as a frame, so there is no Refresh button and nothing to re-invoke. The pill
beside the title reports that channel: *Connecting*, *Live*, *Reconnecting* or
*Offline*; while it is not live the panel falls back to a slow read every four
seconds and retries the stream.

While a page is subscribed the Host also **samples once a second**, even when
nothing changes — that is what keeps uptime and the counters moving instead of
freezing between real events. Uptime is additionally interpolated from the
snapshot's epoch start, so it advances every second regardless of frame timing.

**The tool catalog is trimmed to fit.** A large installation registers far more
tool schema than any local window can hold — this profile registers **265 tools**
totalling **823,101 bytes ≈ 229,000 tokens**, of which 207 are MCP tools. The
adapter therefore offers the model only the tools that fit the space left after
the conversation:

| Setting | Default | Effect |
| --- | --- | --- |
| `limitTools` | on | trim the catalog instead of letting the request fail |
| `maxToolTokens` | `0` | `0` fills whatever the conversation leaves; a number caps it further |
| `excludeTools` | `[]` | prefixes never offered, such as `mcp__` or `mcp__rea__` |

The smallest schemas are kept first, because the largest are what do not fit,
and the caller's order is restored afterwards so the prompt prefix stays stable
for KV-cache reuse. Measured: a **230,792-token catalog became 13 of 265 tools**
and the request was answered rather than refused. Only the conversation itself
can still make a request impossible, and that refusal names the conversation.

If the tool catalog is the problem, excluding a heavy MCP prefix frees the most
space for the least loss; if the conversation is the problem, compact it or raise
the window.

### Tool calling

A tool call reaches the Harness as streamed `tool-call-delta` chunks, and the
Harness names the call from those chunks. The adapter therefore holds a call
until the model has named it, then sends the buffered arguments together with the
name. A call the model never names is dropped and logged, and the turn ends as a
plain stop, because an unnamed call would otherwise reach the Harness as
`unknown tool ""`.

Verified both ways: a canned stream whose name arrives after its arguments, and
the live model, which called `get_weather` with the name present on every delta.

### Prompt cache on disk

`cacheToDisk` (on by default) launches the server with `--slot-save-path
~/.dsh/local-llm/cache` and keeps one state file per model build:

- after a finished turn, and again when the server stops, the plugin asks the
  server to save the slot's state (throttled to one write per 15 seconds);
- on the next start it restores that state before serving the first request, so
  the tokens that were already read are reused instead of re-read;
- a state the server refuses is deleted and the slot is erased, because a
  half-restored slot would fail every later request.

Measured on this machine with a 948-token prompt: cold 4.8 s, then after a
restart 3.1 s with 405 tokens served from the restored state. The saving grows
with the size of the shared prefix — which is the system prompt and the early
conversation, exactly the expensive part.

**What the cache is, and is not.** It is a snapshot of the model's key/value
rows for a token sequence, so:

| Property | Behaviour |
| --- | --- |
| Model-specific | **Yes.** Hidden states are a function of the weights; a state saved by another model was refused in 3 ms and discarded. |
| Context-size specific | No, in this build: a state saved at 2048 restored into a 4096-token context and was still reused. |
| Prompt-specific | **Yes.** It is a token prefix, not meaning. Only the identical leading tokens are reused; a different opening gives no benefit. |
| Portable across engine versions | Not guaranteed. The file is llama.cpp's internal state format; treat it as belonging to the build that wrote it, which is why a refused restore is discarded rather than forced. |
| Shared between models | Never. One file per model build; switching models writes its own. |

The files are large because the state covers the whole KV allocation, not only
the used tokens: about 21 MB for a 2048-token window, so roughly 85 MB at 8192.
The newest four are kept and the rest are pruned at startup.

### Context, and why it decides whether chat answers

The **Context window** is not just a server flag: the Harness keeps conversation
history up to the window the model advertises before it compacts. A CPU model
prefills roughly 100–250 tokens per second, so an oversized window means the
Harness stuffs far more history in than this machine can read, and the first
token appears many minutes later — or never, from the user's point of view.

This plugin therefore tells the truth about the window:

| Setting | Default | Effect |
| --- | --- | --- |
| `contextSize` | `8192` | the window the server is launched with **and** the one the Harness is told about |
| `maxContextSize` | `32768` | hard ceiling; a stored value above it is reduced once, and the panel says so |
| `maxOutputTokens` | `1024` | passed as `-n`, so one answer cannot hold a step open indefinitely |
| `thinking` | off | disables the model's reasoning phase (`--reasoning-budget 0` and `enable_thinking: false`) |

A stored window beyond the ceiling is migrated to `8192` on the next start, with
a line in the server log explaining the reduction. If a prompt still exceeds the
window, llama.cpp refuses it immediately and the panel reports the size and what
to change, rather than spending the wait on prompt evaluation first.

Measured on this machine (Intel Core Ultra 7 155H, CPU build): a 6000-token
prompt reaches its first token in about 22 seconds with thinking off. The same
server given a 256000-token window was asked for a ~253000-token prompt and was
still at 38% after **20 minutes** — that is the failure this design prevents.

**Agent use needs a smaller tool set, and the adapter now provides it.** This
profile registers 265 tools whose compact schemas total 823,101 bytes ≈ 229,000
tokens; a 1.7B CPU model with an 8192-token window cannot hold that at any
setting. With limitTools on, the catalog is trimmed to what fits and the
request is answered. Two things still cost the most: a conversation larger than
the window (compact it, or raise the window) and the prefill time of whatever
still fits.

### Live usage

The **Live usage** card reports, refreshing on its own:

| Metric | Source |
| --- | --- |
| **CPU** | machine-wide busy share, from successive `os.cpus()` deltas |
| **RAM** | machine used / total, from `os.freemem()` and `os.totalmem()` |
| **Tokens processed** | `llamacpp:prompt_tokens_total` + `llamacpp:tokens_predicted_total`, with the input/output split |
| **Avg first token** | average and last time to first streamed token, measured on each call by the adapter |
| **Avg tokens/s** | `tokens_predicted_total ÷ tokens_predicted_seconds_total`, plus the current rate |
| **Active calls** | calls currently open in this process, plus how many the server defers |

The token, throughput and queue figures come from llama-server's own Prometheus
document (`--metrics`), so they count every request the server answers, not only
the ones the Harness made. First-token latency has no server counter, so it is
measured per call: from the request leaving the Host to the first text or
reasoning delta arriving.

## Use it

1. Open **Local model** in the left sidebar.
2. If no runtime is detected, install one:
   - **Install llama.cpp (CPU)** for a 1.7B-class model — measured at 153 tok/s on
     an Intel Core Ultra 7 155H;
   - **Install llama.cpp (Vulkan)** for larger models that benefit from GPU
     offload. It sets GPU layers to 99. On this page's own 1.7B fixture the
     Vulkan build measured 148 tok/s against the CPU build's 153, so the two are
     equivalent at that size.
3. Under **Models → From Hugging Face**. The browser starts empty on purpose;
   nothing is searched until you ask:
   - type any query (`LFM3`, `Qwen3`, `Gemma`, `Mistral`) and press **Search**;
   - the grid shows twenty repositories per page; **‹ ›** walk the cursor
     Hugging Face publishes, and pages you already visited stay in memory;
   - the folder button on a repository opens its builds below the grid, with
     sizes, a **Recommended** tag on the Q4_K_M build, and a download button;
   - or paste `org/repo`, `org/repo/file.gguf`, or a full `huggingface.co` address
     in the last row.
4. Under **Models → On this computer**, select the model you want with the
   check control on its card. The trash control removes a downloaded file and
   its partial download; it refuses the file a running server is serving. The
   grid pages four cards at a time. Card controls are icons carrying their
   label as an accessible name and a tooltip.
5. Press **Start**, then **Verify in Harness**. That second check runs one
   prompt through the same provider route the agent uses.
6. In a chat, open the model selector in the composer and choose the
   **Local model (llama.cpp)** group, then the model above.

A split model (`…-00001-of-00003.gguf`) downloads every shard, and the first
shard becomes the selected model. Downloads resume from their `.part` when
interrupted. Gated repositories need `HF_TOKEN` (or `HUGGING_FACE_HUB_TOKEN`) in
the environment that launches the Harness.

## What it reads and where it writes

| Path | Role |
| --- | --- |
| `~/.dsh/local-llm/runtime/cpu/` | CPU `llama-server`, installed on request |
| `~/.dsh/local-llm/runtime/vulkan/` | Vulkan `llama-server`, installed on request |
| `~/.dsh/local-llm/models/` | `.gguf` model files, downloaded or picked on request |
| `~/.dsh/local-llm/cache/` | one prompt-state file per model build |
| `~/.dsh/local-llm/settings.json` | values changed in the panel |

`binaryPath` pins a `llama-server` you installed yourself; leave it empty to
auto-detect one under `runtime/` or on `PATH`. The built-in installer serves
**Windows x64 only**, because the pinned llama.cpp release publishes Windows
binaries; elsewhere the panel asks for that path instead of offering a download.

`dataDir` in the bundle config moves all of these. Nothing leaves this machine
except the Hugging Face and GitHub requests the panel itself starts: the model
runs on `127.0.0.1` only.

## Limitations

- CPU and RAM describe the whole machine, not the model process alone; the
  model's share is not separable without platform-specific calls.
- The token, throughput and queue counters reset whenever the server restarts,
  because they come from the running process.
- First-token latency covers calls this Harness made; a request issued by
  another client is invisible to it.
- The model runs on the CPU by default (`gpuLayers: 0`). The Vulkan build exists
  for larger models; measured on this machine it did not speed up a 1.7B model.
- A window at the ceiling still costs minutes of prompt prefill. The plugin
  prefers a small window that answers quickly over a large one that appears to
  hang, so raise `contextSize` only when you accept the wait.
- An existing conversation started under a huge window keeps its history until
  the Harness compacts; the first request after the change may still be refused
  for size, which the panel reports immediately.
- A downloaded model is a full GGUF file; the 1.7B Q4_K_M build is about 1.1 GB.
- Hugging Face sizes are read with one `HEAD` request per file, capped at 24
  requests per listing, so the largest repositories report `—` for some builds.
- Paging forward asks Hugging Face for the next cursor; going back reuses the
  page already in memory, so a repository that moves between pages can appear
  twice across a long walk.
- A download cannot be cancelled from the panel yet; stop the Harness or turn
  the plugin off to abort it, and the next attempt resumes from the `.part`.
- The local server is started with a per-launch bearer token, so other pages in
  a browser cannot drive it, but any process running as your user still can.
- Tool calling depends on the model's chat template. A small model may answer
  without calling tools even when tools are offered.
- LFM3 1.7B is a reasoning model, so it spends output tokens on reasoning before
  it answers. Give it a generous context window (8192 or more) and output cap
  before using it for agent work; the panel's own test prompt works with less.
- The panel does not restart the Harness. A change to this plugin's own files is
  loaded the next time the Harness starts.
