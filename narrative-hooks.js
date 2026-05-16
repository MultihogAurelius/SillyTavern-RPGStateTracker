/**
 * narrative-hooks.js — Fatbody D&D Framework
 * RNG engine, dice tools, chat interceptor, and narrative collector.
 * This file is the primary hook into the SillyTavern chat pipeline:
 * it intercepts outgoing messages to inject context (RNG queue, state memo,
 * quests) and collects incoming AI narrative for the state model pass.
 *
 * Imports: state-manager.js
 * Imported by: index.js (registration)
 *
 * NOTE: runStateModelPass is resolved at call-time via globalThis to avoid a
 * circular import. This will be cleaned up when index.js is split.
 */

import { getSettings } from './state-manager.js';
import { parseQuestsFromMemo } from './memo-processor.js';
import { runRouterPass, rollbackRouterPass, saveSceneToLorebook, scanAssistantOutputForKeywords } from './router.js';
import { logTransaction } from './debug-viewer.js';

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

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'router',
        callback: async (args, value) => {
            const val = String(value || '').trim().toLowerCase();
            if (val.startsWith('save')) {
                const hint = val.substring(4).trim();
                await saveSceneToLorebook(hint);
                return 'Scene save requested.';
            }
            if (val === 'run' || val === 'research') {
                const { chat } = SillyTavern.getContext();
                const s = getSettings();
                const combinedNarrative = getNarrativeBlocks(chat, -1, !!s.routerIncludeHidden);
                await runRouterPass(combinedNarrative, null, null, true);
                return 'Research pass started.';
            }
            return 'Usage: /router run | /router save [hint]';
        },
        helpString: 'Interact with the Router Agent (e.g. /router save)',
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'command (e.g. save)',
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
        // `paused` only suppresses automatic state tracker / lorebook runs (see onGenerationEnded).
        // Do not skip this hook when paused: RNG queue, memo, and quest context must still inject
        // into the outgoing user message or combat RNG breaks while updates are paused.
        if (!settings.enabled) return;

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
        if (settings.modules?.quests) {
            const memoQuests = parseQuestsFromMemo(settings.currentMemo);
            if (memoQuests.length) {
                const { checkQuestDeadlines, renderQuestsAsPlainText } = await import('./quests.js');
                checkQuestDeadlines();

                // Inject active quests as plain text into narrative context
                const timeMatch = (settings.currentMemo || '').match(/\[TIME\]([\s\S]*?)\[\/TIME\]/i);
                const currentTime = timeMatch ? timeMatch[1].split('\n').filter(Boolean)[0]?.trim() || '' : '';
                // Re-parse after checkQuestDeadlines may have mutated the memo
                const freshQuests = parseQuestsFromMemo(settings.currentMemo);
                const questText = renderQuestsAsPlainText(freshQuests, currentTime);
                if (questText) injections += questText;
            }
        }



        // Pre-generation keyword scan + same-turn lore injection.
        // The PromptManager builds the prompt BEFORE this interceptor runs, so updating
        // activeRouterKeys is always one turn late on that path.
        // Fix: entries activated THIS scan are injected directly into the user message —
        // the same pattern as state memo and quests — guaranteeing same-turn presence.
        // Skipped when routerNativeKeywordActivation is enabled (native ST system handles keywords).
        if (settings.routerEnabled && !settings.routerNativeKeywordActivation) {
            if (content) {
                const t0 = performance.now().toFixed(1);
                console.group(`[RPG|INTERCEPT] rpgTrackerInterceptor keyword pre-scan @ ${t0}ms`);
                console.log('activeRouterKeys BEFORE scan:', JSON.stringify(settings.activeRouterKeys || []));
                const triggered = await scanAssistantOutputForKeywords(content, { sweepEnabled: false }).catch(() => []);
                console.log('activeRouterKeys AFTER scan:', JSON.stringify(settings.activeRouterKeys || []));
                console.log('newly triggered this scan:', triggered);
                console.log(`scan finished @ ${performance.now().toFixed(1)}ms`);

                if (triggered.length > 0) {
                    try {
                        const ctx = SillyTavern.getContext();
                        let loreBlock = '';
                        const bookCache = {};
                        for (const id of triggered) {
                            const [bookName, uid] = id.split('::');
                            if (!bookCache[bookName]) bookCache[bookName] = await ctx.loadWorldInfo(bookName);
                            const entry = bookCache[bookName]?.entries?.[uid];
                            if (entry?.content) {
                                loreBlock += `### [${entry.key?.[0] || entry.comment || uid}]\n${entry.content}\n\n`;
                            }
                        }
                        if (loreBlock) {
                            injections += `\n<font color="#d4a028">## NEWLY ACTIVATED LORE (KEYWORD MATCH)</font>\n${loreBlock.trim()}\n`;
                            console.log(`[RPG|INTERCEPT] Same-turn lore injected for ${triggered.length} entries.`);
                        }

                        // Trigger UI refresh so the Agent Panel updates immediately with yellow pills
                        if (typeof globalThis._rpgRenderRouterUI === 'function') {
                            globalThis._rpgRenderRouterUI();
                        }
                    } catch (e) {
                        console.warn('[RPG Tracker] Same-turn lore injection failed:', e);
                    }
                }

                // Re-inject previously keyword-activated lore on every subsequent turn.
                // These entries are still disable:true in the lorebook so ST's native system
                // won't inject them — we must keep doing it manually every generation.
                const triggeredSet = new Set(triggered);
                const persistent = (settings.keywordActivatedKeys || []).filter(id => !triggeredSet.has(id));
                if (persistent.length > 0) {
                    try {
                        const ctx = SillyTavern.getContext();
                        let persistBlock = '';
                        const bookCache = {};
                        for (const id of persistent) {
                            const [bookName, uid] = id.split('::');
                            if (!bookCache[bookName]) bookCache[bookName] = await ctx.loadWorldInfo(bookName);
                            const entry = bookCache[bookName]?.entries?.[uid];
                            if (entry?.content) {
                                persistBlock += `### [${entry.key?.[0] || entry.comment || uid}]\n${entry.content}\n\n`;
                            }
                        }
                        if (persistBlock) {
                            injections += `\n<font color="#d4a028">## ACTIVE LORE (KEYWORD)</font>\n${persistBlock.trim()}\n`;
                        }
                    } catch (e) {
                        console.warn('[RPG Tracker] Persistent keyword lore re-injection failed:', e);
                    }
                }

                // Inject agent-activated lore (grey pills): entries in activeRouterKeys that are
                // NOT in the keyword pools. These were added by the Agent or Direct Command.
                // They are disable:true in the lorebook so ST's native scanner ignores them.
                // Neither of the keyword passes above covers them — this pass fills the gap.
                const alreadyInjected = new Set([...triggered, ...(settings.keywordActivatedKeys || [])]);
                const agentOwned = (settings.activeRouterKeys || []).filter(id => !alreadyInjected.has(id));
                if (agentOwned.length > 0) {
                    try {
                        const ctx = SillyTavern.getContext();
                        let agentBlock = '';
                        const bookCache = {};
                        for (const id of agentOwned) {
                            const [bookName, uid] = id.split('::');
                            if (!bookCache[bookName]) bookCache[bookName] = await ctx.loadWorldInfo(bookName);
                            const entry = bookCache[bookName]?.entries?.[uid];
                            if (entry?.content) {
                                agentBlock += `### [${entry.key?.[0] || entry.comment || uid}]\n${entry.content}\n\n`;
                            }
                        }
                        if (agentBlock) {
                            injections += `\n## ACTIVE LORE (AGENT)\n${agentBlock.trim()}\n`;
                        }
                    } catch (e) {
                        console.warn('[RPG Tracker] Agent-owned lore injection failed:', e);
                    }
                }

                console.groupEnd();
            }
        }

        if (!injections) return;

        const originalContent = msg.content || msg.mes || '';
        if (typeof msg.content === "string") msg.content = injections + msg.content;
        else if (typeof msg.mes === "string") msg.mes = injections + msg.mes;

        if (settings.debugMode) {
            console.log("[Fatbody Framework] Injections pushed to request.");
            logTransaction('Main Chat', [{ role: 'user', content: injections + originalContent }]);
        }
    };
}


