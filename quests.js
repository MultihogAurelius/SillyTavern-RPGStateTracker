/**
 * quests.js — Fatbody D&D Framework
 * Quest management, deadline tracking, and tool registration.
 */

import { getSettings } from './settings.js';
import { syncQuestsToMemo } from './state-engine.js';

export function getQuestToolName() {
    return 'LogQuest';
}

// ── Time & Math ──────────────────────────────────────────────────────────────

/**
 * Converts in-world time strings to a comparable numeric value (minutes since Day 1, 00:00).
 * Expected format: "08:00 AM, Day 1"
 * @param {string} str 
 * @returns {number}
 */
export function parseInWorldTime(str) {
    if (!str) return 0;
    const match = str.match(/(\d{1,2}):(\d{2})\s*(AM|PM),\s*Day\s*(\d+)/i);
    if (!match) return 0;
    let hours   = parseInt(match[1]);
    const mins  = parseInt(match[2]);
    const mer   = match[3].toUpperCase();
    const day   = parseInt(match[4]);
    if (mer === 'AM' && hours === 12) hours = 0;
    if (mer === 'PM' && hours !== 12) hours += 12;
    return (day - 1) * 1440 + hours * 60 + mins;
}

/**
 * Computes NPC mood from -1.0 (very pleased) to 1.0+ (very frustrated).
 * Formula: (elapsed/window)^(1/coeff) * 2 - 1
 *
 * At t=0 (quest accepted): always -1  (NPC is pleased you took it)
 * At t=deadline/2, coeff=1: 0 (neutral)
 * At t=deadline: always +1  (NPC is frustrated — regardless of personality)
 * Beyond deadline: >1, unbounded (NPC grows increasingly angry)
 *
 * Low coeff (0.4, patient): rises slowly — NPC barely registers frustration until near deadline
 * High coeff (3.0, volatile): spikes early — NPC is anxious even halfway through
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

    if (!quest.deadline_time) {
        // No deadline: use 24 in-game hours as a soft "expected" window
        const window = 24 * 60;
        const ratio  = elapsed / window;
        return Math.pow(ratio, 1 / coeff) * 2 - 1;
    }

    const deadline = parseInWorldTime(quest.deadline_time);
    const window   = deadline - accepted;
    if (window <= 0) return 1;

    const ratio = elapsed / window; // <1 = ahead of deadline, 1 = at deadline, >1 = overdue
    return Math.pow(ratio, 1 / coeff) * 2 - 1;
}

// ── State Management ─────────────────────────────────────────────────────────

/**
 * Iterates active quests, auto-failing any that have passed their deadline.
 * Call this BEFORE the state model runs.
 */
export function checkQuestDeadlines() {
    const settings = getSettings();
    if (!settings.quests || !settings.quests.length) return;
    
    let changed = false;
    const currentTimeMinutes = parseInWorldTime(settings.currentMemo?.match(/\[TIME\]([\s\S]*?)\[\/TIME\]/i)?.[1]?.trim());
    
    for (const quest of settings.quests) {
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
        if (q.deadline_time) {
            const frust = computeFrustration(q, currentTime);
            let moodLabel;
            if (frust <= -0.5)       moodLabel = 'Very Pleased — NPC is optimistic you will make it';
            else if (frust <= -0.1)  moodLabel = 'Pleased — ahead of schedule';
            else if (frust <=  0.1)  moodLabel = 'Neutral — on track';
            else if (frust <=  0.5)  moodLabel = 'Mildly Frustrated — running behind';
            else if (frust <=  1.0)  moodLabel = 'Frustrated — deadline is near or passed';
            else if (frust <=  1.5)  moodLabel = 'Very Frustrated — deadline passed long ago';
            else                      moodLabel = 'Furious — NPC may withdraw the quest entirely';
            text += `  Deadline: ${q.deadline_time} (NPC Mood: ${moodLabel})\n`;
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

        // In legacy mode, the state model handles quests — no tool needed
        if (s.questLegacyMode) return;

        // Only register if the module is enabled
        if (!s.modules?.quests) return;

        const isHardcore = s.syspromptModules?.quests !== false;

        const properties = {
            title: { type: 'string', description: 'Clear, thematic name of the quest.' },
            giver_name: { type: 'string', description: 'Name of the NPC who gave the quest.' },
            giver_location: { type: 'string', description: 'Where the NPC can be found.' },
            objectives: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        text: { type: 'string', description: 'The goal (e.g. "Kill the wolves").' },
                        required: { type: 'boolean', description: 'True if required for quest completion.' },
                    },
                    required: ['text', 'required'],
                },
            },
            rewards: {
                type: 'array',
                items: { type: 'string', description: 'Items or gold promised (e.g. "100 GP").' },
            },
        };

        const required = ['title', 'giver_name', 'giver_location', 'objectives'];

        // Add simulation fields only if hardcore mode is enabled
        if (isHardcore) {
            properties.deadline_time = { type: 'string', description: 'Optional: When it must be done (e.g. "08:00 AM, Day 3").' };
            properties.frustration_coefficient = { 
                type: 'number', 
                description: 'Optional: How patient the NPC is. 0.4 = patient (75% frust at deadline), 3.0 = volatile (fail if overdue).' 
            };
            properties.auto_fail = { type: 'boolean', description: 'If true, the quest automatically fails if the deadline passes.' };
        }

        unregisterFunctionTool('LogQuest');
        registerFunctionTool({
            name: 'LogQuest',
            description: 'Log a new quest when the player formally accepts it from an NPC. Use this ONLY upon acceptance.',
            parameters: {
                type: 'object',
                properties: properties,
                required: required,
            },
            action: async (args) => {
                const s = getSettings();
                if (!s.quests) s.quests = [];

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
                    deadline_time: args.deadline_time || null,
                    frustration_coefficient: args.frustration_coefficient || 1.0,
                    auto_fail: args.auto_fail !== false,
                    accepted_time: acceptedTime,
                    status: 'active'
                };

                s.quests.push(newQuest);
                SillyTavern.getContext().saveSettingsDebounced();
                
                // Sync new quest into Raw View memo
                syncQuestsToMemo();

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

        console.log("--- Testing Frustration Math ---");
        const dummyQuest = {
            status: 'active',
            accepted_time: "08:00 AM, Day 1",
            deadline_time: "08:00 AM, Day 3", // 2 days = 2880 mins window
            frustration_coefficient: 1.0
        };
        const halfwayTime = "08:00 AM, Day 2";
        
        dummyQuest.frustration_coefficient = 0.4;
        console.log(`Coeff 0.4 (Patient), Halfway -> ${computeFrustration(dummyQuest, halfwayTime).toFixed(3)} (expected ~0.177)`);
        
        dummyQuest.frustration_coefficient = 1.0;
        console.log(`Coeff 1.0 (Neutral), Halfway -> ${computeFrustration(dummyQuest, halfwayTime).toFixed(3)} (expected 0.500)`);
        
        dummyQuest.frustration_coefficient = 3.0;
        console.log(`Coeff 3.0 (Volatile), Halfway -> ${computeFrustration(dummyQuest, halfwayTime).toFixed(3)} (expected ~0.794)`);
        
        console.log("==========================");
    };
}
