/**
 * quests.js — Fatbody D&D Framework
 * Quest management, deadline tracking, and tool registration.
 */

import { getSettings } from './state-manager.js';
import { parseQuestsFromMemo, writeQuestsToMemo, parseInWorldTime } from './memo-processor.js';

export function getQuestToolName() {
    return 'LogQuest';
}

// ── Time & Math ──────────────────────────────────────────────────────────────

// ── Time & Math ──────────────────────────────────────────────────────────────

// parseInWorldTime moved to memo-processor.js

/**
 * Computes NPC mood from -1.0 (very pleased) to 1.0+ (very frustrated).
 * Formula: (elapsed/window)^(1/coeff) * 2 - 1
 *
 * At t=0 (quest accepted): always -1  (NPC is pleased you took it)
 * At t=deadline: always 0 (Neutral)
 * Beyond deadline: >0, unbounded (NPC grows increasingly angry)
 *
 * Low coeff (0.4, patient): stays pleased longer, gets mad slowly after deadline.
 * High coeff (3.0, volatile): becomes neutral faster, gets mad quickly after deadline.
 *
 * @param {object} quest
 * @param {string} currentTime
 * @returns {number} Mood value from -1 (pleased) upward (unbounded)
 */
export function computeFrustration(quest, currentTime) {
    if (quest.status !== 'active') return 0;
    const accepted = parseInWorldTime(quest.accepted_time);
    const current  = parseInWorldTime(currentTime);
    if (!accepted || !current) return 0;

    const elapsed = current - accepted;
    if (elapsed <= 0) return -1; // Just accepted — NPC is optimistic

    const coeff = Math.max(0.1, quest.frustration_coefficient ?? 1.0);

    if (!quest.deadline_time || String(quest.deadline_time).toLowerCase() === 'none') {
        // No deadline: NPC remains neutral regardless of time elapsed
        return 0;
    }

    const deadline = parseInWorldTime(quest.deadline_time);
    const window   = deadline - accepted;
    if (window <= 0) return 1;

    const ratio = elapsed / window;
    
    if (ratio <= 1.0) {
        // Before or at deadline: -1 (Very Pleased) to 0 (Neutral)
        return Math.pow(ratio, 1 / coeff) - 1;
    } else {
        // After deadline: 0 (Neutral) scaling upwards
        return (ratio - 1) * coeff;
    }
}

/**
 * Returns the human-readable mood label and associated color for a quest,
 * based on the calculated frustration value and active settings.
 * @param {object} quest 
 * @param {string} currentTime 
 * @param {boolean} showFrustration 
 * @returns {{ label: string, color: string }}
 */
export function getQuestMood(quest, currentTime, showFrustration) {
    const frust = computeFrustration(quest, currentTime);
    
    let color = '#00cc77';
    let label = 'Pleased';
    
    if (showFrustration) {
        if (frust <= -0.5)      { color = '#00cc77'; label = 'Very Pleased'; }
        else if (frust <= -0.1) { color = '#44dd88'; label = 'Pleased'; }
        else if (frust <=  0.1) { color = '#aaaaaa'; label = 'Neutral'; }
        else if (frust <=  0.5) { color = '#ffcc00'; label = 'Mildly Frustrated'; }
        else if (frust <=  1.0) { color = '#ff8800'; label = 'Frustrated'; }
        else if (frust <=  1.5) { color = '#ff4400'; label = 'Very Frustrated'; }
        else                    { color = '#ff1111'; label = 'Furious'; }
    } else {
        // Deadline-only color scheme
        if (frust <= 0)         { color = '#00cc77'; label = 'Ahead of Schedule'; }
        else if (frust <= 0.5)  { color = '#ffcc00'; label = 'On Time'; }
        else if (frust <= 1.0)  { color = '#ff8800'; label = 'Near Deadline'; }
        else                    { color = '#ff1111'; label = 'Overdue'; }
    }
    
    return { label, color, value: frust };
}

// ── State Management ─────────────────────────────────────────────────────────

/**
 * Iterates active quests, auto-failing any that have passed their deadline.
 * Call this BEFORE the state model runs.
 */
