import { getSettings, getEffectiveRouterCampaignPrefix } from './state-manager.js';
import { sendStateRequest, sendAgentTurn } from './llm-client.js';
import { getRequestHeaders } from '../../../../script.js';

let _routerRunning = false;
let _routerNormalRunCount = 0; // tracks completed normal (non-cleanup) passes for auto-cleanup interval

/** Returns true while a router pass is actively running. */
export function isRouterRunning() { return _routerRunning; }

/**
 * Returns the current campaign prefix (user override in settings, else chat id).
 * Returns '' only if there is no usable prefix.
 */
function getLivePrefix() {
    const ctx = SillyTavern.getContext();
    return getEffectiveRouterCampaignPrefix(ctx.chatId || '');
}

/**
 * Returns true if `bookName` belongs to the given `prefix`.
 * Exact match: bookName === prefix, OR bookName === prefix + '_' + <single-word suffix>
 * (suffix must contain no underscores to prevent "Assistant" from matching
 * "Assistant_2026_05_13_NPCs" which belongs to a different longer prefix).
 * @param {string} bookName
 * @param {string} prefix
 */
function bookBelongsToPrefix(bookName, prefix) {
    if (!prefix) return false;
    if (bookName === prefix) return true;
    const rest = bookName.startsWith(prefix + '_') ? bookName.slice(prefix.length + 1) : null;
    return rest !== null && !rest.includes('_');
}

/**
 * Parses a single Action: toolname({...}) call from a text response.
 * Used as a fallback for profile/default connections that don't support native tool calling.
 * Safe because the caller always passes a single-turn response (multi-turn messages mean
 * the model never echoes prior turns, so only one action appears in the text).
 *
 * @param {string} text
 * @returns {{name: string, args: object, id: string} | null}
 */
