import { getSettings } from './state-manager.js';
import { sendStateRequest, sendAgentTurn } from './llm-client.js';
import { getRequestHeaders } from '../../../../script.js';

let _routerRunning = false;

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
 * Builds the summary "Keyring" text for archive entries.
 */
function buildKeyringText(allBooks) {
    let lines = [];
    for (const [bookName, bookData] of Object.entries(allBooks)) {
        if (!bookData || !bookData.entries) continue;
        for (const [uid, entry] of Object.entries(bookData.entries)) {
            const keys = (entry.key || []).join(', ');
            lines.push(`[ARCHIVE] Label: ${entry.comment || entry.key?.[0] || 'Unnamed'} | Keys: [${keys}]`);
        }
    }
    return lines.join('\n');
}

/**
 * The core Researcher Agent loop.
 */
export async function runRouterPass(narrativeOutput, manualPrompt = null, customLookback = null, isManual = false) {
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
        const prefix = settings.routerCampaignPrefix || '';
        let basicSummary = '';
        
        async function fetchArchiveBooks() {
            // Flush ST's in-memory registry so books written via HTTP API in prior passes are visible
            if (typeof ctx.updateWorldInfoList === 'function') {
                try { await ctx.updateWorldInfoList(); } catch (_) {}
            }
            const allBookNames = await getWorldInfoNamesSafe();
            const scoped = new Set(prefix ? allBookNames.filter(n => n.startsWith(prefix)) : allBookNames);

            // Also sweep books referenced in routerLog (catches books not yet formally indexed)
            const logBookNames = (settings.routerLog || [])
                .flatMap(e => [...(e.record || []), ...(e.activate || [])].map(id => id.split('::')[0]))
                .filter(Boolean);
            for (const n of logBookNames) {
                if (!prefix || n.startsWith(prefix)) scoped.add(n);
            }

            const books = {};
            for (const n of scoped) {
                const b = await ctx.loadWorldInfo(n);
                if (b?.entries) books[n] = b;
            }
            return books;
        }

        let archiveBooks = await fetchArchiveBooks();

        // â”€â”€ Snapshot state BEFORE this pass (for rollback) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        {
            const snapshot = {
                timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
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

        function updateActiveEntries() {
            activeEntriesFull = [];
            for (const [name, book] of Object.entries(archiveBooks)) {
                for (const [uid, entry] of Object.entries(book.entries)) {
                    if (settings.activeRouterKeys?.includes(`${name}::${uid}`)) {
                        activeEntriesFull.push(`### [ACTIVE] ${entry.comment || entry.key?.[0] || `${name}::${uid}`}\nID: ${name}::${uid}\nContent: ${entry.content}`);
                    }
                }
            }
        }
        updateActiveEntries();

        let keyringText = buildKeyringText(archiveBooks);
        const { chat } = ctx;
        
        const N = customLookback !== null ? customLookback : (settings.routerLookback || 3);
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

        const basePrompt = (settings.routerSystemPromptTemplate || 'You are the Lorebook Agent. Maintain narrative consistency and manage lorebooks.')
            .replace(/\{\{campaignRoot\}\}/g, prefix || 'World Chronicle')
            .replace(/\{\{user\}\}/g, ctx.name1 || 'User');

        // -- Basic Mode (tag-based, one-shot, no tool calling) -----------------
        if (settings.routerBasicMode) {
            const modules = settings.routerModules || {};
            const customTags = settings.routerCustomTags || [];
            const formatLines = [];
            for (const config of Object.values(modules)) {
                if (config.enabled) formatLines.push(`- [[${config.tag}: ${config.format}]] (${config.instruction})`);
            }
            for (const custom of customTags) {
                formatLines.push(`- [[${custom.tag}: Name | Description | Keywords]] (${custom.instruction})`);
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

NPC / FAC / QUEST / EVENT labels: Name only — NO " :: " hierarchy, NO tag prefix.
Example: [[FAC: Iron Syndicate | ...]]  NOT  [[FAC: Khelt :: Iron Syndicate | ...]]  and  NOT  [[FAC: FAC: Iron Syndicate | ...]]

## ATTENTION & MEMORY
1. **ACTIVE MEMORY**: You can see the full details of these entities. You can update them at any time.
2. **ARCHIVE INDEX**: You only see names and keywords. You CANNOT see their full biography.
3. **RECALL**: To "read" or "update" an archive entry, you MUST first use [[ACTIVATE: Name]]. It will become visible in the next turn.
4. **LIMIT**: You are limited to **${settings.routerMaxActivations || 5} active entries**. If you need to activate a new one but are at the limit, you MUST use [[DEACTIVATE: Name]] on the least relevant active entry to make room. Prioritize currently present characters and locations.

## RULES
1. Only record persistent or significant entities/events.
2. Use ACTIVATE to bring an existing entry into the current scene context.
3. Use DEACTIVATE to remove an entry that is no longer relevant to the scene.
4. Use DELETE to permanently remove duplicate or redundant entries.
5. Output your thoughts first, then the tags.

Example:
Thought: I see a new NPC named Barnaby in Khelt's Rust-Lantern District. I will record him and the tavern.
[[NPC: Barnaby | A retired blacksmith with a scar on his cheek. | Barnaby, blacksmith, ally]]
[[LOC: Khelt :: Rust-Lantern District :: Barnaby's Forge | Barnaby's old workshop, still smelling of soot. | forge, Khelt, Rust-Lantern]]`;

            const questMatchB = settings.currentMemo?.match(/\[QUESTS\]([\s\S]*?)\[\/QUESTS\]/i);
            const questBlockB = questMatchB ? `[QUESTS]${questMatchB[1].trim()}[/QUESTS]` : 'None';
            const basicUserPrompt = `## CURRENT LOCATION\n${currentHierarchy || 'Unknown'}\n\n## ACTIVE QUESTS\n${questBlockB}\n\n## ACTIVE MEMORY (Lore)\n${activeEntriesFull.join('\n\n') || 'None'}\n\n## ARCHIVE INDEX\n${keyringText}\n\n## NARRATIVE\n${recentChat}\n\n${manualPrompt ? `## INSTRUCTION\n${manualPrompt}\n\n` : ''}`;

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
                                delete_ids: { type: 'array', items: { type: 'string' }, description: 'Book::UID IDs to permanently delete.' }
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
Maximum Active Entities: **${settings.routerMaxActivations || 5}**.
- Entries you record are ACTIVATED AUTOMATICALLY. Do NOT also include them in activate.
- If at the limit and need space, use deactivate in the same commit call.
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
                // Clean prompt for native tool calling — model gets schemas via the API
                ? `${basePrompt}

## YOUR ROLE
You are a lorebook research agent. Maintain the campaign lorebook using the provided tools.
Use grep_lore / inspect_book / read_entry to look up existing data before recording.
When research is complete, call commit once to write all changes. Stop immediately after.
${sharedContext}`
                // Text-format prompt for profile/default — model outputs Action:/Observation: text
                : `${basePrompt}

## YOUR ROLE
You are a lorebook research agent. Maintain the campaign lorebook using the actions below.
Use grep_lore / inspect_book / read_entry to look up existing data before recording.
When research is complete, output commit once to write all changes, then stop.

## ACTIONS
Output exactly ONE action per turn in this format:
  Action: toolname({"arg": "value"})

Available actions:
- grep_lore({"query": "..."}) — search lorebooks for entries matching a keyword
- inspect_book({"book_name": "..."}) — list UIDs in a lorebook
- read_entry({"uid": "Book::0"}) — read full content of an entry
- commit({"record": [...], "update": [...], "activate": [...], "deactivate": [...], "delete_ids": [...]}) — write all changes and finish

commit record items: {"label": "Name only (NO tag prefix)", "keys": ["kw1","kw2"], "content": "...", "category": "NPC|LOC|FAC|QUEST|EVENT"}
commit update items: {"id": "Book::UID", "content": "new text to append"}

## EXAMPLE
Thought: I see a new faction called Iron Syndicate. I will record it.
Action: commit({"record": [{"label": "Iron Syndicate", "keys": ["Khelt", "faction"], "content": "The dominant industrial authority.", "category": "FAC"}]})
${sharedContext}`;

            const questMatchA = settings.currentMemo?.match(/\[QUESTS\]([\s\S]*?)\[\/QUESTS\]/i);
            const questBlockA = questMatchA ? `[QUESTS]${questMatchA[1].trim()}[/QUESTS]` : 'None';
            const contextMessage = `## CURRENT LOCATION\n${currentHierarchy || 'Unknown'}\n\n## ACTIVE QUESTS\n${questBlockA}\n\n## ACTIVE MEMORY (Lore)\n${activeEntriesFull.join('\n\n') || 'None yet.'}\n\n## ARCHIVE INDEX\n${keyringText || 'Empty.'}\n\n## NARRATIVE\n${recentChat}${manualPrompt ? `\n\n## INSTRUCTION\n${manualPrompt}` : ''}`;

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
                    // No tool call and no parseable action — model is done
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
                    keyringText = buildKeyringText(archiveBooks);
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

    // 2. Update existing
    const updates = action.update || [];
    for (const up of updates) {
        const [bookName, uid] = up.id.split('::');
        const book = await ctx.loadWorldInfo(bookName);
        if (book?.entries?.[uid]) {
            // Strip [ID:] stamp from anywhere in the delta (model sometimes echoes it)
            let delta = (up.content || '').replace(/\[ID:[^\]]+\]\n?/gi, '').trim();
            if (timePrefix && !delta.includes('[Day')) {
                delta = timePrefix.trim() + ' ' + delta;
            }
            // Append delta to the existing chronicle
            const existing = (book.entries[uid].content || '').replace(/^\[ID:[^\]]+\]\n?/i, '').trimEnd();
            book.entries[uid].content = existing ? `${existing}\n${delta}` : delta;
            await ctx.saveWorldInfo(bookName, book);
            changed = true;
        }
    }
    // 3. Record new (with Deduplication)
    // Group entries by target book and commit once per book to avoid UID collisions
    const records = action.record || [];
    const prefix = settings.routerCampaignPrefix || '';
    const baseBook = prefix || 'World Chronicle';
    const recordedIds = [];

    // -- Phase A: Route each record to its target book --
    const catMap = { 'NPC': 'NPCs', 'LOC': 'Locations', 'QUEST': 'Quests', 'FAC': 'Factions', 'EVENT': 'Events' };
    // Extend with user-defined custom tags so they get their own books (e.g. WEATHER → prefix_Weather)
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
        // e.g. "FAC: Iron Syndicate" → "Iron Syndicate", "STATS: Thalric Thorne" → "Thalric Thorne"
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
                bookData.entries[existingUid].content = existing ? `${existing}\n${delta}` : delta;
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
                    order: 100, position: 0, disable: false,
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

    // 4. Enforce Max Activations (FIFO Pruning)
    const maxActive = settings.routerMaxActivations || 5;
    if (newActive.length > maxActive) {
        const countBefore = newActive.length;
        newActive = newActive.slice(newActive.length - maxActive);
        if (newActive.length !== countBefore) changed = true;
    }
    
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
        const prefix = settings.routerCampaignPrefix || '';

        // ── Step 1: Delete lorebooks that were CREATED during the pass ────────
        // Fetch current book list scoped to the campaign prefix (or all if none).
        const allCurrentNames = await getWorldInfoNamesSafe();
        const scopedCurrent = prefix
            ? allCurrentNames.filter(n => n.startsWith(prefix))
            : allCurrentNames;

        for (const bookName of scopedCurrent) {
            if (prePassBooks.has(bookName)) continue; // Pre-existed — restore below, don't delete
            // This book was CREATED during the pass — permanently delete it
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

        // ── Step 2: Restore pre-pass lorebooks to their snapshotted state ─────
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

        // ── Step 3: Restore active keys ───────────────────────────────────────
        settings.activeRouterKeys = JSON.parse(JSON.stringify(snapshot.activeRouterKeys || []));

        // ── Step 4: Trim snapshots newer than the restored point ──────────────
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
    const action = { record: [], update: [], activate: [], deactivate: [], delete_ids: [] };
    const settings = getSettings();

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
        } else if (tagName === 'QUEST' && parts.length >= 3) {
            const name = parts[0];
            const loc = parts[1];
            const desc = parts[2];
            const keywords = parts[3] || '';
            processMatch(name, `[Location: ${loc}] ${desc}`, keywords, 'QUEST');
        } else if (parts.length >= 3) {
            processMatch(parts[0], parts[1], parts[2], tagName);
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
            
            const prefix = settings.routerCampaignPrefix || '';
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
    const prefix = settings.routerCampaignPrefix || '';
    
    // Always flush ST's registry from disk first so books written via HTTP API are visible
    if (typeof ctx.updateWorldInfoList === 'function') {
        try { await ctx.updateWorldInfoList(); } catch (_) {}
    }

    const names = await getWorldInfoNamesSafe();
    const scoped = prefix ? names.filter(n => n.startsWith(prefix)) : names;
    
    // Fallback 1: books referenced in activeRouterKeys (not yet in registry)
    const activeBookNames = (settings.activeRouterKeys || [])
        .map(k => k.split('::')[0])
        .filter(Boolean);
    for (const n of activeBookNames) {
        if (!scoped.includes(n) && (!prefix || n.startsWith(prefix))) {
            scoped.push(n);
        }
    }
    
    // Fallback 2: books referenced in routerLog records (catches deactivated entries
    // whose books are no longer in activeRouterKeys nor in ST's registry yet)
    const logBookNames = (settings.routerLog || [])
        .flatMap(e => [...(e.record || []), ...(e.activate || [])].map(id => id.split('::')[0]))
        .filter(Boolean);
    for (const n of logBookNames) {
        if (!scoped.includes(n) && (!prefix || n.startsWith(prefix))) {
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
 * Removes duplicates and empty strings from an array of keywords.
 */
function cleanKeys(keys) {
    if (!Array.isArray(keys)) return [];
    return [...new Set(keys.map(k => k?.trim()).filter(Boolean))];
}