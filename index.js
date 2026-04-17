(function () {
    "use strict";

    // Capture the folder name dynamically from the module URL so it works regardless of what the user names the folder
    const FOLDER_NAME = (function() {
        try {
            const match = import.meta.url.match(/third-party\/([^\/]+)\//);
            if (match) return decodeURIComponent(match[1]);
        } catch (e) {}
        
        // Fallback for non-module contexts (which ST extensions normally wouldn't be)
        const myScript = document.currentScript || document.querySelector('script[src*="RPG Tracker"]');
        return myScript && myScript.src ? decodeURIComponent(myScript.src.match(/third-party\/([^\/]+)\//)?.[1] || 'RPG Tracker') : 'RPG Tracker';
    })();

    const MODULE_NAME = "rpg_tracker";
    let _stateModelRunning = false;

    const DEFAULT_STOCK_PROMPTS = {
        character: "Main character's core stats, current HP, active statuses/buffs (with durations). Do NOT reproduce the Narrative Engine's summary footer line ((Status: X HP) | (XP: Y/Z) | (Vibe: ...)) as your own block content.",
        party: "Companion/Party members, their current HP, and active statuses/buffs.",
        combat: "Active enemies/NPCs in combat, their HP, and current statuses/debuffs (with durations). When combat starts, capture each combatant as: `Name: X/Y HP | AC: Z | Status: ...`. Update HP inline. You MUST output `[COMBAT]REMOVED[/COMBAT]` when the narrative ends combat.",
        inventory: "Items, loot, equipment, and wealth. You MAY create this section if loot is found and it doesn't currently exist.",
        abilities: "Non-spell class features and active abilities ONLY (e.g. Lay on Hands, Action Surge). NEVER mix these with spells.",
        spells: "Spell slots and spells known, grouped by level. Format each line as: `Level N (avail/max): Spell1, Spell2`. Track slot usage accurately. NEVER mix these with abilities."
    };

    /**
     * Get or initialize extension settings.
     */
    function getSettings() {
        const { extensionSettings } = SillyTavern.getContext();
        const defaults = {
            currentMemo: "",
            prevMemo1: "",
            prevMemo2: "",
            memoHistory: [],
            lastDelta: "",
            enabled: true,
            debugMode: true,
            connectionSource: "default",
            connectionProfileId: "",
            completionPresetId: "",
            renderedViewActive: true,
            maxTokens: 0,
            systemPromptTemplate:
                "You are the State Extractor Model. Your task is to maintain a structured State Memo based on the roleplay narrative.\n" +
                "IGNORE NARRATIVE FLUFF: Do not track temporary dialogue or actions. Only track persistent state changes.\n" +
                "INTEGRATION: Track all durations stated by the narrative (e.g. 'poisoned for 3 turns'). Decrement by 1 each round. Remove when duration reaches 0.\n" +
                "CREATION: You MAY create a section that did not exist in the Prior Memo when the narrative warrants it based on your enabled modules.\n" +
                "DELETION: To REMOVE a section entirely, you MUST output: `[TAG]REMOVED[/TAG]`.\n" +
                "You must track the following enabled modules:\n{{modulesText}}\n" +
                "RULES:\n" +
                "1. Read the PRIOR MEMO and the NARRATIVE OUTPUT carefully.\n" +
                "2. Determine which sections changed. Only output sections that actually changed.\n" +
                "3. Use strict [TAG]...[/TAG] structure based on the modules requested above. ALWAYS include the closing tag.\n" +
                "   EXAMPLE FORMATTING:\n" +
                "   [CHARACTER]\n" +
                "   Eliel: 8/8 HP | AC: 12\n" +
                "   STR 8, DEX 14, CON 14\n" +
                "   [/CHARACTER]\n\n" +
                "   [INVENTORY]\n" +
                "   200 GP, Quarterstaff, Grimoire, Potion x3\n" +
                "   [/INVENTORY]\n\n" +
                "   [CUSTOM_TAG]\n" +
                "   (Format any custom fields exactly as instructed)\n" +
                "   [/CUSTOM_TAG]\n" +
                "4. Omit unchanged sections entirely. Do NOT output a section if its contents did not change.\n" +
                "5. If there are absolutely NO CHANGES to any section, you MUST output exactly: `NO_CHANGES_DETECTED`\n" +
                "6. Output ONLY the changed sections (or NO_CHANGES_DETECTED). No preamble, no explanation, no commentary.\n\n" +
                "REGARDING COMBAT:\n" +
                "1. [COMBAT] section is only created when actual combat begins, not when enemies are simply present in the scene.\n" +
                "2. If an entity dies in combat, output it as 0/X HP, for example \"Shambling Corpse B (Fodder): 0/9 HP | AC: 10,\" do not omit it completely from the next state.",
            modules: {
                character: true,
                party: true,
                combat: true,
                inventory: true,
                abilities: true,
                spells: false
            },
            stockPrompts: { ...DEFAULT_STOCK_PROMPTS },
            customFields: [],
            profiles: {},
            activeProfile: "",
            fullViewSections: []
        };

        if (!extensionSettings[MODULE_NAME]) {
            extensionSettings[MODULE_NAME] = {};
        }

        // Deep merge config to prevent missing 'modules' object in updates
        for (const [key, value] of Object.entries(defaults)) {
            if (extensionSettings[MODULE_NAME][key] === undefined) {
                extensionSettings[MODULE_NAME][key] = value;
            } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
                if (extensionSettings[MODULE_NAME][key] === undefined) extensionSettings[MODULE_NAME][key] = {};
                for (const [subKey, subValue] of Object.entries(value)) {
                    if (extensionSettings[MODULE_NAME][key][subKey] === undefined) {
                        extensionSettings[MODULE_NAME][key][subKey] = subValue;
                    }
                }
            }
        }
        return extensionSettings[MODULE_NAME];
    }

    /**
     * Interceptor to inject the current memo into the outgoing prompt.
     * Ephemeral: only modifies the cloned chat object used for the API call.
     */
    globalThis.rpgTrackerInterceptor = async function (chat, contextSize, abort, type) {
        const settings = getSettings();
        if (!settings.enabled || !settings.currentMemo) return;

        // Find the last user message to prepend the memo
        let idx = -1;
        for (let i = chat.length - 1; i >= 0; i--) {
            if (chat[i]['role'] === "user" || chat[i].is_user) {
                idx = i;
                break;
            }
        }

        if (idx === -1) return;

        const msg = chat[idx];
        const content = msg['content'] || msg.mes;

        // Prevent double injection
        if (content && typeof content === "string" && content.includes("### STATE MEMO (DO NOT REPEAT)")) {
            return;
        }

        const cloned = structuredClone(msg);
        const injection = `### STATE MEMO (DO NOT REPEAT)\n${settings.currentMemo}\n\n`;

        if (typeof cloned.content === "string") cloned.content = injection + cloned.content;
        else if (typeof cloned.mes === "string") cloned.mes = injection + cloned.mes;

        chat[idx] = cloned;
        if (settings.debugMode) console.log("[RPG Tracker] Memo injected into request.");
    };

    /**
     * Event handler for MESSAGE_RECEIVED.
     * Triggers the State Model pass after the Narrative Engine speaks.
     */
    async function onMessageReceived(messageId) {
        const settings = getSettings();
        if (!settings.enabled || _stateModelRunning) return;

        const { chat } = SillyTavern.getContext();
        const lastMsg = chat[messageId];

        // ─── Filter out non-narrative messages ───
        // 1. Basic ST types
        if (!lastMsg || lastMsg.is_user || lastMsg.is_system || /** @type {any} */ (lastMsg).is_hidden) return;

        const mes = (lastMsg.mes || '').trim();

        // 2. Ignore typical "summary" patterns (including Summaryception default templates)
        // This prevents the tracker from parsing summaries as actual story narrative.
        if (mes.startsWith('[Summary') || mes.startsWith('(Summary') || mes.includes('Summary of past events:')) {
            if (settings.debugMode) console.log("[RPG Tracker] Ignoring message: summary pattern detected.");
            return;
        }

        // 3. Ignore messages with specialized extension metadata that usually shouldn't be parsed
        if (lastMsg.extra?.['summary'] || lastMsg.extra?.['is_summary'] || lastMsg.extra?.['summary_data']) return;

        if (settings.debugMode) console.log("[RPG Tracker] Assistant message detected. Triggering State Model pass...");

        runStateModelPass(mes);
    }

    /**
     * Update the visual status of the panel (active, running, paused)
     */
    function updatePanelStatus() {
        const settings = getSettings();
        const panel = document.getElementById('rpg-tracker-panel');
        const indicator = document.getElementById('rpg-tracker-status');
        const pauseBtn = document.getElementById('rpg-tracker-pause-btn');

        if (!panel || !indicator || !pauseBtn) return;

        if (settings.enabled) {
            panel.classList.remove('is-paused');
            indicator.classList.add('active');
            pauseBtn.textContent = '⏸';
            pauseBtn.title = 'Pause Tracker';
        } else {
            panel.classList.add('is-paused');
            indicator.classList.remove('active');
            pauseBtn.textContent = '▶';
            pauseBtn.title = 'Resume Tracker';
        }

        if (_stateModelRunning) {
            indicator.classList.add('running');
        } else {
            indicator.classList.remove('running');
        }
    }

    /**
     * Connection Profile Helpers (Switch-Execute-Restore Pattern)
     */
    async function checkConnectionProfilesActive() {
        return $('#sys-settings-button').find('#connection_profiles').length > 0;
    }

    async function getCurrentConnectionProfile() {
        if (!(await checkConnectionProfilesActive())) return null;
        const { executeSlashCommandsWithOptions } = SillyTavern.getContext();
        const result = await executeSlashCommandsWithOptions(`/profile`);
        return result?.pipe?.trim() || null;
    }

    async function setConnectionProfile(name) {
        if (!(await checkConnectionProfilesActive())) return;
        if (!name) return;
        const { executeSlashCommandsWithOptions } = SillyTavern.getContext();
        await executeSlashCommandsWithOptions(`/profile ${name}`);
    }

    async function getConnectionProfiles() {
        if (!(await checkConnectionProfilesActive())) return [];
        const { executeSlashCommandsWithOptions } = SillyTavern.getContext();
        const result = await executeSlashCommandsWithOptions(`/profile-list`);
        try {
            return JSON.parse(result.pipe);
        } catch {
            return [];
        }
    }

    async function getCurrentCompletionPreset() {
        const { executeSlashCommandsWithOptions } = SillyTavern.getContext();
        const result = await executeSlashCommandsWithOptions(`/preset`);
        return result?.pipe?.trim() || null;
    }

    async function setCompletionPreset(name) {
        if (!name) return;
        const { executeSlashCommandsWithOptions } = SillyTavern.getContext();
        await executeSlashCommandsWithOptions(`/preset "${name}"`);
    }

    /**
     * Send the request through the configured backend.
     */
    async function sendStateRequest(settings, systemPrompt, userPrompt) {
        const { generateRaw } = SillyTavern.getContext();
        let originalProfile = null;
        let originalPreset = null;

        try {
            if (settings.connectionSource === 'profile' && settings.connectionProfileId) {
                originalProfile = await getCurrentConnectionProfile();
                if (settings.debugMode) console.log(`[RPG Tracker] Switching Connection Profile: ${originalProfile} -> ${settings.connectionProfileId}`);
                await setConnectionProfile(settings.connectionProfileId);
            }

            if (settings.completionPresetId) {
                originalPreset = await getCurrentCompletionPreset();
                if (settings.debugMode) console.log(`[RPG Tracker] Switching Preset: ${originalPreset} -> ${settings.completionPresetId}`);
                await setCompletionPreset(settings.completionPresetId);
            }

            const options = {
                prompt: userPrompt,
                systemPrompt: systemPrompt,
                bypassAll: true
            };

            if (settings.maxTokens && settings.maxTokens > 0) {
                options.responseLength = settings.maxTokens;
            }

            const result = await generateRaw(options);

            if (typeof result === 'string') return result;
            const r = /** @type {any} */ (result);
            return r?.choices?.[0]?.message?.content || 
                   r?.choices?.[0]?.text || 
                   r?.message?.content || 
                   r?.content || 
                   JSON.stringify(result);

        } catch (err) {
            console.error("[RPG Tracker] Request failed:", err);
            throw err;
        } finally {
            if (originalPreset && settings.completionPresetId && originalPreset !== settings.completionPresetId) {
                if (settings.debugMode) console.log(`[RPG Tracker] Restoring preset: ${originalPreset}`);
                await setCompletionPreset(originalPreset);
            }
            if (originalProfile && settings.connectionProfileId && originalProfile !== settings.connectionProfileId) {
                if (settings.debugMode) console.log(`[RPG Tracker] Restoring profile: ${originalProfile}`);
                await setConnectionProfile(originalProfile);
            }
        }
    }

    /**
     * Merge partial AI output into the existing memo.
     * Finds all [TAG]...[/TAG] blocks in the AI output and replaces the
     * matching section in the current memo. New sections are appended.
     * If the AI output contains no bracket tags at all, the full output
     * replaces the memo (full-replacement fallback).
     */
    function mergeMemo(currentMemo, aiOutput) {
        const settings = getSettings();

        // Find all [TAG]...[/TAG] pairs in the AI's output (case-insensitive, whitespace-tolerant)
        const tagPattern = /\[([^\]\/][^\]]*)\]([\s\S]*?)\[\/\1\]/gi;
        const matches = [...aiOutput.matchAll(tagPattern)];

        // Fallback: if the AI output contains no [TAG] blocks, it likely output a
        // "no changes needed" explanation instead of structured data.
        // In this case, preserve the current memo entirely — do NOT replace it.
        if (matches.length === 0) {
            console.warn("[RPG Tracker] No valid [TAG]...[/TAG] blocks found in model output — treating as no-change. Output was:", aiOutput);
            return currentMemo;
        }

        if (settings.debugMode) console.log(`[RPG Tracker] mergeMemo: found ${matches.length} tag(s):`, matches.map(m => m[1]));

        let memo = currentMemo;

        for (const match of matches) {
            const tag = match[1].trim();         // e.g. "CHARACTER"
            const newContent = match[2].trim();  // new content for that section

            // Handle removal keywords
            const isRemoval = /^(?:REMOVED|EXPIRED|CLEARED|NONE)$/i.test(newContent);

            // Build pattern to find existing section in memo
            const escapedTag = escapeRegex(tag);
            const existingPattern = new RegExp(
                `\\s*\\[${escapedTag}\\][\\s\\S]*?\\[\\/${escapedTag}\\]`,
                'i'
            );

            if (settings.debugMode) {
                console.log(`[RPG Tracker] mergeMemo: processing [${tag}], pattern: ${existingPattern}`);
            }

            if (isRemoval) {
                memo = memo.replace(existingPattern, "").trim();
                if (settings.debugMode) console.log(`[RPG Tracker] mergeMemo: [${tag}] REMOVED`);
            } else {
                const fullBlock = `[${tag}]\n${newContent}\n[/${tag}]`;
                const before = memo;
                memo = memo.replace(existingPattern, () => '\n\n' + fullBlock);
                if (memo !== before) {
                    if (settings.debugMode) console.log(`[RPG Tracker] mergeMemo: [${tag}] REPLACED`);
                } else {
                    // Section doesn't exist yet — append it
                    memo = memo.trimEnd() + '\n\n' + fullBlock;
                    if (settings.debugMode) console.log(`[RPG Tracker] mergeMemo: [${tag}] APPENDED (new section)`);
                }
            }
        }

        // Final cleanup of double newlines that might occur during removal
        return memo.replace(/\n{3,}/g, '\n\n').trim();
    }

    function escapeRegex(str) {
        return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    /**
     * Extract and clean the last user message from the chat,
     * stripping injected blocks (STATE MEMO, RNG_QUEUE) so only
     * the player's actual typed input remains.
     * @returns {string} The cleaned user action text, or an empty string.
     */
    function getLastUserAction() {
        const { chat } = SillyTavern.getContext();
        if (!chat || chat.length === 0) return '';

        let raw = '';
        for (let i = chat.length - 1; i >= 0; i--) {
            if (chat[i].is_user || chat[i]['role'] === 'user') {
                raw = chat[i].mes || chat[i]['content'] || '';
                break;
            }
        }

        if (!raw) return '';

        // Strip ### STATE MEMO ... (ends at a blank line before the next section or RNG block)
        raw = raw.replace(/###\s*STATE MEMO[^]*?(?=\n\[RNG_QUEUE|\n###|\n\[(?!RNG_QUEUE)[A-Z]|$)/i, '');

        // Strip [RNG_QUEUE ...]...[/RNG_QUEUE] blocks
        raw = raw.replace(/\[RNG_QUEUE[^\]]*\][\s\S]*?\[\/RNG_QUEUE\]/gi, '');

        // Strip any residual [TAG]...[/TAG] injected memo blocks that may linger
        raw = raw.replace(/\[[A-Z_]+\][\s\S]*?\[\/[A-Z_]+\]/g, '');

        return raw.trim();
    }

    /**
     * The State Model pass: Extract state changes from the narrative.
     */
    async function runStateModelPass(narrativeOutput) {
        const settings = getSettings();
        const { generateRaw, saveSettingsDebounced } = SillyTavern.getContext();

        if (!generateRaw) {
            console.error("[RPG Tracker] generateRaw not found in context.");
            return;
        }

        try {
            _stateModelRunning = true;
            updateStatusIndicator('running');

            let modulesText = "";
            const promptsMap = settings.stockPrompts || DEFAULT_STOCK_PROMPTS;
            for (const [key, prompt] of Object.entries(promptsMap)) {
                if (settings.modules[key]) {
                    modulesText += `- [${key.toUpperCase()}]: ${prompt}\n`;
                }
            }
            if (settings.customFields && settings.customFields.length > 0) {
                settings.customFields.forEach(f => {
                    if (f.enabled && f.tag && f.prompt) {
                        modulesText += `- [${f.tag.toUpperCase()}]: ${f.prompt}\n`;
                    }
                });
            }

            const systemPrompt = settings.systemPromptTemplate.replace("{{modulesText}}", modulesText);

            const lastUserAction = getLastUserAction();
            const userActionSection = lastUserAction
                ? `## PLAYER ACTION (what the user just did)\n${lastUserAction}\n\n`
                : '';

            const userPrompt =
                `## PRIOR MEMO\n${settings.currentMemo}\n\n` +
                userActionSection +
                `## NARRATIVE OUTPUT\n${narrativeOutput}\n\n` +
                `## OUTPUT ONLY CHANGED SECTIONS:`;

            const result = await sendStateRequest(settings, systemPrompt, userPrompt);

            if (result && typeof result === 'string') {
                if (settings.debugMode) console.log("[RPG Tracker] Raw Result:", result);

                // ── Pre-clean: strip <memo> wrapper tags before any merge logic ──
                // The model may wrap its output in <memo>...</memo> regardless of our prompt.
                // We extract the last complete block's content, or strip orphaned tags.
                let cleanedOutput = result;
                const memoBlocks = [...result.matchAll(/<memo>([\s\S]*?)<\/memo>/gi)];
                if (memoBlocks.length > 0) {
                    // Take the last complete <memo>...</memo> block
                    cleanedOutput = memoBlocks[memoBlocks.length - 1][1].trim();
                } else {
                    // Strip any orphaned <memo> / </memo> tags
                    cleanedOutput = result.replace(/<\/?memo>/gi, '').trim();
                }

                // Also sanitize the current stored memo in case it was previously
                // contaminated by a prior session that saved raw tags.
                const sanitizedCurrent = settings.currentMemo.replace(/<\/?memo>/gi, '').trim();

                const merged = mergeMemo(sanitizedCurrent, cleanedOutput);

                if (settings.debugMode) {
                    console.log(`[RPG Tracker] Memo ${merged !== sanitizedCurrent ? 'updated (partial merge)' : 'unchanged'}.`);
                }

                // Push snapshot to rolling history (max 5)
                const delta = computeDelta(sanitizedCurrent, merged);
                settings.memoHistory.unshift(sanitizedCurrent);
                if (settings.memoHistory.length > 5) settings.memoHistory.length = 5;

                // Persist delta and update panel
                settings.lastDelta = delta;
                const deltaPanel = document.getElementById('rpg-tracker-delta-content');
                if (deltaPanel) deltaPanel.innerHTML = delta;

                // Rotation logic (legacy compat)
                settings.prevMemo2 = settings.prevMemo1;
                settings.prevMemo1 = sanitizedCurrent;
                settings.currentMemo = merged;

                updateUIMemo(merged);
                syncMemoView();
                refreshRenderedView();
                saveSettingsDebounced();

                if (settings.debugMode) console.log("[RPG Tracker] State Model pass complete.");

                // Check for Level Up
                if (/LEVEL_UP=true/i.test(merged)) {
                    handleLevelUp();
                }
            }
        } catch (error) {
            console.error("[RPG Tracker] State Model pass failed:", error);
        } finally {
            _stateModelRunning = false;
            updateStatusIndicator('active');
        }
    }

    function handleLevelUp() {
        const { sendSystemMessage } = SillyTavern.getContext();
        toastr['success']("Level Up Detected! System prompt injected.", "RPG Tracker");

        if (sendSystemMessage) {
            sendSystemMessage('generic', "SYSTEM: Level Up Detected! The character has gained a level. Acknowledge this immediately and prompt the user to make their level-up choices or grant them their logical boons.");
        }
    }

    /**
     * Send a direct instruction to the State Model bypassing the narrative pipeline.
     * Used for initial character setup and manual corrections.
     */
    async function sendDirectPrompt(message) {
        if (_stateModelRunning) {
            toastr['info']('State Model is already running. Please wait.', 'RPG Tracker');
            return;
        }

        const settings = getSettings();
        const { generateRaw, saveSettingsDebounced } = SillyTavern.getContext();
        if (!generateRaw) return;

        try {
            _stateModelRunning = true;
            updateStatusIndicator('running');

            let modulesText = '';
            const promptsMap = settings.stockPrompts || DEFAULT_STOCK_PROMPTS;
            for (const [key, prompt] of Object.entries(promptsMap)) {
                if (settings.modules[key]) {
                    modulesText += `- [${key.toUpperCase()}]: ${prompt}\n`;
                }
            }
            if (settings.customFields && settings.customFields.length > 0) {
                settings.customFields.forEach(f => {
                    if (f.enabled && f.tag && f.prompt) {
                        modulesText += `- [${f.tag.toUpperCase()}]: ${f.prompt}\n`;
                    }
                });
            }

            const systemPrompt = settings.systemPromptTemplate.replace('{{modulesText}}', modulesText);

            const sanitizedCurrent = settings.currentMemo.replace(/<\/?memo>/gi, '').trim();

            const userPrompt =
                `## PRIOR MEMO\n${sanitizedCurrent || '(empty — this is the initial setup)'}\n\n` +
                `## USER INSTRUCTION\n${message}\n\n` +
                `## OUTPUT ONLY CHANGED OR NEW SECTIONS:`;

            const result = await sendStateRequest(settings, systemPrompt, userPrompt);

            if (result && typeof result === 'string') {
                let cleanedOutput = result;
                const memoBlocks = [...result.matchAll(/<memo>([\s\S]*?)<\/memo>/gi)];
                if (memoBlocks.length > 0) {
                    cleanedOutput = memoBlocks[memoBlocks.length - 1][1].trim();
                } else {
                    cleanedOutput = result.replace(/<\/?memo>/gi, '').trim();
                }

                const merged = mergeMemo(sanitizedCurrent, cleanedOutput);

                if (merged !== sanitizedCurrent) {
                    const delta = computeDelta(sanitizedCurrent, merged);
                    settings.lastDelta = delta;
                    settings.memoHistory.unshift(sanitizedCurrent);
                    if (settings.memoHistory.length > 5) settings.memoHistory.length = 5;

                    const dp = document.getElementById('rpg-tracker-delta-content');
                    if (dp) dp.innerHTML = delta;

                    settings.prevMemo2 = settings.prevMemo1;
                    settings.prevMemo1 = sanitizedCurrent;
                    settings.currentMemo = merged;

                    updateUIMemo(merged);
                    syncMemoView();
                    refreshRenderedView();
                    saveSettingsDebounced();
                    toastr['success']('Tracker updated.', 'RPG Tracker');
                } else {
                    toastr['info']('No changes were made.', 'RPG Tracker');
                }
            }
        } catch (err) {
            console.error('[RPG Tracker] Direct prompt failed:', err);
            toastr['error']('Direct prompt failed. Check console.', 'RPG Tracker');
        } finally {
            _stateModelRunning = false;
            updateStatusIndicator('active');
        }
    }



    /**
     * Panel geometry persistence
     */
    const GEOMETRY_KEY = 'rpg_tracker_geometry';

    /**
     * @param {HTMLElement} panel
     */
    function savePanelGeometry(panel) {
        const rect = panel.getBoundingClientRect();
        localStorage.setItem(GEOMETRY_KEY, JSON.stringify({
            left: rect.left, top: rect.top,
            width: rect.width, height: rect.height
        }));
    }

    /**
     * @param {HTMLElement} panel
     */
    function loadPanelGeometry(panel) {
        try {
            const saved = JSON.parse(localStorage.getItem(GEOMETRY_KEY));
            if (!saved) return;
            if (saved.left !== undefined) { panel.style.left = saved.left + 'px'; panel.style.right = 'auto'; }
            if (saved.top !== undefined) { panel.style.top = saved.top + 'px'; panel.style.bottom = 'auto'; }
            if (saved.width) panel.style.width = saved.width + 'px';
            if (saved.height) panel.style.height = saved.height + 'px';
        } catch { /* ignore */ }
    }

    const DELTA_HEIGHT_KEY = 'rpg_tracker_delta_height';

    function saveDeltaHeight(height) {
        localStorage.setItem(DELTA_HEIGHT_KEY, String(height));
    }

    function loadDeltaHeight() {
        const v = parseInt(localStorage.getItem(DELTA_HEIGHT_KEY) || '');
        return isNaN(v) ? 120 : Math.max(40, v);
    }

    /**
     * Profile system
     */
    function saveProfile(name) {
        const s = getSettings();
        if (!name) return;
        if (!s.profiles) s.profiles = {};
        s.profiles[name] = {
            currentMemo: s.currentMemo,
            memoHistory: JSON.parse(JSON.stringify(s.memoHistory)),
            modules: JSON.parse(JSON.stringify(s.modules)),
            stockPrompts: JSON.parse(JSON.stringify(s.stockPrompts || DEFAULT_STOCK_PROMPTS)),
            customFields: JSON.parse(JSON.stringify(s.customFields || [])),
            lastDelta: s.lastDelta || ''
        };
        s.activeProfile = name;
        SillyTavern.getContext().saveSettingsDebounced();
    }

    function loadProfile(name) {
        const s = getSettings();
        const p = s.profiles?.[name];
        if (!p) return;
        s.currentMemo = p.currentMemo ?? '';
        s.memoHistory = p.memoHistory ?? [];
        s.modules = { ...s.modules, ...p.modules };
        s.stockPrompts = p.stockPrompts ? JSON.parse(JSON.stringify(p.stockPrompts)) : { ...DEFAULT_STOCK_PROMPTS };
        s.customFields = p.customFields ? JSON.parse(JSON.stringify(p.customFields)) : [];
        s.lastDelta = p.lastDelta ?? '';
        s.activeProfile = name;
        _historyViewIndex = -1;
        SillyTavern.getContext().saveSettingsDebounced();
        // Refresh module checkboxes
        ['character', 'party', 'combat', 'inventory', 'abilities', 'spells'].forEach(mod => {
            $(`#rpg_tracker_mod_${mod}`).prop('checked', s.modules[mod]);
        });
        // Refresh delta panel
        const dp = document.getElementById('rpg-tracker-delta-content');
        if (dp) dp.innerHTML = s.lastDelta || '<span class="delta-empty">No changes yet.</span>';
        syncMemoView();
    }

    function deleteProfile(name) {
        const s = getSettings();
        if (!s.profiles?.[name]) return;
        delete s.profiles[name];
        if (s.activeProfile === name) s.activeProfile = '';
        SillyTavern.getContext().saveSettingsDebounced();
    }

    function refreshProfileDropdown() {
        const s = getSettings();
        const sel = document.getElementById('rpg_tracker_profile_select');
        if (!sel) return;
        const names = Object.keys(s.profiles || {});
        sel.innerHTML = '<option value="">-- No Profile --</option>' +
            names.map(n => `<option value="${escapeHtml(n)}"${n === s.activeProfile ? ' selected' : ''}>${escapeHtml(n)}</option>`).join('');
    }

    /**
     * Line-level delta between two memo strings.
     * Returns an HTML string for the delta panel.
     */
    function computeDelta(oldMemo, newMemo) {
        if (!oldMemo && !newMemo) return '<span class="delta-empty">No memo yet.</span>';
        if (!oldMemo) return '<span class="delta-added">+ (initial memo created)</span>';

        const oldLines = new Set(oldMemo.split('\n').map(l => l.trim()).filter(Boolean));
        const newLines = new Set(newMemo.split('\n').map(l => l.trim()).filter(Boolean));

        const added = [...newLines].filter(l => !oldLines.has(l));
        const removed = [...oldLines].filter(l => !newLines.has(l));

        if (added.length === 0 && removed.length === 0) {
            return '<span class="delta-empty">No changes detected.</span>';
        }

        const html = [
            ...removed.map(l => `<div class="delta-removed">- ${escapeHtml(l)}</div>`),
            ...added.map(l => `<div class="delta-added">+ ${escapeHtml(l)}</div>`),
        ];
        return html.join('');
    }

    function escapeHtml(str) {
        return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    // ── History index: -1 means "live", 0 = most recent snapshot, higher = older
    let _historyViewIndex = -1;

    /** Whether the rendered card view is active */
    let _renderedViewActive = false;

    /**
     * Parse the memo's [TAG]...[/TAG] blocks and return structured object.
     */
    function parseMemoBlocks(memo) {
        const blocks = {};
        const pattern = /\[([^\]\/][^\]]*)\]([\s\S]*?)\[\/\1\]/gi;
        for (const [, tag, content] of memo.matchAll(pattern)) {
            blocks[tag.trim().toUpperCase()] = content.trim();
        }
        return blocks;
    }



    const BLOCK_ICONS = { CHARACTER: '🧙', PARTY: '👥', COMBAT: '⚔️', INVENTORY: '🎒', ABILITIES: '✨', SPELLS: '📖' };
    const BLOCK_ORDER = ['COMBAT', 'CHARACTER', 'PARTY', 'SPELLS', 'ABILITIES', 'INVENTORY'];
    const PAGE_SIZE = 8;
    // Sections that should NEVER be paginated (show all entries always)
    const NO_PAGINATE = new Set(['CHARACTER', 'ABILITIES']);
    const COLLAPSE_KEY = 'rpg_tracker_collapsed';
    const DETACHED_KEY = 'rpg_tracker_detached';

    const _sectionPages = {};

    function getPageSize(renderType) {
        return renderType === 'SPELLS' ? 5 : PAGE_SIZE;
    }

    function loadCollapsed() {
        try { return new Set(JSON.parse(localStorage.getItem(COLLAPSE_KEY) || '[]')); }
        catch { return new Set(); }
    }
    function saveCollapsed(set) {
        localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...set]));
    }

    function loadDetached() {
        try { return new Set(JSON.parse(localStorage.getItem(DETACHED_KEY) || '[]')); }
        catch { return new Set(); }
    }
    function saveDetached(set) {
        localStorage.setItem(DETACHED_KEY, JSON.stringify([...set]));
    }



    function blockToItems(tag, content) {
        const lines = content.split('\n').map(l => l.trim()).filter(Boolean);
        let renderType = tag;
        const customField = (getSettings().customFields || []).find(f => f.tag.toUpperCase() === tag);
        if (customField && customField.renderType) {
            renderType = customField.renderType;
        }

        switch (renderType) {
            case 'COMBAT':
            case 'PARTY':
                return lines.map(line => {
                    const hpMatch = line.match(/^(.+?):\s*(\d+)\/(\d+)\s*HP\s*[:|]?\s*(.*)$/i);
                    if (!hpMatch) return `<div class="rt-card-line">${escapeHtml(line)}</div>`;
                    const [, name, cur, max, rest] = hpMatch;
                    const pct = Math.max(0, Math.min(100, (Number(cur) / Number(max)) * 100));
                    const hpColor = pct > 60 ? '#00ffaa' : pct > 30 ? '#ffaa00' : '#ff5555';
                    const status = rest.trim();
                    return `<div class="rt-entity-row">
                        <div class="rt-entity-name">${escapeHtml(name.trim())}</div>
                        <div class="rt-hp-bar-wrap" title="${cur}/${max} HP">
                            <div class="rt-hp-bar" style="width:${pct.toFixed(1)}%;background:${hpColor};"></div>
                        </div>
                        <span class="rt-hp-label">${cur}/${max}</span>
                        ${status ? `<span class="rt-status">${escapeHtml(status)}</span>` : ''}
                    </div>`;
                });
            case 'SPELLS': {
                // Lines: "Level N (avail/max): Spell1, Spell2" or "Cantrips: Spell1, Spell2"
                return lines.map(line => {
                    const m = line.match(/^(Level\s*\d+|Cantrips?)\s*(?:\((\d+)\/(\d+)[^)]*\))?\s*:\s*(.+)$/i);
                    if (!m) return `<div class="rt-card-line">${escapeHtml(line)}</div>`;
                    const [, label, availStr, maxStr, spellList] = m;
                    const isCantrip = /cantrip/i.test(label);
                    let pipsHtml = '';
                    if (!isCantrip && availStr !== undefined && maxStr !== undefined) {
                        const avail = parseInt(availStr, 10), max = parseInt(maxStr, 10);
                        const pips = Array.from({ length: max }, (_, i) =>
                            `<span class="rt-slot-pip${i < avail ? ' rt-slot-available' : ' rt-slot-used'}"></span>`
                        ).join('');
                        pipsHtml = `<span class="rt-slot-pips">${pips}</span>`;
                    }
                    const spells = spellList.split(',').map(s => `<span class="rt-spell-name">${escapeHtml(s.trim())}</span>`).join('');
                    return `<div class="rt-spell-row">
                        <span class="rt-spell-level">${escapeHtml(label.trim())}</span>
                        ${pipsHtml}
                        <div class="rt-spell-list">${spells}</div>
                    </div>`;
                });
            }
            case 'INVENTORY': {
                const allItems = lines.flatMap(line => line.split(/,(?![^(]*\))/).map(i => i.trim()).filter(Boolean));
                return allItems.map(l => l.replace(/^[-*]\s*/, ''))
                    .map(i => `<div class="rt-card-item">• ${escapeHtml(i)}</div>`);
            }
            case 'ABILITIES': {
                const allAbilities = lines.flatMap(line => line.split(/,(?![^(]*\))/).map(a => a.trim()).filter(Boolean));
                return allAbilities.map(l => l.replace(/^[-*]\s*/, ''))
                    .map(a => `<span class="rt-ability-pill">${escapeHtml(a)}</span>`);
            }
            case 'CHARACTER':
            default:
                return lines.map(line => {
                    const kv = line.match(/^([^:]+):\s*(.+)$/);
                    if (kv) return `<div class="rt-card-kv"><span class="rt-card-key">${escapeHtml(kv[1].trim())}</span><span class="rt-card-val">${escapeHtml(kv[2].trim())}</span></div>`;
                    return `<div class="rt-card-line">${escapeHtml(line)}</div>`;
                });
        }
    }

    function renderMemoAsCards(memo) {
        if (!memo || !memo.trim()) {
            return `<div class="rt-empty">
                <div class="rt-empty-icon">📜</div>
                <div>Create a character to get started.</div>
                <small>Stats, inventory, and abilities will be recorded automatically from chat. You can also click the 💬 icon to prompt for character creation or paste them in Raw view.</small>
            </div>`;
        }
        const blocks = parseMemoBlocks(memo);
        if (Object.keys(blocks).length === 0) {
            return `<div class="rt-empty">No structured blocks found.<br><small>Switch to Raw view to inspect the memo.</small></div>`;
        }

        const sorted = [
            ...BLOCK_ORDER.filter(k => blocks[k] !== undefined),
            ...Object.keys(blocks).filter(k => !BLOCK_ORDER.includes(k)).sort()
        ];

        const collapsed = loadCollapsed();
        const detached = loadDetached();

        // If filtering by a single tag (detached window context)
        const tagsToRender = arguments[1] ? [arguments[1]] : sorted;

        return tagsToRender.map(tag => {
            const content = blocks[tag];
            if (content === undefined && arguments[1]) {
                return `<div class="rt-empty">Waiting for ${tag} data...</div>`;
            }
            if (content === undefined) return '';
            
            // If main panel context, filter out detached windows
            if (!arguments[1] && detached.has(tag)) {
                return `<div class="rt-detached-placeholder" data-tag="${tag}">
                    <span class="rt-placeholder-icon">⧉</span> ${tag} is detached
                    <button class="rt-reattach-btn-inline" data-tag="${tag}" title="Re-attach">↓</button>
                </div>`;
            }

            const customField = (getSettings().customFields || []).find(f => f.tag.toUpperCase() === tag);
            const icon = customField?.icon || BLOCK_ICONS[tag] || '📄';
            const items = blockToItems(tag, content);
            const isCollapsed = collapsed.has(tag);

            const renderType = customField?.renderType || tag;
            const isFullView = getSettings().fullViewSections.includes(tag) || NO_PAGINATE.has(renderType);
            const localPageSize = getPageSize(renderType);

            const page = isFullView ? 0 : (_sectionPages[tag] ?? 0);
            const totalPages = isFullView ? 1 : Math.ceil(items.length / localPageSize);
            const safePage = Math.min(page, Math.max(0, totalPages - 1));
            if (!isFullView) _sectionPages[tag] = safePage;

            const pageItems = isFullView ? items : items.slice(safePage * localPageSize, (safePage + 1) * localPageSize);
            const bodyClass = `rt-section-body${renderType === 'ABILITIES' ? ' rt-abilities-body' : ''}`;

            const pagination = totalPages > 1 ? `
                <div class="rt-pagination">
                    <button class="rt-page-btn" data-tag="${tag}" data-dir="-1"${safePage === 0 ? ' disabled' : ''}>&#8249;</button>
                    <span>${safePage + 1}&thinsp;/&thinsp;${totalPages}</span>
                    <button class="rt-page-btn" data-tag="${tag}" data-dir="1"${safePage >= totalPages - 1 ? ' disabled' : ''}>&#8250;</button>
                </div>` : '';

            // Don't show detach button if already in detached context (filterTag provided)
            const detachBtn = !arguments[1] ? `
                <button class="rt-detach-btn" data-tag="${tag}" title="Detach panel">
                    ⧉
                </button>
            ` : '';

            const fullViewBtn = NO_PAGINATE.has(renderType) ? '' : `
                <button class="rt-fullview-btn${isFullView ? ' active' : ''}" data-tag="${tag}" title="${isFullView ? 'Switch to Paged View' : 'Switch to Full List'}">
                    ${isFullView ? '📜' : '📑'}
                </button>
            `;

            return `<div class="rt-section-card${isCollapsed ? ' rt-collapsed' : ''}" data-tag="${tag}">
                <div class="rt-section-header" data-tag="${tag}">
                    <span>${icon} ${tag}</span>
                    <div class="rt-section-header-right">
                        ${detachBtn}
                        ${fullViewBtn}
                        <span class="rt-item-count">${items.length} ${items.length === 1 ? 'entry' : 'entries'}</span>
                        <span class="rt-collapse-icon">${isCollapsed ? '&#9656;' : '&#9662;'}</span>
                    </div>
                </div>
                <div class="${bodyClass}">${pageItems.join('')}${pagination}</div>
            </div>`;
        }).join('');
    }

    function bindRenderedCardEvents(el, memo, isDetachedContext = false) {
        el.querySelectorAll('.rt-section-header').forEach(header => {
            // Unbind to prevent duplicate listeners
            const oldHeader = header;
            const newHeader = oldHeader.cloneNode(true);
            oldHeader.parentNode.replaceChild(newHeader, oldHeader);
            
            newHeader.addEventListener('click', (e) => {
                // Prevent toggle if clicking on a button
                if (e.target.closest('button')) return;
                const tag = newHeader.dataset.tag;
                if (!tag) return;
                const col = loadCollapsed();
                if (col.has(tag)) col.delete(tag); else col.add(tag);
                saveCollapsed(col);
                refreshRenderedView();
            });
        });

        el.querySelectorAll('.rt-page-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const tag = btn.dataset.tag;
                const dir = parseInt(btn.dataset.dir);
                if (!tag) return;
                const curBlocks = parseMemoBlocks(memo);
                const items = blockToItems(tag, curBlocks[tag] ?? '');
                
                const customField = (getSettings().customFields || []).find(f => f.tag.toUpperCase() === tag);
                const renderType = customField?.renderType || tag;
                const localPageSize = getPageSize(renderType);
                
                const totalPages = Math.ceil(items.length / localPageSize);
                const cur = _sectionPages[tag] ?? 0;
                _sectionPages[tag] = Math.max(0, Math.min(totalPages - 1, cur + dir));
                refreshRenderedView();
            });
        });

        el.querySelectorAll('.rt-fullview-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const tag = btn.dataset.tag;
                if (!tag) return;
                const s = getSettings();
                const idx = s.fullViewSections.indexOf(tag);
                if (idx === -1) s.fullViewSections.push(tag);
                else s.fullViewSections.splice(idx, 1);
                SillyTavern.getContext().saveSettingsDebounced();
                refreshRenderedView();
            });
        });

        if (!isDetachedContext) {
            el.querySelectorAll('.rt-detach-btn').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const tag = btn.dataset.tag;
                    if (!tag) return;
                    const detached = loadDetached();
                    detached.add(tag);
                    saveDetached(detached);
                    createDetachedPanel(tag);
                    refreshRenderedView();
                });
            });

            el.querySelectorAll('.rt-reattach-btn-inline').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const tag = btn.dataset.tag;
                    if (!tag) return;
                    const detached = loadDetached();
                    detached.delete(tag);
                    saveDetached(detached);
                    const panel = document.getElementById(`rt-detached-panel-${tag}`);
                    if (panel) panel.remove();
                    refreshRenderedView();
                });
            });
        }
    }

    function refreshRenderedView() {
        if (!_renderedViewActive) return;
        const s = getSettings();
        const memo = _historyViewIndex === -1
            ? s.currentMemo
            : (s.memoHistory[_historyViewIndex] ?? '');
        const el = document.getElementById('rpg-tracker-render');
        if (el) {
            el.innerHTML = renderMemoAsCards(memo);
            bindRenderedCardEvents(el, memo, false);
        }

        // Update any detached panels
        const detached = loadDetached();
        detached.forEach(tag => {
            const panel = document.getElementById(`rt-detached-panel-${tag}`);
            if (panel) {
                const body = panel.querySelector('.rpg-tracker-detached-body');
                if (body) {
                    body.innerHTML = renderMemoAsCards(memo, tag);
                    bindRenderedCardEvents(body, memo, true);
                }
            } else {
                // Panel missing, recreate it
                createDetachedPanel(tag);
            }
        });
    }

    function createDetachedPanel(tag) {
        if (document.getElementById(`rt-detached-panel-${tag}`)) return;

        const customField = (getSettings().customFields || []).find(f => f.tag.toUpperCase() === tag);
        const icon = customField?.icon || BLOCK_ICONS[tag] || '📄';

        const settings = getSettings();
        const panel = document.createElement('div');
        panel.id = `rt-detached-panel-${tag}`;
        panel.className = `rpg-tracker-panel rpg-tracker-detached-panel ${settings.trackerTheme || 'rt-theme-native'}`;
        panel.innerHTML = `
            <div class="rpg-tracker-header rt-detached-header">
                <div class="rpg-tracker-header-left">
                    <span>${icon} ${tag}</span>
                </div>
                <div class="rpg-tracker-header-right">
                    <button class="rpg-tracker-icon-btn rt-reattach-btn" data-tag="${tag}" title="Re-attach">✕</button>
                </div>
            </div>
            <div class="rpg-tracker-content rpg-tracker-detached-body">
                <!-- Content injected here via refreshRenderedView() -->
            </div>
        `;

        document.body.appendChild(panel);

        const header = panel.querySelector('.rt-detached-header');
        if (header instanceof HTMLElement) {
            makeDraggable(panel, header, `rpg_tracker_geometry_${tag}`);
        }
        
        // Setup specialized geometry keys
        const geoKey = `rpg_tracker_geometry_${tag}`;
        
        try {
            const saved = JSON.parse(localStorage.getItem(geoKey));
            if (saved && saved.left !== undefined) {
                if (saved.left !== undefined) { panel.style.left = saved.left + 'px'; panel.style.right = 'auto'; }
                if (saved.top !== undefined) { panel.style.top = saved.top + 'px'; panel.style.bottom = 'auto'; }
                if (saved.width) panel.style.width = saved.width + 'px';
                if (saved.height) panel.style.height = saved.height + 'px';
            } else {
                const mainPanel = document.getElementById('rpg-tracker-panel');
                if (mainPanel) {
                    const rect = mainPanel.getBoundingClientRect();
                    // spawn adjacent to the main panel if no stored position
                    let spawnLeft = rect.left - 270;
                    if (spawnLeft < 0) spawnLeft = rect.right + 10;
                    panel.style.left = Math.max(10, spawnLeft) + 'px';
                    panel.style.top = rect.top + 'px';
                    panel.style.right = 'auto';
                    panel.style.bottom = 'auto';
                }
            }
        } catch { /* ignore */ }

        // Debounced save geometry
        let _resizeTimer;
        const ro = new ResizeObserver(() => {
            clearTimeout(_resizeTimer);
            _resizeTimer = setTimeout(() => {
                const rect = panel.getBoundingClientRect();
                localStorage.setItem(geoKey, JSON.stringify({
                    left: rect.left, top: rect.top,
                    width: rect.width, height: rect.height
                }));
            }, 300);
        });
        ro.observe(panel);

        panel.querySelector('.rt-reattach-btn').addEventListener('click', () => {
            const detached = loadDetached();
            detached.delete(tag);
            saveDetached(detached);
            panel.remove();
            refreshRenderedView();
        });

        // Trigger an initial render to fill its body
        refreshRenderedView();
    }





    /**
     * UI Implementation
     */
    function createPanel() {
        const settings = getSettings();

        const panel = document.createElement('div');
        panel.id = 'rpg-tracker-panel';
        panel.className = `rpg-tracker-panel ${settings.trackerTheme || 'rt-theme-native'}`;
        panel.innerHTML = `
            <div class="rpg-tracker-header" id="rpg-tracker-header">
                <div class="rpg-tracker-header-left">
                    <span>RPG TRACKER</span>
                    <div class="rpg-tracker-status-indicator active" id="rpg-tracker-status"></div>
                    <button class="rpg-tracker-stop-btn" id="rpg-tracker-stop-btn" title="Stop Generation" style="display:none;">■</button>
                </div>
                <div class="rpg-tracker-header-right">
                    <button class="rpg-tracker-icon-btn" id="rpg-tracker-pause-btn" title="Pause Tracker">⏸</button>
                    <button class="rpg-tracker-icon-btn" id="rpg-tracker-prompt-btn" title="Toggle direct prompt">💬</button>
                    <button class="rpg-tracker-icon-btn" id="rpg-tracker-view-btn" title="Toggle rendered view">⊞</button>
                    <button class="rpg-tracker-icon-btn" id="rpg-tracker-delta-btn" title="Toggle change log">δ</button>
                    <button class="rpg-tracker-icon-btn" id="rpg-tracker-close-btn" title="Hide panel">✕</button>
                </div>
            </div>
            <div class="rpg-tracker-content">
                <textarea class="rpg-tracker-memo-area" id="rpg-tracker-memo">${settings.currentMemo}</textarea>
                <div class="rpg-tracker-render-view" id="rpg-tracker-render" style="display:none;"></div>
            </div>
            <div class="rpg-tracker-delta-resize-handle" id="rpg-tracker-delta-handle" style="display:none;"></div>
            <div class="rpg-tracker-delta-panel" id="rpg-tracker-delta" style="display:none;">
                <div class="rpg-tracker-delta-toolbar">
                    <span class="rpg-tracker-delta-title">Change Log</span>
                    <button class="rpg-tracker-icon-btn" id="rpg-tracker-delta-clear" title="Clear log">✕</button>
                </div>
                <div id="rpg-tracker-delta-content">${settings.lastDelta || '<span class="delta-empty">No changes yet.</span>'}</div>
            </div>
            <div class="rpg-tracker-prompt-bar" id="rpg-tracker-prompt-bar" style="display:none;">
                <textarea class="rpg-tracker-prompt-input" id="rpg-tracker-prompt-input" rows="2" placeholder="Instruct the tracker model… (Enter to send, Shift+Enter for newline)"></textarea>
                <button class="rpg-tracker-prompt-send" id="rpg-tracker-prompt-send" title="Send instruction">▶</button>
            </div>
            <div class="rpg-tracker-footer">
                <div class="rpg-tracker-nav">
                    <button class="rpg-tracker-nav-btn" id="rpg-tracker-nav-back" title="View previous snapshot">←</button>
                    <span class="rpg-tracker-nav-label" id="rpg-tracker-nav-label">Live</span>
                    <button class="rpg-tracker-nav-btn" id="rpg-tracker-nav-fwd" title="View next snapshot">→</button>
                </div>
                <span id="rpg-tracker-count">chars: ${settings.currentMemo.length}</span>
            </div>
        `;

        document.body.appendChild(panel);

        const header = panel.querySelector('#rpg-tracker-header');
        if (header instanceof HTMLElement) {
            makeDraggable(/** @type {HTMLElement} */(panel), header);
        }
        setupResizeObserver(/** @type {HTMLElement} */(panel));
        loadPanelGeometry(/** @type {HTMLElement} */(panel));

        const stopBtn = panel.querySelector('#rpg-tracker-stop-btn');
        if (stopBtn) {
            stopBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const { stopGeneration } = SillyTavern.getContext();
                if (stopGeneration) stopGeneration();
            });
        }

        const pauseBtn = panel.querySelector('#rpg-tracker-pause-btn');
        if (pauseBtn) {
            pauseBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const s = getSettings();
                s.enabled = !s.enabled;
                SillyTavern.getContext().saveSettingsDebounced();

                // Update settings UI checkbox if it exists
                const cb = document.getElementById('rpg_tracker_enabled');
                if (cb instanceof HTMLInputElement) cb.checked = s.enabled;

                updatePanelStatus();
            });
        }

        updatePanelStatus();

        // Handle manual edits to live memo
        const textarea = panel.querySelector('#rpg-tracker-memo');
        textarea.addEventListener('input', (e) => {
            if (_historyViewIndex !== -1) return;
            settings.currentMemo = /** @type {HTMLTextAreaElement} */ (e.target).value;
            panel.querySelector('#rpg-tracker-count').textContent = `chars: ${settings.currentMemo.length}`;
            SillyTavern.getContext().saveSettingsDebounced();
        });

        // View toggle (Raw ↔ Rendered)
        let _viewBtn = /** @type {HTMLElement} */ (panel.querySelector('#rpg-tracker-view-btn'));
        const ta = /** @type {HTMLElement} */ (panel.querySelector('#rpg-tracker-memo'));
        const rv = /** @type {HTMLElement} */ (panel.querySelector('#rpg-tracker-render'));

        if (settings.renderedViewActive !== undefined) {
            _renderedViewActive = settings.renderedViewActive;
        } else {
            _renderedViewActive = true;
            settings.renderedViewActive = true;
        }

        const applyViewState = () => {
            if (_renderedViewActive) {
                ta.style.display = 'none';
                rv.style.display = 'block';
                _viewBtn.textContent = '≡';
                _viewBtn.title = 'Switch to Raw view';
                refreshRenderedView();
            } else {
                ta.style.display = '';
                rv.style.display = 'none';
                _viewBtn.textContent = '⊞';
                _viewBtn.title = 'Switch to Rendered view';
            }
        };

        applyViewState();

        _viewBtn.addEventListener('click', () => {
            _renderedViewActive = !_renderedViewActive;
            settings.renderedViewActive = _renderedViewActive;
            SillyTavern.getContext().saveSettingsDebounced();
            applyViewState();
        });

        // Delta toggle — also shows/hides the resize handle
        panel.querySelector('#rpg-tracker-delta-btn').addEventListener('click', () => {
            const deltaEl = /** @type {HTMLElement} */ (panel.querySelector('#rpg-tracker-delta'));
            const handleEl = /** @type {HTMLElement} */ (panel.querySelector('#rpg-tracker-delta-handle'));
            const isVisible = deltaEl.style.display !== 'none';
            deltaEl.style.display = isVisible ? 'none' : 'flex';
            handleEl.style.display = isVisible ? 'none' : 'block';
            if (!isVisible) {
                const h = loadDeltaHeight();
                deltaEl.style.height = h + 'px';
            }
        });

        // Delta clear button
        panel.querySelector('#rpg-tracker-delta-clear').addEventListener('click', () => {
            settings.lastDelta = '';
            const dp = document.getElementById('rpg-tracker-delta-content');
            if (dp) dp.innerHTML = '<span class="delta-empty">Log cleared.</span>';
            SillyTavern.getContext().saveSettingsDebounced();
        });

        // Delta resize handle drag
        setupDeltaResize(/** @type {HTMLElement} */(panel));

        // Close panel
        panel.querySelector('#rpg-tracker-close-btn').addEventListener('click', () => {
            panel.style.display = 'none';
        });

        // Direct prompt toggle
        panel.querySelector('#rpg-tracker-prompt-btn').addEventListener('click', () => {
            const bar = /** @type {HTMLElement} */ (panel.querySelector('#rpg-tracker-prompt-bar'));
            const isVisible = bar.style.display !== 'none';
            bar.style.display = isVisible ? 'none' : 'flex';
            if (!isVisible) /** @type {HTMLElement} */ (panel.querySelector('#rpg-tracker-prompt-input')).focus();
        });

        // Direct prompt send
        const promptSend = async () => {
            const input = /** @type {HTMLTextAreaElement} */ (panel.querySelector('#rpg-tracker-prompt-input'));
            const msg = input.value.trim();
            if (!msg) return;
            input.value = '';
            await sendDirectPrompt(msg);
        };
        panel.querySelector('#rpg-tracker-prompt-send').addEventListener('click', promptSend);
        panel.querySelector('#rpg-tracker-prompt-input').addEventListener('keydown', (/** @type {KeyboardEvent} */ e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); promptSend(); }
        });

        // Snapshot navigation
        panel.querySelector('#rpg-tracker-nav-back').addEventListener('click', () => navigateSnapshot(1));
        panel.querySelector('#rpg-tracker-nav-fwd').addEventListener('click', () => navigateSnapshot(-1));

        // Restore via label click
        panel.querySelector('#rpg-tracker-nav-label').addEventListener('click', () => {
            const s = getSettings();
            if (_historyViewIndex === -1) return;
            const snapshot = s.memoHistory[_historyViewIndex];
            if (snapshot === undefined) return;

            // Restore: set currentMemo, trim history forward from this point (discarding the 'future' snapshots)
            s.memoHistory = s.memoHistory.slice(_historyViewIndex + 1);
            s.currentMemo = snapshot;
            _historyViewIndex = -1;
            SillyTavern.getContext().saveSettingsDebounced();
            syncMemoView();
            toastr['success']('Memo restored to snapshot.', 'RPG Tracker');
        });

        syncMemoView();
    }

    function navigateSnapshot(direction) {
        const s = getSettings();
        const maxIndex = s.memoHistory.length - 1;
        const newIndex = _historyViewIndex + direction;

        if (newIndex < -1 || newIndex > maxIndex) return;
        _historyViewIndex = newIndex;
        syncMemoView();
    }

    function syncMemoView() {
        const s = getSettings();
        const textarea = /** @type {HTMLTextAreaElement|null} */ (document.getElementById('rpg-tracker-memo'));
        const navLabel = document.getElementById('rpg-tracker-nav-label');
        const btnBack = /** @type {HTMLButtonElement|null} */ (document.getElementById('rpg-tracker-nav-back'));
        const btnFwd = /** @type {HTMLButtonElement|null} */ (document.getElementById('rpg-tracker-nav-fwd'));
        const counter = document.getElementById('rpg-tracker-count');
        if (!textarea || !navLabel) return;

        const histLen = s.memoHistory.length;

        if (_historyViewIndex === -1) {
            // Live view
            textarea.value = s.currentMemo;
            textarea.readOnly = false;
            navLabel.textContent = '[ LIVE ]';
            navLabel.classList.remove('clickable');
            navLabel.title = 'Current Live State';
            btnBack.disabled = histLen === 0;
            btnFwd.disabled = true;
            if (counter) counter.textContent = `chars: ${s.currentMemo.length}`;
        } else {
            // Snapshot view
            const snapshot = s.memoHistory[_historyViewIndex];
            textarea.value = snapshot ?? '';
            textarea.readOnly = true;
            navLabel.textContent = `[ -${_historyViewIndex + 1} 🔄 ]`;
            navLabel.classList.add('clickable');
            navLabel.title = 'Click to RESTORE this snapshot to Live';
            btnBack.disabled = _historyViewIndex >= histLen - 1;
            btnFwd.disabled = false; // can always navigate forward toward Live
            if (counter) counter.textContent = `chars: ${(snapshot ?? '').length}`;
        }
        refreshRenderedView();
    }

    /**
     * @param {HTMLElement} panel
     * @param {HTMLElement} handle
     */
    function makeDraggable(panel, handle, customKey = null) {
        let isDragging = false;
        let startX, startY, startLeft, startTop;

        handle.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return;
            // Ignore clicks on buttons inside the header
            if (e.target instanceof Element && e.target.closest('button')) return;
            isDragging = true;
            const rect = panel.getBoundingClientRect();
            startX = e.clientX; startY = e.clientY;
            startLeft = rect.left; startTop = rect.top;
            panel.style.left = startLeft + 'px';
            panel.style.top = startTop + 'px';
            panel.style.right = 'auto';
            panel.style.bottom = 'auto';
            e.preventDefault();
        });

        document.addEventListener('mousemove', (e) => {
            if (!isDragging) return;
            panel.style.left = (startLeft + (e.clientX - startX)) + 'px';
            panel.style.top = (startTop + (e.clientY - startY)) + 'px';
        });

        document.addEventListener('mouseup', () => {
            if (isDragging) { 
                isDragging = false; 
                if (customKey) {
                    const rect = panel.getBoundingClientRect();
                    localStorage.setItem(customKey, JSON.stringify({
                        left: rect.left, top: rect.top,
                        width: rect.width, height: rect.height
                    }));
                } else {
                    savePanelGeometry(panel); 
                }
            }
        });
    }

    function setupResizeObserver(panel) {
        // Debounced save on resize
        let _resizeTimer;
        const ro = new ResizeObserver(() => {
            clearTimeout(_resizeTimer);
            _resizeTimer = setTimeout(() => savePanelGeometry(panel), 300);
        });
        ro.observe(panel);
    }

    function setupDeltaResize(panel) {
        const handle = /** @type {HTMLElement} */ (panel.querySelector('#rpg-tracker-delta-handle'));
        const deltaEl = /** @type {HTMLElement} */ (panel.querySelector('#rpg-tracker-delta'));
        let startY, startH;

        handle.addEventListener('mousedown', (e) => {
            startY = e.clientY;
            startH = deltaEl.offsetHeight;
            e.preventDefault();

            const onMove = (ev) => {
                // dragging up = bigger console
                const newH = Math.max(40, startH - (ev.clientY - startY));
                deltaEl.style.height = newH + 'px';
            };
            const onUp = () => {
                saveDeltaHeight(deltaEl.offsetHeight);
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
            };
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        });
    }

    function updateUIMemo(text) {
        if (_historyViewIndex !== -1) return; // don't clobber snapshot view
        const textarea = /** @type {HTMLTextAreaElement|null} */ (document.getElementById('rpg-tracker-memo'));
        if (textarea) textarea.value = text;
        const counter = document.getElementById('rpg-tracker-count');
        if (counter) counter.textContent = `chars: ${text.length}`;
    }

    function updateStatusIndicator(state) {
        const indicator = document.getElementById('rpg-tracker-status');
        const stopBtn = /** @type {HTMLElement} */ (document.getElementById('rpg-tracker-stop-btn'));
        if (!indicator) return;

        indicator.className = 'rpg-tracker-status-indicator ' + state;
        if (stopBtn) {
            stopBtn.style.display = (state === 'running') ? 'flex' : 'none';
        }
    }

    function openCustomFieldsModal() {
        const s = getSettings();
        if (!s.customFields) s.customFields = [];

        let overlay = document.getElementById('rt_cf_overlay');
        if (!overlay) {
            overlay = document.createElement('div');
            overlay.id = 'rt_cf_overlay';
            overlay.style.position = 'fixed';
            overlay.style.top = '0'; overlay.style.left = '0';
            overlay.style.width = '100vw'; overlay.style.height = '100vh';
            overlay.style.backgroundColor = 'rgba(0,0,0,0.7)';
            overlay.style.zIndex = '9999999';
            overlay.style.display = 'flex';
            overlay.style.justifyContent = 'center';
            overlay.style.alignItems = 'center';

            overlay.innerHTML = `
                <div class="popup shadowBase" style="min-width: 500px; max-width: 800px; max-height: 85vh; display: flex; flex-direction: column;">
                    <div class="popup-header">
                        <h3 class="margin0">Manage Custom Tracker Fields</h3>
                        <div id="rt_cf_close" class="popup-close interactable" title="Close"><i class="fa-solid fa-times"></i></div>
                    </div>
                    <div class="popup-body flex-container flexFlowColumn gap-1" id="rt_cf_list" style="overflow-y: auto; flex: 1; padding: 10px;">
                    </div>
                    <div class="popup-footer" style="padding: 10px; border-top: 1px solid var(--SmartThemeBorderColor);">
                        <button id="rt_cf_add" class="menu_button interactable"><i class="fa-solid fa-plus"></i> Add New Field</button>
                    </div>
                </div>
            `;
            document.body.appendChild(overlay);

            document.getElementById('rt_cf_close').addEventListener('click', () => {
                overlay.style.display = 'none';
                SillyTavern.getContext().saveSettingsDebounced();
                refreshRenderedView();
            });

            document.getElementById('rt_cf_add').addEventListener('click', () => {
                s.customFields.push({
                    tag: 'NEW_FIELD', label: 'New Field', icon: '📝',
                    prompt: 'Extract details for NEW_FIELD.',
                    renderType: 'CHARACTER', enabled: true
                });
                renderCustomFieldsList();
            });
        }

        overlay.style.display = 'flex';
        renderCustomFieldsList();

        function renderCustomFieldsList() {
            const list = document.getElementById('rt_cf_list');
            if (!list) return;
            list.innerHTML = '';

            const RENDER_TYPES = {
                'CHARACTER': 'Standard (Key-Value / Lines)',
                'COMBAT': 'HP Bars',
                'SPELLS': 'Spell Pips',
                'INVENTORY': 'Bullet Points',
                'ABILITIES': 'Oval Pills'
            };

            s.customFields.forEach((field, index) => {
                const item = document.createElement('div');
                item.style.border = '1px solid var(--SmartThemeBorderColor)';
                item.style.padding = '10px';
                item.style.borderRadius = '5px';
                item.style.marginBottom = '10px';
                item.style.backgroundColor = 'var(--black50)';

                item.innerHTML = `
                    <div class="flex-container gap-1 alignitemscenter margin-bot-5">
                        <input type="checkbox" id="rt_cf_en_${index}" ${field.enabled ? 'checked' : ''} title="Enable">
                        <input type="text" id="rt_cf_icon_${index}" class="text_pole" value="${escapeHtml(field.icon)}" style="width: 40px; text-align: center;" title="Icon (Emoji)">
                        <input type="text" id="rt_cf_tag_${index}" class="text_pole" value="${escapeHtml(field.tag)}" placeholder="TAG" style="width: 120px; font-family: monospace;" title="Tag Name (e.g. QUESTS)">
                        <input type="text" id="rt_cf_label_${index}" class="text_pole" value="${escapeHtml(field.label)}" placeholder="Display Label" style="flex: 1; min-width: 120px;" title="Display Name">
                        <select id="rt_cf_rt_${index}" class="text_pole" style="width: 180px;" title="Render Style">
                            ${Object.entries(RENDER_TYPES).map(([k, v]) => `<option value="${k}" ${field.renderType === k ? 'selected' : ''}></option>`).join('')}
                        </select>
                        <button id="rt_cf_del_${index}" class="menu_button interactable" style="color: var(--dangerColor);" title="Delete"><i class="fa-solid fa-trash"></i></button>
                    </div>
                    <textarea id="rt_cf_prompt_${index}" class="text_pole" style="resize: vertical;" rows="2" placeholder="System prompt instructions for what to track...">${escapeHtml(field.prompt)}</textarea>
                `;

                // Add option text manually to avoid template literal weirdness with quotes
                Object.entries(RENDER_TYPES).forEach(([k, v]) => {
                    const opt = item.querySelector(`option[value="${k}"]`);
                    if (opt) opt.textContent = v;
                });

                list.appendChild(item);

                const getEl = (id) => document.getElementById(id);
                getEl(`rt_cf_en_${index}`).addEventListener('change', (e) => { field.enabled = /** @type {HTMLInputElement} */ (e.target).checked; });
                getEl(`rt_cf_icon_${index}`).addEventListener('input', (e) => { field.icon = /** @type {HTMLInputElement} */ (e.target).value; });
                getEl(`rt_cf_tag_${index}`).addEventListener('input', (e) => { field.tag = /** @type {HTMLInputElement} */ (e.target).value.replace(/[^a-zA-Z0-9_]/g, '').toUpperCase(); });
                getEl(`rt_cf_label_${index}`).addEventListener('input', (e) => { field.label = /** @type {HTMLInputElement} */ (e.target).value; });
                getEl(`rt_cf_rt_${index}`).addEventListener('change', (e) => { field.renderType = /** @type {HTMLSelectElement} */ (e.target).value; });
                getEl(`rt_cf_prompt_${index}`).addEventListener('input', (e) => { field.prompt = /** @type {HTMLTextAreaElement} */ (e.target).value; });

                getEl(`rt_cf_del_${index}`).addEventListener('click', () => {
                    if (confirm(`Delete custom field [${field.tag}]?`)) {
                        s.customFields.splice(index, 1);
                        renderCustomFieldsList();
                    }
                });
            });

            if (s.customFields.length === 0) {
                list.innerHTML = '<div style="opacity: 0.7; text-align: center; padding: 20px;">No custom fields created yet.</div>';
            }
        }
    }

    function openPromptEditor(title, currentText, defaultText, onSave) {
        let overlay = document.getElementById('rt_pe_overlay');
        if (!overlay) {
            overlay = document.createElement('div');
            overlay.id = 'rt_pe_overlay';
            overlay.className = 'flex-container flexFlowColumn alignitemscenter justifycontentcenter';
            overlay.style.position = 'fixed'; overlay.style.top = '0'; overlay.style.left = '0';
            overlay.style.width = '100vw'; overlay.style.height = '100vh';
            overlay.style.backgroundColor = 'rgba(0,0,0,0.7)';
            overlay.style.zIndex = '10000000';
            overlay.innerHTML = `
                <div class="popup shadowBase" style="min-width: 400px; max-width: 600px;">
                    <div class="popup-header">
                        <h3 class="margin0" id="rt_pe_title">Edit Prompt</h3>
                        <div id="rt_pe_close" class="popup-close interactable"><i class="fa-solid fa-times"></i></div>
                    </div>
                    <div class="popup-body flex-container flexFlowColumn gap-1" style="padding: 10px;">
                        <textarea id="rt_pe_text" class="text_pole" rows="6" style="width: 100%; resize: vertical;"></textarea>
                        <div class="flex-container gap-1 justifycontentend">
                            <button id="rt_pe_reset" class="menu_button interactable" style="margin-right: auto;"><i class="fa-solid fa-arrow-rotate-left"></i> Reset</button>
                            <button id="rt_pe_cancel" class="menu_button interactable">Cancel</button>
                            <button id="rt_pe_save" class="menu_button interactable">Save Changes</button>
                        </div>
                    </div>
                </div>
            `;
            document.body.appendChild(overlay);
        }

        const titleEl = document.getElementById('rt_pe_title');
        const textEl = /** @type {HTMLTextAreaElement} */ (document.getElementById('rt_pe_text'));
        const saveBtn = document.getElementById('rt_pe_save');
        const resetBtn = document.getElementById('rt_pe_reset');
        const close = () => { overlay.style.display = 'none'; };

        titleEl.textContent = title;
        textEl.value = currentText;
        overlay.style.display = 'flex';

        const saveHandler = () => {
            onSave(textEl.value);
            close();
        };

        const resetHandler = () => {
            if (confirm("Reset this prompt to the factory default?")) {
                textEl.value = defaultText;
            }
        };

        const cleanup = () => {
            saveBtn.removeEventListener('click', saveHandler);
            resetBtn.removeEventListener('click', resetHandler);
            document.getElementById('rt_pe_close').removeEventListener('click', close);
            document.getElementById('rt_pe_cancel').removeEventListener('click', close);
        };

        saveBtn.onclick = saveHandler;
        resetBtn.onclick = resetHandler;
        document.getElementById('rt_pe_close').onclick = close;
        document.getElementById('rt_pe_cancel').onclick = close;
    }

    /**
     * Initialization
     */
    (async function init() {
        const ctx = SillyTavern.getContext();
        const { eventSource, event_types, renderExtensionTemplateAsync } = ctx;

        getSettings();
        createPanel();

        try {
            // Load Settings UI using the dynamic folder name
            const html = await renderExtensionTemplateAsync(`third-party/${FOLDER_NAME}`, 'settings', {});
            // Third-party plugins should go to extensions_settings2 (right column) if available
            if ($('#extensions_settings2').length) {
                $('#extensions_settings2').append(html);
            } else {
                $('#extensions_settings').append(html);
            }

            const settings = getSettings();

            $('#rpg_tracker_enabled').prop('checked', settings.enabled).on('change', function () {
                settings.enabled = !!$(this).prop('checked');
                ctx.saveSettingsDebounced();
            });

            $('#rpg_tracker_debug').prop('checked', settings.debugMode).on('change', function () {
                settings.debugMode = !!$(this).prop('checked');
                ctx.saveSettingsDebounced();
            });

            // Connection Settings
            const sourceSelect = $('#rpg_tracker_connection_source');
            const profileGroup = $('#rpg_tracker_profile_group');
            const profileSelect = $('#rpg_tracker_connection_profile');
            const maxTokensInput = $('#rpg_tracker_max_tokens');

            sourceSelect.val(settings.connectionSource).on('change', function () {
                settings.connectionSource = $(this).val();
                profileGroup.toggle(settings.connectionSource === 'profile');
                ctx.saveSettingsDebounced();
            });
            profileGroup.toggle(settings.connectionSource === 'profile');

            maxTokensInput.val(settings.maxTokens || "").on('input', function () {
                settings.maxTokens = parseInt(/** @type {string} */($(this).val())) || 0;
                ctx.saveSettingsDebounced();
            });

            // Theme Select
            const themeSelect = $('#rpg_tracker_theme_select');
            themeSelect.val(settings.trackerTheme || 'rt-theme-native');
            themeSelect.on('change', function () {
                const newTheme = String($(this).val());
                settings.trackerTheme = newTheme;
                ctx.saveSettingsDebounced();
                // Apply immediately
                const panel = document.getElementById('rpg-tracker-panel');
                if (panel) {
                    panel.className = `rpg-tracker-panel ${newTheme}`;
                    if (!settings.enabled) panel.classList.add('is-paused');
                }
                // Apply to detached panels
                document.querySelectorAll('.rpg-tracker-detached-panel').forEach(dp => {
                    dp.className = `rpg-tracker-panel rpg-tracker-detached-panel ${newTheme}`;
                });
            });

            // Populate profiles using the connection helpers
            const profiles = await getConnectionProfiles();
            if (profiles && profiles.length > 0) {
                profileSelect.empty().append('<option value="">-- No Profile Selected --</option>');
                profiles.forEach(p => {
                    profileSelect.append($('<option></option>').val(p).text(p));
                });
                profileSelect.val(settings.connectionProfileId);
            } else if (ctx.ConnectionManagerRequestService?.handleDropdown) {
                // Fallback to legacy service dropdown handling
                /** @type {any} */ (ctx.ConnectionManagerRequestService).handleDropdown(profileSelect[0]);
                profileSelect.val(settings.connectionProfileId);
            }
            profileSelect.on('change', function () {
                settings.connectionProfileId = $(this).val();
                ctx.saveSettingsDebounced();
            });

            // Populate presets
            const presetSelect = $('#rpg_tracker_completion_preset');
            const pm = ctx.getPresetManager ? ctx.getPresetManager() : null;
            if (pm && typeof pm.getAllPresets === 'function') {
                const presets = pm.getAllPresets();
                presetSelect.empty().append('<option value="">-- Use Current Settings --</option>');
                presets.forEach(p => {
                    presetSelect.append($('<option></option>').val(p).text(p));
                });
                presetSelect.val(settings.completionPresetId || '');
            } else {
                presetSelect.empty().append('<option value="">-- Use Current Settings --</option>');
                if (settings.completionPresetId) {
                    presetSelect.append($('<option></option>').val(settings.completionPresetId).text(settings.completionPresetId));
                    presetSelect.val(settings.completionPresetId);
                }
            }
            presetSelect.on('change', function () {
                settings.completionPresetId = $(this).val();
                ctx.saveSettingsDebounced();
            });

            const modPrefix = '#rpg_tracker_mod_';
            ['character', 'party', 'combat', 'inventory', 'abilities', 'spells'].forEach(mod => {
                $(modPrefix + mod).prop('checked', settings.modules[mod]).on('change', function () {
                    settings.modules[mod] = !!$(this).prop('checked');
                    ctx.saveSettingsDebounced();
                });
            });

            $('#rpg_tracker_core_prompt').val(settings.systemPromptTemplate).on('input', function () {
                settings.systemPromptTemplate = $(this).val();
                ctx.saveSettingsDebounced();
            });

            $('.rt-view-stock-prompt').on('click', function () {
                const mod = $(this).data('mod');
                const settings = getSettings();
                if (!settings.stockPrompts) settings.stockPrompts = { ...DEFAULT_STOCK_PROMPTS };

                openPromptEditor(
                    `Edit Default [${mod.toUpperCase()}] Prompt`,
                    settings.stockPrompts[mod],
                    DEFAULT_STOCK_PROMPTS[mod],
                    (newVal) => {
                        settings.stockPrompts[mod] = newVal;
                        ctx.saveSettingsDebounced();
                        toastr['success'](`[${mod.toUpperCase()}] prompt updated.`, 'RPG Tracker');
                    }
                );
            });

            $('#rpg_tracker_manage_custom_fields').on('click', function () {
                openCustomFieldsModal();
            });

            $('#rpg_tracker_btn_reset_prompt').on('click', function () {
                if (!confirm('Reset the State Model prompt to the built-in default?')) return;
                // Re-read the default from the defaults object by temporarily clearing the stored value
                const { extensionSettings } = SillyTavern.getContext();
                delete extensionSettings[MODULE_NAME].systemPromptTemplate;
                const freshSettings = getSettings(); // re-merges defaults
                $('#rpg_tracker_core_prompt').val(freshSettings.systemPromptTemplate);
                ctx.saveSettingsDebounced();
                toastr['success']('Prompt reset to default.', 'RPG Tracker');
            });

            $('#rpg_tracker_btn_update').on('click', async function () {
                const { chat } = SillyTavern.getContext();
                if (!chat || chat.length === 0) return toastr['info']("No chat history found.", "RPG Tracker");

                let lastAssistantMsg = "";
                for (let i = chat.length - 1; i >= 0; i--) {
                    if (!chat[i].is_user && !chat[i].is_system) {
                        lastAssistantMsg = chat[i].mes;
                        break;
                    }
                }
                if (!lastAssistantMsg) return toastr['info']("No assistant message to parse.", "RPG Tracker");

                toastr['info']("Triggering manual State Update...", "RPG Tracker");
                await runStateModelPass(lastAssistantMsg);
            });

            $('#rpg_tracker_btn_clear').on('click', function () {
                if (confirm("Are you sure you want to clear the memory history and wipe the tracker?")) {
                    settings.currentMemo = "";
                    settings.prevMemo1 = "";
                    settings.prevMemo2 = "";
                    settings.memoHistory = [];
                    settings.lastDelta = "";
                    ctx.saveSettingsDebounced();
                    updateUIMemo("");
                    const dp = document.getElementById('rpg-tracker-delta-content');
                    if (dp) dp.innerHTML = '<span class="delta-empty">Log cleared.</span>';
                    toastr['success']("RPG Tracker logic wiped.", "RPG Tracker");
                }
            });

            // ── Profile System ──
            refreshProfileDropdown();

            $('#rpg_tracker_profile_save').on('click', function () {
                const sel = /** @type {HTMLSelectElement} */ (document.getElementById('rpg_tracker_profile_select'));
                const existing = sel.value;
                const name = prompt('Save profile as:', existing || '')?.trim();
                if (!name) return;
                saveProfile(name);
                refreshProfileDropdown();
                toastr['success'](`Profile "${name}" saved.`, 'RPG Tracker');
            });

            $('#rpg_tracker_profile_load').on('click', function () {
                const sel = /** @type {HTMLSelectElement} */ (document.getElementById('rpg_tracker_profile_select'));
                const name = sel.value;
                if (!name) return toastr['info']('No profile selected.', 'RPG Tracker');
                loadProfile(name);
                toastr['success'](`Profile "${name}" loaded.`, 'RPG Tracker');
            });

            $('#rpg_tracker_profile_delete').on('click', function () {
                const sel = /** @type {HTMLSelectElement} */ (document.getElementById('rpg_tracker_profile_select'));
                const name = sel.value;
                if (!name) return toastr['info']('No profile selected.', 'RPG Tracker');
                if (!confirm(`Delete profile "${name}"?`)) return;
                deleteProfile(name);
                refreshProfileDropdown();
                toastr['success'](`Profile "${name}" deleted.`, 'RPG Tracker');
            });

        } catch (e) {
            console.error("[RPG Tracker] Failed to build settings UI", e);
        }

        eventSource.on(event_types.MESSAGE_RECEIVED, onMessageReceived);

        // Add wand button to toggle panel visibility
        addWandButton();

        console.log("[RPG Tracker] Phase 2 Full Implementation Loaded.");
    })();

    function addWandButton() {
        const wandContainer = document.getElementById('extensionsMenu');
        if (!wandContainer) return;

        const btn = document.createElement('div');
        btn.id = 'toggle_rpg_tracker_wand_button';
        btn.classList.add('list-group-item', 'flex-container', 'flexGap5');
        
        btn.innerHTML = `
            <div class="fa-solid fa-clipboard-list extensionsMenuExtensionButton"></div>
            <span>RPG Tracker</span>
        `;
        
        btn.addEventListener('click', () => {
            const panel = document.getElementById('rpg-tracker-panel');
            if (panel) {
                const isHidden = panel.style.display === 'none';
                panel.style.display = isHidden ? 'flex' : 'none';
            }
        });

        wandContainer.appendChild(btn);
    }
})();
