/**
 * rng.js — Fatbody D&D Framework
 * RNG engine, dice tools, chat interceptor, narrative collector.
 *
 * Imports: settings.js, api.js (none — runStateModelPass imported at call time to avoid circular)
 * Imported by: index.js (registration), settings-ui.js (toggle)
 *
 * NOTE: runStateModelPass is resolved at call-time via globalThis to avoid a
 * circular import with state-engine.js. This will be cleaned up in Phase 5.
 */

import { getSettings } from './settings.js';

// ── Dice naming helpers ────────────────────────────────────────────────────────

export function getDiceToolName() {
    return 'RollTheDice';
}

export function getDiceCommandName() {
    return 'roll';
}

export function getDiceCommandAliases() {
    return ['r'];
}

// ── RNG Engine ─────────────────────────────────────────────────────────────────

export const RNG_QUEUE_LEN = 12;

export function rollDie(sides) {
    const buf = new Uint32Array(1);
    const limit = Math.floor(4294967296 / sides) * sides;
    let roll;
    do { crypto.getRandomValues(buf); roll = buf[0]; } while (roll >= limit);
    return (roll % sides) + 1;
}

export function makeRngQueue(n = RNG_QUEUE_LEN) {
    const out = [];
    for (let i = 0; i < n; i++) {
        out.push({
            d20: rollDie(20),
            d4:  rollDie(4),
            d6:  rollDie(6),
            d8:  rollDie(8),
            d10: rollDie(10),
            d12: rollDie(12),
        });
    }
    return out;
}

export function buildRngBlock(queue) {
    const turnId = Date.now();
    const formattedQueue = queue.map(dice =>
        `${dice.d20}(d4:${dice.d4},d6:${dice.d6},d8:${dice.d8},d10:${dice.d10},d12:${dice.d12})`
    ).join(", ");
    return `[RNG_QUEUE v6.0_PROPER]\nturn_id=${turnId}\nscope=this_response\nqueue=[${formattedQueue}]\n[/RNG_QUEUE]\n\n`;
}

// ── Dice rolling ───────────────────────────────────────────────────────────────

export async function doDiceRoll(customDiceFormula, quiet = false) {
    const nullValue = { total: '', rolls: [] };
    let value = typeof customDiceFormula === 'string' ? customDiceFormula.trim() : '1d20';

    if (value === 'custom') {
        const { Popup } = SillyTavern.getContext();
        value = await Popup.show.input('Enter the dice formula:<br><i>(for example, <tt>2d6</tt>)</i>', '', 'Roll', { cancelButton: 'Cancel' });
    }

    if (!value) return nullValue;

    const droll = SillyTavern.libs.droll;
    if (!droll) {
        toastr['error']('Dice library (droll) not found.');
        return nullValue;
    }

    const isValid = droll.validate(value);
    if (isValid) {
        const result = droll.roll(value);
        if (!result) return nullValue;
        if (!quiet) {
            const context = SillyTavern.getContext();
            context.sendSystemMessage('generic', `${context.name1} rolls a ${value}. The result is: ${result.total} (${result.rolls.join(', ')})`, { isSmallSys: true });
        }
        return { total: String(result.total), rolls: result.rolls.map(String) };
    } else {
        toastr['warning']('Invalid dice formula');
        return nullValue;
    }
}

// ── Tool & slash command registration ─────────────────────────────────────────

