(function () {
    "use strict";

    // Capture the folder name dynamically from the module URL so it works regardless of what the user names the folder
    const FOLDER_NAME = (function () {
        try {
            const scripts = Array.from(document.querySelectorAll('script[src]'));
            const myScript = scripts.find(s => s.src.includes('SillyTavern-FatbodyDnDFramework') || s.src.includes('SillyTavern-RPGStateTracker'));
            if (myScript) {
                const match = myScript.src.match(/third-party\/([^\/]+)\//);
                if (match) return decodeURIComponent(match[1]);
            }
        } catch (e) { }
        return 'SillyTavern-FatbodyDnDFramework';
    })();

    const MODULE_NAME = "rpg_tracker";
    let _stateModelRunning = false;

    const DEFAULT_STOCK_PROMPTS = {
        character: "Main character's core stats. Use this format:\n[CHARACTER]\nName (Class): current/max HP\nAtt/def: Weapon (stats) | Armor (AC: Z)\nAttr: STR X, DEX X, CON X, INT X, WIS X, CHA X\nSaves: Fort +X | Ref +X | Will +X\nSkills: Skill1 +X, Skill2 +X\nTraits: Trait1 (effect), Trait2 (effect)\nHD: dX (current/max)\nStatus: Effect (duration Xh Xm)\n[/CHARACTER]\n\nUpon LEVEL UP, incorporate attribute changes.",
        party: "Companion/Party members. Use this format for each member:\nName (Class): current/max HP\nAtt/def: Weapon (stats) | Armor (AC: Z)\nAttr: STR X, DEX X, CON X, INT X, WIS X, CHA X\nSaves: Fort +X | Ref +X | Will +X\nSkills: Skill1 +X, Skill2 +X\nTraits: Trait1 (effect), Trait2 (effect)\nSpells: Cantrips: Spell1, Spell2\nSpells: Level N (avail/max): Spell1, Spell2\nHD: dX (current/max)\nStatus: Effect (duration Xh Xm)\n\nFor spells: output ONE `Spells:` line per spell level. Do NOT merge multiple levels onto one line with pipes.\n\nOnly add party members if you see (X joins the party.)\nOnly remove party members if you see (X leaves the party.)\n\nPERSISTENCE: If the party changes, you MUST output the ENTIRE [PARTY] block including all existing characters. Never omit a character unless they leave the party.\n\nExample party: [PARTY]Elara (Ranger): 26/45 HP\nAtt/def: Shortbow (+5 / 1d6+3 P) | Leather Armor (AC: 15)\nAttr: STR 12, DEX 16, CON 14, INT 10, WIS 14, CHA 12\nSaves: Fort +3 | Ref +5 | Will +2\nSkills: Athletics +3, Perception +5\nTraits: Natural Explorer (ignore difficult terrain)\nSpells: Cantrips: Mage Hand\nSpells: Level 1 (2/2): Hunter's Mark, Goodberry\nHD: d10 (5/5)\nStatus: Healthy\n[/PARTY]",
        combat: "Active enemies/NPCs in combat. Track the current [COMBAT ROUND] starting from 1. Decrement buff/debuff durations by 1 each round. Format each combatant as:\nName: current/max HP\nAtt/def: Weapon (+X / damage) | Armor (AC: Z)\nSaves: Fort +X, Ref +X, Will +X\nOther: Trait1 (description), Trait2 (description)\nStatus: Effect (duration)\n\nYou MUST output `[COMBAT]END_COMBAT[/COMBAT]` when the narrative ends combat. Do not put members of [PARTY] into [COMBAT].",
        inventory: "Items, loot, equipment, and wealth. You MAY create this section if loot is found and it doesn't currently exist.\n\nExample:\n[INVENTORY]\n- Data-crystal\n- 1,000 GP\n- Item (Item special property)\n[/INVENTORY]",
        abilities: "Non-spell class features and active abilities ONLY (e.g. Lay on Hands, Action Surge). NEVER mix these with spells. Format each entry as: `Ability Name (brief description)`.",
        spells: "Spell slots and spells known, grouped by level. Format each line as: `Level N (avail/max): Spell1, Spell2`. For cantrips, use `Cantrips: Spell1, Spell2`. Track slot usage accurately. NEVER mix these with abilities.",
        time: "Current time and day (e.g. '8:43 AM, Day 1') and time of the last rest (e.g. 'Last Rest: 10:00 PM, Day 0'). Use this to track out-of-combat buff durations by comparing to the PRIOR MEMO's time.",
        xp: "Character Level and Experience Points (XP). Format as `Level: X | XP: current/max`. You MUST output this field whenever the narrative mentions gaining experience or leveling up."
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
            rngEnabled: true,
            systemPromptTemplate:
                "You are the State Extractor Model. Your task is to maintain a structured State Memo based on the roleplay narrative.\n" +
                "IGNORE NARRATIVE FLUFF: Do not track temporary dialogue or actions. Only track persistent state changes.\n" +
                "INTEGRATION: Track all durations stated by the narrative (e.g. 'poisoned for 3 turns'). Decrement by 1 each round in [COMBAT]. For out-of-combat durations, calculate the delta between the current [TIME] and the [TIME] in the PRIOR MEMO.\n" +
                "CREATION: You MAY create a section that did not exist in the Prior Memo when the narrative warrants it based on your enabled modules.\n" +
                "DELETION: To REMOVE a section entirely, you MUST output: `[TAG]REMOVED[/TAG]`.\n" +
                "You must track the following enabled modules:\n{{modulesText}}\n" +
                "RULES:\n" +
                "1. Read the PRIOR MEMO and the NARRATIVE OUTPUT carefully.\n" +
                "2. Determine which sections changed. Only output sections that actually changed.\n" +
                "3. Use strict [TAG]...[/TAG] structure based on the modules requested above. ALWAYS include the closing tag.\n" +
                "   EXAMPLE FORMATTING:\n" +
                "   [TIME]\n" +
                "   8:43 AM, Day 1\n" +
                "   [/TIME]\n\n" +
                "   [CHARACTER]\n" +
                "   Eliel: 8/8 HP | AC: 12\n" +
                "   Level 1 | STR 8, DEX 14, CON 14\n" +
                "   Saves: Fort +4 | Ref +2 | Will -1\n" +
                "   [/CHARACTER]\n\n" +
                "   [COMBAT]\n" +
                "   Combat Round 1\n" +
                "   Goblin: 7/7 HP | AC: 15 | Saves: Fort +1, Ref +2, Will +0 | Status: Healthy\n" +
                "   [/COMBAT]\n\n" +
                "   [XP]\n" +
                "   Level: 1 | XP: 100/300\n" +
                "   [/XP]\n\n" +
                "4. Omit unchanged sections entirely. Do NOT output a section if its contents did not change.\n" +
                "5. BLOCK PERSISTENCE: For list-based sections ([PARTY], [INVENTORY], [ABILITIES], [SPELLS], [COMBAT]), if any single item within that section changes, you MUST re-output the ENTIRE section containing all items. Never omit existing members or items unless they are explicitly logically removed.\n" +
                "6. If there are absolutely NO CHANGES to any section, you MUST output exactly: `NO_CHANGES_DETECTED`\n" +
                "7. Output ONLY the changed sections (or NO_CHANGES_DETECTED). No preamble, no explanation, no commentary.\n\n" +
                "REGARDING COMBAT:\n" +
                "1. [COMBAT] section is only created when actual combat begins, not when enemies are simply present in the scene.\n" +
                "2. If an entity dies in combat, output it as 0/X HP, for example \"Shambling Corpse B (Fodder): 0/9 HP | AC: 10,\" do not omit it completely from the next state.\n\n" +
                "BUFFS:\n" +
                "Duration Tracking: Record all durations explicitly. Use turns for combat (e.g., for 3 turns) and H:M for narrative time (e.g., 1h 30m).\n" +
                "Restoration Anchors: When a buff or debuff modifies a base statistic (AC, Attributes, etc.), you MUST record the original value to allow for accurate restoration. Use the \"Current from Original\" format.\n" +
                "Example: (Mage Armor, AC 13 from 10, 8h 0m)\n" +
                "Example: (Weakened, STR 8 from 16, 1h 0m)\n" +
                "Auto-Reversion: During each State Sync, check the delta between the PRIOR MEMO and current narrative. If a duration has expired, you MUST restore the base statistic to its \"Original\" value in the relevant section and then remove the buff from the list.\n" +
                "Conditional Buffs: For effects without a set time, use event-based anchors.\n" +
                "Example: (Exhaustion, Disadvantage on Ability Checks, until Long Rest)\n\n" +
                "LEVEL UPS:\n" +
                "Update abilities/attributes/HP/etc accordingly, such as an ability's 1d6 bonus increasing to 2d6, etc.",
            modules: {
                character: true,
                party: true,
                combat: true,
                inventory: true,
                abilities: true,
                spells: true,
                time: true,
                xp: true
            },
            stockPrompts: { ...DEFAULT_STOCK_PROMPTS },
            customFields: [],
            profiles: {},
            activeProfile: "",
            fullViewSections: [],
            blockOrder: ['COMBAT', 'CHARACTER', 'PARTY', 'INVENTORY', 'ABILITIES', 'SPELLS', 'XP', 'TIME']
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
     * RNG Engine Implementation
     */
    const RNG_QUEUE_LEN = 8;
    function rollDie(sides) {
        const buf = new Uint32Array(1);
        const limit = Math.floor(4294967296 / sides) * sides;
        let roll;
        do { crypto.getRandomValues(buf); roll = buf[0]; } while (roll >= limit);
        return (roll % sides) + 1;
    }
    function makeRngQueue(n = RNG_QUEUE_LEN) {
        const out = [];
        for (let i = 0; i < n; i++) {
            out.push({
                d20: rollDie(20),
                d4: rollDie(4),
                d6: rollDie(6),
                d8: rollDie(8),
                d10: rollDie(10),
                d12: rollDie(12)
            });
        }
        return out;
    }
    function buildRngBlock(queue) {
        const turnId = Date.now();
        const formattedQueue = queue.map(dice => {
            return `${dice.d20}(d4:${dice.d4},d6:${dice.d6},d8:${dice.d8},d10:${dice.d10},d12:${dice.d12})`;
        }).join(", ");
        return `[RNG_QUEUE v6.0_PROPER]\nturn_id=${turnId}\nscope=this_response\nqueue=[${formattedQueue}]\n[/RNG_QUEUE]\n\n`;
    }

    globalThis.rpgTrackerInterceptor = async function (chat, contextSize, abort, type) {
        const settings = getSettings();
        if (!settings.enabled) return;

        // Find the last user message to prepend injections
        let idx = -1;
        for (let i = chat.length - 1; i >= 0; i--) {
            if (chat[i]['role'] === "user" || chat[i].is_user) {
                idx = i;
                break;
            }
        }

        if (idx === -1) return;

        const msg = chat[idx];
        const content = msg['content'] || msg.mes || '';

        let injections = "";

        // 1. RNG Injection
        if (settings.rngEnabled && !content.includes("[RNG_QUEUE v6.0_PROPER]")) {
            const queue = makeRngQueue(RNG_QUEUE_LEN);
            injections += buildRngBlock(queue);
        }

        // 2. State Memo Injection
        if (settings.currentMemo && !content.includes("### STATE MEMO (DO NOT REPEAT)")) {
            injections += `### STATE MEMO (DO NOT REPEAT)\n${settings.currentMemo}\n\n`;
        }

        if (!injections) return;

        const cloned = structuredClone(msg);
        if (typeof cloned.content === "string") cloned.content = injections + cloned.content;
        else if (typeof cloned.mes === "string") cloned.mes = injections + cloned.mes;

        chat[idx] = cloned;
        if (settings.debugMode) console.log("[Fatbody Framework] Injections pushed to request.");
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
            const isRemoval = /^(?:REMOVED|EXPIRED|CLEARED|NONE|END_COMBAT)$/i.test(newContent);

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
     * @param {string} narrativeOutput The last narrative message to parse.
     * @param {boolean} isFullContext Whether to perform a long-horizon audit of the entire chat.
     */
    async function runStateModelPass(narrativeOutput, isFullContext = false) {
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

            let systemPrompt = settings.systemPromptTemplate.replace("{{modulesText}}", modulesText);
            if (isFullContext) {
                systemPrompt = systemPrompt
                    .replace(/Only output sections that actually changed/gi, "Perform a full audit of the narrative history and output the COMPLETE state for all enabled modules")
                    .replace(/Omit unchanged sections entirely/gi, "Do NOT omit any section; output a complete, verified state memo");
            }

            let userPrompt = "";

            if (isFullContext) {
                const { chat } = SillyTavern.getContext();
                // Take last 60 messages for a "long horizon" audit
                const N = 60;
                const recentChat = chat.slice(-N);
                const chatLog = recentChat.map(m => {
                    const name = m.is_user ? 'Player' : (m.name || 'Narrator');
                    return `${name}: ${m.mes}`;
                }).join('\n\n');

                userPrompt =
                    `## NARRATIVE HISTORY (Last ${recentChat.length} messages)\n${chatLog}\n\n` +
                    `## PRIOR MEMO\n${settings.currentMemo || '(empty)'}\n\n` +
                    `## TASK\nAnalyze the entire narrative history provided above. Rebuild the State Memo to ensure every detail (HP, AC, Inventory, Abilities, XP, Party members) is perfectly accurate to the current moment in the story. Correct any errors or omissions found in the Prior Memo.\n\n` +
                    `## OUTPUT THE COMPLETE VERIFIED STATE MEMO:`;
            } else {
                const lastUserAction = getLastUserAction();
                const userActionSection = lastUserAction
                    ? `## PLAYER ACTION (what the user just did)\n${lastUserAction}\n\n`
                    : '';

                userPrompt =
                    `## PRIOR MEMO\n${settings.currentMemo}\n\n` +
                    userActionSection +
                    `## NARRATIVE OUTPUT\n${narrativeOutput}\n\n` +
                    `## OUTPUT ONLY CHANGED SECTIONS:`;
            }

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

            // Sanitize coordinates to prevent "bricking" off-screen
            const left = saved.left !== undefined ? Math.max(0, Math.min(window.innerWidth - 50, saved.left)) : undefined;
            const top = saved.top !== undefined ? Math.max(0, Math.min(window.innerHeight - 50, saved.top)) : undefined;

            if (left !== undefined) { panel.style.left = left + 'px'; panel.style.right = 'auto'; }
            if (top !== undefined) { panel.style.top = top + 'px'; panel.style.bottom = 'auto'; }
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
            blockOrder: JSON.parse(JSON.stringify(s.blockOrder || BLOCK_ORDER)),
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
        s.blockOrder = p.blockOrder ? JSON.parse(JSON.stringify(p.blockOrder)) : s.blockOrder;
        s.stockPrompts = p.stockPrompts ? JSON.parse(JSON.stringify(p.stockPrompts)) : { ...DEFAULT_STOCK_PROMPTS };
        s.customFields = p.customFields ? JSON.parse(JSON.stringify(p.customFields)) : [];
        s.lastDelta = p.lastDelta ?? '';
        s.activeProfile = name;
        _historyViewIndex = -1;
        SillyTavern.getContext().saveSettingsDebounced();
        // Refresh UI
        refreshOrderList();
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

    const splitSmart = (text) => {
        const res = [];
        let cur = '', depth = 0;
        for (const c of text) {
            if (c === '(') depth++; else if (c === ')') depth--;
            if (c === ',' && depth === 0) { res.push(cur.trim()); cur = ''; }
            else cur += c;
        }
        if (cur.trim()) res.push(cur.trim());
        return res;
    };

    const renderPills = (text) => {
        return splitSmart(text).map(t => {
            const m = t.match(/^(.+?)\s*\((.+)\)$/);
            if (m) {
                const [, name, desc] = m;
                return `<span class="rt-unit-pill">
                    <span class="rt-unit-name">${escapeHtml(name)}</span>
                    <span class="rt-unit-icon">i</span>
                    <span class="rt-unit-descr">${escapeHtml(desc)}</span>
                </span>`;
            }
            return `<span class="rt-unit-pill no-desc"><span class="rt-unit-name">${escapeHtml(t)}</span></span>`;
        }).join('');
    };

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



    const BLOCK_ICONS = { TIME: '🕒', XP: '🇽🇵', CHARACTER: '🧙', PARTY: '👥', COMBAT: '⚔️', INVENTORY: '🎒', ABILITIES: '✨', SPELLS: '📖' };
    const BLOCK_ORDER = ['COMBAT', 'CHARACTER', 'PARTY', 'INVENTORY', 'ABILITIES', 'SPELLS', 'XP', 'TIME'];
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

        const highlightParens = (text) => {
            return text.replace(/\(([^)]+)\)/g, '<span class="rt-paren-highlight">($1)</span>');
        };

        switch (renderType) {
            case 'COMBAT':
            case 'PARTY':
            case 'CHARACTER': {
                const results = [];
                let lastEntityIdx = -1;

                for (let i = 0; i < lines.length; i++) {
                    const line = lines[i];

                    // Check for Combat Round header
                    if (tag === 'COMBAT' && /Combat Round\s*\d+/i.test(line)) {
                        results.push(`<div class="rt-combat-round">${escapeHtml(line)}</div>`);
                        lastEntityIdx = -1;
                        continue;
                    }

                    const hpMatch = line.match(/^(.+?):\s*([\d,]+)(?:\/([\d,]+))?\s*HP\s*[:|,]?\s*(.*)$/i);
                    if (hpMatch) {
                        const [, name, curRaw, maxRaw, rest] = hpMatch;
                        const cur = Number(curRaw.replace(/,/g, ''));
                        const max = maxRaw ? Number(maxRaw.replace(/,/g, '')) : undefined;
                        const hasMax = max !== undefined;
                        const pct = hasMax ? Math.max(0, Math.min(100, (cur / max) * 100)) : 100;
                        const hpColor = !hasMax ? '#00ffaa' : pct > 60 ? '#00ffaa' : pct > 30 ? '#ffaa00' : '#ff5555';
                        const status = rest.trim().replace(/^\|\s*/, '');
                        const label = hasMax ? `${curRaw}/${maxRaw}` : `${curRaw}`;

                        lastEntityIdx = results.length;
                        results.push(`<div class="rt-entity-row">
                            <div class="rt-entity-name">${escapeHtml(name.trim())}</div>
                            <div class="rt-hp-bar-wrap" title="${label} HP">
                                <div class="rt-hp-bar" style="width:${pct.toFixed(1)}%;background:${hpColor};"></div>
                            </div>
                            <span class="rt-hp-label">${label}</span>
                        </div>`);

                        if (status) {
                            // Split inline status by pipe to find AC, Saves, etc.
                            const parts = status.split('|').map(p => p.trim()).filter(Boolean);
                            let genericInfo = [];

                            for (const part of parts) {
                                if (part.toLowerCase().startsWith('ac:')) {
                                    results[lastEntityIdx] += `<div class="rt-entity-sub-line">
                                        <span class="rt-entity-sub-label">AC:</span> ${escapeHtml(part.substring(3).trim())}
                                    </div>`;
                                } else if (part.toLowerCase().startsWith('saves:')) {
                                    results[lastEntityIdx] += `<div class="rt-entity-sub-line">
                                        <span class="rt-entity-sub-label">Saves:</span> ${highlightParens(escapeHtml(part.substring(6).trim()))}
                                    </div>`;
                                } else if (part.toLowerCase().startsWith('status:')) {
                                    results[lastEntityIdx] += `<div class="rt-entity-sub-line">
                                        <span class="rt-entity-sub-label">Status:</span> ${highlightParens(escapeHtml(part.substring(7).trim()))}
                                    </div>`;
                                } else if (part.toLowerCase().startsWith('other:') || part.toLowerCase().startsWith('res:')) {
                                    const label = part.toLowerCase().startsWith('res:') ? 'Res:' : 'Other:';
                                    const start = part.toLowerCase().startsWith('res:') ? 4 : 6;
                                    const text = part.substring(start).trim();
                                    results[lastEntityIdx] += `<div class="rt-entity-sub-line rt-units-container">
                                        <span class="rt-entity-sub-label">${label}</span> ${renderPills(text)}
                                    </div>`;
                                } else {
                                    genericInfo.push(part);
                                }
                            }

                            if (genericInfo.length > 0) {
                                results[lastEntityIdx] += `<div class="rt-entity-sub-line">
                                    <span class="rt-entity-sub-label">Info:</span> ${highlightParens(escapeHtml(genericInfo.join(' | ')))}
                                </div>`;
                            }
                        }
                    } else if ((line.toLowerCase().startsWith('attributes:') || line.toLowerCase().startsWith('attr:')) && lastEntityIdx !== -1) {
                        const label = line.toLowerCase().startsWith('attr:') ? 'Attr:' : 'Attr:';
                        const startIdx = line.indexOf(':') + 1;
                        const attrText = line.substring(startIdx).trim();
                        const attrHtml = `<div class="rt-entity-sub-line rt-entity-attributes">
                            <span class="rt-entity-sub-label">${label}</span> ${escapeHtml(attrText)}
                        </div>`;
                        results[lastEntityIdx] += attrHtml;
                    } else if ((line.toLowerCase().startsWith('skills:') || line.toLowerCase().startsWith('key skills:')) && lastEntityIdx !== -1) {
                        // Append bundled skills below the entity row
                        const skillsMatch = line.match(/^(?:key\s+)?skills:\s*(.+)$/i);
                        const skillsText = skillsMatch ? skillsMatch[1].trim() : line.split(':')[1]?.trim() || '';
                        const skillsHtml = `<div class="rt-entity-sub-line">
                            <span class="rt-entity-sub-label">Skills:</span> ${escapeHtml(skillsText)}
                        </div>`;
                        results[lastEntityIdx] += skillsHtml;
                    } else if (line.toLowerCase().startsWith('saves:') && lastEntityIdx !== -1) {
                        const startIdx = line.indexOf(':') + 1;
                        const savesText = line.substring(startIdx).trim();
                        const savesHtml = `<div class="rt-entity-sub-line">
                            <span class="rt-entity-sub-label">Saves:</span> ${highlightParens(escapeHtml(savesText))}
                        </div>`;
                        results[lastEntityIdx] += savesHtml;
                    } else if (line.toLowerCase().startsWith('status:') && lastEntityIdx !== -1) {
                        const statusText = line.substring(7).trim();
                        const statusHtml = `<div class="rt-entity-sub-line">
                            <span class="rt-entity-sub-label">Status:</span> <span>${highlightParens(escapeHtml(statusText))}</span>
                        </div>`;
                        results[lastEntityIdx] += statusHtml;
                    } else if ((line.toLowerCase().startsWith('primary weapon:') || line.toLowerCase().startsWith('att/def:')) && lastEntityIdx !== -1) {
                        const startIdx = line.indexOf(':') + 1;
                        const label = line.toLowerCase().startsWith('att/def:') ? 'Att/Def:' : 'Weapon:';
                        const weaponText = line.substring(startIdx).trim();
                        const weaponHtml = `<div class="rt-entity-sub-line">
                            <span class="rt-entity-sub-label">${label}</span> ${highlightParens(escapeHtml(weaponText))}
                        </div>`;
                        results[lastEntityIdx] += weaponHtml;
                    } else if (line.toLowerCase().startsWith('hd:') && lastEntityIdx !== -1) {
                        const startIdx = line.indexOf(':') + 1;
                        let hdText = line.substring(startIdx).trim();
                        let pipsHtml = escapeHtml(hdText);
                        const m = hdText.match(/^([^(]+?)\s*(?:\(([\d,]+)\/([\d,]+)\))?$/);
                        if (m) {
                            const [, dice, curStr, maxStr] = m;
                            if (curStr && maxStr) {
                                const cur = parseInt(curStr.replace(/,/g, ''), 10);
                                const max = parseInt(maxStr.replace(/,/g, ''), 10);
                                const pips = Array.from({ length: max }, (_, i) =>
                                    `<span class="rt-hd-pip${i < cur ? ' rt-hd-available' : ''}"></span>`
                                ).join('');
                                pipsHtml = `<span class="rt-hd-label">[ ${escapeHtml(dice.trim())} ]</span> <span class="rt-hd-pips">${pips}</span>`;
                            }
                        }
                        const hdHtml = `<div class="rt-entity-sub-line">
                            <span class="rt-entity-sub-label">HD:</span> <span>${pipsHtml}</span>
                        </div>`;
                        results[lastEntityIdx] += hdHtml;
                    } else if (line.toLowerCase().startsWith('traits:') && lastEntityIdx !== -1) {
                        const traitsText = line.substring(7).trim();
                        const traitsHtml = `<div class="rt-entity-sub-line rt-units-container">
                            <span class="rt-entity-sub-label">Traits:</span> ${renderPills(traitsText)}
                        </div>`;
                        results[lastEntityIdx] += traitsHtml;
                    } else if ((line.toLowerCase().startsWith('other:') || line.toLowerCase().startsWith('resistances:')) && lastEntityIdx !== -1) {
                        const startIdx = line.indexOf(':') + 1;
                        const otherText = line.substring(startIdx).trim();
                        const otherHtml = `<div class="rt-entity-sub-line rt-units-container">
                            <span class="rt-entity-sub-label">Other:</span> ${renderPills(otherText)}
                        </div>`;
                        results[lastEntityIdx] += otherHtml;
                    } else if (line.toLowerCase().startsWith('spells:') && lastEntityIdx !== -1) {
                        const startIdx = line.indexOf(':') + 1;
                        const spellLine = line.substring(startIdx).trim();

                        // Helper to render a single parsed spell-level group
                        const renderSpellGroup = (groupStr) => {
                            const m = groupStr.trim().match(/^(Level\s*\d+|Cantrips?)\s*(?:\((\d+)\/(\d+)[^)]*\))?\s*(?::\s*(.+))?$/i);
                            if (!m) return null;
                            const [, label, availStr, maxStr, spellList] = m;
                            const isCantrip = /cantrip/i.test(label);
                            let pipsHtml = '';
                            if (!isCantrip && availStr !== undefined && maxStr !== undefined) {
                                const avail = parseInt(availStr, 10), maxSlots = parseInt(maxStr, 10);
                                const pips = Array.from({ length: maxSlots }, (_, i) =>
                                    `<span class="rt-slot-pip${i < avail ? ' rt-slot-available' : ' rt-slot-used'}"></span>`
                                ).join('');
                                pipsHtml = `<span class="rt-slot-pips">${pips}</span>`;
                            }
                            let spellsHtml = '';
                            if (spellList) {
                                const spells = spellList.split(',').map(s => {
                                    const name = s.trim();
                                    const slug = name.toLowerCase().replace(/'/g, '').replace(/[^a-z0-9]+/g, '-');
                                    const url = `https://dnd5e.wikidot.com/spell:${slug}`;
                                    return `<a href="${url}" target="_blank" class="rt-spell-name" title="View spell on Wikidot">${escapeHtml(name)}</a>`;
                                }).join('');
                                spellsHtml = `<div class="rt-spell-list">${spells}</div>`;
                            }
                            // Mirror the exact HTML structure of the standalone SPELLS block:
                            // rt-spell-row (2-col grid): level label | inline-group(pips + list)
                            return `<div class="rt-spell-row">
                                <span class="rt-spell-level">${escapeHtml(label.trim())}</span>
                                <div class="rt-spell-inline-group">${pipsHtml}${spellsHtml}</div>
                            </div>`;
                        };

                        // Support BOTH formats:
                        // New (standard): one Spells: line per level
                        //   e.g. "Spells: Cantrips: Guidance"
                        //        "Spells: Level 1 (2/2): Hunter's Mark, Goodberry"
                        // Legacy (compound): pipe-separated levels on one Spells: line
                        //   e.g. "Spells: Cantrips: Guidance | Level 1 (2/2): Hunter's Mark, Goodberry"
                        const isCompound = /\|/.test(spellLine) && /(?:Level\s*\d+|Cantrips?)/i.test(spellLine);
                        const groups = isCompound
                            ? spellLine.split(/\s*\|\s*/)
                            : [spellLine];

                        let renderedAny = false;
                        for (const group of groups) {
                            const rowHtml = renderSpellGroup(group);
                            if (rowHtml) {
                                results[lastEntityIdx] += rowHtml;
                                renderedAny = true;
                            }
                        }
                        if (!renderedAny) {
                            // Fallback if model format is unrecognizable
                            results[lastEntityIdx] += `<div class="rt-entity-sub-line"><span class="rt-entity-sub-label">Spells:</span> ${highlightParens(escapeHtml(spellLine))}</div>`;
                        }
                    } else {
                        results.push(`<div class="rt-card-line">${escapeHtml(line)}</div>`);
                        lastEntityIdx = -1;
                    }
                }
                return results;
            }
            case 'TIME': {
                let currentTotalMins = 0;
                let parsedCurrent = false;

                const parseTimeStr = (str) => {
                    let d = 0, h = 0, m = 0;
                    const dayMatch = str.match(/(?:Day|D)\s*(\d+)/i);
                    if (dayMatch) d = parseInt(dayMatch[1], 10);
                    const timeMatch = str.match(/(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
                    if (timeMatch) {
                        let tmph = parseInt(timeMatch[1], 10);
                        m = parseInt(timeMatch[2], 10);
                        if (timeMatch[3]) {
                            const ampm = timeMatch[3].toUpperCase();
                            if (ampm === 'PM' && tmph < 12) tmph += 12;
                            if (ampm === 'AM' && tmph === 12) tmph = 0;
                        }
                        h = tmph;
                    }
                    if (!dayMatch && !timeMatch) return null;
                    return (d * 24 * 60) + (h * 60) + m;
                };

                for (let line of lines) {
                    if (line.toLowerCase().startsWith('last rest:')) continue;
                    if (!parsedCurrent) {
                        const t = parseTimeStr(line);
                        if (t !== null) {
                            currentTotalMins = t;
                            parsedCurrent = true;
                        }
                    }
                }

                return lines.map(line => {
                    if (line.toLowerCase().startsWith('last rest:')) {
                        const restVal = line.substring(line.indexOf(':') + 1).trim();
                        let append = "";
                        if (parsedCurrent) {
                            const restMins = parseTimeStr(restVal);
                            if (restMins !== null) {
                                const diff = currentTotalMins - restMins;
                                if (diff >= 0) {
                                    const dH = Math.floor(diff / 60);
                                    const dM = diff % 60;
                                    append = ` <i style="opacity: 0.7; font-size: 0.9em;">(${dH > 0 ? dH + ' hours ' : ''}${dM > 0 ? dM + ' minutes ' : ''}ago)</i>`;
                                    if (diff === 0) append = ` <i style="opacity: 0.7; font-size: 0.9em;">(just now)</i>`;
                                    if (dH >= 24) {
                                        const dDays = Math.floor(dH / 24);
                                        const dRemH = dH % 24;
                                        append = ` <i style="opacity: 0.7; font-size: 0.9em;">(${dDays} days ${dRemH > 0 ? dRemH + ' hours ' : ''}ago)</i>`;
                                    }
                                }
                            }
                        }
                        return `<div class="rt-card-line"><b>Last Rest:</b> ${escapeHtml(restVal)}${append}</div>`;
                    }
                    return `<div class="rt-card-line">${escapeHtml(line)}</div>`;
                });
            }
            case 'XP':
                return lines.map(line => {
                    const xpMatch = line.match(/(?:Level:\s*(\d+)\s*\|?\s*)?XP:\s*([\d,]+)\/([\d,]+)/i);
                    if (!xpMatch) return `<div class="rt-card-line">${escapeHtml(line)}</div>`;
                    const [, level, curRaw, maxRaw] = xpMatch;
                    const cur = Number(curRaw.replace(/,/g, ''));
                    const max = Number(maxRaw.replace(/,/g, ''));
                    const pct = Math.max(0, Math.min(100, (cur / max) * 100));
                    const levelHtml = level ? `<span>Level ${level}</span>` : '';
                    return `<div class="rt-xp-row">
                        <div class="rt-xp-label">${levelHtml}<span>XP: ${curRaw} / ${maxRaw}</span></div>
                        <div class="rt-xp-bar-wrap">
                            <div class="rt-xp-bar" style="width:${pct.toFixed(1)}%;"></div>
                        </div>
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
                    const spells = spellList.split(',').map(s => {
                        const name = s.trim();
                        const slug = name.toLowerCase()
                            .replace(/'/g, '')
                            .replace(/[^a-z0-9]+/g, '-');
                        const url = `https://dnd5e.wikidot.com/spell:${slug}`;
                        return `<a href="${url}" target="_blank" class="rt-spell-name" title="View spell on Wikidot">${escapeHtml(name)}</a>`;
                    }).join('');
                    return `<div class="rt-spell-row">
                        <span class="rt-spell-level">${escapeHtml(label.trim())}</span>
                        <div class="rt-spell-inline-group">${pipsHtml}<div class="rt-spell-list">${spells}</div></div>
                    </div>`;
                });
            }
            case 'INVENTORY': {
                const allItems = lines.flatMap(line => {
                    // If the line starts with a bullet point, treat it as a single item
                    if (line.trim().match(/^[-*]\s+/)) {
                        return [line.trim()];
                    }
                    // Otherwise split by commas that aren't inside parentheses
                    return line.split(/,(?![^(]*\))/).map(i => i.trim()).filter(Boolean);
                });
                return allItems.map(l => l.replace(/^[-*]\s*/, ''))
                    .map(i => `<div class="rt-card-item">• ${escapeHtml(i)}</div>`);
            }
            case 'ABILITIES': {
                const allAbilities = lines.flatMap(line => {
                    const l = line.trim();
                    if (l.match(/^[-*]\s+/)) return [l.replace(/^[-*]\s*/, '')];
                    return splitSmart(l);
                });

                return allAbilities.map(t => renderPills(t));
            }
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
            return `<div class="rt-empty" style="text-align: left; align-items: flex-start; padding: 12px; gap: 10px; overflow-y: auto;">
                <div style="text-align: center; width: 100%; margin-bottom: 4px; flex-shrink: 0;">
                    <div class="rt-empty-icon">📜</div>
                    <div style="font-size: 17px; font-weight: bold; color: var(--rt-text);">Fatbody D&D Framework</div>
                </div>

                <div style="font-size: 13px; opacity: 0.9; margin-top: 4px; flex-shrink: 0; line-height: 1.4;">
                    <b style="color: var(--rt-accent); font-size: 14px;">Initial Setup:</b><br><br>
                    1. Use the archetype buttons below to roll a new character, paste an existing sheet into the "Raw View", or <b>manually describe a character</b> by clicking 💬 and asking the tracker to create one for you (e.g., "Create a level 5 Orc Paladin").<br><br>
                    2. Create a character card for your "narrator", such as Simulation Engine or Game Master.<br><br>
                    3. Finally, copy <code>sysprompt.txt</code> (or from the SYSPROMPT button) into your Quick Prompts "Main" box.<br><br>
                    <span style="color: #ffaa00;"><b>NOTE:</b> When you update Fatbody D&D Framework, make sure you copy SYSPROMPT from the bottom right again and also reset the prompts in the extension settings. The system prompt is often also updated.</span>
                </div>
                <div style="display: flex; align-items: center; justify-content: center; gap: 8px; width: 100%; margin: 8px 0 4px 0; flex-shrink: 0;">
                    <span style="font-size: 12px; opacity: 0.8; font-weight: bold; font-style: italic;">Starting Level:</span>
                    <select id="rt-starting-level" class="text_pole" style="width: auto; min-width: 60px; padding: 2px 4px; font-size: 12px; height: 24px; border-radius: 4px; background: var(--black70a);">
                        ${[...Array(20).keys()].map(i => `<option value="${i + 1}">Level ${i + 1}</option>`).join('')}
                    </select>
                </div>
                <div class="rt-onboarding-buttons" style="width: 100%; justify-content: center; margin: 4px 0; flex-shrink: 0;">
                    <button class="rt-random-char-btn" data-archetype="magic">✨ Magic</button>
                    <button class="rt-random-char-btn" data-archetype="melee">⚔️ Melee</button>
                    <button class="rt-random-char-btn" data-archetype="rogue">🗡️ Rogue</button>
                </div>

                <div style="font-size: 13px; opacity: 0.9; display: flex; flex-direction: column; gap: 8px; flex-shrink: 0; line-height: 1.4;">
                    <div><b style="color: var(--rt-accent);">Auto-Tracking:</b> As you roleplay, the extension intelligently parses assistant responses. It detects losses of HP, new loot, or combat triggers, running background passes to update the state.</div>

                    <div><b style="color: var(--rt-accent);">Prompt Injection:</b> The State Memo and RNG Queue are injected seamlessly into your outgoing prompt. It acts as the "source of truth," assuring the model accurately remembers HP, inventory, and mechanical outcomes.</div>

                    <div><b style="color: var(--rt-accent);">Validation:</b> Use the Delta Log (δ) to verify changes. If the AI ever makes a mistake, step backwards using the Snapshot Navigation (←/→) to restore a clean state.</div>
                </div>
            </div>`;
        }

        const blocks = parseMemoBlocks(memo);
        if (Object.keys(blocks).length === 0) {
            return `<div class="rt-empty">No structured blocks found.<br><small>Switch to Raw view to inspect the memo.</small></div>`;
        }

        const s = getSettings();
        const order = s.blockOrder || BLOCK_ORDER;
        const sorted = [
            ...order.filter(k => blocks[k] !== undefined),
            ...Object.keys(blocks).filter(k => !order.includes(k)).sort()
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
        el.querySelectorAll('.rt-random-char-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                const archetype = btn.dataset.archetype;
                const level = el.querySelector('#rt-starting-level')?.value || 1;
                const labels = { magic: '✨ Casting...', melee: '⚔️ Training...', rogue: '🗡️ Sneaking...' };
                const prompts = {
                    magic: `Generate a random Level ${level} D&D Magic User (Wizard, Sorcerer, or Warlock). Output [CHARACTER], [SPELLS], [INVENTORY], and [ABILITIES] blocks. Include appropriate spells (using 'Cantrips:' for level 0 spells), items, and attributes consistent with Level ${level}.`,
                    melee: `Generate a random Level ${level} D&D Melee Fighter (Fighter, Barbarian, or Paladin). Output [CHARACTER], [INVENTORY], and [ABILITIES] blocks. Focus on high physical attributes, heavy armor, and signature weapons consistent with Level ${level}.`,
                    rogue: `Generate a random Level ${level} D&D Rogue or Thief-style character. Output [CHARACTER], [INVENTORY], and [ABILITIES] blocks. Focus on high Dexterity, stealth-related equipment (thieves' tools, daggers), and class features like Sneak Attack consistent with Level ${level}.`
                };

                el.querySelectorAll('.rt-random-char-btn').forEach(b => b.disabled = true);
                btn.textContent = labels[archetype] || '🎲 Rolling...';
                await sendDirectPrompt(prompts[archetype]);
            });
        });

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

        // Add toggle behavior for Unit Pills (Traits/Abilities)
        el.querySelectorAll('.rt-unit-pill').forEach(unit => {
            unit.addEventListener('click', (e) => {
                e.stopPropagation();
                // Toggle active class to show/hide description
                const wasActive = unit.classList.contains('active');
                // Close others first for a clean experience
                el.querySelectorAll('.rt-unit-pill.active').forEach(u => u.classList.remove('active'));
                if (!wasActive) unit.classList.add('active');
            });
        });

        // Global deselect when clicking anything else
        const deselectHandler = (e) => {
            if (!e.target.closest('.rt-unit-pill')) {
                el.querySelectorAll('.rt-unit-pill.active').forEach(u => u.classList.remove('active'));
            }
        };
        // Use capture phase or just a standard listener on the panel/document
        // Adding it to document is most reliable for "any empty space"
        document.addEventListener('click', deselectHandler);
        // Note: We might want to clean this up later in an unmount/cleanup phase if ST supports it,
        // but for now this is standard ST extension behavior.
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
                // Sanitize coordinates
                const left = Math.max(0, Math.min(window.innerWidth - 50, saved.left));
                const top = Math.max(0, Math.min(window.innerHeight - 50, saved.top));

                panel.style.left = left + 'px'; panel.style.right = 'auto';
                panel.style.top = top + 'px'; panel.style.bottom = 'auto';
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
                    <span>Fatbody D&D Framework</span>
                    <div class="rpg-tracker-status-indicator active" id="rpg-tracker-status"></div>
                    <button class="rpg-tracker-stop-btn" id="rpg-tracker-stop-btn" title="Stop Generation" style="display:none;">■</button>
                </div>
                <div class="rpg-tracker-header-right">
                    <button class="rpg-tracker-icon-btn" id="rpg-tracker-update-btn" title="Update State Now">🔄</button>
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
                <div class="flex-container gap-1 alignitemscenter">
                    <span id="rpg-tracker-count">chars: ${settings.currentMemo.length}</span>
                    <button class="rpg-tracker-nav-btn" id="rpg-tracker-memo-clear" style="padding: 1px 5px; font-size: 9px; opacity: 0.8; margin-left: 5px;" title="Clear memo and history">CLEAR</button>
                    <button class="rpg-tracker-nav-btn" id="rt-copy-sysprompt" style="padding: 1px 5px; font-size: 9px; opacity: 0.8; margin-left: 5px;" title="Copy Narrator System Prompt (sysprompt.txt)">SYSPROMPT</button>
                </div>
            </div>
            <button id="rt-rng-toggle-overlay" class="rt-rng-toggle-overlay" title="Toggle RNG Injection">
                <i class="fa-solid fa-dice"></i> RNG Physics Engine: <span id="rt-rng-status-text">OFF</span>
            </button>
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

        // ── RNG Toggle Logic ──
        const rngBtn = panel.querySelector('#rt-rng-toggle-overlay');
        const syncRngUI = () => {
            const s = getSettings();
            const text = panel.querySelector('#rt-rng-status-text');
            if (text) text.textContent = s.rngEnabled ? 'ON' : 'OFF';
            if (rngBtn) {
                if (s.rngEnabled) rngBtn.classList.add('active');
                else rngBtn.classList.remove('active');
            }
            const settingsCb = document.getElementById('rpg_tracker_rng_enabled');
            if (settingsCb) /** @type {HTMLInputElement} */ (settingsCb).checked = s.rngEnabled;
        };

        if (rngBtn) {
            rngBtn.addEventListener('click', () => {
                const s = getSettings();
                s.rngEnabled = !s.rngEnabled;
                SillyTavern.getContext().saveSettingsDebounced();
                syncRngUI();
                toastr['info'](`RNG Physics Engine ${s.rngEnabled ? 'Enabled' : 'Disabled'}.`, 'Fatbody Framework');
            });
        }
        syncRngUI();

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

        // Manual update from panel button
        const manualUpdate = async (isFullContext = false) => {
            const { chat } = SillyTavern.getContext();
            if (!chat || chat.length === 0) return toastr['info']("No chat history found.", "RPG Tracker");

            let lastAssistantMsg = "";
            for (let i = chat.length - 1; i >= 0; i--) {
                if (!chat[i].is_user && !chat[i].is_system) {
                    lastAssistantMsg = chat[i].mes;
                    break;
                }
            }

            if (!isFullContext && !lastAssistantMsg) return toastr['info']("No assistant message to parse.", "RPG Tracker");

            toastr['info'](isFullContext ? "Triggering Full Context Audit..." : "Triggering manual State Update...", "RPG Tracker");
            await runStateModelPass(lastAssistantMsg, isFullContext);
        };

        const updateBtn = panel.querySelector('#rpg-tracker-update-btn');
        const updateMenu = document.createElement('div');
        updateMenu.className = 'rt-update-menu';
        updateMenu.style.display = 'none';
        updateMenu.innerHTML = `
            <div class="rt-menu-item" id="rt-update-regular"><b>Regular Update</b><small>Parses last message</small></div>
            <div class="rt-menu-item" id="rt-update-full"><b>Full Context Audit</b><small>Re-examines history</small></div>
        `;
        panel.appendChild(updateMenu);

        updateBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const isVisible = updateMenu.style.display !== 'none';

            // Close all other menus possibly
            document.querySelectorAll('.rt-update-menu').forEach(m => m.style.display = 'none');

            if (!isVisible) {
                const rect = updateBtn.getBoundingClientRect();
                const panelRect = panel.getBoundingClientRect();
                updateMenu.style.top = (rect.bottom - panelRect.top + 5) + 'px';
                updateMenu.style.right = (panelRect.right - rect.right) + 'px';
                updateMenu.style.display = 'flex';

                const closeMenu = () => {
                    updateMenu.style.display = 'none';
                    document.removeEventListener('click', closeMenu);
                };
                setTimeout(() => document.addEventListener('click', closeMenu), 10);
            }
        });

        updateMenu.querySelector('#rt-update-regular').addEventListener('click', () => manualUpdate(false));
        updateMenu.querySelector('#rt-update-full').addEventListener('click', () => manualUpdate(true));

        // Link the settings button too if it's already rendered
        // For settings button, we'll keep it simple or just trigger regular
        $('#rpg_tracker_btn_update').off('click').on('click', () => manualUpdate(false));

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
        });

        // Clear memo button
        panel.querySelector('#rpg-tracker-memo-clear').addEventListener('click', () => {
            if (confirm("Are you sure you want to clear the memory history and wipe the tracker?")) {
                settings.currentMemo = "";
                settings.prevMemo1 = "";
                settings.prevMemo2 = "";
                settings.memoHistory = [];
                settings.lastDelta = "";
                _historyViewIndex = -1;
                SillyTavern.getContext().saveSettingsDebounced();
                syncMemoView();
                const dp = document.getElementById('rpg-tracker-delta-content');
                if (dp) dp.innerHTML = '<span class="delta-empty">Log cleared.</span>';
                toastr['success']("RPG Tracker logic wiped.", "RPG Tracker");
            }
        });

        // Copy System Prompt logic
        panel.querySelector('#rt-copy-sysprompt').addEventListener('click', async () => {
            try {
                const response = await fetch(`scripts/extensions/third-party/${FOLDER_NAME}/sysprompt.txt`);
                if (!response.ok) throw new Error('Failed to fetch sysprompt.txt');
                const text = await response.text();

                await navigator.clipboard.writeText(text);
                toastr['success']("System Prompt copied to clipboard!", "Fatbody Framework");
            } catch (err) {
                console.error("[Fatbody Framework] Failed to copy system prompt:", err);
                toastr['error']("Could not find sysprompt.txt. Make sure the extension is installed correctly.", "Fatbody Framework");
            }
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
            const left = startLeft + (e.clientX - startX);
            const top = startTop + (e.clientY - startY);

            // Constrain to viewport (ensure header stays reachable)
            const boundedLeft = Math.max(0, Math.min(window.innerWidth - 100, left));
            const boundedTop = Math.max(0, Math.min(window.innerHeight - 50, top));

            panel.style.left = boundedLeft + 'px';
            panel.style.top = boundedTop + 'px';
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

    function openCustomFieldEditor(index) {
        const s = getSettings();
        const field = s.customFields[index];
        if (!field) return;

        let overlay = document.getElementById('rt_cfe_overlay');
        if (!overlay) {
            overlay = document.createElement('div');
            overlay.id = 'rt_cfe_overlay';
            overlay.style.position = 'fixed';
            overlay.style.top = '0';
            overlay.style.left = '0';
            overlay.style.width = '100vw';
            overlay.style.height = '100vh';
            overlay.style.backgroundColor = 'rgba(0,0,0,0.7)';
            overlay.style.zIndex = '10000000';
            overlay.style.display = 'flex';
            overlay.style.alignItems = 'center';
            overlay.style.justifyContent = 'center';
            overlay.innerHTML = `
                <div class="popup shadowBase" style="min-width: 400px; max-width: 550px;">
                    <div class="popup-header">
                        <h3 class="margin0">Edit Custom Field</h3>
                        <div id="rt_cfe_close" class="popup-close interactable"><i class="fa-solid fa-times"></i></div>
                    </div>
                    <div class="popup-body flex-container flexFlowColumn gap-1" style="padding: 10px;">
                        <div class="flex-container gap-1 alignitemscenter">
                            <input type="text" id="rt_cfe_icon" class="text_pole" style="width: 50px; text-align: center;" title="Icon (Emoji)">
                            <input type="text" id="rt_cfe_tag" class="text_pole" style="width: 140px; font-family: monospace;" placeholder="TAG">
                            <input type="text" id="rt_cfe_label" class="text_pole" style="flex: 1;" placeholder="Label">
                        </div>
                        <label for="rt_cfe_rt">Render Style</label>
                        <select id="rt_cfe_rt" class="text_pole">
                             <option value="CHARACTER">Standard (Key-Value / Lines)</option>
                             <option value="COMBAT">HP Bars</option>
                             <option value="SPELLS">Spell Pips</option>
                             <option value="INVENTORY">Bullet Points</option>
                             <option value="ABILITIES">Oval Pills (Supports tooltips in parentheses)</option>
                        </select>
                        <label for="rt_cfe_prompt">AI Instructions (What should the model track for this field?)</label>
                        <textarea id="rt_cfe_prompt" class="text_pole" rows="4" style="resize: vertical;" placeholder="Describe what information the AI should track and how to format it (e.g. 'Track the current weather and local time.')."></textarea>

                        <div class="flex-container gap-1 justifycontentend" style="margin-top: 10px;">
                            <button id="rt_cfe_delete" class="menu_button interactable" style="color: var(--dangerColor); margin-right: auto;"><i class="fa-solid fa-trash"></i> Delete</button>
                            <button id="rt_cfe_cancel" class="menu_button interactable">Cancel</button>
                            <button id="rt_cfe_save" class="menu_button interactable">Save Changes</button>
                        </div>
                    </div>
                </div>
            `;
            document.body.appendChild(overlay);
        }

        const iconEl = /** @type {HTMLInputElement} */ (document.getElementById('rt_cfe_icon'));
        const tagEl = /** @type {HTMLInputElement} */ (document.getElementById('rt_cfe_tag'));
        const labelEl = /** @type {HTMLInputElement} */ (document.getElementById('rt_cfe_label'));
        const rtEl = /** @type {HTMLSelectElement} */ (document.getElementById('rt_cfe_rt'));
        const promptEl = /** @type {HTMLTextAreaElement} */ (document.getElementById('rt_cfe_prompt'));

        iconEl.value = field.icon;
        tagEl.value = field.tag;
        labelEl.value = field.label;
        rtEl.value = field.renderType;
        promptEl.value = field.prompt;

        overlay.style.display = 'flex';

        const save = () => {
            field.icon = iconEl.value;
            const newTag = tagEl.value.replace(/[^a-zA-Z0-9_]/g, '').toUpperCase();
            if (!newTag) {
                toastr['error']('Tag cannot be empty.', 'RPG Tracker');
                return;
            }

            const isStock = BLOCK_ORDER.includes(newTag);
            if (isStock) {
                toastr['error'](`Tag [${newTag}] is a reserved stock module name.`, 'RPG Tracker');
                return;
            }

            const duplicate = s.customFields.find((f, i) => i !== index && f.tag.toUpperCase() === newTag);
            if (duplicate) {
                toastr['error'](`Tag [${newTag}] is already in use by another custom field.`, 'RPG Tracker');
                return;
            }

            field.tag = newTag;
            field.label = labelEl.value;
            field.renderType = rtEl.value;
            field.prompt = promptEl.value;

            overlay.style.display = 'none';
            cleanup();
            SillyTavern.getContext().saveSettingsDebounced();
            refreshOrderList();
            refreshRenderedView();
        };

        const del = () => {
            const tagToDelete = field.tag.toUpperCase();
            if (confirm(`Delete custom field [${tagToDelete}]? This will also remove its data from the current tracker.`)) {
                // 1. Remove from custom fields array
                s.customFields.splice(index, 1);

                // 2. Remove from block reordering list
                if (s.blockOrder) {
                    s.blockOrder = s.blockOrder.filter(t => t !== tagToDelete);
                }

                // 3. Strip the data block from the current memo
                const memoBlocks = parseMemoBlocks(s.currentMemo || "");
                if (memoBlocks[tagToDelete] !== undefined) {
                    delete memoBlocks[tagToDelete];
                    // Reconstruct memo from remaining blocks
                    s.currentMemo = Object.entries(memoBlocks)
                        .map(([k, v]) => `[${k}]\n${v}\n[/${k}]`)
                        .join('\n\n');

                    // Update UI components
                    updateUIMemo(s.currentMemo);
                }

                overlay.style.display = 'none';
                cleanup();
                SillyTavern.getContext().saveSettingsDebounced();
                refreshOrderList();
                refreshRenderedView();
            }
        };

        const close = () => { overlay.style.display = 'none'; cleanup(); };

        const cleanup = () => {
            document.getElementById('rt_cfe_save').onclick = null;
            document.getElementById('rt_cfe_delete').onclick = null;
            document.getElementById('rt_cfe_cancel').onclick = null;
            document.getElementById('rt_cfe_close').onclick = null;
        };

        document.getElementById('rt_cfe_save').onclick = save;
        document.getElementById('rt_cfe_delete').onclick = del;
        document.getElementById('rt_cfe_cancel').onclick = close;
        document.getElementById('rt_cfe_close').onclick = close;
    }

    function openPromptEditor(title, currentText, defaultText, onSave) {
        let overlay = document.getElementById('rt_pe_overlay');
        if (!overlay) {
            overlay = document.createElement('div');
            overlay.id = 'rt_pe_overlay';
            overlay.style.position = 'fixed';
            overlay.style.top = '0';
            overlay.style.left = '0';
            overlay.style.width = '100vw';
            overlay.style.height = '100vh';
            overlay.style.backgroundColor = 'rgba(0,0,0,0.7)';
            overlay.style.zIndex = '10000000';
            overlay.style.display = 'flex';
            overlay.style.alignItems = 'center';
            overlay.style.justifyContent = 'center';
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

    function refreshOrderList() {
        const s = getSettings();
        const list = document.getElementById('rpg_tracker_order_list');
        if (!list) return;

        list.innerHTML = '';

        const getIcon = (tag) => {
            if (BLOCK_ICONS[tag]) return BLOCK_ICONS[tag];
            const custom = (s.customFields || []).find(f => f.tag.toUpperCase() === tag);
            return custom?.icon || '📄';
        };

        if (!s.blockOrder) s.blockOrder = [...BLOCK_ORDER];

        // --- Sanitization Pass: Ensure unique tags and no stock conflicts ---
        const seenTags = new Set(BLOCK_ORDER);
        (s.customFields || []).forEach(f => {
            let baseTag = f.tag.toUpperCase().replace(/[^A-Z0-9_]/g, '');
            if (!baseTag) baseTag = 'CUSTOM';
            let finalTag = baseTag;
            let counter = 1;
            while (seenTags.has(finalTag)) {
                finalTag = `${baseTag}_${counter++}`;
            }
            if (f.tag !== finalTag) {
                console.log(`[RPG Tracker] Sanitized tag: ${f.tag} -> ${finalTag}`);
                f.tag = finalTag;
            }
            seenTags.add(finalTag);
        });

        // Add any missing tags to blockOrder
        const allCustomTags = (s.customFields || []).map(f => f.tag.toUpperCase());
        [...BLOCK_ORDER, ...allCustomTags].forEach(tag => {
            if (!s.blockOrder.includes(tag)) s.blockOrder.push(tag);
        });

        // Current order, filtered for validity
        const validCustomTags = new Set(allCustomTags);
        const order = s.blockOrder.filter(tag => BLOCK_ORDER.includes(tag) || validCustomTags.has(tag));
        s.blockOrder = order;

        order.forEach((tag, index) => {
            const isStock = BLOCK_ORDER.includes(tag);
            const customIndex = s.customFields.findIndex(f => f.tag.toUpperCase() === tag);
            const field = isStock ? null : s.customFields[customIndex];

            const isEnabled = isStock ? (s.modules[tag.toLowerCase()] ?? false) : (field?.enabled ?? false);

            const item = document.createElement('div');
            item.className = 'flex-container gap-1 alignitemscenter rt-order-item';
            item.style.padding = '5px';
            item.style.background = isEnabled ? 'var(--black30a)' : 'transparent';
            item.style.opacity = isEnabled ? '1' : '0.6';
            item.style.borderRadius = '4px';
            item.style.border = '1px solid var(--smartThemeBorderColor)';

            // 1. Checkbox
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.checked = isEnabled;
            cb.style.margin = '0 5px';
            cb.onchange = () => {
                if (isStock) {
                    s.modules[tag.toLowerCase()] = cb.checked;
                } else {
                    field.enabled = cb.checked;
                }
                SillyTavern.getContext().saveSettingsDebounced();
                refreshOrderList();
                refreshRenderedView();
            };

            // 2. Label
            const label = document.createElement('span');
            label.style.flex = '1';
            label.style.fontSize = '12px';
            label.style.cursor = 'default';
            label.textContent = `${getIcon(tag)} ${tag}`;

            // 3. Button Group
            const btnGroup = document.createElement('div');
            btnGroup.className = 'flex-container gap-1';

            // Edit Button
            const editBtn = document.createElement('button');
            editBtn.className = 'menu_button interactable rt-order-btn';
            editBtn.style.padding = '2px 6px';
            editBtn.title = isStock ? 'Edit Prompt' : 'Edit Custom Field';
            editBtn.innerHTML = '<i class="fa-solid fa-pen-to-square"></i>';
            editBtn.onclick = () => {
                if (isStock) {
                    const mod = tag.toLowerCase();
                    if (!s.stockPrompts) s.stockPrompts = { ...DEFAULT_STOCK_PROMPTS };
                    openPromptEditor(
                        `Edit Default [${tag}] Prompt`,
                        s.stockPrompts[mod],
                        DEFAULT_STOCK_PROMPTS[mod],
                        (newVal) => {
                            s.stockPrompts[mod] = newVal;
                            SillyTavern.getContext().saveSettingsDebounced();
                            toastr['success'](`[${tag}] prompt updated.`, 'RPG Tracker');
                        }
                    );
                } else {
                    openCustomFieldEditor(customIndex);
                }
            };

            // Up/Down Arrows
            const upBtn = document.createElement('button');
            upBtn.className = 'menu_button interactable rt-order-btn';
            upBtn.style.padding = '2px 6px';
            upBtn.innerHTML = '<i class="fa-solid fa-arrow-up"></i>';
            upBtn.disabled = index === 0;
            upBtn.onclick = () => {
                const newOrder = [...order];
                [newOrder[index - 1], newOrder[index]] = [newOrder[index], newOrder[index - 1]];
                s.blockOrder = newOrder;
                SillyTavern.getContext().saveSettingsDebounced();
                refreshOrderList();
                refreshRenderedView();
            };

            const downBtn = document.createElement('button');
            downBtn.className = 'menu_button interactable rt-order-btn';
            downBtn.style.padding = '2px 6px';
            downBtn.innerHTML = '<i class="fa-solid fa-arrow-down"></i>';
            downBtn.disabled = index === order.length - 1;
            downBtn.onclick = () => {
                const newOrder = [...order];
                [newOrder[index + 1], newOrder[index]] = [newOrder[index], newOrder[index + 1]];
                s.blockOrder = newOrder;
                SillyTavern.getContext().saveSettingsDebounced();
                refreshOrderList();
                refreshRenderedView();
            };

            item.appendChild(cb);
            item.appendChild(label);
            btnGroup.appendChild(editBtn);
            btnGroup.appendChild(upBtn);
            btnGroup.appendChild(downBtn);
            item.appendChild(btnGroup);
            list.appendChild(item);
        });
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
            // Use a cache-busting parameter to ensure we get the fresh file from the server
            const html = await renderExtensionTemplateAsync(`third-party/${FOLDER_NAME}`, 'settings', { v: Date.now() });
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

            // Initial order list refresh
            refreshOrderList();

            $('#rpg_tracker_add_custom_field').on('click', function () {
                const settings = getSettings();
                if (!settings.customFields) settings.customFields = [];

                let newTag = 'NEW_FIELD';
                let counter = 1;
                const isTagTaken = (tag) => BLOCK_ORDER.includes(tag) || settings.customFields.some(f => f.tag.toUpperCase() === tag);

                while (isTagTaken(counter === 1 ? newTag : `${newTag}_${counter}`)) {
                    counter++;
                }
                if (counter > 1) newTag = `${newTag}_${counter}`;

                settings.customFields.push({
                    tag: newTag, label: 'New Field', icon: '📝',
                    prompt: 'What should the AI track for this new field? Describe it here.',
                    renderType: 'CHARACTER', enabled: true
                });
                refreshOrderList();
                ctx.saveSettingsDebounced();
            });

            $('#rpg_tracker_core_prompt').val(settings.systemPromptTemplate).on('input', function () {
                settings.systemPromptTemplate = $(this).val();
                ctx.saveSettingsDebounced();
            });

            $('#rpg_tracker_btn_reset_prompt').on('click', function () {
                if (!confirm('Reset the State Model prompt to the built-in default?')) return;
                // Re-read the default from the defaults object by temporarily clearing the stored value
                const { extensionSettings } = SillyTavern.getContext();
                delete extensionSettings[MODULE_NAME].systemPromptTemplate;
                const freshSettings = getSettings(); // re-merges defaults
                $('#rpg_tracker_core_prompt').val(freshSettings.systemPromptTemplate);
                ctx.saveSettingsDebounced();
                toastr['success']('Core prompt reset to default.', 'RPG Tracker');
            });

            $('#rpg_tracker_btn_reset_all_prompts').on('click', function () {
                if (!confirm('This will reset the Core Prompt, Module Prompts, Active Modules, and Module Order to their factory defaults. This cannot be undone. Proceed?')) return;
                const { extensionSettings } = SillyTavern.getContext();
                delete extensionSettings[MODULE_NAME].systemPromptTemplate;
                delete extensionSettings[MODULE_NAME].stockPrompts;
                delete extensionSettings[MODULE_NAME].blockOrder;
                delete extensionSettings[MODULE_NAME].modules;
                const freshSettings = getSettings();
                $('#rpg_tracker_core_prompt').val(freshSettings.systemPromptTemplate);
                refreshOrderList();
                ctx.saveSettingsDebounced();
                toastr['success']('All prompts, modules, and layout order reset to factory defaults.', 'RPG Tracker');
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

            $('#rpg_tracker_btn_factory_reset').on('click', function () {
                if (confirm("⚠️ NUCLEAR OPTION ⚠️\n\nThis will wipe EVERYTHING: all custom fields, character history, saved profiles, and prompt changes. The framework will return to v1.1.0 factory defaults.\n\nProceed?")) {
                    const { extensionSettings } = SillyTavern.getContext();
                    delete extensionSettings[MODULE_NAME];
                    // Force re-initialization of defaults
                    getSettings();
                    ctx.saveSettingsDebounced();
                    toastr['success']("Framework has been reset to factory defaults. Reloading in 2 seconds...", "RPG Tracker");
                    setTimeout(() => location.reload(), 2000);
                }
            });

            // ── Profile System ──
            refreshProfileDropdown();

            $('#rpg_tracker_profile_save').on('click', function () {
                const sel = /** @type {HTMLSelectElement} */ (document.getElementById('rpg_tracker_profile_select'));
                const name = sel.value;
                if (!name) return toastr['info']('No profile selected to overwrite. Use "Save As" for new profiles.', 'RPG Tracker');
                saveProfile(name);
                toastr['success'](`Profile "${name}" overwritten.`, 'RPG Tracker');
            });

            $('#rpg_tracker_profile_save_as').on('click', async function () {
                const sel = /** @type {HTMLSelectElement} */ (document.getElementById('rpg_tracker_profile_select'));
                const existing = sel.value;
                const { Popup } = SillyTavern.getContext();
                
                let name = null;
                if (Popup && Popup.show && Popup.show.input) {
                    name = await Popup.show.input('Save Profile', 'Save profile as:', existing || '');
                } else {
                    name = prompt('Save profile as:', existing || '');
                }
                
                name = name?.trim();
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

            $('#rpg_tracker_profile_delete').on('click', async function () {
                const sel = /** @type {HTMLSelectElement} */ (document.getElementById('rpg_tracker_profile_select'));
                const name = sel.value;
                if (!name) return toastr['info']('No profile selected.', 'RPG Tracker');
                
                const { Popup, POPUP_RESULT } = SillyTavern.getContext();
                if (Popup && Popup.show && Popup.show.confirm) {
                    const confirmResult = await Popup.show.confirm('Delete Profile', `Delete profile "${name}"?`);
                    if (confirmResult !== POPUP_RESULT.AFFIRMATIVE) return;
                } else {
                    if (!confirm(`Delete profile "${name}"?`)) return;
                }
                
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
            <span>Fatbody D&D Framework</span>
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