function parseTextAction(text) {
    // Find the last "Action:" line to be safe, then extract the balanced JSON argument.
    const parts = ('\n' + text).split(/\nAction:\s*/i);
    if (parts.length < 2) return null;
    const lastPart = parts[parts.length - 1].trim();

    // Extract the tool name
    const nameMatch = lastPart.match(/^(\w+)\s*\(/);
    if (!nameMatch) return null;
    const name = nameMatch[1].toLowerCase();

    // Extract balanced-paren args starting after the tool name
    const parenStart = lastPart.indexOf('(');
    if (parenStart === -1) return null;
    let depth = 0, end = -1;
    for (let i = parenStart; i < lastPart.length; i++) {
        if (lastPart[i] === '(') depth++;
        else if (lastPart[i] === ')') { depth--; if (depth === 0) { end = i; break; } }
    }
    const rawArgs = end !== -1 ? lastPart.slice(parenStart + 1, end) : lastPart.slice(parenStart + 1);

    // For tools that take a bare string (grep_lore, inspect_book, read_entry), wrap in object
    let args;
    try {
        // Try JSON first
        let cleaned = rawArgs.trim();
        if (!cleaned.startsWith('{') && !cleaned.startsWith('[')) {
            // Bare string argument like grep_lore("Iron Syndicate")
            cleaned = cleaned.replace(/^['"]|['"]$/g, '');
            const argNames = { grep_lore: 'query', inspect_book: 'book_name', read_entry: 'uid' };
            args = { [argNames[name] || 'value']: cleaned };
        } else {
            cleaned = cleaned.replace(/,\s*\}/g, '}').replace(/,\s*\]/g, ']');
            args = JSON.parse(cleaned);
        }
    } catch (_) {
        return null;
    }

    return { name, args, id: `text_${Date.now()}` };
}

/**
 * Broadcasts an agent step to the UI for the Terminal view.
 */
function broadcastStep(type, content, metadata = {}) {
    document.dispatchEvent(new CustomEvent('rt_lore_agent_step', {
        detail: { type, content, metadata, timestamp: Date.now() }
    }));
}

/**
 * Compatibility helper for older SillyTavern versions.
 */
async function getWorldInfoNamesSafe() {
    const ctx = SillyTavern.getContext();
    if (typeof ctx.getWorldInfoNames === 'function') {
        return await ctx.getWorldInfoNames();
    }
    // Fallback for older versions
    if (typeof ctx.getLorebookList === 'function') {
        return await ctx.getLorebookList();
    }
    // Deep fallback
    return [];
}

/**
 * Builds the summary "Keyring" text for archive (inactive) entries only.
 * Active entries are excluded to avoid double-listing them in the agent context.
 * @param {object} allBooks
 * @param {string[]} activeKeys - IDs currently in activeRouterKeys (Book::uid format).
 */
function buildKeyringText(allBooks, activeKeys = []) {
    const activeSet = new Set(activeKeys);
    let lines = [];
    for (const [bookName, bookData] of Object.entries(allBooks)) {
        if (!bookData || !bookData.entries) continue;
        for (const [uid, entry] of Object.entries(bookData.entries)) {
            if (activeSet.has(`${bookName}::${uid}`)) continue; // shown in ACTIVE MEMORY
            const keys = (entry.key || []).join(', ');
            lines.push(`[ARCHIVE] Label: ${entry.comment || entry.key?.[0] || 'Unnamed'} | Keys: [${keys}]`);
        }
    }
    return lines.join('\n');
}

/**
 * The core Researcher Agent loop.
 */
export async function runRouterPass(narrativeOutput, manualPrompt = null, customLookback = null, isManual = false, newlyTriggeredIds = []) {
    const settings = getSettings();
    if (!settings.routerEnabled || _routerRunning) return;
    // routerPaused blocks auto-runs only; manual UI runs always go through
    if (settings.routerPaused && !isManual) return;

    const ctx = SillyTavern.getContext();
    if (!ctx.generateRaw) return;

    try {
        _routerRunning = true;
        broadcastStep('start', 'Initializing Lorebook Agent...');

        const startTime = Date.now();
        const prefix = getLivePrefix();
        if (!prefix) {
            broadcastStep('error', 'Cannot run: no campaign prefix available. The chat name may not have loaded yet ? try again in a moment.');
            _routerRunning = false;
            return;
        }
        let basicSummary = '';
        
        async function fetchArchiveBooks() {
            // Flush ST's in-memory registry so books written via HTTP API in prior passes are visible
            if (typeof ctx.updateWorldInfoList === 'function') {
                try { await ctx.updateWorldInfoList(); } catch (_) {}
            }
            const allBookNames = await getWorldInfoNamesSafe();
            const inScope = (n) => !prefix || bookBelongsToPrefix(n, prefix);
            const scoped = new Set(prefix ? allBookNames.filter(inScope) : allBookNames);

            // Also sweep books referenced in routerLog (catches books not yet formally indexed)
            const logBookNames = (settings.routerLog || [])
                .flatMap(e => [...(e.record || []), ...(e.activate || [])].map(id => id.split('::')[0]))
                .filter(Boolean);
            for (const n of logBookNames) {
                if (inScope(n)) scoped.add(n);
            }

            const books = {};
            for (const n of scoped) {
                const b = await ctx.loadWorldInfo(n);
                if (b?.entries) books[n] = b;
            }
            return books;
        }

        let archiveBooks = await fetchArchiveBooks();

        // ?? Snapshot state BEFORE this pass (for rollback) ??????????????????
        {
            const snapshot = {
                timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                /** SillyTavern chat id when this snapshot was taken — rollback must refuse if the user switched chats. */
                chatId: ctx.chatId || '',
                /** Campaign prefix at snapshot time — catches prefix-override changes. */
                campaignPrefix: prefix,
                activeRouterKeys: JSON.parse(JSON.stringify(settings.activeRouterKeys || [])),
                bookSnapshots: {}
            };
            for (const [name, book] of Object.entries(archiveBooks)) {
                snapshot.bookSnapshots[name] = JSON.parse(JSON.stringify(book));
            }
            if (!settings.routerHistory) settings.routerHistory = [];
            settings.routerHistory.unshift(snapshot);
            if (settings.routerHistory.length > 5) settings.routerHistory.length = 5;
            ctx.saveSettingsDebounced();
        }
        let activeEntriesFull = [];
        let newlyTriggeredFull = [];

        const triggeredSet = new Set(newlyTriggeredIds);

        function updateActiveEntries() {
            activeEntriesFull = [];
            newlyTriggeredFull = [];
            for (const [name, book] of Object.entries(archiveBooks)) {
                for (const [uid, entry] of Object.entries(book.entries)) {
                    const fullId = `${name}::${uid}`;
                    if (settings.activeRouterKeys?.includes(fullId)) {
                        const label = entry.comment || entry.key?.[0] || fullId;
                        const block = `### [ACTIVE] ${label}\nID: ${fullId}\nContent: ${entry.content}`;
                        if (triggeredSet.has(fullId)) {
                            newlyTriggeredFull.push(block);
                        } else {
                            activeEntriesFull.push(block);
                        }
                    }
                }
            }
        }
        updateActiveEntries();

        let keyringText = buildKeyringText(archiveBooks, settings.activeRouterKeys);
        const { chat } = ctx;
        
        const N = customLookback !== null ? customLookback : (settings.routerLookback || 4);
        const recentChat = chat.slice(-N).map(m => {
            const name = (/** @type {any} */ (m)).is_user ? 'Player' : ((/** @type {any} */ (m)).name || 'Narrator');
            const content = (/** @type {any} */ (m)).mes || (/** @type {any} */ (m)).content || '';
            return `${name}: ${content.replace(/<[^>]+>/g, '')}`;
        }).join('\n\n');

        // Extract Current Context (Time & Location)
        const timeRegex = /([0-9]{1,2}:[0-9]{2}\s*[AP]M,\s*Day\s*[0-9]+)/i;
        const narrativeTimeMatch = recentChat.match(timeRegex);
        const memoTimeMatch = settings.currentMemo?.match(/\[TIME\]([\s\S]*?)\[\/TIME\]/i);
        const cleanMemoTime = memoTimeMatch ? memoTimeMatch[1].split('\n')[0].trim() : '';
        const currentTime = narrativeTimeMatch ? narrativeTimeMatch[1] : cleanMemoTime;

        const locationRegex = /\(Location:\s*([^)]+)\)/i;
        const locMatch = recentChat.match(locationRegex);
        const currentHierarchy = locMatch ? locMatch[1].trim() : '';
        const breadcrumb = currentHierarchy ? currentHierarchy.replace(/,\s*/g, ' :: ') : '';

        // 2. The Loop
        let turns = 0;
        const maxTurns = settings.routerMaxTurns || 5;
        let basicSummaryText = '';

        const routerSettings = {
            ...settings,
            connectionSource: settings.routerConnectionSource || 'default',
            connectionProfileId: settings.routerConnectionProfileId,
            completionPresetId: settings.routerCompletionPresetId,
            ollamaUrl: settings.routerOllamaUrl,
            ollamaModel: settings.routerOllamaModel,
            openaiUrl: settings.routerOpenaiUrl,
            openaiKey: settings.routerOpenaiKey,
            openaiModel: settings.routerOpenaiModel,
            maxTokens: (settings.routerMaxTokens !== undefined && settings.routerMaxTokens !== null && settings.routerMaxTokens !== '') ? Number(settings.routerMaxTokens) : 1000,
        };

        // Budget status — computed once and reused in both basic and agent context
        const activeCount = settings.activeRouterKeys?.length || 0;
        const maxActive = settings.routerMaxActivations || 8;
        const overflow = activeCount - maxActive;
        const budgetLine = `Active entries: ${activeCount} / ${maxActive}`;
        const overflowInstruction = overflow > 0
            ? `\nBUDGET VIOLATION: ${activeCount} entr${activeCount !== 1 ? 'ies' : 'y'} active, limit is ${maxActive}. ` +
              `You MUST deactivate at least ${overflow} entr${overflow > 1 ? 'ies' : 'y'} ` +
              `before this pass ends. Eliminate the narratively least relevant entries first. ` +
              `Justify each deactivation.`
            : '';

        const basePrompt = (settings.routerSystemPromptTemplate || 'You are the Lorebook Agent. Maintain narrative consistency and manage lorebooks.')
            .replace(/\{\{campaignRoot\}\}/g, prefix || 'World Chronicle')
            .replace(/\{\{user\}\}/g, ctx.name1 || 'User');

        // ── Cleanup Mode ─────────────────────────────────────────────────────
        // Triggered by the UI broom button via runRouterPass(null, '__CLEANUP__', null, true).
        // ── Cleanup Mode ─────────────────────────────────────────────────────
        // Triggered by the UI broom button or Clean per-entry buttons.
        // Bypasses all normal research logic; uses stripped prompts and rewrite/consolidate only.
        const isCleanupPass = isManual && (manualPrompt || '').startsWith('__CLEANUP__');
        const CLEANUP_TOKEN_THRESHOLD = settings.routerCleanupTokenThreshold || 300; // ~1200 chars — entries larger than this are flagged

        if (isCleanupPass) {
            let targetEntryId = null;
            let customInstructions = null;

            // Format parser:
            // __CLEANUP__::[BookName]::[UID]::[Instructions]
            // Or: __CLEANUP__::::[Instructions]
            const cleanupParts = manualPrompt.split('::');
            if (cleanupParts.length > 1) {
                const b = cleanupParts[1]?.trim();
                const u = cleanupParts[2]?.trim();
                if (b && u) {
                    targetEntryId = `${b}::${u}`;
                }
                // Custom instructions is everything after target, or after double colon
                if (b && u && cleanupParts.length >= 4) {
                    customInstructions = cleanupParts.slice(3).join('::').trim();
                } else if (!b && !u && cleanupParts.length >= 3) {
                    customInstructions = cleanupParts.slice(2).join('::').trim();
                }
            }

            if (targetEntryId) {
                broadcastStep('thought', `Cleanup mode: targeted compression for "${targetEntryId}"...`);
            } else {
                broadcastStep('thought', 'Cleanup mode: scanning for bloated entries...');
            }

            const flagged = [];
            for (const [bookName, book] of Object.entries(archiveBooks)) {
                if (!book?.entries) continue;
                for (const [uid, entry] of Object.entries(book.entries)) {
                    const fullId = `${bookName}::${uid}`;
                    const tokens = estimateTokens(entry.content);
                    const useThreshold = settings.routerCleanupUseThreshold !== false;
                    const isTarget = targetEntryId && fullId === targetEntryId;
                    const overThreshold = !useThreshold || tokens >= CLEANUP_TOKEN_THRESHOLD;

                    if (isTarget || (!targetEntryId && overThreshold)) {
                        const lines = (entry.content || '').split('\n').filter(Boolean).length;
                        const pairs = countRedundantPairs(entry.content);
                        const label = entry.comment || entry.key?.[0] || uid;
                        flagged.push({ id: fullId, tokens, lines, pairs, label, content: entry.content });
                    }
                }
            }

            if (flagged.length === 0) {
                const noFoundMsg = targetEntryId
                    ? `Cleanup: targeted entry "${targetEntryId}" not found.`
                    : settings.routerCleanupUseThreshold !== false
                        ? `Cleanup: no entries exceed the token threshold (${CLEANUP_TOKEN_THRESHOLD}t). Nothing to do.`
                        : `Cleanup: no entries found in the campaign lorebook. Nothing to do.`;
                broadcastStep('finish', noFoundMsg);
                _routerRunning = false;
                return;
            }

            // Sort worst-first so the model prioritises high-impact entries
            flagged.sort((a, b) => b.tokens - a.tokens);
            if (targetEntryId) {
                broadcastStep('thought', `Cleanup: compressing target entry "${flagged[0].label}"...`);
            } else {
                broadcastStep('thought', `Cleanup: ${flagged.length} bloated entr${flagged.length === 1 ? 'y' : 'ies'} found. Requesting compression...`);
            }

            // Build context: metadata list + full content of flagged entries
            const cleanupContext =
                `## ENTRIES FLAGGED FOR CONSOLIDATION\n` +
                flagged.map(e =>
                    `- ${e.id} | "${e.label}" | ~${e.tokens} tokens | ${e.lines} lines` +
                    (e.pairs > 0 ? ` | ⚠ ${e.pairs} redundant line pairs` : ` | ✓ low redundancy`)
                ).join('\n') +
                `\n\n## ENTRY CONTENTS\n` +
                flagged.map(e => `### ${e.id} — "${e.label}"\n${e.content}`).join('\n\n');

            let basicInstructionPrompt = `You are the Lorebook Archivist. Consolidate the bloated entries shown below.

## AVAILABLE TAGS
- [[REWRITE: BookName::UID | new canonical content]]
  Replace a single entry's content with a compressed version.

- [[CONSOLIDATE: TargetID1, TargetID2 | SurvivorID | merged content]]
  Merge two or more duplicate entries into one. All targets are deleted.
  Targets and survivors may be in different books.

## RULES
1. Merge all timestamped updates into a single coherent, present-tense description.
2. Preserve plot-significant changes as brief dated notes (e.g. "Burned down on Day 12").
3. Remove redundant observations — if six updates repeat the same fact, write it once.
4. Preserve every unique fact. When in doubt, keep it.
5. Target 30–60% of the original token count.
6. Do NOT activate, deactivate, record, or delete entries except via CONSOLIDATE targets.
7. Output your reasoning first, then the tags.`;

            let agentInstructionPrompt = `You are the Lorebook Archivist. Consolidate bloated lorebook entries using the tools provided.

## YOUR TASK
For each flagged entry:
1. Call read_entry to inspect its content if needed.
2. Decide: rewrite in place (rewrite), or merge with a duplicate (consolidate).
3. When done, call commit once with all rewrite and consolidate operations.

## RULES
1. Merge timestamped updates into a single coherent, present-tense description.
2. Preserve plot-significant changes as brief dated notes (e.g. "Burned down on Day 12").
3. Remove redundant observations. Preserve every unique fact.
4. Target 30–60% of the original token count per entry.
5. Do NOT activate, deactivate, record, or create new entries.
6. Call commit exactly once at the end. Do not call it per-entry.`;

            if (customInstructions) {
                const overrideText = `\n\n## USER CUSTOM REQUIREMENTS\nYou MUST adhere strictly to these custom compression instructions:\n- ${customInstructions}`;
                basicInstructionPrompt += overrideText;
                agentInstructionPrompt += overrideText;
            }

            // Determine routing mode here so we can shape the cleanup system prompt accordingly.
            // Profile/default connections don't support native tool schemas; use text-format actions.
            const usesNativeToolsForCleanup = ['openai', 'ollama'].includes(routerSettings.connectionSource);

            const cleanupSystemPrompt = settings.routerBasicMode
                ? basicInstructionPrompt
                : (usesNativeToolsForCleanup
                    // Native tool-call path — model receives JSON schemas via the API
                    ? agentInstructionPrompt
                    // Text-format path for profile/default — model must output Action: lines
                    : agentInstructionPrompt + `

## ACTIONS
You do NOT have access to native function calling. Output exactly ONE action per turn in plain text:
  Action: toolname({"arg": "value"})

Available actions:
- read_entry({"uid": "Book::0"}) — read the full content of an entry
- commit({"rewrite": [...], "consolidate": [...]}) — write all cleanup changes and finish

commit rewrite items: {"id": "Book::UID", "content": "compressed content"}
commit consolidate items: {"targets": ["Book::UID1"], "survivor": "Book::UID2", "content": "merged content"}

## EXAMPLE
Thought: The entry is verbose. I will rewrite it with the key facts.
Action: commit({"rewrite": [{"id": "Eldoria_Events::3", "content": "Compressed version of the entry."}]})`
                );

            if (settings.routerBasicMode) {
                const cleanupUserPrompt = cleanupContext;
                broadcastStep('thought', 'Thinking...');
                const basicResp = await sendStateRequest(routerSettings, cleanupSystemPrompt, cleanupUserPrompt);
                const thoughtMatchC = basicResp.match(/(?:Thought|Reasoning):\s*([\s\S]*?)(?=\[\[|$)/i);
                if (thoughtMatchC) broadcastStep('thought', thoughtMatchC[1].trim().substring(0, 300));
                broadcastStep('thought', 'Parsing cleanup tags...');
                const cleanupAction = parseBasicTags(basicResp, archiveBooks);
                cleanupAction.reason = targetEntryId ? `Targeted cleanup: ${targetEntryId}.` : 'Cleanup pass (basic mode).';
                if (cleanupAction.rewrite.length > 0 || cleanupAction.consolidate.length > 0) {
                    await applyAction(cleanupAction, archiveBooks, currentTime, breadcrumb);
                    const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
                    broadcastStep('finish', `Cleanup done in ${totalTime}s — ${cleanupAction.rewrite.length} rewritten, ${cleanupAction.consolidate.length} consolidated.`);
                } else {
                    broadcastStep('finish', 'Cleanup: agent found nothing to compress.');
                }
                _routerRunning = false;
                return;
            }

            // Agent mode: lean context (metadata only) — agent uses read_entry per-entry
            const agentCleanupContext = `## ENTRIES FLAGGED FOR CLEANUP\n` +
                flagged.map(e =>
                    `- ${e.id} | "${e.label}" | ~${e.tokens} tokens | ${e.lines} lines` +
                    (e.pairs > 0 ? ` | ⚠ ${e.pairs} redundant pairs` : '')
                ).join('\n');

            const usesNativeTools = usesNativeToolsForCleanup;
            // Text-format connections get full entry content upfront (one-shot commit, no read_entry turn needed).
            // Native tool connections get lean metadata and can use read_entry to pull content on demand.
            const cleanupMessages = [
                { role: 'system', content: cleanupSystemPrompt },
                { role: 'user',   content: usesNativeTools ? agentCleanupContext : cleanupContext }
            ];

            /** @type {Array<object>} */
            const cleanupAgentTools = [
                {
                    type: 'function',
                    function: {
                        name: 'grep_lore',
                        description: `Search all lorebooks in scope ("${prefix || 'All'}") for entries whose content or label contains the query.`,
                        parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }
                    }
                },
                {
                    type: 'function',
                    function: {
                        name: 'inspect_book',
                        description: 'List all entry labels and UIDs in a specific lorebook.',
                        parameters: { type: 'object', properties: { book_name: { type: 'string' } }, required: ['book_name'] }
                    }
                },
                {
                    type: 'function',
                    function: {
                        name: 'read_entry',
                        description: 'Read the full content of a lorebook entry.',
                        parameters: { type: 'object', properties: { uid: { type: 'string', description: 'Entry UID in "BookName::0" format.' } }, required: ['uid'] }
                    }
                },
                {
                    type: 'function',
                    function: {
                        name: 'commit',
                        description: 'Write all cleanup changes and finish. Call exactly once at the end.',
                        parameters: {
                            type: 'object',
                            properties: {
                                rewrite: {
                                    type: 'array',
                                    description: 'Full content replacements for bloated entries.',
                                    items: {
                                        type: 'object',
                                        properties: {
                                            id:      { type: 'string', description: 'Book::UID of the entry to rewrite.' },
                                            content: { type: 'string', description: 'New canonical content.' }
                                        },
                                        required: ['id', 'content']
                                    }
                                },
                                consolidate: {
                                    type: 'array',
                                    description: 'Merge multiple entries into one. Targets are deleted.',
                                    items: {
                                        type: 'object',
                                        properties: {
                                            targets:  { type: 'array', items: { type: 'string' }, description: 'Book::UID IDs to delete after merging.' },
                                            survivor: { type: 'string', description: 'Book::UID to keep.' },
                                            content:  { type: 'string', description: 'Merged content for survivor.' }
                                        },
                                        required: ['targets', 'survivor', 'content']
                                    }
                                }
                            }
                        }
                    }
                }
            ];

            let cleanupTurns = 0;
            while (cleanupTurns < maxTurns) {
                cleanupTurns++;
                broadcastStep('thought', `Cleanup thinking (Turn ${cleanupTurns}/${maxTurns})...`);
                const result = await sendAgentTurn(routerSettings, cleanupMessages, usesNativeTools ? cleanupAgentTools : null);

                if (result.content) {
                    const thoughtLine = result.content.match(/(?:Thought|Reasoning):\s*(.*)/i)?.[1]?.trim()
                        || result.content.trim().split('\n')[0];
                    if (thoughtLine) broadcastStep('thought', thoughtLine.substring(0, 200));
                }

                let resolvedToolCall = result.toolCall;
                if (!resolvedToolCall && result.content) {
                    resolvedToolCall = parseTextAction(result.content);
                }
                if (!resolvedToolCall) break;

                const { name: toolName, args } = resolvedToolCall;
                const callId = /** @type {any} */ (resolvedToolCall).id || `call_cleanup_${Date.now()}_${cleanupTurns}`;
                broadcastStep('tool', `${toolName}(...)`);

                cleanupMessages.push({
                    role: 'assistant',
                    content: result.content || null,
                    tool_calls: [{ id: callId, type: 'function', function: { name: toolName, arguments: JSON.stringify(args) } }]
                });

                let observation = '';
                if (toolName === 'commit') {
                    args.reason = targetEntryId ? `Targeted cleanup: ${targetEntryId}.` : 'Cleanup pass (agent mode).';
                    const commitResult = await applyAction(args, archiveBooks, currentTime, breadcrumb);
                    archiveBooks = await fetchArchiveBooks();
                    if (commitResult.errors.length > 0) {
                        observation = `Committed with warnings: ${commitResult.errors.join(', ')}`;
                    } else {
                        const details = [];
                        if (args.rewrite?.length)     details.push(`Rewritten: ${args.rewrite.length}`);
                        if (args.consolidate?.length) details.push(`Consolidated: ${args.consolidate.length}`);
                        observation = `Committed successfully. ${details.join(' | ')}`;
                    }
                } else if (toolName === 'read_entry') {
                    const uid = args.uid || '';
                    const [bookName, id] = uid.split('::');
                    const book = await ctx.loadWorldInfo(bookName);
                    observation = book?.entries?.[id] ? book.entries[id].content : `Entry "${uid}" not found.`;
                } else if (toolName === 'grep_lore') {
                    const query = (args.query || '').toLowerCase();
                    const hits = [];
                    for (const [name, book] of Object.entries(archiveBooks)) {
                        for (const [uid, entry] of Object.entries(book.entries)) {
                            if ((entry.content || '').toLowerCase().includes(query) || (entry.comment || '').toLowerCase().includes(query)) {
                                hits.push(`[${name}::${uid}] "${entry.comment || uid}": ${(entry.content || '').substring(0, 120)}...`);
                            }
                        }
                    }
                    observation = hits.length > 0 ? hits.join('\n') : `No entries found for "${args.query}".`;
                } else if (toolName === 'inspect_book') {
                    const bookName = args.book_name || '';
                    if (archiveBooks[bookName]) {
                        observation = Object.entries(archiveBooks[bookName].entries)
                            .map(([uid, e]) => `${bookName}::${uid} -- ${e.comment || e.key?.[0] || uid}`)
                            .join('\n');
                    } else {
                        observation = `Book "${bookName}" not found.`;
                    }
                } else {
                    observation = `Unknown tool: ${toolName}`;
                }

                broadcastStep('result', observation.substring(0, 200) + (observation.length > 200 ? '...' : ''));
                cleanupMessages.push({
                    role: 'tool',
                    tool_call_id: cleanupMessages[cleanupMessages.length - 1].tool_calls[0].id,
                    content: observation
                });

                if (toolName === 'commit') break;
            }

            const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
            broadcastStep('finish', `Cleanup done in ${totalTime}s.`);
            _routerRunning = false;
            return;
        }
        // ── End Cleanup Mode ──────────────────────────────────────────────────

        // -- Basic Mode (tag-based, one-shot, no tool calling) -----------------
        if (settings.routerBasicMode) {

            const modules = settings.routerModules || {};
            const customTags = settings.routerCustomTags || [];
            const formatLines = [];
            for (const config of Object.values(modules)) {
                if (config.enabled) formatLines.push(`- [[${config.tag}: ${config.format}]] (${config.instruction})`);
            }
            for (const custom of customTags) {
                formatLines.push(`- [[${custom.tag}: ${custom.format || 'Name | Description | Keywords'}]] (${custom.instruction})`);
            }
            formatLines.push(`- [[ACTIVATE: Name]] (Bring entry to active memory)`);
            formatLines.push(`- [[DEACTIVATE: Name]] (Remove from active memory)`);
            formatLines.push(`- [[DELETE: Name]] (Permanently remove an entry)`);

            const basicSystemPrompt = `You are the Research Assistant. Your task is to identify and record important narrative entities and events.

## FORMAT
Use these tags in your response:
${formatLines.join('\n')}

## HIERARCHY CONVENTION (CRITICAL FOR LOCATIONS)
For LOC entries, the Name field MUST be the FULL hierarchical path using " :: " (space, colon, colon, space) as the separator.
The current scene's location stack is shown above as "CURRENT LOCATION". Prepend it to any sub-location you record.

Examples:
  CURRENT LOCATION: Khelt :: Rust-Lantern District
  --> [[LOC: Khelt :: Rust-Lantern District :: Marrow-Deep Mines Office | A squat iron building managing mining contracts. | mines, contracts, Khelt, Rust-Lantern]]
  --> [[LOC: Khelt :: Rust-Lantern District :: The Guilded Anvil Tavern | A noisy tavern with a job bulletin board. | tavern, jobs, Khelt, Rust-Lantern]]

Also include each ancestor name (Khelt, Rust-Lantern District) as a plain keyword in the Keywords field.

NPC / FAC / QUEST / EVENT labels: Name only ? NO " :: " hierarchy, NO tag prefix.
Example: [[FAC: Iron Syndicate | ...]]  NOT  [[FAC: Khelt :: Iron Syndicate | ...]]  and  NOT  [[FAC: FAC: Iron Syndicate | ...]]

**FAC** uses four fields: \`Name | Status | Description | Keywords\`. Put a concise current-state line in **Status** (standing, conflicts, recent changes); put history, ideology, schemes, and members in **Description**.

## ATTENTION & MEMORY
1. **NEWLY ACTIVATED THIS TURN**: Entries whose keywords appeared in the latest narrator output are pre-loaded here with full content. You do not need to activate them again — they are already active.
2. **ACTIVE MEMORY**: Full details of all other currently active entities. You can update them at any time.
3. **ARCHIVE INDEX**: Inactive entries — labels and keywords only. You CANNOT see their full biography.
4. **RECALL**: To read or update an archive entry, use [[ACTIVATE: Name]]. Its full content becomes visible next turn.
5. **LIMIT**: You are limited to **${settings.routerMaxActivations || 8} active entries**. Nothing is archived automatically. If you exceed this limit you will see a **BUDGET VIOLATION** line and you MUST use [[DEACTIVATE: Name]] on the least relevant active entries to return within budget before this pass ends.

## RULES
1. Only record persistent or significant entities/events.
2. Use ACTIVATE to bring an existing entry into the current scene context.
3. Use DEACTIVATE to remove an entry that is no longer relevant to the scene.
4. Use DELETE to permanently remove duplicate or redundant entries.
5. Output your thoughts first, then the tags.

Example:
Thought: I see a new NPC named Barnaby in Khelt's Rust-Lantern District. I will record him and the tavern.
[[NPC: Barnaby | A retired blacksmith with a scar on his cheek. | Barnaby, blacksmith, ally]]
[[LOC: Khelt :: Rust-Lantern District :: Barnaby's Forge | Barnaby's old workshop, still smelling of soot. | forge, Khelt, Rust-Lantern]]
[[FAC: Iron Syndicate | Wary of outsiders after the forge raid; still dominant in the industrial quarter. | Founded by ex-mercenaries forty years ago; controls scrap tariffs and smuggling. Lieutenant Marna Voss handles street enforcement. | Iron Syndicate, Khelt, faction, smuggling]]`;

            const questMatchB = settings.currentMemo?.match(/\[QUESTS\]([\s\S]*?)\[\/QUESTS\]/i);
            const questBlockB = questMatchB ? `[QUESTS]${questMatchB[1].trim()}[/QUESTS]` : 'None';
            const basicUserPrompt = `## BUDGET STATUS\n${budgetLine}${overflowInstruction}\n\n## NEWLY ACTIVATED THIS TURN\n${newlyTriggeredFull.join('\n\n') || 'None.'}\n\n## ACTIVE MEMORY (Lore)\n${activeEntriesFull.join('\n\n') || 'None.'}\n\n## ARCHIVE INDEX\n${keyringText || 'Empty.'}\n\n## CURRENT LOCATION\n${currentHierarchy || 'Unknown'}\n\n## ACTIVE QUESTS\n${questBlockB}\n\n## NARRATIVE\n${recentChat}\n\n${manualPrompt ? `## INSTRUCTION\n${manualPrompt}\n\n` : ''}`;

            broadcastStep('thought', 'Thinking...');
            const basicResp = await sendStateRequest(routerSettings, basicSystemPrompt, basicUserPrompt);

            const thoughtMatchB = basicResp.match(/Thought:\s*([\s\S]*?)(?=\[\[|$)/i);
            if (thoughtMatchB) broadcastStep('thought', thoughtMatchB[1].trim());
            broadcastStep('thought', 'Parsing tags...');
            const basicAction = parseBasicTags(basicResp, archiveBooks);

            if (basicAction.record.length > 0 || basicAction.update.length > 0 || basicAction.activate.length > 0 || basicAction.delete_ids?.length > 0) {
                const summaries = [];
                if (basicAction.record.length) summaries.push(`New: ${basicAction.record.length}`);
                if (basicAction.update.length) summaries.push(`Updates: ${basicAction.update.length}`);
                if (basicAction.activate.length) summaries.push(`Activations: ${basicAction.activate.length}`);
                basicAction.reason = (thoughtMatchB ? thoughtMatchB[1].trim() : 'Tag-based update.') + ` (${summaries.join(', ')})`;
                await applyAction(basicAction, archiveBooks, currentTime, breadcrumb);
                basicSummaryText = summaries.join(', ');
            } else {
                broadcastStep('finish', 'Basic Mode: No tags found.');
            }

        } else {
            // -- Agent Mode (native tool calling, multi-turn messages) ----------

            // Build the commit tool's category enum from enabled modules + custom tags
            const validCategories = [
                ...Object.values(settings.routerModules || {}).filter(m => m.enabled).map(m => m.tag.toUpperCase()),
                ...(settings.routerCustomTags || []).map(t => t.tag.toUpperCase()),
            ];
            const categoryEnum = validCategories.length ? validCategories : ['NPC', 'LOC', 'QUEST', 'FAC', 'EVENT'];

            /** @type {Array<object>} */
            const agentTools = [
                {
                    type: 'function',
                    function: {
                        name: 'grep_lore',
                        description: `Search all lorebooks in scope ("${prefix || 'All'}") for entries whose content or label contains the query.`,
                        parameters: {
                            type: 'object',
                            properties: { query: { type: 'string', description: 'Keyword or phrase to search for.' } },
                            required: ['query']
                        }
                    }
                },
                {
                    type: 'function',
                    function: {
                        name: 'inspect_book',
                        description: 'List all entry labels and UIDs in a specific lorebook.',
                        parameters: {
                            type: 'object',
                            properties: { book_name: { type: 'string', description: 'Exact lorebook name (e.g. "Eldoria_Factions").' } },
                            required: ['book_name']
                        }
                    }
                },
                {
                    type: 'function',
                    function: {
                        name: 'read_entry',
                        description: 'Read the full content of a lorebook entry.',
                        parameters: {
                            type: 'object',
                            properties: { uid: { type: 'string', description: 'Entry UID in "BookName::0" format.' } },
                            required: ['uid']
                        }
                    }
                },
                {
                    type: 'function',
                    function: {
                        name: 'commit',
                        description: 'Write all changes to the lorebook and finish the research pass. The ONLY way to persist data.',
                        parameters: {
                            type: 'object',
                            properties: {
                                record: {
                                    type: 'array',
                                    description: 'New entries to create. Recording an entry with an existing label automatically updates it.',
                                    items: {
                                        type: 'object',
                                        properties: {
                                            label: { type: 'string', description: 'Entity name only. NO tag prefix (e.g. "Iron Syndicate", NOT "FAC: Iron Syndicate").' },
                                            keys:  { type: 'array', items: { type: 'string' }, description: 'Search keywords. Include ancestor location names.' },
                                            content:  { type: 'string', description: 'Full description.' },
                                            category: { type: 'string', enum: categoryEnum, description: 'Determines which lorebook the entry goes into.' }
                                        },
                                        required: ['label', 'keys', 'content', 'category']
                                    }
                                },
                                update: {
                                    type: 'array',
                                    description: 'Append new information to existing entries.',
                                    items: {
                                        type: 'object',
                                        properties: {
                                            id:      { type: 'string', description: 'Book::UID format (e.g. "Eldoria_NPCs::0").' },
                                            content: { type: 'string', description: 'New information to append.' }
                                        },
                                        required: ['id', 'content']
                                    }
                                },
                                activate:   { type: 'array', items: { type: 'string' }, description: 'Book::UID IDs to move into active context.' },
                                deactivate: { type: 'array', items: { type: 'string' }, description: 'Book::UID IDs to remove from active context.' },
                                delete_ids: { type: 'array', items: { type: 'string' }, description: 'Book::UID IDs to permanently delete.' },
                                rewrite: {
                                    type: 'array',
                                    description: 'Replace the entire content of existing entries. Use for compressing bloated entries.',
                                    items: {
                                        type: 'object',
                                        properties: {
                                            id:      { type: 'string', description: 'Book::UID of the entry to rewrite.' },
                                            content: { type: 'string', description: 'New canonical content. Replaces everything.' }
                                        },
                                        required: ['id', 'content']
                                    }
                                },
                                consolidate: {
                                    type: 'array',
                                    description: 'Merge multiple entries into one. All targets are deleted; the survivor gets the new content.',
                                    items: {
                                        type: 'object',
                                        properties: {
                                            targets:  {
                                                type: 'array',
                                                items: { type: 'string' },
                                                description: 'One or more Book::UID IDs to delete after merging.'
                                            },
                                            survivor: { type: 'string', description: 'Book::UID of the entry to keep, with merged content.' },
                                            content:  { type: 'string', description: 'Full merged canonical content for the survivor.' }
                                        },
                                        required: ['targets', 'survivor', 'content']
                                    }
                                }
                            }
                        }
                    }
                }
            ];

            // Native tool calling is only reliable for direct openai/ollama connections.
            // For profile/default the ConnectionManagerRequestService may not forward tools
            // correctly, causing MALFORMED_FUNCTION_CALL errors. Those connections get a
            // text-format (Action:/Observation:) system prompt and text-based parsing instead.
            const usesNativeTools = ['openai', 'ollama'].includes(routerSettings.connectionSource);

            const sharedContext = `
## MEMORY LIMIT
Maximum Active Entities: **${settings.routerMaxActivations || 8}**.
- Entries you record are ACTIVATED AUTOMATICALLY. Do NOT also include them in activate.
- Nothing is archived automatically. If you exceed the limit you will receive a **BUDGET VIOLATION** in the context and you MUST deactivate enough entries in that same commit call to return within budget. Choose the narratively least relevant entries.
- Entries whose keywords appeared in the latest narrator output may already appear under **NEWLY ACTIVATED THIS TURN** with full content — you do not need to activate those again.
- Always use exact Book::UID format (e.g. "Eldoria_NPCs::0") for activate/update/deactivate/delete_ids.

## CAMPAIGN CONTEXT
Campaign Root: "${prefix || 'World Archive'}"
  NPCs -> "${prefix ? prefix + '_NPCs' : 'NPCs'}"
  Locations -> "${prefix ? prefix + '_Locations' : 'Locations'}" (etc.)
Location hierarchy: use " :: " separator in labels (e.g. "Khelt :: Rust-Lantern District :: The Guilded Anvil").
Include ancestor location names as plain keywords (e.g. keys: ["Khelt", "Rust-Lantern District", "tavern"]).

## FIELD INSTRUCTIONS
${Object.values(settings.routerModules || {}).filter(m => m.enabled).map(m => `- ${m.tag}: ${m.instruction}`).join('\n')}${(settings.routerCustomTags || []).length ? '\n\n### CUSTOM CATEGORIES\n' + (settings.routerCustomTags || []).map(m => `- ${m.tag.toUpperCase()}: ${m.instruction}`).join('\n') : ''}`;

            const agentSystemPrompt = usesNativeTools
                // Clean prompt for native tool calling ? model gets schemas via the API
                ? `${basePrompt}

## YOUR ROLE
You are a lorebook research agent. Maintain the campaign lorebook using the provided tools.
Use grep_lore / inspect_book / read_entry to look up existing data before recording.
When research is complete, call commit once to write all changes. Stop immediately after.
${sharedContext}`
                // Text-format prompt for profile/default ? model outputs Action:/Observation: text
                : `${basePrompt}

## YOUR ROLE
You are a lorebook research agent. Maintain the campaign lorebook using the actions below.
Use grep_lore / inspect_book / read_entry to look up existing data before recording.
When research is complete, output commit once to write all changes, then stop.

## ACTIONS
Output exactly ONE action per turn in this format:
  Action: toolname({"arg": "value"})

Available actions:
- grep_lore({"query": "..."}) ? search lorebooks for entries matching a keyword
- inspect_book({"book_name": "..."}) ? list UIDs in a lorebook
- read_entry({"uid": "Book::0"}) ? read full content of an entry
- commit({"record": [...], "update": [...], "activate": [...], "deactivate": [...], "delete_ids": [...]}) ? write all changes and finish

commit record items: {"label": "Name only (NO tag prefix)", "keys": ["kw1","kw2"], "content": "...", "category": "NPC|LOC|FAC|QUEST|EVENT"}
commit update items: {"id": "Book::UID", "content": "new text to append"}

## EXAMPLE
Thought: I see a new faction called Iron Syndicate. I will record it.
Action: commit({"record": [{"label": "Iron Syndicate", "keys": ["Khelt", "faction"], "content": "The dominant industrial authority.", "category": "FAC"}]})
${sharedContext}`;

            const questMatchA = settings.currentMemo?.match(/\[QUESTS\]([\s\S]*?)\[\/QUESTS\]/i);
            const questBlockA = questMatchA ? `[QUESTS]${questMatchA[1].trim()}[/QUESTS]` : 'None';
            const contextMessage = `## BUDGET STATUS\n${budgetLine}${overflowInstruction}\n\n## NEWLY ACTIVATED THIS TURN\n${newlyTriggeredFull.join('\n\n') || 'None.'}\n\n## ACTIVE MEMORY (Lore)\n${activeEntriesFull.join('\n\n') || 'None yet.'}\n\n## ARCHIVE INDEX\n${keyringText || 'Empty.'}\n\n## CURRENT LOCATION\n${currentHierarchy || 'Unknown'}\n\n## ACTIVE QUESTS\n${questBlockA}\n\n## NARRATIVE\n${recentChat}${manualPrompt ? `\n\n## INSTRUCTION\n${manualPrompt}` : ''}`;

            /** @type {Array<{role:string, content:string|null, tool_calls?:any[], tool_call_id?:string}>} */
            const messages = [
                { role: 'system', content: agentSystemPrompt },
                { role: 'user',   content: contextMessage }
            ];

            while (turns < maxTurns) {
                turns++;
                broadcastStep('thought', `Thinking (Turn ${turns}/${maxTurns})...`);

                // Only pass tool schemas to connections that support native tool calling.
                // Profile/default connections ignore or mishandle the tools parameter.
                const result = await sendAgentTurn(routerSettings, messages, usesNativeTools ? agentTools : null);

                // Show any inline thought the model included alongside the tool call
                if (result.content) {
                    const thoughtLine = result.content.match(/Thought:\s*(.*)/i)?.[1]?.trim()
                        || result.content.trim().split('\n')[0];
                    if (thoughtLine) broadcastStep('thought', thoughtLine.substring(0, 200));
                }

                // For profile/default connections the model outputs text. Parse a single
                // Action: call from the current turn response (safe since it's single-turn).
                let resolvedToolCall = result.toolCall;
                if (!resolvedToolCall && result.content) {
                    resolvedToolCall = parseTextAction(result.content);
                }

                if (!resolvedToolCall) {
                    // No tool call and no parseable action ? model is done
                    break;
                }

                const { name: toolName, args } = resolvedToolCall;
                const callId = /** @type {any} */ (resolvedToolCall).id || `call_${Date.now()}_${turns}`;
                broadcastStep('tool', `${toolName}(...)`);

                // Append the assistant turn (with tool_calls) to the conversation
                messages.push({
                    role: 'assistant',
                    content: result.content || null,
                    tool_calls: [{
                        id:   callId || `call_${Date.now()}_${turns}`,
                        type: 'function',
                        function: { name: toolName, arguments: JSON.stringify(args) }
                    }]
                });

                let observation = '';

                if (toolName === 'commit') {
                    const commitResult = await applyAction(args, archiveBooks, currentTime, breadcrumb);
                    archiveBooks = await fetchArchiveBooks();
                    keyringText = buildKeyringText(archiveBooks, settings.activeRouterKeys);
                    updateActiveEntries();
                    if (commitResult.errors.length > 0) {
                        observation = `Committed with warnings: ${commitResult.errors.join(', ')}`;
                    } else {
                        const details = [];
                        if (commitResult.recordedIds?.length > 0) details.push(`Recorded/Updated: ${commitResult.recordedIds.join(', ')}`);
                        if (args.activate?.length > 0) details.push(`Activated: ${args.activate.join(', ')}`);
                        observation = `Committed successfully. ${details.join(' | ')}`;
                    }
                } else if (toolName === 'grep_lore') {
                    const query = (args.query || '').toLowerCase();
                    const hits = [];
                    for (const [name, book] of Object.entries(archiveBooks)) {
                        for (const [uid, entry] of Object.entries(book.entries)) {
                            if ((entry.content || '').toLowerCase().includes(query) || (entry.comment || '').toLowerCase().includes(query)) {
                                hits.push(`[${name}::${uid}] "${entry.comment || uid}": ${(entry.content || '').substring(0, 120)}...`);
                            }
                        }
                    }
                    observation = hits.length > 0 ? hits.join('\n') : `No entries found for "${args.query}".`;
                } else if (toolName === 'inspect_book') {
                    const bookName = args.book_name || '';
                    if (archiveBooks[bookName]) {
                        observation = Object.entries(archiveBooks[bookName].entries)
                            .map(([uid, e]) => `${bookName}::${uid} -- ${e.comment || e.key?.[0] || uid}`)
                            .join('\n');
                    } else {
                        observation = `Book "${bookName}" not found. Available: ${Object.keys(archiveBooks).join(', ') || 'none'}`;
                    }
                } else if (toolName === 'read_entry') {
                    const uid = args.uid || '';
                    const [bookName, id] = uid.split('::');
                    const book = await ctx.loadWorldInfo(bookName);
                    observation = book?.entries?.[id] ? book.entries[id].content : `Entry "${uid}" not found.`;
                } else {
                    observation = `Unknown tool: ${toolName}`;
                }

                broadcastStep('result', observation.substring(0, 200) + (observation.length > 200 ? '...' : ''));

                // Append the tool result so the model sees it on the next turn
                messages.push({
                    role: 'tool',
                    tool_call_id: messages[messages.length - 1].tool_calls[0].id,
                    content: observation
                });

                // commit always ends the research pass
                if (toolName === 'commit') break;
            }
        } // end agent mode

        const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
        const finishMsg = basicSummaryText ? `Finished in ${totalTime}s -- ${basicSummaryText}` : `Finished in ${totalTime}s`;
        broadcastStep('finish', finishMsg, { time: totalTime, turns });

        // Non-blocking bloat hint and auto-cleanup check
        {
            const CLEANUP_TOKEN_THRESHOLD = settings.routerCleanupTokenThreshold || 300;
            const bloatedCount = Object.values(archiveBooks)
                .flatMap(b => Object.values(b.entries || {}))
                .filter(e => estimateTokens(e.content) >= CLEANUP_TOKEN_THRESHOLD).length;

            _routerNormalRunCount++;
            const cleanupEvery = settings.routerCleanupEvery || 0;
            const shouldAutoCleanup = cleanupEvery > 0 && (_routerNormalRunCount % cleanupEvery === 0) && bloatedCount > 0;

            if (shouldAutoCleanup) {
                broadcastStep('thought', `🧹 Auto-cleanup: ${bloatedCount} bloated entr${bloatedCount > 1 ? 'ies' : 'y'} found. Scheduling cleanup pass...`);
                // Queue non-blockingly so the current pass finishes cleanly first
                setTimeout(() => runRouterPass(null, '__CLEANUP__', null, true), 200);
            } else if (bloatedCount > 0) {
                broadcastStep('thought', `💡 ${bloatedCount} entr${bloatedCount > 1 ? 'ies' : 'y'} may benefit from cleanup (>${CLEANUP_TOKEN_THRESHOLD} tokens). Use the 🧹 button to compress.`);
            }
        }

        return true;
    } catch (e) {
        console.error("[Lorebook Agent] Run failed:", e);
        broadcastStep('error', e.message);
        return false;
    } finally {
        _routerRunning = false;
    }
}

/**
 * Applies the agent's final decision to settings and lorebooks.
 * @param {object} action - The action to apply.
 * @param {object} allBooks - The cached archive books for verification.
 * @param {string} [currentTime=''] - The current time string for timestamping.
 * @param {string} [breadcrumb=''] - The current location hierarchy string (Main :: Sub).
 * @returns {Promise<{success: boolean, errors: string[], recordedIds: string[]}>}
 */
async function applyAction(action, allBooks = {}, currentTime = '', breadcrumb = '') {
    const settings = getSettings();
    const ctx = SillyTavern.getContext();
    let changed = false;
    const errors = [];
    const allBookNames = Object.keys(allBooks);

    const timePrefix = currentTime ? `[${currentTime}] ` : '';

    // 1. Activate/Deactivate
    const activate = action.activate || [];
    const deactivate = action.deactivate || [];
    let newActive = [...(settings.activeRouterKeys || [])];
    
    // Remove deactivations
    newActive = newActive.filter(k => !deactivate.includes(k));
    
    // Add activations
    for (const k of activate) {
        if (typeof k !== 'string' || !k.includes('::')) {
            errors.push(`Invalid ID format: ${k}`);
            continue;
        }
        const [bookName, uid] = k.split('::');
        const exists = allBooks[bookName]?.entries?.[uid];
        
        if (exists) {
            if (!newActive.includes(k)) {
                newActive.push(k);
                changed = true;
            }
        } else {
            errors.push(`Entity not found: ${k}`);
        }
    }
    if (deactivate.length > 0) changed = true;

    // Sync keywordActivatedKeys: agent ownership trumps keyword-auto tracking.
    // - Explicitly activated: agent owns it now, no longer auto-expires.
    // - Explicitly deactivated: remove from both pools.
    if ((activate.length > 0 || deactivate.length > 0) && Array.isArray(settings.keywordActivatedKeys)) {
        const activateSet = new Set(activate);
        const deactivateSet = new Set(deactivate);
        settings.keywordActivatedKeys = settings.keywordActivatedKeys.filter(k =>
            !activateSet.has(k) && !deactivateSet.has(k)
        );
    }

    // 2. Update existing
    const updates = action.update || [];
    for (const up of updates) {
        const [bookName, uid] = up.id.split('::');
        const book = await ctx.loadWorldInfo(bookName);
        if (book?.entries?.[uid]) {
            // Strip [ID:] stamp from anywhere in the delta (model sometimes echoes it)
            let delta = (up.content || '').replace(/\[ID:[^\]]+\]\n?/gi, '').trim();
            // Append delta to the existing chronicle
            const existing = (book.entries[uid].content || '').replace(/^\[ID:[^\]]+\]\n?/i, '').trimEnd();
            delta = deduplicateContent(existing, delta);
            if (delta && timePrefix && !delta.includes('[Day')) {
                delta = timePrefix.trim() + ' ' + delta;
            }
            book.entries[uid].content = existing && delta ? `${existing}\n${delta}` : (existing || delta);
            await ctx.saveWorldInfo(bookName, book);
            changed = true;
        }
    }

    // 2b. Rewrite (full content replacement — no append, no dedup)
    const rewriteIds = [];
    for (const rw of (action.rewrite || [])) {
        const [bookName, uid] = rw.id.split('::');
        const book = await ctx.loadWorldInfo(bookName);
        if (book?.entries?.[uid]) {
            book.entries[uid].content = rw.content;
            await ctx.saveWorldInfo(bookName, book);
            rewriteIds.push(rw.id);
            changed = true;
        } else {
            errors.push(`Rewrite target not found: ${rw.id}`);
        }
    }

    // 2c. Consolidate (many-to-one merge with deletion)
    const consolidateIds = [];
    for (const op of (action.consolidate || [])) {
        // Update the survivor with merged content
        const [sBook, sUid] = op.survivor.split('::');
        const sBookData = await ctx.loadWorldInfo(sBook);
        if (sBookData?.entries?.[sUid]) {
            sBookData.entries[sUid].content = op.content;
            await ctx.saveWorldInfo(sBook, sBookData);
            consolidateIds.push(op.survivor);
        } else {
            errors.push(`Consolidate survivor not found: ${op.survivor}`);
            continue;
        }

        // Delete each target and scrub from active/keyword key lists
        for (const targetId of (op.targets || [])) {
            const [tBook, tUid] = targetId.split('::');
            const tBookData = await ctx.loadWorldInfo(tBook);
            if (tBookData?.entries?.[tUid]) {
                delete tBookData.entries[tUid];
                await ctx.saveWorldInfo(tBook, tBookData);
            } else {
                errors.push(`Consolidate target not found: ${targetId}`);
            }
            settings.activeRouterKeys = (settings.activeRouterKeys || [])
                .filter(k => k !== targetId);
            newActive = newActive.filter(k => k !== targetId);
            if (Array.isArray(settings.keywordActivatedKeys)) {
                settings.keywordActivatedKeys = settings.keywordActivatedKeys
                    .filter(k => k !== targetId);
            }
        }
        changed = true;
    }

    // 3. Record new (with Deduplication)
    // Group entries by target book and commit once per book to avoid UID collisions
    const records = action.record || [];
    const prefix = getLivePrefix();
    const baseBook = prefix || 'World Chronicle';
    const recordedIds = [];

    // -- Phase A: Route each record to its target book --
    const catMap = { 'NPC': 'NPCs', 'LOC': 'Locations', 'QUEST': 'Quests', 'FAC': 'Factions', 'EVENT': 'Events' };
    // Extend with user-defined custom tags so they get their own books (e.g. WEATHER ? prefix_Weather)
    for (const ct of (settings.routerCustomTags || [])) {
        const t = ct.tag.toUpperCase();
        if (!catMap[t]) catMap[t] = t.charAt(0) + t.slice(1).toLowerCase();
    }
    /** @type {Map<string, Array>} */
    const bookQueue = new Map();

    for (const rec of records) {
        const cat = (rec.category || rec.comment || '').toUpperCase();
        const catName = Object.keys(catMap).find(k => cat.includes(k));
        const targetBook = catName ? (prefix ? `${prefix}_${catMap[catName]}` : catMap[catName]) : baseBook;

        // Strip any accidental "TAG: " prefix the model may have included in the label
        // e.g. "FAC: Iron Syndicate" ? "Iron Syndicate", "STATS: Thalric Thorne" ? "Thalric Thorne"
        if (rec.label) {
            rec.label = rec.label.replace(/^[A-Z_]{2,10}:\s+/i, '').trim();
        }

        // Breadcrumb enrichment is intentionally omitted: the model is instructed in the system
        // prompt to include the full hierarchy in the label itself (e.g. "Khelt :: Section 4").
        // Auto-prepending the current breadcrumb causes corruption when recording parent/sibling
        // locations that are not children of the current scene.

        if (cat.includes('EVENT')) {
            if (currentTime && !rec.label.includes('[Day')) {
                rec.label = `[${currentTime}] ${rec.label}`;
            }
        }

        if (timePrefix && !rec.content.includes('[Day')) {
            rec.content = timePrefix + rec.content;
        }

        // Add location hierarchy keywords (plain fragments, no 'In:' prefix)
        // Matches status footer tokens for native ST keyword triggering.
        {
            const parts = (breadcrumb || '').split(' :: ').filter(Boolean);
            rec.keys = rec.keys || [];
            for (const part of parts) {
                if (!rec.keys.includes(part)) rec.keys.push(part);
            }
        }
        rec.keys = cleanKeys(rec.keys || []);

        if (!bookQueue.has(targetBook)) bookQueue.set(targetBook, []);
        bookQueue.get(targetBook).push(rec);
    }


    // -- Phase B: For each book, load existing entries, append new ones, save to disk via HTTP API --
    const knownBookNames = Object.keys(allBooks);
    /** @type {Set<string>} books written this pass that need activation */
    const booksWritten = new Set();
    for (const [targetBook, recs] of bookQueue.entries()) {
        if (settings.debugMode) console.log(`[RPG Tracker] Writing ${recs.length} entries to: ${targetBook}`);

        // Load existing book or initialize a new one
        let bookData = knownBookNames.includes(targetBook)
            ? await ctx.loadWorldInfo(targetBook)
            : null;

        if (!bookData) {
            bookData = { entries: {}, name: targetBook, scan_depth: 4, token_budget: 400, recursive: false, extensions: {} };
        }

        for (const rec of recs) {
            // Deduplication: skip if an entry with this label already exists
            const cleanLabel = (rec.label || '').replace(/^\[.*?\]\s*/i, '').toLowerCase().trim();
            let existingUid = null;
            for (const [uid, entry] of Object.entries(bookData.entries)) {
                const entryLabel = (entry.comment || '').replace(/^\[.*?\]\s*/i, '').toLowerCase().trim();
                if (entryLabel === cleanLabel) { existingUid = uid; break; }
            }

            if (existingUid) {
                // Append delta to existing chronicle (dedup path)
                const fullId = `${targetBook}::${existingUid}`;
                // Strip [ID:] stamp from anywhere in the delta (model sometimes echoes it)
                let delta = (rec.content || '').replace(/\[ID:[^\]]+\]\n?/gi, '').trim();
                const existing = (bookData.entries[existingUid].content || '').replace(/^\[ID:[^\]]+\]\n?/i, '').trimEnd();
                delta = deduplicateContent(existing, delta);
                bookData.entries[existingUid].content = existing && delta ? `${existing}\n${delta}` : (existing || delta);
                const keys = bookData.entries[existingUid].key || [];
                (rec.keys || []).forEach(k => { if (!keys.includes(k)) keys.push(k); });
                bookData.entries[existingUid].key = cleanKeys(keys);
                if (!newActive.includes(fullId)) newActive.push(fullId);
                recordedIds.push(`${fullId} (updated)`);
            } else {
                // Append new entry with the next sequential UID
                const uids = Object.keys(bookData.entries).map(Number).filter(n => !isNaN(n));
                const nextUid = uids.length > 0 ? Math.max(...uids) + 1 : 0;
                const fullId = `${targetBook}::${nextUid}`;
                bookData.entries[nextUid] = {
                    uid: nextUid,
                    key: rec.keys || [rec.label],
                    keysecondary: [],
                    comment: rec.label || 'LORE_GEN',
                    content: rec.content || '',
                    constant: false, selective: false, selectiveLogic: 0, addMemo: true,
                    order: 100, position: 0, disable: !settings.routerNativeKeywordActivation,
                    probability: 100, useProbability: false,
                    depth: 4, group: '', groupOverride: false, groupWeight: 100,
                };
                if (!newActive.includes(fullId)) newActive.push(fullId);
                recordedIds.push(fullId);
            }
            changed = true;
        }

        // Always use the raw HTTP API to guarantee disk persistence.
        // ctx.saveWorldInfo only flushes books already in ST's in-memory registry,
        // silently dropping any new (unregistered) books. The /api/worldinfo/edit
        // endpoint writes directly to disk with no registry requirement.
        const saveRes = await fetch('/api/worldinfo/edit', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ name: targetBook, data: bookData })
        });
        if (!saveRes.ok) {
            console.error(`[RPG Tracker] Failed to save ${targetBook}: HTTP ${saveRes.status}`);
        } else {
            if (settings.debugMode) console.log(`[RPG Tracker] Saved ${recs.length} entries to ${targetBook}`);
            // Cache bust: write bookData into ST's in-memory registry so that the
            // subsequent renderRouterUI -> loadWorldInfo call sees fresh entries immediately
            // (the raw HTTP API bypasses the in-memory cache; this syncs them up).
            if (typeof ctx.saveWorldInfo === 'function') {
                try { await ctx.saveWorldInfo(targetBook, bookData); } catch (_) { /* non-fatal */ }
            }
            booksWritten.add(targetBook);
        }
    }

    // Bulk-activate all written books after all disk writes are done.
    // Doing this once at the end avoids race conditions where ST's world info
    // list hasn't re-indexed yet when the first /world command fires.
    if (booksWritten.size > 0 && typeof ctx.executeSlashCommandsWithOptions === 'function') {
        await new Promise(r => setTimeout(r, 400));
        if (typeof ctx.updateWorldInfoList === 'function') await ctx.updateWorldInfoList();
        for (const bookName of booksWritten) {
            await ctx.executeSlashCommandsWithOptions(`/world state=on silent=true "${bookName}"`);
            await new Promise(r => setTimeout(r, 100));
        }
        if (settings.debugMode) console.log(`[RPG Tracker] Activated books: ${[...booksWritten].join(', ')}`);
    }

    // Budget enforcement is handled by the agent via overflow instruction in context.
    // No FIFO pruning here — the agent must explicitly deactivate entries.
    settings.activeRouterKeys = newActive;

    // 4. Delete
    const deleteIds = action.delete_ids || [];
    for (const id of deleteIds) {
        const parts = id.split('::');
        if (parts.length < 2) continue;
        const [bookName, uid] = parts;
        const book = await ctx.loadWorldInfo(bookName);
        if (book?.entries?.[uid]) {
            delete book.entries[uid];
            await ctx.saveWorldInfo(bookName, book);
            // Also remove from active keys if present
            settings.activeRouterKeys = settings.activeRouterKeys.filter(k => k !== id);
            changed = true;
        }
    }

    if (changed) {
        const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        settings.routerLog.unshift({
            time: timestamp,
            activate: activate,
            deactivate: deactivate,
            record: recordedIds,
            delete: deleteIds,
            rewrite: rewriteIds,
            consolidate: consolidateIds,
            reason: action.reason || (settings.routerBasicMode ? "Tag-based update." : "Agent tool update.")
        });
        if (settings.routerLog.length > 50) settings.routerLog.length = 50;

        // Track campaign lorebooks per chat_id so they auto-activate on chat switch
        if (booksWritten.size > 0) {
            const chatId = typeof globalThis._rpgCurrentChatId === 'function'
                ? globalThis._rpgCurrentChatId()
                : null;
            if (chatId) {
                if (!settings.chatStates) settings.chatStates = {};
                if (!settings.chatStates[chatId]) settings.chatStates[chatId] = {};
                const existing = new Set(settings.chatStates[chatId].campaignBooks || []);
                for (const b of booksWritten) existing.add(b);
                settings.chatStates[chatId].campaignBooks = [...existing];
            }
        }

        ctx.saveSettingsDebounced();
        document.dispatchEvent(new CustomEvent('rt_lore_agent_updated'));
    }

    return { success: true, errors, recordedIds };
}

