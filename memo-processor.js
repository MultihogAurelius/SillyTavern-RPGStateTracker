/**
 * memo-processor.js — Fatbody D&D Framework
 * Pure text/logic utilities for memo management and state model context assembly.
 * Handles [TAG]...[/TAG] block merging, deduplication, delta computation,
 * lorebook assembly, and quest text serialization.
 * No DOM access. No module-level side effects.
 *
 * Imports: state-manager.js, constants.js
 * Imported by: index.js, renderer.js, quests.js
 */

import { getSettings } from './state-manager.js';
import { DEFAULT_STOCK_PROMPTS } from './constants.js';

// ── String utilities ──────────────────────────────────────────────────────────

export function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function escapeHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Wraps parenthetical groups in a highlight span. */
export function highlightParens(text) {
    return text.replace(/\(([^)]+)\)/g, '<span class="rt-paren-highlight">($1)</span>');
}

/**
 * Converts in-world time strings to a comparable numeric value (minutes since Day 1, 00:00).
 * Expected formats: "08:00 AM, Day 1", "Day 4", "10:00 PM"
 * @param {string} str 
 * @returns {number}
 */
export function parseInWorldTime(str) {
    if (!str) return 0;
    const dayMatch = str.match(/(?:Day|D)\s*(\d+)/i);
    const timeMatch = str.match(/(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
    
    let d = dayMatch ? parseInt(dayMatch[1], 10) : 1;
    let h = 0, m = 0;
    
    if (timeMatch) {
        h = parseInt(timeMatch[1], 10);
        m = parseInt(timeMatch[2], 10);
        if (timeMatch[3]) {
            const mer = timeMatch[3].toUpperCase();
            if (mer === 'AM' && h === 12) h = 0;
            if (mer === 'PM' && h !== 12) h += 12;
        }
    }
    
    if (!dayMatch && !timeMatch) return 0;
    return (d - 1) * 1440 + h * 60 + m;
}

/**
 * Formats a minute difference into a human-readable "X days Y hours Z minutes" string.
 * @param {number} diffMinutes 
 * @param {boolean} isFuture - If true, returns "X left", else "X ago"
 * @returns {string}
 */
export function formatTimeDiff(diffMinutes, isFuture = false) {
    if (diffMinutes === 0) return isFuture ? "due now" : "just now";
    const absDiff = Math.abs(diffMinutes);
    const dDays = Math.floor(absDiff / 1440);
    const dH = Math.floor((absDiff % 1440) / 60);
    const dM = absDiff % 60;
    
    let parts = [];
    if (dDays > 0) parts.push(`${dDays} day${dDays > 1 ? 's' : ''}`);
    if (dH > 0) parts.push(`${dH} hour${dH > 1 ? 's' : ''}`);
    if (dM > 0) parts.push(`${dM} minute${dM > 1 ? 's' : ''}`);
    
    if (parts.length === 0) return isFuture ? "due now" : "just now";
    
    const timeStr = parts.join(' ');
    return isFuture ? `${timeStr} left` : `${timeStr} ago`;
}

// ── Memo deduplication ────────────────────────────────────────────────────────

/**
 * Sanitizes a memo string to ensure no duplicate [TAG] sections exist.
 * If duplicates are found, the last one in the string is preserved.
 */
export function deduplicateMemo(memo) {
    if (!memo) return "";
    const settings = getSettings();

    const tagRegex = /\[([A-Z_]+)\]/gi;
    const tags = new Set();
    let match;
    while ((match = tagRegex.exec(memo)) !== null) {
        tags.add(match[1].toUpperCase());
    }

    let cleanedMemo = memo;
    for (const tag of tags) {
        const escapedTag = escapeRegex(tag);
        const pattern = new RegExp(`\\[${escapedTag}\\][\\s\\S]*?\\[\\/${escapedTag}\\]`, 'gi');
        const blocks = [...memo.matchAll(pattern)];

        if (blocks.length > 1) {
            if (settings.debugMode) console.warn(`[RPG Tracker] Deduplication: Found ${blocks.length} instances of [${tag}]. Keeping the last one.`);
            cleanedMemo = cleanedMemo.replace(pattern, "---DEDUP_MARKER---");
            const lastBlock = blocks[blocks.length - 1][0];
            const split = cleanedMemo.split("---DEDUP_MARKER---");
            cleanedMemo = split.join("").trim() + "\n\n" + lastBlock;
        }
    }

    return cleanedMemo.replace(/\n{3,}/g, '\n\n').trim();
}

// ── Memo merge ────────────────────────────────────────────────────────────────

/**
 * Merge partial AI output into the existing memo.
 * Finds all [TAG]...[/TAG] blocks in the AI output and replaces the
 * matching section in the current memo. New sections are appended.
 * If the AI output contains no bracket tags at all, the current memo is preserved.
 */
export function mergeMemo(currentMemo, aiOutput) {
    const settings = getSettings();

    const tagPattern = /\[([^\]\/][^\]]*)\]([\s\S]*?)\[\/\1\]/gi;
    const matches = [...aiOutput.matchAll(tagPattern)];

    if (matches.length === 0) {
        console.warn("[RPG Tracker] No valid [TAG]...[/TAG] blocks found in model output — treating as no-change. Output was:", aiOutput);
        return currentMemo;
    }

    if (settings.debugMode) console.log(`[RPG Tracker] mergeMemo: found ${matches.length} tag(s):`, matches.map(m => m[1]));

    let memo = currentMemo;

    for (const match of matches) {
        const tag = match[1].trim();
        const newContent = match[2].trim();

        // [QUESTS] block — route to appropriate handler based on mode
        if (tag.toUpperCase() === 'QUESTS') {
            const s = getSettings();
            if (s.questLegacyMode) {
                // Legacy: state model wrote the full text block — parse it wholesale
                const parsed = parseQuestsFromText(newContent);
                if (parsed) {
                    s.quests = parsed;
                    // Do NOT continue; let the standard replacement logic below
                    // integrate the new [QUESTS] block into the 'memo' string.
                }
            } else {
                // Tool mode: state model emits a diff JSON.
                // This updates settings.quests and calls syncQuestsToMemo() internally.
                mergeQuestUpdates(newContent);
                continue;
            }
        }

        const isRemoval = /^(?:REMOVED|EXPIRED|CLEARED|NONE|END_COMBAT)$/i.test(newContent);

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
                memo = memo.trimEnd() + '\n\n' + fullBlock;
                if (settings.debugMode) console.log(`[RPG Tracker] mergeMemo: [${tag}] APPENDED (new section)`);
            }
        }
    }

    const cleaned = memo.replace(/\n{3,}/g, '\n\n').trim();
    return deduplicateMemo(cleaned);
}