export function checkQuestDeadlines() {
    const settings = getSettings();
    const quests = parseQuestsFromMemo(settings.currentMemo);
    if (!quests.length) return;
    
    let changed = false;
    const currentTimeMinutes = parseInWorldTime(settings.currentMemo?.match(/\[TIME\]([\s\S]*?)\[\/TIME\]/i)?.[1]?.trim());
    
    for (const quest of quests) {
        if (quest.status === 'active' && quest.deadline_time) {
            const deadlineMinutes = parseInWorldTime(quest.deadline_time);
            if (currentTimeMinutes >= deadlineMinutes && deadlineMinutes > 0) {
                if (quest.auto_fail) {
                    quest.status = 'failed';
                    changed = true;
                    if (settings.debugMode) {
                        console.log(`[RPG Tracker] Quest "${quest.title}" auto-failed (deadline reached).`);
                    }
                }
            }
        }
    }
    
    if (changed) {
        writeQuestsToMemo(quests);
        SillyTavern.getContext().saveSettingsDebounced();
    }
}

/**
 * Generates the plain-text block injected into the narrative model context.
 * Only includes active quests.
 */
export function renderQuestsAsPlainText(quests, currentTime) {
    if (!quests || !quests.length) return "";
    
    const activeQuests = quests.filter(q => q.status === 'active');
    if (activeQuests.length === 0) return "";
    
    let text = "### ACTIVE QUESTS\n";
    for (const q of activeQuests) {
        text += `- **${q.title}** (Given by ${q.giver_name} at ${q.giver_location})\n`;
        const settings = getSettings();
        if (q.deadline_time && settings.isDeadlines) {
            let moodInfo = '';
            if (settings.isFrustration) {
                const frust = computeFrustration(q, currentTime);
                let moodLabel;
                if (frust <= -0.5)       moodLabel = 'Very Pleased — NPC is optimistic you will make it';
                else if (frust <= -0.1)  moodLabel = 'Pleased — on schedule';
                else if (frust <=  0.1)  moodLabel = 'Neutral — at deadline';
                else if (frust <=  0.5)  moodLabel = 'Mildly Frustrated — deadline missed';
                else if (frust <=  1.0)  moodLabel = 'Frustrated — deadline missed';
                else if (frust <=  1.5)  moodLabel = 'Very Frustrated — deadline passed long ago';
                else                      moodLabel = 'Furious — NPC may withdraw the quest entirely';
                moodInfo = ` (NPC Mood: ${moodLabel})`;
            }
            text += `  Deadline: ${q.deadline_time}${moodInfo}\n`;
        }
        for (const obj of q.objectives) {
            if (obj.status !== 'completed') {
                text += `  - [ ] ${obj.text}${obj.required ? '' : ' (Optional)'}\n`;
            } else {
                text += `  - [x] ${obj.text}${obj.required ? '' : ' (Optional)'}\n`;
            }
        }
        if (q.rewards && q.rewards.length) {
            text += `  Rewards: ${q.rewards.join(', ')}\n`;
        }
    }
    return text + "\n";
}

// ── Lorebook Injection ───────────────────────────────────────────────────────

/**
 * Writes a canonical lorebook entry anchoring the quest location.
 */
export async function buildQuestLorebookEntry(quest) {
    const stCtx = SillyTavern.getContext();
    if (!stCtx.createWorldInfoEntry) return; // Fallback if API missing

    const entryContent = `Quest Origin — ${quest.title}\nThe quest "${quest.title}" was given by ${quest.giver_name} at ${quest.giver_location}. This location is canonical and must not change.`;
    
    const titleWords = quest.title.split(/\s+/).slice(0, 3).join(' ');
    const keys = [quest.id, quest.giver_name, titleWords].filter(Boolean);

    try {
        // Attempt to create a new entry in a dedicated "RPG Tracker Quests" book, or the default.
        // The specific API call depends on SillyTavern's world info manager structure.
        // Often it's passed as an object to a world info creation function.
        // Assuming createWorldInfoEntry(bookName, entryData) or similar exists, or we write to a default.
        // We will just do a standard toast/log for now as the exact WI API needs verifying,
        // but this is the hook point.
        console.log(`[RPG Tracker] Quest Lorebook Entry generated:\nKeys: ${keys.join(',')}\n${entryContent}`);
        // If there's a specific ST API to push WI entries programmatically:
        // stCtx.createWorldInfoEntry({ keys, content: entryContent, name: `Quest: ${quest.title}` });
    } catch (e) {
        console.error('[RPG Tracker] Failed to write lorebook entry:', e);
    }
}

// ── Tool Registration ────────────────────────────────────────────────────────