/**
 * @param {{ bookSnapshots?: Record<string, any>, chatId?: string, campaignPrefix?: string }} snapshot
 * @param {string} prefix - {@link getLivePrefix}
 * @param {string} liveChatId - {@link SillyTavern.getContext().chatId}
 * @returns {string|null} Abort reason for console / UI, or null if safe to apply lore mutations.
 */
function getLoreSnapshotApplyAbortReason(snapshot, prefix, liveChatId) {
    const names = Object.keys(snapshot?.bookSnapshots || {});
    if (names.length > 0 && prefix) {
        if (!names.every(n => bookBelongsToPrefix(n, prefix))) {
            return 'snapshot lorebooks do not belong to the current campaign prefix (likely a different chat)';
        }
    }
    if (snapshot.chatId && liveChatId && snapshot.chatId !== liveChatId) {
        return 'snapshot was taken on a different chat';
    }
    if (snapshot.campaignPrefix && prefix && snapshot.campaignPrefix !== prefix) {
        return 'campaign prefix changed since this snapshot was taken';
    }
    return null;
}

/**
 * Restores a past lorebook snapshot from routerHistory.
 * - Deletes any lorebook that was CREATED during the pass (wasn't in snapshot).
 * - Overwrites any lorebook that was MODIFIED during the pass back to its pre-pass content.
 * @param {number} index - 0 = most recent pre-pass snapshot.
 * @returns {Promise<boolean>}
 */
