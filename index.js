import { EXAMPLES, COLOR_EXAMPLES, DEFAULT_STOCK_PROMPTS, RT_PROMPTS, BLOCK_ICONS, BLOCK_ORDER, PAGE_SIZE, NO_PAGINATE, QUESTS_NARRATOR_MODERN, QUESTS_NARRATOR_LEGACY } from './constants.js';
import { MODULE_NAME, DEFAULT_MODULES, getSettings, getBarBackground, migrateCustomFields, saveChatState, saveProfile, deleteProfile } from './state-manager.js';
import { sendStateRequest, fetchOllamaModels, fetchOpenAIModels, testOpenAIConnection, getConnectionProfiles, getCurrentCompletionPreset, setCompletionPreset } from './llm-client.js';
import { getDiceToolName, getDiceCommandName, getDiceCommandAliases, doDiceRoll, registerDiceFunctionTool, registerDiceSlashCommand, installInterceptor, getNarrativeBlocks, onGenerationEnded, resetRouterTick } from './narrative-hooks.js';
import { deduplicateMemo, mergeMemo, computeDelta, escapeHtml, escapeRegex, highlightParens, cleanToolCallMessage, getLastUserAction, buildLorebookContext, buildModulesInstructionText, buildModuleFormatInstruction, parseQuestsFromMemo, syncQuestsFromMemo, syncQuestsToMemo, writeQuestsToMemo, getQuestMood } from './memo-processor.js';
import { renderSubFieldByRule, tryRenderMarker, renderCustomBlockLine, stripMemoHtml, escapeHtmlWithColor, parseMemoBlocks, getPageSize, loadCollapsed, saveCollapsed, loadDetached, saveDetached, blockToItems, renderMemoAsCards, renderQuestLog, renderLorebookTerminal } from './renderer.js';
import { registerLogQuestTool, checkQuestDeadlines } from './quests.js';
import { initializeDebugViewer, toggleDebugViewer } from './debug-viewer.js';
import { runRouterPass, rollbackRouterPass, reapplyRouterPass, getLorebookManifest, deleteLorebookEntry, disableManagedEntries } from './router.js';

    // Capture the folder name dynamically from the module URL so it works regardless of what the user names the folder
    const FOLDER_NAME = (function () {
        try {
            const scripts = /** @type {HTMLScriptElement[]} */ (Array.from(document.querySelectorAll('script[src]')));
            const myScript = scripts.find(s => s.src.includes('SillyTavern-FatbodyDnDFramework') || s.src.includes('SillyTavern-RPGStateTracker'));
            if (myScript) {
                const match = myScript.src.match(/third-party\/([^\/]+)\//);
                if (match) return decodeURIComponent(match[1]);
            }
        } catch (e) { }
        return 'SillyTavern-FatbodyDnDFramework';
    })();

    let _stateModelRunning = false;
    let _stateController = null;   // To abort ongoing state updates
    let _currentChatId = null;
    let _prefixDeriveTimer = null; // Pending CHAT_CHANGED → prefix-derivation timer
    let themeUndoStack = [];
    let _pillDeselectHandler = null;
    let renderRouterUI = null;

    /**
     * Centralized save helper that handles both global settings and
     * the Chat-Linked State for the active chat.
     */
    function saveSettings() {
        const s = getSettings();
        const ctx = SillyTavern.getContext();
        ctx.saveSettingsDebounced();
        if (s.chatLinkEnabled && _currentChatId) {
            saveChatState(_currentChatId);
        }
        syncOnboardingUI();
    }

    /**
     * Synchronizes the onboarding UI elements with the current settings state.
     * This is called whenever a setting is saved to ensure both the main sidebar
     * and the tracker's onboarding screen stay perfectly in sync.
     */
    function syncOnboardingUI() {
        const s = getSettings();
        const onboarding = document.querySelector('.rt-empty');
        if (!onboarding) return;

        // RNG Mode Sync
        const rngHybrid = /** @type {HTMLInputElement|null} */ (onboarding.querySelector('#rt_onboarding_rng_hybrid'));
        const rngLegacy = /** @type {HTMLInputElement|null} */ (onboarding.querySelector('#rt_onboarding_rng_legacy'));
        if (rngHybrid && rngLegacy) {
            rngHybrid.checked = !!s.diceFunctionTool;
            rngLegacy.checked = !s.diceFunctionTool;
        }

        // Quests Enabled Sync
        const questsEnabled = /** @type {HTMLInputElement|null} */ (onboarding.querySelector('#rt_onboarding_quests_enabled'));
        if (questsEnabled) {
            const isEnabled = s.syspromptModules?.quests !== false;
            questsEnabled.checked = isEnabled;
            const optionsDiv = /** @type {HTMLElement|null} */ (onboarding.querySelector('#rt_onboarding_quest_options'));
            if (optionsDiv) optionsDiv.style.display = isEnabled ? 'flex' : 'none';
        }

        // Deadlines Sync
        const deadlines = /** @type {HTMLInputElement|null} */ (onboarding.querySelector('#rt_onboarding_quests_deadlines'));
        if (deadlines) deadlines.checked = !!s.syspromptModules?.questsDeadlines;
        const frustrationWrapOnb = /** @type {HTMLElement|null} */ (onboarding.querySelector('#rt_onboarding_quests_frustration_wrap'));
        if (frustrationWrapOnb) frustrationWrapOnb.style.display = deadlines?.checked ? '' : 'none';

        // Frustration levels Sync
        const frustration = /** @type {HTMLInputElement|null} */ (onboarding.querySelector('#rt_onboarding_quests_frustration'));
        if (frustration) frustration.checked = !!s.syspromptModules?.questsFrustration;

        // Difficulty Sync
        const difficulty = /** @type {HTMLInputElement|null} */ (onboarding.querySelector('#rt_onboarding_quests_difficulty'));
        if (difficulty) difficulty.checked = !!s.syspromptModules?.questsDifficulty;

        // Quest Processing Mode Sync
        const qmStandard = /** @type {HTMLInputElement|null} */ (onboarding.querySelector('#rt_onboarding_quest_standard'));
        const qmLegacy = /** @type {HTMLInputElement|null} */ (onboarding.querySelector('#rt_onboarding_quest_legacy'));
        if (qmStandard && qmLegacy) {
            qmStandard.checked = !s.questLegacyMode;
            qmLegacy.checked = !!s.questLegacyMode;
        }

        // Optional Components Sync
        const mods = { 'loot': '#rt_onboarding_mod_loot', 'random_events': '#rt_onboarding_mod_random_events', 'resting': '#rt_onboarding_mod_resting' };
        for (const [key, id] of Object.entries(mods)) {
            const cb = /** @type {HTMLInputElement|null} */ (onboarding.querySelector(id));
            if (cb) cb.checked = !!s.syspromptModules?.[key];
        }

        // Custom Sysprompt Sync
        const customSyspromptCb = /** @type {HTMLInputElement|null} */ (onboarding.querySelector('#rt_onboarding_custom_sysprompt'));
        if (customSyspromptCb) customSyspromptCb.checked = !!s.customSysprompt;
    }
    // ── Renderer / navigation state ──
    let _historyViewIndex = -1;    // -1 = live, 0 = most recent snapshot, higher = older
    let _renderedViewActive = false;
    const _sectionPages = {};

    // ── Lorebook Agent nav state ──
    /** @type {Array<{prePassSnapshot: object, postPassState: object}>} */
    let _loreRedoStack = [];  // in-memory; cleared when a new agent pass starts

    /**
     * Returns true if `bookName` belongs to the given `prefix`.
     * A book belongs when it is EITHER the prefix itself OR exactly
     * `prefix + '_' + <single-word suffix>` — the suffix must contain
     * no underscores so that "Assistant" never accidentally matches
     * "Assistant_2026_05_13_NPCs" (which belongs to a different, longer prefix).
     * @param {string} bookName
     * @param {string} prefix
     */
    function bookBelongsToPrefix(bookName, prefix) {
        if (!prefix) return false;
        if (bookName === prefix) return true;
        const rest = bookName.startsWith(prefix + '_') ? bookName.slice(prefix.length + 1) : null;
        return rest !== null && !rest.includes('_');
    }

    /**
     * Activates every lorebook that belongs to the current campaign in SillyTavern's
     * world-info system (equivalent to toggling them ON in the World Info panel).
     * Uses the full ST lorebook registry filtered by campaign prefix, so keyless
     * lorebooks that never appear in activeRouterKeys are still caught.
     * Returns the count of books activated.
     */
    async function activateCampaignBooks() {
        const s = getSettings();
        const ctx = SillyTavern.getContext();
        if (typeof ctx.executeSlashCommandsWithOptions !== 'function') return 0;

        const prefix = s.routerCampaignPrefix || '';
        // No valid prefix → do nothing. Never touch lorebook state with an
        // unknown / ambiguous prefix or we risk activating books from other sessions.
        if (!prefix) return 0;

        // Flush ST registry so freshly-written books are visible
        if (typeof ctx.updateWorldInfoList === 'function') {
            try { await ctx.updateWorldInfoList(); } catch (_) {}
        }

        // Get all known lorebook names then filter to this campaign
        let allNames = [];
        if (typeof ctx.getWorldInfoNames === 'function') {
            try { allNames = await ctx.getWorldInfoNames(); } catch (_) {}
        }

        const bookNames = allNames.filter(n => bookBelongsToPrefix(n, prefix));

        // Deactivate every managed book that does NOT belong to the current prefix.
        // A "managed" book is any name that looks like "<something>_<SingleWordSuffix>",
        // i.e. it has exactly one underscore-separated word at the end with no digits —
        // same shape as auto-generated lorebooks. This safely ignores user's own books.
        const toDeactivate = allNames.filter(n => {
            if (bookNames.includes(n)) return false; // current session → keep
            const lastUs = n.lastIndexOf('_');
            if (lastUs <= 0) return false;
            const tail = n.slice(lastUs + 1);
            return /^[A-Za-z]+$/.test(tail); // looks like a managed book
        });
        for (const name of toDeactivate) {
            await ctx.executeSlashCommandsWithOptions(`/world state=off silent=true "${name}"`);
        }

        for (const name of bookNames) {
            await ctx.executeSlashCommandsWithOptions(`/world state=on silent=true "${name}"`);
        }
        return bookNames.length;
    }



    // ── Chat-Linked State (deferred from state-manager.js — touches DOM + _historyViewIndex) ──

    function refreshQuestLegacyPrompt(s) {
        let prompt = DEFAULT_STOCK_PROMPTS.quests_legacy;
        if (!s.syspromptModules?.questsDeadlines && !s.syspromptModules?.questsFrustration) {
            prompt = prompt.replace(/  DEADLINE:.*\n/g, '');
            prompt = prompt.replace(/  FRUSTRATION_COEFF:.*\n/g, '');
            prompt = prompt.replace(/  MOOD:.*\n/g, '');
            prompt = prompt.replace(/- DEADLINE \/ FRUSTRATION_COEFF:.*\n/g, '');
            prompt = prompt.replace(/- FRUSTRATION_COEFF:.*\n/g, '');
            prompt = prompt.replace(/- The MOOD field.*\n/g, '');
        } else {
            if (!s.syspromptModules?.questsDeadlines) {
                prompt = prompt.replace(/  DEADLINE:.*\n/g, '');
                prompt = prompt.replace(/- DEADLINE.*\n/g, '');
            }
            if (!s.syspromptModules?.questsFrustration) {
                prompt = prompt.replace(/  FRUSTRATION_COEFF:.*\n/g, '');
                prompt = prompt.replace(/- FRUSTRATION_COEFF:.*\n/g, '');
                prompt = prompt.replace(/  MOOD:.*\n/g, '');
                prompt = prompt.replace(/- The MOOD field.*\n/g, '');
            }
        }
        if (!s.syspromptModules?.questsDifficulty) {
            prompt = prompt.replace(/  DIFFICULTY:.*\n/g, '');
            prompt = prompt.replace(/- For difficulty, use the DIFFICULTY marker.*\n/g, '');
        }
        if (!s.stockPrompts) s.stockPrompts = {};
        // Write ONLY to the legacy slot — the runtime swap in buildModulesInstructionText
        // will read from here when questLegacyMode is active. Never touch stockPrompts.quests.
        s.stockPrompts.quests_legacy = prompt;
    }

    /**
     * Restore a previously saved chat state into the live settings.
     * Returns true if a saved state was found, false if no state existed (clean slate).
     * @param {string} chatId
     * @returns {boolean}
     */
    function loadChatState(chatId) {
        if (!chatId) return false;
        const s = getSettings();
        const saved = s.chatStates?.[chatId];
        if (!saved) return false;

        s.currentMemo  = saved.currentMemo  ?? '';
        s.memoHistory  = saved.memoHistory  ?? [];
        s.lastDelta    = saved.lastDelta    ?? '';
        if (saved.modules)      s.modules      = { ...s.modules, ...saved.modules };
        if (saved.blockOrder)   s.blockOrder   = JSON.parse(JSON.stringify(saved.blockOrder));
        if (saved.stockPrompts) s.stockPrompts = JSON.parse(JSON.stringify(saved.stockPrompts));
        if (saved.customFields) s.customFields = JSON.parse(JSON.stringify(saved.customFields));
        // quests are derived from currentMemo, do not load independently
        s.quests = [];
        s.historyIndex = saved.historyIndex ?? -1;
        
        s.activeRouterKeys = JSON.parse(JSON.stringify(saved.activeRouterKeys || []));
        s.routerLog        = JSON.parse(JSON.stringify(saved.routerLog || []));
        // Don't restore routerCampaignPrefix from per-chat saved state — the prefix
        // is fully derivable from the chat ID and must be re-derived live by
        // onChatChanged. Restoring a stale value (e.g. a bare "Assistant" from
        // a previous buggy run) would cause greedy lorebook matching.

        _historyViewIndex = -1;
        
        // currentMemo is the source of truth for quest state.
        // Derive settings.quests FROM it rather than injecting quests BACK INTO the memo.
        syncQuestsFromMemo(s.currentMemo);

        const dp = document.getElementById('rpg-tracker-delta-content');
        if (dp) dp.innerHTML = s.lastDelta || '<span class="delta-empty">No changes yet.</span>';

        refreshOrderList();
        syncMemoView();
        
        // Refresh Lorebook Agent UI
        if (typeof renderRouterUI === 'function') {
            renderRouterUI();
        }

        // Patch any managed entries that don't yet have disable:true so ST's
        // native keyword scanner cannot inject them on user-message send.
        if (s.routerEnabled) {
            disableManagedEntries().catch(e => console.warn('[RPG Tracker] disableManagedEntries on chat change failed:', e));
        }

        return true;
    }

    /**
     * Installs a transient prompt interceptor to inject active lore keys
     * into the main narrator's prompt. This is non-mutating and clean.
     */
    /**
     * Updates the persistent SillyTavern extension prompt with the currently active lore.
     * This is the preferred method for older/stable ST versions.
     */
    async function refreshExtensionPrompt() {
        const ctx = SillyTavern.getContext();
        const { setExtensionPrompt } = ctx;
        if (typeof setExtensionPrompt !== 'function') return;

        const s = getSettings();
        if (!s.routerEnabled || !s.activeRouterKeys?.length) {
            setExtensionPrompt('rpg_tracker_lore', '', 0, 0); // Clear if disabled
            return;
        }

        try {
            let injectedContext = "";
            const books = {};
            for (const k of s.activeRouterKeys) {
                const [bookName] = k.split('::');
                if (!books[bookName]) books[bookName] = await ctx.loadWorldInfo(bookName);
            }

            for (const k of s.activeRouterKeys) {
                const [bookName, uid] = k.split('::');
                const entry = books[bookName]?.entries?.[uid];
                if (entry && entry.content) {
                    injectedContext += `### [${entry.key?.[0] || entry.comment || uid}]\n${entry.content}\n\n`;
                }
            }

            if (injectedContext) {
                const routerBlock = `## ROUTER ACTIVE LORE\n${injectedContext.trim()}`;
                // Set as an extension prompt at the end of the system block (Position 0, but ST handles placement)
                setExtensionPrompt('rpg_tracker_lore', routerBlock, 0, 0); 
            } else {
                setExtensionPrompt('rpg_tracker_lore', '', 0, 0);
            }
        } catch (e) {
            console.error("[Router Agent] Failed to update extension prompt:", e);
        }
    }

    function installRouterInterceptor() {
        const ctx = SillyTavern.getContext();
        const { addPromptManagerInterceptor, addChatInterceptor, addInterceptor } = ctx;

        // Try modern interceptors first
        if (typeof addPromptManagerInterceptor === 'function') {
            addPromptManagerInterceptor(async (prompt) => {
                const s = getSettings();
                if (!s.routerEnabled || !s.activeRouterKeys?.length) return;
                // Reuse the same logic but for the prompt object
                let injectedContext = "";
                const books = {};
                for (const k of s.activeRouterKeys) {
                    const [bookName] = k.split('::');
                    if (!books[bookName]) books[bookName] = await ctx.loadWorldInfo(bookName);
                }
                for (const k of s.activeRouterKeys) {
                    const [bookName, uid] = k.split('::');
                    const entry = books[bookName]?.entries?.[uid];
                    if (entry && entry.content) injectedContext += `### [${entry.key?.[0] || entry.comment || uid}]\n${entry.content}\n\n`;
                }
                if (injectedContext) {
                    const routerBlock = `\n## ROUTER ACTIVE LORE\n${injectedContext.trim()}\n`;
                    const sysPart = prompt.find(p => p.role === 'system');
                    if (sysPart) sysPart.content += routerBlock;
                    else prompt.unshift({ role: 'system', content: routerBlock });
                }
            });
        } else {
            // Fallback to the persistent extension prompt system
            console.log('[RPG Tracker] Interceptors not available. Using setExtensionPrompt.');
            refreshExtensionPrompt();
            
            // Re-refresh on important events
            ctx.eventSource.on(ctx.eventTypes.CHARACTER_MOUNTED, () => refreshExtensionPrompt());
            ctx.eventSource.on(ctx.eventTypes.CHAT_CHANGED, () => refreshExtensionPrompt());
        }
    }

    /**
     * Sanitizes a ST chat ID into a filesystem/lorebook-safe prefix.
     * The chat ID is already unique per session, so it's used verbatim
     * with only unsafe characters replaced.
     * @param {string} chatId
     * @returns {string}
     */
    function derivePrefixFromChatId(chatId) {
        if (!chatId) return '';
        return String(chatId).replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    }

    /**
     * Called on CHAT_CHANGED. Saves the departing chat's state,
     * then loads the arriving chat's state — or resets the memo if
     * this is a new/unseen chat (no saved state).
     * @param {string} newChatId
     */
    function onChatChanged(newChatId) {
        const s = getSettings();

        const oldChatId = _currentChatId;
        _currentChatId  = newChatId || null;

        // Reset the run-every tick so the agent fires promptly on the first generation of each chat
        resetRouterTick();

        // Auto-activate and prefix logic run regardless of chatLinkEnabled.
        // Always re-derive the prefix from the chat ID so stale saved data never
        // causes the wrong session's lorebooks to activate.
        if (s.routerEnabled && newChatId) {
            // Cancel any pending prefix-derivation from a previous CHAT_CHANGED
            // so a transient chat ID (e.g. mid-rename) can't sneak through.
            if (_prefixDeriveTimer) clearTimeout(_prefixDeriveTimer);
            _prefixDeriveTimer = setTimeout(async () => {
                _prefixDeriveTimer = null;
                // Bail if a newer chat change has come in while we were waiting.
                if (newChatId !== _currentChatId) return;

                const prefix = derivePrefixFromChatId(newChatId);
                const s2 = getSettings();
                const prefixDisplay = document.getElementById('rpg_tracker_router_prefix_display');

                if (!prefix) {
                    // Chat ID doesn't have a usable timestamp (transient ST state
                    // during rename, or unusual format). Clear the live prefix and
                    // do NOT touch any lorebook state.
                    s2.routerCampaignPrefix = '';
                    if (prefixDisplay) prefixDisplay.textContent = '—';
                    return;
                }

                s2.routerCampaignPrefix = prefix;
                if (prefixDisplay) prefixDisplay.textContent = prefix;

                const ctx = SillyTavern.getContext();
                if (typeof ctx.updateWorldInfoList === 'function') await ctx.updateWorldInfoList().catch(() => {});
                let allNames = [];
                if (typeof ctx.getWorldInfoNames === 'function') {
                    try { allNames = await ctx.getWorldInfoNames(); } catch (_) {}
                }
                const matchingBooks = allNames.filter(n => bookBelongsToPrefix(n, prefix));

                if (!s2.chatStates) s2.chatStates = {};
                if (!s2.chatStates[newChatId]) s2.chatStates[newChatId] = {};
                s2.chatStates[newChatId].campaignBooks = matchingBooks;
                saveSettings();
                if (s2.chatLinkEnabled && _currentChatId) saveChatState(_currentChatId);
                // Always call activateCampaignBooks so previous-session books get
                // deactivated even when the new chat has no lorebooks yet.
                activateCampaignBooks().catch(() => {});
            }, 800);
        }

        if (!s.chatLinkEnabled) {
            updateChatLinkUI();
            return;
        }

        if (oldChatId) saveChatState(oldChatId);

        const found = loadChatState(newChatId);
        if (!found) {
            s.currentMemo  = '';
            s.memoHistory  = [];
            s.lastDelta    = '';
            s.activeRouterKeys = [];
            s.routerLog    = [];
            
            _historyViewIndex = -1;

            const dp = document.getElementById('rpg-tracker-delta-content');
            if (dp) dp.innerHTML = '<span class="delta-empty">No changes yet.</span>';

            updateUIMemo('');
            refreshRenderedView();
        }

        updateChatLinkUI();
    }


    async function openThemeWizard(isIteration = false) {
        const settings = getSettings();

        const systemPrompt = `You are a CSS theme designer for a dark-UI RPG tracker panel.
The user will describe a visual theme in plain language. You must output ONLY a valid JSON object with these exact keys and CSS values:

{
  "--rt-custom-bg": "<CSS background value, usually rgba()>",
  "--rt-custom-blur": "<blur() value, e.g. blur(12px)>",
  "--rt-custom-border": "<full CSS border, e.g. 1px solid #rrggbb>",
  "--rt-custom-text": "<primary text color, hex or rgba>",
  "--rt-custom-text-muted": "<secondary/dimmed text color>",
  "--rt-custom-font": "<font-family stack>",
  "--rt-custom-font-mono": "<monospace font-family stack>",
  "--rt-custom-accent": "<main accent/highlight color>",
  "--rt-custom-accent-dim": "<accent color at ~40% opacity, rgba()>",
  "--rt-custom-accent-bg": "<accent color at ~10-15% opacity, rgba()>",
  "--rt-custom-card-border": "<full CSS border for inner cards>",
  "--rt-custom-shadow": "<box-shadow value>",
  "--rt-custom-header-bg": "<header background, usually semi-transparent>",
  "--rt-custom-card-bg": "<card body background, semi-transparent>",
  "--rt-custom-card-header": "<card header background, semi-transparent>"
}

Rules:
- Output ONLY the JSON object. No markdown, no code fences, no explanation.
- All colors must be valid CSS. Prefer rgba() for backgrounds (allow transparency).
- Make the theme visually coherent and beautiful. Lean into the user's description creatively.
- Ensure text colors have sufficient contrast against the background for readability.`;

        const statusEl = document.getElementById('rpg_tracker_theme_wizard_status');
        const generateBtn = /** @type {HTMLButtonElement|null} */ (document.getElementById('rpg_tracker_theme_generate'));
        const iterateBtn = /** @type {HTMLButtonElement|null} */ (document.getElementById('rpg_tracker_theme_iterate'));

        const setStatus = (msg, isError = false) => {
            if (!statusEl) return;
            statusEl.style.display = 'block';
            statusEl.style.color = isError ? '#ff7777' : 'inherit';
            statusEl.textContent = msg;
        };

        const promptText = /** @type {HTMLTextAreaElement} */ (document.getElementById('rpg_tracker_theme_prompt'))?.value?.trim();
        if (!promptText) {
            setStatus(isIteration ? '⚠ Please describe the changes you want.' : '⚠ Please describe a theme first.', true);
            return;
        }

        const iterationContext = (isIteration && settings.customTheme)
            ? `\n\nCURRENT THEME STATE (JSON):\n${JSON.stringify(settings.customTheme, null, 2)}\n\nUser wants to CHANGE this theme as follows: ${promptText}`
            : `\n\nUser description: ${promptText}`;

        if (generateBtn) generateBtn.disabled = true;
        if (iterateBtn) iterateBtn.disabled = true;
        setStatus(isIteration ? '⚡ Refining theme.' : '⚡ Generating theme.');

        let raw = '';
        try {
            raw = await sendStateRequest(settings, systemPrompt, iterationContext);
        } catch (err) {
            setStatus(`❌ Request failed: ${err.message}`, true);
            if (generateBtn) generateBtn.disabled = false;
            if (iterateBtn) iterateBtn.disabled = false;
            return;
        }

        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
            setStatus('❌ AI did not return valid JSON. Try a different prompt or model.', true);
            if (generateBtn) generateBtn.disabled = false;
            if (iterateBtn) iterateBtn.disabled = false;
            return;
        }

        let vars;
        try {
            vars = JSON.parse(jsonMatch[0]);
        } catch (e) {
            setStatus('❌ Failed to parse AI response as JSON.', true);
            if (generateBtn) generateBtn.disabled = false;
            if (iterateBtn) iterateBtn.disabled = false;
            return;
        }

        const expected = [
            '--rt-custom-bg', '--rt-custom-blur', '--rt-custom-border',
            '--rt-custom-text', '--rt-custom-text-muted', '--rt-custom-font',
            '--rt-custom-font-mono', '--rt-custom-accent', '--rt-custom-accent-dim',
            '--rt-custom-accent-bg', '--rt-custom-card-border', '--rt-custom-shadow',
            '--rt-custom-header-bg', '--rt-custom-card-bg', '--rt-custom-card-header',
        ];
        const missing = expected.filter(k => !vars[k]);
        if (missing.length > 3) {
            setStatus(`❌ AI response is missing too many theme keys: ${missing.join(', ')}`, true);
            if (generateBtn) generateBtn.disabled = false;
            if (iterateBtn) iterateBtn.disabled = false;
            return;
        }

        if (settings.customTheme) {
            themeUndoStack.push(JSON.parse(JSON.stringify(settings.customTheme)));
            if (themeUndoStack.length > 20) themeUndoStack.shift();
        }
        settings.customTheme = vars;
        settings.trackerTheme = 'rt-theme-custom';
        saveSettings();
        applyCustomTheme(vars);

        document.querySelectorAll('.rpg-tracker-panel').forEach(p => {
            p.className = p.className.replace(/rt-theme-\S+/g, '').trim() + ' rt-theme-custom';
        });

        const sel = /** @type {HTMLSelectElement} */ (document.getElementById('rpg_tracker_theme_select'));
        if (sel) sel.value = 'rt-theme-custom';

        setStatus(isIteration ? '✅ Theme refined!' : '✅ Theme generated!');
        if (generateBtn) generateBtn.disabled = false;
        if (iterateBtn) iterateBtn.disabled = false;
        toastr['success'](isIteration ? 'Theme refined successfully!' : 'New theme generated and applied!', 'Theme Wizard');
        refreshSavedThemesList();
    }

    function refreshSavedThemesList() {
        const settings = getSettings();
        const container = document.getElementById('rpg_tracker_saved_themes_container');
        const list = document.getElementById('rpg_tracker_saved_themes_list');
        if (!container || !list) return;

        const entries = Object.entries(settings.savedThemes || {});
        if (entries.length === 0) {
            container.style.display = 'none';
            return;
        }

        container.style.display = 'block';
        list.innerHTML = '';

        entries.forEach(([name, vars]) => {
            const row = document.createElement('div');
            row.className = 'flex-container alignitemscenter gap-1';
            row.style.background = 'rgba(255,255,255,0.05)';
            row.style.padding = '4px 8px';
            row.style.borderRadius = '4px';

            const nameSpan = document.createElement('span');
            nameSpan.textContent = name;
            nameSpan.style.flex = '1';
            nameSpan.style.fontSize = '0.85em';
            nameSpan.style.cursor = 'pointer';
            nameSpan.className = 'interactable';
            nameSpan.title = 'Click to load this theme';
            nameSpan.addEventListener('click', () => {
                settings.customTheme = JSON.parse(JSON.stringify(vars));
                settings.trackerTheme = 'rt-theme-custom';
                saveSettings();
                applyCustomTheme(settings.customTheme);
                
                // Update UI
                const sel = /** @type {HTMLSelectElement} */ (document.getElementById('rpg_tracker_theme_select'));
                if (sel) sel.value = 'rt-theme-custom';
                document.querySelectorAll('.rpg-tracker-panel').forEach(p => {
                    p.className = p.className.replace(/rt-theme-\S+/g, '').trim() + ' rt-theme-custom';
                });
                
                const statusEl = document.getElementById('rpg_tracker_theme_wizard_status');
                if (statusEl) {
                    statusEl.style.display = 'block';
                    statusEl.style.color = 'inherit';
                    statusEl.textContent = `⚡ Loaded library theme: ${name}`;
                }
            });

            const delBtn = document.createElement('i');
            delBtn.className = 'fa-solid fa-trash-can interactable';
            delBtn.style.fontSize = '0.8em';
            delBtn.style.opacity = '0.5';
            delBtn.title = 'Delete theme';
            delBtn.addEventListener('click', () => {
                if (confirm(`Are you sure you want to delete the theme "${name}"?`)) {
                    delete settings.savedThemes[name];
                    saveSettings();
                    refreshSavedThemesList();
                    toastr['info'](`Deleted theme: ${name}`, 'Theme Library');
                }
            });

            row.appendChild(nameSpan);
            row.appendChild(delBtn);
            list.appendChild(row);
        });
    }

    function handleRecolor(barId, currentBg, targetEl) {
        if (!barId) return;

        document.getElementById('rt-recolor-popup')?.remove();

        const s = getSettings();
        const initialCfg = s.barColors?.[barId] ? JSON.parse(JSON.stringify(s.barColors[barId])) : null;
        
        let cfg = s.barColors?.[barId];
        if (!cfg) {
            const isHP = barId.endsWith(':HP') || barId.includes(':HPBAR') || barId.endsWith(':HP');
            let color = "#ff0000";
            const hexMatch = currentBg.match(/#[0-9a-fA-F]{3,8}/);
            if (hexMatch) color = hexMatch[0];
            
            if (isHP) {
                cfg = { mode: 'dynamic', color: '#00ffaa', color2: '#ff5555' };
            } else {
                cfg = { mode: 'solid', color: color };
            }
        } else if (typeof cfg === 'string') {
            cfg = { mode: 'solid', color: cfg };
        }

        const applyLive = () => {
            const ss = getSettings();
            if (!ss.barColors) ss.barColors = {};
            ss.barColors[barId] = { ...cfg };
            saveSettings();
            refreshRenderedView();
        };

        const popup = document.createElement('div');
        popup.id = 'rt-recolor-popup';
        popup.style.cssText = `
            position: fixed; z-index: 999999; background: #252535; border: 1px solid rgba(255,255,255,0.3);
            border-radius: 12px; padding: 14px; box-shadow: 0 12px 40px rgba(0,0,0,0.75);
            backdrop-filter: blur(16px); color: #ffffff !important; font-family: sans-serif; width: 240px;
        `;

        const renderContent = () => {
            popup.innerHTML = `
                <div style="display:flex; flex-direction:column; gap:12px;">
                    <div style="font-size:0.85em; font-weight:bold; opacity:0.8; letter-spacing:0.05em; text-transform:uppercase;">Recolor Bar</div>
                    
                    <div style="display:flex; background:rgba(0,0,0,0.3); border-radius:6px; padding:2px;">
                        <button class="mode-btn" data-mode="solid" style="flex:1; border:none; background:${cfg.mode==='solid'?'rgba(255,255,255,0.15)':'transparent'}; color:white; font-size:0.75em; padding:4px; border-radius:4px; cursor:pointer;">Solid</button>
                        <button class="mode-btn" data-mode="gradient" style="flex:1; border:none; background:${cfg.mode==='gradient'?'rgba(255,255,255,0.15)':'transparent'}; color:white; font-size:0.75em; padding:4px; border-radius:4px; cursor:pointer;">Gradient</button>
                        <button class="mode-btn" data-mode="dynamic" style="flex:1; border:none; background:${cfg.mode==='dynamic'?'rgba(255,255,255,0.15)':'transparent'}; color:white; font-size:0.75em; padding:4px; border-radius:4px; cursor:pointer;">Dynamic</button>
                    </div>

                    <div id="recolor-controls" style="display:flex; align-items:center; gap:10px; min-height:40px;">
                        ${cfg.mode === 'dynamic' ? `
                            <span style="font-size:0.8em; opacity:0.7;">HP-based coloring active</span>
                        ` : `
                            <input id="color1" type="color" value="${cfg.color}" style="width:40px; height:30px; border:1px solid rgba(255,255,255,0.2); border-radius:4px; cursor:pointer; background:rgba(255,255,255,0.1);" />
                            ${cfg.mode === 'gradient' ? `
                                <span style="font-size:1.2em; opacity:0.5;">&rarr;</span>
                                <input id="color2" type="color" value="${cfg.color2 || cfg.color}" style="width:40px; height:30px; border:1px solid rgba(255,255,255,0.2); border-radius:4px; cursor:pointer; background:rgba(255,255,255,0.1);" />
                            ` : ''}
                        `}
                    </div>

                    <div style="display:flex; gap:6px; margin-top:4px;">
                        <button id="recolor-ok" style="flex:1.5; padding:6px; border-radius:6px; border:none; background:var(--rt-accent-bg, #00ffaa); color:#000; font-weight:bold; cursor:pointer; font-size:0.85em;">OK</button>
                        <button id="recolor-cancel" style="flex:1; padding:6px; border-radius:6px; border:1px solid rgba(255,255,255,0.2); background:rgba(255,255,255,0.05); color:white; cursor:pointer; font-size:0.85em;">Cancel</button>
                        <button id="recolor-reset" style="flex:1; padding:6px; border-radius:6px; border:1px solid rgba(255,255,255,0.2); background:rgba(255,255,255,0.05); color:white; cursor:pointer; font-size:0.85em;" title="Reset to defaults">Reset</button>
                    </div>
                </div>
            `;

            popup.querySelectorAll('.mode-btn').forEach(btn => {
                btn.addEventListener('click', () => {
                    cfg.mode = /** @type {HTMLElement} */ (btn).dataset.mode;
                    if (cfg.mode === 'gradient' && !cfg.color2) cfg.color2 = cfg.color;
                    applyLive();
                    renderContent();
                });
            });

            const c1 = popup.querySelector('#color1');
            const c2 = popup.querySelector('#color2');
            if (c1) c1.addEventListener('input', (e) => { cfg.color = /** @type {HTMLInputElement} */ (e.target).value; applyLive(); });
            if (c2) c2.addEventListener('input', (e) => { cfg.color2 = /** @type {HTMLInputElement} */ (e.target).value; applyLive(); });

            popup.querySelector('#recolor-ok').addEventListener('click', () => {
                applyLive();
                popup.remove();
            });

            popup.querySelector('#recolor-cancel').addEventListener('click', () => {
                const ss = getSettings();
                if (initialCfg) ss.barColors[barId] = initialCfg;
                else delete ss.barColors[barId];
                saveSettings();
                refreshRenderedView();
                popup.remove();
            });

            popup.querySelector('#recolor-reset').addEventListener('click', () => {
                const ss = getSettings();
                if (ss.barColors) delete ss.barColors[barId];
                saveSettings();
                refreshRenderedView();
                popup.remove();
            });
        };

        renderContent();
        document.body.appendChild(popup);
        
        const rect = targetEl.getBoundingClientRect();
        let left = rect.left + rect.width / 2 - 120;
        let top = rect.top - popup.offsetHeight - 12;
        left = Math.max(8, Math.min(left, window.innerWidth - 248));
        if (top < 8) top = rect.bottom + 12;
        popup.style.left = left + 'px';
        popup.style.top = top + 'px';

        const onOutside = (e) => {
            if (!popup.contains(e.target)) {
                popup.remove();
                document.removeEventListener('mousedown', onOutside);
            }
        };

        setTimeout(() => document.addEventListener('mousedown', onOutside), 50);
    }

    function handleCategorySettings(tag, targetEl) {
        const existing = document.getElementById('rt-cat-settings-popup');
        if (existing) {
            const oldTag = existing.getAttribute('data-tag');
            existing.remove();
            if (oldTag === tag) return;
        }
        const s = getSettings();
        if (!s.categoryRenderOptions) s.categoryRenderOptions = {};
        if (!s.categoryRenderOptions[tag]) {
            const noBullets = (tag === 'TIME' || tag === 'XP' || tag === 'QUESTS' || tag === 'SPELLS' || tag === 'CHARACTER' || tag === 'PARTY' || tag === 'COMBAT' || tag === 'ABILITIES');
            s.categoryRenderOptions[tag] = {
                fontSize: (tag === 'TIME' || tag === 'INVENTORY') ? 12 : 13,
                italic: false,
                bold: false,
                bullets: !noBullets,
                bulletStyle: tag === 'INVENTORY' ? '▪' : '•',
                bulletColor: 'inherit',
                fontFamily: 'inherit',
                textColor: 'inherit'
            };
        } else if (s.categoryRenderOptions[tag].bullets === undefined) {
            // Migration for existing settings: default specific categories to no bullets
            if (tag === 'TIME' || tag === 'XP' || tag === 'QUESTS' || tag === 'SPELLS' || tag === 'CHARACTER' || tag === 'PARTY' || tag === 'COMBAT' || tag === 'ABILITIES') {
                s.categoryRenderOptions[tag].bullets = false;
            } else {
                s.categoryRenderOptions[tag].bullets = true;
            }
        }
        const cfg = s.categoryRenderOptions[tag];
        const initialCfg = JSON.stringify(cfg);

        let applyTimeout = null;
        const applyLive = () => {
            if (applyTimeout) clearTimeout(applyTimeout);
            applyTimeout = setTimeout(() => {
                saveSettings();
                refreshRenderedView();
            }, 50);
        };

        const popup = document.createElement('div');
        popup.id = 'rt-cat-settings-popup';
        popup.setAttribute('data-tag', tag);
        popup.style.cssText = `
            position: fixed; z-index: 999999; background: #252535; border: 1px solid rgba(255,255,255,0.3);
            border-radius: 12px; padding: 14px; box-shadow: 0 12px 40px rgba(0,0,0,0.75);
            backdrop-filter: blur(16px); color: #ffffff !important; font-family: sans-serif; width: 280px;
        `;

        const renderContent = () => {
            const symbols = ['•', '○', '●', '▪', '▫', '▶', '➤', '—', '*', '>', '✓', '⚡'];
            popup.innerHTML = `
                <div style="display:flex; flex-direction:column; gap:12px;">
                    <div style="font-size:0.85em; font-weight:bold; opacity:0.8; letter-spacing:0.05em; text-transform:uppercase;">${tag} Settings</div>
                    
                    <div style="display:flex; flex-direction:column; gap:4px;">
                        <div style="display:flex; align-items:center; justify-content:space-between;">
                            <span style="font-size:0.85em; opacity:0.8;">Font Size</span>
                            <span id="rt-cat-fs-val" style="font-size:0.85em; font-weight:bold; color:var(--rt-accent, #00ffaa);">${cfg.fontSize || '13'}</span>
                        </div>
                        <input id="rt-cat-fs" type="range" value="${cfg.fontSize || 13}" min="8" max="24" step="1" style="width:100%; cursor:pointer; accent-color:var(--rt-accent, #00ffaa);">
                    </div>

                    <div style="display:flex; gap:6px;">
                        <button id="rt-cat-bold" style="flex:1; padding:6px; border-radius:6px; border:1px solid rgba(255,255,255,0.2); background:${cfg.bold ? 'rgba(255,255,255,0.15)' : 'transparent'}; color:white; cursor:pointer; font-weight:bold;">B</button>
                        <button id="rt-cat-italic" style="flex:1; padding:6px; border-radius:6px; border:1px solid rgba(255,255,255,0.2); background:${cfg.italic ? 'rgba(255,255,255,0.15)' : 'transparent'}; color:white; cursor:pointer; font-style:italic;">I</button>
                        ${(tag !== 'QUESTS' && tag !== 'SPELLS' && tag !== 'CHARACTER' && tag !== 'PARTY' && tag !== 'COMBAT' && tag !== 'ABILITIES') ? `<button id="rt-cat-bullets" style="flex:2; padding:6px; border-radius:6px; border:1px solid rgba(255,255,255,0.2); background:${cfg.bullets ? 'rgba(255,255,255,0.15)' : 'transparent'}; color:white; cursor:pointer; font-size:0.85em;">${cfg.bullets ? 'Bullets: ON' : 'Bullets: OFF'}</button>` : ''}
                    </div>

                    <div style="display:${(cfg.bullets && tag !== 'QUESTS' && tag !== 'SPELLS' && tag !== 'CHARACTER' && tag !== 'PARTY' && tag !== 'COMBAT' && tag !== 'ABILITIES') ? 'flex' : 'none'}; flex-direction:column; gap:8px;">
                        <div style="font-size:0.75em; opacity:0.6; font-weight:bold; text-transform:uppercase;">Bullet Style</div>
                        <div style="display:grid; grid-template-columns: repeat(6, 1fr); gap:4px;">
                            ${symbols.map(s => `
                                <button class="symbol-btn" data-symbol="${s}" style="aspect-ratio:1; border:1px solid ${cfg.bulletStyle === s ? 'var(--rt-accent, #00ffaa)' : 'rgba(255,255,255,0.1)'}; background:${cfg.bulletStyle === s ? 'rgba(0,255,170,0.1)' : 'rgba(0,0,0,0.2)'}; color:white; border-radius:4px; cursor:pointer; font-size:1em;">${s}</button>
                            `).join('')}
                        </div>
                        <div style="display:flex; align-items:center; justify-content:space-between; margin-top:4px;">
                            <span style="font-size:0.85em; opacity:0.8;">Bullet Color</span>
                            <input id="rt-cat-bullet-color" type="color" value="${cfg.bulletColor === 'inherit' ? '#ffffff' : cfg.bulletColor}" style="width:40px; height:24px; border:none; border-radius:4px; cursor:pointer; background:none;">
                        </div>
                    </div>

                    <div style="display:flex; flex-direction:column; gap:8px;">
                        <div style="display:flex; align-items:center; justify-content:space-between;">
                            <span style="font-size:0.85em; opacity:0.8;">Font Family</span>
                            <select id="rt-cat-family" style="background:#151525; color:white; border:1px solid rgba(255,255,255,0.2); border-radius:4px; font-size:0.85em; padding:2px 4px;">
                                <option value="inherit" ${cfg.fontFamily === 'inherit' ? 'selected' : ''}>Inherit</option>
                                <option value="sans-serif" ${cfg.fontFamily === 'sans-serif' ? 'selected' : ''}>Sans</option>
                                <option value="serif" ${cfg.fontFamily === 'serif' ? 'selected' : ''}>Serif</option>
                                <option value="monospace" ${cfg.fontFamily === 'monospace' ? 'selected' : ''}>Mono</option>
                            </select>
                        </div>
                        <div style="display:flex; align-items:center; justify-content:space-between;">
                            <div style="display:flex; align-items:center; gap:6px;">
                                <span style="font-size:0.85em; opacity:0.8;">Text Color</span>
                                <button id="rt-cat-color-reset" style="font-size:0.7em; background:rgba(255,255,255,0.1); border:none; color:#aaa; border-radius:3px; padding:1px 4px; cursor:pointer;">Reset</button>
                            </div>
                            <input id="rt-cat-text-color" type="color" value="${cfg.textColor === 'inherit' ? '#ffffff' : cfg.textColor}" style="width:40px; height:24px; border:none; border-radius:4px; cursor:pointer; background:none;">
                        </div>
                    </div>

                    <div style="display:flex; gap:6px; margin-top:4px;">
                        <button id="rt-cat-ok" style="flex:1.5; padding:8px; border-radius:6px; border:none; background:var(--rt-accent-bg, #00ffaa); color:#000; font-weight:bold; cursor:pointer; font-size:0.85em;">DONE</button>
                        <button id="rt-cat-reset" style="flex:1; padding:8px; border-radius:6px; border:1px solid rgba(255,255,255,0.2); background:rgba(255,255,255,0.05); color:white; cursor:pointer; font-size:0.85em;">RESET</button>
                    </div>
                </div>
            `;

            popup.querySelector('#rt-cat-fs').addEventListener('mousedown', (e) => e.stopPropagation());
            popup.querySelector('#rt-cat-fs').addEventListener('input', (e) => {
                const target = /** @type {HTMLInputElement} */ (e.target);
                const val = parseInt(target.value);
                cfg.fontSize = val;
                const display = popup.querySelector('#rt-cat-fs-val');
                if (display) display.textContent = val.toString() + 'px';
                applyLive();
            });

            popup.querySelector('#rt-cat-bold').addEventListener('click', () => {
                cfg.bold = !cfg.bold;
                applyLive();
                renderContent();
            });

            popup.querySelector('#rt-cat-italic').addEventListener('click', () => {
                cfg.italic = !cfg.italic;
                applyLive();
                renderContent();
            });

            const bulletsBtn = popup.querySelector('#rt-cat-bullets');
            if (bulletsBtn) {
                bulletsBtn.addEventListener('click', () => {
                    cfg.bullets = !cfg.bullets;
                    applyLive();
                    renderContent();
                });
            }

            popup.querySelectorAll('.symbol-btn').forEach(btn => {
                const el = /** @type {HTMLElement} */ (btn);
                el.addEventListener('click', () => {
                    cfg.bulletStyle = el.dataset.symbol;
                    applyLive();
                    renderContent();
                });
            });

            const colorInp = popup.querySelector('#rt-cat-bullet-color');
            if (colorInp) {
                colorInp.addEventListener('mousedown', (e) => e.stopPropagation());
                colorInp.addEventListener('input', (e) => {
                    const target = /** @type {HTMLInputElement} */ (e.target);
                    cfg.bulletColor = target.value;
                    applyLive();
                });
            }

            popup.querySelector('#rt-cat-family').addEventListener('change', (e) => {
                const target = /** @type {HTMLSelectElement} */ (e.target);
                cfg.fontFamily = target.value;
                applyLive();
            });

            const textColorInp = popup.querySelector('#rt-cat-text-color');
            if (textColorInp) {
                textColorInp.addEventListener('mousedown', (e) => e.stopPropagation());
                textColorInp.addEventListener('input', (e) => {
                    const target = /** @type {HTMLInputElement} */ (e.target);
                    cfg.textColor = target.value;
                    applyLive();
                });
            }

            popup.querySelector('#rt-cat-color-reset').addEventListener('click', () => {
                cfg.textColor = 'inherit';
                applyLive();
                renderContent();
            });

            popup.querySelector('#rt-cat-ok').addEventListener('click', () => {
                popup.remove();
            });

            popup.querySelector('#rt-cat-reset').addEventListener('click', () => {
                const noBullets = (tag === 'TIME' || tag === 'XP' || tag === 'QUESTS' || tag === 'SPELLS' || tag === 'CHARACTER' || tag === 'PARTY' || tag === 'COMBAT' || tag === 'ABILITIES');
                cfg.fontSize = (tag === 'TIME' || tag === 'INVENTORY') ? 12 : 13;
                cfg.italic = false;
                cfg.bold = false;
                cfg.bullets = !noBullets;
                cfg.bulletStyle = tag === 'INVENTORY' ? '▪' : '•';
                cfg.bulletColor = 'inherit';
                cfg.fontFamily = 'inherit';
                cfg.textColor = 'inherit';
                applyLive();
                renderContent();
            });
        };

        renderContent();
        document.body.appendChild(popup);

        const rect = targetEl.getBoundingClientRect();
        let left = rect.left + rect.width / 2 - 140;
        let top = rect.bottom + 10;
        left = Math.max(8, Math.min(left, window.innerWidth - 288));
        if (top + 300 > window.innerHeight) top = rect.top - 300;
        popup.style.left = left + 'px';
        popup.style.top = top + 'px';

        const onOutside = (e) => {
            if (!popup.contains(e.target) && !targetEl.contains(e.target)) {
                popup.remove();
                document.removeEventListener('mouseup', onOutside);
            }
        };
        setTimeout(() => document.addEventListener('mouseup', onOutside), 50);
    }

    /**
     * Injects/updates the <style id="rt-custom-theme-style"> tag in <head>
     * to set the --rt-custom-* variables on :root.
     * @param {Record<string,string>|null} vars
     */
    function applyCustomTheme(vars) {
        let tag = document.getElementById('rt-custom-theme-style');
        if (!tag) {
            tag = document.createElement('style');
            tag.id = 'rt-custom-theme-style';
            document.head.appendChild(tag);
        }

        if (!vars) {
            tag.textContent = '';
            return;
        }

        let css = ':root {\n';
        for (const [key, val] of Object.entries(vars)) {
            if (val) css += `  ${key}: ${val} !important;\n`;
        }
        css += '}';
        tag.textContent = css;
    }

    /**
     * Syncs the 🔗/🔓 icon in the panel header and the settings checkbox
     * to reflect the current chatLinkEnabled state.
     */
    function updateChatLinkUI() {
        const s = getSettings();
        const on = s.chatLinkEnabled;

        const btn = document.getElementById('rpg-tracker-chat-link-btn');
        if (btn) {
            btn.textContent = on ? '🔗' : '🔓';
            btn.title = on
                ? `Chat Link ON — state is bound to the active chat\n(Click to unlock / use global state)`
                : `Chat Link OFF — using global state\n(Click to re-lock to current chat)`;
        }

        const cb = document.getElementById('rpg_tracker_chat_link_enabled');
        if (cb instanceof HTMLInputElement) cb.checked = on;
    }

    /**
     * Update the visual status of the panel (active, running, paused, disabled)
     */
    function updatePanelStatus() {
        const settings = getSettings();
        const panel = document.getElementById('rpg-tracker-panel');
        const indicator = document.getElementById('rpg-tracker-status');
        const pauseBtn = document.getElementById('rpg-tracker-pause-btn');
        const pauseBanner = document.getElementById('rpg-tracker-pause-banner');
        const enableBtn = /** @type {HTMLElement|null} */ (document.getElementById('rpg-tracker-enable-btn'));

        if (!panel || !indicator || !pauseBtn) return;

        // Keep in-panel power button in sync
        if (enableBtn) {
            enableBtn.style.opacity = settings.enabled ? '' : '0.35';
            enableBtn.title = settings.enabled ? 'Disable RPG Tracker' : 'Enable RPG Tracker';
        }
        // Keep settings sidebar checkbox in sync
        const sidebarEnableCheck = /** @type {HTMLInputElement|null} */ (document.getElementById('rpg_tracker_enabled'));
        if (sidebarEnableCheck) sidebarEnableCheck.checked = !!settings.enabled;

        if (!settings.enabled) {
            // Fully disabled — transparent panel, no banner
            panel.classList.add('is-disabled');
            panel.classList.remove('is-paused');
            indicator.classList.remove('active');
            // Always keep the header clickable so the user can re-enable (belt-and-suspenders over the CSS rule)
            const header = panel.querySelector('.rpg-tracker-header');
            if (header) /** @type {HTMLElement} */ (header).style.pointerEvents = 'auto';
            pauseBtn.textContent = '▶';
            pauseBtn.title = 'Resume Tracker';
            if (pauseBanner) pauseBanner.textContent = '';
        } else if (settings.paused) {
            // Paused — visible panel, pause banner shown
            panel.classList.remove('is-disabled');
            panel.classList.add('is-paused');
            indicator.classList.add('active');
            pauseBtn.textContent = '▶';
            pauseBtn.title = 'Resume Tracker';
            if (pauseBanner) pauseBanner.textContent = 'TRACKER UPDATES PAUSED';
        } else {
            // Active
            panel.classList.remove('is-disabled');
            panel.classList.remove('is-paused');
            indicator.classList.add('active');
            pauseBtn.textContent = '⏸';
            pauseBtn.title = 'Pause Tracker';
            if (pauseBanner) pauseBanner.textContent = '';
        }

        if (_stateModelRunning) {
            indicator.classList.add('running');
        } else {
            indicator.classList.remove('running');
        }
    }

    /**
     * The State Model pass: Extract state changes from the narrative.
     * @param {string} narrativeOutput The last narrative message to parse.
     * @param {boolean} isFullContext Whether to perform a long-horizon audit of the entire chat.
     */
    async function runStateModelPass(narrativeOutput, isFullContext = false, overrideLookback = null) {
        const settings = getSettings();
        
        // Deterministic logic: Auto-fail quests past deadline (if not using frustration)
        checkQuestDeadlines();

        const { generateRaw } = SillyTavern.getContext();

        if (!generateRaw) {
            console.error("[RPG Tracker] generateRaw not found in context.");
            return;
        }

        try {
            _stateModelRunning = true;
            updateStatusIndicator('running');

            // Abort previous if any
            if (_stateController) _stateController.abort();
            _stateController = new AbortController();
            const signal = _stateController.signal;

            const modulesText = buildModulesInstructionText(settings);

            let systemPrompt = settings.systemPromptTemplate.replace("{{modulesText}}", modulesText);
            if (isFullContext) {
                systemPrompt = systemPrompt
                    .replace(/Only output sections that actually changed/gi, "Perform a full audit of the narrative history and output the COMPLETE state for all enabled modules")
                    .replace(/Omit unchanged sections entirely/gi, "Do NOT omit any section; output a complete, verified state memo");
            }

            const worldLore = await buildLorebookContext();
            const worldLoreSection = worldLore ? worldLore + '\n\n' : '';

            const { chat } = SillyTavern.getContext();
            // overrideLookback comes from the Lookback Update menu; it wins over settings
            const N = overrideLookback !== null ? overrideLookback
                    : isFullContext          ? chat.length
                    : (settings.lookbackMessages !== undefined ? settings.lookbackMessages : 2);
            const recentChat = chat.slice(-N);
            const chatLog = recentChat
                .map(m => {
                    const name = m.is_user ? 'Player' : (m.name || 'Narrator');
                    // Returns null for tool-call messages — excluded from state model context
                    const content = cleanToolCallMessage(m.mes || m['content'] || '');
                    if (content === null) return null;
                    return `${name}: ${content}`;
                })
                .filter(line => line !== null)
                .join('\n\n');

            let priorMemoText = `## TRACKER STATE 0 (Current)\n${stripMemoHtml(settings.currentMemo)}\n\n`;
            const historyCount = (settings.trackerHistoryCount || 1) - 1;
            if (historyCount > 0 && settings.memoHistory && settings.memoHistory.length > 0) {
                const historyToInclude = settings.memoHistory.slice(0, historyCount).reverse();
                const historyString = historyToInclude.map((memo, i) => {
                    const offset = -(historyToInclude.length - i);
                    return `## TRACKER STATE ${offset}\n${stripMemoHtml(memo)}`;
                }).join('\n\n');
                priorMemoText = historyString + '\n\n' + priorMemoText;
            }

            let userPrompt = "";

            if (isFullContext) {
                userPrompt =
                    worldLoreSection +
                    priorMemoText +
                    `## NARRATIVE HISTORY (Last ${recentChat.length} messages)\n${chatLog}\n\n` +
                    `## TASK\nAnalyze the entire narrative history provided above. Rebuild the State Memo to ensure every detail (HP, AC, Inventory, Abilities, XP, Party members) is perfectly accurate to the current moment in the story. Correct any errors or omissions found in the Prior Memo.\n\n` +
                    `## OUTPUT THE COMPLETE VERIFIED STATE MEMO:`;
            } else {
                userPrompt =
                    worldLoreSection +
                    priorMemoText +
                    `## NARRATIVE HISTORY (Last ${recentChat.length} messages)\n${chatLog}\n\n` +
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

                let merged = mergeMemo(sanitizedCurrent, cleanedOutput);

                if (settings.debugMode) {
                    console.log(`[RPG Tracker] Memo ${merged !== sanitizedCurrent ? 'updated (partial merge)' : 'unchanged'}.`);
                }

                // Push snapshot to rolling history
                const delta = computeDelta(sanitizedCurrent, merged);

                // Flush any quests staged by LogQuest during this generation.
                // We do this BEFORE pushing to history so the NEW state in history includes the quest.
                if (globalThis._rpgPendingQuests && globalThis._rpgPendingQuests.length) {
                    const existingQuests = parseQuestsFromMemo(merged);
                    existingQuests.push(...globalThis._rpgPendingQuests);
                    merged = writeQuestsToMemo(existingQuests, merged);
                    const count = globalThis._rpgPendingQuests.length;
                    globalThis._rpgPendingQuests = [];
                    if (settings.debugMode) console.log(`[RPG Tracker] Flushed ${count} pending quest(s) into merged memo.`);
                }

                // Linear Stone History Logic:
                // 1. If we were viewing/committed to a past state, delete the "abandoned" future.
                if (settings.historyIndex !== undefined && settings.historyIndex !== -1) {
                    if (settings.debugMode) console.log(`[RPG Tracker] Splicing history at index ${settings.historyIndex} due to new update.`);
                    settings.memoHistory = settings.memoHistory.slice(settings.historyIndex);
                }

                // 2. Archive the state BEFORE this generation to history
                if (settings.memoHistory[0] !== sanitizedCurrent) {
                    settings.memoHistory.unshift(sanitizedCurrent);
                }

                // 3. Archive the NEW state so it's always recoverable via navigation
                settings.memoHistory.unshift(merged);
                if (settings.memoHistory.length > 1000) settings.memoHistory.length = 1000;

                // 4. Set pointer to the NEW state (the live stone)
                settings.historyIndex = 0;
                _historyViewIndex = -1;

                // Persist delta and update panel
                settings.lastDelta = delta;
                const deltaPanel = document.getElementById('rpg-tracker-delta-content');
                if (deltaPanel) deltaPanel.innerHTML = delta;

                // Rotation logic (legacy compat)
                settings.prevMemo2 = settings.prevMemo1;
                settings.prevMemo1 = sanitizedCurrent;
                settings.currentMemo = merged;

                // Sync internal quest cache from the merged memo (legacy compat)
                syncQuestsFromMemo(merged);

                updateUIMemo(merged);
                syncMemoView();
                refreshRenderedView();
                saveSettings();

                if (settings.debugMode) console.log("[RPG Tracker] State Model pass complete.");
                
                // Check for Level Up
                if (/LEVEL_UP=true/i.test(merged)) {
                    handleLevelUp();
                }
                
                return delta;
            }
        } catch (error) {
            if (error.name === 'AbortError') {
                if (settings.debugMode) console.log("[RPG Tracker] State Model pass aborted by user.");
                return;
            }
            console.error("[RPG Tracker] State Model pass failed:", error);
        } finally {
            _stateModelRunning = false;
            _stateController = null;
            updateStatusIndicator('active');
        }
    }

    // ── Phase-5 bridge: exposes runStateModelPass for narrative-hooks.js/onGenerationEnded ──
    // Removed when memo-processor.js is created in Phase 5.
    globalThis._rpgRunStateModelPass = runStateModelPass;
    globalThis._rpgStateModelRunning = () => _stateModelRunning;
    globalThis._rpgCurrentChatId = () => _currentChatId;
    // Expose live prefix derivation for any module that needs the current prefix.
    globalThis._rpgGetCurrentPrefix = () => derivePrefixFromChatId(SillyTavern.getContext().chatId || '');

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
        const { generateRaw } = SillyTavern.getContext();
        if (!generateRaw) return;

        try {
            _stateModelRunning = true;
            updateStatusIndicator('running');

            // Abort previous if any
            if (_stateController) _stateController.abort();
            _stateController = new AbortController();
            const signal = _stateController.signal;
            const worldLore = await buildLorebookContext();
            const worldLoreSection = worldLore ? worldLore + '\n\n' : '';

            const modulesText = buildModulesInstructionText(settings);
            const systemPrompt = settings.systemPromptTemplate.replace('{{modulesText}}', modulesText);

            const sanitizedCurrent = stripMemoHtml(settings.currentMemo.replace(/<\/?memo>/gi, '').trim());

            const { chat } = SillyTavern.getContext();
            const N = settings.directPromptContext !== undefined ? settings.directPromptContext : 5;
            let chatLog = '';
            if (N > 0 && chat && chat.length > 0) {
                const recentChat = chat.slice(-N);
                chatLog = `## NARRATIVE HISTORY (Last ${recentChat.length} messages)\n` +
                    recentChat
                        .map(m => {
                            const name = m.is_user ? 'Player' : (m.name || 'Narrator');
                            // Returns null for tool-call messages — excluded from state model context
                            const content = cleanToolCallMessage(m.mes || m['content'] || '');
                            if (content === null) return null;
                            return `${name}: ${content}`;
                        })
                        .filter(line => line !== null)
                        .join('\n\n') + '\n\n';
            }

            const userPrompt =
                worldLoreSection +
                chatLog +
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

                    // Linear Stone History Logic
                    if (settings.historyIndex !== undefined && settings.historyIndex !== -1) {
                        settings.memoHistory = settings.memoHistory.slice(settings.historyIndex);
                    }
                    if (settings.memoHistory[0] !== sanitizedCurrent) {
                        settings.memoHistory.unshift(sanitizedCurrent);
                    }
                    settings.memoHistory.unshift(merged);
                    if (settings.memoHistory.length > 1000) settings.memoHistory.length = 1000;
                    settings.historyIndex = 0;
                    _historyViewIndex = -1;

                    const dp = document.getElementById('rpg-tracker-delta-content');
                    if (dp) dp.innerHTML = delta;

                    settings.prevMemo2 = settings.prevMemo1;
                    settings.prevMemo1 = sanitizedCurrent;
                    settings.currentMemo = merged;

                    updateUIMemo(merged);
                    syncMemoView();
                    refreshRenderedView();
                    saveSettings();
                    toastr['success']('Tracker updated.', 'RPG Tracker');
                } else {
                    toastr['info']('No changes were made.', 'RPG Tracker');
                }
            }
        } catch (err) {
            if (err.name === 'AbortError') {
                if (settings.debugMode) console.log("[RPG Tracker] Direct prompt aborted by user.");
                return;
            }
            console.error('[RPG Tracker] Direct prompt failed:', err);
            toastr['error']('Direct prompt failed. Check console.', 'RPG Tracker');
        } finally {
            _stateModelRunning = false;
            _stateController = null;
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

    /** Profile system — load a named profile into live settings. */
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
        // quests are always derived from currentMemo — never from the profile snapshot
        s.quests = [];
        syncQuestsFromMemo(s.currentMemo);
        s.lastDelta = p.lastDelta ?? '';
        s.activeProfile = name;
        _historyViewIndex = -1;
        
        saveSettings();
        // Refresh UI
        refreshOrderList();
        // Refresh delta panel
        const dp = document.getElementById('rpg-tracker-delta-content');
        if (dp) dp.innerHTML = s.lastDelta || '<span class="delta-empty">No changes yet.</span>';
        syncMemoView();
    }

    function refreshProfileDropdown() {
        const s = getSettings();
        const sel = document.getElementById('rpg_tracker_profile_select');
        if (!sel) return;
        const names = Object.keys(s.profiles || {});
        sel.innerHTML = '<option value="">-- No Profile --</option>' +
            names.map(n => `<option value="${escapeHtml(n)}"${n === s.activeProfile ? ' selected' : ''}>${escapeHtml(n)}</option>`).join('');
    }

    async function showRngExplanation() {
        const { Popup } = SillyTavern.getContext();
        const card = (icon, title, body) => `
            <div style="background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.12); border-radius: 8px; padding: 12px 14px; margin-bottom: 12px; text-align: left;">
                <div style="font-size: 1em; font-weight: bold; margin-bottom: 6px;">${icon} ${title}</div>
                <div style="font-size: 0.9em; line-height: 1.5; opacity: 0.88;">${body}</div>
            </div>`;
        const popupBody = `
            <div style="font-size: 0.9em; line-height: 1.5; max-width: 480px; text-align: left;">
                ${card('🎲', 'RNG Queue <span style="font-weight:normal;opacity:0.6;">(Combat)</span>',
                    `Generates a list of pre-rolled dice and injects them directly into the story context. The AI uses the next roll in the queue until it reaches the last one, then wraps about to the start again. Each input injects a fresh set of numbers.<br><br>
                    Ideal for combat because initiative creates a deterministic "grid," removing any opportunity for the AI to game the outcome. This is why it's the default method for combat—it reduces token costs massively, minimizes latency, and is more reliable due to its reduced structural complexity.`
                )}
                ${card('🔧', 'Tool Call RNG <span style="font-weight:normal;opacity:0.6;">(Narrative)</span>',
                    `A reactive system where the AI proactively calls a dice tool for a specific narrative action (e.g., picking a lock, persuading a guard). The AI must declare a <b>Difficulty Class (DC)</b> before seeing the result. This ensures it can't "game the system" by lowering the DC to fit a roll or skipping the roll entirely. While I haven't personally observed this "gaming" behavior with the Queue-only method, Tool Calls ensure that it remains technically impossible.`
                )}
                <div style="background: rgba(255,200,50,0.08); border: 1px solid rgba(255,200,50,0.25); border-radius: 8px; padding: 10px 14px; margin-bottom: 12px; font-size: 0.88em; text-align: left;">
                    <b style="color: #ffcc33;">⚠ Important:</b> Tool Call RNG requires <b>"Enable function calling"</b> to be enabled in SillyTavern's AI Response Configuration.
                </div>
                ${card('📋', 'Which system should I use?',
                    `<ul style="margin: 4px 0 0 0; padding-left: 20px; text-align: left; list-style-position: outside;">
                        <li style="margin-bottom: 4px;"><b>Hybrid RNG (recommended):</b> Enables both systems. A more "waterproof" system.</li>
                        <li><b>Legacy RNG:</b> Queue-only. Use if your model doesn't support tool calling or you prefer the simpler setup for any other reason.</li>
                    </ul>`
                )}
            </div>`;
        await Popup.show.confirm('🎲 RNG Systems Explained', popupBody, { okButton: 'Got it', cancelButton: false });
    }

    /**
     * Renders and shows the Quests Hardcore systems explanation popup.
     */
    async function showQuestsHardcoreExplanation() {
        const { Popup } = SillyTavern.getContext();
        const card = (icon, title, body, sub = false) => `
            <div style="background: rgba(255,255,255,${sub ? '0.03' : '0.05'}); border: 1px solid rgba(255,255,255,0.12); border-radius: 8px; padding: 12px 14px; margin-bottom: 12px; text-align: left; ${sub ? 'margin-left: 16px;' : ''}">
                <div style="font-size: 1em; font-weight: bold; margin-bottom: 6px;">${icon} ${title}</div>
                <div style="font-size: 0.9em; line-height: 1.5; opacity: 0.88;">${body}</div>
            </div>`;
        const popupBody = `
            <div style="font-size: 0.9em; line-height: 1.5; max-width: 480px; text-align: left;">
                ${card('⏳', 'Deadlines',
                    `Adds time-sensitive constraints to quests. The system prompt instructs NPCs to attach deadlines to tasks they give you. If the deadline passes without turning in the quest, it auto-fails. Forces you to prioritise — you can't just accept every task and grind at your leisure.`
                )}
                ${card('🎭', 'Frustration', `Requires Deadlines. A sub-mode where quests <em>don't</em> auto-fail at the deadline. Instead, each quest giver has an NPC happiness level that starts high and quickly drops the longer you leave it past due. The rate of decline depends on the NPC's personality, which the model infers from their archetype and tone. You can still turn the quest in late — but the reception won't be warm.`, true)}
                ${card('⚔️', 'Difficulty',
                    `The model assigns an explicit difficulty rating to each quest (e.g. Easy / Hard / Deadly) rather than leaving it vague. Useful for planning and for AI consistency when calculating rewards or consequences.`
                )}
            </div>`;
        await Popup.show.confirm('📋 Quest Mechanics Explained', popupBody, { okButton: 'Got it', cancelButton: false });
    }

    async function showComponentsExplanation() {
        const { Popup } = SillyTavern.getContext();
        const card = (icon, title, body) => `
            <div style="background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.12); border-radius: 8px; padding: 12px 14px; margin-bottom: 12px; text-align: left;">
                <div style="font-size: 1em; font-weight: bold; margin-bottom: 6px;">${icon} ${title}</div>
                <div style="font-size: 0.9em; line-height: 1.5; opacity: 0.88;">${body}</div>
            </div>`;
        const popupBody = `
            <div style="font-size: 0.9em; line-height: 1.5; max-width: 480px; text-align: left;">
                ${card('🎲', 'Loot',
                    `When loot is received, dice rolls are made to determine its quality — whether something is a battered common item or a rare find. Adds meaningful variance to rewards.`
                )}
                ${card('🌍', 'Events',
                    `Random events are rolled when time skips or travel occurs. A chance encounter, a weather shift, an ambush — things that happen without the player initiating them. Keeps the world feeling alive.`
                )}
                ${card('💤', 'Resting',
                    `Resting is limited to once every 9 hours of in-game time. Prevents exploiting rest as a free heal between every fight, and reflects the reality that you can't just nap on demand.`
                )}
            </div>`;
        await Popup.show.confirm('🧩 Components Explained', popupBody, { okButton: 'Got it', cancelButton: false });
    }

    function bindRenderedCardEvents(el, memo, isDetachedContext = false, onRefresh = null) {
        const refresh = onRefresh || refreshRenderedView;
        el.querySelectorAll('.rt-random-char-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                const archetype = btn.dataset.archetype;
                const level = el.querySelector('#rt-starting-level')?.value || 1;
                const labels = { magic: '✨ Casting...', melee: '⚔️ Training...', rogue: '🗡️ Sneaking...', persona: '🎭 Embodying...' };
                const prompts = {
                    magic: `Generate a random Level ${level} D&D Magic User (Wizard, Sorcerer, or Warlock). Give them a random fantasy name (do NOT use {{user}}). Output [CHARACTER], [SPELLS], [INVENTORY], and [ABILITIES] blocks. Include appropriate spells (using 'Cantrips:' for level 0 spells), items, and attributes consistent with Level ${level}.`,
                    melee: `Generate a random Level ${level} D&D Melee Fighter (Fighter, Barbarian, or Paladin). Give them a random fantasy name (do NOT use {{user}}). Output [CHARACTER], [INVENTORY], and [ABILITIES] blocks. Focus on high physical attributes, heavy armor, and signature weapons consistent with Level ${level}.`,
                    rogue: `Generate a random Level ${level} D&D Rogue or Thief-style character. Give them a random fantasy name (do NOT use {{user}}). Output [CHARACTER], [INVENTORY], and [ABILITIES] blocks. Focus on high Dexterity, stealth-related equipment (thieves' tools, daggers), and class features like Sneak Attack consistent with Level ${level}.`
                };

                // ── Persona archetype: derive character from the active SillyTavern persona ──
                if (archetype === 'persona') {
                    const { substituteParams } = SillyTavern.getContext();
                    const resolvedPersona = substituteParams ? substituteParams('{{persona}}').trim() : '';
                    if (!resolvedPersona || resolvedPersona === '{{persona}}') {
                        toastr['warning'](
                            'No persona is set. Set a persona in SillyTavern (User Settings → Personas) and try again.',
                            'RPG Tracker'
                        );
                        return;
                    }
                    el.querySelectorAll('.rt-random-char-btn').forEach(b => b.disabled = true);
                    btn.textContent = labels.persona;
                    const personaPrompt = `Using the following persona description as the basis for the player character, create a Level ${level} D&D character that faithfully embodies this persona. Translate the personality, background, and traits into appropriate D&D stats, class, race, and equipment. Output [CHARACTER], [INVENTORY], and [ABILITIES] blocks (and [SPELLS] if the class is a spellcaster, using 'Cantrips:' for level 0 spells). All attributes and gear should be consistent with Level ${level}.\n\nPersona:\n${resolvedPersona}`;
                    await sendDirectPrompt(personaPrompt);
                    return;
                }

                el.querySelectorAll('.rt-random-char-btn').forEach(b => b.disabled = true);
                btn.textContent = labels[archetype] || '🎲 Rolling...';
                await sendDirectPrompt(prompts[archetype]);
            });
        });

        el.querySelectorAll('.rt-hp-bar-wrap[data-recolor-id], .rt-xp-bar-wrap[data-recolor-id]').forEach(wrap => {
            wrap.addEventListener('click', (e) => {
                e.stopPropagation();
                handleRecolor(wrap.dataset.recolorId, wrap.dataset.recolorCurrent, wrap);
            });
        });

        // RNG Help Popup Trigger
        el.querySelectorAll('.rt-rng-help-icon').forEach(icon => {
            icon.addEventListener('click', (e) => {
                e.stopPropagation();
                showRngExplanation();
            });
        });

        // Hardcore Help Popup Triggers
        el.querySelectorAll('.rt-quests-hardcore-help').forEach(icon => {
            icon.addEventListener('click', (e) => {
                e.stopPropagation();
                showQuestsHardcoreExplanation();
            });
        });

        // --- Onboarding Narrator Configuration (Salad Bar Sync) ---
        const s = getSettings();
        
        /**
         * Helper to update a setting, save it, and sync the UIs.
         * This avoids the 'ghost click' problem where onboarding UI tries to
         * trigger changes on non-existent settings panel elements.
         */
        const syncSettingsAndUI = (updateFn) => {
            const fresh = getSettings();
            updateFn(fresh);
            
            // Sync the main settings panel if it exists
            const rngHybrid = /** @type {HTMLInputElement|null} */ (document.getElementById('rpg_rng_hybrid'));
            const rngLegacy = /** @type {HTMLInputElement|null} */ (document.getElementById('rpg_rng_legacy'));
            const questsCb = /** @type {HTMLInputElement|null} */ (document.getElementById('rpg_sysprompt_mod_quests'));
            const deadlinesCb = /** @type {HTMLInputElement|null} */ (document.getElementById('rpg_quests_deadlines'));
            const frustrationCb = /** @type {HTMLInputElement|null} */ (document.getElementById('rpg_quests_frustration'));
            const qmStandard = /** @type {HTMLInputElement|null} */ (document.getElementById('rpg_quest_standard'));
            const qmLegacy = /** @type {HTMLInputElement|null} */ (document.getElementById('rpg_quest_legacy'));

            if (rngHybrid && rngLegacy) {
                rngHybrid.checked = !!fresh.diceFunctionTool;
                rngLegacy.checked = !fresh.diceFunctionTool;
            }
            if (questsCb) questsCb.checked = fresh.syspromptModules?.quests !== false;
            if (deadlinesCb) deadlinesCb.checked = !!fresh.syspromptModules?.questsDeadlines;
            if (frustrationCb) frustrationCb.checked = !!fresh.syspromptModules?.questsFrustration;
            const frustrationWrapEl = /** @type {HTMLElement|null} */ (document.getElementById('rpg_quests_frustration_wrap'));
            if (frustrationWrapEl) frustrationWrapEl.style.display = !!fresh.syspromptModules?.questsDeadlines ? '' : 'none';
            const difficultyCb = /** @type {HTMLInputElement|null} */ (document.getElementById('rpg_quests_difficulty'));
            if (difficultyCb) difficultyCb.checked = !!fresh.syspromptModules?.questsDifficulty;
            if (qmStandard && qmLegacy) {
                qmStandard.checked = !fresh.questLegacyMode;
                qmLegacy.checked = !!fresh.questLegacyMode;
            }
            
            // Optional components
            const mods = { 'loot': '#rpg_sysprompt_mod_loot', 'random_events': '#rpg_sysprompt_mod_random_events', 'resting': '#rpg_sysprompt_mod_resting' };
            for (const [key, id] of Object.entries(mods)) {
                const cb = /** @type {HTMLInputElement|null} */ (document.getElementById(id.replace('#','')));
                if (cb) cb.checked = !!fresh.syspromptModules?.[key];
            }

            // Custom Sysprompt
            const customSyspromptEl = /** @type {HTMLInputElement|null} */ (document.getElementById('rpg_tracker_custom_sysprompt'));
            if (customSyspromptEl) customSyspromptEl.checked = !!fresh.customSysprompt;
            const narratorBlockEl = document.getElementById('rpg_narrator_config_block');
            if (narratorBlockEl) narratorBlockEl.style.display = !!fresh.customSysprompt ? 'none' : '';

            // Save and sync the onboarding view
            saveSettings();
            
            // Handle specific logic like tool registration
            if (fresh.questLegacyMode) {
                refreshQuestLegacyPrompt(fresh);
            } else {
                // Ensure modern prompt is in the quests slot
                if (!fresh.stockPrompts) fresh.stockPrompts = {};
                fresh.stockPrompts.quests = DEFAULT_STOCK_PROMPTS.quests;
                registerLogQuestTool();
            }
            refreshOrderList();
            saveSettings();
            scheduleAutoApply();
        };

        // RNG Mode Sync
        const onboardingRngInputs = el.querySelectorAll('input[name="rt_onboarding_rng_mode"]');
        onboardingRngInputs.forEach(input => {
            input.checked = (input.value === (s.diceFunctionTool ? 'hybrid' : 'legacy'));
            input.addEventListener('change', () => {
                syncSettingsAndUI(settings => {
                    settings.diceFunctionTool = (input.value === 'hybrid');
                });
            });
        });

        // Quests Enabled Sync
        const onboardingQuestsCb = el.querySelector('#rt_onboarding_quests_enabled');
        if (onboardingQuestsCb) {
            onboardingQuestsCb.checked = s.syspromptModules?.quests !== false;
            const optionsDiv = el.querySelector('#rt_onboarding_quest_options');
            if (optionsDiv) optionsDiv.style.display = onboardingQuestsCb.checked ? 'flex' : 'none';
            
            onboardingQuestsCb.addEventListener('change', () => {
                const isEnabled = !!onboardingQuestsCb.checked;
                if (optionsDiv) optionsDiv.style.display = isEnabled ? 'flex' : 'none';
                syncSettingsAndUI(settings => {
                    if (!settings.syspromptModules) settings.syspromptModules = {};
                    settings.syspromptModules.quests = isEnabled;
                });
            });
        }

        // Deadlines Sync
        const onboardingDeadlinesCb = el.querySelector('#rt_onboarding_quests_deadlines');
        const onboardingFrustrationWrap = el.querySelector('#rt_onboarding_quests_frustration_wrap');
        const syncOnboardingFrustrationVisibility = () => {
            if (onboardingFrustrationWrap) onboardingFrustrationWrap.style.display = onboardingDeadlinesCb?.checked ? '' : 'none';
        };
        if (onboardingDeadlinesCb) {
            onboardingDeadlinesCb.checked = !!s.syspromptModules?.questsDeadlines;
            syncOnboardingFrustrationVisibility();
            onboardingDeadlinesCb.addEventListener('change', () => {
                if (!onboardingDeadlinesCb.checked) {
                    const fCb = el.querySelector('#rt_onboarding_quests_frustration');
                    if (fCb) fCb.checked = false;
                    syncSettingsAndUI(settings => {
                        if (!settings.syspromptModules) settings.syspromptModules = {};
                        settings.syspromptModules.questsDeadlines = false;
                        settings.syspromptModules.questsFrustration = false;
                    });
                } else {
                    syncSettingsAndUI(settings => {
                        if (!settings.syspromptModules) settings.syspromptModules = {};
                        settings.syspromptModules.questsDeadlines = true;
                    });
                }
                syncOnboardingFrustrationVisibility();
            });
        }

        // Frustration Levels Sync
        const onboardingFrustrationCb = el.querySelector('#rt_onboarding_quests_frustration');
        if (onboardingFrustrationCb) {
            onboardingFrustrationCb.checked = !!s.syspromptModules?.questsFrustration;
            onboardingFrustrationCb.addEventListener('change', () => {
                syncSettingsAndUI(settings => {
                    if (!settings.syspromptModules) settings.syspromptModules = {};
                    settings.syspromptModules.questsFrustration = !!onboardingFrustrationCb.checked;
                });
            });
        }

        // Difficulty Sync
        const onboardingDifficultyCb = el.querySelector('#rt_onboarding_quests_difficulty');
        if (onboardingDifficultyCb) {
            onboardingDifficultyCb.checked = !!s.syspromptModules?.questsDifficulty;
            onboardingDifficultyCb.addEventListener('change', () => {
                syncSettingsAndUI(settings => {
                    if (!settings.syspromptModules) settings.syspromptModules = {};
                    settings.syspromptModules.questsDifficulty = !!onboardingDifficultyCb.checked;
                });
            });
        }

        // Quest Mode Sync
        const onboardingQuestModeInputs = el.querySelectorAll('input[name="rt_onboarding_quest_mode"]');
        onboardingQuestModeInputs.forEach(input => {
            const isLegacy = s.questLegacyMode;
            input.checked = (input.value === (isLegacy ? 'legacy' : 'standard'));
            input.addEventListener('change', () => {
                syncSettingsAndUI(settings => {
                    settings.questLegacyMode = (input.value === 'legacy');
                });
            });
        });

        // Optional Components Sync
        const syncOptionalMod = (onboardingId, settingKey) => {
            const cb = el.querySelector(onboardingId);
            if (cb) {
                cb.checked = !!s.syspromptModules?.[settingKey];
                cb.addEventListener('change', () => {
                    syncSettingsAndUI(settings => {
                        if (!settings.syspromptModules) settings.syspromptModules = {};
                        settings.syspromptModules[settingKey] = !!cb.checked;
                    });
                });
            }
        };
        syncOptionalMod('#rt_onboarding_mod_loot', 'loot');
        syncOptionalMod('#rt_onboarding_mod_random_events', 'random_events');
        syncOptionalMod('#rt_onboarding_mod_resting', 'resting');

        // Custom Sysprompt toggle (onboarding)
        const onboardingCustomSyspromptCb = el.querySelector('#rt_onboarding_custom_sysprompt');
        if (onboardingCustomSyspromptCb) {
            onboardingCustomSyspromptCb.checked = !!getSettings().customSysprompt;
            onboardingCustomSyspromptCb.addEventListener('change', () => {
                syncSettingsAndUI(s => { s.customSysprompt = !!onboardingCustomSyspromptCb.checked; });
            });
        }

        // Apply System Prompt button (onboarding) — same logic as settings panel "Update Main Sysprompt"
        const onboardingBtnApply = el.querySelector('#rt_onboarding_btn_update_sysprompt');
        if (onboardingBtnApply) {
            onboardingBtnApply.addEventListener('click', async () => {
                await autoApplySysprompt();
                toastr['success']('System prompt applied! \u2705', 'RPG Tracker');
            });
        }

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
                refresh();
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
                refresh();
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
                saveSettings();
                refresh();
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
                    refresh();
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
                    refresh();
                });
            });
        }

        el.querySelectorAll('.rt-category-settings-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                handleCategorySettings(btn.dataset.tag, btn);
            });
        });

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
        if (!_pillDeselectHandler) {
            _pillDeselectHandler = (e) => {
                if (!e.target.closest('.rt-unit-pill')) {
                    document.querySelectorAll('.rt-unit-pill.active').forEach(u => u.classList.remove('active'));
                }
            };
            document.addEventListener('click', _pillDeselectHandler);
        }
    }

    function refreshRenderedView() {
        if (!_renderedViewActive) return;
        const s = getSettings();
        const memo = _historyViewIndex === -1
            ? s.currentMemo
            : (s.memoHistory[_historyViewIndex] ?? '');
            
        const collapsed = loadCollapsed();
        const detached  = loadDetached();

        // Extract world time from THIS snapshot for frustration computation
        const timeMatch = (memo || '').match(/\[TIME\]([\s\S]*?)\[\/TIME\]/i);
        const currentTime = timeMatch ? timeMatch[1].split('\n').filter(Boolean)[0]?.trim() || '' : '';

        const el = document.getElementById('rpg-tracker-render');
        if (el) {
            let html = renderMemoAsCards(memo, null, _sectionPages);

            // Append quest log section if module is enabled (always render, even when empty)
            if (s.modules?.quests) {
                const snapshotQuests = parseQuestsFromMemo(memo);
                html += renderQuestLog(snapshotQuests, currentTime, collapsed, detached);
            }

            el.innerHTML = html;
            bindRenderedCardEvents(el, memo, false);

            // Update footer location: try parsing from recent chat status footer first, fallback to memo
            let locText = '';
            const ctx = SillyTavern.getContext();
            if (ctx && ctx.chat && ctx.chat.length) {
                for (let i = ctx.chat.length - 1; i >= 0; i--) {
                    const msgContent = ctx.chat[i]?.mes || ctx.chat[i]?.['content'] || '';
                    const m = msgContent.match(/\(Location:\s*([^)]+)\)/i);
                    if (m) {
                        locText = m[1].trim();
                        break;
                    }
                }
            }
            if (!locText) {
                const locMatch = (memo || '').match(/Location:\s*([^)\n]+)/i);
                if (locMatch) locText = locMatch[1].trim();
            }
            const footerLoc = document.getElementById('rt-footer-location');
            if (footerLoc) {
                footerLoc.textContent = locText || 'Unknown Location';
                footerLoc.title = locText ? `Location: ${locText}` : 'Unknown Location';
            }
        }

        // Update any detached panels
        detached.forEach(tag => {
            const panel = document.getElementById(`rt-detached-panel-${tag}`);
            if (panel) {
                const body = panel.querySelector('.rpg-tracker-detached-body');
                if (body) {
                    if (tag === 'QUESTS') {
                        const snapshotQuests = parseQuestsFromMemo(memo);
                        body.innerHTML = renderQuestLog(snapshotQuests, currentTime, collapsed, detached, 'QUESTS');
                    } else {
                        body.innerHTML = renderMemoAsCards(memo, tag, _sectionPages);
                    }
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
        const displayName = customField?.label || tag;

        const settings = getSettings();
        const panel = document.createElement('div');
        panel.id = `rt-detached-panel-${tag}`;
        panel.className = `rpg-tracker-panel rpg-tracker-detached-panel ${settings.trackerTheme || 'rt-theme-native'}`;
        panel.innerHTML = `
            <div class="rpg-tracker-header rt-detached-header">
                <div class="rpg-tracker-header-left">
                    <span>${icon} ${displayName}</span>
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
        
        // Cleanup any existing detached panels from the body to prevent duplicates on re-init
        document.querySelectorAll('body > .rpg-tracker-detached-panel').forEach(el => el.remove());
        document.querySelector('body > #rpg-tracker-agent')?.remove();

        const panel = document.createElement('div');
        panel.id = 'rpg-tracker-panel';
        panel.className = `rpg-tracker-panel ${settings.trackerTheme || 'rt-theme-native'}`;
        panel.style.setProperty('--rt-base-size', (settings.fontSize || 13) + 'px');
        panel.innerHTML = `
            <div class="rt-resizer-tr" id="rt-resizer-tr" title="Resize from top-right"></div>
            <div class="rpg-tracker-header" id="rpg-tracker-header">
                <div class="rpg-tracker-header-left">
                    <span>Fatbody D&D Framework</span>
                    <div class="rpg-tracker-status-indicator active" id="rpg-tracker-status"></div>
                    <button class="rpg-tracker-stop-btn" id="rpg-tracker-stop-btn" title="Stop Generation" style="display:none;">■</button>
                    <button class="rpg-tracker-icon-btn" id="rpg-tracker-chat-link-btn" style="font-size:13px;" title="Chat Link ON">🔗</button>
                </div>
                <div class="rpg-tracker-header-center" id="rpg-tracker-pause-banner"></div>
                <div class="rpg-tracker-header-right">
                    <button class="rpg-tracker-icon-btn" id="rpg-tracker-enable-btn" title="${settings.enabled ? 'Disable RPG Tracker' : 'Enable RPG Tracker'}" style="${settings.enabled ? '' : 'opacity:0.4;'}" >⏻</button>
                    <button class="rpg-tracker-icon-btn" id="rpg-tracker-update-btn" title="Update State Now">🔄</button>
                    <button class="rpg-tracker-icon-btn" id="rpg-tracker-pause-btn" title="Pause Tracker">⏸</button>
                    <button class="rpg-tracker-icon-btn" id="rpg-tracker-prompt-btn" title="Toggle direct prompt">💬</button>
                    <button class="rpg-tracker-icon-btn" id="rpg-tracker-view-btn" title="Toggle rendered view">⊞</button>
                    <button class="rpg-tracker-icon-btn" id="rpg-tracker-delta-btn" title="Toggle change log">δ</button>
                    <button class="rpg-tracker-icon-btn" id="rpg-tracker-agent-btn" title="Lorebook Agent">🤖</button>
                    <button class="rpg-tracker-icon-btn" id="rpg-tracker-debug-btn" title="Context Debugger" style="display:none;">🛠️</button>
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
            <div class="rpg-tracker-panel rpg-tracker-agent-panel ${settings.trackerTheme || 'rt-theme-native'}" id="rpg-tracker-agent" style="display:none; position: absolute; right: 0; top: 30px; width: 300px; max-height: calc(100% - 30px); z-index: 1000; flex-direction: column;">
                <div class="rpg-tracker-header" style="cursor: default;">
                    <span class="rpg-tracker-header-left"><i class="fa-solid fa-robot"></i> Lorebook Agent</span>
                    <div class="rpg-tracker-header-center" id="rt-agent-pause-banner" style="color:#ffa500; font-size:0.7em; font-weight:bold; letter-spacing:0.04em;">${settings.routerPaused ? 'AGENT PAUSED' : ''}</div>
                    <div class="rpg-tracker-header-right">
                        <button class="rpg-tracker-icon-btn" id="rt-agent-router-manual-run" title="Run Research Now" style="color: var(--rt-accent);"><i class="fa-solid fa-play"></i></button>
                        <button class="rpg-tracker-icon-btn" id="rt-agent-router-enable-btn" title="${settings.routerEnabled ? 'Disable Lorebook Agent' : 'Enable Lorebook Agent'}" style="${settings.routerEnabled ? '' : 'opacity:0.35;'}">⏻</button>
                        <button class="rpg-tracker-icon-btn" id="rt-agent-router-pause-btn" title="${settings.routerPaused ? 'Resume Agent (auto-runs paused)' : 'Pause Agent (skip auto-runs)'}" style="${settings.routerPaused ? 'color:#ffa500;' : ''}">${settings.routerPaused ? '▶' : '⏸'}</button>
                        <button class="rpg-tracker-icon-btn" id="rt-agent-router-detach" title="Detach Lorebook Agent">⧉</button>
                        <button class="rpg-tracker-icon-btn" id="rpg-tracker-agent-close" title="Close">✕</button>
                    </div>
                </div>
                <div class="rpg-tracker-content" style="flex: 1; overflow-y: auto; padding: 10px; color: var(--rt-text);">
                    <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px;">
                        <div style="font-weight: bold; opacity: 0.9; font-size: 0.923em; color: var(--rt-accent, #3498db);">AUTONOMOUS RESEARCHER</div>
                        <button id="rt-agent-help-btn" style="background: var(--rt-accent-bg); border: 1px solid var(--rt-accent-dim); color: var(--rt-accent); border-radius: 12px; width: 20px; height: 20px; font-size: 0.846em; cursor: pointer; display: flex; align-items: center; justify-content: center;" title="What is the Lorebook Agent?">?</button>
                    </div>

                    <div style="background: rgba(255, 165, 0, 0.1); border: 1px solid rgba(255, 165, 0, 0.3); color: #ffa500; padding: 6px; border-radius: 4px; font-size: 0.769em; text-align: center; font-weight: bold; margin-bottom: 15px;">
                        ⚠️ UNDER CONSTRUCTION, NEEDS TESTING
                    </div>

                    <label style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; cursor: pointer; opacity: 0.8; font-size: 0.846em;" title="Use simple text tags [[NPC: Name | Desc]] instead of complex tools. Better for small models.">
                        Basic Mode (tag-based, no tool calls)
                        <input type="checkbox" id="rt-agent-router-basic" ${settings.routerBasicMode ? 'checked' : ''}>
                    </label>

                    <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 6px;">
                        <div style="display: flex; align-items: center; gap: 6px; flex: 1;" title="Main lookback: last N chat messages (user and assistant, in order) included in the agent context during automatic passes.">
                            <span style="font-size: 0.769em; opacity: 0.7;">Lookback (user/assistant):</span>
                            <input type="number" id="rt-agent-router-lookback" value="${settings.routerLookback || 4}" min="1" max="100" style="width: 40px; background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.1); color: white; border-radius: 3px; text-align: center; font-size: 0.769em; padding: 1px;">
                            <span style="font-size: 0.769em; opacity: 0.5;">msgs</span>
                        </div>
                        <div style="display: flex; align-items: center; gap: 6px; flex: 1;" title="Run every N messages: The agent only fires an auto-pass once per N AI responses. Higher = fewer runs, fewer tokens. Manual runs always fire immediately.">
                            <span style="font-size: 0.769em; opacity: 0.7;">Run every:</span>
                            <input type="number" id="rt-agent-router-run-every" value="${settings.routerRunEvery || 1}" min="1" max="50" style="width: 40px; background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.1); color: white; border-radius: 3px; text-align: center; font-size: 0.769em; padding: 1px;">
                            <span style="font-size: 0.769em; opacity: 0.5;">msgs</span>
                        </div>
                    </div>
                    <label style="display: flex; align-items: center; gap: 5px; margin-bottom: 10px; cursor: pointer; font-size: 0.769em; opacity: 0.75;" title="Include hidden messages (e.g. messages collapsed by a summarizer) in the agent's lookback window.">
                        <input type="checkbox" id="rt-agent-router-include-hidden" ${settings.routerIncludeHidden ? 'checked' : ''}>
                        <span>Include hidden msgs (summarizer)</span>
                    </label>

                    <div style="display: flex; gap: 8px; margin-bottom: 10px;">
                        <div style="flex: 1;" title="Max Tokens: The maximum token limit for the agent's response. 0 = model default.">
                            <div style="margin-bottom: 5px; opacity: 0.8; font-size: 0.846em; color: var(--rt-text-muted);">Max Tokens:</div>
                            <input type="number" id="rt-agent-router-max-tokens" value="${settings.routerMaxTokens || 0}" style="width: 100%; background: var(--rt-card-bg); color: var(--rt-text); border: var(--rt-border); border-radius: 4px; padding: 4px; font-size: 0.846em; box-sizing: border-box;">
                        </div>
                        <div style="flex: 1;" title="Max Turns: How many Thought/Action loops the agent can perform before timing out (Advanced Mode only).">
                            <div style="margin-bottom: 5px; opacity: 0.8; font-size: 0.846em; color: var(--rt-text-muted);">Max Turns:</div>
                            <input type="number" id="rt-agent-router-max-turns" value="${settings.routerMaxTurns || 5}" style="width: 100%; background: var(--rt-card-bg); color: var(--rt-text); border: var(--rt-border); border-radius: 4px; padding: 4px; font-size: 0.846em; box-sizing: border-box;">
                        </div>
                        <div style="flex: 1;" title="Max Active: The maximum number of lore entries the agent can keep in Active Memory. Once reached, it must deactivate old entries to add new ones.">
                            <div style="margin-bottom: 5px; opacity: 0.8; font-size: 0.846em; color: var(--rt-text-muted);">Max Active:</div>
                            <input type="number" id="rt-agent-router-max-activations" value="${settings.routerMaxActivations || 5}" min="1" max="20" style="width: 100%; background: var(--rt-card-bg); color: var(--rt-text); border: var(--rt-border); border-radius: 4px; padding: 4px; font-size: 0.846em; box-sizing: border-box;">
                        </div>
                    </div>
                    
                    <div style="margin-bottom: 5px; font-weight: bold; opacity: 0.8; font-size: 0.846em; color: var(--rt-text-muted);">Direct Command:</div>
                    <textarea id="rt-agent-router-direct-prompt" placeholder="Ask the agent to find or record something specific..." style="width: 100% !important; min-height: 60px !important; height: 60px !important; background: var(--rt-card-bg) !important; color: var(--rt-text) !important; border: var(--rt-border) !important; border-radius: 4px !important; padding: 6px !important; font-size: 0.846em !important; margin-bottom: 6px !important; resize: vertical !important; display: block !important; box-sizing: border-box !important; line-height: 1.3 !important;">${settings.routerDirectPrompt || ''}</textarea>

                    <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; background: var(--rt-header-bg); padding: 4px 8px; border-radius: 4px; border: 1px solid rgba(255,255,255,0.05); box-sizing: border-box; min-height: 32px;">
                        <div style="display: flex; align-items: center; gap: 6px;" title="Direct lookback: last N chat messages (user and assistant) for this manual run.">
                            <span style="font-size: 0.769em; opacity: 0.7; color: var(--rt-text-muted);">Lookback (user/assistant):</span>
                            <input type="number" id="rt-agent-router-direct-lookback" value="${settings.routerDirectLookback || 10}" min="1" max="100" style="width: 38px; background: var(--rt-card-bg); border: 1px solid var(--rt-accent-dim); color: var(--rt-accent); border-radius: 3px; text-align: center; font-size: 0.769em; padding: 1px; box-sizing: border-box; height: 20px;">
                            <span style="font-size: 0.769em; opacity: 0.5; color: var(--rt-text-muted);">msgs</span>
                        </div>
                        <button id="rt-agent-router-run-direct" class="rpg-tracker-prompt-send" style="width: auto; height: 22px; padding: 0 10px; font-size: 0.769em; font-weight: bold; gap: 4px; margin: 0;" title="Execute Lorebook Agent pass">
                            <i class="fa-solid fa-paper-plane" style="font-size: 0.692em;"></i> RUN COMMAND
                        </button>
                    </div>


                    <details style="margin-top: 10px; border-top: 1px solid #444; padding-top: 10px;">
                        <summary style="cursor: pointer; font-size: 0.846em; font-weight: bold; opacity: 0.8; color: #aaa;">Modular Repertoire (Prompt Rules)</summary>
                        <div style="padding-top: 10px;">
                            <div style="margin-bottom: 5px; font-weight: bold; opacity: 0.8; font-size: 0.846em;">Enabled Modules (Stock):</div>
                            <div id="rt-agent-stock-modules-list" style="margin-bottom: 10px;"></div>

                            <div style="margin-bottom: 5px; font-weight: bold; opacity: 0.8; font-size: 0.846em;">Custom Tags:</div>
                            <div id="rt-agent-custom-tags-list"></div>
                            <button id="rt-agent-add-custom-tag" style="width: 100%; background: #333; border: 1px solid #444; color: #ddd; font-size: 0.769em; padding: 2px; border-radius: 3px; cursor: pointer; margin-top: 4px;">+ Add Custom Tag</button>
                        </div>
                    </details>

                    <details style="margin-top: 10px; border-top: 1px solid #444; padding-top: 10px;">
                        <summary style="cursor: pointer; font-size: 0.846em; font-weight: bold; opacity: 0.8; color: #aaa;">Lorebook Agent Connection</summary>
                        <div style="padding-top: 10px;">
                            <div style="margin-bottom: 5px; font-weight: bold; opacity: 0.8; font-size: 0.846em;">Connection Source:</div>
                            <select id="rt-agent-router-source" style="width: 100%; margin-bottom: 5px; background: #222; color: #ddd; border: 1px solid #444; border-radius: 3px; padding: 2px;">
                                <option value="default" ${settings.routerConnectionSource === 'default' ? 'selected' : ''}>Main API</option>
                                <option value="profile" ${settings.routerConnectionSource === 'profile' ? 'selected' : ''}>SillyTavern Profile</option>
                                <option value="ollama" ${settings.routerConnectionSource === 'ollama' ? 'selected' : ''}>Ollama (Local)</option>
                                <option value="openai" ${settings.routerConnectionSource === 'openai' ? 'selected' : ''}>OpenAI Compatible</option>
                            </select>

                            <div id="rt-agent-router-profile-group" style="display: ${settings.routerConnectionSource === 'profile' ? 'block' : 'none'};">
                                <select id="rt-agent-router-profile" style="width: 100%; margin-bottom: 5px; background: #222; color: #ddd; border: 1px solid #444; border-radius: 3px; padding: 2px;">
                                    <option value="">-- No Profile Selected --</option>
                                </select>
                            </div>

                            <div id="rt-agent-router-ollama-group" style="display: ${settings.routerConnectionSource === 'ollama' ? 'block' : 'none'};">
                                <input type="text" id="rt-agent-router-ollama-url" placeholder="Ollama URL" value="${settings.routerOllamaUrl || 'http://localhost:11434'}" style="width: 100%; margin-bottom: 5px; background: #222; color: #ddd; border: 1px solid #444; border-radius: 3px; padding: 2px;">
                                <div style="display: flex; gap: 4px; margin-bottom: 5px;">
                                    <select id="rt-agent-router-ollama-model" style="flex: 1; background: #222; color: #ddd; border: 1px solid #444; border-radius: 3px; padding: 2px;">
                                        <option value="">-- Select Model --</option>
                                    </select>
                                    <button id="rt-agent-router-ollama-refresh" style="background: #333; border: 1px solid #444; color: #ddd; border-radius: 3px; padding: 0 8px; cursor: pointer;" title="Refresh Models"><i class="fa-solid fa-arrows-rotate"></i></button>
                                </div>
                            </div>

                            <div id="rt-agent-router-openai-group" style="display: ${settings.routerConnectionSource === 'openai' ? 'block' : 'none'};">
                                <input type="text" id="rt-agent-router-openai-url" placeholder="Endpoint URL" value="${settings.routerOpenaiUrl || ''}" style="width: 100%; margin-bottom: 5px; background: #222; color: #ddd; border: 1px solid #444; border-radius: 3px; padding: 2px;">
                                <input type="password" id="rt-agent-router-openai-key" placeholder="API Key (Optional)" value="${settings.routerOpenaiKey || ''}" style="width: 100%; margin-bottom: 5px; background: #222; color: #ddd; border: 1px solid #444; border-radius: 3px; padding: 2px;">
                                <div style="display: flex; gap: 4px; margin-bottom: 5px;">
                                    <select id="rt-agent-router-openai-model" style="flex: 1; background: #222; color: #ddd; border: 1px solid #444; border-radius: 3px; padding: 2px;">
                                        <option value="">-- Select Model --</option>
                                    </select>
                                    <button id="rt-agent-router-openai-refresh" style="background: #333; border: 1px solid #444; color: #ddd; border-radius: 3px; padding: 0 8px; cursor: pointer;" title="Refresh Models"><i class="fa-solid fa-arrows-rotate"></i></button>
                                </div>
                                <input type="text" id="rt-agent-router-openai-model-manual" placeholder="Or type model name manually" value="${settings.routerOpenaiModel || ''}" style="width: 100%; margin-bottom: 5px; background: #222; color: #ddd; border: 1px solid #444; border-radius: 3px; padding: 2px;">
                            </div>

                            <div style="margin-bottom: 5px; opacity: 0.8; font-size: 0.846em;">Generation Preset:</div>
                            <select id="rt-agent-router-preset" style="width: 100%; margin-bottom: 5px; background: #222; color: #ddd; border: 1px solid #444; border-radius: 3px; padding: 2px;">
                                <option value="">-- Use Current Settings --</option>
                            </select>
                        </div>
                    </details>

                    

                    <hr style="border-color: #333; margin: 10px 0;">

                    <div style="display: flex; align-items: center; gap: 6px; margin-bottom: 5px;">
                        <div style="font-weight: bold; opacity: 0.8; font-size: 0.846em;">Active Lore Keys:</div>
                        <button id="rt-agent-keys-refresh" title="Refresh active keys from disk" style="background: none; border: none; color: var(--rt-accent); font-size: 0.769em; cursor: pointer; opacity: 0.6; padding: 0;" ><i class="fa-solid fa-arrows-rotate"></i></button>
                    </div>
                    <div id="rt-agent-router-active-keys" style="margin-bottom: 10px; display: flex; flex-wrap: wrap; gap: 4px; min-height: 24px;">
                    </div>
                    <hr style="border-color: #333; margin: 10px 0;">
                    
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 5px;">
                        <div style="font-weight: bold; opacity: 0.8; font-size: 0.846em;">Lorebook Terminal:</div>
                        <button id="rt-agent-router-terminal-clear" style="background: transparent; border: none; color: #ff5555; font-size: 0.692em; cursor: pointer; opacity: 0.7;">Clear</button>
                    </div>
                    <div id="rt-agent-router-terminal" style="background: var(--rt-card-bg); border: var(--rt-border); border-radius: 4px; padding: 8px; min-height: 80px; max-height: 200px; overflow-y: auto; margin-bottom: 10px; font-family: var(--rt-font-mono);">
                        <div style="opacity: 0.4; font-size: 0.769em; font-style: italic; color: var(--rt-text-muted);">Waiting for agent activity...</div>
                    </div>

                    <hr style="border-color: rgba(255,255,255,0.05); margin: 10px 0;">
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 5px;">
                        <div style="font-weight: bold; opacity: 0.8; font-size: 0.846em;">Agent Log History:</div>
                        <button id="rt-agent-router-log-clear" style="background: transparent; border: none; color: #ff5555; font-size: 0.692em; cursor: pointer; opacity: 0.7;">Clear</button>
                    </div>
                    <div id="rt-agent-router-log" style="display: flex; flex-direction: column; gap: 5px; margin-bottom: 15px; max-height: 150px; overflow-y: auto;">
                    </div>

                    <div style="margin-top: 10px; border-top: 1px solid rgba(255,255,255,0.1); padding-top: 15px;">
                        <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px;">
                            <div style="font-weight: bold; opacity: 0.8; font-size: 0.846em;">CAMPAIGN RECORDS</div>
                            <div style="display: flex; align-items: center; gap: 6px;">
                                <button class="rpg-tracker-icon-btn" id="rt-agent-manifest-refresh" title="Refresh Manifest" style="font-size: 0.769em; opacity: 0.5;"><i class="fa-solid fa-arrows-rotate"></i></button>
                            </div>
                        </div>
                        <div id="rt-agent-manifest-list" style="max-height: 400px; overflow-y: auto; display: flex; flex-direction: column; gap: 6px;">
                            <div style="text-align: center; opacity: 0.5; font-size: 0.769em; padding: 10px;">Click refresh to load lore...</div>
                        </div>
                    </div>
                </div>
                <div class="rpg-tracker-footer" id="rt-agent-footer">
                    <div class="rpg-tracker-nav">
                        <button class="rpg-tracker-nav-btn" id="rt-agent-nav-back" title="Undo last lorebook pass">←</button>
                        <span class="rpg-tracker-nav-label" id="rt-agent-nav-label">[ LIVE ]</span>
                        <button class="rpg-tracker-nav-btn" id="rt-agent-nav-fwd" title="Redo lorebook pass">→</button>
                    </div>
                </div>
            </div>
            <div class="rpg-tracker-prompt-bar" id="rpg-tracker-prompt-bar" style="display:none;">
                <textarea class="rpg-tracker-prompt-input" id="rpg-tracker-prompt-input" rows="2" placeholder="Instruct the tracker model… (Enter to send, Shift+Enter for newline)"></textarea>
                <div style="display: flex; flex-direction: column; gap: 4px; align-items: center; justify-content: flex-end;">
                    <div class="rt-prompt-ctx-control" style="font-size: 0.692em; display: flex; flex-direction: column; align-items: center; gap: 0;" title="Context: number of recent messages to include">
                        <input type="number" id="rt-prompt-context-val" value="${settings.directPromptContext || 5}" min="0" max="50" style="width: 28px; height: 16px; font-size: 0.692em; background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.1); color: white; border-radius: 3px; text-align: center; padding: 0;">
                        <span style="opacity: 0.5; font-size: 8px; line-height: 1;">msg</span>
                    </div>
                    <button class="rpg-tracker-prompt-send" id="rpg-tracker-prompt-send" title="Send instruction">▶</button>
                </div>
            </div>
            <div class="rpg-tracker-footer" id="rt-main-footer">
                <div class="rt-mobile-top-row">
                    <button class="rt-footer-toggle-btn" id="rt-footer-expand-btn" title="Toggle Settings Drawer"><i class="fa-solid fa-chevron-up"></i></button>
                    <div class="rpg-tracker-nav">
                        <button class="rpg-tracker-nav-btn" id="rpg-tracker-nav-back" title="View previous snapshot">←</button>
                        <span class="rpg-tracker-nav-label" id="rpg-tracker-nav-label">Live</span>
                        <button class="rpg-tracker-nav-btn" id="rpg-tracker-nav-fwd" title="View next snapshot">→</button>
                    </div>
                </div>
                <div class="flex-container gap-1 alignitemscenter rt-rng-footer-group" style="display:none;">
                    <!-- Removed inline RNG toggles, now located in extension settings -->
                </div>
                <div id="rt-footer-location" style="font-size: 0.769em; color: var(--rt-accent); flex: 1; text-align: center; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; opacity: 0.9; cursor: help;" title="Current Location (Main, Sub)"></div>
                <div class="flex-container gap-1 alignitemscenter rt-utility-footer-group">
                    <span id="rpg-tracker-count">~${Math.round(settings.currentMemo.length / 2.62)} tokens</span>
                    <button class="rpg-tracker-nav-btn" id="rpg-tracker-memo-clear" style="padding: 1px 5px; font-size: 0.692em; opacity: 0.8; margin-left: 5px;" title="Clear memo and history">CLEAR</button>
                </div>
            </div>
        `;

        document.body.appendChild(panel);

        const header = panel.querySelector('#rpg-tracker-header');
        if (header instanceof HTMLElement) {
            makeDraggable(/** @type {HTMLElement} */(panel), header);
        }
        setupResizeObserver(/** @type {HTMLElement} */(panel));
        loadPanelGeometry(/** @type {HTMLElement} */(panel));

        const resizerTR = panel.querySelector('#rt-resizer-tr');
        if (resizerTR instanceof HTMLElement) {
            makeResizableTR(/** @type {HTMLElement} */(panel), resizerTR);
        }

        const stopBtn = panel.querySelector('#rpg-tracker-stop-btn');
        if (stopBtn) {
            stopBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                // 1. Abort the state update controller (kills fetch/Ollama/OpenAI)
                if (_stateController) {
                    _stateController.abort();
                    _stateController = null;
                }
                // 2. Stop SillyTavern generation (kills internal ST requests)
                const { stopGeneration } = SillyTavern.getContext();
                if (stopGeneration) stopGeneration();
            });
        }

        const enableBtn = panel.querySelector('#rpg-tracker-enable-btn');
        if (enableBtn) {
            enableBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const s = getSettings();
                s.enabled = !s.enabled;
                saveSettings();
                updatePanelStatus();
            });
        }

        const pauseBtn = panel.querySelector('#rpg-tracker-pause-btn');
        if (pauseBtn) {
            pauseBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const s = getSettings();
                // Pause button only toggles the paused state, not the enabled state
                s.paused = !s.paused;
                saveSettings();
                updatePanelStatus();
            });
        }

        // ── Chat Link Toggle ──
        const chatLinkBtn = panel.querySelector('#rpg-tracker-chat-link-btn');
        if (chatLinkBtn) {
            chatLinkBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const { Popup, POPUP_RESULT } = SillyTavern.getContext();
                const s = getSettings();
                const turningOn = !s.chatLinkEnabled;

                if (turningOn && _currentChatId) {
                    const saved = s.chatStates?.[_currentChatId];
                    const liveContent = (s.currentMemo || '').trim();
                    const savedContent = (saved?.currentMemo || '').trim();
                    
                    const liveKeys = s.activeRouterKeys || [];
                    const savedKeys = saved?.activeRouterKeys || [];
                    const keysChanged = JSON.stringify(liveKeys.sort()) !== JSON.stringify(savedKeys.sort());

                    // Show conflict if EITHER content or keys are different
                    const hasConflict = (savedContent && liveContent && liveContent !== savedContent) || (savedKeys.length > 0 && liveKeys.length > 0 && keysChanged);

                    if (hasConflict) {
                        const body = `
                            <div style="text-align: left;">
                                <p><b>Conflict Detected:</b> This chat has a saved state (memo or lore keys), but your current session is not empty.</p>
                                <p style="font-size: 0.9em; opacity: 0.8; margin-top: 10px;">
                                    <b>RESTORE:</b> Use the chat's saved state. (Current session moved to history)<br>
                                    <b>OVERWRITE:</b> Keep current session and save it to this chat. (Old chat data moved to history)
                                </p>
                            </div>`;
                        
                        const choice = await Popup.show.confirm('⚠️ Chat Link Conflict', body, {
                            okButton: 'RESTORE',
                            cancelButton: 'OVERWRITE',
                            customButtons: [
                                {
                                    text: 'CANCEL',
                                    result: POPUP_RESULT.CANCELLED,
                                    appendAtEnd: true,
                                }
                            ],
                        });

                        if (choice === POPUP_RESULT.AFFIRMATIVE) {
                            // User wants to Restore
                            if (s.currentMemo) {
                                saved.memoHistory = saved.memoHistory || [];
                                saved.memoHistory.unshift({
                                    memo: s.currentMemo,
                                    delta: s.lastDelta,
                                    timestamp: Date.now(),
                                    label: 'Global Edit (Pre-Link)'
                                });
                                if (saved.memoHistory.length > 50) saved.memoHistory.length = 50;
                            }
                            loadChatState(_currentChatId);
                            toastr['success']('Chat Link ON — restored saved state.', 'RPG Tracker');
                        } else if (choice === POPUP_RESULT.NEGATIVE) {
                            // User wants to Overwrite
                            if (saved.currentMemo) {
                                s.memoHistory.unshift(saved.currentMemo);
                                if (s.memoHistory.length > 50) s.memoHistory.length = 50;
                            }
                            saveChatState(_currentChatId);
                            toastr['success']('Chat Link ON — current state saved to chat.', 'RPG Tracker');
                        } else {
                            // User closed the modal or hit escape — cancel the toggle
                            return;
                        }
                    } else {
                        // No conflict or chat was empty
                        saveChatState(_currentChatId);
                        toastr['success']('Chat Link ON — state bound to this chat.', 'RPG Tracker');
                    }
                } else if (turningOn) {
                    // Normal lock (empty or new chat)
                    if (_currentChatId) {
                        const found = loadChatState(_currentChatId);
                        if (!found) saveChatState(_currentChatId);
                    }
                    toastr['success']('Chat Link ON', 'RPG Tracker');
                } else {
                    toastr['info']('Chat Link OFF — using global state.', 'RPG Tracker');
                }

                s.chatLinkEnabled = turningOn;
                saveSettings();
                updateChatLinkUI();
            });
        }

        // ── Router Agent UI ──
        const agentBtn = /** @type {HTMLElement} */ (panel.querySelector('#rpg-tracker-agent-btn'));
        const agentPanel = /** @type {HTMLElement} */ (panel.querySelector('#rpg-tracker-agent'));
        agentPanel.style.setProperty('--rt-base-size', (settings.agentFontSize || 13) + 'px');
        const agentCloseBtn = /** @type {HTMLElement} */ (panel.querySelector('#rpg-tracker-agent-close'));
        
        renderRouterUI = async function() {
            const s = getSettings();
            const keysContainer = agentPanel.querySelector('#rt-agent-router-active-keys');
            const logContainer = agentPanel.querySelector('#rt-agent-router-log');
            if (!keysContainer || !logContainer) return;
            
            const ctx = SillyTavern.getContext();
            const books = {};
            const activeKeys = s.activeRouterKeys || [];
            
            // Collect needed lorebooks to minimize loads
            const neededBooks = new Set();
            for (const k of activeKeys) {
                const parts = k.split('::');
                if (parts.length > 1) neededBooks.add(parts[0]);
            }
            
            for (const bookName of neededBooks) {
                books[bookName] = await ctx.loadWorldInfo(bookName);
            }

            const keywordTriggeredSet = new Set(s.lastKeywordTriggeredKeys || []);

            keysContainer.innerHTML = activeKeys.map(k => {
                const [bookName, uid] = k.split('::');
                const entry = books[bookName]?.entries?.[uid];
                
                const shortBook = bookName.split('_').pop() || bookName;
                let label = `${shortBook}/${uid}`;
                let title = "No entry found.";
                if (entry) {
                    label = entry.comment || (entry.key?.[0]) || uid;
                    title = `[${bookName}] ${entry.key?.join(', ')}\n\n${(entry.content || '').substring(0, 500)}${entry.content?.length > 500 ? '...' : ''}`;
                }

                const isKeywordTriggered = keywordTriggeredSet.has(k);
                const pillBg    = isKeywordTriggered ? 'rgba(58, 46, 14, 0.9)'          : 'rgba(42, 42, 53, 0.8)';
                const pillBorder = isKeywordTriggered ? '1px solid rgba(210, 160, 40, 0.6)' : '1px solid rgba(255,255,255,0.1)';
                const tooltipPrefix = isKeywordTriggered ? '⌂ Keyword-triggered this turn\n\n' : '';

                return `<span class="rt-router-pill" style="background: ${pillBg}; padding: 2px 8px; border-radius: 12px; font-size: 0.769em; border: ${pillBorder}; display: inline-flex; align-items: center; gap: 6px; cursor: help; max-width: 120px;" title="${escapeHtml(tooltipPrefix + title)}">
                    ${isKeywordTriggered ? '<span style="color: #d4a028; font-size: 0.9em; flex-shrink: 0;" title="Keyword-triggered this turn">⌂</span>' : ''}
                    <span style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1;">${escapeHtml(label)}</span>
                    <span class="rt-router-kill-key" data-key="${k}" style="cursor:pointer; color: #ff5555; font-weight: bold; padding: 0 2px;" title="Deactivate">✕</span>
                </span>`;
            }).join('') || '<span style="opacity:0.5; font-size:10px;">None</span>';
            
            logContainer.innerHTML = (s.routerLog || []).map(entry => {
                let diffStr = '';
                if (entry.activate?.length) diffStr += `<span style="color:#55ff55;">+${entry.activate.length}</span> `;
                if (entry.deactivate?.length) diffStr += `<span style="color:#ff5555;">-${entry.deactivate.length}</span> `;
                if (entry.record?.length) diffStr += `<span style="color:#55ccff;" title="Created: ${entry.record.join(', ')}">*${entry.record.length}</span> `;
                if (entry.delete?.length) diffStr += `<span style="color:#ff3333; font-weight: bold;" title="Deleted: ${entry.delete.join(', ')}">✕${entry.delete.length}</span> `;
                return `<div style="background: rgba(0,0,0,0.3); padding: 6px; border-radius: 4px; font-size: 0.769em; margin-bottom: 4px; border-left: 2px solid rgba(255,255,255,0.05);">
                    <div style="display:flex; justify-content: space-between; opacity: 0.7; margin-bottom: 2px; font-weight: bold;">
                        <span>${entry.time}</span>
                        <span>${diffStr}</span>
                    </div>
                    <div style="line-height: 1.3;">${escapeHtml(entry.reason)}</div>
                </div>`;
            }).join('') || '<span style="opacity:0.5; font-size:10px;">No logs yet.</span>';
            
            // Attach kill handlers
            keysContainer.querySelectorAll('.rt-router-kill-key').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    const target = /** @type {HTMLElement} */ (e.target);
                    const key = target.getAttribute('data-key');
                    const st = getSettings();
                    if (st.activeRouterKeys) {
                        st.activeRouterKeys = st.activeRouterKeys.filter(k => k !== key);
                        if (st.lastKeywordTriggeredKeys) {
                            st.lastKeywordTriggeredKeys = st.lastKeywordTriggeredKeys.filter(k => k !== key);
                        }
                        saveSettings();
                        renderRouterUI();
                    }
                });
            });
        }
        
        // Assigned below when the agent panel is wired. Declared here so
        // nav handlers outside the wiring block can always call it safely.
        let refreshManifest = async (_source = 'uninitialized') => {};

        if (agentBtn && agentPanel && agentCloseBtn) {
            agentBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const isHidden = (/** @type {HTMLElement} */ (agentPanel)).style.display === 'none';
                (/** @type {HTMLElement} */ (agentPanel)).style.display = isHidden ? 'flex' : 'none';
                if (isHidden) { renderRouterUI(); refreshManifest(); }
            });
            agentCloseBtn.addEventListener('click', () => {
                (/** @type {HTMLElement} */ (agentPanel)).style.display = 'none';
            });
            const helpBtn = agentPanel.querySelector('#rt-agent-help-btn');
            if (helpBtn) {
                helpBtn.addEventListener('click', () => {
                    const content = `
                        <div style="text-align: left; font-size: 13px; line-height: 1.5;">
                            <h3 style="margin-top: 0; color: var(--rt-custom-accent, #3498db);">The Lorebook Agent</h3>
                            <p>An autonomous narrative researcher. After each generation it scans your recent chat, decides what has changed, and writes new or updated entries directly into your SillyTavern lorebooks — no manual data entry needed.</p>

                            <h4 style="margin-bottom: 5px;">🤖 Operating Modes</h4>
                            <ul style="padding-left: 20px; margin-top: 0;">
                                <li><b>Basic Mode (Tags)</b> — The model outputs structured tags the Agent parses directly:<br>
                                    <code style="font-size:11px;">[[NPC: Name | Description | keyword1, keyword2]]</code><br>
                                    Supported types: <code>NPC</code>, <code>LOC</code>, <code>FAC</code>, <code>QUEST</code>, <code>EVENT</code>, plus <code>[[ACTIVATE: name]]</code>, <code>[[DEACTIVATE: name]]</code>, <code>[[DELETE: name]]</code>.<br>
                                    Ideal for smaller/local models (Mistral Small, Gemma, Qwen, etc.).</li>
                                <li style="margin-top:8px;"><b>Advanced Mode (Tools)</b> — Multi-turn ReAct loop: the model reasons (<i>Thought</i>), calls a tool (<i>Action</i>), receives a result (<i>Observation</i>), and repeats until it calls <code>finish</code> or hits Max Turns. Tools include <code>record</code>, <code>update</code>, <code>activate</code>, <code>deactivate</code>, <code>delete</code>, and <code>search</code>. Best for larger models (Claude Sonnet, GPT-5); maybe even Qwen 3 can handle it on capable hardware.</li>
                            </ul>

                            <h4 style="margin-bottom: 5px;">🧠 Attention-Based Memory</h4>
                            <p>The Agent sees two tiers of lorebook content:</p>
                            <ul style="padding-left: 20px; margin-top: 0;">
                                <li><b>Active entries</b> — full content is visible in the Agent's context. Keyword-triggered by SillyTavern and managed via <b>Active Lore Keys</b>.</li>
                                <li><b>Inactive entries</b> — listed only by name and keywords (no content). The Agent must activate them first to read or update their body.</li>
                            </ul>
                            <p style="margin-top:4px;"><b>Max Active</b> caps how many entries can be active simultaneously (FIFO pruning keeps token cost predictable).</p>

                            <h4 style="margin-bottom: 5px;">📂 Campaign Records</h4>
                            <p>All lorebooks created by the Agent for the current campaign are shown grouped by book. Click any folder to expand it; click any entry to read its full content. Books are automatically activated and deactivated based on the current chat — no manual action needed.</p>

                            <h4 style="margin-bottom: 5px;">↩ History Navigation</h4>
                            <p>The <b>← [ LIVE ] →</b> bar at the bottom lets you step back through lorebook snapshots and redo steps you've undone — just like the State Tracker's memo history. Each agent pass is snapshotted before it runs (up to 5 saved). A new pass clears the redo stack.</p>

                            <h4 style="margin-bottom: 5px;">🛠️ Modular Repertoire</h4>
                            <p>Toggle which entity types the Agent tracks (NPCs, Locations, Factions, Quests, Events) and add <b>Custom Tags</b> for anything world-specific. Every module's system prompt snippet is editable so you control exactly how the AI records data.</p>

                            <h4 style="margin-bottom: 5px;">🕹️ Controls Reference</h4>
                            <ul style="padding-left: 20px; margin-top: 0;">
                                <li><b>Main Lookback</b>: Messages the Agent scans during automatic post-generation runs.</li>
                                <li><b>Max Tokens</b>: Caps the Agent's response length per turn.</li>
                                <li><b>Max Turns</b>: Maximum ReAct loop iterations before the Agent is forced to finish (Advanced Mode).</li>
                                <li><b>Max Active</b>: Maximum simultaneously active lore entries.</li>
                                <li><b>Campaign Prefix</b>: Namespace for all lorebooks this Agent creates (e.g. <i>Eldoria</i> → <i>Eldoria_NPCs</i>, <i>Eldoria_Locations</i>…).</li>
                                <li><b>Direct Command</b>: Runs a one-off agent pass with a custom instruction and its own lookback window — useful for targeted research or corrections.</li>
                            </ul>
                        </div>
                    `;
                    const { Popup } = SillyTavern.getContext();
                    Popup.show.confirm('📖 Lorebook Agent Documentation', content, { okButton: 'Got it', cancelButton: false });
                });
            }

            /** Applies/removes is-agent-disabled on the agent panel to match routerEnabled. */
            function updateAgentPanelDisabled() {
                const s = getSettings();
                if (s.routerEnabled) {
                    agentPanel.classList.remove('is-agent-disabled');
                } else {
                    agentPanel.classList.add('is-agent-disabled');
                }
                // Keep settings sidebar toggle in sync
                const sidebarCheck = /** @type {HTMLInputElement|null} */ (document.getElementById('rpg_tracker_router_enabled'));
                if (sidebarCheck) sidebarCheck.checked = !!s.routerEnabled;
                // Keep header ⏻ button in sync
                const agentEnableBtn = /** @type {HTMLElement|null} */ (agentPanel.querySelector('#rt-agent-router-enable-btn'));
                if (agentEnableBtn) {
                    agentEnableBtn.style.opacity = s.routerEnabled ? '' : '0.35';
                    agentEnableBtn.title = s.routerEnabled ? 'Disable Lorebook Agent' : 'Enable Lorebook Agent';
                }
            }

            // Apply on open
            updateAgentPanelDisabled();

            // ── Agent enable button (header ⏻) ──
            const agentEnableBtn = agentPanel.querySelector('#rt-agent-router-enable-btn');
            if (agentEnableBtn) {
                agentEnableBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const s = getSettings();
                    s.routerEnabled = !s.routerEnabled;
                    saveSettings();
                    updateAgentPanelDisabled();
                });
            }

            const basicCheck = agentPanel.querySelector('#rt-agent-router-basic');
            if (basicCheck) {
                basicCheck.addEventListener('change', (e) => {
                    const s = getSettings();
                    s.routerBasicMode = (/** @type {HTMLInputElement} */ (e.target)).checked;
                    saveSettings();
                });
            }

            // Tracks which lorebook folders are open across refreshes
            const _manifestOpenFolders = new Set();

            refreshManifest = async () => {
                const list = agentPanel.querySelector('#rt-agent-manifest-list');
                if (!list) return;

                list.innerHTML = '<div style="text-align: center; opacity: 0.5; font-size: 0.769em; padding: 10px;">Loading...</div>';

                try {
                    const manifest = await getLorebookManifest();
                    if (!manifest.length) {
                        const hasPrefix = !!(getSettings().routerCampaignPrefix || '').trim();
                        list.innerHTML = `<div style="text-align: center; opacity: 0.5; font-size: 0.769em; padding: 10px;">${hasPrefix ? 'No records found.' : 'Set a Campaign Prefix to see records.'}</div>`;
                        return;
                    }

                    const s = getSettings();
                    const prefix = s.routerCampaignPrefix || '';

                    // Group entries by lorebook
                    /** @type {Map<string, typeof manifest>} */
                    const byBook = new Map();
                    for (const item of manifest) {
                        if (!byBook.has(item.book)) byBook.set(item.book, []);
                        byBook.get(item.book).push(item);
                    }

                    list.innerHTML = '';

                    for (const [bookName, items] of byBook) {
                        // Strip campaign prefix from display name: "Eldoria_Factions" → "Factions"
                        const displayName = prefix && bookName.startsWith(prefix + '_')
                            ? bookName.slice(prefix.length + 1)
                            : bookName;

                        const activeCount = items.filter(i => i.is_active).length;
                        const isOpen = _manifestOpenFolders.has(bookName);

                        const folder = document.createElement('div');
                        folder.style.cssText = 'flex-shrink: 0; margin-bottom: 2px;';

                        const folderHdr = document.createElement('div');
                        folderHdr.style.cssText = 'display:flex; align-items:center; gap:6px; padding:5px 6px; cursor:pointer; border-radius:4px; background:rgba(255,255,255,0.04);';
                        folderHdr.innerHTML = `
                            <span class="rt-mf-icon" style="font-size:9px; opacity:0.5; width:10px; flex-shrink:0; font-family:monospace;">${isOpen ? '▼' : '▶'}</span>
                            <span style="font-weight:bold; font-size:11px; flex:1; color:var(--rt-text); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(displayName)}</span>
                            <span style="font-size:9px; opacity:0.45; color:var(--rt-text-muted); flex-shrink:0;">${activeCount}/${items.length}</span>
                        `;

                        const folderBody = document.createElement('div');
                        folderBody.style.cssText = `display:${isOpen ? 'flex' : 'none'}; flex-direction:column; border-left:1px solid rgba(255,255,255,0.07); margin-left:10px; padding-left:6px; gap:1px; padding-top:3px; padding-bottom:3px;`;

                        folderHdr.addEventListener('click', () => {
                            const opening = folderBody.style.display === 'none';
                            folderBody.style.display = opening ? 'flex' : 'none';
                            folderHdr.querySelector('.rt-mf-icon').textContent = opening ? '▼' : '▶';
                            if (opening) _manifestOpenFolders.add(bookName);
                            else _manifestOpenFolders.delete(bookName);
                        });

                        for (const item of items) {
                            const statusColor = item.is_active ? 'var(--rt-accent)' : 'rgba(255,255,255,0.18)';

                            const entryEl = document.createElement('div');
                            entryEl.style.cssText = 'flex-shrink:0; border-radius:3px;';

                            const entryHdr = document.createElement('div');
                            entryHdr.style.cssText = 'display:flex; align-items:center; gap:5px; padding:3px 4px; cursor:pointer; border-radius:3px;';
                            entryHdr.innerHTML = `
                                <div style="width:5px; height:5px; border-radius:50%; background:${statusColor}; flex-shrink:0;" title="${item.is_active ? 'Active (visible to agent)' : 'Inactive'}"></div>
                                <span style="flex:1; font-size:10px; color:var(--rt-text); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(item.label)}</span>
                                <button class="rt-agent-entry-delete" data-id="${item.id}" style="background:none; border:none; color:var(--rt-text-muted); cursor:pointer; font-size:9px; padding:1px 3px; opacity:0; flex-shrink:0;" title="Delete entry"><i class="fa-solid fa-trash"></i></button>
                            `;

                            const entryBody = document.createElement('div');
                            entryBody.style.cssText = 'display:none; padding:4px 4px 6px 12px; flex-direction:column; gap:4px;';
                            entryBody.innerHTML = `
                                <div style="font-size:9px; opacity:0.5; color:var(--rt-text-muted); font-family:var(--rt-font-mono);">[${escapeHtml(item.keys.join(', '))}]</div>
                                <div style="font-size:10px; opacity:0.85; color:var(--rt-text); line-height:1.45; white-space:pre-wrap; word-break:break-word;">${escapeHtml(item.content)}</div>
                            `;

                            // Show delete button on hover
                            const delBtn = /** @type {HTMLButtonElement} */ (entryHdr.querySelector('.rt-agent-entry-delete'));
                            entryHdr.addEventListener('mouseenter', () => { delBtn.style.opacity = '0.5'; });
                            entryHdr.addEventListener('mouseleave', () => { delBtn.style.opacity = '0'; });

                            // Toggle entry body on click (but not on delete)
                            entryHdr.addEventListener('click', (e) => {
                                if (/** @type {HTMLElement} */ (e.target).closest('.rt-agent-entry-delete')) return;
                                const opening = entryBody.style.display === 'none';
                                entryBody.style.display = opening ? 'flex' : 'none';
                                entryHdr.style.background = opening ? 'rgba(255,255,255,0.05)' : '';
                            });

                            delBtn.addEventListener('click', async (e) => {
                                e.stopPropagation();
                                if (confirm(`Delete lore entry "${item.label}"?`)) {
                                    const ok = await deleteLorebookEntry(item.id);
                                    if (ok) {
                                        refreshManifest();
                                        // @ts-ignore
                                        toastr.success(`Deleted "${item.label}"`, 'Lorebook Agent');
                                    }
                                }
                            });

                            entryEl.appendChild(entryHdr);
                            entryEl.appendChild(entryBody);
                            folderBody.appendChild(entryEl);
                        }

                        folder.appendChild(folderHdr);
                        folder.appendChild(folderBody);
                        list.appendChild(folder);
                    }
                } catch (e) {
                    list.innerHTML = '<div style="text-align: center; color: #ff5555; font-size: 0.769em; padding: 10px;">Error loading manifest.</div>';
                }
            };

            const refreshBtn = agentPanel.querySelector('#rt-agent-manifest-refresh');
            if (refreshBtn) refreshBtn.addEventListener('click', () => refreshManifest('manual-button'));

            // Initial load so the list is populated without needing a manual click
            refreshManifest();

            const renderAgentModules = () => {
                const s = getSettings();
                const list = agentPanel.querySelector('#rt-agent-stock-modules-list');
                if (!list) return;
                list.innerHTML = '';
                Object.entries(s.routerModules || {}).forEach(([id, config]) => {
                    const row = document.createElement('div');
                    row.style.cssText = 'display: flex; gap: 4px; margin-bottom: 6px; align-items: center;';
                    row.innerHTML = `
                        <input type="checkbox" class="rt-agent-module-check" data-id="${id}" ${config.enabled ? 'checked' : ''} style="cursor: pointer; margin: 0;">
                        <div style="flex: 1; display: flex; flex-direction: column; gap: 2px;">
                            <div style="display: flex; justify-content: space-between; align-items: center;">
                                <div style="font-size: 0.769em; font-weight: bold; opacity: 0.7;">${config.tag}</div>
                                <button class="rt-agent-module-reset" data-id="${id}" style="background: transparent; border: none; color: var(--rt-accent); cursor: pointer; font-size: 0.769em; padding: 0 4px; opacity: 0.6; height: 14px;" title="Reset to Default"><i class="fa-solid fa-arrow-rotate-left"></i></button>
                            </div>
                            <input type="text" value="${escapeHtml(config.instruction)}" class="rt-agent-module-inst" data-id="${id}" style="width: 100%; background: rgba(0,0,0,0.3); color: var(--rt-text); border: 1px solid rgba(255,255,255,0.1); border-radius: 3px; font-size: 0.769em; padding: 2px 4px; box-sizing: border-box;">
                        </div>
                    `;
                    list.appendChild(row);
                });

                list.querySelectorAll('.rt-agent-module-check').forEach(cb => {
                    cb.addEventListener('change', (e) => {
                        const id = (/** @type {HTMLInputElement} */ (e.target)).dataset.id;
                        const val = (/** @type {HTMLInputElement} */ (e.target)).checked;
                        const s = getSettings();
                        s.routerModules[id].enabled = val;
                        saveSettings();
                    });
                });
                list.querySelectorAll('.rt-agent-module-inst').forEach(input => {
                    input.addEventListener('change', (e) => {
                        const target = /** @type {HTMLInputElement} */ (e.target);
                        const id = target.dataset.id;
                        const s = getSettings();
                        s.routerModules[id].instruction = target.value;
                        saveSettings();
                    });
                });
                list.querySelectorAll('.rt-agent-module-reset').forEach(btn => {
                    btn.addEventListener('click', (e) => {
                        const id = (/** @type {HTMLElement} */ (e.currentTarget)).dataset.id;
                        if (confirm(`Reset ${id.toUpperCase()} module instructions to default?`)) {
                            const s = getSettings();
                            // Pull fresh defaults directly from the exported constant — single source of truth
                            const defaults = DEFAULT_MODULES;
                            if (defaults[id]) {
                                s.routerModules[id].instruction = defaults[id].instruction;
                                saveSettings();
                                renderAgentModules();
                            }
                        }
                    });
                });
            };
            renderAgentModules();

            const renderAgentCustomTags = () => {
                const s = getSettings();
                const list = agentPanel.querySelector('#rt-agent-custom-tags-list');
                if (!list) return;
                list.innerHTML = '';
                (s.routerCustomTags || []).forEach((tag, idx) => {
                    const row = document.createElement('div');
                    row.style.cssText = 'display: flex; gap: 2px; margin-bottom: 2px; align-items: center;';
                    row.innerHTML = `
                        <input type="text" value="${tag.tag}" class="rt-custom-tag-name" data-idx="${idx}" placeholder="TAG" style="width: 60px; background: #111; color: #ddd; border: 1px solid #333; font-size: 0.769em; padding: 1px;">
                        <input type="text" value="${tag.instruction}" class="rt-custom-tag-inst" data-idx="${idx}" placeholder="Instructions..." style="flex: 1; background: #111; color: #ddd; border: 1px solid #333; font-size: 0.769em; padding: 1px;">
                        <button class="rt-custom-tag-del" data-idx="${idx}" style="background: #422; color: #f99; border: none; font-size: 0.769em; cursor: pointer; padding: 1px 4px;">✕</button>
                    `;
                    list.appendChild(row);
                });

                list.querySelectorAll('input').forEach(input => {
                    input.addEventListener('change', (e) => {
                        const target = /** @type {HTMLInputElement} */ (e.target);
                        const idx = parseInt(target.dataset.idx);
                        const s = getSettings();
                        if (target.classList.contains('rt-custom-tag-name')) s.routerCustomTags[idx].tag = target.value.toUpperCase();
                        else s.routerCustomTags[idx].instruction = target.value;
                        saveSettings();
                    });
                });
                list.querySelectorAll('.rt-custom-tag-del').forEach(btn => {
                    btn.addEventListener('click', (e) => {
                        const idx = parseInt((/** @type {HTMLElement} */ (e.currentTarget)).dataset.idx);
                        const s = getSettings();
                        s.routerCustomTags.splice(idx, 1);
                        saveSettings();
                        renderAgentCustomTags();
                    });
                });
            };

            const addTagBtn = agentPanel.querySelector('#rt-agent-add-custom-tag');
            if (addTagBtn) {
                addTagBtn.addEventListener('click', () => {
                    const s = getSettings();
                    if (!s.routerCustomTags) s.routerCustomTags = [];
                    s.routerCustomTags.push({ tag: 'NEW_TAG', instruction: 'New instructions...' });
                    saveSettings();
                    renderAgentCustomTags();
                });
            }
            renderAgentCustomTags();



            const lookbackInput = /** @type {HTMLInputElement} */ (agentPanel.querySelector('#rt-agent-router-lookback'));
            if (lookbackInput) {
                lookbackInput.addEventListener('change', (e) => {
                    const s = getSettings();
                    s.routerLookback = parseInt((/** @type {HTMLInputElement} */ (e.target)).value) || 4;
                    saveSettings();
                });
            }

            const directLookbackInput = /** @type {HTMLInputElement} */ (agentPanel.querySelector('#rt-agent-router-direct-lookback'));
            if (directLookbackInput) {
                directLookbackInput.addEventListener('change', (e) => {
                    const s = getSettings();
                    s.routerDirectLookback = parseInt((/** @type {HTMLInputElement} */ (e.target)).value);
                    saveSettings();
                });
            }

            const maxAct = /** @type {HTMLInputElement} */ (agentPanel.querySelector('#rt-agent-router-max-activations'));
            if (maxAct) {
                maxAct.addEventListener('change', () => {
                    const s = getSettings();
                    s.routerMaxActivations = parseInt(maxAct.value) || 5;
                    saveSettings();
                });
            }

            // Prefix is auto-derived from chat name — update read-only display in agent panel
            const panelPrefixDisplay = panel.querySelector('#rpg_tracker_router_prefix_display');
            if (panelPrefixDisplay) panelPrefixDisplay.textContent = settings.routerCampaignPrefix || '—';
            
            const sourceSel = /** @type {HTMLSelectElement} */ (agentPanel.querySelector('#rt-agent-router-source'));
            const profGrp = /** @type {HTMLElement} */ (agentPanel.querySelector('#rt-agent-router-profile-group'));
            const profSel = /** @type {HTMLSelectElement} */ (agentPanel.querySelector('#rt-agent-router-profile'));
            const ollGrp = /** @type {HTMLElement} */ (agentPanel.querySelector('#rt-agent-router-ollama-group'));
            const ollUrl = /** @type {HTMLInputElement} */ (agentPanel.querySelector('#rt-agent-router-ollama-url'));
            const ollMod = /** @type {HTMLSelectElement} */ (agentPanel.querySelector('#rt-agent-router-ollama-model'));
            const ollRef = /** @type {HTMLElement} */ (agentPanel.querySelector('#rt-agent-router-ollama-refresh'));
            const oaiGrp = /** @type {HTMLElement} */ (agentPanel.querySelector('#rt-agent-router-openai-group'));
            const oaiUrl = /** @type {HTMLInputElement} */ (agentPanel.querySelector('#rt-agent-router-openai-url'));
            const oaiKey = /** @type {HTMLInputElement} */ (agentPanel.querySelector('#rt-agent-router-openai-key'));
            const oaiMod = /** @type {HTMLSelectElement} */ (agentPanel.querySelector('#rt-agent-router-openai-model'));
            const oaiRef = /** @type {HTMLElement} */ (agentPanel.querySelector('#rt-agent-router-openai-refresh'));
            const oaiMan = /** @type {HTMLInputElement} */ (agentPanel.querySelector('#rt-agent-router-openai-model-manual'));
            const preSel = /** @type {HTMLSelectElement} */ (agentPanel.querySelector('#rt-agent-router-preset'));
            const maxTok = /** @type {HTMLInputElement} */ (agentPanel.querySelector('#rt-agent-router-max-tokens'));
            if (maxTok) {
                maxTok.addEventListener('input', (e) => {
                    const s = getSettings();
                    s.routerMaxTokens = parseInt((/** @type {HTMLInputElement} */ (e.target)).value) || 0;
                    $('#rpg_tracker_router_max_tokens').val(s.routerMaxTokens);
                    saveSettings();
                });
            }
            const maxTur = /** @type {HTMLInputElement} */ (agentPanel.querySelector('#rt-agent-router-max-turns'));
            if (maxTur) {
                maxTur.addEventListener('input', (e) => {
                    const s = getSettings();
                    s.routerMaxTurns = parseInt((/** @type {HTMLInputElement} */ (e.target)).value) || 5;
                    $('#rpg_tracker_router_max_turns').val(s.routerMaxTurns);
                    saveSettings();
                });
            }

            const directPromptInp = /** @type {HTMLTextAreaElement} */ (agentPanel.querySelector('#rt-agent-router-direct-prompt'));
            if (directPromptInp) {
                directPromptInp.addEventListener('input', (e) => {
                    const s = getSettings();
                    s.routerDirectPrompt = (/** @type {HTMLTextAreaElement} */ (e.target)).value;
                    saveSettings();
                });
            }

            const lookbackInp = /** @type {HTMLInputElement} */ (agentPanel.querySelector('#rt-agent-router-lookback'));
            if (lookbackInp) {
                lookbackInp.addEventListener('input', (e) => {
                    const s = getSettings();
                    s.routerLookback = parseInt((/** @type {HTMLInputElement} */ (e.target)).value) || 4;
                    $('#rpg_tracker_router_lookback').val(s.routerLookback);
                    saveSettings();
                });
            }

            // ── Include hidden messages ──
            const includeHiddenCheck = /** @type {HTMLInputElement} */ (agentPanel.querySelector('#rt-agent-router-include-hidden'));
            if (includeHiddenCheck) {
                includeHiddenCheck.addEventListener('change', () => {
                    const s = getSettings();
                    s.routerIncludeHidden = includeHiddenCheck.checked;
                    saveSettings();
                });
            }

            // ── Run-every counter ──
            const runEveryInput = /** @type {HTMLInputElement} */ (agentPanel.querySelector('#rt-agent-router-run-every'));
            if (runEveryInput) {
                runEveryInput.addEventListener('change', (e) => {
                    const s = getSettings();
                    s.routerRunEvery = parseInt((/** @type {HTMLInputElement} */ (e.target)).value) || 1;
                    saveSettings();
                });
            }

            // ── Agent pause button ──
            const agentPauseBtn = agentPanel.querySelector('#rt-agent-router-pause-btn');
            const agentPauseBanner = /** @type {HTMLElement} */ (agentPanel.querySelector('#rt-agent-pause-banner'));
            if (agentPauseBtn) {
                agentPauseBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const s = getSettings();
                    s.routerPaused = !s.routerPaused;
                    saveSettings();
                    agentPauseBtn.textContent = s.routerPaused ? '▶' : '⏸';
                    /** @type {HTMLElement} */ (agentPauseBtn).title = s.routerPaused
                        ? 'Resume Agent (auto-runs paused)'
                        : 'Pause Agent (skip auto-runs)';
                    /** @type {HTMLElement} */ (agentPauseBtn).style.color = s.routerPaused ? '#ffa500' : '';
                    if (agentPauseBanner) agentPauseBanner.textContent = s.routerPaused ? 'AGENT PAUSED' : '';
                });
            }

            const runDirectBtn = agentPanel.querySelector('#rt-agent-router-run-direct');
            if (runDirectBtn) {
                runDirectBtn.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    const s = getSettings();
                    const prompt = s.routerDirectPrompt?.trim() || null;
                    
                    const dlInput = /** @type {HTMLInputElement} */ (agentPanel.querySelector('#rt-agent-router-direct-lookback'));
                    const lookback = dlInput ? parseInt(dlInput.value) : (s.routerDirectLookback || 10);
                    
                    const { chat } = SillyTavern.getContext();
                    const combinedNarrative = getNarrativeBlocks(chat, -1, !!s.routerIncludeHidden);
                    toastr['info'](prompt ? "Running agent with specific command..." : "Starting manual research pass...");
                    await runRouterPass(combinedNarrative, prompt, lookback, true);
                });
            }

            const manualRunBtn = agentPanel.querySelector('#rt-agent-router-manual-run');
            if (manualRunBtn) {
                manualRunBtn.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    const s = getSettings();
                    const { chat } = SillyTavern.getContext();
                    const combinedNarrative = getNarrativeBlocks(chat, -1, !!s.routerIncludeHidden);
                    toastr['info']("Starting manual research pass...");
                    await runRouterPass(combinedNarrative, null, s.routerLookback || 4, true);
                });
            }

        // ── Lorebook Agent Detaching ──
        const detachBtn = /** @type {HTMLElement} */ (agentPanel.querySelector('#rt-agent-router-detach'));
        if (detachBtn) {
            const DETACHED_AGENT_KEY = 'rpg_tracker_agent_detached';
            const GEO_KEY = 'rpg_tracker_geometry_lorebook_agent';
            const isDetached = () => localStorage.getItem(DETACHED_AGENT_KEY) === 'true';

            /** @type {(() => void) | null} */
            let destroyAgentDraggable = null;

            const applyDetachedState = () => {
                if (isDetached()) {
                    agentPanel.classList.add('rt-detached-panel');
                    agentPanel.style.display = 'flex'; // Force visibility if detached
                    document.body.appendChild(agentPanel);
                    renderRouterUI(); // Ensure it's populated
                    refreshManifest();
                    const header = agentPanel.querySelector('.rpg-tracker-header');
                    if (header instanceof HTMLElement) {
                        destroyAgentDraggable = makeDraggable(agentPanel, header, GEO_KEY);
                    }
                    detachBtn.innerHTML = '↓';
                    detachBtn.title = 'Re-attach Lorebook Agent';
                    
                    // Restore geometry with off-screen protection
                    try {
                        const savedStr = localStorage.getItem(GEO_KEY);
                        const saved = savedStr ? JSON.parse(savedStr) : null;
                        
                        let left = 100;
                        let top = 100;
                        let width = 300;
                        let height = 400;

                        if (saved && typeof saved.left === 'number') {
                            const isOffScreen = (
                                saved.left + 50 > window.innerWidth || 
                                saved.top + 50 > window.innerHeight || 
                                saved.left < -250 || 
                                saved.top < -50
                            );
                            
                            if (!isOffScreen) {
                                left = saved.left;
                                top = saved.top;
                                if (saved.width) width = saved.width;
                                if (saved.height) height = saved.height;
                            }
                        }

                        agentPanel.style.left = left + 'px';
                        agentPanel.style.top = top + 'px';
                        agentPanel.style.width = width + 'px';
                        if (height) agentPanel.style.height = height + 'px';
                        agentPanel.style.right = 'auto';
                    } catch (e) {
                        agentPanel.style.left = '100px';
                        agentPanel.style.top = '100px';
                        agentPanel.style.width = '300px';
                    }
                } else {
                    if (destroyAgentDraggable) {
                        destroyAgentDraggable();
                        destroyAgentDraggable = null;
                    }
                    agentPanel.classList.remove('rt-detached-panel');
                    panel.appendChild(agentPanel);
                    agentPanel.style.left = ''; agentPanel.style.top = '30px'; agentPanel.style.right = '0';
                    agentPanel.style.width = '300px'; agentPanel.style.height = '';
                    detachBtn.innerHTML = '⧉';
                    detachBtn.title = 'Detach Lorebook Agent';
                }
            };

            detachBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                localStorage.setItem(DETACHED_AGENT_KEY, isDetached() ? 'false' : 'true');
                applyDetachedState();
            });

            // Initial apply
            if (isDetached()) applyDetachedState();
        }

        const updateRouterPanels = () => {
            const src = sourceSel.value;
                $(profGrp).stop(true, true)[src === 'profile' ? 'slideDown' : 'slideUp'](200);
                $(ollGrp).stop(true, true)[src === 'ollama' ? 'slideDown' : 'slideUp'](200);
                $(oaiGrp).stop(true, true)[src === 'openai' ? 'slideDown' : 'slideUp'](200);
            };

            if (sourceSel) {
                sourceSel.addEventListener('change', (e) => {
                    const s = getSettings();
                    s.routerConnectionSource = (/** @type {HTMLSelectElement} */ (e.target)).value;
                    saveSettings();
                    updateRouterPanels();
                });
            }

            if (profSel) {
                const ctx = SillyTavern.getContext();
                if (ctx.ConnectionManagerRequestService?.handleDropdown) {
                    /** @type {any} */ (ctx.ConnectionManagerRequestService).handleDropdown(profSel);
                    profSel.value = settings.routerConnectionProfileId || "";
                } else {
                    getConnectionProfiles().then(profiles => {
                        profSel.innerHTML = '<option value="">-- No Profile Selected --</option>';
                        profiles.forEach(p => {
                            const opt = document.createElement('option');
                            opt.value = p; opt.textContent = p;
                            profSel.appendChild(opt);
                        });
                        profSel.value = settings.routerConnectionProfileId || "";
                    });
                }
                profSel.addEventListener('change', () => {
                    getSettings().routerConnectionProfileId = profSel.value;
                    saveSettings();
                });
            }

            if (ollUrl) {
                ollUrl.addEventListener('input', () => {
                    getSettings().routerOllamaUrl = ollUrl.value;
                    saveSettings();
                });
            }
            if (ollMod) {
                ollMod.addEventListener('change', () => {
                    getSettings().routerOllamaModel = ollMod.value;
                    saveSettings();
                });
                ollRef.addEventListener('click', async () => {
                    if (!ollUrl.value) return toastr['info']("Enter Ollama URL first.");
                    try {
                        toastr['info']("Fetching Ollama models...");
                        const models = await fetchOllamaModels(ollUrl.value);
                        ollMod.innerHTML = '<option value="">-- Select Model --</option>';
                        models.forEach(m => {
                            const opt = document.createElement('option');
                            opt.value = m.name; opt.textContent = m.name;
                            ollMod.appendChild(opt);
                        });
                        ollMod.value = getSettings().routerOllamaModel || "";
                        toastr['success']("Ollama models updated.");
                    } catch (e) {
                        toastr['error']("Failed to fetch Ollama models.");
                    }
                });
            }

            if (oaiUrl) {
                oaiUrl.addEventListener('input', () => {
                    getSettings().routerOpenaiUrl = oaiUrl.value;
                    saveSettings();
                });
            }
            if (oaiKey) {
                oaiKey.addEventListener('input', () => {
                    getSettings().routerOpenaiKey = oaiKey.value;
                    saveSettings();
                });
            }
            if (oaiMod) {
                oaiMod.addEventListener('change', () => {
                    if (oaiMod.value) {
                        oaiMan.value = '';
                        getSettings().routerOpenaiModel = oaiMod.value;
                    } else {
                        getSettings().routerOpenaiModel = oaiMan.value.trim();
                    }
                    saveSettings();
                });
                oaiRef.addEventListener('click', async () => {
                    if (!oaiUrl.value) return toastr['info']("Enter Endpoint URL first.");
                    try {
                        toastr['info']("Fetching models...");
                        const models = await fetchOpenAIModels(oaiUrl.value, oaiKey.value);
                        oaiMod.innerHTML = '<option value="">-- Select Model --</option>';
                        models.forEach(m => {
                            const id = typeof m === 'string' ? m : (m.id || m.name);
                            const opt = document.createElement('option');
                            opt.value = id; opt.textContent = id;
                            oaiMod.appendChild(opt);
                        });
                        oaiMod.value = getSettings().routerOpenaiModel || "";
                        toastr['success']("Models updated.");
                    } catch (e) {
                        toastr['warning']("Cannot auto-detect models (CORS). Type manually.");
                    }
                });
            }
            if (oaiMan) {
                oaiMan.addEventListener('input', () => {
                    if (oaiMan.value.trim()) oaiMod.value = '';
                    getSettings().routerOpenaiModel = oaiMan.value.trim() || oaiMod.value;
                    saveSettings();
                });
            }

            if (preSel) {
                const ctx = SillyTavern.getContext();
                const pm = ctx.getPresetManager ? ctx.getPresetManager() : null;
                if (pm && typeof pm.getAllPresets === 'function') {
                    const presets = pm.getAllPresets();
                    preSel.innerHTML = '<option value="">-- Use Current Settings --</option>';
                    presets.forEach(p => {
                        const opt = document.createElement('option');
                        opt.value = p; opt.textContent = p;
                        preSel.appendChild(opt);
                    });
                    preSel.value = settings.routerCompletionPresetId || '';
                }
                preSel.addEventListener('change', () => {
                    getSettings().routerCompletionPresetId = preSel.value;
                    saveSettings();
                });
            }

            if (maxTok) {
                maxTok.addEventListener('input', () => {
                    getSettings().routerMaxTokens = parseInt(maxTok.value) || 0;
                    saveSettings();
                });
            }
        }
        
        // ── Lorebook Agent History Nav (← [LIVE] →) ─────────────────────────
        const agentNavBack  = /** @type {HTMLButtonElement|null} */ (agentPanel.querySelector('#rt-agent-nav-back'));
        const agentNavFwd   = /** @type {HTMLButtonElement|null} */ (agentPanel.querySelector('#rt-agent-nav-fwd'));
        const agentNavLabel = /** @type {HTMLElement|null} */ (agentPanel.querySelector('#rt-agent-nav-label'));

        const syncAgentNav = () => {
            const s = getSettings();
            const histLen  = (s.routerHistory || []).length;
            const redoLen  = _loreRedoStack.length;
            if (agentNavBack)  agentNavBack.disabled  = histLen === 0;
            if (agentNavFwd)   agentNavFwd.disabled   = redoLen === 0;
            if (agentNavLabel) {
                if (redoLen === 0) {
                    agentNavLabel.textContent = '[ LIVE ]';
                    agentNavLabel.title = 'Lorebook is at current live state';
                } else {
                    agentNavLabel.textContent = `[ -${redoLen} ]`;
                    agentNavLabel.title = `Rolled back ${redoLen} agent pass${redoLen !== 1 ? 'es' : ''} — use → to redo`;
                }
                agentNavLabel.classList.remove('clickable');
            }
        };

        /** Snapshot the current lorebook state for the books touched by the given history entry. */
        const captureCurrentLoreState = async (histEntry) => {
            const ctx = SillyTavern.getContext();
            const s   = getSettings();
            const bookNames = Object.keys(histEntry.bookSnapshots || {});
            const bookSnapshots = {};
            for (const name of bookNames) {
                try {
                    const book = await ctx.loadWorldInfo(name);
                    if (book) bookSnapshots[name] = JSON.parse(JSON.stringify(book));
                } catch (_) {}
            }
            return {
                timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                activeRouterKeys: JSON.parse(JSON.stringify(s.activeRouterKeys || [])),
                bookSnapshots,
            };
        };

        if (agentNavBack) {
            agentNavBack.addEventListener('click', async () => {
                const s = getSettings();
                if (!(s.routerHistory || []).length) return;
                agentNavBack.disabled = true;
                if (agentNavFwd) agentNavFwd.disabled = true;
                const histEntry = s.routerHistory[0];
                const postPassState = await captureCurrentLoreState(histEntry);
                const ok = await rollbackRouterPass(0);
                if (ok) {
                    _loreRedoStack.push({ prePassSnapshot: histEntry, postPassState });
                } else {
                    toastr['error']('Rollback failed. Check console.', 'Lorebook Agent');
                }
                syncAgentNav();
                await refreshManifest();
            });
        }

        if (agentNavFwd) {
            agentNavFwd.addEventListener('click', async () => {
                if (!_loreRedoStack.length) return;
                if (agentNavBack) agentNavBack.disabled = true;
                agentNavFwd.disabled = true;
                const redoEntry = _loreRedoStack.pop();
                const ok = await reapplyRouterPass(redoEntry.prePassSnapshot, redoEntry.postPassState);
                if (!ok) {
                    _loreRedoStack.push(redoEntry);
                    toastr['error']('Redo failed. Check console.', 'Lorebook Agent');
                }
                syncAgentNav();
                await refreshManifest();
            });
        }

        // updateUndoLabel kept as alias so existing call-sites still compile
        const updateUndoLabel = syncAgentNav;
        // ── Active Keys Refresh Button ────────────────────────────────────────
        const keysRefreshBtn = agentPanel.querySelector('#rt-agent-keys-refresh');
        if (keysRefreshBtn) {
            keysRefreshBtn.addEventListener('click', async () => {
                keysRefreshBtn.querySelector('i')?.classList.add('fa-spin');
                const _ctx = SillyTavern.getContext();
                if (typeof _ctx.updateWorldInfoList === 'function') {
                    try { await _ctx.updateWorldInfoList(); } catch (_) {}
                }
                await renderRouterUI();
                keysRefreshBtn.querySelector('i')?.classList.remove('fa-spin');
            });
        }

        updateUndoLabel();

        document.addEventListener('rt_lore_agent_updated', async () => {
            saveSettings();
            // Flush ST's in-memory lorebook cache before re-rendering so that
            // loadWorldInfo() picks up the entries we just wrote via the HTTP API.
            const _ctx = SillyTavern.getContext();
            if (typeof _ctx.updateWorldInfoList === 'function') {
                try { await _ctx.updateWorldInfoList(); } catch (_) {}
            }
            await renderRouterUI();
            updateUndoLabel();
        });

        // ── Lorebook Terminal Logic ──
        let _routerSteps = [];
        const terminal = agentPanel.querySelector('#rt-agent-router-terminal');
        const terminalClear = agentPanel.querySelector('#rt-agent-router-terminal-clear');
        const logClear = agentPanel.querySelector('#rt-agent-router-log-clear');

        document.addEventListener('rt_lore_agent_step', (e) => {
            if (!terminal) return;
            const step = (/** @type {CustomEvent} */ (e)).detail;
            
            if (step.type === 'start') {
                _routerSteps = [];
                _loreRedoStack = [];
                syncAgentNav();
            }
            _routerSteps.push(step);

            terminal.innerHTML = renderLorebookTerminal(_routerSteps);
            terminal.scrollTop = terminal.scrollHeight;

            // Refresh Campaign Records after the pass fully completes — at this point
            // all applyAction writes and saveWorldInfo cache-busts are guaranteed done.
            if (step.type === 'finish' || step.type === 'error') {
                refreshManifest();
            }
        });

        if (terminalClear) {
            terminalClear.addEventListener('click', () => {
                _routerSteps = [];
                if (terminal) terminal.innerHTML = '<div style="opacity: 0.4; font-size: 0.769em; font-style: italic;">Waiting for agent activity...</div>';
            });
        }

        if (logClear) {
            logClear.addEventListener('click', () => {
                const s = getSettings();
                s.routerLog = [];
                saveSettings();
                renderRouterUI();
            });
        }



        updateChatLinkUI();
        updatePanelStatus();

        // Handle manual edits to live memo
        const textarea = panel.querySelector('#rpg-tracker-memo');
        let _rawEditDebounce = null;
        textarea.addEventListener('input', (e) => {
            if (_historyViewIndex !== -1) return;
            const newText = /** @type {HTMLTextAreaElement} */ (e.target).value;
            settings.currentMemo = newText;
            
            // Sync internal quest state
            syncQuestsFromMemo(newText);

            panel.querySelector('#rpg-tracker-count').textContent = `~${Math.round(settings.currentMemo.length / 2.62)} tokens`;
            saveSettings();
            // Refresh the rendered view live so changes are visible without toggling modes
            clearTimeout(_rawEditDebounce);
            _rawEditDebounce = setTimeout(refreshRenderedView, 400);
        });

        // (RNG footer toggles removed; managed via settings.html)

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
            saveSettings();
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
            saveSettings();
        });

        // Delta resize handle drag
        setupDeltaResize(/** @type {HTMLElement} */(panel));

        // Close panel
        panel.querySelector('#rpg-tracker-close-btn').addEventListener('click', () => {
            panel.style.display = 'none';
            settings.closeCount = (settings.closeCount || 0) + 1;
            // Only show toast on the 1st close and every 10th close thereafter
            if (settings.closeCount === 1 || settings.closeCount % 10 === 0) {
                toastr['info']('Tracker hidden. You can reopen it at any time from the Extensions (Wand) Menu.', 'RPG Tracker');
            }
            saveSettings();
        });

        // Context Debugger toggle
        panel.querySelector('#rpg-tracker-debug-btn').addEventListener('click', () => {
            toggleDebugViewer();
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
        panel.querySelector('#rt-prompt-context-val').addEventListener('change', (e) => {
            settings.directPromptContext = parseInt(/** @type {HTMLInputElement} */(e.target).value) || 0;
            saveSettings();
        });

        // Manual update from panel button
        const manualUpdate = async (type = 'regular') => {
            const { chat, Popup } = SillyTavern.getContext();
            let narrative = "";
            let isFullAudit = false;
            let customLookbackN = null;

            if (type === 'regular') {
                narrative = getNarrativeBlocks(chat, -1);
            } else if (type === 'full') {
                isFullAudit = true;
            } else if (type === 'custom') {
                const count = await Popup.show.input("RPG Tracker", "How many messages back should I parse?", "5");
                if (!count || isNaN(parseInt(count))) return;
                customLookbackN = parseInt(count);
                narrative = getNarrativeBlocks(chat, customLookbackN);
            }

            if (type !== 'full' && !narrative) return toastr['info']("No assistant message to parse.", "RPG Tracker");

            toastr['info'](isFullAudit ? "Triggering Full Context Audit..." : "Triggering manual State Update...", "RPG Tracker");
            await runStateModelPass(narrative, isFullAudit, customLookbackN);
        };

        const updateBtn = panel.querySelector('#rpg-tracker-update-btn');
        const updateMenu = document.createElement('div');
        updateMenu.className = 'rt-update-menu';
        updateMenu.style.display = 'none';
        updateMenu.innerHTML = `
            <div class="rt-menu-item" id="rt-update-regular"><b>Regular Update</b><small>Since last user message</small></div>
            <div class="rt-menu-item" id="rt-update-custom"><b>Lookback Update</b><small>Last N messages</small></div>
            <div class="rt-menu-item" id="rt-update-full"><b>Full Context Audit</b><small>Re-examine whole history</small></div>
        `;
        panel.appendChild(updateMenu);

        updateBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const isVisible = updateMenu.style.display !== 'none';

            // Close all other menus possibly
            document.querySelectorAll('.rt-update-menu').forEach(m => /** @type {HTMLElement} */(m).style.display = 'none');

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

        updateMenu.querySelector('#rt-update-regular').addEventListener('click', () => manualUpdate('regular'));
        updateMenu.querySelector('#rt-update-custom').addEventListener('click', () => manualUpdate('custom'));
        updateMenu.querySelector('#rt-update-full').addEventListener('click', () => manualUpdate('full'));

        // Link the settings button too if it's already rendered
        // For settings button, we'll keep it simple or just trigger regular
        $('#rpg_tracker_btn_update').off('click').on('click', () => manualUpdate('regular'));

        // Snapshot navigation
        panel.querySelector('#rpg-tracker-nav-back').addEventListener('click', () => navigateSnapshot(1));
        panel.querySelector('#rpg-tracker-nav-fwd').addEventListener('click', () => navigateSnapshot(-1));

        // Footer Expand/Collapse (Mobile)
        panel.querySelector('#rt-footer-expand-btn').addEventListener('click', () => {
            const footer = document.getElementById('rt-main-footer');
            if (footer) {
                footer.classList.toggle('rt-footer-expanded');
                const icon = footer.querySelector('#rt-footer-expand-btn i');
                if (icon) {
                    if (footer.classList.contains('rt-footer-expanded')) {
                        icon.classList.replace('fa-chevron-up', 'fa-chevron-down');
                    } else {
                        icon.classList.replace('fa-chevron-down', 'fa-chevron-up');
                    }
                }
            }
        });

        // Restore via label click (Commit)
        panel.querySelector('#rpg-tracker-nav-label').addEventListener('click', () => {
            const s = getSettings();
            if (_historyViewIndex === -1) return;
            const snapshot = s.memoHistory[_historyViewIndex];
            if (snapshot === undefined) return;

            // Simply move the live pointer to this snapshot.
            // The history already contains all states — no need to archive currentMemo here.
            // Direct Prompt and runStateModelPass handle archiving when they produce new states.
            s.currentMemo = snapshot;
            s.historyIndex = _historyViewIndex;
            _historyViewIndex = -1;
            saveSettings();
            syncMemoView();
            toastr['success']('Historical state restored as LIVE.', 'RPG Tracker');
        });

        // Clear memo button
        panel.querySelector('#rpg-tracker-memo-clear').addEventListener('click', () => {
            if (confirm("Are you sure you want to clear the memory history and wipe the tracker?")) {
                settings.currentMemo = "";
                settings.prevMemo1 = "";
                settings.prevMemo2 = "";
                settings.memoHistory = [];
                settings.historyIndex = -1;
                settings.lastDelta = "";
                _historyViewIndex = -1;
                saveSettings();
                syncMemoView();
                const dp = document.getElementById('rpg-tracker-delta-content');
                if (dp) dp.innerHTML = '<span class="delta-empty">Log cleared.</span>';
                toastr['success']("RPG Tracker logic wiped.", "RPG Tracker");
            }
        });

        syncMemoView();
    }

    function navigateSnapshot(direction) {
        const s = getSettings();
        const L = s.historyIndex === undefined ? -1 : s.historyIndex;
        const maxIndex = s.memoHistory.length - 1;
        const maxPos = L === -1 ? maxIndex + 1 : maxIndex;
        
        let pos = L === -1 
            ? (_historyViewIndex === -1 ? 0 : _historyViewIndex + 1)
            : (_historyViewIndex === -1 ? L : _historyViewIndex);
            
        pos += direction;
        
        if (pos < 0) pos = 0;
        if (pos > maxPos) pos = maxPos;
        
        _historyViewIndex = L === -1
            ? (pos === 0 ? -1 : pos - 1)
            : (pos === L ? -1 : pos);
            
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
        const L = s.historyIndex === undefined ? -1 : s.historyIndex;
        const livePos = L === -1 ? 0 : L;
        const currentPos = L === -1 
            ? (_historyViewIndex === -1 ? 0 : _historyViewIndex + 1)
            : (_historyViewIndex === -1 ? L : _historyViewIndex);

        const maxPos = L === -1 ? histLen : histLen - 1;

        if (_historyViewIndex === -1) {
            // LIVE stone
            textarea.value = s.currentMemo;
            textarea.readOnly = false;
            navLabel.classList.remove('clickable');
            navLabel.title = 'Current Live State';
        } else {
            // Snapshot stone
            const snapshot = s.memoHistory[_historyViewIndex];
            textarea.value = snapshot ?? '';
            textarea.readOnly = true;
            navLabel.classList.add('clickable');
            navLabel.title = 'Click to RESTORE this state as LIVE';
        }

        const distance = currentPos - livePos;
        if (distance === 0) {
            navLabel.textContent = '[ LIVE ]';
        } else if (distance > 0) {
            navLabel.textContent = `[ -${distance} 🔄 ]`;
        } else {
            navLabel.textContent = `[ +${Math.abs(distance)} 🔄 ]`;
        }

        btnBack.disabled = currentPos >= maxPos;
        btnFwd.disabled = currentPos <= 0;

        if (counter) {
            counter.textContent = `~${Math.round(textarea.value.length / 2.62)} tokens`;
        }

        // Update delta panel: always show the diff that created the currently-viewed state
        const deltaPanel = document.getElementById('rpg-tracker-delta-content');
        if (deltaPanel) {
            let deltaHtml = '';
            const activeIdx = (_historyViewIndex === -1) ? L : _historyViewIndex;

            if (activeIdx === -1) {
                deltaHtml = s.lastDelta || '<span class="delta-empty">No changes yet.</span>';
            } else {
                const current  = s.memoHistory[activeIdx];
                const previous = s.memoHistory[activeIdx + 1] || '';
                deltaHtml = computeDelta(previous, current);
            }
            deltaPanel.innerHTML = deltaHtml;
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

        const onPointerDown = (e) => {
            if (e.button !== 0) return;
            // Ignore clicks on buttons inside the header
            if (e.target instanceof Element && e.target.closest('button')) return;
            isDragging = true;
            handle.setPointerCapture(e.pointerId);
            const rect = panel.getBoundingClientRect();
            startX = e.clientX; startY = e.clientY;
            startLeft = rect.left; startTop = rect.top;
            panel.style.left = startLeft + 'px';
            panel.style.top = startTop + 'px';
            panel.style.right = 'auto';
            panel.style.bottom = 'auto';
            e.preventDefault();
        };

        const onPointerMove = (e) => {
            if (!isDragging) return;
            const left = startLeft + (e.clientX - startX);
            const top = startTop + (e.clientY - startY);

            // Constrain to viewport (ensure header stays reachable)
            const boundedLeft = Math.max(0, Math.min(window.innerWidth - 100, left));
            const boundedTop = Math.max(0, Math.min(window.innerHeight - 50, top));

            panel.style.left = boundedLeft + 'px';
            panel.style.top = boundedTop + 'px';
        };

        const onPointerUp = () => {
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
        };

        handle.addEventListener('pointerdown', onPointerDown);
        handle.addEventListener('pointermove', onPointerMove);
        handle.addEventListener('pointerup', onPointerUp);
        handle.addEventListener('pointercancel', () => { isDragging = false; });

        return () => {
            isDragging = false;
            handle.removeEventListener('pointerdown', onPointerDown);
            handle.removeEventListener('pointermove', onPointerMove);
            handle.removeEventListener('pointerup', onPointerUp);
        };
    }

    /**
     * Top-Right corner resizer logic
     * @param {HTMLElement} panel 
     * @param {HTMLElement} handle 
     */
    function makeResizableTR(panel, handle) {
        let startX, startY, startWidth, startHeight, startTop, startLeft;

        handle.addEventListener('pointerdown', (e) => {
            if (e.button !== 0) return;
            handle.setPointerCapture(e.pointerId);
            const rect = panel.getBoundingClientRect();
            startX = e.clientX;
            startY = e.clientY;
            startWidth = rect.width;
            startHeight = rect.height;
            startTop = rect.top;
            startLeft = rect.left;

            panel.style.left = startLeft + 'px';
            panel.style.top = startTop + 'px';
            panel.style.right = 'auto';
            panel.style.bottom = 'auto';

            e.preventDefault();
            e.stopPropagation();
        });

        handle.addEventListener('pointermove', (e) => {
            if (!handle.hasPointerCapture(e.pointerId)) return;
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;

            const newWidth = Math.max(220, startWidth + dx);
            const newHeight = Math.max(200, startHeight - dy);
            const newTop = startTop + dy;

            panel.style.width = newWidth + 'px';
            if (newHeight > 200) {
                panel.style.height = newHeight + 'px';
                panel.style.top = newTop + 'px';
            }
        });

        handle.addEventListener('pointerup', (e) => {
            if (handle.hasPointerCapture(e.pointerId)) {
                savePanelGeometry(panel);
            }
        });

        handle.addEventListener('pointercancel', () => {});
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

        handle.addEventListener('pointerdown', (e) => {
            startY = e.clientY;
            startH = deltaEl.offsetHeight;
            handle.setPointerCapture(e.pointerId);
            e.preventDefault();
        });

        handle.addEventListener('pointermove', (e) => {
            if (!handle.hasPointerCapture(e.pointerId)) return;
            const newH = Math.max(40, startH - (e.clientY - startY));
            deltaEl.style.height = newH + 'px';
        });

        handle.addEventListener('pointerup', (e) => {
            if (handle.hasPointerCapture(e.pointerId)) {
                saveDeltaHeight(deltaEl.offsetHeight);
            }
        });

        handle.addEventListener('pointercancel', () => {});
    }

    function updateUIMemo(text) {
        if (_historyViewIndex !== -1) return; // don't clobber snapshot view
        const textarea = /** @type {HTMLTextAreaElement|null} */ (document.getElementById('rpg-tracker-memo'));
        if (textarea) textarea.value = text;
        const counter = document.getElementById('rpg-tracker-count');
        if (counter) counter.textContent = `~${Math.round(text.length / 2.62)} tokens`;
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

    const RENDER_HINTS = {
        CHARACTER: {
            label: 'Entity Rows — HP Bars (Characters)',
            description: 'Each entity is one row with an HP bar. First line: "Name (Race/Class): cur/max HP". Sub-lines: Att/def, Attr, Saves, Skills, Traits, HD, Status.',
            example: 'Korgath Iron-Hide (Dwarven Warrior): 32/32 HP\nAtt/def: Volcanic Mace (+1 / 2d6+3) | Furs (AC: 13)\nAttr: STR 16, DEX 12, CON 16, INT 8, WIS 16, CHA 6\nSaves: Fort +6 | Ref +1 | Will +1\nSkills: Athletics +5, Intimidation +4\nHD: d10 (2/2)\nStatus: Healthy'
        },
        COMBAT: {
            label: 'Entity Rows — HP Bars (Enemies)',
            description: 'Same entity-row format as Characters. Optionally starts with a "COMBAT ROUND N" header line. Each enemy: "Name (Type): cur/max HP". Sub-lines: Att/def, Saves, Status.',
            example: 'COMBAT ROUND 1\nSkritch (Goblin Minion): 8/8 HP\nAtt/def: Pickaxe (+3 / 1d6+1 P) | Furs (AC: 12)\nSaves: Fort +0, Ref +2, Will +0\nStatus: Healthy\n\nGrak (Goblin Minion): 8/8 HP\nAtt/def: Jagged Stone (+3 / 1d4+1 B) | Furs (AC: 12)\nStatus: Healthy'
        },
        SPELLS: {
            label: 'Spell Pips — Slot Tracker',
            description: 'One line per spell level. Cantrips: comma-separated names. Slots: "Level N (available/max): Spell1, Spell2".',
            example: 'Cantrips: Guidance, Resistance\nLevel 1 (2/2): Cure Wounds, Shield of Faith\nLevel 2 (1/3): Hold Person, Silence'
        },
        INVENTORY: {
            label: 'Bullet Points — Item List',
            description: 'One item per line. Leading "- " dashes are stripped. Supports <font color=...> tags for rarity/class coloring.',
            example: '- <font color=#ff8000>Volcanic Mace (+1 / 2d6+3 Fire)</font>\n- <font color=#a335ee>Cloak of Displacement</font>\n- <font color=#0070dd>Healing Potion (Greater)</font> x2\n- <font color=#1eff00>Iron Buckler (AC +2)</font>\n- <font color=#aaaaaa>Rope (50 ft)</font>\n- 80 gold pieces'
        },
        ABILITIES: {
            label: 'Oval Pills — Trait Tags',
            description: 'Each line becomes a clickable pill. Text in parentheses (e.g. 10/15) is tracked as a resource. Supports <font color=...> tags.',
            example: '- Lay on Hands (10/15, Heal 1 HP per point)\n- Divine Sense (3/4, Detect celestials/fiends/undead)\n- <font color=#ffaa00>Hasted (Double speed, +2 AC)</font>\n- <font color=#ff5555>Poisoned (Disadvantage on attacks)</font>'
        }
    };

    // Row type options shared by both the custom field editor and the global sub-field rules list
    const ROW_TYPE_OPTIONS = [
        ['pills',     'Pills (comma-separated chips)'],
        ['badge',     'Badge (single chip)'],
        ['highlight', 'Highlight (paren emphasis)'],
        ['hp_bar',    'HP Bar (X/Y progress)'],
        ['xp_bar',    'XP Bar (X/Y with optional level)'],
        ['kv',        'Key / Value pair'],
        ['text',      'Plain Text'],
    ];

    function buildRowTypeSelect(selectedVal) {
        const sel = document.createElement('select');
        sel.className = 'text_pole';
        sel.style.cssText = 'flex:2; min-width:110px; height:28px; padding:2px 4px; font-size:12px;';
        ROW_TYPE_OPTIONS.forEach(([val, label]) => {
            const opt = document.createElement('option');
            opt.value = val; opt.textContent = label;
            if (val === selectedVal) opt.selected = true;
            sel.appendChild(opt);
        });
        return sel;
    }

    function openCustomFieldEditor(index) {
        const isSmallScreen = window.innerWidth <= 700;
        const s = getSettings();
        const field = s.customFields[index];
        const overlay = document.createElement('div');
        overlay.id = 'rt_cfe_overlay';
        overlay.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;background:rgba(0,0,0,0.7);backdrop-filter:blur(2px);z-index:10000000;display:none;align-items:center;justify-content:center;overflow-y:auto;';

        overlay.innerHTML = `
            <div id="rt_cfe_modal" class="popup shadowBase" style="
                width: min(540px, 94vw);
                height: ${isSmallScreen ? '85vh' : 'auto'};
                max-height: ${isSmallScreen ? '90vh' : '850px'};
                margin: auto;
                display: flex;
                flex-direction: column;
                padding: 0;
                overflow: hidden;
            ">
                <div class="popup-header">
                    <h3 class="margin0" style="font-size:14px; flex:1;">Custom Module Editor</h3>
                    <div id="rt_cfe_close" class="popup-close interactable" title="Close"><i class="fa-solid fa-times"></i></div>
                </div>
                <div class="popup-body flex-container flexFlowColumn gap-1" style="padding:10px 14px; overflow-y:auto; flex:1;">
                    <!-- Identity row -->
                    <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;">
                        <input type="text" id="rt_cfe_icon" class="text_pole" style="width:44px;text-align:center;" title="Icon (emoji)">
                        <input type="text" id="rt_cfe_tag"  class="text_pole" style="width:100px;font-family:monospace;" placeholder="TAG">
                        <input type="text" id="rt_cfe_label" class="text_pole" style="flex:1;min-width:80px;" placeholder="Display label">
                    </div>

                    <!-- Layout Options -->
                    <div style="display:flex; align-items:center; gap:10px; margin-top:4px; padding:2px 4px;">
                        <div style="display:flex; align-items:center; gap:6px;">
                            <span style="font-size:12px; font-weight:bold; opacity:0.8;">Pagination Threshold:</span>
                            <input type="number" id="rt_cfe_pagesize" class="text_pole" style="width:50px; height:24px; text-align:center;" min="1" max="99" title="How many items to show before adding page buttons">
                            <span style="font-size:11px; opacity:0.6;">entries</span>
                        </div>
                    </div>

                    <!-- AI Instructions -->
                    <div style="margin-top:12px; padding:10px; background:rgba(0,0,0,0.2); border-radius:8px; border:1px solid rgba(255,255,255,0.05);">
                        <div style="display:flex; align-items:center; gap:6px; margin-bottom:6px;">
                            <i class="fa-solid fa-robot" style="opacity:0.7;"></i>
                            <b style="font-size:12px;">AI Instructions</b>
                        </div>
                        <textarea id="rt_cfe_prompt" class="text_pole" rows="10" style="resize:vertical; width:100%;" placeholder="What should the AI track and in what format? Define the instructions. You can use the box below with the live preview (desktop only for now!) to create and paste a formatting instructions template here.&#10;&#10;Example: Track the Limit Break charge level of the protagonist. Increment Times Used on use; increase level by 1 on each use.&#10;&#10;Format:&#10;[LIMIT BREAK]&#10;((XPBAR)) Limit Break: 10/100 Level 4&#10;Times Used: 3&#10;[/LIMIT BREAK]"></textarea>
                    </div>

                    <!-- Testing Sandbox -->
                    <div style="margin-top:15px;">
                        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
                             <b style="font-size:13px;">Testing Sandbox (desktop only) <i class="fa-solid fa-circle-question" style="opacity:0.5; cursor:help; font-size:11px;" title="This box is ONLY for testing how the UI renders your formatting. Nothing from this box is sent to the AI. You must manually include any formatting examples in the 'AI Instructions' box above."></i></b>
                        </div>
                        <textarea id="rt_cfe_template" class="text_pole" rows="8" style="resize:vertical; width:100%; font-family:monospace; font-size:12px;" placeholder="Example:\n((PILLS)) Skills: Stealth, Deception\nHP: 10/100"></textarea>
                    </div>
                </div>
                <!-- Footer -->
                <div class="popup-footer flex-container gap-1 justifycontentend" style="padding:8px 14px; border-top:1px solid rgba(255,255,255,0.08); flex-shrink:0;">
                    <button id="rt_cfe_delete" class="menu_button interactable" style="color:#ff5555;font-size:12px;"><i class="fa-solid fa-trash"></i> Delete</button>
                    <button id="rt_cfe_export" class="menu_button interactable" style="font-size:12px;margin-right:auto;" title="Export this module as a shareable code"><i class="fa-solid fa-file-export"></i> Export</button>
                    <button id="rt_cfe_cancel" class="menu_button interactable" style="font-size:12px;">Cancel</button>
                    <button id="rt_cfe_save" class="menu_button interactable" style="font-size:12px;">Save Changes</button>
                </div>
            </div>
            <!-- Floating preview -->
            <div id="rt_cfe_preview" class="rpg-tracker-panel" style="margin:0;display:none;flex-direction:column;cursor:default;height:auto;min-height:44px;width:300px;position:fixed;">
                <div id="rt_cfe_preview_header" class="rpg-tracker-header" style="cursor:move;user-select:none;font-size:0.75em;opacity:0.7;padding:5px 10px;"><i class="fa-solid fa-grip-lines" style="margin-right:6px;"></i>UI Live Preview</div>
                <div id="rt_cfe_preview_view" class="rpg-tracker-render-view"></div>
            </div>
        `;
        document.body.appendChild(overlay);
        overlay.addEventListener('mousedown', e => e.stopPropagation());
        overlay.addEventListener('click', e => e.stopPropagation());

        const iconEl     = /** @type {HTMLInputElement}    */ (document.getElementById('rt_cfe_icon'));
        const tagEl      = /** @type {HTMLInputElement}    */ (document.getElementById('rt_cfe_tag'));
        const labelEl    = /** @type {HTMLInputElement}    */ (document.getElementById('rt_cfe_label'));
        const templateEl = /** @type {HTMLTextAreaElement} */ (document.getElementById('rt_cfe_template'));
        const promptEl   = /** @type {HTMLTextAreaElement} */ (document.getElementById('rt_cfe_prompt'));
        const previewEl  = document.getElementById('rt_cfe_preview');
        const pageSizeEl = /** @type {HTMLInputElement}    */ (document.getElementById('rt_cfe_pagesize'));

        iconEl.value     = field.icon  || '📄';
        tagEl.value      = field.tag   || '';
        labelEl.value    = field.label || '';
        templateEl.value = field.template || '';
        // Legacy cleanup: clear the old placeholder text if it's stored as a value
        if (field.prompt === 'What should the AI track for this new field? Describe it here.') {
            field.prompt = '';
        }
        promptEl.value   = field.prompt || '';
        pageSizeEl.value = String(s.modulePageSizes?.[field.tag.toUpperCase()] ?? (field.tag.toUpperCase() === 'SPELLS' ? 5 : PAGE_SIZE));

        // ── Live Preview ──
        let _previewDebounce = null;
        let _bgRefreshDebounce = null;
        const schedulePreview = () => {
            clearTimeout(_previewDebounce);
            _previewDebounce = setTimeout(updatePreview, 180);
            clearTimeout(_bgRefreshDebounce);
            _bgRefreshDebounce = setTimeout(refreshRenderedView, 300);
        };

        const renderPreviewInto = (targetEl) => {
            const renderView = targetEl || document.getElementById('rt_cfe_preview_view');
            if (!renderView) return;

            const testContent = templateEl.value || 'Nothing in testing sandbox';
            const previewTag = '__PREVIEW__';
            const fakeMemo = `[${previewTag}]\n${testContent}\n[/${previewTag}]`;

            const ghostField = {
                tag:     previewTag,
                label:   labelEl.value || tagEl.value || 'Preview',
                icon:    iconEl.value || '📄',
                template: templateEl.value,
                prompt:  '',
                enabled: true
            };
            const savedCustomFields = s.customFields;
            s.customFields = [...savedCustomFields, ghostField];
            try {
                renderView.innerHTML = renderMemoAsCards(fakeMemo, previewTag, _sectionPages);
                bindRenderedCardEvents(renderView, fakeMemo, true, () => renderPreviewInto(targetEl));
            } finally {
                s.customFields = savedCustomFields;
            }
        };

        const updatePreview = () => renderPreviewInto(null);

        iconEl.addEventListener('input', schedulePreview);
        tagEl.addEventListener('input', schedulePreview);
        labelEl.addEventListener('input', schedulePreview);
        templateEl.addEventListener('input', schedulePreview);
        pageSizeEl.addEventListener('input', () => {
            if (!s.modulePageSizes) s.modulePageSizes = {};
            const val = parseInt(String(pageSizeEl.value), 10);
            if (!isNaN(val) && val >= 1) {
                s.modulePageSizes[tagEl.value.toUpperCase()] = val;
                saveSettings();
                schedulePreview();
            }
        });

        updatePreview();
        overlay.style.display = 'flex';

        const modal = document.getElementById('rt_cfe_modal');
        const previewHeader = (document.getElementById('rt_cfe_preview_header'));

        if (modal && previewEl && previewHeader) {
            const rect = modal.getBoundingClientRect();
            const spaceOnRight = window.innerWidth - rect.right;
            if (spaceOnRight >= 320 && !isSmallScreen) {
                previewEl.style.display = 'flex';
                previewEl.style.left = (rect.right + 20) + 'px';
                previewEl.style.top  = rect.top + 'px';
                // @ts-ignore
                makeDraggable(previewEl, previewHeader);
            }
        }

        const save = () => {
            field.icon  = iconEl.value;
            const newTag = tagEl.value.replace(/[^a-zA-Z0-9_]/g, '').toUpperCase();
            if (!newTag) { toastr['error']('Tag cannot be empty.', 'RPG Tracker'); return; }

            // Save page size
            if (!s.modulePageSizes) s.modulePageSizes = {};
            const ps = parseInt(pageSizeEl.value, 10);
            if (!isNaN(ps) && ps >= 1) {
                s.modulePageSizes[newTag] = ps;
            }
            if (!newTag) { toastr['error']('Tag cannot be empty.', 'RPG Tracker'); return; }
            if (BLOCK_ORDER.includes(newTag)) { toastr['error'](`[${newTag}] is a reserved stock module name.`, 'RPG Tracker'); return; }
            const dup = s.customFields.find((f, i) => i !== index && f.tag.toUpperCase() === newTag);
            if (dup) { toastr['error'](`Tag [${newTag}] is already in use.`, 'RPG Tracker'); return; }

            field.tag      = newTag;
            field.label    = labelEl.value;
            field.template = templateEl.value;
            field.prompt   = promptEl.value;
            delete field.rows;
            delete field.renderType;

            overlay.remove();
            saveSettings();
            refreshOrderList();
            refreshRenderedView();
        };

        const del = () => {
            const tagToDelete = field.tag.toUpperCase();
            if (confirm(`Delete custom module [${tagToDelete}]? This will also remove its data from the current tracker.`)) {
                s.customFields.splice(index, 1);
                if (s.blockOrder) s.blockOrder = s.blockOrder.filter(t => t !== tagToDelete);
                const memoBlocks = parseMemoBlocks(s.currentMemo || '');
                if (memoBlocks[tagToDelete] !== undefined) {
                    delete memoBlocks[tagToDelete];
                    s.currentMemo = Object.entries(memoBlocks).map(([k, v]) => `[${k}]\n${v}\n[/${k}]`).join('\n\n');
                    updateUIMemo(s.currentMemo);
                }
                overlay.remove();
                saveSettings();
                refreshOrderList();
                refreshRenderedView();
            }
        };

        const close = () => overlay.remove();
        document.getElementById('rt_cfe_save').onclick   = save;
        document.getElementById('rt_cfe_delete').onclick = del;
        document.getElementById('rt_cfe_cancel').onclick = close;
        document.getElementById('rt_cfe_close').onclick  = close;
        document.getElementById('rpg-tracker-debug-btn').onclick = () => toggleDebugViewer();
        document.getElementById('rt_cfe_export').onclick = () => exportModules([field]);
    }
    function openPromptEditor(tag, title, currentText, defaultText, onSave) {
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
                        <div id="rt_pe_close" class="popup-close interactable" title="Close"><i class="fa-solid fa-times"></i></div>
                    </div>
                    <div class="popup-body flex-container flexFlowColumn gap-1" style="padding: 10px;">
                        <!-- Layout Options -->
                        <div style="display:flex; align-items:center; gap:10px; margin-bottom:8px; padding:0 4px;">
                            <div style="display:flex; align-items:center; gap:6px;">
                                <span style="font-size:12px; font-weight:bold; opacity:0.8;">Pagination Threshold:</span>
                                <input type="number" id="rt_pe_pagesize" class="text_pole" style="width:50px; height:24px; text-align:center;" min="1" max="99" title="How many items to show before adding page buttons">
                                <span style="font-size:11px; opacity:0.6;">entries</span>
                            </div>
                        </div>
                        <textarea id="rt_pe_text" class="text_pole" rows="10" style="width: 100%; resize: vertical;"></textarea>
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
        const pageSizeEl = /** @type {HTMLInputElement} */ (document.getElementById('rt_pe_pagesize'));
        const saveBtn = document.getElementById('rt_pe_save');
        const resetBtn = document.getElementById('rt_pe_reset');
        const closeBtn = document.getElementById('rt_pe_close');
        const cancelBtn = document.getElementById('rt_pe_cancel');
        
        const s = getSettings();
        pageSizeEl.value = String(s.modulePageSizes?.[tag.toUpperCase()] ?? (tag.toUpperCase() === 'SPELLS' ? 5 : PAGE_SIZE));
        pageSizeEl.addEventListener('input', () => {
            if (!s.modulePageSizes) s.modulePageSizes = {};
            const val = parseInt(String(pageSizeEl.value), 10);
            if (!isNaN(val) && val >= 1) {
                s.modulePageSizes[tag.toUpperCase()] = val;
                saveSettings();
                refreshRenderedView();
            }
        });

        const close = () => { overlay.style.display = 'none'; };

        titleEl.textContent = title;
        textEl.value = currentText;
        overlay.style.display = 'flex';

        const saveHandler = () => {
            if (!s.modulePageSizes) s.modulePageSizes = {};
            const ps = parseInt(String(pageSizeEl.value), 10);
            if (!isNaN(ps) && ps >= 1) {
                s.modulePageSizes[tag.toUpperCase()] = ps;
            }
            saveSettings();
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


    // ── Module Export / Import ──────────────────────────────────────────────────

    /**
     * Builds the shareable JSON envelope for the given custom field objects
     * and opens the share modal.
     * @param {Array<{icon:string, tag:string, label:string, prompt:string}>} fields
     */
    function exportModules(fields) {
        const payload = {
            format: 'fatbody-custom-module',
            version: 1,
            exportedAt: new Date().toISOString(),
            modules: fields.map(f => ({
                icon:   f.icon  || '📄',
                tag:    f.tag,
                label:  f.label || f.tag,
                prompt: f.prompt || '',
            })),
        };
        openShareModal(JSON.stringify(payload, null, 2));
    }

    /**
     * Opens a read-only copy-to-clipboard modal with the export JSON.
     * Uses the Termux-safe execCommand fallback (same as sysprompt copy).
     * @param {string} jsonString
     */
    function openShareModal(jsonString) {
        const { Popup } = SillyTavern.getContext();
        const escaped = jsonString
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
        const content = `
            <div style="display:flex; flex-direction:column; gap:8px; min-width:360px;">
                <p style="margin:0; font-size:12px; opacity:0.7;">
                    Copy this code and share it anywhere. Others can paste it using the <b>Import</b> button.
                </p>
                <textarea id="rt_share_blob" readonly rows="12" class="text_pole"
                    style="font-family:monospace; font-size:11px; resize:vertical; width:100%;"
                >${escaped}</textarea>
                <div style="display:flex; gap:8px;">
                    <button id="rt_share_copy" class="menu_button interactable" style="flex:1;">
                        <i class="fa-solid fa-copy"></i> Copy to Clipboard
                    </button>
                    <button id="rt_share_download" class="menu_button interactable" style="flex:1;">
                        <i class="fa-solid fa-file-download"></i> Export .json
                    </button>
                </div>
            </div>
        `;
        Popup.show.confirm('📤 Share Custom Module', content, {
            okButton: 'Done',
            cancelButton: false,
        });
        // Wire buttons after the popup DOM renders (next tick)
        setTimeout(() => {
            const copyBtn = document.getElementById('rt_share_copy');
            if (copyBtn) {
                copyBtn.addEventListener('click', async () => {
                    try {
                        // Use modern Clipboard API if available and in secure context
                        if (navigator.clipboard && window.isSecureContext) {
                            await navigator.clipboard.writeText(jsonString);
                            toastr['success']('Module code copied to clipboard!', 'Fatbody Framework');
                            return;
                        }

                        // Fallback for non-secure contexts (HTTP) or older browsers
                        const ta = document.createElement('textarea');
                        ta.value = jsonString;
                        ta.style.position = 'fixed';
                        ta.style.left = '-9999px';
                        ta.style.top = '0';
                        ta.style.opacity = '0';
                        document.body.appendChild(ta);
                        ta.focus();
                        ta.select();
                        ta.setSelectionRange(0, 99999); // Important for mobile

                        const success = document.execCommand('copy');
                        document.body.removeChild(ta);

                        if (success) {
                            toastr['success']('Module code copied to clipboard!', 'Fatbody Framework');
                        } else {
                            throw new Error('execCommand returned false');
                        }
                    } catch (err) {
                        console.error('[Fatbody Framework] clipboard copy failed:', err);
                        toastr['error']('Could not copy automatically. Please select the text manually.', 'Fatbody Framework');
                    }
                });
            }

            const downloadBtn = document.getElementById('rt_share_download');
            if (downloadBtn) {
                downloadBtn.addEventListener('click', () => {
                    const blob = new Blob([jsonString], { type: 'application/json' });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = `fatbody_module_${new Date().getTime()}.json`;
                    document.body.appendChild(a);
                    a.click();
                    document.body.removeChild(a);
                    URL.revokeObjectURL(url);
                });
            }
        }, 50);
    }

    /**
     * Validates and imports custom modules from a pasted JSON export string.
     * Collects all tag conflicts first, then resolves them with a single prompt.
     * @param {string} jsonString
     */
    async function importModulesFromJson(jsonString) {
        // Stock module tags — derived from the settings default so they stay in sync
        const STOCK_TAGS = new Set(['COMBAT', 'CHARACTER', 'PARTY', 'INVENTORY', 'ABILITIES', 'SPELLS', 'XP', 'TIME']);

        let parsed;
        try {
            parsed = JSON.parse(jsonString.trim());
        } catch {
            toastr['error']('Invalid JSON. Please paste a valid module export.', 'Fatbody Framework');
            return;
        }

        if (parsed?.format !== 'fatbody-custom-module' || !Array.isArray(parsed?.modules)) {
            toastr['error']("This doesn't look like a Fatbody module export.", 'Fatbody Framework');
            return;
        }

        // Normalize and filter out malformed entries
        const incoming = parsed.modules.filter(m => {
            if (!m.tag || typeof m.tag !== 'string') return false;
            m.tag = m.tag.replace(/[^a-zA-Z0-9_]/g, '').toUpperCase();
            return m.tag.length > 0;
        });

        if (incoming.length === 0) {
            toastr['warning']('No valid modules found in the export.', 'Fatbody Framework');
            return;
        }

        const s = getSettings();
        const existingTags = new Set((s.customFields || []).map(f => f.tag.toUpperCase()));

        // Hard-block stock tag conflicts
        const stockConflicts = incoming.filter(m => STOCK_TAGS.has(m.tag));
        if (stockConflicts.length > 0) {
            toastr['error'](
                `Cannot import: [${stockConflicts.map(m => m.tag).join('], [')}] clash with built-in stock modules.`,
                'Fatbody Framework'
            );
            return;
        }

        // Collect soft (custom) conflicts and resolve with a single popup
        const softConflicts = incoming.filter(m => existingTags.has(m.tag));
        let overwriteConflicts = false;

        if (softConflicts.length > 0) {
            const { Popup } = SillyTavern.getContext();
            const tagList = softConflicts.map(m => `<b>[${m.tag}]</b>`).join(', ');
            const choice = await Popup.show.confirm(
                '⚠️ Import Conflicts',
                `<p>${softConflicts.length} module(s) already exist: ${tagList}</p><p>What would you like to do?</p>`,
                { okButton: 'Overwrite Existing', cancelButton: 'Skip Conflicts' }
            );
            if (choice === null || choice === undefined) return; // user dismissed
            overwriteConflicts = (choice === 1);
        }

        if (!s.blockOrder) s.blockOrder = ['COMBAT', 'CHARACTER', 'PARTY', 'INVENTORY', 'ABILITIES', 'SPELLS', 'XP', 'TIME'];

        let importedCount = 0;
        for (const m of incoming) {
            const isConflict = existingTags.has(m.tag);
            if (isConflict && !overwriteConflicts) continue;

            const newField = {
                icon:     m.icon  || '📄',
                tag:      m.tag,
                label:    m.label || m.tag,
                prompt:   m.prompt || '',
                template: '',   // sandbox always starts blank
                enabled:  true, // imported modules are active immediately
            };

            if (isConflict) {
                const idx = s.customFields.findIndex(f => f.tag.toUpperCase() === m.tag);
                if (idx !== -1) s.customFields[idx] = newField;
            } else {
                s.customFields.push(newField);
                if (!s.blockOrder.includes(m.tag)) s.blockOrder.push(m.tag);
            }
            importedCount++;
        }

        if (importedCount === 0) {
            toastr['info']('No modules were imported (all conflicts were skipped).', 'Fatbody Framework');
            return;
        }

        saveSettings();
        refreshOrderList();
        syncMemoView();
        toastr['success'](`Imported ${importedCount} custom module(s).`, 'Fatbody Framework');
    }

    // ───────────────────────────────────────────────────────────────────────────

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

        // Current order, filtered for validity and optional module toggles
        const validCustomTags = new Set(allCustomTags);
        const order = s.blockOrder.filter(tag => {
            const isStock = BLOCK_ORDER.includes(tag);
            if (!isStock && !validCustomTags.has(tag)) return false;

            // Hide QUESTS if disabled in Narrator Config
            if (tag === 'QUESTS' && s.syspromptModules?.quests === false) return false;

            return true;
        });
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
                saveSettings();
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
                    let mod = tag.toLowerCase();
                    let displayTag = tag;
                    
                    // Redirect QUESTS to quests_legacy if in legacy mode
                    if (tag === 'QUESTS' && s.questLegacyMode) {
                        mod = 'quests_legacy';
                        displayTag = 'QUESTS (Legacy Mode)';
                    }

                    if (!s.stockPrompts) s.stockPrompts = { ...DEFAULT_STOCK_PROMPTS };
                    openPromptEditor(
                        displayTag,
                        `Edit Default [${displayTag}] Prompt`,
                        s.stockPrompts[mod] || DEFAULT_STOCK_PROMPTS[mod],
                        DEFAULT_STOCK_PROMPTS[mod],
                        (newVal) => {
                            s.stockPrompts[mod] = newVal;
                            saveSettings();
                            toastr['success'](`[${displayTag}] prompt updated.`, 'RPG Tracker');
                        }
                    );
                } else {
                    openCustomFieldEditor(customIndex);
                }
            };

            // Reset Button (Stock only)
            let resetBtn = null;
            if (isStock) {
                resetBtn = document.createElement('button');
                resetBtn.className = 'menu_button interactable rt-order-btn';
                resetBtn.style.padding = '2px 6px';
                resetBtn.title = 'Reset Prompt to Default';
                resetBtn.innerHTML = '<i class="fa-solid fa-rotate-left"></i>';
                resetBtn.onclick = () => {
                    let mod = tag.toLowerCase();
                    if (tag === 'QUESTS' && s.questLegacyMode) mod = 'quests_legacy';
                    
                    if (confirm(`Reset [${tag}] prompt to default? This will lose any custom changes.`)) {
                        if (!s.stockPrompts) s.stockPrompts = { ...DEFAULT_STOCK_PROMPTS };
                        s.stockPrompts[mod] = DEFAULT_STOCK_PROMPTS[mod];
                        saveSettings();
                        toastr['success'](`[${tag}] prompt reset.`, 'RPG Tracker');
                    }
                };
            }

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
                saveSettings();
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
                saveSettings();
                refreshOrderList();
                refreshRenderedView();
            };

            item.appendChild(cb);
            item.appendChild(label);
            btnGroup.appendChild(editBtn);
            if (resetBtn) btnGroup.appendChild(resetBtn);
            btnGroup.appendChild(upBtn);
            btnGroup.appendChild(downBtn);
            item.appendChild(btnGroup);
            list.appendChild(item);
        });
    }

    /**
     * Rebuilds the system prompt by stripping out XML blocks that are
     * disabled in settings.syspromptModules.
     * @param {string} rawText
     * @returns {string}
     */
    let _autoApplyTimer = null;
    async function autoApplySysprompt() {
        const s = getSettings();
        if (s.customSysprompt) return;

        const fileName = s.diceFunctionTool ? 'sysprompt.txt' : 'sysprompt_legacy.txt';
        let content;
        try {
            const response = await fetch(`/scripts/extensions/third-party/${FOLDER_NAME}/${fileName}`);
            if (response.ok) {
                content = await response.text();
            } else {
                throw new Error(`Server returned ${response.status}`);
            }
        } catch (err) {
            console.warn(`[Fatbody Framework] autoApplySysprompt: could not fetch ${fileName}, using fallback:`, err);
            content = RT_PROMPTS[fileName];
        }
        if (!content) return;

        content = buildSysprompt(content);
        const mainTextarea = /** @type {HTMLTextAreaElement|null} */ (document.getElementById('main_prompt_quick_edit_textarea'));
        if (mainTextarea) {
            mainTextarea.value = content;
            mainTextarea.dispatchEvent(new Event('blur', { bubbles: true }));
        }
    }

    function scheduleAutoApply() {
        if (_autoApplyTimer) clearTimeout(_autoApplyTimer);
        _autoApplyTimer = setTimeout(() => { _autoApplyTimer = null; autoApplySysprompt(); }, 400);
    }

    function buildSysprompt(rawText) {
        if (!rawText) return "";
        const s = getSettings();
        const mods = s.syspromptModules || {};
        
        // 1. Tag-based module stripping and Quest mode swap
        let content = rawText
            .replace(/<(\w[\w_-]*)>([\s\S]*?)<\/\1>/g, (match, tag) => {
                if (mods[tag] === false) return '';
                // Inject correct instructions for quests based on legacy mode
                if (tag === 'quests') {
                    let instruction = s.questLegacyMode ? QUESTS_NARRATOR_LEGACY : QUESTS_NARRATOR_MODERN;
                    // Strip Mood guidance if Frustration is off
                    if (!mods.questsFrustration) {
                        instruction = instruction.replace(/Use the MOOD field.*?\./g, '');
                    }
                    // Strip Difficulty guidance if Difficulty is off
                    if (!mods.questsDifficulty) {
                        instruction = instruction.replace(/the difficulty \(Very Easy to Very Hard\), /g, '');
                        instruction = instruction.replace(/Assign an appropriate difficulty \(Very Easy to Very Hard\) based on the narrative stakes\. /g, '');
                    }
                    return `<quests>\n${instruction.trim()}\n</quests>`;
                }
                return match;
            });

        // 2. Inject current module instructions
        const modulesText = buildModulesInstructionText(s);
        content = content.replace("{{modulesText}}", modulesText);

        // 3. Handle Quests Hardcore rules stripping (Narrator guidance)
        if (!mods.questsDeadlines) {
            // Strip deadline assignment rule and auto_fail guidance
            content = content.replace(/- Assign an in-world Deadline.*\n/g, '');
            content = content.replace(/- Set auto_fail to true for quests.*\n/g, '');
            content = content.replace(/- If a duration is given.* Day N.*\n/g, '');
        }
        if (!mods.questsFrustration) {
            // Strip frustration coefficient and mood rules
            content = content.replace(/- Set a frustration_coefficient.*\n/g, '');
            content = content.replace(/ {2}· 0\.4 = Very patient.*\n/g, '');
            content = content.replace(/ {2}· 1\.0 = Normal.*\n/g, '');
            content = content.replace(/ {2}· 3\.0 = Volatile.*\n/g, '');
            content = content.replace(/- The NPC Mood evolves continuously.*\n/g, '');
            // Also strip the 'past deadline' override rule — only applies when Frustration is active
            content = content.replace(/- If a quest is time-sensitive and the deadline passes.*\n/g, '');
        }

        return content
            .replace(/\n{3,}/g, "\n\n")
            .trim();
    }

    /**
     * Initialization
     */
    (async function init() {
        // Guard against double-init (e.g. browser serving a cached copy of this script
        // while the fresh copy also loads). Remove any stale panel/settings first.
        document.getElementById('rpg-tracker-panel')?.remove();
        document.querySelectorAll('.rpg-tracker-settings').forEach(el => el.remove());

        const ctx = SillyTavern.getContext();
        const { eventSource, event_types, renderExtensionTemplateAsync } = ctx;

        getSettings();
        migrateCustomFields();
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

            // Bind drawer toggles ONLY for our own content to avoid global conflicts
            $('.rpg-tracker-settings').on('click', '.inline-drawer-toggle', function(e) {
                e.preventDefault();
                e.stopPropagation();
                const drawer = $(this).closest('.inline-drawer');
                const content = drawer.find('> .inline-drawer-content');
                drawer.toggleClass('open');
                content.stop(true, true).slideToggle(200);
                $(this).find('.inline-drawer-icon').toggleClass('down');
            });

            const settings = getSettings();

            // --- Automatic Stock Prompt Synchronization ---
            // Always ensure stockPrompts exists — users without saved settings need defaults
            if (!settings.stockPrompts) settings.stockPrompts = { ...DEFAULT_STOCK_PROMPTS };
            {
                let changed = false;

                // Modern Quests: update if it has the old format (missing "progress" field)
                if (settings.stockPrompts.quests &&
                    settings.stockPrompts.quests.includes('"id", "status"') &&
                    !settings.stockPrompts.quests.includes('"progress"')) {
                    settings.stockPrompts.quests = DEFAULT_STOCK_PROMPTS.quests;
                    console.log('[RPG Tracker] Synchronized modern quest prompt (added progress tracking).');
                    changed = true;
                }

                // Legacy Quests: update if it's missing OBJ_TOTAL
                if (settings.stockPrompts.quests_legacy &&
                    settings.stockPrompts.quests_legacy.includes('OBJ_ACTIVE') &&
                    !settings.stockPrompts.quests_legacy.includes('OBJ_TOTAL')) {
                    settings.stockPrompts.quests_legacy = DEFAULT_STOCK_PROMPTS.quests_legacy;
                    console.log('[RPG Tracker] Synchronized legacy quest prompt (added progress tracking).');
                    changed = true;
                }

                // Ensure quests_legacy slot always exists as a reference
                if (!settings.stockPrompts.quests_legacy) {
                    settings.stockPrompts.quests_legacy = DEFAULT_STOCK_PROMPTS.quests_legacy;
                    changed = true;
                }

                // ── Definitive quest prompt selection at init ────────────────────
                // Write the correct prompt into stockPrompts.quests based on questLegacyMode.
                // This is the authoritative source — the runtime swap in buildModulesInstructionText
                // is a belt-and-suspenders backup, but this guarantees correctness at startup.
                if (settings.questLegacyMode) {
                    const isDeadlines = !!settings.syspromptModules?.questsDeadlines;
                    const isFrustration = !!settings.syspromptModules?.questsFrustration;
                    let legacyPrompt = settings.stockPrompts.quests_legacy || DEFAULT_STOCK_PROMPTS.quests_legacy;
                    if (!isDeadlines) legacyPrompt = legacyPrompt.replace(/\n\s*DEADLINE:.*?\n/g, '\n');
                    if (!isFrustration) legacyPrompt = legacyPrompt.replace(/\n\s*FRUSTRATION_COEFF:.*?\n/g, '\n');
                    if (!settings.stockPrompts.quests || !settings.stockPrompts.quests.includes('OBJ_ACTIVE')) {
                        settings.stockPrompts.quests = legacyPrompt;
                        console.log('[RPG Tracker] Init: wrote LEGACY prompt into quests slot (questLegacyMode=true).');
                        changed = true;
                    }
                } else {
                    // Ensure modern/JSON prompt is in the quests slot
                    if (!settings.stockPrompts.quests || (settings.stockPrompts.quests.includes('OBJ_ACTIVE') &&
                        !settings.stockPrompts.quests.includes('updates'))) {
                        settings.stockPrompts.quests = DEFAULT_STOCK_PROMPTS.quests;
                        console.log('[RPG Tracker] Init: wrote MODERN prompt into quests slot (questLegacyMode=false).');
                        changed = true;
                    }
                }

                if (changed) {
                    saveSettings();
                }

                // Diagnostic: confirm the final quest mode state at init
                console.log(`[RPG Tracker] Quest mode at init: questLegacyMode=${settings.questLegacyMode}, quests slot=${settings.stockPrompts.quests?.includes?.('updates') ? 'MODERN/JSON' : settings.stockPrompts.quests?.includes?.('OBJ_ACTIVE') ? 'LEGACY' : 'UNKNOWN'}`);

                // Retroactive Log Cleanup: replace generic messages with more descriptive ones
                if (settings.routerLog && settings.routerLog.length > 0) {
                    let cleaned = false;
                    settings.routerLog.forEach(entry => {
                        if (entry.reason === "Tag-based update.") {
                            entry.reason = "Processed narrative entities (Legacy Log).";
                            cleaned = true;
                        }
                    });
                    if (cleaned) saveSettings();
                }
            }

            $('#rpg_tracker_enabled').prop('checked', settings.enabled).on('change', function () {
                settings.enabled = !!$(this).prop('checked');
                saveSettings();
                updatePanelStatus();
            });

            $('#rpg_tracker_debug').prop('checked', settings.debugMode).on('change', function () {
                settings.debugMode = !!$(this).prop('checked');
                saveSettings();
            });

            // RNG Help Popup Trigger (Settings)
            $('.rt-rng-help-icon').on('click', (e) => {
                e.stopPropagation();
                showRngExplanation();
            });

            $('#rpg_tracker_legacy_dice').prop('checked', settings.legacyDiceNaming).on('change', function () {
                settings.legacyDiceNaming = !!$(this).prop('checked');
                saveSettings();
                registerDiceFunctionTool();
                registerDiceSlashCommand();
                toastr['info']("Dice logic updated.", "RPG Tracker");
            });

            $('#rpg_tracker_dice_function_tool').prop('checked', settings.diceFunctionTool).on('change', function () {
                settings.diceFunctionTool = !!$(this).prop('checked');
                saveSettings();
                registerDiceFunctionTool();
            });

            $('#rpg_tracker_chat_link_enabled').on('change', function () {
                const s = getSettings();
                const turningOn = !!$(this).prop('checked');
                
                // If we're turning it on from the settings menu, just simulate the button click logic
                // but keep it simple here. The panel button is the primary toggle.
                s.chatLinkEnabled = turningOn;
                saveSettings();
                updateChatLinkUI();
                
                if (turningOn && _currentChatId) {
                    const saved = s.chatStates?.[_currentChatId];
                    if (saved && saved.currentMemo && s.currentMemo && s.currentMemo !== saved.currentMemo) {
                        // In settings we'll just do the safe silent restore if they checked the box
                        // because async confirms in jQuery 'change' events can be janky.
                        // The panel button handles the explicit decision better.
                        loadChatState(_currentChatId);
                    } else {
                        const found = loadChatState(_currentChatId);
                        if (!found) saveChatState(_currentChatId);
                    }
                }
            });

            $('#rpg_tracker_clear_chat_states').on('click', function () {
                const s = getSettings();
                const count = Object.keys(s.chatStates || {}).length;
                if (count === 0) return toastr['info']('No saved chat states to clear.', 'RPG Tracker');
                if (confirm(`Clear ALL ${count} saved chat state(s)?\n\nThis removes the auto-saved tracker data for every chat. Your current live state is unaffected.\n\nProceed?`)) {
                    s.chatStates = {};
                    saveSettings();
                    toastr['success'](`Cleared ${count} chat state(s).`, 'RPG Tracker');
                }
            });

            // ─── Event Hooks ───
            eventSource.on(event_types.GENERATION_ENDED, onGenerationEnded);
            eventSource.on(event_types.GENERATION_STOPPED, onGenerationEnded);

            // ─── Chat Link ───
            eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
            // Bootstrap: restore state for whichever chat is already open
            const bootChatId = ctx.getCurrentChatId?.() || null;
            _currentChatId = bootChatId;
            if (bootChatId && settings.chatLinkEnabled) {
                loadChatState(bootChatId);
            }

            // ─── Dice System ───
            installInterceptor();
            installRouterInterceptor();

            // Ensure managed lorebook entries have disable:true so ST's native keyword
            // scanner never injects them. Fire-and-forget — non-blocking on startup.
            const s = getSettings();
            if (s.routerEnabled) disableManagedEntries().catch(e => console.warn('[RPG Tracker] disableManagedEntries on init failed:', e));

            registerDiceFunctionTool();
            registerDiceSlashCommand();

            // ─── Quest System ───
            import('./quests.js').then(({ registerLogQuestTool, installQuestDebugTools, computeFrustration }) => {
                registerLogQuestTool();
                installQuestDebugTools();
                // Expose for renderQuestLog (renderer can't import dynamically)
                // getQuestMood is from memo-processor.js (no circular dep)
                globalThis.__rpgQuestUtils = { computeFrustration, getQuestMood };
            }).catch(e => console.error('[RPG Tracker] quests.js failed to load:', e));

            initializeDebugViewer();

            // Connection Settings
            const sourceSelect = $('#rpg_tracker_connection_source');
            const profileGroup = $('#rpg_tracker_profile_group');
            const profileSelect = $('#rpg_tracker_connection_profile');
            const ollamaGroup = $('#rpg_tracker_ollama_group');
            const openaiGroup = $('#rpg_tracker_openai_group');
            const maxTokensInput = $('#rpg_tracker_max_tokens');

            function updateConnectionPanels() {
                const source = sourceSelect.val();
                profileGroup.toggle(source === 'profile');
                ollamaGroup.toggle(source === 'ollama');
                openaiGroup.toggle(source === 'openai');
            }

            sourceSelect.val(settings.connectionSource).on('change', function () {
                settings.connectionSource = $(this).val();
                updateConnectionPanels();
                saveSettings();
            });
            updateConnectionPanels();

            // Ollama
            $('#rpg_tracker_ollama_url').val(settings.ollamaUrl).on('input', function () {
                settings.ollamaUrl = $(this).val();
                saveSettings();
            });
            const ollamaModelSelect = $('#rpg_tracker_ollama_model');
            ollamaModelSelect.val(settings.ollamaModel).on('change', function () {
                settings.ollamaModel = $(this).val();
                saveSettings();
            });

            async function refreshOllamaModelsList() {
                const url = $('#rpg_tracker_ollama_url').val();
                if (!url) return toastr['info']("Please enter an Ollama URL first.");
                try {
                    toastr['info']("Fetching Ollama models...");
                    const models = await fetchOllamaModels(url);
                    ollamaModelSelect.empty().append('<option value="">-- Select Model --</option>');
                    models.forEach(m => {
                        ollamaModelSelect.append($('<option></option>').val(m.name).text(m.name));
                    });
                    ollamaModelSelect.val(settings.ollamaModel);
                    toastr['success']("Ollama models updated.");
                } catch (e) {
                    console.error("[RPG Tracker] Ollama fetch failed:", e);
                    toastr['error']("Failed to fetch Ollama models. Check console.");
                }
            }
            $('#rpg_tracker_ollama_refresh').on('click', refreshOllamaModelsList);

            // OpenAI
            $('#rpg_tracker_openai_url').val(settings.openaiUrl).on('input', function () {
                settings.openaiUrl = $(this).val();
                saveSettings();
            });
            $('#rpg_tracker_openai_key').val(settings.openaiKey).on('input', function () {
                settings.openaiKey = $(this).val();
                saveSettings();
            });

            const openaiModelSelect = $('#rpg_tracker_openai_model');
            const openaiModelManual = $('#rpg_tracker_openai_model_manual');

            // The effective model is: manual input (if filled) > dropdown selection
            function getOpenAIModel() {
                const manual = String(openaiModelManual.val() || '').trim();
                return manual || String(openaiModelSelect.val() || '') || '';
            }

            // Initialize: if saved model isn't in dropdown yet, show it in the manual field
            openaiModelManual.val(settings.openaiModel || '');
            openaiModelSelect.on('change', function () {
                const val = $(this).val();
                if (val) {
                    // Dropdown selected — clear manual, save selection
                    openaiModelManual.val('');
                    settings.openaiModel = val;
                } else {
                    settings.openaiModel = String(openaiModelManual.val() || '').trim() || '';
                }
                saveSettings();
            });
            openaiModelManual.on('input', function () {
                const manual = String($(this).val() || '').trim();
                if (manual) {
                    // Manual overrides dropdown — deselect it visually
                    openaiModelSelect.val('');
                }
                settings.openaiModel = manual || openaiModelSelect.val() || '';
                saveSettings();
            });

            async function refreshOpenAIModelsList() {
                const url = $('#rpg_tracker_openai_url').val();
                const key = $('#rpg_tracker_openai_key').val();
                if (!url) return toastr['info']("Please enter an Endpoint URL first.");
                try {
                    toastr['info']("Fetching models from endpoint...");
                    const models = await fetchOpenAIModels(url, key);
                    openaiModelSelect.empty().append('<option value="">-- Select Model --</option>');
                    models.forEach(m => {
                        const id = typeof m === 'string' ? m : (m.id || m.name);
                        if (id) openaiModelSelect.append($('<option></option>').val(id).text(id));
                    });
                    // Restore saved selection
                    const saved = settings.openaiModel;
                    if (saved && openaiModelSelect.find(`option[value="${saved}"]`).length) {
                        openaiModelSelect.val(saved);
                        openaiModelManual.val('');
                    }
                    toastr['success'](`${models.length} model(s) found.`);
                } catch (e) {
                    console.error("[RPG Tracker] OpenAI fetch failed:", e);
                    // Show a short toast; full details logged to console
                    toastr['warning'](
                        "Cannot auto-detect models (CORS). Type the model name manually below, or enable enableCorsProxy: true in ST's config.yaml.",
                        "Model Sniffing Unavailable",
                        { timeOut: 8000 }
                    );
                }
            }
            $('#rpg_tracker_openai_refresh').on('click', refreshOpenAIModelsList);

            $('#rpg_tracker_openai_test').on('click', async function () {
                const url = $('#rpg_tracker_openai_url').val();
                const key = $('#rpg_tracker_openai_key').val();
                const model = getOpenAIModel();
                if (!url) return toastr['info']("Enter the Endpoint URL first.");
                if (!model) return toastr['info']("Enter or select a model name first.");
                toastr['info']("Testing OpenAI connection...");
                const result = await testOpenAIConnection(url, key, model);
                if (result.success) {
                    toastr['success'](result.message);
                    await refreshOpenAIModelsList();
                } else {
                    toastr['error'](result.message);
                }
            });

            maxTokensInput.val(settings.maxTokens || "").on('input', function () {
                settings.maxTokens = parseInt(/** @type {string} */($(this).val())) || 0;
                saveSettings();
            });

            // Advanced Options
            const lookbackInput = $('#rpg_tracker_lookback_messages');
            if (lookbackInput.length) {
                lookbackInput.val(settings.lookbackMessages !== undefined ? settings.lookbackMessages : 2).on('input', function () {
                    settings.lookbackMessages = parseInt(/** @type {string} */($(this).val())) || 2;
                    saveSettings();
                });
            }
            const historyCountInput = $('#rpg_tracker_history_count');
            if (historyCountInput.length) {
                historyCountInput.val(settings.trackerHistoryCount !== undefined ? settings.trackerHistoryCount : 1).on('input', function () {
                    settings.trackerHistoryCount = parseInt(/** @type {string} */($(this).val())) || 1;
                    saveSettings();
                });
            }

            // ── Lorebook Context UI ──
            async function refreshLorebookList() {
                const $container = $('#rpg_tracker_lorebook_list');
                $container.empty();
                const stCtx = SillyTavern.getContext();
                let worldNames = [];
                try {
                    worldNames = stCtx.getWorldInfoNames?.() ?? [];

                    // If empty, the in-memory world_names may not be populated yet.
                    // Force a backend refresh and retry.
                    if (!worldNames.length && stCtx.updateWorldInfoList) {
                        if (settings.debugMode) console.log('[RPG Tracker] world_names empty — forcing backend refresh…');
                        await stCtx.updateWorldInfoList();
                        worldNames = stCtx.getWorldInfoNames?.() ?? [];
                    }

                    // Final fallback: direct backend fetch (covers edge cases and older ST versions)
                    if (!worldNames.length) {
                        if (settings.debugMode) console.log('[RPG Tracker] world_names still empty — falling back to direct API fetch…');
                        try {
                            const resp = await fetch('/api/settings/get', {
                                method: 'POST',
                                headers: stCtx.getRequestHeaders(),
                                body: JSON.stringify({}),
                            });
                            if (resp.ok) {
                                const data = await resp.json();
                                worldNames = data.world_names ?? [];
                            }
                        } catch (fetchErr) {
                            console.warn('[RPG Tracker] Direct world_names fetch failed:', fetchErr);
                        }
                    }
                } catch (e) {
                    console.warn('[RPG Tracker] getWorldInfoNames() failed:', e);
                }

                if (!worldNames || worldNames.length === 0) {
                    $container.append('<i style="opacity:0.6;">No lorebooks found.</i>');
                    return;
                }

                const currentFilter = settings.lorebookFilter || [];
                const sortedBooks = [...worldNames].sort();

                sortedBooks.forEach(bookName => {
                    const isChecked = currentFilter.includes(bookName);
                    const $item = $(`<label class="checkbox_label" style="font-size: 0.9em;">
                        <input type="checkbox" data-book="${bookName}" ${isChecked ? 'checked' : ''} />
                        <span>${bookName}</span>
                    </label>`);

                    $item.find('input').on('change', function () {
                        const book = $(this).data('book');
                        if (!Array.isArray(settings.lorebookFilter)) settings.lorebookFilter = [];
                        if ($(this).prop('checked')) {
                            if (!settings.lorebookFilter.includes(book)) {
                                settings.lorebookFilter.push(book);
                            }
                        } else {
                            settings.lorebookFilter = settings.lorebookFilter.filter(b => b !== book);
                        }
                        saveSettings();
                    });
                    $container.append($item);
                });
            }

            $('#rpg_tracker_ctx_worldinfo').prop('checked', settings.ctxWorldInfo ?? false).on('change', async function () {
                settings.ctxWorldInfo = !!$(this).prop('checked');
                if (settings.ctxWorldInfo) await refreshLorebookList();
                $('#rpg_tracker_lorebook_filter_group').toggle(settings.ctxWorldInfo);
                saveSettings();
            }).trigger('change');

            $('#rpg_tracker_lorebook_list_refresh').on('click', async function () {
                await refreshLorebookList();
            });

            // Theme Select + Wizard
            const themeSelect = $('#rpg_tracker_theme_select');
            themeSelect.val(settings.trackerTheme || 'rt-theme-native');

            const wizardBlock = document.getElementById('rpg_tracker_theme_wizard_block');
            const showHideWizard = (theme) => {
                if (wizardBlock) wizardBlock.style.display = theme === 'rt-theme-custom' ? 'block' : 'none';
            };
            showHideWizard(settings.trackerTheme || 'rt-theme-native');

            // Theme Wizard buttons
            document.getElementById('rpg_tracker_theme_generate')?.addEventListener('click', () => {
                openThemeWizard(false);
            });
            document.getElementById('rpg_tracker_theme_iterate')?.addEventListener('click', () => {
                if (!settings.customTheme) {
                    toastr['info']('No custom theme to iterate on. Generating a new one instead.', 'Theme Wizard');
                    openThemeWizard(false);
                } else {
                    openThemeWizard(true);
                }
            });

            // Restore saved custom theme on settings load
            if (settings.customTheme) applyCustomTheme(settings.customTheme);

            themeSelect.on('change', function () {
                const newTheme = String($(this).val());
                settings.trackerTheme = newTheme;
                saveSettings();
                showHideWizard(newTheme);
                const panel = document.getElementById('rpg-tracker-panel');
                if (panel) {
                    panel.className = `rpg-tracker-panel ${newTheme}`;
                    if (!settings.enabled) panel.classList.add('is-disabled');
                }
                document.querySelectorAll('.rpg-tracker-detached-panel, .rpg-tracker-agent-panel').forEach(dp => {
                    dp.className = dp.classList.contains('rpg-tracker-agent-panel') 
                        ? `rpg-tracker-panel rpg-tracker-agent-panel ${newTheme}`
                        : `rpg-tracker-panel rpg-tracker-detached-panel ${newTheme}`;
                });
            });

            document.getElementById('rpg_tracker_theme_save')?.addEventListener('click', () => {
                if (!settings.customTheme) {
                    toastr['warning']('No custom theme to save. Generate one first!', 'Theme Wizard');
                    return;
                }
                const name = prompt('Enter a name for this theme:', 'My Custom Theme');
                if (name && name.trim()) {
                    const trimmedName = name.trim();
                    if (settings.savedThemes && settings.savedThemes[trimmedName]) {
                        if (!confirm(`A theme named "${trimmedName}" already exists. Overwrite?`)) return;
                    }
                    if (!settings.savedThemes) settings.savedThemes = {};
                    settings.savedThemes[trimmedName] = JSON.parse(JSON.stringify(settings.customTheme));
                    saveSettings();
                    refreshSavedThemesList();
                    toastr['success'](`Saved "${name}" to library.`, 'Theme Library');
                }
            });
            document.getElementById('rpg_tracker_theme_wizard_undo')?.addEventListener('click', () => {
                if (themeUndoStack.length === 0) {
                    toastr['info']('No steps to undo.', 'Theme Wizard');
                    return;
                }
                const prev = themeUndoStack.pop();
                settings.customTheme = prev;
                saveSettings();
                applyCustomTheme(prev);
                const statusEl = document.getElementById('rpg_tracker_theme_wizard_status');
                if (statusEl) { 
                    statusEl.style.display = 'block'; 
                    statusEl.style.color = 'inherit'; 
                    statusEl.textContent = `Undone last change. (${themeUndoStack.length} steps remaining)`; 
                }
            });

            refreshSavedThemesList();

            const fontSizeInput = $('#rpg_tracker_font_size');
            const fontSizeVal = $('#rpg_tracker_font_size_val');
            fontSizeInput.val(settings.fontSize || 13);
            if (fontSizeVal.length) fontSizeVal.text((settings.fontSize || 13) + 'px');

            fontSizeInput.on('input', function() {
                const val = parseInt(String($(this).val()));
                if (isNaN(val) || val < 8 || val > 32) return;
                if (fontSizeVal.length) fontSizeVal.text(val + 'px');
                settings.fontSize = val;
                saveSettings();
                updateTrackerFontSize(val);
            });

            const agentFontSizeInput = $('#rpg_agent_font_size');
            const agentFontSizeVal = $('#rpg_agent_font_size_val');
            agentFontSizeInput.val(settings.agentFontSize || 13);
            if (agentFontSizeVal.length) agentFontSizeVal.text((settings.agentFontSize || 13) + 'px');

            agentFontSizeInput.on('input', function() {
                const val = parseInt(String($(this).val()));
                if (isNaN(val) || val < 8 || val > 32) return;
                if (agentFontSizeVal.length) agentFontSizeVal.text(val + 'px');
                settings.agentFontSize = val;
                saveSettings();
                updateAgentFontSize(val);
            });

            // Populate profiles using handleDropdown (fills real internal IDs, not names)
            if (ctx.ConnectionManagerRequestService?.handleDropdown) {
                /** @type {any} */ (ctx.ConnectionManagerRequestService).handleDropdown(profileSelect[0]);
                profileSelect.val(settings.connectionProfileId);
            } else {
                // Fallback for older ST: /profile-list returns names only
                const profiles = await getConnectionProfiles();
                profileSelect.empty().append('<option value="">-- No Profile Selected --</option>');
                profiles.forEach(p => {
                    profileSelect.append($('<option></option>').val(p).text(p));
                });
                profileSelect.val(settings.connectionProfileId);
            }
            profileSelect.on('change', function () {
                settings.connectionProfileId = $(this).val();
                saveSettings();
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
                saveSettings();
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
                    prompt: '',
                    template: EXAMPLES + '\n\n' + COLOR_EXAMPLES,
                    enabled: true
                });
                refreshOrderList();
                saveSettings();
            });

            $('#rpg_tracker_export_all_modules').on('click', () => {
                const s = getSettings();
                if (!s.customFields || s.customFields.length === 0) {
                    toastr['info']('No custom modules to export.', 'Fatbody Framework');
                    return;
                }
                exportModules(s.customFields);
            });

            $('#rpg_tracker_import_modules').on('click', async () => {
                const { Popup } = SillyTavern.getContext();
                let pastedValue = '';

                // Attach the file input directly to body so the OS file picker
                // doesn't steal focus away from the popup and trigger its "outside click" dismiss.
                const fileInput = /** @type {HTMLInputElement} */ (document.createElement('input'));
                fileInput.type = 'file';
                fileInput.accept = '.json';
                fileInput.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0;pointer-events:none;';
                document.body.appendChild(fileInput);

                const content = `
                    <div style="display:flex; flex-direction:column; gap:8px; min-width:min(500px, 90vw);">
                        <p style="margin:0; font-size:12px; opacity:0.7;">
                            Paste the module export code (JSON) below or load it from a file.
                        </p>
                        <textarea id="rt_import_blob" rows="12" class="text_pole"
                            style="font-family:monospace; font-size:11px; resize:vertical; width:100%;"
                            placeholder='{"format": "fatbody-custom-module", ...}'
                        ></textarea>
                        <button id="rt_import_file_btn" class="menu_button interactable" style="width:100%;">
                            <i class="fa-solid fa-file-upload"></i> Load from File
                        </button>
                    </div>
                `;

                setTimeout(() => {
                    const fileBtn = document.getElementById('rt_import_file_btn');
                    const textarea = /** @type {HTMLTextAreaElement} */ (document.getElementById('rt_import_blob'));

                    if (textarea) {
                        textarea.addEventListener('input', () => {
                            pastedValue = textarea.value;
                        });
                    }

                    if (fileBtn) {
                        fileBtn.addEventListener('click', (e) => {
                            e.stopPropagation();
                            fileInput.click();
                        });
                    }

                    fileInput.addEventListener('change', () => {
                        const file = fileInput.files?.[0];
                        if (!file) return;
                        const reader = new FileReader();
                        reader.onload = (ev) => {
                            const text = String(ev.target?.result || '');
                            pastedValue = text;
                            if (textarea) textarea.value = text;
                        };
                        reader.readAsText(file);
                        fileInput.value = ''; // allow re-selecting same file
                    });
                }, 100);

                const result = await Popup.show.confirm('📥 Import Custom Module(s)', content, { okButton: 'Import', cancelButton: 'Cancel' });
                document.body.removeChild(fileInput);

                if (result && pastedValue.trim()) {
                    await importModulesFromJson(pastedValue);
                }
            });

            $('#rpg_tracker_delete_all_custom_modules').on('click', function () {
                const s = getSettings();
                if (!s.customFields || s.customFields.length === 0) return toastr['info']('No custom modules to delete.', 'RPG Tracker');

                if (confirm(`Delete ALL (${s.customFields.length}) custom modules?\n\nThis will also remove their data from the current tracker state. Stock modules (COMBAT, CHARACTER, etc.) will not be touched.\n\nProceed?`)) {
                    const customTags = new Set(s.customFields.map(f => f.tag.toUpperCase()));

                    // Clear fields
                    s.customFields = [];

                    // Clean block order
                    if (s.blockOrder) {
                        s.blockOrder = s.blockOrder.filter(tag => !customTags.has(tag.toUpperCase()));
                    }

                    // Clean current memo
                    const memoBlocks = parseMemoBlocks(s.currentMemo || '');
                    let changed = false;
                    for (const tag of customTags) {
                        if (memoBlocks[tag] !== undefined) {
                            delete memoBlocks[tag];
                            changed = true;
                        }
                    }

                    if (changed) {
                        s.currentMemo = Object.entries(memoBlocks)
                            .map(([k, v]) => `[${k}]\n${v}\n[/${k}]`)
                            .join('\n\n');
                        updateUIMemo(s.currentMemo);
                    }

                    saveSettings();
                    refreshOrderList();
                    syncMemoView();
                    toastr['success']('All custom modules deleted.', 'RPG Tracker');
                }
            });

            $('#rpg_tracker_core_prompt').val(settings.systemPromptTemplate).on('input', function () {
                settings.systemPromptTemplate = $(this).val();
                saveSettings();
            });

            $('#rpg_tracker_btn_reset_prompt').on('click', function () {
                if (!confirm('Reset the State Model prompt to the built-in default?')) return;
                // Re-read the default from the defaults object by temporarily clearing the stored value
                const { extensionSettings } = SillyTavern.getContext();
                delete extensionSettings[MODULE_NAME].systemPromptTemplate;
                const freshSettings = getSettings(); // re-merges defaults
                $('#rpg_tracker_core_prompt').val(freshSettings.systemPromptTemplate);
                saveSettings();
                toastr['success']('Core prompt reset to default.', 'RPG Tracker');
            });

            $('#rpg_tracker_btn_reset_all_prompts').on('click', function () {
                if (!confirm('This will reset the Module Prompts, Active Modules, and Module Order to their factory defaults. Custom modules will be moved to the bottom of the list. Your Core Prompt will not be affected. Proceed?')) return;
                const { extensionSettings } = SillyTavern.getContext();
                delete extensionSettings[MODULE_NAME].stockPrompts;
                delete extensionSettings[MODULE_NAME].blockOrder;
                delete extensionSettings[MODULE_NAME].modules;
                refreshOrderList();
                saveSettings();
                toastr['success']('Stock modules, order, and prompts reset to factory defaults.', 'RPG Tracker');
            });

            $('#rpg_tracker_btn_update_sysprompt').on('click', async function () {
                const fileName = getSettings().diceFunctionTool ? 'sysprompt.txt' : 'sysprompt_legacy.txt';
                let content;
                try {
                    const response = await fetch(`/scripts/extensions/third-party/${FOLDER_NAME}/${fileName}`);
                    if (response.ok) {
                        content = await response.text();
                    } else {
                        throw new Error(`Server returned ${response.status}`);
                    }
                } catch (err) {
                    console.warn(`[Fatbody Framework] Could not fetch ${fileName}, using hardcoded fallback:`, err);
                    content = RT_PROMPTS[fileName];
                }

                if (!content) {
                    toastr['error']('Could not load sysprompt.txt. Main prompt was NOT updated.', 'RPG Tracker');
                    return;
                }

                content = buildSysprompt(content);

                const mainTextarea = /** @type {HTMLTextAreaElement} */ (document.getElementById('main_prompt_quick_edit_textarea'));
                if (mainTextarea) {
                    mainTextarea.value = content;
                    mainTextarea.dispatchEvent(new Event('blur', { bubbles: true }));
                    toastr['success']('Main sysprompt updated! \u2705', 'RPG Tracker');
                } else {
                    await navigator.clipboard.writeText(content).catch(() => {});
                    toastr['info']('Quick-edit textarea not found. Sysprompt copied to clipboard — paste it manually into your Main prompt.', 'RPG Tracker');
                }
            });

            $('#rpg_tracker_btn_reset_and_apply_sysprompt').on('click', async function () {
                if (!confirm('This will:\n\n1. Reset the Core State Model prompt to built-in default\n2. Reset all Stock Module prompts, Active Modules, and Module Order to factory defaults\n3. Fetch the latest sysprompt.txt and write it directly into your Quick Prompt "Main" box\n\nYour custom modules will NOT be affected. Proceed?')) return;

                const { extensionSettings } = SillyTavern.getContext();

                // 1. Reset Core prompt
                delete extensionSettings[MODULE_NAME].systemPromptTemplate;
                const freshSettings = getSettings();
                $('#rpg_tracker_core_prompt').val(freshSettings.systemPromptTemplate);

                // 2. Reset stock modules, order, active modules
                delete extensionSettings[MODULE_NAME].stockPrompts;
                delete extensionSettings[MODULE_NAME].blockOrder;
                delete extensionSettings[MODULE_NAME].modules;
                
                // Re-merge defaults
                const finalSettings = getSettings();
                
                // If legacy mode is on, the prompt is applied at runtime by buildModulesInstructionText
                // (no explicit call needed)
                
                refreshOrderList();
                saveSettings();

                // 3. Fetch sysprompt and apply to ST Quick Prompt "Main"
                const fileName = getSettings().diceFunctionTool ? 'sysprompt.txt' : 'sysprompt_legacy.txt';
                let content;
                try {
                    const response = await fetch(`/scripts/extensions/third-party/${FOLDER_NAME}/${fileName}`);
                    if (response.ok) {
                        content = await response.text();
                        console.log(`[Fatbody Framework] Loaded ${fileName} from live file for auto-apply.`);
                    } else {
                        throw new Error(`Server returned ${response.status}`);
                    }
                } catch (err) {
                    console.warn(`[Fatbody Framework] Could not fetch ${fileName}, using hardcoded fallback:`, err);
                    content = RT_PROMPTS[fileName];
                }

                if (!content) {
                    toastr['error']('Could not load sysprompt.txt. Reset completed but Main prompt was NOT updated.', 'RPG Tracker');
                    return;
                }

                content = buildSysprompt(content);

                const mainTextarea = /** @type {HTMLTextAreaElement} */ (document.getElementById('main_prompt_quick_edit_textarea'));
                if (mainTextarea) {
                    mainTextarea.value = content;
                    // Fire blur to trigger ST's handleQuickEditSave listener
                    mainTextarea.dispatchEvent(new Event('blur', { bubbles: true }));
                    toastr['success']('All prompts reset & Main sysprompt applied! \u2705', 'RPG Tracker');
                } else {
                    // Fallback: ST might not be in OpenAI mode, so the quick-edit textarea may not exist.
                    // Copy to clipboard as a graceful fallback.
                    const ta = document.createElement('textarea');
                    ta.value = content;
                    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;';
                    document.body.appendChild(ta);
                    ta.focus();
                    ta.select();
                    try {
                        document.execCommand('copy');
                        toastr['warning']('All prompts reset. Quick Prompt "Main" textarea not found. Sysprompt copied to clipboard — paste it manually and enable function calls in the completion preset!', 'RPG Tracker');
                    } catch (e) {
                        toastr['warning']('All prompts reset. Quick Prompt "Main" textarea not found and clipboard copy failed. Use the SYSPROMPT button to copy manually.', 'RPG Tracker');
                    } finally {
                        document.body.removeChild(ta);
                    }
                }
            });

            // ── Sysprompt Section Toggles ──
            const _syspromptModDefs = [
                { key: 'loot',          id: 'rpg_sysprompt_mod_loot' },
                { key: 'random_events', id: 'rpg_sysprompt_mod_random_events' },
                { key: 'resting',       id: 'rpg_sysprompt_mod_resting' },
                { key: 'quests',        id: 'rpg_sysprompt_mod_quests' },
            ];
            _syspromptModDefs.forEach(({ key, id }) => {
                const s = getSettings();
                const val = s.syspromptModules?.[key] ?? true;
                $(`#${id}`).prop('checked', val).on('change', function () {
                    const fresh = getSettings();
                    if (!fresh.syspromptModules) fresh.syspromptModules = {};
                    fresh.syspromptModules[key] = !!$(this).prop('checked');

                    if (key === 'quests') {
                        $('#rpg_quests_options').toggle(!!$(this).prop('checked'));
                        registerLogQuestTool();
                        refreshOrderList();
                    }

                    saveSettings();
                    scheduleAutoApply();
                });

                if (key === 'quests') {
                    $('#rpg_quests_options').toggle(val);
                }
            });

            // Deadlines Toggle
            const deadlinesCb = /** @type {HTMLInputElement} */ (document.getElementById('rpg_quests_deadlines'));
            const frustrationWrap = document.getElementById('rpg_quests_frustration_wrap');
            const syncFrustrationVisibility = () => {
                if (frustrationWrap) frustrationWrap.style.display = deadlinesCb?.checked ? '' : 'none';
            };
            if (deadlinesCb) {
                deadlinesCb.checked = !!getSettings().syspromptModules?.questsDeadlines;
                syncFrustrationVisibility();
                deadlinesCb.addEventListener('change', function () {
                    const fresh = getSettings();
                    if (!fresh.syspromptModules) fresh.syspromptModules = {};
                    fresh.syspromptModules.questsDeadlines = !!this.checked;
                    // If deadlines disabled, also uncheck frustration
                    if (!this.checked) {
                        fresh.syspromptModules.questsFrustration = false;
                        const fCb = /** @type {HTMLInputElement|null} */ (document.getElementById('rpg_quests_frustration'));
                        if (fCb) fCb.checked = false;
                    }
                    syncFrustrationVisibility();
                    if (fresh.questLegacyMode) {
                        refreshQuestLegacyPrompt(fresh);
                        refreshOrderList();
                    } else {
                        registerLogQuestTool();
                    }
                    saveSettings();
                    scheduleAutoApply();
                });
            }

            // Frustration Toggle
            const frustrationCb = /** @type {HTMLInputElement} */ (document.getElementById('rpg_quests_frustration'));
            if (frustrationCb) {
                frustrationCb.checked = !!getSettings().syspromptModules?.questsFrustration;
                frustrationCb.addEventListener('change', function () {
                    const fresh = getSettings();
                    if (!fresh.syspromptModules) fresh.syspromptModules = {};
                    fresh.syspromptModules.questsFrustration = !!this.checked;
                    if (fresh.questLegacyMode) {
                        refreshQuestLegacyPrompt(fresh);
                        refreshOrderList();
                    } else {
                        registerLogQuestTool();
                    }
                    saveSettings();
                    scheduleAutoApply();
                });
            }

            // Difficulty Toggle
            const difficultyCb = /** @type {HTMLInputElement} */ (document.getElementById('rpg_quests_difficulty'));
            if (difficultyCb) {
                difficultyCb.checked = !!getSettings().syspromptModules?.questsDifficulty;
                difficultyCb.addEventListener('change', function () {
                    const fresh = getSettings();
                    if (!fresh.syspromptModules) fresh.syspromptModules = {};
                    fresh.syspromptModules.questsDifficulty = !!this.checked;
                    if (fresh.questLegacyMode) {
                        refreshQuestLegacyPrompt(fresh);
                        refreshOrderList();
                    } else {
                        registerLogQuestTool();
                    }
                    saveSettings();
                    scheduleAutoApply();
                });
            }

            // Quests Help Trigger
            $('#rt_quests_hardcore_help').on('click', (e) => {
                e.stopPropagation();
                showQuestsHardcoreExplanation();
            });

            // Components Help Trigger
            $('#rt_components_help').on('click', (e) => {
                e.stopPropagation();
                showComponentsExplanation();
            });



            // Quest Mode (Standard vs Legacy)
            const questModeRadios = document.querySelectorAll('input[name="rpg_sysprompt_quest_mode"]');
            if (questModeRadios.length) {
                const s = getSettings();
                const currentQuestMode = s.questLegacyMode ? 'legacy' : 'standard';
                $(`input[name="rpg_sysprompt_quest_mode"][value="${currentQuestMode}"]`).prop('checked', true);

                $('input[name="rpg_sysprompt_quest_mode"]').on('change', function () {
                    const fresh = getSettings();
                    fresh.questLegacyMode = ($(this).val() === 'legacy');
                    
                    if (fresh.questLegacyMode) {
                        if (!fresh.stockPrompts) fresh.stockPrompts = {};
                        // Legacy prompt is applied at runtime by buildModulesInstructionText
                    } else {
                        // Always restore from canonical default — never trust a stale backup
                        fresh.stockPrompts.quests = DEFAULT_STOCK_PROMPTS.quests;
                        delete fresh._questToolPromptBackup;
                    }
                    refreshOrderList();
                    registerLogQuestTool();
                    saveSettings();
                    scheduleAutoApply();
                });
            }

            // RNG Mode (Hybrid vs Legacy)
            const rngModeRadios = document.querySelectorAll('input[name="rpg_sysprompt_rng_mode"]');
            if (rngModeRadios.length) {
                const s = getSettings();
                let currentRngMode = (s.rngEnabled && s.diceFunctionTool === false) ? 'legacy' : 'hybrid';
                $(`input[name="rpg_sysprompt_rng_mode"][value="${currentRngMode}"]`).prop('checked', true);

                $('input[name="rpg_sysprompt_rng_mode"]').on('change', function () {
                    const fresh = getSettings();
                    const val = $(this).val();
                    if (val === 'hybrid') {
                        fresh.rngEnabled = true;
                        fresh.diceFunctionTool = true;
                        registerDiceFunctionTool();
                    } else {
                        fresh.rngEnabled = true;
                        fresh.diceFunctionTool = false;
                    }
                    saveSettings();
                    scheduleAutoApply();
                });
            }

            // Router Agent Settings
            $('#rpg_tracker_router_enabled').prop('checked', settings.routerEnabled).on('change', function () {
                settings.routerEnabled = !!$(this).prop('checked');
                saveSettings();
                // Sync in-panel enable checkbox
                const inPanelCheck = /** @type {HTMLInputElement|null} */ (document.getElementById('rt-agent-router-enable'));
                if (inPanelCheck) inPanelCheck.checked = settings.routerEnabled;
                // Apply disabled state to agent panel
                const ap = document.getElementById('rpg-tracker-agent');
                if (ap) {
                    if (settings.routerEnabled) ap.classList.remove('is-agent-disabled');
                    else ap.classList.add('is-agent-disabled');
                }
            });

            const routerSourceSelect = $('#rpg_tracker_router_source');
            const routerProfileGroup = $('#rpg_tracker_router_profile_group');
            const routerProfileSelect = $('#rpg_tracker_router_connection_profile');
            const routerOllamaGroup = $('#rpg_tracker_router_ollama_group');
            const routerOpenaiGroup = $('#rpg_tracker_router_openai_group');
            const routerMaxTokensInput = $('#rpg_tracker_router_max_tokens');

            function updateRouterConnectionPanels() {
                const source = routerSourceSelect.val();
                routerProfileGroup.toggle(source === 'profile');
                routerOllamaGroup.toggle(source === 'ollama');
                routerOpenaiGroup.toggle(source === 'openai');
            }

            routerSourceSelect.val(settings.routerConnectionSource || 'default').on('change', function () {
                settings.routerConnectionSource = $(this).val();
                updateRouterConnectionPanels();
                saveSettings();
            });
            setTimeout(updateRouterConnectionPanels, 100); // Ensure DOM is ready for toggle

            // Prefix display (read-only — auto-derived from chat name)
            const prefixDisplayEl = document.getElementById('rpg_tracker_router_prefix_display');
            if (prefixDisplayEl) prefixDisplayEl.textContent = settings.routerCampaignPrefix || '—';

            // Router Ollama
            $('#rpg_tracker_router_ollama_url').val(settings.routerOllamaUrl).on('input', function () {
                settings.routerOllamaUrl = $(this).val();
                saveSettings();
            });
            const routerOllamaModelSelect = $('#rpg_tracker_router_ollama_model');
            routerOllamaModelSelect.val(settings.routerOllamaModel).on('change', function () {
                settings.routerOllamaModel = $(this).val();
                saveSettings();
            });
            $('#rpg_tracker_router_ollama_refresh').on('click', async function () {
                const url = $('#rpg_tracker_router_ollama_url').val();
                if (!url) return toastr['info']("Please enter an Ollama URL first.");
                try {
                    toastr['info']("Fetching Ollama models...");
                    const models = await fetchOllamaModels(url);
                    routerOllamaModelSelect.empty().append('<option value="">-- Select Model --</option>');
                    models.forEach(m => {
                        routerOllamaModelSelect.append($('<option></option>').val(m.name).text(m.name));
                    });
                    routerOllamaModelSelect.val(settings.routerOllamaModel);
                    toastr['success']("Ollama models updated.");
                } catch (e) {
                    toastr['error']("Failed to fetch Ollama models.");
                }
            });

            // Router OpenAI
            $('#rpg_tracker_router_openai_url').val(settings.routerOpenaiUrl).on('input', function () {
                settings.routerOpenaiUrl = $(this).val();
                saveSettings();
            });
            $('#rpg_tracker_router_openai_key').val(settings.routerOpenaiKey).on('input', function () {
                settings.routerOpenaiKey = $(this).val();
                saveSettings();
            });
            const routerOpenaiModelSelect = $('#rpg_tracker_router_openai_model');
            const routerOpenaiModelManual = $('#rpg_tracker_router_openai_model_manual');
            routerOpenaiModelManual.val(settings.routerOpenaiModel || '');
            routerOpenaiModelSelect.on('change', function () {
                const val = $(this).val();
                if (val) {
                    routerOpenaiModelManual.val('');
                    settings.routerOpenaiModel = String(val);
                } else {
                    settings.routerOpenaiModel = String(routerOpenaiModelManual.val() || '').trim() || '';
                }
                saveSettings();
            });
            routerOpenaiModelManual.on('input', function () {
                const manual = String($(this).val() || '').trim();
                if (manual) routerOpenaiModelSelect.val('');
                settings.routerOpenaiModel = manual || String(routerOpenaiModelSelect.val() || '') || '';
                saveSettings();
            });
            $('#rpg_tracker_router_openai_refresh').on('click', async function () {
                const url = $('#rpg_tracker_router_openai_url').val();
                const key = $('#rpg_tracker_router_openai_key').val();
                if (!url) return toastr['info']("Please enter an Endpoint URL first.");
                try {
                    toastr['info']("Fetching models...");
                    const models = await fetchOpenAIModels(url, key);
                    routerOpenaiModelSelect.empty().append('<option value="">-- Select Model --</option>');
                    models.forEach(m => {
                        const id = typeof m === 'string' ? m : (m.id || m.name);
                        if (id) routerOpenaiModelSelect.append($('<option></option>').val(id).text(id));
                    });
                    routerOpenaiModelSelect.val(settings.routerOpenaiModel);
                    toastr['success']("Models updated.");
                } catch (e) {
                    toastr['warning']("Cannot auto-detect models. Type manually.");
                }
            });

            // Router Profiles & Presets Population
            const routerPresetSelect = $('#rpg_tracker_router_completion_preset');
            if (ctx.ConnectionManagerRequestService?.handleDropdown) {
                /** @type {any} */ (ctx.ConnectionManagerRequestService).handleDropdown(routerProfileSelect[0]);
                routerProfileSelect.val(settings.routerConnectionProfileId || "");
            } else {
                getConnectionProfiles().then(profiles => {
                    routerProfileSelect.empty().append('<option value="">-- No Profile Selected --</option>');
                    profiles.forEach(p => routerProfileSelect.append($('<option></option>').val(p).text(p)));
                    routerProfileSelect.val(settings.routerConnectionProfileId || "");
                });
            }
            routerProfileSelect.on('change', function () {
                settings.routerConnectionProfileId = $(this).val();
                saveSettings();
            });

            if (pm && typeof pm.getAllPresets === 'function') {
                const presets = pm.getAllPresets();
                routerPresetSelect.empty().append('<option value="">-- Use Current Settings --</option>');
                presets.forEach(p => routerPresetSelect.append($('<option></option>').val(p).text(p)));
                routerPresetSelect.val(settings.routerCompletionPresetId || '');
            }
            routerPresetSelect.on('change', function () {
                settings.routerCompletionPresetId = String($(this).val() || '');
                saveSettings();
            });

            routerMaxTokensInput.val(settings.routerMaxTokens).on('input', function () {
                settings.routerMaxTokens = parseInt(String($(this).val() || '')) || 0;
                saveSettings();
            });
            $('#rpg_tracker_router_max_turns').val(settings.routerMaxTurns).on('input', function () {
                settings.routerMaxTurns = parseInt(String($(this).val() || '')) || 5;
                saveSettings();
            });
            $('#rpg_tracker_router_lookback').val(settings.routerLookback).on('input', function () {
                settings.routerLookback = parseInt(String($(this).val() || '')) || 4;
                $('#rt-agent-router-lookback').val(settings.routerLookback);
                saveSettings();
            });

            $('#rpg_tracker_router_prompt').val(settings.routerSystemPromptTemplate).on('input', function () {
                settings.routerSystemPromptTemplate = String($(this).val() || '');
                saveSettings();
            });
            $('#rpg_tracker_router_btn_reset_prompt').on('click', function () {
                if (!confirm('Reset Router Agent prompt to default?')) return;

                // Delete the stored key so getSettings() falls back to the canonical default in state-manager.js
                const { extensionSettings } = SillyTavern.getContext();
                if (extensionSettings[MODULE_NAME]) {
                    delete extensionSettings[MODULE_NAME].routerSystemPromptTemplate;
                }
                const freshDefault = getSettings().routerSystemPromptTemplate;

                const s = getSettings();
                s.routerSystemPromptTemplate = freshDefault;

                const $el = $('#rpg_tracker_router_prompt');
                $el.val(freshDefault);
                $el.trigger('input');

                if (typeof (/** @type {any} */ ($el)).trigger === 'function') {
                    (/** @type {any} */ ($el)).trigger('autosize.resize');
                }

                saveSettings();
                toastr['success']('Router prompt reset to default.', 'RPG Tracker');
            });

            // Custom Sysprompt Mode toggle
            const customSyspromptCb = /** @type {HTMLInputElement|null} */ (document.getElementById('rpg_tracker_custom_sysprompt'));
            const narratorConfigBlock = document.getElementById('rpg_narrator_config_block');
            const syncNarratorBlockVisibility = () => {
                if (narratorConfigBlock) narratorConfigBlock.style.display = customSyspromptCb?.checked ? 'none' : '';
            };
            if (customSyspromptCb) {
                customSyspromptCb.checked = !!getSettings().customSysprompt;
                syncNarratorBlockVisibility();
                customSyspromptCb.addEventListener('change', function () {
                    const fresh = getSettings();
                    fresh.customSysprompt = !!this.checked;
                    saveSettings();
                    syncNarratorBlockVisibility();
                });
            }

            $('#rpg_tracker_btn_update').on('click', async function () {
                const { chat } = SillyTavern.getContext();
                if (!chat || chat.length === 0) return toastr['info']("No chat history found.", "RPG Tracker");

                let lastAssistantMsg = "";
                for (let i = chat.length - 1; i >= 0; i--) {
                    // Look for any message that isn't the user and isn't empty.
                    // We include 'system' messages because some Narrator extensions/prompts
                    // might mark their output as system, and we still want to track state from them.
                    if (!chat[i].is_user && chat[i].mes && chat[i].mes.trim()) {
                        lastAssistantMsg = chat[i].mes;
                        break;
                    }
                }
                if (!lastAssistantMsg) return toastr['info']("No assistant message with content found.", "RPG Tracker");

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
                    settings.quests = [];
                    settings.historyIndex = -1;
                    _historyViewIndex = -1;
                    saveSettings();
                    updateUIMemo("");
                    refreshRenderedView();
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
                    saveSettings();
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

        // Add wand button to toggle panel visibility
        addWandButton();

    function updateTrackerFontSize(size) {
        const panel = document.getElementById('rpg-tracker-panel');
        if (!panel) return;
        const s = size || getSettings().fontSize || 13;
        panel.style.setProperty('--rt-base-size', s + 'px');

        // Also update CFE preview if open
        const cfe = document.getElementById('rt_cfe_preview');
        if (cfe) cfe.style.setProperty('--rt-base-size', s + 'px');
    }

    function updateAgentFontSize(size) {
        const s = size || getSettings().agentFontSize || 13;
        // Agent may be embedded in the main panel or detached to body
        for (const el of /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('#rpg-tracker-agent'))) {
            el.style.setProperty('--rt-base-size', s + 'px');
        }
    }

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

    // ── Debug harness (safe to leave in — only runs when called manually) ──
    // Usage from DevTools console:
    //   window.rpgDebug.testCleanToolCall(someMessage)
    //   window.rpgDebug.testCleanToolCall()   <- uses last assistant message from chat
    const _dbgWin = /** @type {any} */ (window);
    _dbgWin.rpgDebug = _dbgWin.rpgDebug || {};
    _dbgWin.rpgDebug.testCleanToolCall = function (text) {
        if (text === undefined) {
            // Auto-grab the last non-user message from the current chat
            const { chat } = SillyTavern.getContext();
            const last = chat && [...chat].reverse().find(m => !m.is_user && m['role'] !== 'user');
            text = last ? (last.mes || last['content'] || '') : '';
            if (!text) { console.warn('[rpgDebug] No assistant message found in chat.'); return; }
        }
        const result = cleanToolCallMessage(text);
        const saved = text.length - result.length;
        console.group('%c[rpgDebug] cleanToolCallMessage', 'font-weight:bold;color:#7c4dff');
        console.log('%cINPUT  (%d chars)', 'color:#aaa', text.length, text);
        console.log('%cOUTPUT (%d chars)', 'color:#4caf50', result.length, result);
        console.log(
            saved > 0
                ? `%c✅ Stripped ${saved} chars (~${Math.round(saved / 4)} tokens)`
                : '%c⚠️  Nothing stripped — not a tool-call JSON (original returned unchanged)',
            `font-weight:bold;color:${saved > 0 ? '#4caf50' : '#f44336'}`
        );
        console.groupEnd();
        return result;
    };

    })();

/**
 * Renders the debug info into the Agent panel's debug drawer.
 */

