import { getSettings } from './state-manager.js';
import { sendStateRequest } from './llm-client.js';

let _routerRunning = false;

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
export async function runRouterPass(narrativeOutput, manualPrompt = null, customLookback = null) {
    const settings = getSettings();
    if (!settings.routerEnabled || _routerRunning) return;

    const ctx = SillyTavern.getContext();
    if (!ctx.generateRaw) return;

    try {
        _routerRunning = true;
        broadcastStep('start', 'Initializing Lorebook Agent...');

        const startTime = Date.now();
        const prefix = settings.routerCampaignPrefix || '';
        let basicSummary = '';
        
        async function fetchArchiveBooks() {
            const allBookNames = await getWorldInfoNamesSafe();
            const scoped = prefix ? allBookNames.filter(n => n.startsWith(prefix)) : allBookNames;
            const books = {};
            for (const n of scoped) {
                const b = await ctx.loadWorldInfo(n);
                if (b?.entries) books[n] = b;
            }
            return books;
        }

        let archiveBooks = await fetchArchiveBooks();
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
        let loopHistory = [];
        let finalAction = null;

        const basePrompt = (settings.routerSystemPromptTemplate || "You are the Lorebook Agent. Maintain narrative consistency and manage lorebooks.")
            .replace(/\{\{campaignRoot\}\}/g, prefix || 'World Chronicle')
            .replace(/\{\{user\}\}/g, ctx.name1 || 'User');

        const systemPrompt = `${basePrompt}

## TOOLS
1. grep_lore(query): Search all lorebooks in scope ("${prefix || 'All'}") for keywords.
2. inspect_book(book_name): List entries in a specific book.
3. read_entry(uid): Read the full content of an archive entry.
4. commit(activate, deactivate, record, update, delete_ids): Final action. Ends loop.
   - activate/deactivate: ["Book::UID", ...] (Toggles presence in active context)
   - record: [{"label": "Title/Name", "keys": ["keyword1", ...], "content": "Description", "category": "NPC/LOC/QUEST"}]
   - update: [{"id": "Book::UID", "content": "Full new content"}]
   - delete_ids: ["Book::UID", ...] (Permanently REMOVES from lorebook)

## MEMORY LIMIT
Maximum Active Entities: **${settings.routerMaxActivations || 5}**.
- If you are at the limit and need to activate a new entity, you MUST use \`commit({"deactivate": ["Book::UID"]})\` on the least relevant active entity.
- **IMPORTANT**: Entries you \`record\` are ACTIVATED AUTOMATICALLY. Do not include them in the \`activate\` list of the same commit.
- **IMPORTANT**: You MUST use the exact \`Book::UID\` format for activation/update. Never use names or invent IDs.

## PROCESS
1. **SEARCH FIRST**: Use \`grep_lore\` or \`inspect_book\` to find IDs.
2. **MODULAR UPDATES**: You can use \`commit\` to record NEW info or update existing entries. 
   - **Note**: If you \`record\` an entry with a label that already exists, it will AUTOMATICALLY update the existing one.
3. **TERMINATION**: You are allocated a turn budget, but you should **STOP** as soon as the archive is synchronized with the latest events. To finish, simply provide a final Thought summarizing your work and **do not output any Action tag**.

Campaign Root: "${prefix || 'World Archive'}" (NPCs/Locations go into "${prefix ? prefix + '_NPCs' : 'NPCs'}" or "${prefix ? prefix + '_Locations' : 'Locations'}").

## EXAMPLE
Thought: The user mentioned Elara. I will check if she exists.
Action: grep_lore("Elara")
Observation: Found "Adventure_NPCs::0" (Elara).
Thought: She already exists. I will update her description and activate her.
Action: commit({"update":[{"id":"Adventure_NPCs::0","content":"Now a known ally."}], "activate":["Adventure_NPCs::0"]})
Observation: Committed successfully.
Thought: I have updated Elara. Research complete.

Campaign Root: "${prefix || 'World Archive'}"
Hierarchy: When recording locations or NPCs, use the current breadcrumb (${breadcrumb || 'Root'}) as a prefix in the label using the " :: " separator.
Example: "Khelt :: Section Four :: Impact Site"

Categories: Always include "In: [Parent]" in the keywords for every ancestor in the hierarchy.
Example Keywords: "scholarly, In: Khelt, In: Section Four" (Note: do not include the name of the entry itself or parents without the "In:" prefix).

## FIELD INSTRUCTIONS
${Object.values(settings.routerModules || {}).filter(m => m.enabled).map(m => `- ${m.tag}: ${m.instruction}`).join('\n')}
${(settings.routerCustomTags || []).map(m => `- ${m.tag}: ${m.instruction}`).join('\n')}
`;

        while (turns < maxTurns) {
            turns++;
            
            const questMatch = settings.currentMemo?.match(/\[QUESTS\]([\s\S]*?)\[\/QUESTS\]/i);
            const questBlock = questMatch ? `[QUESTS]${questMatch[1].trim()}[/QUESTS]` : 'None';
            
            const userPrompt = `## CURRENT LOCATION\n${currentHierarchy || 'Unknown'}\n\n## ACTIVE QUESTS\n${questBlock}\n\n## ACTIVE MEMORY (Lore)\n${activeEntriesFull.join('\n\n') || 'None'}\n\n## ARCHIVE INDEX\n${keyringText}\n\n## NARRATIVE\n${recentChat}\n\n${manualPrompt ? `## INSTRUCTION\n${manualPrompt}\n\n` : ''}${loopHistory.join('\n\n')}\n\nNext Step:`;

            const routerSettings = {
                ...settings,
                connectionSource: settings.routerConnectionSource || "default",
                connectionProfileId: settings.routerConnectionProfileId,
                completionPresetId: settings.routerCompletionPresetId,
                ollamaUrl: settings.routerOllamaUrl,
                ollamaModel: settings.routerOllamaModel,
                openaiUrl: settings.routerOpenaiUrl,
                openaiKey: settings.routerOpenaiKey,
                openaiModel: settings.routerOpenaiModel,
                maxTokens: settings.routerMaxTokens || 1000,
            };

            broadcastStep('thought', `Thinking (Turn ${turns}/${maxTurns})...`);
            
            let currentSystemPrompt = systemPrompt;
            if (settings.routerBasicMode) {
                const modules = settings.routerModules || {};
                const customTags = settings.routerCustomTags || [];
                
                let formatLines = [];
                for (const [id, config] of Object.entries(modules)) {
                    if (config.enabled) {
                        formatLines.push(`- [[${config.tag}: ${config.format}]] (${config.instruction})`);
                    }
                }
                for (const custom of customTags) {
                    formatLines.push(`- [[${custom.tag}: Name | Description | Keywords]] (${custom.instruction})`);
                }
                formatLines.push(`- [[ACTIVATE: Name]] (Bring entry to active memory)`);
                formatLines.push(`- [[DEACTIVATE: Name]] (Remove from active memory)`);
                formatLines.push(`- [[DELETE: Name]] (Permanently remove an entry)`);

                currentSystemPrompt = `You are the Research Assistant. Your task is to identify and record important narrative entities and events.

## FORMAT
Use these tags in your response:
${formatLines.join('\n')}

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
Thought: I see a new NPC named Barnaby. I will record him.
[[NPC: Barnaby | A retired blacksmith with a scar on his cheek. | Barnaby, blacksmith, ally]]`;
            }

            const response = await sendStateRequest(routerSettings, currentSystemPrompt, userPrompt);
            
            // Debug capture
            settings.routerLastRequest = {
                system: currentSystemPrompt,
                user: userPrompt,
                chars: (currentSystemPrompt.length + userPrompt.length),
                estTokens: Math.ceil((currentSystemPrompt.length + userPrompt.length) / 4)
            };

            if (settings.routerBasicMode) {
                const thoughtMatch = response.match(/Thought:\s*([\s\S]*?)(?=\[\[|$)/i);
                if (thoughtMatch) broadcastStep('thought', thoughtMatch[1].trim());

                broadcastStep('thought', 'Parsing tags...');
                const basicAction = parseBasicTags(response, archiveBooks);
                
                if (basicAction.record.length > 0 || basicAction.update.length > 0 || basicAction.activate.length > 0 || basicAction.delete_ids?.length > 0) {
                    const summaries = [];
                    if (basicAction.record.length) summaries.push(`New: ${basicAction.record.length}`);
                    if (basicAction.update.length) summaries.push(`Updates: ${basicAction.update.length}`);
                    if (basicAction.activate.length) summaries.push(`Activations: ${basicAction.activate.length}`);
                    
                    basicAction.reason = (thoughtMatch ? thoughtMatch[1].trim() : "Tag-based update.") + ` (${summaries.join(', ')})`;
                    
                    await applyAction(basicAction, archiveBooks, currentTime, breadcrumb);
                    basicSummary = summaries.join(', ');
                } else {
                    broadcastStep('finish', 'Basic Mode: No tags found.');
                }
                break; // One-shot for basic mode
            }

            const thoughtMatch = response.match(/Thought:\s*([\s\S]*?)(?=Action:|$)/i);
            const actionMatch = response.match(/(?:Action:\s*)?(\w+)\(([\s\S]*)\)/i);

            if (thoughtMatch) broadcastStep('thought', thoughtMatch[1].trim());

            if (actionMatch) {
                const toolName = actionMatch[1].toLowerCase();
                const argsStr = actionMatch[2].trim();
                broadcastStep('tool', `${toolName}(...)`);

                let observation = "";
                if (toolName === 'commit') {
                    const cleanJson = (str) => {
                        let clean = str.match(/\{[\s\S]*\}/)?.[0] || str;
                        if (!clean.includes('"') && clean.includes("'")) {
                            clean = clean.replace(/'/g, '"');
                        }
                        clean = clean.replace(/,\s*\}/g, '}').replace(/,\s*\]/g, ']');
                        return clean;
                    };

                    try {
                        const currentAction = JSON.parse(cleanJson(argsStr));
                        const result = await applyAction(currentAction, archiveBooks, currentTime, breadcrumb);
                        
                        // REFRESH STATE: Re-load books so next loop sees new entries
                        archiveBooks = await fetchArchiveBooks();
                        keyringText = buildKeyringText(archiveBooks);
                        updateActiveEntries();
                        
                        if (result.errors.length > 0) {
                            observation = `Committed with warnings: ${result.errors.join(', ')}`;
                        } else {
                            const details = [];
                            if (result.recordedIds?.length > 0) details.push(`Recorded/Updated: ${result.recordedIds.join(', ')}`);
                            if (currentAction.activate?.length > 0) details.push(`Activated: ${currentAction.activate.join(', ')}`);
                            observation = `Committed successfully. ${details.join(' | ')}`;
                        }
                    } catch (e) {
                        observation = `Error: Invalid JSON in commit. ${e.message}`;
                    }
                } else if (toolName === 'grep_lore') {
                    const query = argsStr.replace(/['"]/g, '').trim();
                    const results = [];
                    for (const [name, book] of Object.entries(archiveBooks)) {
                        for (const [uid, entry] of Object.entries(book.entries)) {
                            if (entry.content.toLowerCase().includes(query.toLowerCase())) {
                                results.push(`[${name}::${uid}] Match: ${entry.content.substring(0, 100)}...`);
                            }
                        }
                    }
                    observation = results.length > 0 ? results.join('\n') : "No matches found.";
                } else if (toolName === 'inspect_book') {
                    const bookName = argsStr.replace(/['"]/g, '').trim();
                    if (archiveBooks[bookName]) {
                        observation = Object.entries(archiveBooks[bookName].entries)
                            .map(([uid, e]) => `${bookName}::${uid} - ${e.comment || e.key?.[0]}`)
                            .join('\n');
                    } else {
                        observation = "Error: Book not found.";
                    }
                } else if (toolName === 'read_entry') {
                    const uid = argsStr.replace(/['"]/g, '').trim();
                    const [bookName, id] = uid.split('::');
                    const book = await ctx.loadWorldInfo(bookName);
                    observation = book?.entries?.[id] ? book.entries[id].content : "Error: Entry not found.";
                } else {
                    observation = "Error: Unknown tool.";
                }

                broadcastStep('result', observation.substring(0, 200) + (observation.length > 200 ? '...' : ''));
                loopHistory.push(`Thought: ${thoughtMatch?.[1] || '...'}\nAction: ${toolName}(${argsStr})\nObservation: ${observation}`);
            } else {
                break; 
            }
        }

        const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
        const finishMsg = basicSummary ? `Finished in ${totalTime}s — ${basicSummary}` : `Finished in ${totalTime}s`;
        broadcastStep('finish', finishMsg, { time: totalTime, turns });

        // Final application for Basic Mode
        if (settings.routerBasicMode && turns === 1) {
             // Handled inside the loop
        } else if (finalAction) {
            await applyAction(finalAction, archiveBooks);
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

    // 2. Update existing
    const updates = action.update || [];
    for (const up of updates) {
        const [bookName, uid] = up.id.split('::');
        const book = await ctx.loadWorldInfo(bookName);
        if (book?.entries?.[uid]) {
            let newContent = up.content;
            if (timePrefix && !newContent.includes('[Day')) {
                newContent = timePrefix + newContent;
            }
            book.entries[uid].content = newContent;
            await ctx.saveWorldInfo(bookName, book);
            changed = true;
        }
    }

    // 3. Record new (with Deduplication)
    const records = action.record || [];
    const prefix = settings.routerCampaignPrefix || '';
    const recordedIds = [];
    for (const rec of records) {
        // Map category to book name
        const allBookNames = Object.keys(allBooks);
        const baseBook = prefix || 'World Chronicle';
        let targetBook = baseBook;
        const cat = (rec.category || rec.comment || '').toUpperCase();
        
        const catMap = { 'NPC': 'NPCs', 'LOC': 'Locations', 'QUEST': 'Quests', 'FAC': 'Factions', 'EVENT': 'Events' };
        const catName = Object.keys(catMap).find(k => cat.includes(k));
        const targetCat = catName ? catMap[catName] : null;

        if (targetCat) {
            const prefixed = prefix ? `${prefix}_${targetCat}` : targetCat;
            // Always prefer the category-specific name (will be created if missing)
            targetBook = prefixed;
        } else {
            targetBook = baseBook;
        }

        if (settings.debugMode) console.log(`[RPG Tracker] Routing ${cat} "${rec.label}" to: ${targetBook}`);

        if (cat.includes('EVENT')) {
            if (currentTime && !rec.label.includes('[Day')) {
                rec.label = `[${currentTime}] ${rec.label}`;
            }
        }

        // Apply temporal content tagging to ALL records
        if (timePrefix && !rec.content.includes('[Day')) {
            rec.content = timePrefix + rec.content;
        }

        // DEDUPLICATION: Check if an entry with this label already exists in the target book
        let existingUid = null;
        const targetBookData = allBooks[targetBook];
        if (targetBookData?.entries) {
            const cleanLabel = (rec.label || '').replace(/^\[Day[^\]]+\]\s*/i, '').toLowerCase().trim();
            for (const [uid, entry] of Object.entries(targetBookData.entries)) {
                const entryLabel = (entry.comment || '').replace(/^\[Day[^\]]+\]\s*/i, '').toLowerCase().trim();
                if (entryLabel === cleanLabel) {
                    existingUid = uid;
                    break;
                }
            }
        }

        if (existingUid) {
            // Convert record to update
            const book = await ctx.loadWorldInfo(targetBook);
            if (book?.entries?.[existingUid]) {
                book.entries[existingUid].content = rec.content;
                // Update keywords to include hierarchy if missing
                const keys = book.entries[existingUid].key || [];
                const parts = (breadcrumb || '').split(' :: ').filter(Boolean);
                if (parts.length > 0) {
                    const hierarchyKey = `In: ${parts.join(', ')}`;
                    if (!keys.includes(hierarchyKey)) keys.push(hierarchyKey);
                }
                (rec.keys || []).forEach(k => { if (!keys.includes(k)) keys.push(k); });
                book.entries[existingUid].key = cleanKeys(keys);

                await ctx.saveWorldInfo(targetBook, book);
                const fullId = `${targetBook}::${existingUid}`;
                if (!newActive.includes(fullId)) newActive.push(fullId);
                recordedIds.push(`${fullId} (updated existing)`);
                changed = true;
            }
        } else {
            // Force hierarchical keywords if not provided by Agent
            if (currentTime && !rec.keys?.some(k => k.startsWith('In:'))) {
                const parts = (breadcrumb || '').split(' :: ').filter(Boolean);
                if (parts.length > 0) {
                    rec.keys = rec.keys || [];
                    const hierarchyKey = `In: ${parts.join(', ')}`;
                    if (!rec.keys.includes(hierarchyKey)) rec.keys.push(hierarchyKey);
                }
            }
            rec.keys = cleanKeys(rec.keys || []);

            const newId = await addLorebookEntry(targetBook, rec, Object.keys(allBooks));
            if (!newActive.includes(newId)) {
                newActive.push(newId);
            }
            recordedIds.push(newId);
            changed = true;
        }
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
        ctx.saveSettingsDebounced();
        document.dispatchEvent(new CustomEvent('rt_lore_agent_updated'));
    }

    return { success: true, errors, recordedIds };
}

/**
 * Parses basic narrative tags [[TAG: ...]]
 */
function parseBasicTags(text, archiveBooks) {
    const action = { record: [], update: [], activate: [], deactivate: [], delete_ids: [] };
    const settings = getSettings();

    const processMatch = (name, content, keywords, category) => {
        name = name.trim();
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
    const tagRegex = /\[\[(\w+):\s*([^\]]+?)\s*\]\]/gi;
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

    const existingUids = Object.keys(bookData.entries).map(Number).filter(n => !isNaN(n));
    const nextUid = existingUids.length > 0 ? Math.max(...existingUids) + 1 : 0;
    
    bookData.entries[nextUid] = {
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
    
    await ctx.saveWorldInfo(lorebookName, bookData);
    
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
            maxTokens: settings.routerMaxTokens || 1000,
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
    
    const names = await getWorldInfoNamesSafe();
    const scoped = prefix ? names.filter(n => n.startsWith(prefix)) : names;
    
    const manifest = [];
    for (const n of scoped) {
        const b = await ctx.loadWorldInfo(n);
        if (!b?.entries) continue;
        for (const [uid, entry] of Object.entries(b.entries)) {
            manifest.push({
                id: `${n}::${uid}`,
                book: n,
                uid: uid,
                label: entry.comment || entry.key?.[0] || 'Unnamed',
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