export async function rollbackRouterPass(index = 0) {
    const settings = getSettings();
    const ctx = SillyTavern.getContext();
    const history = settings.routerHistory || [];

    if (index < 0 || index >= history.length) {
        console.warn('[RPG Tracker] Rollback: invalid index', index);
        return false;
    }

    const snapshot = history[index];
    if (!snapshot) return false;

    try {
        const prePassBooks = new Set(Object.keys(snapshot.bookSnapshots || {}));
        const prefix = getLivePrefix();
        const liveChatId = ctx.chatId || '';
        const abortReason = getLoreSnapshotApplyAbortReason(snapshot, prefix, liveChatId);
        if (abortReason) {
            console.warn('[RPG Tracker] Rollback aborted: ' + abortReason);
            return false;
        }

        // -- Step 1: Delete lorebooks that were CREATED during the pass --------
        // Only consider books under the live campaign prefix. If the prefix is missing,
        // scanning "all" lorebooks would treat every unrelated book as newly created
        // and delete or wipe anything not present in this pass's snapshot.
        const allCurrentNames = await getWorldInfoNamesSafe();
        const scopedCurrent = prefix
            ? allCurrentNames.filter(n => bookBelongsToPrefix(n, prefix))
            : [];
        if (!prefix && allCurrentNames.length) {
            console.warn('[RPG Tracker] Rollback: no campaign prefix — skipping delete-new-books step (would otherwise touch the entire lore library).');
        }

        for (const bookName of scopedCurrent) {
            if (prePassBooks.has(bookName)) continue; // Pre-existed ? restore below, don't delete
            // This book was CREATED during the pass ? permanently delete it
            let deleted = false;
            try {
                const delRes = await fetch('/api/worldinfo/delete', {
                    method: 'POST',
                    headers: getRequestHeaders(),
                    body: JSON.stringify({ name: bookName })
                });
                deleted = delRes.ok;
            } catch (_) { /* endpoint may not exist on older ST builds */ }

            if (!deleted) {
                // Fallback: clear all entries so the book is effectively empty
                const emptyBook = { entries: {}, name: bookName, scan_depth: 4, token_budget: 400, recursive: false, extensions: {} };
                await fetch('/api/worldinfo/edit', {
                    method: 'POST',
                    headers: getRequestHeaders(),
                    body: JSON.stringify({ name: bookName, data: emptyBook })
                });
                if (typeof ctx.saveWorldInfo === 'function') {
                    try { await ctx.saveWorldInfo(bookName, emptyBook); } catch (_) {}
                }
            }
        }

        // Re-index so ST knows about deletions before we start restoring
        if (typeof ctx.updateWorldInfoList === 'function') {
            try { await ctx.updateWorldInfoList(); } catch (_) {}
        }

        // -- Step 2: Restore pre-pass lorebooks to their snapshotted state -----
        for (const [bookName, bookData] of Object.entries(snapshot.bookSnapshots || {})) {
            const saveRes = await fetch('/api/worldinfo/edit', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({ name: bookName, data: bookData })
            });
            if (!saveRes.ok) {
                console.error(`[RPG Tracker] Rollback: failed to restore ${bookName}: HTTP ${saveRes.status}`);
                continue;
            }
            // Bust ST in-memory cache so the UI sees the restored data immediately
            if (typeof ctx.saveWorldInfo === 'function') {
                try { await ctx.saveWorldInfo(bookName, bookData); } catch (_) { /* non-fatal */ }
            }
        }

        // -- Step 3: Restore active keys ---------------------------------------
        settings.activeRouterKeys = JSON.parse(JSON.stringify(snapshot.activeRouterKeys || []));

        // -- Step 4: Trim snapshots newer than the restored point --------------
        settings.routerHistory = history.slice(index + 1);

        ctx.saveSettingsDebounced();
        document.dispatchEvent(new CustomEvent('rt_lore_agent_updated'));
        return true;
    } catch (e) {
        console.error('[RPG Tracker] Rollback failed:', e);
        return false;
    }
}