export function registerDiceFunctionTool() {
    try {
        const ctx = SillyTavern.getContext();
        const { registerFunctionTool, unregisterFunctionTool } = ctx;
        if (!registerFunctionTool || !unregisterFunctionTool) return;

        unregisterFunctionTool('RollTheDice');
        unregisterFunctionTool('FatbodyRollTheDice');

        const settings = getSettings();
        if (settings.legacyRollingMode) return; // Legacy: prose-based rolling
        if (!settings.diceFunctionTool) return;

        const toolName = getDiceToolName();
        const isLegacy = settings.legacyDiceNaming;

        const rollDiceSchema = isLegacy ? {
            type: 'object',
            properties: {
                who: { type: 'string', description: 'The name of the persona rolling the dice' },
                formula: { type: 'string', description: 'A dice formula to roll, e.g. 1d6' },
            },
            required: ['who', 'formula'],
        } : {
            type: 'object',
            properties: {
                who: { type: 'string', description: 'The name of the persona rolling the dice' },
                formula: { type: 'string', description: 'A dice formula to roll, e.g. 1d20' },
                dc: { type: 'number', description: 'The Difficulty Class (DC) for this roll. Anchors the difficulty before the roll is made.' },
            },
            required: ['who', 'formula', 'dc'],
        };

        registerFunctionTool({
            name: toolName,
            displayName: isLegacy ? 'Dice Roll' : 'Dice Roll (with DC)',
            description: 'Rolls the dice using the provided formula and returns the numeric result. Use when it is necessary to roll the dice to determine the outcome of an action or when the user requests it.',
            parameters: rollDiceSchema,
            action: async (args) => {
                const formula = args?.formula || (isLegacy ? '1d6' : '1d20');
                const roll = await doDiceRoll(formula, true);
                const total = parseInt(roll.total) || 0;

                if (isLegacy) {
                    return args.who
                        ? `${args.who} rolls a ${formula}. The result is: ${total}. Individual rolls: ${roll.rolls.join(', ')}`
                        : `The result of a ${formula} roll is: ${total}. Individual rolls: ${roll.rolls.join(', ')}`;
                }

                const dc = Number(args?.dc) || 0;
                let result = args.who
                    ? `${args.who} rolls a ${formula} against DC ${dc}. The result is: ${total}. Individual rolls: ${roll.rolls.join(', ')}`
                    : `The result of a ${formula} roll against DC ${dc} is: ${total}. Individual rolls: ${roll.rolls.join(', ')}`;

                if (dc > 0) {
                    result += ` (Result: ${total >= dc ? 'SUCCESS' : 'FAILURE'})`;
                }
                return result;
            },
            formatMessage: () => '',
        });
    } catch (error) {
        console.error('[RPG Tracker] Error registering dice function tool', error);
    }
}

export function registerDiceSlashCommand() {
    const { SlashCommand, SlashCommandParser, ARGUMENT_TYPE, SlashCommandArgument, SlashCommandNamedArgument } = SillyTavern.getContext();
    if (!SlashCommand || !SlashCommandParser) return;

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: getDiceCommandName(),
        aliases: getDiceCommandAliases(),
        callback: async (args, value) => {
            const quiet = String(args.quiet) === 'true';
            const result = await doDiceRoll(String(value || (getSettings().legacyDiceNaming ? '1d6' : '1d20')), quiet);
            return result.total;
        },
        helpString: 'Roll the dice.',
        returns: 'roll result',
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'quiet',
                description: 'Do not display the result in chat',
                isRequired: false,
                typeList: [ARGUMENT_TYPE.BOOLEAN],
                defaultValue: 'false',
            }),
        ],
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'dice formula, e.g. 2d6',
                isRequired: true,
                typeList: [ARGUMENT_TYPE.STRING],
            }),
        ],
    }));
}

// ── stripMemoHtml (local copy — canonical version moves to renderer.js in Phase 6) ──
function stripMemoHtml(text) {
    if (!text) return text;
    let stripped = text.replace(/<br\s*\/?>/gi, '\n');
    stripped = stripped.replace(/<[^>]+>/g, '');
    return stripped;
}

// ── Chat interceptor (registered on globalThis for ST manifest hook) ───────────