// ── Narrative collector ────────────────────────────────────────────────────────

/**
 * Collects AI narrative blocks from the chat array.
 * @param {any[]} chat
 * @param {number} limit  -1 = all since last user message; N = collect N blocks
 */
export function getNarrativeBlocks(chat, limit = -1, includeHidden = false) {
    if (!chat || chat.length === 0) return "";
    let narrativeBlocks = [];
    let foundCount = 0;

    for (let i = chat.length - 1; i >= 0; i--) {
        const msg = chat[i];
        if (limit === -1 && msg.is_user) break;
        if (limit !== -1 && foundCount >= limit) break;
        if (msg.is_system) continue;
        if (!includeHidden && /** @type {any} */ (msg).is_hidden) continue;

        let mes = (msg.mes || '').trim();
        if (!mes) continue;
        if (mes.startsWith('[Summary') || mes.startsWith('(Summary') || mes.includes('Summary of past events:')) continue;
        if (msg.extra?.['summary'] || msg.extra?.['is_summary'] || msg.extra?.['summary_data']) continue;

        // Strip tool call & thinking UI (XML-tag variants)
        mes = mes.replace(/<details\b[^>]*>([\s\S]*?)<\/details>/gi, '');
        mes = mes.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, '');
        mes = mes.replace(/<thought\b[^>]*>([\s\S]*?)<\/thought>/gi, '');
        mes = mes.replace(/<thinking\b[^>]*>([\s\S]*?)<\/thinking>/gi, '');
        mes = mes.replace(/<reasoning\b[^>]*>([\s\S]*?)<\/reasoning>/gi, '');
        // <think> tags used by DeepSeek, Qwen, etc.
        mes = mes.replace(/<think\b[^>]*>([\s\S]*?)<\/think>/gi, '');

        // If ST stored reasoning in extra.reasoning and it bled into mes, strip it
        const extraReasoning = /** @type {any} */ (msg).extra?.reasoning;
        if (extraReasoning && typeof extraReasoning === 'string' && mes.includes(extraReasoning)) {
            mes = mes.replace(extraReasoning, '');
        }

        mes = mes.trim();

        if (mes) { narrativeBlocks.unshift(mes); foundCount++; }
    }
    return narrativeBlocks.join('\n\n');
}

