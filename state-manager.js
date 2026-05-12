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

// ── Default module definitions (single source of truth for reset logic) ─────────
export const DEFAULT_MODULES = {
    npc:   { enabled: true, tag: 'NPC',   format: 'Name | Description | Keywords',                    instruction: 'Named characters. Do NOT create an entry for {{user}} — their state lives in the State Memo. Mention {{user}} in EVENT or QUEST entries as needed.' },
    loc:   { enabled: true, tag: 'LOC',   format: 'Name | Description | Keywords',                    instruction: 'Named places. The Name MUST be the full hierarchical path using " :: " as the separator (e.g. "Khelt :: Rust-Lantern District :: Marrow-Deep Mines Office"). Include each ancestor name as a keyword (e.g. "Khelt, Rust-Lantern District, mines").' },
    fac:   { enabled: true, tag: 'FAC',   format: 'Name | Description | Keywords',                    instruction: 'Named factions, guilds, organisations. Focus on the faction\'s unfolding narrative — what they are doing, what has changed, what schemes or conflicts are active. Record player standing and notable members as secondary context.' },
    quest: { enabled: true, tag: 'QUEST', format: 'Name | Location | Description | Keywords',         instruction: 'ONLY record a quest when the player explicitly accepts it. A quest being mentioned or offered is NOT enough.' },
    event: { enabled: true, tag: 'EVENT', format: 'Name | Details | Keywords',                        instruction: 'Significant narrative events. The Name is a SHORT, STABLE identifier (e.g. "Siege of Ashford") — no timestamps in the name, no "Final"/"Update" suffixes. Put timestamps in the Details field. Reuse the exact same Name when adding new information — entries are chronicles that accumulate automatically.' }
};

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
        agentFontSize: 13,
        customSysprompt: false,
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
        routerPaused: false,
        routerRunEvery: 1,
        routerIncludeHidden: false,
        routerAutoActivateBooks: false,
        routerPromptForPrefix: false,
        routerModules: JSON.parse(JSON.stringify(DEFAULT_MODULES)),
        routerCustomTags: [], 
        routerHistory: [],
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
When recording a new entry, keep the lorebook category separate from the entity label.

- Use the "category" field for the type (NPC, LOC, FAC, QUEST, EVENT, or a custom tag).
- Use the "label" field for the entity name only. Do NOT prefix labels with the category tag.

Correct examples:
- {"label": "Iron Syndicate", "category": "FAC"}
- {"label": "Thalric Thorne", "category": "STATS"}

Incorrect examples:
- {"label": "FAC: Iron Syndicate", "category": "FAC"}
- {"label": "STATS: Thalric Thorne", "category": "STATS"}
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
The current world date/time is visible in the ## NARRATIVE section — look for the status footer in recent messages (e.g. "11:52 AM, Day 1").
When recording an EVENT or any time-sensitive entry, include the timestamp at the beginning of the content.
Example: "[Day 1, 11:52] Character signed the contract with Brodrik."
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
            npc: { enabled: !!old.npc, tag: 'NPC', format: 'Name | Description | Keywords', instruction: 'Named characters. Do NOT create an entry for {{user}} — their state lives in the State Memo.' },
            loc: { enabled: !!old.loc, tag: 'LOC', format: 'Name | Description | Keywords', instruction: 'Named places. Name MUST be the full hierarchical path using " :: " as the separator (e.g. "Khelt :: Rust-Lantern District :: Marrow-Deep Mines Office"). Include each ancestor as a keyword.' },
            fac: { enabled: !!old.fac, tag: 'FAC', format: 'Name | Description | Keywords', instruction: 'Named factions, guilds, organisations. Focus on the faction\'s unfolding narrative — what they are doing, what has changed, what schemes or conflicts are active.' },
            quest: { enabled: !!old.quest, tag: 'QUEST', format: 'Name | Location | Description | Keywords', instruction: 'ONLY record a quest when the player explicitly accepts it. A quest being mentioned or offered is NOT enough.' },
            event: { enabled: !!old.event, tag: 'EVENT', format: 'Name | Details | Keywords', instruction: 'Significant narrative events. Use a SHORT, STABLE Name — no timestamps in the name. Reuse the exact same Name when adding new information.' }
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

    // Strip placeholder NEW_TAG entries persisted from previous sessions (one-time cleanup at init)
    if (Array.isArray(s.routerCustomTags)) {
        s.routerCustomTags = s.routerCustomTags.filter(t => t.tag && t.tag !== 'NEW_TAG');
    }

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
    // Preserve fields that are written outside the normal save cycle (e.g. campaignBooks)
    const existing = s.chatStates[chatId] || {};
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
        // Preserve lorebook stack link — written by Link button and router, not by normal state saves
        campaignBooks: existing.campaignBooks || [],
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