// ── Quest update merge ────────────────────────────────────────────────────────

/**
 * Applies a constrained {"updates":[...]} diff from the state model to settings.quests.
 * Only mutates `status` and `objectives[n].status`. All other fields are locked.
 * Does NOT touch quests with status 'failed'.
 * @param {string} jsonText
 */
export function mergeQuestUpdates(jsonText) {
    const settings = getSettings();
    if (!settings.quests || !settings.quests.length) return;

    let parsed;
    try {
        parsed = JSON.parse(jsonText);
    } catch (e) {
        console.warn('[RPG Tracker] mergeQuestUpdates: invalid JSON in [QUESTS] diff block:', jsonText);
        return;
    }

    const updates = Array.isArray(parsed?.updates) ? parsed.updates : [];
    if (!updates.length) return;

    const mods = settings.syspromptModules || {};
    const isDeadlines = !!mods.questsDeadlines;
    const isFrustration = !!mods.questsFrustration;

    let changed = false;
    for (const update of updates) {
        const quest = settings.quests.find(q => q.id === update.id);
        if (!quest) continue;
        if (quest.status === 'failed') continue;

        if (update.status && ['active', 'completed', 'past deadline', 'failed'].includes(update.status)) {
            let resolvedStatus = update.status;

            // Frustration ON: deadline expiry → 'past deadline', not 'failed' (AI may get this wrong)
            if (isFrustration && resolvedStatus === 'failed' && quest.deadline_time && quest.status === 'active') {
                resolvedStatus = 'past deadline';
            }
            // Deadlines ON, Frustration OFF: 'past deadline' is invalid → promote to 'failed'
            if (isDeadlines && !isFrustration && resolvedStatus === 'past deadline') {
                resolvedStatus = 'failed';
            }

            quest.status = resolvedStatus;
            changed = true;
        }

        if (Array.isArray(update.objectives)) {
            for (const objUpdate of update.objectives) {
                const obj = quest.objectives.find(o => o.id === objUpdate.id);
                if (!obj) continue;
                if (objUpdate.status && ['active', 'completed', 'failed'].includes(objUpdate.status)) {
                    obj.status = objUpdate.status;
                    changed = true;
                }
            }
        }
    }

    if (changed) {
        if (settings.debugMode) console.log('[RPG Tracker] mergeQuestUpdates: applied quest state changes.');
        SillyTavern.getContext().saveSettingsDebounced();
        syncQuestsToMemo();
    }
}