export function registerLogQuestTool() {
    try {
        const s = getSettings();
        const { registerFunctionTool, unregisterFunctionTool } = SillyTavern.getContext();
        
        // Unregister first (idempotent)
        unregisterFunctionTool('LogQuest');

        // In legacy mode or if quests are disabled in Narrator Config, no tool needed
        if (s.questLegacyMode || s.syspromptModules?.quests === false) return;

        const isDeadlines = !!s.syspromptModules?.questsDeadlines;
        const isFrustration = !!s.syspromptModules?.questsFrustration;


        // ── Build a dynamic tool description based on enabled features ──────────
        let toolDescription =
            'Log a new quest when the player formally accepts it from an NPC. ' +
            'Call this ONCE per accepted quest. Do NOT call it for rumors, casual mentions, or unaccepted tasks. ' +
            'Populate all fields from what was already established in the narrative.';

        if (isDeadlines) {
            toolDescription +=
                ' If the quest is time-sensitive, you MUST calculate and supply deadline_time in the format "HH:MM AM/PM, Day N". ' +
                (isFrustration
                    ? 'The NPC Mood evolves continuously based on frustration_coefficient. ' +
                      'Reserve status "failed" ONLY for quests that are logically impossible to complete or explicitly called off by the NPC.'
                    : 'The quest will automatically fail if the current time passes the deadline. ' +
                      'However, YOU MUST still mark the status as "failed" if the quest becomes narratively impossible (e.g. a target dies).');
        }

        if (isFrustration) {
            toolDescription +=
                ' The NPC Mood evolves continuously based on frustration_coefficient. ' +
                'Let this affect how the NPC speaks and acts whenever the player encounters them throughout the campaign.';
        }

        // ── Build per-parameter descriptions ─────────────────────────────────
        const properties = {
            title: {
                type: 'string',
                description: 'Clear, thematic name of the quest as established in the narrative.'
            },
            giver_name: {
                type: 'string',
                description: 'Full name of the NPC who issued the quest.'
            },
            giver_location: {
                type: 'string',
                description: 'Where this NPC can be found (e.g. "Crestwood Mill", "The Rusty Flagon Inn").'
            },
            objectives: {
                type: 'array',
                description: 'Break the task into specific, concrete objectives. Include all sub-tasks mentioned by the NPC.',
                items: {
                    type: 'object',
                    properties: {
                        text: {
                            type: 'string',
                            description: 'A single, specific goal (e.g. "Kill the wolves in the eastern forest").'
                        },
                        required: {
                            type: 'boolean',
                            description: 'True if this objective is required for quest completion; false if it is optional.'
                        },
                        total: {
                            type: 'number',
                            description: 'For collection/count objectives, the total amount required (e.g. 6 for "collect 6 mushrooms"). Omit if not a quantity objective.'
                        },
                    },
                    required: ['text', 'required'],
                },
            },
            rewards: {
                type: 'array',
                description: 'All rewards promised by the NPC. One entry per reward (e.g. "100 GP", "Elara\'s family heirloom").',
                items: { type: 'string' },
            },
        };

        const required = ['title', 'giver_name', 'giver_location', 'objectives'];

        if (isDeadlines) {
            properties.deadline_time = {
                type: 'string',
                description:
                    'The exact in-world timestamp when the quest must be completed (e.g. "06:00 PM, Day 4"). ' +
                    'If the narrative specifies a duration (e.g., "four days"), you MUST calculate the absolute Day N timestamp based on the current time. ' +
                    'Omit only if the quest has no time pressure whatsoever.'
            };
            // Removed auto_fail property - now deterministic based on isFrustration toggle
        }

        if (isFrustration) {
            properties.frustration_coefficient = {
                type: 'number',
                description:
                    'How quickly this NPC\'s mood deteriorates as time passes. Scale: 0.4–3.0.\n' +
                    '· 0.4 = Very patient. NPC stays pleased longer, and gets mad slowly if you miss the deadline.\n' +
                    '· 1.0 = Normal. NPC is neutral exactly at the deadline, and frustrated if you miss it.\n' +
                    '· 3.0 = Volatile. NPC becomes neutral quickly, and gets mad rapidly if you miss the deadline.\n' +
                    'Assign based on the NPC\'s established personality in the narrative. Default: 1.0.'
            };
        }

        unregisterFunctionTool('LogQuest');
        registerFunctionTool({
            name: 'LogQuest',
            displayName: 'LogQuest',
            description: toolDescription,
            parameters: {
                type: 'object',
                properties: properties,
                required: required,
            },
            action: async (args) => {
                const s = getSettings();

                // Extract T-1 time from the memo
                const tMatch = s.currentMemo?.match(/\[TIME\]([\s\S]*?)\[\/TIME\]/i);
                let acceptedTime = "08:00 AM, Day 1"; // Fallback
                if (tMatch) {
                    const timeLines = tMatch[1].split('\n').filter(Boolean);
                    if (timeLines.length > 0 && timeLines[0].includes('Day')) {
                        acceptedTime = timeLines[0].trim();
                    }
                }

                const newQuest = {
                    id: `quest_${Date.now()}`,
                    title: args.title || 'Unknown Quest',
                    giver_name: args.giver_name || 'Unknown',
                    giver_location: args.giver_location || 'Unknown Location',
                    objectives: (args.objectives || []).map((o, idx) => ({
                        id: `obj_${idx}`,
                        text: o.text || '',
                        required: o.required !== false,
                        status: 'active'
                    })),
                    rewards: args.rewards || [],
                    deadline_time: isDeadlines ? (args.deadline_time || null) : undefined,
                    frustration_coefficient: isFrustration ? (args.frustration_coefficient || 1.0) : undefined,
                    auto_fail: (isDeadlines && !isFrustration),
                    accepted_time: acceptedTime,
                    status: 'active'
                };

                // Stage the quest — do NOT write to currentMemo yet.
                // The state model pass will flush pending quests into the merged
                // output AFTER snapshotting, so rollback remains clean.
                if (!globalThis._rpgPendingQuests) globalThis._rpgPendingQuests = [];
                globalThis._rpgPendingQuests.push(newQuest);

                await buildQuestLorebookEntry(newQuest);

                return `Quest "${newQuest.title}" successfully logged.`;
            },
            formatMessage: () => '',
        });
    } catch (error) {
        console.error('[RPG Tracker] Error registering LogQuest function tool', error);
    }
}