/**
 * Re-applies a previously undone agent pass (redo).
 * Pushes prePassSnapshot back onto routerHistory and restores lorebooks to postPassState.
 * @param {{ timestamp: string, activeRouterKeys: string[], bookSnapshots: Record<string, any> }} prePassSnapshot
 * @param {{ timestamp: string, activeRouterKeys: string[], bookSnapshots: Record<string, any> }} postPassState
 * @returns {Promise<boolean>}
 */
export async function reapplyRouterPass(prePassSnapshot, postPassState) {
    const settings = getSettings();
    const ctx = SillyTavern.getContext();

    try {
        const prefix = getLivePrefix();
        const liveChatId = ctx.chatId || '';
        const redoAbort = getLoreSnapshotApplyAbortReason(prePassSnapshot, prefix, liveChatId)
            || getLoreSnapshotApplyAbortReason(postPassState, prefix, liveChatId);
        if (redoAbort) {
            console.warn('[RPG Tracker] Redo aborted: ' + redoAbort);
            return false;
        }

        // Step 1: Put the pre-pass snapshot back so the user can undo again
        if (!settings.routerHistory) settings.routerHistory = [];
        settings.routerHistory.unshift(prePassSnapshot);
        if (settings.routerHistory.length > 5) settings.routerHistory.length = 5;

        // Step 2: Restore lorebooks to the post-pass state
        for (const [bookName, bookData] of Object.entries(postPassState.bookSnapshots || {})) {
            const saveRes = await fetch('/api/worldinfo/edit', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({ name: bookName, data: bookData })
            });
            if (!saveRes.ok) {
                console.error(`[RPG Tracker] Redo: failed to restore ${bookName}: HTTP ${saveRes.status}`);
                continue;
            }
            if (typeof ctx.saveWorldInfo === 'function') {
                try { await ctx.saveWorldInfo(bookName, bookData); } catch (_) {}
            }
        }

        if (typeof ctx.updateWorldInfoList === 'function') {
            try { await ctx.updateWorldInfoList(); } catch (_) {}
        }

        // Step 3: Restore active keys to the post-pass state
        settings.activeRouterKeys = JSON.parse(JSON.stringify(postPassState.activeRouterKeys || []));

        ctx.saveSettingsDebounced();
        document.dispatchEvent(new CustomEvent('rt_lore_agent_updated'));
        return true;
    } catch (e) {
        console.error('[RPG Tracker] Redo failed:', e);
        return false;
    }
}