/**
 * Rebuilds the [QUESTS] block in settings.currentMemo from settings.quests.
 * Uses plain-text format in legacy mode, JSON in tool mode.
 */
export function syncQuestsToMemo() {
    const settings = getSettings();
    if (!settings.quests) return;

    const tag = 'QUESTS';
    const escapedTag = escapeRegex(tag);
    const pattern = new RegExp(`\\s*\\[${escapedTag}\\][\\s\\S]*?\\[\\/${escapedTag}\\]`, 'i');
    const blockExists = pattern.test(settings.currentMemo);

    // If no quests, remove the block if present — never insert an empty one
    if (!settings.quests.length) {
        if (blockExists) {
            settings.currentMemo = settings.currentMemo.replace(pattern, '').trim();
        }
        return;
    }

    const content = settings.questLegacyMode
        ? serializeQuestsToText(settings.quests)
        : JSON.stringify(settings.quests, null, 2);

    const block = `\n\n[${tag}]\n${content}\n[/${tag}]`;

    if (blockExists) {
        settings.currentMemo = settings.currentMemo.replace(pattern, block);
    } else {
        settings.currentMemo = (settings.currentMemo + block).trim();
    }
}

// ── Legacy quest text format ───────────────────────────────────────────────────

/**
 * Parses the state model's plain-text quest format into settings.quests[].
 * Each quest block starts with "QUEST: <title>" and contains labeled key: value lines.
 * @param {string} text - Content inside [QUESTS]...[/QUESTS]
 * @returns {object[]|null} Array of quest objects, or null on complete parse failure.
 */
