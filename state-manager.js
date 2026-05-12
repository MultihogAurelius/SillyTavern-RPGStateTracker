/**
 * state-manager.js — Fatbody D&D Framework
 * Game state schema, defaults, persistence, migration, and profile I/O.
 * Owns the single source of truth for all runtime state (currentMemo, quests,
 * modules, chat-linked snapshots, connection settings, etc.).
 * No DOM. No circular deps.
 *
 * Imports: constants.js
 * Imported by: virtually everything — the root dependency.
 */

import { DEFAULT_STOCK_PROMPTS, BLOCK_ORDER } from './constants.js';

// ── Module name (shared constant, settings key) ────────────────────────────────
export const MODULE_NAME = 'rpg_tracker';

// ── Core settings accessor ─────────────────────────────────────────────────────

/**
 * Returns the live extension settings object, deep-merging defaults for any
 * missing keys. All reads and writes to persistent state go through this.
 * @returns {Record<string, any>}
 */
export function getSettings() {
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
        fontSize: 14,
        rngEnabled: true,
        diceFunctionTool: true,
        barColors: {},
        modulePageSizes: {},
        customTheme: null,
        savedThemes: {},
        systemPromptTemplate:
            `You are the State Extractor Model. Your task is to maintain a structured State Memo based on the roleplay narrative.
<core_directives>
IGNORE NARRATIVE FLUFF: Do not track temporary dialogue or actions. Only track persistent state changes.
INTEGRATION: Track all durations stated by the narrative (e.g. 'poisoned for 3 turns'). Decrement by 1 each round in [COMBAT]. For out-of-combat/time-based durations, calculate the delta between the current [TIME] and the [TIME] in the PRIOR MEMO.
CREATION: You MAY create a section that did not exist in the Prior Memo when the narrative warrants it based on your enabled modules.
DELETION: To REMOVE a section entirely, you MUST output: \`[TAG]REMOVED[/TAG]\`.
</core_directives>

<modules>
You must track the following enabled modules:
{{modulesText}}
</modules>

<rules>
1. Read the PRIOR MEMO and the NARRATIVE OUTPUT carefully.
2. Determine which sections changed. Only output sections that actually changed.
3. Use strict [TAG]...[/TAG] structure based on the modules requested above. ALWAYS include the closing tag.
4. Omit unchanged sections entirely. Do NOT output a section if its contents did not change.
5. BLOCK PERSISTENCE: For list-based sections ([PARTY], [INVENTORY], [ABILITIES], [SPELLS], [COMBAT]), if any single item within that section changes, you MUST re-output the ENTIRE section containing all items. Never omit existing members or items unless they are explicitly logically removed.
6. If there are absolutely NO CHANGES to any section, you MUST output exactly: \`NO_CHANGES_DETECTED\`
7. Output ONLY the changed sections (or NO_CHANGES_DETECTED). No preamble, no explanation, no commentary.
</rules>


<list_formatting>
For sections with multiple items ([ABILITIES], [INVENTORY], [SPELLS], [PARTY]):
1. Use a bulleted list with \`-\`.
2. Format: \`- Name (Resource/Max, Effect Description)\`.
3. If no resource tracker is needed, use: \`- Name (Effect Description)\`.
4. The parentheses MUST contain the resource count FIRST, followed by a comma, then the description.
</list_formatting>

<buff_debuff_logic>
Duration Tracking: Record all durations explicitly. Use turns for combat (e.g., for 3 turns) and H:M for narrative time (e.g., 1h 30m).
Restoration Anchors: When a buff or debuff modifies a base statistic (AC, Attributes, etc.), record the base value directly in the respective field—e.g., 'AC 18 (base 13)'.
Status Formatting: Output the buff/debuff in the Status line with its absolute mathematical effect in parentheses. Example: 'Shield (+5 AC, 1 turn)'.
Auto-Reversion: During each State Sync, check if a duration has expired. If it has, use the modifier in the Status line to reverse the math on the base statistic (e.g., subtracting the +5 AC), restore the field, and remove the buff from the list.
Conditional Buffs: For effects without a set time, use event-based anchors. Example: 'Exhaustion (Disadvantage on Ability Checks, until Long Rest)'.
STATUS LABELING: In [CHARACTER], [PARTY], and [COMBAT] blocks, prefix positive status effects (buffs) with \`(+)\` and negative status effects (debuffs) with \`(-)\`. Every status MUST include its effect AND duration in parentheses. Example: \`Status: (+) Heroism (+2 Temp HP per turn, 9 turns), (-) Poisoned (Disadvantage on attacks, 2 turns)\`. Healthy or no effects needs no prefix.
</buff_debuff_logic>

<progression_logic>
Update abilities/attributes/HP/etc accordingly, such as an ability's 1d6 bonus increasing to 2d6, etc.
</progression_logic>

<custom_formatting>
You may be asked to use Markers: ((PLS)), ((B)), ((XB)), ((BDG)), ((HGT)). These are for graphical rendering options; use them if instructed but only if instructed in a specific [MODULE].
</custom_formatting>`,
        modules: {
            character: true,
            party: true,
            combat: true,
            inventory: true,
            abilities: true,
            spells: true,
            time: true,
            xp: true,
            quests: true,
        },
        stockPrompts: { ...DEFAULT_STOCK_PROMPTS },
        customFields: [],
        profiles: {},
        activeProfile: "",
        fullViewSections: [],
        blockOrder: ['COMBAT', 'CHARACTER', 'PARTY', 'INVENTORY', 'ABILITIES', 'SPELLS', 'XP', 'TIME'],
        legacyDiceNaming: false,
        closeCount: 0,
        lookbackMessages: 2,
        directPromptContext: 5,
        historyIndex: -1,
        ctxWorldInfo: false,
        lorebookFilter: [],
        ollamaUrl: "http://localhost:11434",
        ollamaModel: "",
        openaiUrl: "",
        openaiKey: "",
        openaiModel: "",
        openaiMaxTokens: 0,
        chatLinkEnabled: true,
        chatStates: {},
        quests: [],
        questLegacyMode: false,
        syspromptModules: {
            loot: true,
            random_events: true,
            resting: true,
            quests: true,
            questsDeadlines: false,
            questsFrustration: false,
            questsDifficulty: false
        },
        routerEnabled: false,
        routerLog: [],
        activeRouterKeys: [],
        routerConnectionSource: "default",
        routerOpenaiUrl: "",
        routerOpenaiKey: "",
        routerOpenaiModel: "",
        routerOllamaUrl: "http://localhost:11434",
        routerOllamaModel: "",
        routerConnectionProfileId: "",
        routerCompletionPresetId: "",
        routerMaxTokens: 0,
        routerMaxTurns: 5,
        routerMaxActivations: 5,
        routerCampaignPrefix: "",
        routerLookback: 3,
        routerDirectLookback: 10,
        routerDirectPrompt: "",
        routerBasicMode: false,
        routerModules: {
            npc: { enabled: true, tag: 'NPC', format: 'Name | Description | Keywords', instruction: 'Use for NEW NPCs or updating ACTIVE ones. NEVER create a standalone NPC entry for the player character ({{user}}) — their state is in the State Memo. You may still mention them in EVENT or QUEST entries.' },
            loc: { enabled: true, tag: 'LOC', format: 'Name | Parent Location | Description | Keywords', instruction: 'Use for NEW Locations. ALWAYS specify the Parent Location. Do NOT explicitly activate locations; they trigger via the footer. Record them with keywords matching the footer\'s location fragments (e.g. \'Khelt\', \'Third Tier\'). To update an active location, use the update tool with the ID value from the [ID:] stamp visible at the top of the injected entry — never copy the [ID:] line into your content. Provide only a timestamped delta.' },
            fac: { enabled: true, tag: 'FAC', format: 'Name | Status | Keywords', instruction: 'Track faction reputation and standing.' },
            quest: { enabled: true, tag: 'QUEST', format: 'Name | Location | Description | Keywords', instruction: 'Record quests and where they were received.' },
            event: { enabled: true, tag: 'EVENT', format: 'Name | Details | Keywords', instruction: 'Record significant narrative events. ALWAYS include a timestamp (e.g., [Day 1, 14:00]) in the details so the chronology is preserved.' }
        },
        routerCustomTags: [], 
        routerSystemPromptTemplate: `<basic_instructions>
You are the Researcher Agent, a specialized Dungeon Master's Assistant. Your goal is to maintain the narrative's "Active Context" by managing lorebook entries.

You have the authority to browse the campaign's archive, search for relevant history, and update {{campaignRoot}} to reflect new developments.

When you identify a gap in the active context, use your tools to find the missing information. When new NPCs or locations are introduced, record them immediately.

Your primary focus is narrative consistency and preventing the AI Narrator from forgetting established facts.

Make multiple entries per turn if necessary and relevant.
<memory_limits>
You have a limited budget for "Active Context" (entities in Full Vision). If you exceed this limit, the system will automatically archive the oldest entries.
To maintain control, proactively use [[DEACTIVATE]] on entities that are no longer immediate relevant to the current scene.
</memory_limits>
</basic_instructions>

<formatting>
The main label of a category entry should identify the entity clearly. Examples:

- Main Category: Eldoria_Quests, single entry: QUEST: Clogged Vein. Giver: Overseer Harlen.

- Main Category: Eldoria_NPCs, single entry: NPC: Overseer Harlen, an overseer for the Iron Syndicate
</formatting>

<quests>
When you log a quest, describe the location and the quest giver in a single paragraph, including details about them that will be relevant to location persistence when {{user}} eventually returns to turn in the quest.
</quests>

<updating_entities>
When an entity (location, NPC, etc) changes in a meaningful way, update the associated lorebook entry.
Entries are append-only chronicles. Provide ONLY the new information as a timestamped delta (e.g. "[Day 3, 14:00] The forge was destroyed."). Do NOT rewrite or re-summarize the full entry.
For locations: the [ID:] stamp at the top of every injected entry gives you the ID to pass to the update tool.
IMPORTANT: Never include the [ID:] line in the content field you write. It is managed automatically — only use the ID value in the "id" field of the update tool.
</updating_entities>

<timestamps>
You have access to the CURRENT STATE memo. Always check the [TIME] block to see the current world date/time. 
When recording an EVENT or any time-sensitive entry, include the timestamp at the beginning of the content. 
Example: "DAY 1, 14:30: Character signed the contract with Brodrik."
</timestamps>`,
        categoryRenderOptions: {},
    };

    if (!extensionSettings[MODULE_NAME]) {
        extensionSettings[MODULE_NAME] = {};
    }

    // Deep merge — fills in missing keys without overwriting existing ones
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
    
    // ── MIGRATION: routerModules (v1.8.35+) ───────────────────────────────────
    const s = extensionSettings[MODULE_NAME];
    if (s.routerModules && typeof s.routerModules.npc === 'boolean') {
        const old = s.routerModules;
        s.routerModules = {
            npc: { enabled: !!old.npc, tag: 'NPC', format: 'Name | Description | Keywords', instruction: 'Use for NEW NPCs or updating ACTIVE ones.' },
            loc: { enabled: !!old.loc, tag: 'LOC', format: 'Name | Description | Keywords', instruction: 'Use for NEW Locations or updating ACTIVE ones.' },
            fac: { enabled: !!old.fac, tag: 'FAC', format: 'Name | Status | Keywords', instruction: 'Track faction reputation and standing.' },
            quest: { enabled: !!old.quest, tag: 'QUEST', format: 'Name | Location | Description | Keywords', instruction: 'Record quests and where they were received.' },
            event: { enabled: !!old.event, tag: 'EVENT', format: 'Name | Details | Keywords', instruction: 'Record significant narrative events.' }
        };
    }

    return extensionSettings[MODULE_NAME];
}