/**
 * Parses basic narrative tags [[TAG: ...]]
 */
function parseBasicTags(text, archiveBooks) {
    const action = { record: [], update: [], activate: [], deactivate: [], delete_ids: [], rewrite: [], consolidate: [] };
    const settings = getSettings();

    // REWRITE tag parser
    const rewriteRegex = /\[\[REWRITE:\s*([^|]+)\|([\s\S]*?)\]\]/gi;
    let rw;
    while ((rw = rewriteRegex.exec(text)) !== null) {
        const id      = rw[1].trim();
        const content = rw[2].trim();
        action.rewrite.push({ id, content });
    }

    // CONSOLIDATE tag parser
    const consolidateRegex = /\[\[CONSOLIDATE:\s*([^|]+)\|([^|]+)\|([\s\S]*?)\]\]/gi;
    let cm;
    while ((cm = consolidateRegex.exec(text)) !== null) {
        const targets  = cm[1].split(',').map(s => s.trim()).filter(Boolean);
        const survivor = cm[2].trim();
        const content  = cm[3].trim();
        action.consolidate.push({ targets, survivor, content });
    }

    const processMatch = (name, content, keywords, category) => {
        name = name.trim().replace(/^[A-Z_]{2,10}:\s+/i, '').trim();
        content = content.trim();
        const keys = (keywords || '').split(',').map(k => k.trim());

        // Check for existing by name
        let existingId = null;
        for (const [bookName, book] of Object.entries(archiveBooks)) {
            for (const [uid, entry] of Object.entries(book.entries)) {
                if ((entry.comment || '').toLowerCase() === name.toLowerCase()) {
                    existingId = `${bookName}::${uid}`;
                    break;
                }
            }
            if (existingId) break;
        }

        if (existingId) {
            action.update.push({ id: existingId, content });
        } else {
            action.record.push({ label: name, content, keys, category });
        }
    };

    // Generic tag parser: [[TAG: ...]]
    const tagRegex = /\[\[(\w+):\s*((?:(?!\]\]).)+?)\]\]/gi;
    let match;

    while ((match = tagRegex.exec(text)) !== null) {
        const tagName = match[1].toUpperCase();
        if (tagName === 'REWRITE' || tagName === 'CONSOLIDATE') continue; // Collision protection

        const inner = match[2];
        const parts = inner.split('|').map(p => p.trim());

        if ((tagName === 'ACTIVATE' || tagName === 'DEACTIVATE' || tagName === 'DELETE') && parts.length >= 1) {
            const name = inner.trim().toLowerCase();
            let targetList = [];
            if (tagName === 'ACTIVATE') targetList = action.activate;
            else if (tagName === 'DEACTIVATE') targetList = action.deactivate;
            else if (tagName === 'DELETE') targetList = action.delete_ids;

            for (const [bookName, book] of Object.entries(archiveBooks)) {
                for (const [uid, entry] of Object.entries(book.entries)) {
                    if ((entry.comment || '').toLowerCase() === name) {
                        targetList.push(`${bookName}::${uid}`);
                        break;
                    }
                }
            }
        } else if (parts.length >= 3) {
            // Generic: first = name, last = keywords, everything in between = body (joined with blank line).
            // Supports any number of middle slots so renaming or adding slots in the UI works automatically.
            const name = parts[0];
            const keywords = parts[parts.length - 1];
            const body = parts.slice(1, -1).filter(Boolean).join('\n\n');
            processMatch(name, body, keywords, tagName);
        }
    }

    return action;
}