export function parseQuestsFromText(text) {
    if (!text || !text.trim()) return [];

    const questBlocks = text.trim().split(/^QUEST:/m);
    const quests = [];

    for (const block of questBlocks) {
        if (!block.trim()) continue;

        const lines = block.split('\n');
        const title = lines[0].trim();
        if (!title) continue;

        /** @param {string} key */
        const getField = (key) => {
            const re = new RegExp(`^\\s*${key}:\\s*(.+)$`, 'mi');
            const m = block.match(re);
            return m ? m[1].trim() : null;
        };

        const rawGiver  = getField('GIVER') || '';
        const giverParts = rawGiver.split(' @ ');
        const giverName = giverParts[0]?.trim() || 'Unknown';
        const giverLoc  = giverParts[1]?.trim() || 'Unknown';

        const rawCoeff = getField('FRUSTRATION_COEFF');
        const coeff = rawCoeff ? parseFloat(rawCoeff) : null;

        // Objectives: OBJ_ACTIVE, OBJ_COMPLETED/OBJ_DONE, or OBJ_FAILED lines
        // Robust: handles both one-per-line and comma-separated objectives on a single line
        const objectives = [];
        const objRe = /^\s*(OBJ_ACTIVE|OBJ_DONE|OBJ_COMPLETED|OBJ_FAILED):\s*(.+)$/gmi;
        let objMatch;
        let objIdx = 0;
        while ((objMatch = objRe.exec(block)) !== null) {
            const tag = objMatch[1].toUpperCase();
            const isDone = (tag === 'OBJ_DONE' || tag === 'OBJ_COMPLETED');
            const isFailed = (tag === 'OBJ_FAILED');
            const rawContent = objMatch[2].trim();

            // Detect comma-separated objectives: "Obj one (required), Obj two (optional)"
            // A comma-separated list will have "(required)" or "(optional)" mid-string
            const hasInlineMarkers = /\)\s*,/.test(rawContent);

            const parts = hasInlineMarkers
                ? rawContent.split(/,\s*(?=\S)/)   // split on ", " boundaries
                : [rawContent];

            for (const part of parts) {
                const p = part.trim();
                if (!p) continue;
                const isOptional = /\(optional\)$/i.test(p);
                const objText = p.replace(/\s*\((required|optional)\)\s*$/i, '').trim();
                if (!objText) continue;
                objectives.push({
                    id:       `obj_${objIdx++}`,
                    text:     objText,
                    required: !isOptional,
                    status:   isDone ? 'completed' : (isFailed ? 'failed' : 'active'),
                });
            }
        }

        // Rewards: REWARD lines
        const rewards = [];
        const rewardRe = /^\s*REWARD:\s*(.+)$/gmi;
        let rewardMatch;
        while ((rewardMatch = rewardRe.exec(block)) !== null) {
            rewards.push(rewardMatch[1].trim());
        }

        quests.push({
            id:                     getField('ID') || `quest_${Date.now()}_${quests.length}`,
            title,
            status:                 getField('STATUS') || 'active',
            giver_name:             giverName,
            giver_location:         giverLoc,
            accepted_time:          getField('ACCEPTED'),
            deadline_time:          getField('DEADLINE'),
            frustration_coefficient: coeff !== null && !isNaN(coeff) ? coeff : undefined,
            objectives,
            rewards,
        });
    }

    return quests;
}

/**
 * Converts settings.quests[] back to the plain-text format for the Raw View.
 * @param {object[]} quests
 * @returns {string}
 */
export function serializeQuestsToText(quests) {
    if (!quests || !quests.length) return '';

    return quests.map(q => {
        const lines = [`QUEST: ${q.title}`];
        lines.push(`  ID: ${q.id}`);
        lines.push(`  STATUS: ${q.status || 'active'}`);
        lines.push(`  GIVER: ${q.giver_name} @ ${q.giver_location}`);
        if (q.accepted_time)          lines.push(`  ACCEPTED: ${q.accepted_time}`);
        if (q.deadline_time)          lines.push(`  DEADLINE: ${q.deadline_time}`);
        if (q.frustration_coefficient != null)
                                      lines.push(`  FRUSTRATION_COEFF: ${q.frustration_coefficient}`);
        for (const obj of (q.objectives || [])) {
            let tag = 'OBJ_ACTIVE';
            if (obj.status === 'completed') tag = 'OBJ_COMPLETED';
            else if (obj.status === 'failed') tag = 'OBJ_FAILED';
            
            const suffix = obj.required ? '(required)' : '(optional)';
            lines.push(`  ${tag}: ${obj.text} ${suffix}`);
        }
        for (const r of (q.rewards || [])) {
            lines.push(`  REWARD: ${r}`);
        }
        return lines.join('\n');
    }).join('\n\n');
}

/**
 * Parses the [QUESTS] block from a text string and updates settings.quests.
 * Used when the user manually edits the Raw View.
 * @param {string} memoText
 */