// ── Bar color resolver ─────────────────────────────────────────────────────────

/**
 * Returns the CSS background string for a bar element, respecting any
 * user-configured color overrides stored in settings.barColors.
 * @param {string} barId
 * @param {string} defaultBackground
 * @param {number|null} pct
 */
export function getBarBackground(barId, defaultBackground, pct = null) {
    if (!barId) return defaultBackground;
    const s = getSettings();
    const cfg = s.barColors?.[barId];
    if (!cfg) {
        const isHP = barId.endsWith(':HP') || barId.includes(':HPBAR');
        if (isHP && pct !== null) {
            return pct > 60 ? '#00ffaa' : pct > 30 ? '#ffaa00' : '#ff5555';
        }
        return defaultBackground;
    }

    if (typeof cfg === 'string') return cfg; // Legacy support

    switch (cfg.mode) {
        case 'gradient':
            return `linear-gradient(90deg, ${cfg.color}, ${cfg.color2 || cfg.color})`;
        case 'dynamic': {
            const p = pct !== null ? pct : 100;
            return p > 60 ? '#00ffaa' : p > 30 ? '#ffaa00' : '#ff5555';
        }
        case 'solid':
        default:
            return cfg.color;
    }
}

// ── One-time data migrations ───────────────────────────────────────────────────

