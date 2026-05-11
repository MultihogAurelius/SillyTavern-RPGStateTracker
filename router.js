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
        
        async function fetchArchiveBooks() {
            const names = await ctx.getWorldInfoNames();
            const scoped = prefix ? names.filter(n => n.startsWith(prefix)) : names;
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
If you are at the limit and need to activate a new entity, you MUST use \`commit({"deactivate": ["Book::UID"]})\` on the least relevant active entity to make room.

## PROCESS
1. **SEARCH FIRST**: Always use \`grep_lore\` or \`inspect_book\` before recording a new entry to prevent duplicates.
2. **CONSOLIDATE**: If you find duplicates, use \`delete_ids\` to remove the redundant ones and \`update\` the primary one with the combined info.
3. Use Thought/Action/Observation. You can call "commit" multiple times. Your turn ends when you provide a "Thought" without an "Action".

## EXAMPLE
Thought: The user mentioned Elara. I will check if she exists.
Action: grep_lore("Elara")
Observation: Found "Adventure_NPCs::0" (Elara).
Thought: She already exists. I will update her description and activate her.
Action: commit({"update":[{"id":"Adventure_NPCs::0","content":"Now a known ally."}], "activate":["Adventure_NPCs::0"]})
Observation: Committed successfully.
Thought: I have updated Elara. Research complete.

Campaign Root: "${prefix || 'None'}" (All records go here. NPCs/Locations may be sorted into "${prefix ? prefix + '_NPCs' : 'NPCs'}" or "${prefix ? prefix + '_Locations' : 'Locations'}").

## FIELD INSTRUCTIONS
${Object.values(settings.routerModules || {}).filter(m => m.enabled).map(m => `- ${m.tag}: ${m.instruction}`).join('\n')}
${(settings.routerCustomTags || []).map(m => `- ${m.tag}: ${m.instruction}`).join('\n')}
`;

        while (turns < maxTurns) {
            turns++;
            const userPrompt = `## CURRENT STATE (Trackers/Clock)\n${settings.currentMemo || 'None'}\n\n## ACTIVE MEMORY (Lore)\n${activeEntriesFull.join('\n\n') || 'None'}\n\n## ARCHIVE INDEX\n${keyringText}\n\n## NARRATIVE\n${recentChat}\n\n${manualPrompt ? `## INSTRUCTION\n${manualPrompt}\n\n` : ''}${loopHistory.join('\n\n')}\n\nNext Step:`;

            const routerSettings = {
                ...settings,
                connectionSource: settings.routerConnectionSource || "default",
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
                broadcastStep('thought', 'Parsing tags...');
                const basicAction = parseBasicTags(response, archiveBooks);
                if (basicAction.record.length > 0 || basicAction.update.length > 0) {
                    await applyAction(basicAction);
                    broadcastStep('finish', `Basic Mode: Processed ${basicAction.record.length} records and ${basicAction.update.length} updates.`);
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
                        await applyAction(currentAction);
                        
                        // REFRESH STATE: Re-load books so next loop sees new entries
                        archiveBooks = await fetchArchiveBooks();
                        keyringText = buildKeyringText(archiveBooks);
                        updateActiveEntries();
                        
                        observation = "Committed successfully. Archive updated.";
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
        broadcastStep('finish', `Finished in ${totalTime}s`, { time: totalTime, turns });
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
 */
async function applyAction(action) {
    const settings = getSettings();
    const ctx = SillyTavern.getContext();
    let changed = false;

    // 1. Activate/Deactivate
    const activate = action.activate || [];
    const deactivate = action.deactivate || [];
    let newActive = [...(settings.activeRouterKeys || [])];
    
    // Remove deactivations
    newActive = newActive.filter(k => !deactivate.includes(k));
    
    // Add activations
    for (const k of activate) {
        if (!newActive.includes(k)) {
            newActive.push(k);
            changed = true;
        }
    }
    if (deactivate.length > 0) changed = true;

    // 2. Update existing
    const updates = action.update || [];
    for (const up of updates) {
        const [bookName, uid] = up.id.split('::');
        const book = await ctx.loadWorldInfo(bookName);
        if (book?.entries?.[uid]) {
            book.entries[uid].content = up.content;
            await ctx.saveWorldInfo(bookName, book);
            changed = true;
        }
    }

    // 3. Record new
    const records = action.record || [];
    const prefix = settings.routerCampaignPrefix || '';
    for (const rec of records) {
        // Map category to book name
        let targetBook = prefix || 'World Chronicle';
        const cat = (rec.category || rec.comment || '').toUpperCase();
        if (cat.includes('NPC')) targetBook = prefix ? `${prefix}_NPCs` : 'NPCs';
        else if (cat.includes('LOC')) targetBook = prefix ? `${prefix}_Locations` : 'Locations';
        else if (cat.includes('QUEST')) targetBook = prefix ? `${prefix}_Quests` : 'Quests';
        else if (cat.includes('FAC')) targetBook = prefix ? `${prefix}_Factions` : 'Factions';
        else if (cat.includes('EVENT')) targetBook = prefix ? `${prefix}_Events` : 'Events';

        const newId = await addLorebookEntry(targetBook, rec);
        if (!newActive.includes(newId)) {
            newActive.push(newId);
        }
        changed = true;
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
            record: records.map(r => r.label || r.id),
            delete: deleteIds,
            reason: action.reason || (settings.routerBasicMode ? "Tag-based update." : "Agent tool update.")
        });
        if (settings.routerLog.length > 50) settings.routerLog.length = 50;
        ctx.saveSettingsDebounced();
        document.dispatchEvent(new CustomEvent('rt_lore_agent_updated'));
    }
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
async function addLorebookEntry(lorebookName, entryData) {
    const ctx = SillyTavern.getContext();
    const allNames = await ctx.getWorldInfoNames();
    let bookData = null;
    if (allNames.includes(lorebookName)) {
        bookData = await ctx.loadWorldInfo(lorebookName);
    } else {
        bookData = { entries: {} };
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
    
    const names = await ctx.getWorldInfoNames();
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