export function installInterceptor() {
    globalThis.rpgTrackerInterceptor = async function (chat, contextSize, abort, type) {
        const settings = getSettings();
        if (!settings.enabled || settings.paused) return;

        let idx = -1;
        for (let i = chat.length - 1; i >= 0; i--) {
            if (chat[i]['role'] === "user" || chat[i].is_user) { idx = i; break; }
        }
        if (idx === -1) return;

        const msg = chat[idx];
        const content = msg['content'] || msg.mes || '';
        let injections = "";

        if (settings.rngEnabled && !content.includes("[RNG_QUEUE v6.0_PROPER]")) {
            const queue = makeRngQueue(RNG_QUEUE_LEN);
            injections += buildRngBlock(queue);
        }

        if (settings.currentMemo && !content.includes("### STATE MEMO (DO NOT REPEAT)")) {
            // Strip the JSON [QUESTS] block from the narrative context to save tokens and avoid redundancy
            const memoText = stripMemoHtml(settings.currentMemo).replace(/\[QUESTS\][\s\S]*?\[\/QUESTS\]/gi, '').trim();
            injections += `### STATE MEMO (DO NOT REPEAT)\n${memoText}\n\n`;
        }

        // Quest deadline check — fires before state model pass, deterministically
        if (settings.modules?.quests && settings.quests?.length) {
            const { checkQuestDeadlines, renderQuestsAsPlainText } = await import('./quests.js');
            checkQuestDeadlines();

            // Inject active quests as plain text into narrative context
            const timeMatch = (settings.currentMemo || '').match(/\[TIME\]([\s\S]*?)\[\/TIME\]/i);
            const currentTime = timeMatch ? timeMatch[1].split('\n').filter(Boolean)[0]?.trim() || '' : '';
            const questText = renderQuestsAsPlainText(settings.quests, currentTime);
            if (questText) injections += questText;
        }

        if (!injections) return;

        if (typeof msg.content === "string") msg.content = injections + msg.content;
        else if (typeof msg.mes === "string") msg.mes = injections + msg.mes;
        if (settings.debugMode) console.log("[Fatbody Framework] Injections pushed to request.");
    };
}

// ── Narrative collector ────────────────────────────────────────────────────────

/**
 * Collects AI narrative blocks from the chat array.
 * @param {any[]} chat
 * @param {number} limit  -1 = all since last user message; N = collect N blocks
 */
export function getNarrativeBlocks(chat, limit = -1) {
    if (!chat || chat.length === 0) return "";
    let narrativeBlocks = [];
    let foundCount = 0;

    for (let i = chat.length - 1; i >= 0; i--) {
        const msg = chat[i];
        if (limit === -1 && msg.is_user) break;
        if (limit !== -1 && foundCount >= limit) break;
        if (msg.is_system || /** @type {any} */ (msg).is_hidden) continue;

        let mes = (msg.mes || '').trim();
        if (!mes) continue;
        if (mes.startsWith('[Summary') || mes.startsWith('(Summary') || mes.includes('Summary of past events:')) continue;
        if (msg.extra?.['summary'] || msg.extra?.['is_summary'] || msg.extra?.['summary_data']) continue;

        // Strip tool call & thinking UI
        mes = mes.replace(/<details\b[^>]*>([\s\S]*?)<\/details>/gi, '');
        mes = mes.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, '');
        mes = mes.replace(/<thought\b[^>]*>([\s\S]*?)<\/thought>/gi, '');
        mes = mes.replace(/<thinking\b[^>]*>([\s\S]*?)<\/thinking>/gi, '');
        mes = mes.replace(/<reasoning\b[^>]*>([\s\S]*?)<\/reasoning>/gi, '');
        mes = mes.trim();

        if (mes) { narrativeBlocks.unshift(mes); foundCount++; }
    }
    return narrativeBlocks.join('\n\n');
}

// ── Generation-ended handler ───────────────────────────────────────────────────

/**
 * Fires on GENERATION_ENDED. Triggers the state model pass.
 * runStateModelPass is resolved via the module import below to avoid
 * a hard circular dep — it will be a direct import once state-engine.js exists.
 */
export async function onGenerationEnded() {
    const settings = getSettings();
    if (!settings.enabled || settings.paused || globalThis._rngStateModelRunning) return;

    const { chat } = SillyTavern.getContext();
    const combinedNarrative = getNarrativeBlocks(chat, -1);
    if (!combinedNarrative) return;

    if (settings.debugMode) console.log("[RPG Tracker] Assistant generation ended. Triggering State Model pass...", combinedNarrative);

    // runStateModelPass lives in index.js until Phase 5. Resolved at call-time.
    if (typeof globalThis._rpgRunStateModelPass === 'function') {
        globalThis._rpgRunStateModelPass(combinedNarrative);
    }
}