/**
 * Migrates custom fields from legacy formats to the current template-based format.
 * Safe to call repeatedly — idempotent.
 */
export function migrateCustomFields() {
    const s = getSettings();
    (s.customFields || []).forEach(field => {
        // Migration 1: Convert single renderType to empty rows (old)
        if (field.renderType !== undefined && !field.rows && !field.template) {
            field.rows = [];
            delete field.renderType;
        }
        // Migration 2: Convert rows to template (New)
        if (field.rows && !field.template) {
            const UI_TO_MARKER = {
                'pills': 'PILLS', 'badge': 'BADGE', 'highlight': 'HIGHLIGHT',
                'hp_bar': 'BAR', 'xp_bar': 'XPBAR', 'text': 'TEXT', 'kv': 'TEXT'
            };
            field.template = field.rows.map(row => {
                const marker = UI_TO_MARKER[row.renderType] || 'TEXT';
                const content = row.label || '';
                return `((${marker})) ${content}`;
            }).join('\n').trim();
            delete field.rows;
            delete field.renderType;
        }
    });
}

// ── Chat-linked state persistence ─────────────────────────────────────────────

/**
 * Snapshots the current live settings into chatStates[chatId].
 * Pure write — no shared mutable state, no DOM.
 * @param {string} chatId
 */