// ── Generation-ended handler ───────────────────────────────────────────────────

/** In-memory counter: how many generations have fired since the agent last ran. Resets on chat change. */
let _routerAutoTick = 0;

/**
 * Accumulates keyword-triggered entry IDs across throttled generations so the
 * agent receives the full set (not just the current turn) when it finally fires.
 * Reset whenever the agent runs or the chat changes.
 */
let _pendingKeywordTriggered = [];

/** Call this whenever the active chat changes so the interval counter and accumulator restart.
 * @param {boolean} [clearKeywordPool] - Pass true only when actually switching to a different chat.
 */
export function resetRouterTick(clearKeywordPool = false) {
    _routerAutoTick = 0;
    _pendingKeywordTriggered = [];
    // Keyword-activated entries are transient (they expire when the keyword leaves the scan window).
    // Only clear on a real chat change, not on same-chat reloads (swipe, regenerate).
    if (clearKeywordPool) {
        const s = getSettings();
        if (s.keywordActivatedKeys?.length) {
            s.keywordActivatedKeys = [];
        }
    }
}

/**
 * Fires on GENERATION_ENDED. Triggers the state model pass.
 * runStateModelPass is resolved via the module import below to avoid
 * a hard circular dep — it will be a direct import once memo-processor.js exists.
 */
