import { EXAMPLES, COLOR_EXAMPLES, DEFAULT_STOCK_PROMPTS, RT_PROMPTS, BLOCK_ICONS, BLOCK_ORDER, PAGE_SIZE, NO_PAGINATE } from './constants.js';
import { MODULE_NAME, getSettings, getBarBackground, migrateCustomFields, saveChatState, saveProfile, deleteProfile } from './settings.js';
import { sendStateRequest, fetchOllamaModels, fetchOpenAIModels, testOpenAIConnection, getConnectionProfiles, getCurrentCompletionPreset, setCompletionPreset } from './api.js';
import { getDiceToolName, getDiceCommandName, getDiceCommandAliases, doDiceRoll, registerDiceFunctionTool, registerDiceSlashCommand, installInterceptor, getNarrativeBlocks, onGenerationEnded } from './rng.js';
import { deduplicateMemo, mergeMemo, computeDelta, escapeHtml, escapeRegex, highlightParens, cleanToolCallMessage, getLastUserAction, buildLorebookContext, buildModulesInstructionText, buildModuleFormatInstruction } from './state-engine.js';

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
    let _currentChatId = null;
    let themeUndoStack = [];
    // ── Renderer / navigation state ──
    let _historyViewIndex = -1;    // -1 = live, 0 = most recent snapshot, higher = older
    let _renderedViewActive = false;
    const _sectionPages = {};



    // ── Chat-Linked State (deferred from settings.js — touches DOM + _historyViewIndex) ──

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

        _historyViewIndex = -1;

        const dp = document.getElementById('rpg-tracker-delta-content');
        if (dp) dp.innerHTML = s.lastDelta || '<span class="delta-empty">No changes yet.</span>';

        refreshOrderList();
        syncMemoView();
        return true;
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
        SillyTavern.getContext().saveSettingsDebounced();
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
                SillyTavern.getContext().saveSettingsDebounced();
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
                    SillyTavern.getContext().saveSettingsDebounced();
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
            SillyTavern.getContext().saveSettingsDebounced();
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
                SillyTavern.getContext().saveSettingsDebounced();
                refreshRenderedView();
                popup.remove();
            });

            popup.querySelector('#recolor-reset').addEventListener('click', () => {
                const ss = getSettings();
                if (ss.barColors) delete ss.barColors[barId];
                SillyTavern.getContext().saveSettingsDebounced();
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

        if (!panel || !indicator || !pauseBtn) return;

        if (!settings.enabled) {
            // Fully disabled — transparent panel, no banner
            panel.classList.add('is-disabled');
            panel.classList.remove('is-paused');
            indicator.classList.remove('active');
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
        const { generateRaw, saveSettingsDebounced } = SillyTavern.getContext();

        if (!generateRaw) {
            console.error("[RPG Tracker] generateRaw not found in context.");
            return;
        }

        try {
            _stateModelRunning = true;
            updateStatusIndicator('running');

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

            const result = await sendStateRequest(settings, systemPrompt, userPrompt);            if (result && typeof result === 'string') {
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
                if (settings.memoHistory.length > 1000) settings.memoHistory.length = 1000;

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

    // ── Phase-5 bridge: exposes runStateModelPass for rng.js/onGenerationEnded ──
    // Removed when state-engine.js is created in Phase 5.
    globalThis._rpgRunStateModelPass = runStateModelPass;

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
            const worldLore = await buildLorebookContext();
            const worldLoreSection = worldLore ? worldLore + '\n\n' : '';

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

    function refreshProfileDropdown() {
        const s = getSettings();
        const sel = document.getElementById('rpg_tracker_profile_select');
        if (!sel) return;
        const names = Object.keys(s.profiles || {});
        sel.innerHTML = '<option value="">-- No Profile --</option>' +
            names.map(n => `<option value="${escapeHtml(n)}"${n === s.activeProfile ? ' selected' : ''}>${escapeHtml(n)}</option>`).join('');
    }


    /**
     * Renders a line according to a row rule (label → renderType → color).
     * Flexible "salad bar" renderers — hp_bar and xp_bar accept any X/Y value.
     */
    function renderSubFieldByRule(rule, line, barId = null) {
        const colonIdx = line.indexOf(':');
        // If there's no colon, the whole line is the value (no label)
        const hasLabel = colonIdx !== -1;
        const labelText = hasLabel ? line.substring(0, colonIdx + 1).trim() : '';
        const value     = hasLabel ? line.substring(colonIdx + 1).trim() : line.trim();
        const labelStyle = rule.color ? ` style="color:${rule.color}"` : '';
        const labelHtml  = labelText
            ? `<span class="rt-entity-sub-label"${labelStyle}>${escapeHtml(labelText)}</span>`
            : '';

        switch (rule.renderType) {
            case 'pills':
                return `<div class="rt-entity-sub-line rt-units-container">${labelHtml} ${renderPills(value)}</div>`;
            case 'badge':
                return `<div class="rt-entity-sub-line rt-units-container">${labelHtml} <span class="rt-unit-pill no-desc"><span class="rt-unit-name">${escapeHtmlWithColor(value)}</span></span></div>`;
            case 'highlight':
                return `<div class="rt-entity-sub-line">${labelHtml} ${highlightParens(escapeHtmlWithColor(value))}</div>`;
            case 'hp_bar': {
                // Flexible: parses any "X/Y" optionally with extra text e.g. "45/100 (5 temp)"
                const m = value.match(/(\d[\d,]*)\s*\/\s*(\d[\d,]*)/);
                if (m) {
                    const cur = parseInt(m[1].replace(/,/g, ''), 10);
                    const max = parseInt(m[2].replace(/,/g, ''), 10);
                    const pct = max > 0 ? Math.max(0, Math.min(100, (cur / max) * 100)) : 0;
                    const extra = value.replace(m[0], '').trim();
                    // Use custom color if set, else fall back to red gradient
                    let barBg = rule.color
                        ? rule.color
                        : 'linear-gradient(90deg,#e74c3c,#c0392b)';
                    if (barId) barBg = getBarBackground(barId, barBg, pct);

                    const recolorData = barId ? ` data-recolor-id="${escapeHtml(barId)}" data-recolor-current="${escapeHtml(barBg)}" title="Click to recolor"` : '';

                    return `<div class="rt-entity-sub-line" style="gap:6px;">
                        ${labelHtml}
                        <div class="rt-hp-bar-wrap"${recolorData} style="flex:1; position:relative; height:14px; border-radius:4px; overflow:hidden; background:rgba(255,255,255,0.1);">
                            <div class="rt-hp-bar" style="width:${pct.toFixed(1)}%; height:100%; border-radius:4px; background:${barBg}; transition:width 0.3s;"></div>
                        </div>
                        <span style="font-size:0.82em; opacity:0.85; white-space:nowrap;">${cur}/${max}${extra ? ' ' + escapeHtml(extra) : ''}</span>
                    </div>`;
                }
                // Fallback: plain text
                return `<div class="rt-entity-sub-line">${labelHtml} ${escapeHtmlWithColor(value)}</div>`;
            }
            case 'xp_bar': {
                // Flexible: parses any "X/Y" with optional "Level N" anywhere in value
                const xm = value.match(/(\d[\d,]*)\s*\/\s*(\d[\d,]*)/);
                const lm = value.match(/level\s*(\d+)/i);
                if (xm) {
                    const cur = parseInt(xm[1].replace(/,/g, ''), 10);
                    const max = parseInt(xm[2].replace(/,/g, ''), 10);
                    const pct = max > 0 ? Math.max(0, Math.min(100, (cur / max) * 100)) : 0;
                    const levelStr = lm ? `<span style="font-size:0.8em; opacity:0.75;">Lv ${lm[1]}</span> ` : '';
                    // Use custom color if set, else fall back to orange gradient
                    let barBg = rule.color
                        ? rule.color
                        : 'linear-gradient(90deg,#f39c12,#e67e22)';
                    if (barId) barBg = getBarBackground(barId, barBg, pct);

                    const recolorData = barId ? ` data-recolor-id="${escapeHtml(barId)}" data-recolor-current="${escapeHtml(barBg)}" title="Click to recolor"` : '';

                    return `<div class="rt-entity-sub-line" style="gap:6px; flex-wrap:wrap;">
                        ${labelHtml} ${levelStr}
                        <div class="rt-hp-bar-wrap"${recolorData} style="flex:1; min-width:60px; position:relative; height:10px; border-radius:4px; overflow:hidden; background:rgba(255,255,255,0.1);">
                            <div style="width:${pct.toFixed(1)}%; height:100%; border-radius:4px; background:${barBg}; transition:width 0.3s;"></div>
                        </div>
                        <span style="font-size:0.78em; opacity:0.8; white-space:nowrap;">${xm[1]}/${xm[2]}</span>
                    </div>`;
                }
                return `<div class="rt-entity-sub-line">${labelHtml} ${escapeHtmlWithColor(value)}</div>`;
            }
            case 'kv':
                return `<div class="rt-card-kv"><span class="rt-card-key">${labelHtml}</span><span class="rt-card-val">${escapeHtmlWithColor(value)}</span></div>`;
            case 'text':
            default:
                return `<div class="rt-entity-sub-line">${labelHtml} ${escapeHtmlWithColor(value)}</div>`;
        }
    }

    /**
     * If `line` begins with a ((MARKER)) prefix, renders it and returns HTML.
     * Returns null if no marker is present, so callers can fall through to
     * their own renderer. This makes markers work in ALL stock blocks.
     */
    function tryRenderMarker(line, tag = '', entityName = '') {
        const m = line.match(/^\(\((PILLS|BAR|HPBAR|XPBAR|TEXT|BADGE|HIGHLIGHT|PLS|B|HPB|XB|HGT|BDG)\)\)\s*(.*)$/i);
        if (!m) return null;
        const typeMap = {
            PILLS:'pills', PLS:'pills',
            BAR:'hp_bar', B:'hp_bar',
            HPBAR:'hp_bar', HPB:'hp_bar',
            XPBAR:'xp_bar', XB:'xp_bar',
            TEXT:'text',
            BADGE:'badge', BDG:'badge',
            HIGHLIGHT:'highlight', HGT:'highlight'
        };
        const markerType = m[1].toUpperCase();
        const renderType = typeMap[markerType] || 'text';
        const content = m[2].trim();

        let barId = null;
        if (renderType === 'hp_bar' || renderType === 'xp_bar') {
            const colonIdx = content.indexOf(':');
            const labelText = colonIdx !== -1 ? content.substring(0, colonIdx).trim() : 'Bar';
            barId = `${tag}:${entityName}:${labelText}`;
        }

        return renderSubFieldByRule({ renderType }, content, barId);
    }

    /**
     * Renders a single line from a custom block (non-built-in tag).
     */
    function renderCustomBlockLine(tag, line, lineIdx = 0) {
        const asMarker = tryRenderMarker(line, tag);
        if (asMarker !== null) return asMarker;

        // Plain kv fallback
        const kv = line.match(/^([^:]+):\s*(.+)$/);
        if (kv) return `<div class="rt-card-kv"><span class="rt-card-key">${escapeHtmlWithColor(kv[1].trim())}:</span><span class="rt-card-val">${escapeHtmlWithColor(kv[2].trim())}</span></div>`;
        return `<div class="rt-card-line">${escapeHtmlWithColor(line.trim())}</div>`;
    }

    /**
     * Strip HTML tags from a memo string, preserving inner text.
     * Used before sending the memo to the AI to avoid token bloat from
     * color markup (<font>, <span>, etc.) that is purely for display.
     * NOTE: ((MARKERS)) like ((PILLS)), ((BAR)), etc. are intentionally
     * preserved so the AI can faithfully echo them back in its output.
     */
    function stripMemoHtml(text) {
        if (!text) return text;
        // Convert <br> variants to newlines so line structure is preserved
        let stripped = text.replace(/<br\s*\/?>/gi, '\n');
        // Remove all HTML tags, keeping their inner text
        stripped = stripped.replace(/<[^>]+>/g, '');
        return stripped;
    }

    /**
     * Like escapeHtml but allows <font color="#hex"> and <font color="name"> tags through,
     * converting them to safe <span style="color:"> elements.
     * Use this for all AI/user content rendered into tracker cards.
     */
    function escapeHtmlWithColor(str) {
        if (!str) return '';

        // Rarity tag map (WoW-style item quality)
        const RARITY_COLORS = {
            'poor': '#9d9d9d',
            'common': '#ffffff',
            'uncommon': '#1eff00',
            'rare': '#0070dd',
            'epic': '#a335ee',
            'legendary': '#ff8000',
            'artifact': '#e6cc80',
            'heirloom': '#00ccff'
        };

        // Shared placeholder system — placeholders survive escapeHtml unchanged
        const OPEN = '\x01';
        const CLOSE = '\x02';
        const spans = [];

        // 1. Process [Rarity] tags. They hide the tag and color everything that follows them.
        const rarityRx = /\[(poor|common|uncommon|rare|epic|legendary|artifact|heirloom)\]\s*([\s\S]*)/gi;
        let processed = str.replace(rarityRx, (match, rarity, rest) => {
            const color = RARITY_COLORS[rarity.toLowerCase()];
            // Recursively process 'rest' for any font tags, but skip rarity tags (already handled)
            const safeInner = escapeHtmlWithColor(rest);
            spans.push(`<span style="color:${color}">${safeInner}</span>`);
            return OPEN + (spans.length - 1) + CLOSE;
        });

        // 2. Replace <font color=...>inner</font> tags (author-written color markup).
        //    The inner text is recursively processed so nested tags work correctly.
        const colorRx = /<font\s+color\s*=\s*["']?(#[0-9a-fA-F]{3,8}|[a-zA-Z]+)["']?>([\s\S]*?)<\/font>/gi;
        const tokenized = processed.replace(colorRx, (_, color, inner) => {
            // inner may contain more font tags but NOT rarity tags (already replaced above)
            const safeInner = escapeHtmlWithColor(inner);
            spans.push(`<span style="color:${color}">${safeInner}</span>`);
            return OPEN + (spans.length - 1) + CLOSE;
        });

        // 3. Escape everything that remains, then restore the safe span placeholders.
        return escapeHtml(tokenized).replace(/\x01(\d+)\x02/g, (_, i) => spans[parseInt(i)]);
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
            // Detect buff/debuff prefix
            let pillClass = 'rt-unit-pill';
            let displayText = t;
            if (t.startsWith('(+)') || t.startsWith('(+) ')) {
                pillClass += ' rt-pill-buff';
                displayText = t.replace(/^\(\+\)\s*/, '');
            } else if (t.startsWith('(-)') || t.startsWith('(-) ')) {
                pillClass += ' rt-pill-debuff';
                displayText = t.replace(/^\(-\)\s*/, '');
            }

            const m = displayText.match(/^(.+?)\s*\((.+)\)$/);
            if (m) {
                const [, name, desc] = m;

                // Extract resource count if present (e.g., "2/3")
                let iconHtml = '';
                const resourceMatch = desc.match(/(\d+)\s*\/\s*(\d+)/);
                if (resourceMatch) {
                    iconHtml = `<span class="rt-unit-icon">${escapeHtmlWithColor(resourceMatch[0])}</span>`;
                }

                return `<span class="${pillClass}">
                    <span class="rt-unit-name">${escapeHtmlWithColor(name)}</span>
                    ${iconHtml}
                    <span class="rt-unit-descr">(${escapeHtmlWithColor(desc)})</span>
                </span>`;
            }
            return `<span class="${pillClass} no-desc"><span class="rt-unit-name">${escapeHtmlWithColor(displayText)}</span></span>`;
        }).join('');
    };


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

    const COLLAPSE_KEY = 'rpg_tracker_collapsed';
    const DETACHED_KEY = 'rpg_tracker_detached';



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



    function blockToItems(tag, content, renderTypeOverride = null) {
        const lines = content.split('\n').map(l => l.trim()).filter(Boolean);
        let renderType = renderTypeOverride || tag;
        const customField = (getSettings().customFields || []).find(f => f.tag.toUpperCase() === tag);
        if (!renderTypeOverride && customField && customField.renderType) {
            renderType = customField.renderType;
        }

        switch (renderType) {
                        case 'COMBAT':
            case 'PARTY':
            case 'CHARACTER': {
                const results = [];
                let lastEntityIdx = -1;
                let currentEntity = '';

                const MARKER_RX = /^\(\((PILLS|BAR|XPBAR|TEXT|BADGE|HIGHLIGHT|HPBAR|PLS|B|XB|HGT|HPB|BDG)\)\)\s*(.*)/i;
                const MARKER_TYPE_MAP = {
                    'PILLS': 'pills', 'PLS': 'pills',
                    'BAR': 'hp_bar', 'B': 'hp_bar',
                    'HPBAR': 'hp_bar', 'HPB': 'hp_bar',
                    'XPBAR': 'xp_bar', 'XB': 'xp_bar',
                    'TEXT': 'text',
                    'BADGE': 'badge', 'BDG': 'badge',
                    'HIGHLIGHT': 'highlight', 'HGT': 'highlight'
                };

                const renderSpellGroup = (groupStr) => {
                    const m = groupStr.trim().match(/^(Level\s*\d+|Cantrips?)\s*(?:\((\d+)\/(\d+)[^)]*\))?\s*(?::\s*(.+))?$/i);
                    if (!m) return null;
                    const [, lbl, availStr, maxStr, spellList] = m;
                    const isCantrip = /cantrip/i.test(lbl);
                    let pipsHtml = '';
                    if (!isCantrip && availStr !== undefined && maxStr !== undefined) {
                        const avail = parseInt(availStr, 10), maxSlots = parseInt(maxStr, 10);
                        pipsHtml = `<span class="rt-slot-pips">${Array.from({ length: maxSlots }, (_, i) =>
                            `<span class="rt-slot-pip${i < avail ? ' rt-slot-available' : ' rt-slot-used'}"></span>`).join('')}</span>`;
                    }
                    let spellsHtml = '';
                    if (spellList) {
                        spellsHtml = `<div class="rt-spell-list">${spellList.split(',').map(s => {
                            const name = s.trim();
                            const slug = name.toLowerCase().replace(/'/g, '').replace(/[^a-z0-9]+/g, '-');
                            return `<a href="https://dnd5e.wikidot.com/spell:${slug}" target="_blank" class="rt-spell-name" title="View spell on Wikidot">${escapeHtmlWithColor(name)}</a>`;
                        }).join('')}</div>`;
                    }
                    return `<div class="rt-spell-row"><span class="rt-spell-level">${escapeHtmlWithColor(lbl.trim())}</span><div class="rt-spell-inline-group">${pipsHtml}${spellsHtml}</div></div>`;
                };

                for (let i = 0; i < lines.length; i++) {
                    const rawLine = lines[i];
                    const mm = rawLine.match(MARKER_RX);
                    const explicitType = mm ? MARKER_TYPE_MAP[mm[1].toUpperCase()] : null;
                    const line = mm ? mm[2].trim() : rawLine;

                    // 1. Combat Round header
                    if (tag === 'COMBAT' && /Combat Round\s*\d+/i.test(line)) {
                        results.push(`<div class="rt-combat-round">${escapeHtmlWithColor(line)}</div>`);
                        lastEntityIdx = -1;
                        continue;
                    }

                    // 2. Entity anchor: classic "Name: X/Y HP ..." — fires with no marker OR BAR/HPBAR
                    const hpMatch = line.match(/^(.+?):\s*([\d,]+)(?:\/([\d,]+))?\s*HP\s*[:|,]?\s*(.*)$/i);
                    if (hpMatch && (explicitType === null || explicitType === 'hp_bar')) {
                        const [, name, curRaw, maxRaw, rest] = hpMatch;
                        const cur = Number(curRaw.replace(/,/g, ''));
                        const max = maxRaw ? Number(maxRaw.replace(/,/g, '')) : undefined;
                        const hasMax = max !== undefined;
                        const pct = hasMax ? Math.max(0, Math.min(100, (cur / max) * 100)) : 100;
                        const hpColor = !hasMax ? '#00ffaa' : pct > 60 ? '#00ffaa' : pct > 30 ? '#ffaa00' : '#ff5555';
                        const status = rest.trim().replace(/^\|\s*/, '');
                        const label = hasMax ? `${curRaw}/${maxRaw}` : `${curRaw}`;

                        currentEntity = name.trim();
                        const barId = `${tag}:${currentEntity}:HP`;
                        const barBg = getBarBackground(barId, hpColor, pct);

                        lastEntityIdx = results.length;
                        results.push(`<div class="rt-entity-row"><div class="rt-entity-name">${escapeHtmlWithColor(currentEntity)}</div><div class="rt-hp-bar-wrap" title="Click to recolor HP" data-recolor-id="${escapeHtml(barId)}" data-recolor-current="${escapeHtml(barBg)}"><div class="rt-hp-bar" style="width:${pct.toFixed(1)}%;background:${barBg};"></div></div><span class="rt-hp-label">${label}</span></div>`);

                        if (status) {
                            const parts = status.split('|').map(p => p.trim()).filter(Boolean);
                            let genericInfo = [];
                            for (const part of parts) {
                                if (part.toLowerCase().startsWith('ac:')) {
                                    results[lastEntityIdx] += `<div class="rt-entity-sub-line"><span class="rt-entity-sub-label">AC:</span> ${escapeHtmlWithColor(part.substring(3).trim())}</div>`;
                                } else if (part.toLowerCase().startsWith('saves:')) {
                                    results[lastEntityIdx] += `<div class="rt-entity-sub-line"><span class="rt-entity-sub-label">Saves:</span> ${highlightParens(escapeHtmlWithColor(part.substring(6).trim()))}</div>`;
                                } else if (part.toLowerCase().startsWith('status:')) {
                                    results[lastEntityIdx] += `<div class="rt-entity-sub-line rt-units-container"><span class="rt-entity-sub-label">Status:</span> ${renderPills(part.substring(7).trim())}</div>`;
                                } else if (part.toLowerCase().startsWith('other:') || part.toLowerCase().startsWith('res:')) {
                                    const lbl = part.toLowerCase().startsWith('res:') ? 'Res:' : 'Other:';
                                    const start = part.toLowerCase().startsWith('res:') ? 4 : 6;
                                    results[lastEntityIdx] += `<div class="rt-entity-sub-line rt-units-container"><span class="rt-entity-sub-label">${lbl}</span> ${renderPills(part.substring(start).trim())}</div>`;
                                } else { genericInfo.push(part); }
                            }
                            if (genericInfo.length > 0) {
                                results[lastEntityIdx] += `<div class="rt-entity-sub-line"><span class="rt-entity-sub-label">Info:</span> ${highlightParens(escapeHtmlWithColor(genericInfo.join(' | ')))}</div>`;
                            }
                        }
                        continue;
                    }

                    // 3. Explicit ((TYPE)) marker — attach to entity or push standalone
                    if (explicitType) {
                        const rendered = tryRenderMarker(rawLine, tag, currentEntity);
                        if (lastEntityIdx !== -1) { results[lastEntityIdx] += rendered; }
                        else { results.push(rendered); }
                        continue;
                    }

                    // 4. Keyword-based sub-lines (backward compat)
                    if (lastEntityIdx !== -1) {
                        const ll = line.toLowerCase();
                        if (ll.startsWith('attr:') || ll.startsWith('attributes:')) {
                            results[lastEntityIdx] += `<div class="rt-entity-sub-line rt-entity-attributes"><span class="rt-entity-sub-label">Attr:</span> ${escapeHtmlWithColor(line.substring(line.indexOf(':') + 1).trim())}</div>`;
                            continue;
                        }
                        if (ll.startsWith('skills:') || ll.startsWith('key skills:')) {
                            const sm = line.match(/^(?:key\s+)?skills:\s*(.+)$/i);
                            results[lastEntityIdx] += `<div class="rt-entity-sub-line"><span class="rt-entity-sub-label">Skills:</span> ${escapeHtmlWithColor(sm ? sm[1].trim() : line.split(':')[1]?.trim() || '')}</div>`;
                            continue;
                        }
                        if (ll.startsWith('saves:')) {
                            results[lastEntityIdx] += `<div class="rt-entity-sub-line"><span class="rt-entity-sub-label">Saves:</span> ${highlightParens(escapeHtmlWithColor(line.substring(6).trim()))}</div>`;
                            continue;
                        }
                        if (ll.startsWith('status:')) {
                            results[lastEntityIdx] += `<div class="rt-entity-sub-line rt-units-container"><span class="rt-entity-sub-label">Status:</span> ${renderPills(line.substring(7).trim())}</div>`;
                            continue;
                        }
                        if (ll.startsWith('primary weapon:') || ll.startsWith('att/def:')) {
                            const lbl = ll.startsWith('att/def:') ? 'Att/Def:' : 'Weapon:';
                            results[lastEntityIdx] += `<div class="rt-entity-sub-line"><span class="rt-entity-sub-label">${lbl}</span> ${highlightParens(escapeHtmlWithColor(line.substring(line.indexOf(':') + 1).trim()))}</div>`;
                            continue;
                        }
                        if (ll.startsWith('hd:')) {
                            let hdText = line.substring(3).trim();
                            let pipsHtml = escapeHtmlWithColor(hdText);
                            const hm = hdText.match(/^([^(]+?)\s*(?:\(([\d,]+)\/([\d,]+)\))?$/);
                            if (hm && hm[2] && hm[3]) {
                                const cur = parseInt(hm[2].replace(/,/g, ''), 10);
                                const max = parseInt(hm[3].replace(/,/g, ''), 10);
                                pipsHtml = `<span class="rt-hd-label">[ ${escapeHtmlWithColor(hm[1].trim())} ]</span> <span class="rt-hd-pips">${Array.from({ length: max }, (_, i) => `<span class="rt-hd-pip${i < cur ? ' rt-hd-available' : ''}"></span>`).join('')}</span>`;
                            }
                            results[lastEntityIdx] += `<div class="rt-entity-sub-line"><span class="rt-entity-sub-label">HD:</span> <span>${pipsHtml}</span></div>`;
                            continue;
                        }
                        if (ll.startsWith('traits:')) {
                            results[lastEntityIdx] += `<div class="rt-entity-sub-line rt-units-container"><span class="rt-entity-sub-label">Traits:</span> ${renderPills(line.substring(7).trim())}</div>`;
                            continue;
                        }
                        if (ll.startsWith('other:') || ll.startsWith('resistances:')) {
                            results[lastEntityIdx] += `<div class="rt-entity-sub-line rt-units-container"><span class="rt-entity-sub-label">Other:</span> ${renderPills(line.substring(line.indexOf(':') + 1).trim())}</div>`;
                            continue;
                        }
                        if (ll.startsWith('spells:')) {
                            const spellLine = line.substring(7).trim();
                            const isCompound = /\|/.test(spellLine) && /(?:Level\s*\d+|Cantrips?)/i.test(spellLine);
                            const groups = isCompound ? spellLine.split(/\s*\|\s*/) : [spellLine];
                            let renderedAny = false;
                            for (const group of groups) {
                                const rowHtml = renderSpellGroup(group);
                                if (rowHtml) { results[lastEntityIdx] += rowHtml; renderedAny = true; }
                            }
                            if (!renderedAny) { results[lastEntityIdx] += `<div class="rt-entity-sub-line"><span class="rt-entity-sub-label">Spells:</span> ${highlightParens(escapeHtmlWithColor(spellLine))}</div>`; }
                            continue;
                        }
                    }

                    // 5. Fallback: plain card line, resets entity context
                    results.push(`<div class="rt-card-line">${escapeHtmlWithColor(rawLine)}</div>`);
                    lastEntityIdx = -1;
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
                            return `<div class="rt-card-line"><b>Last Rest:</b> ${escapeHtmlWithColor(restVal)}${append}</div>`;
                        }
                        const asMarker = tryRenderMarker(line, tag);
                        if (asMarker !== null) return asMarker;
                        return `<div class="rt-card-line">${escapeHtmlWithColor(line)}</div>`;
                    });
            }
            case 'XP':
                return lines.map(line => {
                    const asMarker = tryRenderMarker(line, tag);
                    if (asMarker !== null) return asMarker;

                    // New format: Total: 1,200 / 2,700 XP (Level 3)
                    let m = line.match(/Total:\s*([\d,]+)\s*\/\s*([\d,]+)\s*XP\s*\(Level\s*(\d+)\)/i);
                    if (m) {
                        const [, curRaw, maxRaw, level] = m;
                        const cur = Number(curRaw.replace(/,/g, ''));
                        const max = Number(maxRaw.replace(/,/g, ''));
                        const pct = Math.max(0, Math.min(100, (cur / max) * 100));
                        const barId = 'XP::XP';
                        const barBg = getBarBackground(barId, 'linear-gradient(90deg, #f39c12, #e67e22)', pct);

                        return `<div class="rt-xp-row">
                            <div class="rt-xp-label"><span>Level ${level}</span><span>XP: ${curRaw} / ${maxRaw}</span></div>
                            <div class="rt-xp-bar-wrap" title="Click to recolor XP" data-recolor-id="${escapeHtml(barId)}" data-recolor-current="${escapeHtml(barBg)}">
                                <div class="rt-xp-bar" style="width:${pct.toFixed(1)}%; background:${barBg};"></div>
                            </div>
                        </div>`;
                    }

                    // Legacy format: XP: 1,200/2,700 or Level: 3 | XP: 1,200/2,700
                    m = line.match(/(?:Level:\s*(\d+)\s*\|?\s*)?XP:\s*([\d,]+)\/([\d,]+)/i);
                    if (m) {
                        const [, level, curRaw, maxRaw] = m;
                        const cur = Number(curRaw.replace(/,/g, ''));
                        const max = Number(maxRaw.replace(/,/g, ''));
                        const pct = Math.max(0, Math.min(100, (cur / max) * 100));
                        const levelHtml = level ? `<span>Level ${level}</span>` : '';
                        const barId = 'XP::XP';
                        const barBg = getBarBackground(barId, 'linear-gradient(90deg, #f39c12, #e67e22)', pct);

                        return `<div class="rt-xp-row">
                            <div class="rt-xp-label">${levelHtml}<span>XP: ${curRaw} / ${maxRaw}</span></div>
                            <div class="rt-xp-bar-wrap" title="Click to recolor XP" data-recolor-id="${escapeHtml(barId)}" data-recolor-current="${escapeHtml(barBg)}">
                                <div class="rt-xp-bar" style="width:${pct.toFixed(1)}%; background:${barBg};"></div>
                            </div>
                        </div>`;
                    }

                    return `<div class="rt-card-line">${escapeHtmlWithColor(line)}</div>`;
                });
            case 'SPELLS': {
                // Lines: "Level N (avail/max): Spell1, Spell2" or "Cantrips: Spell1, Spell2"
                return lines.map(line => {
                    const asMarker = tryRenderMarker(line, tag);
                    if (asMarker !== null) return asMarker;

                    const m = line.match(/^(Level\s*\d+|Cantrips?)\s*(?:\((\d+)\/(\d+)[^)]*\))?\s*:\s*(.+)$/i);
                    if (!m) return `<div class="rt-card-line">${escapeHtmlWithColor(line)}</div>`;
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
                        return `<a href="${url}" target="_blank" class="rt-spell-name" title="View spell on Wikidot">${escapeHtmlWithColor(name)}</a>`;
                    }).join('');
                    return `<div class="rt-spell-row">
                        <span class="rt-spell-level">${escapeHtmlWithColor(label.trim())}</span>
                        <div class="rt-spell-inline-group">${pipsHtml}<div class="rt-spell-list">${spells}</div></div>
                    </div>`;
                });
            }
            case 'INVENTORY': {
                // Lines with a ((MARKER)) prefix bypass the bullet-list renderer
                const inventoryResults = [];
                const pendingBullets = [];

                const flushBullets = () => {
                    if (!pendingBullets.length) return;
                    pendingBullets.forEach(i => inventoryResults.push(`<div class="rt-card-item">• ${escapeHtmlWithColor(i)}</div>`));
                    pendingBullets.length = 0;
                };

                for (const line of lines) {
                    const asMarker = tryRenderMarker(line, tag);
                    if (asMarker !== null) {
                        flushBullets();
                        inventoryResults.push(asMarker);
                        continue;
                    }
                    // Original bullet/comma logic
                    if (line.trim().match(/^[-*]\s+/)) {
                        pendingBullets.push(line.trim().replace(/^[-*]\s*/, ''));
                    } else {
                        line.split(/,(?![^(]*\))/).map(i => i.trim()).filter(Boolean)
                            .forEach(i => pendingBullets.push(i));
                    }
                }
                flushBullets();
                return inventoryResults;
            }
            case 'ABILITIES': {
                const abilityResults = [];
                for (const line of lines) {
                    const asMarker = tryRenderMarker(line, tag);
                    if (asMarker !== null) { abilityResults.push(asMarker); continue; }
                    const l = line.trim();
                    const items = l.match(/^[-*]\s+/) ? [l.replace(/^[-*]\s*/, '')] : splitSmart(l);
                    items.forEach(t => abilityResults.push(renderPills(t)));
                }
                return abilityResults;
            }
            default:
                // Custom blocks: resolve each line via module rows → global rules → kv fallback
                // Pass line index so positional row matching works even without label prefixes
                return lines.map((line, idx) => renderCustomBlockLine(tag, line, idx));
        }
    }

    function renderMemoAsCards(memo) {
        if (!memo || !memo.trim()) {
            return `<div class="rt-empty" style="text-align: left; align-items: flex-start; padding: 12px; gap: 10px; overflow-y: auto;">
                <div style="text-align: center; width: 100%; margin-bottom: 4px; flex-shrink: 0;">
                    <div class="rt-empty-icon">📜</div>
                    <div style="font-size: 17px; font-weight: bold; color: var(--rt-text);">Fatbody D&D Framework</div>
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

                <div style="font-size: 13px; opacity: 0.9; margin-top: 12px; flex-shrink: 0; line-height: 1.4; border-top: 1px solid rgba(255,255,255,0.1); padding-top: 12px;">
                    <b style="color: var(--rt-accent); font-size: 14px;">Initial Setup:</b><br><br>
                    1. Use the archetype buttons above to roll a new character, or <b>manually describe a character</b> by clicking 💬.<br><br>
                    2. Create a character card for your "narrator" (e.g. Game Master). <b>Leave the card fields empty</b>, as the framework handles all logic via the system prompt.<br><br>
                    3. Finally, copy <code>sysprompt.txt</code> (or from the <b>SYSPROMPT</b> button) into your Quick Prompts "Main" box—or <a id="rt-onboarding-auto-apply" href="javascript:void(0)" style="color: var(--rt-accent); text-decoration: underline;"><b>click here to reset &amp; apply everything automatically</b></a>.<br><br>
                    <span style="color: #ffaa00; font-size: 11px;"><b>NOTE:</b> When you update the framework, remember to reset prompts in settings (or use the link above) to ensure you have the latest logic.</span>
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
            const displayName = customField?.label || tag;
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
                    <span>${icon} ${displayName}</span>
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

    function bindRenderedCardEvents(el, memo, isDetachedContext = false, onRefresh = null) {
        const refresh = onRefresh || refreshRenderedView;
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

        el.querySelectorAll('.rt-hp-bar-wrap[data-recolor-id], .rt-xp-bar-wrap[data-recolor-id]').forEach(wrap => {
            wrap.addEventListener('click', (e) => {
                e.stopPropagation();
                handleRecolor(wrap.dataset.recolorId, wrap.dataset.recolorCurrent, wrap);
            });
        });

        const onboardingResetLink = el.querySelector('#rt-onboarding-auto-apply');
        if (onboardingResetLink) {
            onboardingResetLink.addEventListener('click', async (e) => {
                e.preventDefault();
                if (!confirm('This will:\n\n1. Reset the Core State Model prompt to built-in default\n2. Reset all Stock Module prompts, Active Modules, and Module Order to factory defaults\n3. Fetch the latest sysprompt.txt and write it directly into your Quick Prompt "Main" box\n\nYour custom modules will NOT be affected. Proceed?')) return;

                const ctx2 = SillyTavern.getContext();
                const { extensionSettings } = ctx2;

                // 1. Reset Core prompt
                delete extensionSettings[MODULE_NAME].systemPromptTemplate;
                const freshSettings = getSettings();
                $('#rpg_tracker_core_prompt').val(freshSettings.systemPromptTemplate);

                // 2. Reset stock modules, order, active modules
                delete extensionSettings[MODULE_NAME].stockPrompts;
                delete extensionSettings[MODULE_NAME].blockOrder;
                delete extensionSettings[MODULE_NAME].modules;
                refreshOrderList();
                ctx2.saveSettingsDebounced();

                // 3. Fetch sysprompt.txt and apply to ST Quick Prompt "Main"
                const fileName = 'sysprompt.txt';
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
                    toastr['error']('Could not load sysprompt.txt. Reset completed but Main prompt was NOT updated.', 'RPG Tracker');
                    return;
                }

                const mainTextarea = /** @type {HTMLTextAreaElement} */ (document.getElementById('main_prompt_quick_edit_textarea'));
                if (mainTextarea) {
                    mainTextarea.value = content;
                    mainTextarea.dispatchEvent(new Event('blur', { bubbles: true }));
                    toastr['success']('All prompts reset & Main sysprompt applied! ✅', 'RPG Tracker');
                } else {
                    const ta = document.createElement('textarea');
                    ta.value = content;
                    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;';
                    document.body.appendChild(ta);
                    ta.focus();
                    ta.select();
                    try {
                        document.execCommand('copy');
                        toastr['warning']('All prompts reset. Quick Prompt "Main" textarea not found (wrong API mode?). Sysprompt copied to clipboard — paste it manually.', 'RPG Tracker');
                    } catch (e) {
                        toastr['warning']('All prompts reset. Quick Prompt "Main" textarea not found and clipboard copy failed. Use the SYSPROMPT button to copy manually.', 'RPG Tracker');
                    } finally {
                        document.body.removeChild(ta);
                    }
                }
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
                SillyTavern.getContext().saveSettingsDebounced();
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
                <div style="display: flex; flex-direction: column; gap: 4px; align-items: center; justify-content: flex-end;">
                    <div class="rt-prompt-ctx-control" style="font-size: 9px; display: flex; flex-direction: column; align-items: center; gap: 0;" title="Context: number of recent messages to include">
                        <input type="number" id="rt-prompt-context-val" value="${settings.directPromptContext || 5}" min="0" max="50" style="width: 28px; height: 16px; font-size: 9px; background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.1); color: white; border-radius: 3px; text-align: center; padding: 0;">
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
                <div class="flex-container gap-1 alignitemscenter rt-rng-footer-group">
                    <button id="rt-rng-toggle-overlay" class="rt-rng-toggle-overlay" title="Toggle RNG Queue Injection">
                        <i class="fa-solid fa-dice"></i> <span class="rt-rng-label-text">RNG Queue: </span><span id="rt-rng-status-text" class="rt-rng-status-text">OFF</span>
                    </button>
                    <button id="rt-dice-tool-toggle" class="rt-rng-toggle-overlay" title="Toggle Tool Call RNG">
                        <i class="fa-solid fa-robot"></i> <span class="rt-rng-label-text">Tool Call RNG: </span><span id="rt-dice-tool-status-text" class="rt-rng-status-text">OFF</span>
                    </button>
                </div>
                <div class="flex-container gap-1 alignitemscenter rt-utility-footer-group">
                    <span id="rpg-tracker-count">~${Math.round(settings.currentMemo.length / 2.62)} tokens</span>
                    <button class="rpg-tracker-nav-btn" id="rpg-tracker-memo-clear" style="padding: 1px 5px; font-size: 9px; opacity: 0.8; margin-left: 5px;" title="Clear memo and history">CLEAR</button>
                    <div style="position: relative; display: flex; align-items: center;">
                        <div id="rt-sysprompt-menu" class="rt-sysprompt-menu" style="display: none;">
                             <button class="rt-sysprompt-opt" data-file="sysprompt.txt">Tool Call + Queue (recommended)</button>
                             <button class="rt-sysprompt-opt" data-file="sysprompt_legacy.txt">Queue Only</button>
                             <hr style="margin: 2px 0; border: none; border-top: 1px solid rgba(255,255,255,0.05);">
                             <button class="rt-sysprompt-opt" id="rt-sysprompt-help-btn">What are these?</button>
                         </div>
                         <button class="rpg-tracker-nav-btn" id="rt-copy-sysprompt" style="padding: 1px 5px; font-size: 9px; opacity: 0.8; margin-left: 5px;" title="Copy Narrator System Prompt">SYSPROMPT</button>
                     </div>
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
                const { stopGeneration } = SillyTavern.getContext();
                if (stopGeneration) stopGeneration();
            });
        }

        const pauseBtn = panel.querySelector('#rpg-tracker-pause-btn');
        if (pauseBtn) {
            pauseBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const s = getSettings();
                // Pause button only toggles the paused state, not the enabled state
                s.paused = !s.paused;
                SillyTavern.getContext().saveSettingsDebounced();
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

                    // Only show conflict if BOTH have content and they are DIFFERENT
                    if (savedContent && liveContent && liveContent !== savedContent) {
                        const body = `
                            <div style="text-align: left;">
                                <p><b>Conflict Detected:</b> This chat has a saved tracker state, but your current (Global) tracker is not empty.</p>
                                <p style="font-size: 0.9em; opacity: 0.8; margin-top: 10px;">
                                    <b>RESTORE:</b> Use the chat's saved state. (Global work is moved to history)<br>
                                    <b>OVERWRITE:</b> Keep current work and save it to this chat. (Old chat data is moved to history)
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
                SillyTavern.getContext().saveSettingsDebounced();
                updateChatLinkUI();
            });
        }

        updateChatLinkUI();
        updatePanelStatus();

        // Handle manual edits to live memo
        const textarea = panel.querySelector('#rpg-tracker-memo');
        let _rawEditDebounce = null;
        textarea.addEventListener('input', (e) => {
            if (_historyViewIndex !== -1) return;
            settings.currentMemo = /** @type {HTMLTextAreaElement} */ (e.target).value;
            panel.querySelector('#rpg-tracker-count').textContent = `~${Math.round(settings.currentMemo.length / 2.62)} tokens`;
            SillyTavern.getContext().saveSettingsDebounced();
            // Refresh the rendered view live so changes are visible without toggling modes
            clearTimeout(_rawEditDebounce);
            _rawEditDebounce = setTimeout(refreshRenderedView, 400);
        });

        // ── RNG & Dice Toggle Logic ──
        const rngBtn = panel.querySelector('#rt-rng-toggle-overlay');
        const diceToolBtn = panel.querySelector('#rt-dice-tool-toggle');

        const syncFooterToggles = () => {
            const s = getSettings();

            // Sync RNG Engine
            const rngText = panel.querySelector('#rt-rng-status-text');
            if (rngText) rngText.textContent = s.rngEnabled ? 'ON' : 'OFF';
            if (rngBtn) {
                if (s.rngEnabled) rngBtn.classList.add('active');
                else rngBtn.classList.remove('active');
            }
            const rngCb = document.getElementById('rpg_tracker_rng_enabled');
            if (rngCb) /** @type {HTMLInputElement} */ (rngCb).checked = s.rngEnabled;

            // Sync AI Dice Tool
            const diceText = panel.querySelector('#rt-dice-tool-status-text');
            if (diceText) diceText.textContent = s.diceFunctionTool ? 'ON' : 'OFF';
            if (diceToolBtn) {
                if (s.diceFunctionTool) diceToolBtn.classList.add('active');
                else diceToolBtn.classList.remove('active');
            }
            const diceCb = document.getElementById('rpg_tracker_dice_function_tool');
            if (diceCb) /** @type {HTMLInputElement} */ (diceCb).checked = s.diceFunctionTool;
        };

        if (rngBtn) {
            rngBtn.addEventListener('click', () => {
                const s = getSettings();
                s.rngEnabled = !s.rngEnabled;
                SillyTavern.getContext().saveSettingsDebounced();
                syncFooterToggles();
                toastr['info'](`RNG Queue ${s.rngEnabled ? 'Enabled' : 'Disabled'}.`, 'Fatbody Framework');
            });
        }

        if (diceToolBtn) {
            diceToolBtn.addEventListener('click', () => {
                const s = getSettings();
                s.diceFunctionTool = !s.diceFunctionTool;
                SillyTavern.getContext().saveSettingsDebounced();
                syncFooterToggles();
                registerDiceFunctionTool();
                toastr['info'](`Tool Call RNG ${s.diceFunctionTool ? 'Enabled' : 'Disabled'}.`, 'Fatbody Framework');
            });
        }

        syncFooterToggles();

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
            settings.closeCount = (settings.closeCount || 0) + 1;
            // Only show toast on the 1st close and every 10th close thereafter
            if (settings.closeCount === 1 || settings.closeCount % 10 === 0) {
                toastr['info']('Tracker hidden. You can reopen it at any time from the Extensions (Wand) Menu.', 'RPG Tracker');
            }
            SillyTavern.getContext().saveSettingsDebounced();
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
            SillyTavern.getContext().saveSettingsDebounced();
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
        const syspromptMenu = /** @type {HTMLElement} */ (panel.querySelector('#rt-sysprompt-menu'));
        const syspromptBtn = /** @type {HTMLElement} */ (panel.querySelector('#rt-copy-sysprompt'));

        syspromptBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const isVisible = syspromptMenu.style.display === 'flex';
            syspromptMenu.style.display = isVisible ? 'none' : 'flex';
        });

        panel.querySelectorAll('.rt-sysprompt-opt').forEach(opt => {
            opt.addEventListener('click', async (e) => {
                const fileName = /** @type {HTMLElement} */ (e.currentTarget).getAttribute('data-file');
                
                if (!fileName) {
                    // This is the "What are these?" button
                    const { Popup } = SillyTavern.getContext();
                    const helpContent = `
                        <div style="text-align: left; line-height: 1.4; max-height: 70vh; overflow-y: auto; padding-right: 5px;">
                            <h4 style="margin-top: 0; color: var(--rt-accent);">RNG Queue (Combat)</h4>
                            <p>Generates a list of pre-rolled dice and injects them into the story context. This keeps combat fast and fluid because the AI doesn't need to stop for a tool call on every attack—it just uses the next roll in the queue.</p>
                            <p>Functions perfectly in combat because combat works on a "grid" determined by initiative, taking any opportunity of mechanical sycophancy away from the AI.</p>

                            <h4 style="color: var(--rt-accent);">Tool Call RNG (Narrative)</h4>
                            <p>A reactive tool call where the AI proactively asks to roll specific dice for a specific action (e.g., picking a lock). This prevents "cheating" by forcing the AI to commit to a difficulty (DC) before seeing the roll result.</p>
                            <p style="background: rgba(255, 165, 0, 0.1); border-left: 3px solid orange; padding: 10px; font-size: 11px; color: #eee; border-radius: 0 4px 4px 0;">
                                <b>NOTE:</b> "Enable function calling" <b>must</b> be enabled in SillyTavern's <b>AI Response Configuration</b> for tool calls to work.
                            </p>

                            <h4 style="color: var(--rt-accent);">System Prompt Selection</h4>
                            <p>Choose the system prompt that matches your selected RNG method:</p>
                            <ul style="padding-left: 20px;">
                                <li style="margin-bottom: 8px;"><b>Tool Call + Queue</b>: The modern hybrid system (recommended). Mandatory for the Tool Call RNG toggle to function.</li>
                                <li><b>Queue Only</b>: The legacy behavior. Ideal if your model doesn't support tool calling or if you prefer the classic "always-in-context" RNG.</li>
                            </ul>
                        </div>
                    `;
                    Popup.show.confirm('RNG Systems Explained', helpContent, { okButton: 'OK', cancelButton: false });
                    syspromptMenu.style.display = 'none';
                    return;
                }

                let content;

                // Attempt to fetch the live file from disk first
                try {
                    const response = await fetch(`/scripts/extensions/third-party/SillyTavern-FatbodyDnDFramework/${fileName}`);
                    if (response.ok) {
                        content = await response.text();
                        console.log(`[Fatbody Framework] Loaded ${fileName} from live file.`);
                    } else {
                        throw new Error(`Server returned ${response.status}`);
                    }
                } catch (err) {
                    console.warn(`[Fatbody Framework] Could not fetch ${fileName} from live file, using hardcoded fallback:`, err);
                    content = RT_PROMPTS[fileName];
                }

                if (!content) {
                    toastr['error'](`Prompt not found: ${fileName}`, "Fatbody Framework");
                    return;
                }

                // Use a hidden textarea fallback — works on HTTP (Termux) where navigator.clipboard is blocked
                const ta = document.createElement('textarea');
                ta.value = content;
                ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;';
                document.body.appendChild(ta);
                ta.focus();
                ta.select();
                try {
                    document.execCommand('copy');
                    const isLegacy = fileName === 'sysprompt_legacy.txt';
                    const msg = isLegacy 
                        ? `${fileName} copied to clipboard! Make sure to disable tool call RNG from the bottom of the UI.`
                        : `${fileName} copied to clipboard! Make sure to enable function calls in the completion preset!`;
                    toastr['success'](msg, "Fatbody Framework");
                    syspromptMenu.style.display = 'none';
                } catch (err) {
                    console.error("[Fatbody Framework] execCommand copy failed:", err);
                    toastr['error']('Could not copy to clipboard.', "Fatbody Framework");
                } finally {
                    document.body.removeChild(ta);
                }
            });
        });

        // Close menu when clicking outside
        window.addEventListener('click', (e) => {
            if (syspromptMenu && syspromptMenu.style.display === 'flex' && !syspromptMenu.contains(/** @type {Node} */(e.target)) && e.target !== syspromptBtn) {
                syspromptMenu.style.display = 'none';
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
            if (counter) counter.textContent = `~${Math.round(s.currentMemo.length / 2.62)} tokens`;
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
            if (counter) counter.textContent = `~${Math.round((snapshot ?? '').length / 2.62)} tokens`;
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

    /**
     * Top-Right corner resizer logic
     * @param {HTMLElement} panel 
     * @param {HTMLElement} handle 
     */
    function makeResizableTR(panel, handle) {
        let isResizing = false;
        let startX, startY, startWidth, startHeight, startTop, startLeft;

        handle.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return;
            isResizing = true;
            const rect = panel.getBoundingClientRect();
            startX = e.clientX;
            startY = e.clientY;
            startWidth = rect.width;
            startHeight = rect.height;
            startTop = rect.top;
            startLeft = rect.left;

            // Switch to absolute/fixed values before moving
            panel.style.left = startLeft + 'px';
            panel.style.top = startTop + 'px';
            panel.style.right = 'auto';
            panel.style.bottom = 'auto';

            e.preventDefault();
            e.stopPropagation();
        });

        document.addEventListener('mousemove', (e) => {
            if (!isResizing) return;
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;

            const newWidth = Math.max(220, startWidth + dx);
            const newHeight = Math.max(200, startHeight - dy);
            const newTop = startTop + dy;

            panel.style.width = newWidth + 'px';
            // Only apply height/top if we're above min-height to prevent jumping
            if (newHeight > 200) {
                panel.style.height = newHeight + 'px';
                panel.style.top = newTop + 'px';
            }
        });

        document.addEventListener('mouseup', () => {
            if (isResizing) {
                isResizing = false;
                savePanelGeometry(panel);
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

        iconEl.value     = field.icon  || '📄';
        tagEl.value      = field.tag   || '';
        labelEl.value    = field.label || '';
        templateEl.value = field.template || '';
        // Legacy cleanup: clear the old placeholder text if it's stored as a value
        if (field.prompt === 'What should the AI track for this new field? Describe it here.') {
            field.prompt = '';
        }
        promptEl.value   = field.prompt || '';

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
                renderView.innerHTML = renderMemoAsCards(fakeMemo, previewTag);
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
            SillyTavern.getContext().saveSettingsDebounced();
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
                SillyTavern.getContext().saveSettingsDebounced();
                refreshOrderList();
                refreshRenderedView();
            }
        };

        const close = () => overlay.remove();
        document.getElementById('rt_cfe_save').onclick   = save;
        document.getElementById('rt_cfe_delete').onclick = del;
        document.getElementById('rt_cfe_cancel').onclick = close;
        document.getElementById('rt_cfe_close').onclick  = close;
        document.getElementById('rt_cfe_export').onclick = () => exportModules([field]);
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

        SillyTavern.getContext().saveSettingsDebounced();
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

    /*
    /**
     * Assembles the sysprompt from rawText, stripping XML sections that are
     * disabled in settings.syspromptModules.
     * Only sections explicitly set to false are removed.
     * @param {string} rawText
     * @returns {string}
     * /
    function buildSysprompt(rawText) {
        if (!rawText) return "";
        const mods = getSettings().syspromptModules || {};
        return rawText
            .replace(/<(\w[\w_-]*)>([\s\S]*?)<\/\1>/g, (match, tag) => {
                // Only remove if the toggle is explicitly set to false
                if (mods[tag] === false) return "";
                return match;
            })
            .replace(/\n{3,}/g, "\n\n")
            .trim();
    }
    */

    /**
     * Initialization
     */
    (async function init() {
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

            const settings = getSettings();

            $('#rpg_tracker_enabled').prop('checked', settings.enabled).on('change', function () {
                settings.enabled = !!$(this).prop('checked');
                ctx.saveSettingsDebounced();
                updatePanelStatus();
            });

            $('#rpg_tracker_debug').prop('checked', settings.debugMode).on('change', function () {
                settings.debugMode = !!$(this).prop('checked');
                ctx.saveSettingsDebounced();
            });

            $('#rpg_tracker_legacy_dice').prop('checked', settings.legacyDiceNaming).on('change', function () {
                settings.legacyDiceNaming = !!$(this).prop('checked');
                ctx.saveSettingsDebounced();
                registerDiceFunctionTool();
                registerDiceSlashCommand();
                toastr['info']("Dice logic updated.", "RPG Tracker");
            });

            $('#rpg_tracker_dice_function_tool').prop('checked', settings.diceFunctionTool).on('change', function () {
                settings.diceFunctionTool = !!$(this).prop('checked');
                ctx.saveSettingsDebounced();
                registerDiceFunctionTool();
            });

            $('#rpg_tracker_chat_link_enabled').on('change', function () {
                const s = getSettings();
                const turningOn = !!$(this).prop('checked');
                
                // If we're turning it on from the settings menu, just simulate the button click logic
                // but keep it simple here. The panel button is the primary toggle.
                s.chatLinkEnabled = turningOn;
                ctx.saveSettingsDebounced();
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
                    ctx.saveSettingsDebounced();
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
            registerDiceFunctionTool();
            registerDiceSlashCommand();

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
                ctx.saveSettingsDebounced();
            });
            updateConnectionPanels();

            // Ollama
            $('#rpg_tracker_ollama_url').val(settings.ollamaUrl).on('input', function () {
                settings.ollamaUrl = $(this).val();
                ctx.saveSettingsDebounced();
            });
            const ollamaModelSelect = $('#rpg_tracker_ollama_model');
            ollamaModelSelect.val(settings.ollamaModel).on('change', function () {
                settings.ollamaModel = $(this).val();
                ctx.saveSettingsDebounced();
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
                ctx.saveSettingsDebounced();
            });
            $('#rpg_tracker_openai_key').val(settings.openaiKey).on('input', function () {
                settings.openaiKey = $(this).val();
                ctx.saveSettingsDebounced();
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
                ctx.saveSettingsDebounced();
            });
            openaiModelManual.on('input', function () {
                const manual = String($(this).val() || '').trim();
                if (manual) {
                    // Manual overrides dropdown — deselect it visually
                    openaiModelSelect.val('');
                }
                settings.openaiModel = manual || openaiModelSelect.val() || '';
                ctx.saveSettingsDebounced();
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
                ctx.saveSettingsDebounced();
            });

            // Advanced Options
            const lookbackInput = $('#rpg_tracker_lookback_messages');
            if (lookbackInput.length) {
                lookbackInput.val(settings.lookbackMessages !== undefined ? settings.lookbackMessages : 2).on('input', function () {
                    settings.lookbackMessages = parseInt(/** @type {string} */($(this).val())) || 2;
                    ctx.saveSettingsDebounced();
                });
            }
            const historyCountInput = $('#rpg_tracker_history_count');
            if (historyCountInput.length) {
                historyCountInput.val(settings.trackerHistoryCount !== undefined ? settings.trackerHistoryCount : 1).on('input', function () {
                    settings.trackerHistoryCount = parseInt(/** @type {string} */($(this).val())) || 1;
                    ctx.saveSettingsDebounced();
                });
            }

            // ── Lorebook Context UI ──
            async function refreshLorebookList() {
                const $container = $('#rpg_tracker_lorebook_list');
                $container.empty();
                const stCtx = SillyTavern.getContext();
                let worldNames = [];
                try {
                    worldNames = await stCtx.getWorldInfoNames() ?? [];
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
                        ctx.saveSettingsDebounced();
                    });
                    $container.append($item);
                });
            }

            $('#rpg_tracker_ctx_worldinfo').prop('checked', settings.ctxWorldInfo ?? false).on('change', async function () {
                settings.ctxWorldInfo = !!$(this).prop('checked');
                if (settings.ctxWorldInfo) await refreshLorebookList();
                $('#rpg_tracker_lorebook_filter_group').toggle(settings.ctxWorldInfo);
                ctx.saveSettingsDebounced();
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
                ctx.saveSettingsDebounced();
                showHideWizard(newTheme);
                const panel = document.getElementById('rpg-tracker-panel');
                if (panel) {
                    panel.className = `rpg-tracker-panel ${newTheme}`;
                    if (!settings.enabled) panel.classList.add('is-disabled');
                }
                document.querySelectorAll('.rpg-tracker-detached-panel').forEach(dp => {
                    dp.className = `rpg-tracker-panel rpg-tracker-detached-panel ${newTheme}`;
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
                    SillyTavern.getContext().saveSettingsDebounced();
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
                ctx.saveSettingsDebounced();
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
            fontSizeInput.val(settings.fontSize || 13).on('input', function() {
                const val = parseInt(String($(this).val()));
                if (isNaN(val) || val < 8 || val > 32) return;
                settings.fontSize = val;
                ctx.saveSettingsDebounced();
                updateTrackerFontSize(val);
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
                    prompt: '',
                    template: EXAMPLES + '\n\n' + COLOR_EXAMPLES,
                    enabled: true
                });
                refreshOrderList();
                ctx.saveSettingsDebounced();
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

                    SillyTavern.getContext().saveSettingsDebounced();
                    refreshOrderList();
                    syncMemoView();
                    toastr['success']('All custom modules deleted.', 'RPG Tracker');
                }
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
                if (!confirm('This will reset the Module Prompts, Active Modules, and Module Order to their factory defaults. Custom modules will be moved to the bottom of the list. Your Core Prompt will not be affected. Proceed?')) return;
                const { extensionSettings } = SillyTavern.getContext();
                delete extensionSettings[MODULE_NAME].stockPrompts;
                delete extensionSettings[MODULE_NAME].blockOrder;
                delete extensionSettings[MODULE_NAME].modules;
                refreshOrderList();
                ctx.saveSettingsDebounced();
                toastr['success']('Stock modules, order, and prompts reset to factory defaults.', 'RPG Tracker');
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
                refreshOrderList();
                ctx.saveSettingsDebounced();

                // 3. Fetch sysprompt.txt and apply to ST Quick Prompt "Main"
                const fileName = 'sysprompt.txt';
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
                    // content = typeof buildSysprompt === 'function' ? buildSysprompt(content) : content;
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

            $('#rpg_tracker_btn_update').on('click', async function () {
                const { chat } = SillyTavern.getContext();
                if (!chat || chat.length === 0) return toastr['info']("No chat history found.", "RPG Tracker");

                /*
                // ── Sysprompt Section Toggles ──
                const _syspromptModDefs = [
                    { key: 'loot',          id: 'rpg_sysprompt_mod_loot' },
                    { key: 'random_events', id: 'rpg_sysprompt_mod_random_events' },
                    { key: 'resting',       id: 'rpg_sysprompt_mod_resting' },
                ];
                _syspromptModDefs.forEach(({ key, id }) => {
                    const s = getSettings();
                    const val = s.syspromptModules?.[key] ?? true;
                    $(`#${id}`).prop('checked', val).on('change', function () {
                        const fresh = getSettings();
                        if (!fresh.syspromptModules) fresh.syspromptModules = {};
                        fresh.syspromptModules[key] = !!$(this).prop('checked');
                        ctx.saveSettingsDebounced();
                    });
                });

                $('#rpg_tracker_btn_apply_sysprompt').on('click', async function () {
                    const fileName = 'sysprompt.txt';
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
                        toastr['error']('Could not load sysprompt.txt.', 'RPG Tracker');
                        return;
                    }

                    if (typeof buildSysprompt === 'function') content = buildSysprompt(content);

                    const mainTextarea = (document.getElementById('main_prompt_quick_edit_textarea'));
                    if (mainTextarea) {
                        mainTextarea.value = content;
                        mainTextarea.dispatchEvent(new Event('blur', { bubbles: true }));
                        toastr['success']('Main sysprompt applied! \u2705', 'RPG Tracker');
                    } else {
                        try {
                            await navigator.clipboard.writeText(content);
                            toastr['warning']('Quick Prompt "Main" textarea not found. Sysprompt copied to clipboard. Make sure to enable function calls in the completion preset! \u2705', 'RPG Tracker');
                        } catch (e) {
                            toastr['warning']('Quick Prompt "Main" textarea not found and clipboard copy failed.', 'RPG Tracker');
                        }
                    }
                });
                */

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