/**
 * Shared helper to add an entry to a specific lorebook.
 */
async function addLorebookEntry(lorebookName, entryData, allNames) {
    const ctx = SillyTavern.getContext();
    if (!allNames) allNames = await getWorldInfoNamesSafe();
    let bookData = null;
    if (allNames.includes(lorebookName)) {
        bookData = await ctx.loadWorldInfo(lorebookName);
    } else {
        if (getSettings().debugMode) console.log(`[RPG Tracker] Initializing new lorebook: ${lorebookName}`);
        bookData = { 
            entries: {},
            name: lorebookName,
            scan_depth: 4,
            token_budget: 400,
            recursive: false,
            extensions: {}
        };
    }

    // Always reload fresh from disk to get accurate existing UIDs
    // (avoids uid:0 collision when multiple entries are written to a new book in one pass)
    const freshData = allNames.includes(lorebookName) ? await ctx.loadWorldInfo(lorebookName) : bookData;
    const existingUids = Object.keys(freshData?.entries || {}).map(Number).filter(n => !isNaN(n));
    const nextUid = existingUids.length > 0 ? Math.max(...existingUids) + 1 : 0;
    
    const writeTarget = freshData || bookData;
    writeTarget.entries[nextUid] = {
        uid: nextUid,
        key: entryData.keys || [entryData.label || entryData.id],
        keysecondary: [],
        comment: entryData.label || entryData.id || entryData.category || entryData.comment || 'LORE_GEN',
        content: entryData.content,
        constant: false,
        selective: false,
        selectiveLogic: 0,
        addMemo: true,
        order: 100,
        position: 0,
        disable: false,
        probability: 100,
        useProbability: false,
        depth: 4,
        group: '',
        groupOverride: false,
        groupWeight: 100,
    };
    
    await ctx.saveWorldInfo(lorebookName, writeTarget);
    
    // Update allNames cache so subsequent calls know this book now exists
    if (!allNames.includes(lorebookName)) allNames.push(lorebookName);
    
    // Trigger SillyTavern UI/Internal refresh
    if (ctx.reloadWorldInfoEditor) ctx.reloadWorldInfoEditor(lorebookName);
    if (ctx.eventSource && ctx.event_types) {
        ctx.eventSource.emit(ctx.event_types.WORLD_INFO_UPDATED, lorebookName);
    }
    
    return `${lorebookName}::${nextUid}`;
}

/**
 * Manual scene archiving tool.
 */
export async function saveSceneToLorebook(hint = "") {
    const settings = getSettings();
    const ctx = SillyTavern.getContext();
    if (!ctx.generateRaw) return;

    try {
        (/** @type {any} */ (toastr)).info("Saving scene...", "Lorebook Agent");
        
        const { chat } = ctx;
        const recentChat = chat.slice(-5).map(m => `${(/** @type {any} */ (m)).is_user ? 'Player' : ((/** @type {any} */ (m)).name || 'Narrator')}: ${((/** @type {any} */ (m)).mes || (/** @type {any} */ (m)).content || '').replace(/<[^>]+>/g, '')}`).join('\n\n');

        const systemPrompt = `You are the Scene Archiver. Based on the recent narrative, generate a Lorebook entry for this scene.
Output a JSON object:
{
  "id": "scene_unique_name",
  "desc": "Short description",
  "content": "Full summary of the event",
  "keys": ["Keyword1", "Keyword2"]
}`;

        const userPrompt = `## RECENT CHAT\n${recentChat}\n\n${hint ? `## USER HINT\n${hint}\n\n` : ""}Generate the JSON scene save.`;

        const routerSettings = {
            ...settings,
            connectionSource: settings.routerConnectionSource || "default",
            maxTokens: (settings.routerMaxTokens !== undefined && settings.routerMaxTokens !== null && settings.routerMaxTokens !== '') ? Number(settings.routerMaxTokens) : 1000,
        };

        const result = await sendStateRequest(routerSettings, systemPrompt, userPrompt);
        const match = result.match(/\{[\s\S]*\}/);
        if (match) {
            const data = JSON.parse(match[0]);
            
            const prefix = getLivePrefix();
            const lorebookName = prefix ? `${prefix}World_Chronicle` : 'World Chronicle';
            const newId = await addLorebookEntry(lorebookName, {
                id: data.id,
                keys: data.keys,
                content: data.content,
                comment: 'LORE_SCENE'
            });
            
            const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            settings.routerLog.unshift({
                time: timestamp,
                activate: [newId], deactivate: [],
                reason: `Saved scene: ${data.desc} -> ${lorebookName} (${data.id})`
            });
            settings.activeRouterKeys.push(newId);
            ctx.saveSettingsDebounced();
            document.dispatchEvent(new CustomEvent('rt_lore_agent_updated'));
            
            (/** @type {any} */ (toastr)).success(`Saved scene: ${data.desc}`, 'Lorebook Agent');
        }
    } catch (e) {
        console.error("[Lorebook Agent] Save scene failed:", e);
        (/** @type {any} */ (toastr)).error('Failed to save scene.', 'Lorebook Agent');
    }
}

/**
 * Fetches a manifest of all campaign-scoped lorebook entries for the UI.
 */
export async function getLorebookManifest() {
    const settings = getSettings();
    const ctx = SillyTavern.getContext();
    const prefix = getLivePrefix();
    
    // Always flush ST's registry from disk first so books written via HTTP API are visible
    if (typeof ctx.updateWorldInfoList === 'function') {
        try { await ctx.updateWorldInfoList(); } catch (_) {}
    }

    const names = await getWorldInfoNamesSafe();
    // With no prefix, show nothing ? the user hasn't set a campaign yet.
    if (!prefix) return [];
    const scoped = names.filter(n => bookBelongsToPrefix(n, prefix));
    
    // Fallback 1: books referenced in activeRouterKeys (not yet in registry)
    const activeBookNames = (settings.activeRouterKeys || [])
        .map(k => k.split('::')[0])
        .filter(Boolean);
    for (const n of activeBookNames) {
        if (!scoped.includes(n) && bookBelongsToPrefix(n, prefix)) {
            scoped.push(n);
        }
    }
    
    // Fallback 2: books referenced in routerLog records (catches deactivated entries
    // whose books are no longer in activeRouterKeys nor in ST's registry yet)
    const logBookNames = (settings.routerLog || [])
        .flatMap(e => [...(e.record || []), ...(e.activate || [])].map(id => id.split('::')[0]))
        .filter(Boolean);
    for (const n of logBookNames) {
        if (!scoped.includes(n) && bookBelongsToPrefix(n, prefix)) {
            scoped.push(n);
        }
    }
    
    const manifest = [];
    for (const n of scoped) {
        const b = await ctx.loadWorldInfo(n);
        if (!b?.entries) continue;
        for (const [uid, entry] of Object.entries(b.entries)) {
            manifest.push({
                id: `${n}::${uid}`,
                book: n,
                uid: uid,
                label: entry.comment || (entry.key?.[0]) || uid,
                keys: entry.key || [],
                content: entry.content,
                is_active: settings.activeRouterKeys?.includes(`${n}::${uid}`)
            });
        }
    }
    return manifest;
}

/**
 * Deletes a lorebook entry by ID (Book::UID).
 */
export async function deleteLorebookEntry(id) {
    const [bookName, uid] = id.split('::');
    if (!bookName || !uid) return false;
    
    const ctx = SillyTavern.getContext();
    const book = await ctx.loadWorldInfo(bookName);
    if (!book?.entries || !book.entries[uid]) return false;
    
    delete book.entries[uid];
    await ctx.saveWorldInfo(bookName, book);
    
    // Also remove from active list if it was there
    const settings = getSettings();
    if (settings.activeRouterKeys?.includes(id)) {
        settings.activeRouterKeys = settings.activeRouterKeys.filter(k => k !== id);
    }
    
    return true;
}

