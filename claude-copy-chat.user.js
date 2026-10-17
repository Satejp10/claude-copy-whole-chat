// ==UserScript==
// @name         Claude Copy Chat
// @namespace    https://github.com/claude-copy-chat/userscript
// @version      1.0.0
// @description  Copy Claude.ai conversations as formatted Markdown — the whole chat or a single exchange (prompt + response). Full-fidelity via Claude's internal API (works beyond the visible screen), optional thinking blocks with a settings menu.
// @author       Claude Copy Chat
// @match        https://claude.ai/*
// @match        https://app.claude.ai/*
// @icon         https://claude.ai/favicon.ico
// @grant        GM_setClipboard
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @run-at       document-idle
// @noframes
// @license      MIT
// ==/UserScript==

/*
 * ─────────────────────────────────────────────────────────────────────────────
 *  Claude Copy Chat v1.0.0
 * ─────────────────────────────────────────────────────────────────────────────
 *  FEATURES
 *    • ⧉ Copy chat   – whole conversation → clipboard as formatted Markdown
 *    • ⧉ Copy exchange – a small button under every Claude reply copies that
 *                        single prompt + response pair
 *    • ⚙ Settings    – include/omit thinking blocks (collapsible or blockquote),
 *                        tool calls, timestamps, metadata header, image notes
 *    • Reads Claude's INTERNAL API (the same JSON the web app uses), so you get
 *      the full active branch even when only part of it is rendered on screen,
 *      plus thinking blocks and branched/edit threads handled correctly.
 *    • Works on claude.ai/chat/<id> and claude.ai/share/<id> pages.
 *
 *  HOW IT WORKS (no DOM scraping for content — API-first, DOM only for UI)
 *    1. Conversation UUID comes from the URL.
 *    2. Organization UUID comes from the `lastActiveOrg` cookie
 *       (fallback: GET /api/organizations).
 *    3. GET /api/organizations/{org}/chat_conversations/{id}
 *         ?tree=true&rendering_mode=messages&render_all_tools=true
 *    4. The active branch is rebuilt by walking parent_message_uuid pointers
 *       from current_leaf_message_uuid (so regenerated/edited answers export
 *       exactly what is on screen).
 *    5. Content blocks (text / thinking / tool_use / tool_result) are rendered
 *       to Markdown and copied to the clipboard.
 *
 *  PRIVACY: runs 100% locally; the only network call is to claude.ai's own
 *  API using your existing session. Nothing is sent anywhere else.
 * ─────────────────────────────────────────────────────────────────────────────
 */