export function syncQuestsFromMemo(memoText) {
    const settings = getSettings();
    const match = memoText.match(/\[QUESTS\]([\s\S]*?)\[\/QUESTS\]/i);

    if (!match) {
        if (settings.quests && settings.quests.length > 0) {
            settings.quests = [];
            if (settings.debugMode) console.log('[RPG Tracker] syncQuestsFromMemo: quests cleared because [QUESTS] block was removed.');
        }
        return;
    }

    const content = match[1].trim();

    // Auto-detect format: plain-text starts with QUEST:, otherwise try JSON
    if (content.startsWith('QUEST:') || settings.questLegacyMode) {
        const parsed = parseQuestsFromText(content);
        if (parsed) {
            settings.quests = parsed;
            if (settings.debugMode) console.log('[RPG Tracker] syncQuestsFromMemo: updated internal state from plain-text edit.');
        }
    } else {
        try {
            const parsed = JSON.parse(content);
            if (Array.isArray(parsed)) {
                settings.quests = parsed;
                if (settings.debugMode) console.log('[RPG Tracker] syncQuestsFromMemo: updated internal state from JSON edit.');
            }
        } catch (e) {
            if (settings.debugMode) console.warn('[RPG Tracker] syncQuestsFromMemo: could not parse quest block. Error:', e.message);
        }
    }
}

// ── Delta display ─────────────────────────────────────────────────────────────

/**
 * Produces an HTML diff string for display in the delta panel.
 */
export function computeDelta(oldMemo, newMemo) {
    if (!oldMemo && !newMemo) return '<span class="delta-empty">No memo yet.</span>';
    if (!oldMemo) return '<span class="delta-added">+ (initial memo created)</span>';

    const oldLines = new Set(oldMemo.split('\n').map(l => l.trim()).filter(Boolean));
    const newLines = new Set(newMemo.split('\n').map(l => l.trim()).filter(Boolean));

    const added   = [...newLines].filter(l => !oldLines.has(l));
    const removed = [...oldLines].filter(l => !newLines.has(l));

    if (added.length === 0 && removed.length === 0) {
        return '<span class="delta-empty">No changes detected.</span>';
    }

    const html = [
        ...removed.map(l => `<div class="delta-removed">- ${escapeHtml(l)}</div>`),
        ...added.map(l   => `<div class="delta-added">+ ${escapeHtml(l)}</div>`),
    ];
    return html.join('');
}

// ── Tool-call message detection ───────────────────────────────────────────────

/**
 * Returns null if the message is a tool-call payload (discard it from context).
 * Returns the original text if it is regular narrative.
 * @param {string} text
 * @returns {string|null}
 */
export function cleanToolCallMessage(text) {
    if (!text) return text;
    const trimmed = text.trim();

    if (trimmed.includes('<code') && trimmed.includes('</code>')) {
        const codeStart   = trimmed.indexOf('<code');
        const contentStart = trimmed.indexOf('>', codeStart);
        const codeEnd     = trimmed.indexOf('</code>', contentStart);
        if (contentStart !== -1 && codeEnd !== -1) {
            const jsonText = trimmed.slice(contentStart + 1, codeEnd).trim();
            try {
                const parsed  = JSON.parse(jsonText);
                const entries = Array.isArray(parsed) ? parsed : [parsed];
                if (entries.some(e => e && (e.name || e.result !== undefined))) {
                    return null;
                }
            } catch { /* not valid JSON inside the code block */ }
        }
    }

    if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
        try {
            const parsed  = JSON.parse(trimmed);
            const entries = Array.isArray(parsed) ? parsed : [parsed];
            if (entries.some(e => e && (e.name || e.result !== undefined))) {
                return null;
            }
        } catch { /* not valid JSON */ }
    }

    return text;
}

// ── User action extraction ────────────────────────────────────────────────────