/**
 * Updates editable fields on a single lorebook entry in-place.
 * Reads the book first so other fields (disable, extensions, etc.) are preserved.
 * @param {string} id - "BookName::uid"
 * @param {{ content?: string, key?: string[], comment?: string }} fields
 * @returns {Promise<boolean>}
 */
export async function updateLorebookEntry(id, fields) {
    const [bookName, uid] = id.split('::');
    if (!bookName || !uid) return false;

    const ctx = SillyTavern.getContext();
    const book = await ctx.loadWorldInfo(bookName);
    if (!book?.entries || !book.entries[uid]) return false;

    const entry = book.entries[uid];
    if (fields.content  !== undefined) entry.content = fields.content;
    if (fields.comment  !== undefined) entry.comment = fields.comment;
    if (fields.key      !== undefined) entry.key     = cleanKeys(fields.key);

    try {
        await ctx.saveWorldInfo(bookName, book);
        return true;
    } catch (e) {
        console.error('[RPG Tracker] updateLorebookEntry failed:', e);
        return false;
    }
}

/**
 * Scans the assistant's narrative output for entry keywords across all scoped
 * lorebooks. Entries whose keys appear in the text are immediately added to
 * activeRouterKeys so the Lorebook Agent sees their full content this turn.
 *
 * Must be called BEFORE runRouterPass on each generation.
 *
 * @param {string} narrativeText - The assistant message that just generated.
 * @param {{ sweepEnabled?: boolean }} [opts]
 * @returns {Promise<string[]>} IDs (Book::uid) of entries newly activated this pass.
 */
export async function scanAssistantOutputForKeywords(narrativeText, opts = {}) {
    if (!narrativeText) return [];
    const sweepEnabled = opts.sweepEnabled !== false; // default true
    const settings = getSettings();
    if (!settings.routerEnabled) return [];

    const ctx = SillyTavern.getContext();
    const prefix = getLivePrefix();
    if (!prefix) return [];

    // Fast Path: use the campaignBooks ownership list if available.
    // This avoids calling updateWorldInfoList() — the same 90-second registry scan
    // that was causing the chat-switch latency — on EVERY generation.
    const chatId = typeof globalThis._rpgCurrentChatId === 'function' ? globalThis._rpgCurrentChatId() : null;
    const knownBooks = chatId ? (settings.chatStates?.[chatId]?.campaignBooks || []) : [];

    let booksToScan;
    if (knownBooks.length > 0) {
        // We know exactly which books belong to this campaign — no registry scan needed.
        booksToScan = [...knownBooks];
    } else {
        // Fallback for first-time chats: discover books via in-memory registry.
        // updateWorldInfoList() is intentionally NOT called here — it triggers a
        // full disk re-index on every message send, causing multi-second latency
        // for users whose chatStates.campaignBooks is empty (new campaigns, no
        // lorebook entries yet). The routerLog fallback below already catches any
        // books not yet visible in the in-memory registry at zero I/O cost.
        // runRouterPass calls updateWorldInfoList() after actual book writes (line ~1298),
        // so the registry is already current by the time the next scan fires.
        const allNames = await getWorldInfoNamesSafe();
        const scoped = allNames.filter(n => bookBelongsToPrefix(n, prefix));

        // Also sweep books referenced in routerLog (catches books not yet re-indexed)
        const logBookNames = (settings.routerLog || [])
            .flatMap(e => [...(e.record || []), ...(e.activate || [])].map(id => id.split('::')[0]))
            .filter(Boolean);
        const scopedSet = new Set(scoped);
        for (const n of logBookNames) {
            if (bookBelongsToPrefix(n, prefix)) scopedSet.add(n);
        }
        booksToScan = [...scopedSet];
    }

    // ── Forward pass: activate entries whose keywords appear in the new narrative ──
    // ── or in the recent history window (Retroactive Lookback).            ──
    const lowerText = narrativeText.toLowerCase();
    const chat = ctx.chat || [];
    const recentMessages = chat.filter(m => !m.is_system); // exclude system messages

    const currentActive = new Set(settings.activeRouterKeys || []);
    const currentKeyword = new Set(settings.keywordActivatedKeys || []);
    const newlyTriggered = [];

    // Cache loaded books so the reverse sweep can reuse them without re-loading.
    /** @type {Map<string, any>} */
    const bookCache = new Map();

    for (const bookName of booksToScan) {
        const book = await ctx.loadWorldInfo(bookName);
        if (!book?.entries) continue;
        bookCache.set(bookName, book);

        for (const [uid, entry] of Object.entries(book.entries)) {
            const fullId = `${bookName}::${uid}`;
            if (currentActive.has(fullId)) continue; // already active — skip

            const keywords = Array.isArray(entry.key) ? entry.key : [];
            if (keywords.length === 0) continue;

            // Check the current narrative text (discovery)
            let matched = keywords.some(kw =>
                typeof kw === 'string' && kw.length > 0 &&
                lowerText.includes(kw.toLowerCase())
            );

            // Retroactive lookback: check history window if not matched in the current text
            if (!matched) {
                const depth = (typeof entry.depth === 'number' && entry.depth > 0) ? entry.depth : (book.scan_depth ?? 4);
                const window = recentMessages.slice(-depth);
                const windowText = window.map(m => (m.mes || m.content || '')).join(' ').toLowerCase();
                matched = keywords.some(kw =>
                    typeof kw === 'string' && kw.length > 0 &&
                    windowText.includes(kw.toLowerCase())
                );
            }

            if (matched) {
                currentActive.add(fullId);
                currentKeyword.add(fullId);
                newlyTriggered.push(fullId);
            }
        }
    }

    // ── Reverse sweep: auto-expire keyword-activated entries whose keywords ──────
    // ── are no longer present in the last `entry.depth` messages.          ──────
    // Only runs on the full onGenerationEnded pass (sweepEnabled=true), not on the
    // lightweight user-message pre-scan from the interceptor.
    if (sweepEnabled) {
        const chat = ctx.chat || [];
        const recentMessages = chat.filter(m => !m.is_system);
        const autoExpired = [];

        for (const id of currentKeyword) {
            if (newlyTriggered.includes(id)) continue;

            const [bookName, uid] = id.split('::');
            if (!bookName || uid === undefined) { autoExpired.push(id); continue; }

            let book = bookCache.get(bookName);
            if (!book) {
                book = await ctx.loadWorldInfo(bookName);
                if (book) bookCache.set(bookName, book);
            }
            const entry = book?.entries?.[uid];
            if (!entry) { autoExpired.push(id); continue; }

            const keywords = Array.isArray(entry.key) ? entry.key : [];
            if (keywords.length === 0) continue;

            const depth = (typeof entry.depth === 'number' && entry.depth > 0) ? entry.depth : (book.scan_depth ?? 4);
            const window = recentMessages.slice(-depth);
            const windowText = window.map(m => (m.mes || m.content || '')).join(' ').toLowerCase();

            const stillPresent = keywords.some(kw =>
                typeof kw === 'string' && kw.length > 0 && windowText.includes(kw.toLowerCase())
            );

            if (!stillPresent) autoExpired.push(id);
        }

        if (autoExpired.length > 0) {
            for (const id of autoExpired) {
                currentActive.delete(id);
                currentKeyword.delete(id);
            }
            if (settings.debugMode) {
                console.log('[RPG Tracker] Keyword scanner auto-expired:', autoExpired);
            }
        }
    }

    // ── Persist ───────────────────────────────────────────────────────────────
    settings.activeRouterKeys = [...currentActive];
    settings.keywordActivatedKeys = [...currentKeyword];
    settings.lastKeywordTriggeredKeys = newlyTriggered;
    ctx.saveSettingsDebounced();

    if (settings.debugMode && newlyTriggered.length > 0) {
        console.log('[RPG Tracker] Keyword scanner activated:', newlyTriggered);
    }

    return newlyTriggered;
}




/**
 * Sets disable: true on every entry in all scoped lorebooks so ST's native
 * keyword scanner never injects managed entries on user-message send.
 * Idempotent — safe to call on every init / chat-change.
 */
export async function disableManagedEntries() {
    const settings = getSettings();
    if (!settings.routerEnabled) return;
    // In native keyword mode, entries are left enabled for ST's keyword scanner to manage.
    if (settings.routerNativeKeywordActivation) return;
    const ctx = SillyTavern.getContext();
    const prefix = getLivePrefix();
    if (!prefix) return;

    try {
        const allNames = await getWorldInfoNamesSafe();
        const scoped = allNames.filter(n => bookBelongsToPrefix(n, prefix));
        for (const bookName of scoped) {
            const book = await ctx.loadWorldInfo(bookName);
            if (!book?.entries) continue;
            let changed = false;
            for (const entry of Object.values(book.entries)) {
                if (!entry.disable) {
                    entry.disable = true;
                    changed = true;
                }
            }
            if (changed) {
                try { await ctx.saveWorldInfo(bookName, book); } catch (_) {}
            }
        }
    } catch (e) {
        console.warn('[RPG Tracker] disableManagedEntries failed:', e);
    }
}

/**
 * Removes duplicates and empty strings from an array of keywords.
 */
function cleanKeys(keys) {
    if (!Array.isArray(keys)) return [];
    return [...new Set(keys.map(k => k?.trim()).filter(Boolean))];
}

/**
 * Given existing lorebook content and a delta the model wants to append,
 * strip any sentences/lines from the delta that are already present in the
 * existing content (the model often echoes the full entry back).
 * Returns only the truly-new content, or an empty string if nothing is new.
 */
function deduplicateContent(existing, delta) {
    if (!existing || !delta) return delta || '';
    const normExisting = existing.toLowerCase();
    // Split delta on newlines; keep a line only if it's not already in existing
    const newLines = delta.split('\n').filter(line => {
        const norm = line.replace(/^\[.*?\]\s*/g, '').trim().toLowerCase();
        // Short or empty fragments are kept as-is (timestamps, separators, etc.)
        if (norm.length < 15) return true;
        return !normExisting.includes(norm);
    });
    return newLines.join('\n').trim();
}

/**
 * Estimates token count using a ~4 chars/token heuristic.
 * Sufficient for threshold comparisons; no tokenizer dependency needed.
 */
function estimateTokens(str) {
    return Math.ceil((str || '').length / 4);
}

/**
 * Returns the set of word bigrams from a string,
 * stripping timestamp markers like [Day X, HH:MM].
 */
function getBigrams(str) {
    const words = str.toLowerCase()
        .replace(/\[[^\]]+\]/g, '')
        .trim()
        .split(/\s+/);
    const bigrams = new Set();
    for (let i = 0; i < words.length - 1; i++) {
        bigrams.add(`${words[i]} ${words[i + 1]}`);
    }
    return bigrams;
}

/**
 * Jaccard similarity between two strings based on word bigrams.
 * Returns 0–1; higher = more similar.
 */
function jaccardSimilarity(a, b) {
    const ba = getBigrams(a), bb = getBigrams(b);
    const intersection = [...ba].filter(x => bb.has(x)).length;
    const union = new Set([...ba, ...bb]).size;
    return union === 0 ? 0 : intersection / union;
}

/**
 * Counts near-duplicate line pairs within a single entry's content.
 * Used to annotate entries in the cleanup context — not passed verbatim to the LLM.
 *
 * @param {string} content
 * @param {number} threshold - Similarity threshold (default 0.6)
 * @returns {number} Count of near-duplicate pairs
 */
function countRedundantPairs(content, threshold = 0.6) {
    const lines = content.split('\n').filter(Boolean);
    let count = 0;
    for (let i = 0; i < lines.length; i++) {
        for (let j = i + 1; j < lines.length; j++) {
            if (jaccardSimilarity(lines[i], lines[j]) >= threshold) count++;
        }
    }
    return count;
}

