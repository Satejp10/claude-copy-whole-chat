# Claude Copy Chat

A Tampermonkey/Violentmonkey userscript for **claude.ai** that copies conversations as clean, formatted **Markdown** — the whole chat in one click, or just a single exchange (your prompt + Claude's response).

Unlike selecting text or using Claude's native copy button, it reads **Claude's internal conversation API** with your existing session, so you get the *entire* active branch — including messages no longer rendered on screen — with thinking blocks, correct branch handling, and byte-perfect source markdown for code, tables and math.

---

## Installation

1. Install a userscript manager if you don't have one:
   - **Tampermonkey** (Chrome / Edge / Safari) — <https://www.tampermonkey.net/>
   - **Violentmonkey** (Firefox) — <https://violentmonkey.github.io/>
2. Open the manager's dashboard → **Create new script** (or drag-install the `.user.js` file).
3. Paste the full contents of `claude-copy-chat.user.js`, save (`Ctrl+S`).
4. Open any conversation at <https://claude.ai> — you'll see a **⧉ Copy chat** pill in the bottom-right corner.

## Usage

| Action | How |
|---|---|
| Copy the whole conversation | Click the **⧉ Copy chat** pill (bottom-right) |
| Copy one exchange (prompt + response) | Click the small **⧉** icon in the action bar **under any Claude reply** |
| Choose what gets copied | Click the **⚙ gear** next to the pill |
| Menu commands | Tampermonkey menu → *Copy whole conversation / Copy settings / Toggle thinking* |

Everything lands on your clipboard as Markdown — paste into Notion, Obsidian, VS Code, GitHub, Google Docs, anywhere.

## Settings

| Setting | What it does | Default |
|---|---|---|
| Include thinking blocks | Adds Claude's extended reasoning | ✅ on |
| Thinking format | Collapsible (`<details>`) or blockquote | collapsible |
| Include tool calls & results | Web-search / artifact tool internals (verbose) | ❌ off |
| Note attached files | Small `📎 attachment:` lines | ✅ on |
| Timestamps | When each message was sent | ✅ on |
| Metadata header | Title, model, date, source URL at top | ✅ on |
| Image placeholders | `[image omitted]` notes instead of silent drop | ❌ off |

Settings persist across page reloads (stored via `GM_setValue`).

## Output format

```markdown
# Setting up Claude Code with multiple subscriptions

> **Exported:** Oct 17, 2026, 1:20 PM · **Model:** claude-sonnet-4-5 · **Exchanges:** 4
> **Source:** https://claude.ai/chat/018d3f1a-…

---
## 🧑 You

*Oct 1, 2026, 10:00 AM*

How can I set Claude Code up with this subscription?

---
## 🤖 Claude

*Oct 1, 2026, 10:02 AM*

##### 💭 Thinking

<details>
<summary>Show thinking</summary>

Check the subscription constraints first…

</details>

You can configure multiple folders to use different subscriptions…
```

Headings inside message bodies are automatically demoted (fence-aware) so they nest correctly under the speaker headings; code blocks are never touched.

## How it works (for the curious)

1. **Conversation UUID** is read from the URL (`claude.ai/chat/<uuid>`, `/share/<uuid>`).
2. **Organization UUID** comes from the `lastActiveOrg` cookie (fallback: `GET /api/organizations`).
3. One authenticated call: `GET /api/organizations/{org}/chat_conversations/{id}?tree=true&rendering_mode=messages&render_all_tools=true`.
4. Claude stores conversations as a **tree** (edits/regenerations create branches). The script walks `parent_message_uuid` pointers from `current_leaf_message_uuid`, so you always copy exactly the branch on screen — even if only part of it is rendered in the DOM.
5. Content blocks (`text`, `thinking`, `tool_use`, `tool_result`) are rendered to Markdown. Tool-result plumbing that the API hides inside "human" messages is never mistaken for your prompts.
6. If the API is ever unreachable, the per-exchange buttons fall back to extracting the visible page text (limited fidelity).

## Privacy & safety

- Runs 100% locally. The only network call is to `claude.ai`'s own API using **your** logged-in session — the same request your browser already makes when loading the page.
- No analytics, no external servers, nothing stored beyond your settings.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Pill doesn't appear | Confirm the userscript is enabled for `claude.ai`; hard-refresh the tab |
| *"Claude API returned 401/403"* | Your session expired — reload the page / sign in again |
| *"Could not determine your Claude workspace"* | Sign in to claude.ai first; the `lastActiveOrg` cookie is set on load |
| *"reply is still streaming"* | Wait for Claude to finish answering, then copy |
| No per-exchange buttons | Claude changed their DOM — the pill still works; please file an issue |

## Limitations (v1)

- Images are not embedded in the markdown (toggle the placeholder to mark where they appeared).
- Artifacts export as their name/source reference rather than full artifact content.
- Share pages (`/share/<id>`) work only if the share is visible to your signed-in account.

## License

MIT