/**
 * Extracts the last user message from the chat, stripping injected blocks
 * (STATE MEMO, RNG_QUEUE) so only the player's actual typed input remains.
 */
export function getLastUserAction() {
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

    raw = raw.replace(/###\s*STATE MEMO[^]*?(?=\n\[RNG_QUEUE|\n###|\n\[(?!RNG_QUEUE)[A-Z]|$)/i, '');
    raw = raw.replace(/\[RNG_QUEUE\s[^\]]*\][\s\S]*?\[\/RNG_QUEUE\][ \t]*\n?/gi, '');
    raw = raw.replace(/\[[A-Z_]+\][\s\S]*?\[\/[A-Z_]+\]/g, '');

    return raw.trim();
}

// ── Lorebook context builder ──────────────────────────────────────────────────

/**
 * Reads active Lorebooks from user settings and assembles them into
 * a context string prepended to the state model user prompt.
 */
export async function buildLorebookContext() {
    const settings = getSettings();
    const stCtx = SillyTavern.getContext();
    const parts = [];

    if (settings.ctxWorldInfo) {
        try {
            const allowedBooks = settings.lorebookFilter || [];
            let booksToLoad = allowedBooks.length > 0
                ? allowedBooks
                : (await stCtx.getWorldInfoNames() || []);

            const entries = [];
            for (const bookName of booksToLoad) {
                try {
                    const bookData = await stCtx.loadWorldInfo(bookName);
                    if (!bookData?.entries) continue;
                    for (const entry of Object.values(/** @type {any} */(bookData).entries)) {
                        const e = /** @type {any} */ (entry);
                        if (!e.disable && e.content) entries.push(e.content);
                    }
                } catch (bookErr) {
                    console.warn(`[RPG Tracker] Failed to load lorebook "${bookName}":`, bookErr);
                }
            }

            if (entries.length > 0) {
                const label = allowedBooks.length > 0 ? `Filtered: ${allowedBooks.join(', ')}` : 'All Books';
                parts.push(`## WORLD LORE (${label})\n${entries.join('\n---\n')}`);
            }
        } catch (e) {
            console.warn('[RPG Tracker] Could not inject World Info:', e);
        }
    }

    return parts.join('\n\n');
}

// ── Module instruction builders ───────────────────────────────────────────────

/**
 * Builds the complete modules instruction block for the system prompt.
 */
export function buildModulesInstructionText(settings) {
    let modulesText = "";
    const promptsMap = settings.stockPrompts || DEFAULT_STOCK_PROMPTS;

    modulesText += "### CORE MODULES\n";
    for (const [key, prompt] of Object.entries(promptsMap)) {
        if (settings.modules[key]) {
            let p = prompt;

            // ── Dynamic prompt stripping for Legacy Quests ──────────────────
            if (key === 'quests' && settings.questLegacyMode) {
                const isDeadlines = !!settings.syspromptModules?.questsDeadlines;
                const isFrustration = !!settings.syspromptModules?.questsFrustration;

                if (!isDeadlines) {
                    // Strip DEADLINE line
                    p = p.replace(/\n\s*DEADLINE:.*?\n/g, '\n');
                }
                if (!isFrustration) {
                    // Strip FRUSTRATION_COEFF line
                    p = p.replace(/\n\s*FRUSTRATION_COEFF:.*?\n/g, '\n');
                }
            }

            modulesText += `- [${key.toUpperCase()}]: ${p}\n`;
        }
    }

    const enabledCustomFields = (settings.customFields || []).filter(f => f.enabled && f.tag);
    if (enabledCustomFields.length > 0) {
        modulesText += "\n### CUSTOM MODULES\n";
        enabledCustomFields.forEach(f => {
            const instruction = buildModuleFormatInstruction(f);
            if (instruction) {
                modulesText += `- [${f.tag.toUpperCase()}]: ${instruction}\n`;
            }
        });
    }
    return modulesText.trim();
}

export function buildModuleFormatInstruction(field) {
    return field.prompt || '';
}