(function () {
  'use strict';

  /* ═════════════════════════════ 1. CONSTANTS & STATE ═══════════════════════ */

  const VERSION = '1.0.0';
  const LOG = '[Claude Copy Chat]';
  const CACHE_TTL_MS = 10_000; // conversation cache lifetime
  const SCAN_DEBOUNCE_MS = 300; // DOM scan debounce
  // Parent of the very first message in a thread (nil-UUID sentinel).
  const ROOT_SENTINEL = /^0{8}-0000-4000-8000-0{12}$/;

  // Current (2026) claude.ai DOM anchors. Used ONLY to place our buttons and
  // for a last-resort text fallback — conversation content comes from the API.
  const SEL = {
    actionsGroup: '[role="group"][aria-label="Message actions"]',
    feedbackBtn: 'button[aria-label="Give positive feedback"]',
    userMsg: '[data-testid="user-message"]',
    asstMsg: '.font-claude-message, [data-testid="assistant-message"]',
  };

  const DEFAULTS = {
    includeThinking: true,   // copy Claude's thinking blocks
    thinkingStyle: 'collapse', // 'collapse' (<details>) | 'quote' (blockquote)
    includeToolCalls: false, // tool_use / tool_result blocks (can be verbose)
    includeAttachments: true, // "📎 attachment:" note lines
    includeTimestamps: true, // per-message timestamp line
    includeMetaHeader: true, // title / date / model / URL header block
    imagePlaceholder: false, // "[image omitted]" notes instead of silent skip
  };

  let prefs = loadPrefs();

  /** @type {{key: string|null, at: number, data: any}} */
  const convCache = { key: null, at: 0, data: null };

  let ui = { root: null, pill: null, copyBtn: null, gearBtn: null, panel: null, toast: null };
  let busy = false;
  let scanTimer = null;

  /* ═════════════════════════════ 2. STORAGE (prefs) ═════════════════════════ */

  function loadPrefs() {
    const out = { ...DEFAULTS };
    try {
      if (typeof GM_getValue === 'function') {
        for (const k of Object.keys(DEFAULTS)) {
          const v = GM_getValue('ccx_' + k, undefined);
          if (v !== undefined) out[k] = v;
        }
      } else {
        const raw = localStorage.getItem('ccx_prefs');
        if (raw) Object.assign(out, JSON.parse(raw));
      }
    } catch (e) { console.warn(LOG, 'prefs load failed', e); }
    if (out.thinkingStyle !== 'collapse' && out.thinkingStyle !== 'quote') {
      out.thinkingStyle = 'collapse';
    }
    return out;
  }

  function savePref(key, value) {
    prefs[key] = value;
    try {
      if (typeof GM_setValue === 'function') {
        GM_setValue('ccx_' + key, value);
      } else {
        localStorage.setItem('ccx_prefs', JSON.stringify(prefs));
      }
    } catch (e) { console.warn(LOG, 'pref save failed', e); }
  }

  /* ═════════════════════════════ 3. SMALL UTILITIES ═════════════════════════ */

  const log = (...a) => console.log(LOG, ...a);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function el(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
      else if (k === 'dataset') Object.assign(node.dataset, v);
      else if (k === 'textContent') node.textContent = v ?? '';
      else if (k === 'html') node.innerHTML = v;
      else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
      else if (v !== null && v !== undefined) node.setAttribute(k, v);
    }
    for (const c of children) if (c) node.appendChild(c);
    return node;
  }

  /** Clipboard with graceful fallbacks. Returns true on success. */
  async function copyText(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (e) { /* fall through */ }
    try {
      if (typeof GM_setClipboard === 'function') {
        GM_setClipboard(text, 'text/plain');
        return true;
      }
    } catch (e) { /* fall through */ }
    try {
      const ta = el('textarea', { style: { position: 'fixed', opacity: '0', pointerEvents: 'none' } });
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch (e) {
      console.error(LOG, 'all clipboard strategies failed', e);
      return false;
    }
  }

  /** Localized human timestamp, or null when input is unusable. */
  function fmtStamp(iso) {
    if (!iso) return null;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    try {
      return d.toLocaleString(undefined, {
        year: 'numeric', month: 'short', day: 'numeric',
        hour: 'numeric', minute: '2-digit',
      });
    } catch (e) { return null; }
  }

  /**
   * Wrap body in a code fence that can never be closed early, even if the
   * body itself contains long backtick runs.
   */
  function fence(body, lang = '') {
    const runs = String(body).match(/`+/g) ?? [];
    const marker = '`'.repeat(Math.max(3, ...runs.map((r) => r.length + 1)));
    return `${marker}${lang}\n${String(body).replace(/\n$/, '')}\n${marker}`;
  }

  /**
   * Shift ATX headings down by `shift` levels so message-internal headings
   * nest beneath our "## 🧑 You / ## 🤖 Claude" speaker headings.
   * Fence-aware: headings inside ``` code blocks are left untouched.
   * Lines already deeper than 6 levels are capped.
   */
  function demoteHeadings(text, shift = 2) {
    if (!text || shift <= 0) return text || '';
    const out = [];
    let inFence = false;
    let fenceMarker = '';
    for (const line of String(text).split('\n')) {
      const m = line.match(/^\s*(`{3,}|~{3,})/);
      if (m) {
        if (!inFence) { inFence = true; fenceMarker = m[1][0].repeat(3); }
        else if (m[1][0] === fenceMarker[0] && m[1].length >= 3) inFence = false;
        out.push(line);
        continue;
      }
      if (!inFence) {
        const h = line.match(/^(#{1,6})(\s|$)/);
        if (h) {
          const level = Math.min(6, h[1].length + shift);
          out.push('#'.repeat(level) + line.slice(h[1].length));
          continue;
        }
      }
      out.push(line);
    }
    return out.join('\n');
  }

  /** Indent every non-empty line with "> " to build a blockquote. */
  function blockquote(text) {
    return String(text)
      .split('\n')
      .map((l) => (l.trim() ? `> ${l}` : '>'))
      .join('\n');
  }

  /* ═════════════════════════════ 4. TOAST FEEDBACK ══════════════════════════ */

  let toastTimer = null;

  function toast(message, kind = 'ok') {
    if (!ui.toast) return;
    ui.toast.textContent = (kind === 'ok' ? '✓ ' : '⚠ ') + message;
    ui.toast.dataset.kind = kind;
    ui.toast.classList.add('ccx-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => ui.toast.classList.remove('ccx-visible'), 2600);
  }

  /* ═════════════════════════════ 5. MARKDOWN PIPELINE ═══════════════════════ */

  /** Render a `thinking` content block according to user prefs. */
  function renderThinking(block) {
    const text = String(block.thinking ?? block.text ?? '').trim();
    if (!text) return null;
    if (prefs.thinkingStyle === 'quote') {
      return `### 💭 Thinking\n\n${blockquote(text)}`;
    }
    // Collapsible — blank lines around the body are required so the markdown
    // inside <details> renders on GitHub / Obsidian / most renderers. A stray
    // closing tag inside the text would break the wrapper, so strip it.
    const safe = text.replace(/<\/details>/gi, '');
    return `### 💭 Thinking\n\n<details>\n<summary>Show thinking</summary>\n\n${safe}\n\n</details>`;
  }

  /** Render a `tool_use` block (name + JSON input). */
  function renderToolUse(block) {
    const name = block.name ?? 'tool';
    let input = '';
    try { input = block.input == null ? '' : JSON.stringify(block.input, null, 2); }
    catch (e) { input = String(block.input); }
    const body = input ? `${fence(input, 'json')}` : '_(no input)_';
    return `**🔧 Tool call: \`${name}\`**\n\n${body}`;
  }

  /** Render a `tool_result` block. */
  function renderToolResult(block) {
    let body = '';
    const c = block.content;
    if (typeof c === 'string') body = c;
    else if (Array.isArray(c)) body = c.map((p) => p?.text ?? JSON.stringify(p)).join('\n').trim();
    else if (block.text) body = String(block.text);
    if (!body) return null;
    const flag = block.is_error ? ' (error)' : '';
    return `**↩ Tool result${flag}**\n\n${fence(body)}`;
  }

  /** Notes for files attached to a message (documents pasted into the prompt). */
  function renderAttachments(msg) {
    if (!prefs.includeAttachments) return [];
    const atts = [...(msg.attachments ?? []), ...(msg.files_v2 ?? [])];
    const notes = [];
    for (const a of atts) {
      const name = a.file_name ?? a.name ?? 'attachment';
      notes.push(`*📎 attachment: ${name}*`);
    }
    return notes;
  }

  /** Convert one API message object to Markdown according to prefs. */
  function messageToMd(msg) {
    const parts = [];
    const blocks = Array.isArray(msg.content) && msg.content.length
      ? msg.content
      : (typeof msg.text === 'string' && msg.text.trim()
          ? [{ type: 'text', text: msg.text }]
          : []);

    for (const b of blocks) {
      if (!b || typeof b !== 'object') continue;
      switch (b.type) {
        case 'text':
          if (b.text && b.text.trim()) parts.push(String(b.text).trim());
          break;
        case 'thinking':
        case 'reasoning': {
          if (prefs.includeThinking) {
            const t = renderThinking(b);
            if (t) parts.push(t);
          }
          break;
        }
        case 'tool_use':
          if (prefs.includeToolCalls) parts.push(renderToolUse(b));
          break;
        case 'tool_result':
          if (prefs.includeToolCalls) {
            const r = renderToolResult(b);
            if (r) parts.push(r);
          }
          break;
        case 'image':
          if (prefs.imagePlaceholder) parts.push('*[image omitted]*');
          break;
        case 'document':
          if (prefs.imagePlaceholder) parts.push(`*[document omitted${b.name ? ': ' + b.name : ''}]*`);
          break;
        default:
          break; // unknown block types are silently skipped
      }
    }

    parts.push(...renderAttachments(msg));
    return parts.join('\n\n').trim();
  }

  /** One exchange = the user's prompt + Claude's response, as Markdown. */
  function exchangeToMd(exchange) {
    const out = [];
    if (exchange.human) {
      const ts = prefs.includeTimestamps ? fmtStamp(exchange.human.created_at) : null;
      out.push(`## 🧑 You\n${ts ? `\n*${ts}*\n\n` : '\n'}${demoteHeadings(messageToMd(exchange.human))}`);
    }
    if (exchange.assistants.length) {
      const ts = prefs.includeTimestamps
        ? fmtStamp(exchange.assistants[exchange.assistants.length - 1].created_at)
        : null;
      const body = exchange.assistants
        .map((m) => demoteHeadings(messageToMd(m)))
        .filter(Boolean)
        .join('\n\n') || '*(no copyable content)*';
      out.push(`## 🤖 Claude\n${ts ? `\n*${ts}*\n\n` : '\n'}${body}`);
    }
    // Tool plumbing attached to this exchange — shown only when the user
    // opted into tool calls (their tool_use side is rendered in the Claude
    // section; here we render the paired tool_result blocks).
    if (prefs.includeToolCalls && exchange.toolCarriers?.length) {
      const results = exchange.toolCarriers
        .map((m) => demoteHeadings(messageToMd(m)))
        .filter(Boolean)
        .join('\n\n');
      if (results) out.push(results);
    }
    return out.join('\n\n---\n\n').trim();
  }

  /** Build the metadata header block for a full-conversation copy. */
  function buildMetaHeader(meta) {
    if (!prefs.includeMetaHeader) return '';
    const lines = [`# ${meta.title || 'Claude conversation'}`, ''];
    const facts = [];
    if (meta.exportedAt) facts.push(`**Exported:** ${meta.exportedAt}`);
    if (meta.model) facts.push(`**Model:** ${meta.model}`);
    if (meta.turnCount) facts.push(`**Exchanges:** ${meta.turnCount}`);
    if (facts.length) lines.push('> ' + facts.join(' · '));
    if (meta.url) lines.push(`> **Source:** ${meta.url}`);
    if (meta.createdStamp) lines.push(`> **Conversation started:** ${meta.createdStamp}`);
    lines.push('', '---', '');
    return lines.join('\n');
  }

  /** Full conversation → Markdown (one path shared with exchange copies). */
  function conversationToMd(thread, meta) {
    const exchanges = buildExchanges(thread);
    const body = exchanges.map((ex) => exchangeToMd(ex)).join('\n\n---\n\n');
    return (buildMetaHeader(meta) + body + '\n').trimEnd() + '\n';
  }

  /* ═════════════════════════════ 6. API / DATA LAYER ════════════════════════ */

  /**
   * Which conversation are we on?
   * Handles /chat/<uuid>, /share/<uuid> and bare /<uuid> routes.
   * Returns { kind: 'chat'|'share', id } or null when not a conversation page.
   */
  function getRoute() {
    const parts = window.location.pathname.split('/').filter(Boolean);
    const shareIdx = parts.indexOf('share');
    if (shareIdx >= 0 && parts[shareIdx + 1]) return { kind: 'share', id: parts[shareIdx + 1] };
    const chatIdx = parts.indexOf('chat');
    if (chatIdx >= 0 && parts[chatIdx + 1]) return { kind: 'chat', id: parts[chatIdx + 1] };
    // Legacy bare-UUID URLs
    if (parts.length === 1 && /^[0-9a-f-]{16,}$/i.test(parts[0])) return { kind: 'chat', id: parts[0] };
    return null;
  }

  function apiFetch(url) {
    return fetch(url, {
      credentials: 'include', // send the claude.ai session cookies
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    });
  }

  /** Organization UUID: `lastActiveOrg` cookie first, /api/organizations fallback. */
  async function getOrgId() {
    const fromCookie = document.cookie.match(/lastActiveOrg=([^;]+)/)?.[1];
    if (fromCookie) return fromCookie;
    try {
      const res = await apiFetch('/api/organizations');
      if (res.ok) {
        const orgs = await res.json();
        if (Array.isArray(orgs) && orgs.length) return orgs[0].uuid;
      }
    } catch (e) { console.warn(LOG, 'organizations lookup failed', e); }
    return null;
  }

  /**
   * Fetch + cache the conversation JSON.
   * @param {boolean} force skip the cache (used by "copy whole conversation")
   */
  async function getConversation(force = false) {
    const route = getRoute();
    if (!route) throw new Error('Open a Claude conversation first — this page has no conversation ID.');

    const key = route.kind + ':' + route.id;
    if (!force && convCache.data && convCache.key === key && Date.now() - convCache.at < CACHE_TTL_MS) {
      return convCache.data;
    }

    const orgId = await getOrgId();
    if (!orgId) {
      throw new Error('Could not determine your Claude workspace (no lastActiveOrg cookie). Are you signed in?');
    }

    const url = route.kind === 'share'
      ? `/api/organizations/${orgId}/chat_snapshots/${route.id}?rendering_mode=messages&render_all_tools=true`
      : `/api/organizations/${orgId}/chat_conversations/${route.id}?tree=true&rendering_mode=messages&render_all_tools=true`;

    let res;
    try {
      res = await apiFetch(url);
    } catch (e) {
      throw new Error('Could not reach the Claude API (' + (e?.message ?? e) + ').');
    }
    if (res.status === 401 || res.status === 403) {
      throw new Error('Claude API returned ' + res.status + ' — your session may have expired. Reload the page and sign in again.');
    }
    if (!res.ok) {
      throw new Error('Claude API request failed (HTTP ' + res.status + ').');
    }

    let raw;
    try { raw = await res.json(); }
    catch (e) { throw new Error('Claude API response was not JSON (login or bot check?). Reload and try again.'); }

    const data = route.kind === 'share' ? normalizeSnapshot(raw, route.id) : raw;
    if (!Array.isArray(data.chat_messages) || !data.chat_messages.length) {
      throw new Error('The conversation contains no messages yet.');
    }

    convCache.key = key;
    convCache.at = Date.now();
    convCache.data = data;
    return data;
  }

  /** Map a /chat_snapshots response onto the normal conversation shape. */
  function normalizeSnapshot(raw, shareId) {
    const snap = raw?.snapshot ?? {};
    return {
      ...raw,
      uuid: raw?.uuid ?? snap.uuid ?? shareId,
      name: raw?.name ?? raw?.snapshot_name ?? raw?.conversation?.name ?? snap.name ?? null,
      model: raw?.model ?? snap.model ?? raw?.conversation?.model ?? snap.model ?? null,
      created_at: raw?.created_at ?? snap.created_at ?? raw?.conversation?.created_at ?? null,
      chat_messages: [raw?.chat_messages, snap.chat_messages, raw?.conversation?.chat_messages, snap.messages, raw?.messages]
        .find(Array.isArray) ?? [],
      current_leaf_message_uuid: raw?.current_leaf_message_uuid ?? snap.current_leaf_message_uuid ?? null,
    };
  }

  /**
   * Claude conversations are trees — editing or regenerating a message creates
   * a sibling branch. Walk from the active leaf up the parent chain to export
   * exactly the branch currently displayed on screen, in chronological order.
   */
  function buildActiveThread(data) {
    const messages = data?.chat_messages ?? [];
    if (!messages.length) return [];

    // Flat payload (no parent links) → keep server order.
    if (!messages.some((m) => m.parent_message_uuid)) {
      return [...messages].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    }

    const byUuid = new Map(messages.map((m) => [m.uuid, m]));
    const leafId = data.current_leaf_message_uuid ?? findLatestLeaf(messages);

    const ordered = [];
    const seen = new Set();
    let cursor = byUuid.get(leafId) ?? messages[messages.length - 1];
    while (cursor && !seen.has(cursor.uuid)) {
      seen.add(cursor.uuid);
      ordered.push(cursor);
      const parent = cursor.parent_message_uuid;
      // Stop at the root sentinel or any UUID that is not a real message.
      cursor = parent && !ROOT_SENTINEL.test(parent) ? byUuid.get(parent) : null;
    }
    return ordered.reverse();
  }

  /** Fallback leaf picker: newest message nobody references as a parent. */
  function findLatestLeaf(messages) {
    const parented = new Set(messages.map((m) => m.parent_message_uuid).filter(Boolean));
    const leaves = messages.filter((m) => !parented.has(m.uuid));
    leaves.sort((a, b) => new Date(b.created_at ?? 0) - new Date(a.created_at ?? 0));
    return leaves[0]?.uuid ?? messages[messages.length - 1]?.uuid;
  }

  /**
   * Detect messages that are pure tool plumbing: in claude.ai's API the
   * assistant's tool results arrive as `human`-sender messages whose content
   * is exclusively `tool_result` blocks. They are NOT user prompts and must
   * never start a new exchange.
   */
  function isToolCarrier(msg) {
    const blocks = Array.isArray(msg.content) ? msg.content : [];
    return blocks.length > 0 && blocks.every((b) => b?.type === 'tool_result');
  }

  /**
   * Pair each Claude response with the user prompt that precedes it.
   * Returns [{ human, assistants: [], toolCarriers: [] }] in conversation order.
   * Consecutive assistant messages (multi-part replies) are merged into one
   * exchange; tool-result messages (which the API sends with sender "human")
   * are attached to the surrounding exchange instead of being read as prompts.
   */
  function buildExchanges(thread) {
    const exchanges = [];
    let open = null;

    const flush = () => {
      if (open) exchanges.push(open);
      open = null;
    };
    const newOpen = (h) => {
      open = { human: h, assistants: [], toolCarriers: [] };
    };

    for (const msg of thread) {
      if (msg.sender === 'human') {
        if (isToolCarrier(msg)) {
          // belongs to the exchange currently being assembled — the tool_use
          // side of which is inside `open.assistants`.
          if (!open) newOpen(null);
          open.toolCarriers.push(msg);
          continue;
        }
        flush();
        newOpen(msg);
      } else {
        if (!open) newOpen(null);
        open.assistants.push(msg);
      }
    }
    flush();
    return exchanges;
  }

  /** Metadata used by the header block and toasts. */
  function buildMeta(data, thread) {
    return {
      title: data?.name || null,
      model: data?.model || null,
      url: window.location.href,
      exportedAt: fmtStamp(new Date().toISOString()),
      createdStamp: fmtStamp(data?.created_at),
      turnCount: buildExchanges(thread).length,
    };
  }

  /* ═════════════════════════════ 7. ACTIONS ═════════════════════════════════ */

  /** Copy the whole conversation as Markdown. */
  async function copyWholeConversation() {
    if (busy) return;
    busy = true;
    setPillBusy(true);
    try {
      const data = await getConversation(true); // always fresh for full copies
      const thread = buildActiveThread(data);
      if (!thread.length) throw new Error('No messages found in this conversation.');
      const meta = buildMeta(data, thread);
      const md = conversationToMd(thread, meta);
      const ok = await copyText(md);
      if (!ok) throw new Error('Clipboard write was blocked by the browser.');
      const n = thread.filter((m) => !isToolCarrier(m)).length;
      toast(`Copied whole conversation — ${n} messages as Markdown`);
      log(`copied conversation ${data?.uuid ?? '?'} (${md.length} chars)`);
    } catch (e) {
      console.error(LOG, e);
      toast(e?.message ?? String(e), 'err');
    } finally {
      busy = false;
      setPillBusy(false);
    }
  }

  /**
   * Copy a single exchange (prompt + response).
   * @param {number} ordinal index of the assistant reply on the page (0-based)
   */
  async function copyExchange(ordinal) {
    try {
      let exchange = null;
      let total = 0;
      try {
        exchange = await getExchangeByOrdinal(ordinal);
        total = getExchangeCount();
      } catch (apiErr) {
        // API unavailable → last-resort DOM extraction from the visible page
        console.warn(LOG, 'API path failed, trying DOM fallback:', apiErr?.message);
        exchange = extractExchangeFromDom(ordinal);
        if (!exchange) throw apiErr;
      }
      if (!exchange) {
        // Cache may predate a freshly-streamed reply → refetch once.
        convCache.at = 0;
        exchange = await getExchangeByOrdinal(ordinal);
        total = getExchangeCount();
      }
      if (!exchange) throw new Error('This reply is still streaming — try again in a moment.');
      const md = exchangeToMd(exchange);
      const ok = await copyText(md);
      if (!ok) throw new Error('Clipboard write was blocked by the browser.');
      toast(`Copied exchange ${ordinal + 1}${total ? ' of ' + total : ''} (prompt + response)`);
    } catch (e) {
      console.error(LOG, e);
      toast(e?.message ?? String(e), 'err');
    }
  }

  function getExchangeCount() {
    if (!convCache.data) return 0;
    return buildExchanges(buildActiveThread(convCache.data)).length;
  }

  /** Resolve an exchange by the ordinal of its button on the page. */
  async function getExchangeByOrdinal(ordinal) {
    const data = await getConversation(false);
    const thread = buildActiveThread(data);
    const exchanges = buildExchanges(thread);
    return exchanges[ordinal] ?? null;
  }

  /* ── DOM fallback (best effort, only when the API is unreachable) ────────── */

  function extractExchangeFromDom(ordinal) {
    const humanNodes = [...document.querySelectorAll(SEL.userMsg)];
    const asstNodes = [...document.querySelectorAll(SEL.asstMsg)]
      .filter((n) => (n.textContent ?? '').trim());
    const human = humanNodes[ordinal];
    const asst = asstNodes[ordinal];
    if (!human && !asst) return null;
    const now = new Date().toISOString();
    const mk = (text) => ({ sender: 'human', created_at: now, content: [{ type: 'text', text }] });
    const ex = {
      human: human ? mk((human.innerText ?? human.textContent ?? '').trim()) : null,
      assistants: [],
    };
    if (asst) {
      ex.assistants.push({
        sender: 'assistant',
        created_at: now,
        content: [{ type: 'text', text: (asst.innerText ?? asst.textContent ?? '').trim() }],
      });
    }
    if (!ex.human && !ex.assistants.length) return null;
    toast('API unavailable — used on-page text (limited fidelity)', 'err');
    return ex;
  }

  /* ═════════════════════════════ 8. STYLES ══════════════════════════════════ */

  const CSS = `
    #ccx-root {
      --ccx-bg: #ffffff;
      --ccx-fg: #1f1e1d;
      --ccx-muted: #6f6d69;
      --ccx-border: rgba(0, 0, 0, 0.13);
      --ccx-accent: #c96442;
      --ccx-accent-hover: #b35334;
      --ccx-accent-fg: #ffffff;
      --ccx-danger: #b3261e;
      --ccx-shadow: 0 8px 30px rgba(0, 0, 0, 0.18);
      position: fixed;
      right: 16px;
      bottom: 16px;
      z-index: 2147483000;
      display: flex;
      flex-direction: column;
      align-items: flex-end;
      gap: 10px;
      font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    }
    @media (prefers-color-scheme: dark) {
      #ccx-root {
        --ccx-bg: #262624;
        --ccx-fg: #f0eee9;
        --ccx-muted: #a8a59e;
        --ccx-border: rgba(255, 255, 255, 0.16);
        --ccx-danger: #ff8a80;
        --ccx-shadow: 0 8px 30px rgba(0, 0, 0, 0.55);
      }
    }

    #ccx-root.ccx-hidden { display: none; }

    .ccx-pillwrap { display: flex; align-items: center; gap: 8px; }

    .ccx-btn-main {
      display: inline-flex; align-items: center; gap: 7px;
      padding: 9px 16px;
      background: var(--ccx-accent);
      color: var(--ccx-accent-fg);
      border: none;
      border-radius: 999px;
      font-size: 13px; font-weight: 600; letter-spacing: 0.1px;
      cursor: pointer;
      box-shadow: var(--ccx-shadow);
      transition: background 0.15s ease, transform 0.1s ease;
    }
    .ccx-btn-main:hover { background: var(--ccx-accent-hover); }
    .ccx-btn-main:active { transform: scale(0.97); }
    .ccx-btn-main:disabled { opacity: 0.65; cursor: progress; }
    .ccx-btn-main svg { flex: 0 0 auto; }

    .ccx-btn-gear {
      display: inline-flex; align-items: center; justify-content: center;
      width: 36px; height: 36px;
      background: var(--ccx-bg);
      color: var(--ccx-fg);
      border: 1px solid var(--ccx-border);
      border-radius: 999px;
      cursor: pointer;
      box-shadow: var(--ccx-shadow);
      transition: transform 0.2s ease;
    }
    .ccx-btn-gear:hover { transform: rotate(30deg); }

    .ccx-panel {
      width: 296px;
      max-height: min(72vh, 560px);
      overflow-y: auto;
      background: var(--ccx-bg);
      color: var(--ccx-fg);
      border: 1px solid var(--ccx-border);
      border-radius: 14px;
      box-shadow: var(--ccx-shadow);
      padding: 14px 16px 12px;
      font-size: 13px;
      display: none;
    }
    .ccx-panel.ccx-open { display: block; }
    .ccx-panel h3 {
      margin: 0 0 10px; font-size: 13px; font-weight: 700;
      display: flex; align-items: center; justify-content: space-between;
    }
    .ccx-panel h3 .ccx-ver { font-weight: 400; color: var(--ccx-muted); font-size: 11px; }
    .ccx-row {
      display: flex; align-items: flex-start; gap: 9px;
      padding: 7px 0;
      border-top: 1px solid var(--ccx-border);
    }
    .ccx-row:first-of-type { border-top: none; }
    .ccx-row input[type="checkbox"] {
      accent-color: var(--ccx-accent);
      width: 15px; height: 15px; margin: 1px 0 0;
      cursor: pointer; flex: 0 0 auto;
    }
    .ccx-row label { cursor: pointer; line-height: 1.35; }
    .ccx-row .ccx-sub { display: block; color: var(--ccx-muted); font-size: 11.5px; margin-top: 1px; }
    .ccx-selectrow { padding: 8px 0 2px; border-top: 1px solid var(--ccx-border); }
    .ccx-selectrow label { display: block; color: var(--ccx-muted); font-size: 11.5px; margin-bottom: 5px; }
    .ccx-selectrow select {
      width: 100%;
      background: var(--ccx-bg); color: var(--ccx-fg);
      border: 1px solid var(--ccx-border); border-radius: 8px;
      padding: 6px 8px; font-size: 12.5px; cursor: pointer;
    }
    .ccx-panel footer {
      margin-top: 10px; padding-top: 9px; border-top: 1px solid var(--ccx-border);
      color: var(--ccx-muted); font-size: 11px; line-height: 1.45;
    }

    .ccx-toast {
      background: var(--ccx-bg);
      color: var(--ccx-fg);
      border: 1px solid var(--ccx-border);
      border-radius: 10px;
      box-shadow: var(--ccx-shadow);
      padding: 8px 13px;
      font-size: 12.5px;
      max-width: 340px;
      opacity: 0;
      transform: translateY(6px);
      transition: opacity 0.18s ease, transform 0.18s ease;
      pointer-events: none;
    }
    .ccx-toast.ccx-visible { opacity: 1; transform: translateY(0); }
    .ccx-toast[data-kind="err"] { color: var(--ccx-danger); border-color: var(--ccx-danger); }

    /* per-exchange button, injected inside Claude's own message action bar */
    .ccx-ex-btn {
      display: inline-flex; align-items: center; justify-content: center;
      width: 28px; height: 28px;
      padding: 0;
      background: transparent;
      border: none;
      border-radius: 8px;
      color: inherit;
      opacity: 0.55;
      cursor: pointer;
      transition: opacity 0.12s ease, background 0.12s ease;
    }
    .ccx-ex-btn:hover { opacity: 1; background: rgba(128, 128, 128, 0.14); }
    .ccx-ex-btn:active { transform: scale(0.94); }
    .ccx-ex-btn.ccx-busy { opacity: 1; animation: ccx-pulse 0.9s ease-in-out infinite; }
    @keyframes ccx-pulse { 50% { opacity: 0.35; } }
  `;

  function injectStyles() {
    if (document.getElementById('ccx-style')) return;
    document.head.appendChild(el('style', { id: 'ccx-style', html: CSS }));
  }

  /* ═════════════════════════════ 9. UI CONSTRUCTION ═════════════════════════ */

  const ICONS = {
    copy: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
    copySm: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
    gear: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
  };

  function buildUI() {
    if (document.getElementById('ccx-root')) return;

    ui.toast = el('div', { class: 'ccx-toast', 'aria-live': 'polite', role: 'status' });

    // ── settings panel ─────────────────────────────────────────────────
    ui.panel = el('div', { class: 'ccx-panel', id: 'ccx-panel' });
    const panelBody = el('div');
    ui.panel.appendChild(el('h3', {}, [
      el('span', { textContent: 'Copy settings' }),
      el('span', { class: 'ccx-ver', textContent: 'v' + VERSION }),
    ]));
    ui.panel.appendChild(panelBody);

    const rows = [];
    const addCheck = (key, label, sub) => {
      const cb = el('input', { type: 'checkbox' });
      cb.checked = !!prefs[key];
      cb.addEventListener('change', () => savePref(key, cb.checked));
      const row = el('div', { class: 'ccx-row' }, [
        cb,
        el('label', {}, [
          document.createTextNode(label),
          sub ? el('span', { class: 'ccx-sub', textContent: sub }) : null,
        ]),
      ]);
      rows.push({ key, cb, row });
      panelBody.appendChild(row);
      return row;
    };

    addCheck('includeThinking', 'Include thinking blocks',
      'Claude\u2019s extended reasoning, if the conversation has any.');
    addCheck('includeToolCalls', 'Include tool calls & results',
      'Web searches, artifacts internals — can get verbose.');
    addCheck('includeAttachments', 'Note attached files',
      'Adds a small \u201cattachment\u201d line for uploaded files.');
    addCheck('includeTimestamps', 'Timestamps',
      'Shows when each message was sent.');
    addCheck('includeMetaHeader', 'Metadata header',
      'Title, model, date and source URL at the top.');
    addCheck('imagePlaceholder', 'Image placeholders',
      'Mark where images appeared (off = drop silently).');

    // thinking style sub-option
    const styleSel = el('select', {}, [
      el('option', { value: 'collapse', textContent: 'Collapsible (details/summary)' }),
      el('option', { value: 'quote', textContent: 'Blockquote' }),
    ]);
    styleSel.value = prefs.thinkingStyle;
    styleSel.addEventListener('change', () => savePref('thinkingStyle', styleSel.value));
    const styleRow = el('div', { class: 'ccx-selectrow' }, [
      el('label', { textContent: 'Thinking format' }),
      styleSel,
    ]);
    panelBody.appendChild(styleRow);

    const syncStyleRow = () => { styleRow.style.display = prefs.includeThinking ? '' : 'none'; };
    const thinkRow = rows.find((r) => r.key === 'includeThinking');
    thinkRow.cb.addEventListener('change', syncStyleRow);
    syncStyleRow();

    ui.panel.appendChild(el('footer', {
      textContent: 'Reads Claude\u2019s internal API with your session \u2014 copies the full conversation, even parts not rendered on screen. Runs 100% locally.',
    }));

    // ── pill ───────────────────────────────────────────────────────────
    ui.copyBtn = el('button', {
      class: 'ccx-btn-main', type: 'button', title: 'Copy the whole conversation as Markdown',
      onclick: copyWholeConversation,
    });
    ui.copyLabel = el('span', { textContent: 'Copy chat' });
    ui.copyBtn.append(el('span', { html: ICONS.copy, style: { display: 'inline-flex' } }), ui.copyLabel);

    ui.gearBtn = el('button', {
      class: 'ccx-btn-gear', type: 'button', title: 'Copy settings',
      'aria-label': 'Copy settings', 'aria-expanded': 'false',
      onclick: togglePanel,
    });
    ui.gearBtn.append(el('span', { html: ICONS.gear, style: { display: 'inline-flex' } }));

    ui.pill = el('div', { class: 'ccx-pillwrap' }, [ui.copyBtn, ui.gearBtn]);

    ui.root = el('div', { id: 'ccx-root' }, [ui.toast, ui.panel, ui.pill]);
    document.body.appendChild(ui.root);

    // close the panel when clicking elsewhere
    document.addEventListener('pointerdown', (ev) => {
      if (!ui.panel.classList.contains('ccx-open')) return;
      if (ui.panel.contains(ev.target) || ui.gearBtn.contains(ev.target)) return;
      closePanel();
    });
  }

  function togglePanel() {
    ui.panel.classList.contains('ccx-open') ? closePanel() : openPanel();
  }

  function openPanel() {
    ui.panel.classList.add('ccx-open');
    ui.gearBtn.setAttribute('aria-expanded', 'true');
  }

  function closePanel() {
    ui.panel.classList.remove('ccx-open');
    ui.gearBtn.setAttribute('aria-expanded', 'false');
  }

  function setPillBusy(state) {
    if (!ui.copyBtn || !ui.copyLabel) return;
    ui.copyBtn.disabled = state;
    ui.copyLabel.textContent = state ? 'Copying\u2026' : 'Copy chat';
  }

  /* ═══════════════════ 10. PER-EXCHANGE BUTTON INJECTION ════════════════════ */

  /**
   * Claude renders one action bar per message: `[role=group][aria-label="Message
   * actions"]`. Assistant bars contain a feedback (thumbs-up) button; human bars
   * contain edit instead. We append a small "copy exchange" button to every
   * assistant bar, remembering its ordinal so clicks map to the API thread.
   */
  function scanGroups() {
    if (!document.body || document.hidden) return;
    const groups = document.querySelectorAll(SEL.actionsGroup);
    if (!groups.length) return;

    let assistantOrdinal = 0;
    let injected = 0;

    for (const group of groups) {
      const isAssistant = !!group.querySelector(SEL.feedbackBtn);
      if (!isAssistant) continue;
      const ordinal = assistantOrdinal++;

      // already has our button? (React reuses nodes; our button persists)
      if (group.querySelector('.ccx-ex-btn')) continue;

      const btn = el('button', {
        class: 'ccx-ex-btn',
        type: 'button',
        title: 'Copy this prompt + Claude\u2019s response as Markdown',
        'aria-label': 'Copy exchange as Markdown',
      });
      btn.innerHTML = ICONS.copySm;
      btn.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        btn.classList.add('ccx-busy');
        copyExchange(ordinal).finally(() => btn.classList.remove('ccx-busy'));
      });
      group.appendChild(btn);
      injected++;
    }

    if (injected && !convCache.data) {
      // warm the cache so first click feels instant
      getConversation(false).catch(() => { /* silent — surfaced on click */ });
    }
  }

  function scheduleScan() {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scanGroups, SCAN_DEBOUNCE_MS);
  }

  /* ═════════════════════════════ 11. OBSERVERS & LIFECYCLE ══════════════════ */

  function updatePillVisibility() {
    if (!ui.root) return;
    const onConversation = !!getRoute();
    ui.root.classList.toggle('ccx-hidden', !onConversation);
    if (!onConversation) closePanel();
  }

  function onRouteChange() {
    convCache.key = null;
    convCache.at = 0;
    convCache.data = null;
    updatePillVisibility();
    scheduleScan();
    log('route changed →', window.location.pathname);
  }

  function startObservers() {
    // DOM changes → (re)inject per-exchange buttons (debounced)
    const bodyObserver = new MutationObserver(scheduleScan);
    bodyObserver.observe(document.body, { childList: true, subtree: true });

    // SPA navigation: claude.ai never reloads the page, so watch the URL
    let lastHref = window.location.href;
    const checkUrl = () => {
      if (window.location.href !== lastHref) {
        lastHref = window.location.href;
        onRouteChange();
      }
    };
    const urlObserver = new MutationObserver(checkUrl);
    urlObserver.observe(document.documentElement, { childList: true, subtree: true });
    window.addEventListener('popstate', checkUrl);
  }

  function registerMenu() {
    if (typeof GM_registerMenuCommand !== 'function') return;
    try {
      GM_registerMenuCommand('⧉ Copy whole conversation', copyWholeConversation);
      GM_registerMenuCommand('⚙ Copy settings', togglePanel);
      GM_registerMenuCommand('💭 Toggle thinking blocks', () => {
        savePref('includeThinking', !prefs.includeThinking);
        toast(`Thinking blocks will be ${prefs.includeThinking ? 'included' : 'left out'}`);
      });
    } catch (e) { console.warn(LOG, 'menu registration failed', e); }
  }

  function init() {
    if (!document.body) {
      setTimeout(init, 200);
      return;
    }
    injectStyles();
    buildUI();
    updatePillVisibility();
    startObservers();
    registerMenu();
    scanGroups();
    log('v' + VERSION + ' ready \u2014 look for the pill in the bottom-right corner');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