export function saveChatState(chatId) {
    if (!chatId) return;
    const s = getSettings();
    if (!s.chatStates) s.chatStates = {};
    s.chatStates[chatId] = {
        currentMemo:  s.currentMemo,
        memoHistory:  JSON.parse(JSON.stringify(s.memoHistory)),
        lastDelta:    s.lastDelta || '',
        modules:      JSON.parse(JSON.stringify(s.modules)),
        blockOrder:   JSON.parse(JSON.stringify(s.blockOrder  || BLOCK_ORDER)),
        stockPrompts: JSON.parse(JSON.stringify(s.stockPrompts || DEFAULT_STOCK_PROMPTS)),
        customFields: JSON.parse(JSON.stringify(s.customFields || [])),
        quests:       [],  // quests are derived from currentMemo on load — not persisted separately
        historyIndex: s.historyIndex ?? -1,
        activeRouterKeys: JSON.parse(JSON.stringify(s.activeRouterKeys || [])),
        routerLog:    JSON.parse(JSON.stringify(s.routerLog || [])),
        routerCampaignPrefix: s.routerCampaignPrefix || '',
        routerLookback: s.routerLookback || 3,
        routerDirectPrompt: s.routerDirectPrompt || '',
    };
    SillyTavern.getContext().saveSettingsDebounced();
}

// ── Profile I/O ───────────────────────────────────────────────────────────────

/**
 * Saves the current tracker state into a named profile slot.
 * @param {string} name
 */
export function saveProfile(name) {
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
        // quests are derived from currentMemo on load — not persisted separately
        lastDelta: s.lastDelta || '',
        historyIndex: s.historyIndex ?? -1,
        activeRouterKeys: JSON.parse(JSON.stringify(s.activeRouterKeys || [])),
        routerLog:    JSON.parse(JSON.stringify(s.routerLog || [])),
        routerCampaignPrefix: s.routerCampaignPrefix || '',
        routerLookback: s.routerLookback || 3,
        routerDirectPrompt: s.routerDirectPrompt || '',
    };
    s.activeProfile = name;
    SillyTavern.getContext().saveSettingsDebounced();
}

/**
 * Deletes a named profile slot.
 * @param {string} name
 */
export function deleteProfile(name) {
    const s = getSettings();
    if (!s.profiles?.[name]) return;
    delete s.profiles[name];
    if (s.activeProfile === name) s.activeProfile = '';
    SillyTavern.getContext().saveSettingsDebounced();
}