export async function onGenerationEnded() {
    const settings = getSettings();
    const isStateRunning = typeof globalThis._rpgStateModelRunning === 'function' && globalThis._rpgStateModelRunning();

    console.log(
        `%c[RPG Tracker Hooks] onGenerationEnded entered%c\n` +
        `settings.enabled: ${settings.enabled}\n` +
        `settings.paused: ${settings.paused}\n` +
        `isStateRunning: ${isStateRunning}`,
        'color: #ff9900; font-weight: bold; background: #222; padding: 2px 5px; border-radius: 3px;',
        'color: inherit;'
    );

    if (!settings.enabled || settings.paused || isStateRunning) return;

    const ctx = SillyTavern.getContext();
    const { chat } = ctx;
    const combinedNarrative = getNarrativeBlocks(chat, -1, !!settings.routerIncludeHidden);

    console.log(
        `%c[RPG Tracker Hooks] post-early exits%c\n` +
        `combinedNarrative: "${(combinedNarrative || '').slice(0, 100)}..."\n` +
        `chat length: ${chat ? chat.length : 0}`,
        'color: #ff6600; font-weight: bold; background: #222; padding: 2px 5px; border-radius: 3px;',
        'color: inherit;'
    );

    if (!combinedNarrative) return;

    // ── Swipe detection ────────────────────────────────────────────────────────
    // A right swipe (regenerate) is identified by swipe_id > 0 on the last message.
    // When the toggle is on, roll back both systems BEFORE the new pass runs so
    // the incoming generation writes onto the restored state, not the old one.
    const lastMsg = chat[chat.length - 1];
    const isSwipe = lastMsg && typeof lastMsg.swipe_id === 'number' && lastMsg.swipe_id > 0;

    console.log(
        `%c[RPG Tracker Hooks] Swipe Check Outcome%c\n` +
        `lastMsg exists: ${!!lastMsg}\n` +
        `lastMsg.swipe_id: ${lastMsg ? lastMsg.swipe_id : 'n/a'} (type: ${lastMsg ? typeof lastMsg.swipe_id : 'n/a'})\n` +
        `isSwipe: ${isSwipe}\n` +
        `routerAutoRollbackOnSwipe toggle: ${settings.routerAutoRollbackOnSwipe}`,
        'color: #00ccff; font-weight: bold; background: #222; padding: 2px 5px; border-radius: 3px;',
        'color: inherit;'
    );

    if (isSwipe && settings.routerAutoRollbackOnSwipe) {
        console.log('%c[RPG Tracker Hooks] Executing Auto-Rollback on Swipe...', 'color: #ff3330; font-weight: bold;');

        // 1. State Tracker rollback: restore to the memo from before the last generation.
        //    memoHistory[0] = live state after last gen, memoHistory[1] = state before it.
        if (settings.memoHistory && settings.memoHistory.length > 1) {
            const beforeShiftLen = settings.memoHistory.length;
            const previousMemo = settings.memoHistory[1];
            // Remove the generation that's being replaced
            settings.memoHistory.shift();
            settings.currentMemo = settings.memoHistory[0] ?? previousMemo;
            settings.historyIndex = 0;
            console.log(`[RPG Tracker Hooks] State Tracker rolled back. Length went from ${beforeShiftLen} to ${settings.memoHistory.length}. New currentMemo size: ${settings.currentMemo.length} chars.`);
            // Notify the UI
            if (typeof globalThis._rpgSyncMemoView === 'function') globalThis._rpgSyncMemoView();
        } else {
            console.warn('[RPG Tracker Hooks] State Tracker rollback skipped: memoHistory is empty or too short.', settings.memoHistory);
        }

        // 2. Lorebook Agent rollback: restore the most recent agent pass snapshot.
        if ((settings.routerHistory || []).length > 0) {
            console.log(`[RPG Tracker Hooks] Lorebook Agent rollback starting. History length: ${settings.routerHistory.length}`);
            const ok = await rollbackRouterPass(0);
            console.log('[RPG Tracker Hooks] Lorebook Agent rollback result:', ok ? 'success' : 'failed or nothing to restore');
        } else {
            console.warn('[RPG Tracker Hooks] Lorebook Agent rollback skipped: routerHistory is empty.');
        }
    }
    // ── End swipe detection ────────────────────────────────────────────────────

    if (settings.debugMode) console.log("[RPG Tracker] Assistant generation ended. Running keyword scanner...");

    // Step 1: Scan assistant output for entry keywords and activate matches immediately.
    // Must run before the state model pass and on EVERY generation, regardless of throttle,
    // so entries are never one turn behind the narrator even when the agent is skipped.
    // Skipped when routerNativeKeywordActivation is enabled (native ST system handles keywords).
    if (settings.routerEnabled && !settings.routerNativeKeywordActivation) {
        const thisGenTriggered = await scanAssistantOutputForKeywords(combinedNarrative);
        if (thisGenTriggered.length > 0) {
            // Accumulate across throttled turns — deduplicate so IDs are not repeated.
            const accumulated = new Set([..._pendingKeywordTriggered, ...thisGenTriggered]);
            _pendingKeywordTriggered = [...accumulated];
            if (settings.debugMode) {
                console.log("[RPG Tracker] Keyword scanner activated entries:", thisGenTriggered, "| Pending total:", _pendingKeywordTriggered.length);
            }

            // Trigger UI refresh
            if (typeof globalThis._rpgRenderRouterUI === 'function') {
                globalThis._rpgRenderRouterUI();
            }
        }
    }

    if (settings.debugMode) console.log("[RPG Tracker] Triggering State Model pass...", combinedNarrative);

    // Step 2: State Tracker pass.
    if (typeof globalThis._rpgRunStateModelPass === 'function') {
        await globalThis._rpgRunStateModelPass(combinedNarrative);
    }

    // Step 3: Run-every throttle — only fire the Lorebook Agent every N auto-generations.
    _routerAutoTick++;
    const runEvery = settings.routerRunEvery || 1;
    if (_routerAutoTick < runEvery) return;
    _routerAutoTick = 0;

    // Step 4: Lorebook Agent pass — passes the full accumulated set of keyword-triggered IDs
    // from all throttled turns since the last agent run (not just the current generation).
    const triggeredForAgent = [..._pendingKeywordTriggered];
    _pendingKeywordTriggered = []; // reset accumulator now that the agent is about to process them
    await runRouterPass(combinedNarrative, null, null, false, triggeredForAgent);
}