// ── Debug / Test Tool ────────────────────────────────────────────────────────

/**
 * Exposes a global debugging tool in the console.
 * Usage in console: rpgTracker.debugQuests()
 */
export function installQuestDebugTools() {
    globalThis.rpgTracker = globalThis.rpgTracker || {};
    globalThis.rpgTracker.debugQuests = () => {
        console.log("=== Quest System Debug ===");
        const s = getSettings();
        console.log("Active Quests in Settings:", s.quests);
        
        console.log("--- Testing Time Parser ---");
        const t1 = "08:00 AM, Day 1";
        const t2 = "12:00 PM, Day 1";
        const t3 = "06:30 PM, Day 3";
        console.log(`"${t1}" -> ${parseInWorldTime(t1)} mins`);
        console.log(`"${t2}" -> ${parseInWorldTime(t2)} mins`);
        console.log(`"${t3}" -> ${parseInWorldTime(t3)} mins`);

        console.log("--- Testing Frustration Math (Pre-Deadline: Halfway) ---");
        const dummyQuest = {
            status: 'active',
            accepted_time: "08:00 AM, Day 1",
            deadline_time: "08:00 AM, Day 3", // 2 days = 2880 mins window
            frustration_coefficient: 1.0
        };
        const halfwayTime = "08:00 AM, Day 2";
        
        dummyQuest.frustration_coefficient = 0.4;
        console.log(`Coeff 0.4 (Patient), Halfway -> ${computeFrustration(dummyQuest, halfwayTime).toFixed(3)} (expected -0.823)`);
        
        dummyQuest.frustration_coefficient = 1.0;
        console.log(`Coeff 1.0 (Neutral), Halfway -> ${computeFrustration(dummyQuest, halfwayTime).toFixed(3)} (expected -0.500)`);
        
        dummyQuest.frustration_coefficient = 3.0;
        console.log(`Coeff 3.0 (Volatile), Halfway -> ${computeFrustration(dummyQuest, halfwayTime).toFixed(3)} (expected -0.206)`);

        console.log("--- Testing Frustration Math (At Deadline) ---");
        const atDeadline = "08:00 AM, Day 3";
        dummyQuest.frustration_coefficient = 1.0;
        console.log(`Coeff 1.0, At Deadline -> ${computeFrustration(dummyQuest, atDeadline).toFixed(3)} (expected 0.000)`);

        console.log("--- Testing Frustration Math (Post-Deadline: 50% Overtime) ---");
        const overtimeTime = "08:00 AM, Day 4"; // ratio = 1.5
        dummyQuest.frustration_coefficient = 0.4;
        console.log(`Coeff 0.4 (Patient), 50% Over -> ${computeFrustration(dummyQuest, overtimeTime).toFixed(3)} (expected 0.200)`);

        dummyQuest.frustration_coefficient = 1.0;
        console.log(`Coeff 1.0 (Neutral), 50% Over -> ${computeFrustration(dummyQuest, overtimeTime).toFixed(3)} (expected 0.500)`);

        dummyQuest.frustration_coefficient = 3.0;
        console.log(`Coeff 3.0 (Volatile), 50% Over -> ${computeFrustration(dummyQuest, overtimeTime).toFixed(3)} (expected 1.500)`);
        
        console.log("==========================");
    };
}
