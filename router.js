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
            let desc = entry.comment || '';
            if (!desc) {
                desc = (entry.content || '').substring(0, 80).replace(/\n/g, ' ') + '...';
            }
            lines.push(`ID: ${bookName}::${uid} | Keys: [${keys}] | Desc: ${desc}`);
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

## SCOPE
Campaign Root: "${prefix || 'None'}" (All records go here. NPCs/Locations may be sorted into "${prefix ? prefix + '_NPCs' : 'NPCs'}" or "${prefix ? prefix + '_Locations' : 'Locations'}").
`;

        while (turns < maxTurns) {
            turns++;
            const userPrompt = `## ACTIVE MEMORY\n${activeEntriesFull.join('\n\n') || 'None'}\n\n## ARCHIVE INDEX\n${keyringText}\n\n## NARRATIVE\n${recentChat}\n\n${manualPrompt ? `## INSTRUCTION\n${manualPrompt}\n\n` : ''}${loopHistory.join('\n\n')}\n\nNext Step:`;

            const routerSettings = {
                ...settings,
                connectionSource: settings.routerConnectionSource || "default",
                maxTokens: settings.routerMaxTokens || 1000,
            };

            broadcastStep('thought', `Thinking (Turn ${turns}/${maxTurns})...`);
            const response = await sendStateRequest(routerSettings, systemPrompt, userPrompt);
            
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
    
    newActive = newActive.filter(k => !deactivate.includes(k));
    for (const k of activate) {
        if (!newActive.includes(k)) {
            newActive.push(k);
            changed = true;
        }
    }
    if (deactivate.length > 0) changed = true;
    settings.activeRouterKeys = newActive;

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

        const newId = await addLorebookEntry(targetBook, rec);
        if (!settings.activeRouterKeys.includes(newId)) {
            settings.activeRouterKeys.push(newId);
        }
        changed = true;
    }

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
            reason: action.reason || "Manual update."
        });
        if (settings.routerLog.length > 50) settings.routerLog.length = 50;
        ctx.saveSettingsDebounced();
        document.dispatchEvent(new CustomEvent('rt_lore_agent_updated'));
    }
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
