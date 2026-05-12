import { getSettings, getBarBackground } from './state-manager.js';
import { escapeHtml, highlightParens, parseInWorldTime, formatTimeDiff } from './memo-processor.js';
import { BLOCK_ICONS, BLOCK_ORDER, PAGE_SIZE, NO_PAGINATE } from './constants.js';

// ── Renderer module: pure HTML string producers, localStorage helpers ──
// No live DOM mutations. All functions return strings or void (localStorage).

const DEFAULT_HP_COLOR = '#00ffaa';
const DEFAULT_XP_COLOR = 'linear-gradient(90deg, #0088ff, #00d4ff)';

    export const STOCK_FIELD_RULES = {
        'attr': 'text',
        'attributes': 'text',
        'skills': 'pills',
        'key skills': 'pills',
        'saves': 'highlight',
        'status': 'pills',
        'traits': 'pills',
        'other': 'pills',
        'resistances': 'pills',
        'res': 'pills',
        'hd': 'hd_pips',
        'weapon': 'highlight',
        'att/def': 'highlight',
        'primary weapon': 'highlight',
        'spells': 'spell_group',
        'ac': 'text'
    };

    export function renderSubFieldByRule(rule, line, barId = null) {
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
                    let barBg = rule.color ? rule.color : DEFAULT_XP_COLOR;
                    if (barId) barBg = getBarBackground(barId, barBg, pct);

                    const recolorData = barId ? ` data-recolor-id="${escapeHtml(barId)}" data-recolor-current="${escapeHtml(barBg)}" title="Click to recolor"` : '';

                    return `<div class="rt-entity-sub-line" style="gap:6px;">
                        ${labelHtml}
                        <div class="rt-xp-bar-wrap"${recolorData} style="flex:1; height:12px;">
                            <div class="rt-xp-bar" style="width:${pct.toFixed(1)}%; background:${barBg};"></div>
                        </div>
                        <span style="font-size:0.82em; opacity:0.85; white-space:nowrap;">${levelStr}${xm[1]}/${xm[2]}</span>
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

    export function renderHDPips(val) {
        let pipsHtml = escapeHtmlWithColor(val);
        const hm = val.match(/^([^(]+?)\s*(?:\(([\d,]+)\/([\d,]+)\))?$/);
        if (hm && hm[2] && hm[3]) {
            const cur = parseInt(hm[2].replace(/,/g, ''), 10);
            const max = parseInt(hm[3].replace(/,/g, ''), 10);
            pipsHtml = `<span class="rt-hd-label">[ ${escapeHtmlWithColor(hm[1].trim())} ]</span> <span class="rt-hd-pips">${Array.from({ length: max }, (_, i) => `<span class="rt-hd-pip${i < cur ? ' rt-hd-available' : ''}"></span>`).join('')}</span>`;
        }
        return `<div class="rt-entity-sub-line"><span class="rt-entity-sub-label">HD:</span> <span>${pipsHtml}</span></div>`;
    }

    export function renderSpellGroups(val) {
        const isCompound = /\|/.test(val) && /(?:Level\s*\d+|Cantrips?)/i.test(val);
        const groups = isCompound ? val.split(/\s*\|\s*/) : [val];
        let html = '';
        for (const group of groups) {
            const m = group.trim().match(/^(Level\s*\d+|Cantrips?)\s*(?:\((\d+)\/(\d+)[^)]*\))?\s*(?::\s*(.+))?$/i);
            if (!m) continue;
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
                spellsHtml = spellList.split(',').map(s => {
                    const name = s.trim();
                    const slug = name.toLowerCase().replace(/'/g, '').replace(/[^a-z0-9]+/g, '-');
                    return `<a href="https://dnd5e.wikidot.com/spell:${slug}" target="_blank" class="rt-spell-name" title="View spell on Wikidot">${escapeHtmlWithColor(name)}</a>`;
                }).join('');
            }
            html += `<div class="rt-spell-row"><span class="rt-spell-level">${escapeHtmlWithColor(lbl.trim())}</span><div class="rt-spell-inline-group"><div class="rt-spell-list">${pipsHtml}${spellsHtml}</div></div></div>`;
        }
        return html || `<div class="rt-entity-sub-line"><span class="rt-entity-sub-label">Spells:</span> ${highlightParens(escapeHtmlWithColor(val))}</div>`;
    }


    /**
     * If `line` begins with a ((MARKER)) prefix, renders it and returns HTML.
     * Returns null if no marker is present, so callers can fall through to
     * their own renderer. This makes markers work in ALL stock blocks.
     */
    export function tryRenderMarker(line, tag = '', entityName = '') {
        const m = line.match(/^\(\((PILLS|BAR|HPBAR|XPBAR|TEXT|BADGE|HIGHLIGHT|PLS|B|HPB|XB|HGT|BDG|HP)\)\)\s*(.*)$/i);
        if (!m) return null;
        const typeMap = {
            PILLS:'pills', PLS:'pills',
            BAR:'hp_bar', B:'hp_bar',
            HPBAR:'hp_bar', HPB:'hp_bar',
            HP: 'hp_bar',
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

    export function renderLineInEntityContext(tag, line, entityName, rawLine) {
        // 1. Try marker first
        const asMarker = tryRenderMarker(rawLine, tag, entityName);
        if (asMarker) return asMarker;

        const ll = line.toLowerCase();
        const colonIdx = line.indexOf(':');

        // 2. Try known stock keywords
        for (const [key, ruleType] of Object.entries(STOCK_FIELD_RULES)) {
            if (ll.startsWith(key + ':') || ll === key) {
                const val = colonIdx !== -1 ? line.substring(colonIdx + 1).trim() : '';
                if (ruleType === 'hd_pips') return renderHDPips(val);
                if (ruleType === 'spell_group') return renderSpellGroups(val);
                return renderSubFieldByRule({ renderType: ruleType }, line);
            }
        }

        // 3. Fallback: unknown KV pair or plain line (always attached to entity if we are here)
        if (colonIdx !== -1) {
            return renderSubFieldByRule({ renderType: 'highlight' }, line);
        }
        return `<div class="rt-entity-sub-line">${escapeHtmlWithColor(line)}</div>`;
    }

    /**
     * Renders a single line from a custom block (non-built-in tag).
     */
    export function renderCustomBlockLine(tag, line, lineIdx = 0) {
        const asMarker = tryRenderMarker(line, tag);
        if (asMarker !== null) return asMarker;

        // Plain kv fallback
        const kv = line.match(/^([^:]+):\s*(.+)$/);
        if (kv) return `<div class="rt-card-kv"><span class="rt-card-key">${escapeHtmlWithColor(kv[1].trim())}:</span><span class="rt-card-val">${escapeHtmlWithColor(kv[2].trim())}</span></div>`;
        return `<div class="rt-card-item">${escapeHtmlWithColor(line.trim())}</div>`;
    }

    /**
     * Strip HTML tags from a memo string, preserving inner text.
     * Used before sending the memo to the AI to avoid token bloat from
     * color markup (<font>, <span>, etc.) that is purely for display.
     * NOTE: ((MARKERS)) like ((PILLS)), ((BAR)), etc. are intentionally
     * preserved so the AI can faithfully echo them back in its output.
     */
    export function stripMemoHtml(text) {
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
    export function escapeHtmlWithColor(str) {
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
    export function parseMemoBlocks(memo) {
        const blocks = {};
        const pattern = /\[([^\]\/][^\]]*)\]([\s\S]*?)\[\/\1\]/gi;
        for (const [, tag, content] of memo.matchAll(pattern)) {
            blocks[tag.trim().toUpperCase()] = content.trim();
        }
        return blocks;
    }

    const COLLAPSE_KEY = 'rpg_tracker_collapsed';
    const DETACHED_KEY = 'rpg_tracker_detached';



    export function getPageSize(tag) {
        const s = getSettings();
        if (s.modulePageSizes && s.modulePageSizes[tag]) {
            return s.modulePageSizes[tag];
        }
        // Fallback to stock defaults
        return tag === 'SPELLS' ? 5 : PAGE_SIZE;
    }

    export function loadCollapsed() {
        try { return new Set(JSON.parse(localStorage.getItem(COLLAPSE_KEY) || '[]')); }
        catch { return new Set(); }
    }
    export function saveCollapsed(set) {
        localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...set]));
    }

    export function loadDetached() {
        try { return new Set(JSON.parse(localStorage.getItem(DETACHED_KEY) || '[]')); }
        catch { return new Set(); }
    }
    export function saveDetached(set) {
        localStorage.setItem(DETACHED_KEY, JSON.stringify([...set]));
    }



    export function blockToItems(tag, content, renderTypeOverride = null) {
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

                const MARKER_RX = /^\(\((PILLS|BAR|XPBAR|TEXT|BADGE|HIGHLIGHT|HPBAR|PLS|B|XB|HGT|HPB|BDG|HP)\)\)\s*(.*)/i;
                const MARKER_TYPE_MAP = {
                    'PILLS': 'pills', 'PLS': 'pills',
                    'BAR': 'hp_bar', 'B': 'hp_bar',
                    'HPBAR': 'hp_bar', 'HPB': 'hp_bar',
                    'HP': 'hp_bar',
                    'XPBAR': 'xp_bar', 'XB': 'xp_bar',
                    'TEXT': 'text',
                    'BADGE': 'badge', 'BDG': 'badge',
                    'HIGHLIGHT': 'highlight', 'HGT': 'highlight'
                };

                for (let i = 0; i < lines.length; i++) {
                    const rawLine = lines[i];
                    const mm = rawLine.match(MARKER_RX);
                    const markerCode = mm ? mm[1].toUpperCase() : null;
                    const explicitType = mm ? MARKER_TYPE_MAP[markerCode] : null;
                    const line = mm ? mm[2].trim() : rawLine;

                    // 1. Combat Round header
                    if (tag === 'COMBAT' && /Combat Round\s*\d+/i.test(line)) {
                        results.push(`<div class="rt-combat-round">${escapeHtmlWithColor(line)}</div>`);
                        lastEntityIdx = -1;
                        continue;
                    }

                    // 2. Entity anchor: classic "Name: X/Y HP ..." or explicit ((HP)) marker
                    let hpMatch = line.match(/^(.+?):\s*([\d,]+)(?:\/([\d,]+))?\s*HP\s*[:|,]?\s*(.*)$/i);
                    const isHpMarker = (markerCode === 'HP' || markerCode === 'HPB' || markerCode === 'HPBAR');

                    // If marker is specifically ((HP)), try a more relaxed regex (optional HP suffix)
                    if (!hpMatch && isHpMarker) {
                        hpMatch = line.match(/^(.+?):\s*([\d,]+)(?:\/([\d,]+))?(?:\s*HP)?\s*[:|,]?\s*(.*)$/i);
                    }

                    if (hpMatch) {
                        const [, name, curRaw, maxRaw, rest] = hpMatch;
                        const cur = Number(curRaw.replace(/,/g, ''));
                        const max = maxRaw ? Number(maxRaw.replace(/,/g, '')) : undefined;
                        const hasMax = max !== undefined;
                        const pct = hasMax ? Math.max(0, Math.min(100, (cur / max) * 100)) : 100;
                        const hpColor = !hasMax ? DEFAULT_HP_COLOR : pct > 60 ? DEFAULT_HP_COLOR : pct > 30 ? '#ffaa00' : '#ff5555';
                        const status = (rest || '').trim().replace(/^\|\s*/, '');
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

                    // 3. Sub-field Logic (Sticky Context)
                    if (lastEntityIdx !== -1) {
                        results[lastEntityIdx] += renderLineInEntityContext(tag, line, currentEntity, rawLine);
                    } else {
                        // No active entity: render as a standalone card line
                        results.push(`<div class="rt-card-item">${escapeHtmlWithColor(rawLine)}</div>`);
                    }
                }
                return results;
            }

            case 'TIME': {
                let currentTotalMins = 0;
                let parsedCurrent = false;

                // parseTimeStr removed, using shared parseInWorldTime from memo-processor.js


                for (let line of lines) {
                    if (line.toLowerCase().startsWith('last rest:')) continue;
                    if (!parsedCurrent) {
                        const t = parseInWorldTime(line);
                        if (t !== 0) {
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
                                const restMins = parseInWorldTime(restVal);
                                if (restMins !== null) {
                                    const diff = currentTotalMins - restMins;
                                    if (diff >= 0) {
                                        append = `&nbsp;<span style="opacity: 0.7; font-size: 1em;">(${formatTimeDiff(diff, false)})</span>`;
                                    }
                                }
                            }
                            return `<div class="rt-card-item"><b>Last Rest:</b>&nbsp;${escapeHtmlWithColor(restVal)}${append}</div>`;
                        }
                        const asMarker = tryRenderMarker(line, tag);
                        if (asMarker !== null) return asMarker;
                        return `<div class="rt-card-item">${escapeHtmlWithColor(line)}</div>`;
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

                    return `<div class="rt-card-item">${escapeHtmlWithColor(line)}</div>`;
                });
            case 'SPELLS': {
                // Lines: "Level N (avail/max): Spell1, Spell2" or "Cantrips: Spell1, Spell2"
                return lines.map(line => {
                    const asMarker = tryRenderMarker(line, tag);
                    if (asMarker !== null) return asMarker;

                    const m = line.match(/^(Level\s*\d+|Cantrips?)\s*(?:\((\d+)\/(\d+)[^)]*\))?\s*:\s*(.+)$/i);
                    if (!m) return `<div class="rt-card-item">${escapeHtmlWithColor(line)}</div>`;
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
                        <div class="rt-spell-inline-group">
                            <div class="rt-spell-list">${pipsHtml}${spells}</div>
                        </div>
                    </div>`;
                });
            }
            case 'INVENTORY': {
                // Lines with a ((MARKER)) prefix bypass the bullet-list renderer
                const inventoryResults = [];
                const pendingBullets = [];

                const flushBullets = () => {
                    if (!pendingBullets.length) return;
                    pendingBullets.forEach(i => inventoryResults.push(`<div class="rt-card-item">${escapeHtmlWithColor(i)}</div>`));
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

    export function renderMemoAsCards(memo, filterTag, sectionPages) {
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
                    <button class="rt-random-char-btn" data-archetype="persona">🎭 Persona</button>
                </div>

                <div style="font-size: 13px; opacity: 0.9; display: flex; flex-direction: column; gap: 8px; flex-shrink: 0; line-height: 1.4;">
                    <div><b style="color: var(--rt-accent);">Auto-Tracking:</b> As you roleplay, the extension intelligently parses assistant responses. It detects losses of HP, new loot, or combat triggers, running background passes to update the state.</div>

                    <div><b style="color: var(--rt-accent);">Prompt Injection:</b> The State Memo and RNG Queue are injected seamlessly into your outgoing prompt. It acts as the "source of truth," assuring the model accurately remembers HP, inventory, and mechanical outcomes.</div>

                    <div><b style="color: var(--rt-accent);">Validation:</b> Use the Delta Log (δ) to verify changes. If the AI ever makes a mistake, step backwards using the Snapshot Navigation (←/→) to restore a clean state. A capable model like Gemini 3 Flash should almost never make a mistake, so you probably will not need the Delta Log often — but it is there when you want it.</div>

                    <div><b style="color: var(--rt-accent);">Lorebook Agent &#x1F916;:</b> Open it from the robot button in the header. It autonomously manages your lorebook — creating, updating, activating, deactivating, and deleting entries as your story evolves. Click <b>?</b> inside the agent panel for full documentation.</div>
                </div>

                <!-- Narrator Configuration (Salad Bar) -->
                <div style="margin-top: 12px; border: 1px solid rgba(255,255,255,0.12); border-radius: 6px; padding: 10px; background: rgba(255,255,255,0.03); width: 100%; box-sizing: border-box;">
                    <b style="color: var(--rt-accent); font-size: 14px; display: block; margin-bottom: 6px;">Narrator Configuration</b>
                    <small style="display: block; margin-bottom: 8px; opacity: 0.65; font-style: italic; line-height: 1.3;">Select your preferred modes and components. Changes apply to your system prompt automatically (unless Custom Sysprompt Mode is on).</small>
                    
                    <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 4px; border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom: 4px;">
                        <span style="font-size: 0.85em; font-weight: bold; opacity: 0.8;">RNG</span>
                        <button class="rt-rng-help-icon" style="background: none; border: 1px solid rgba(255,255,255,0.2); border-radius: 4px; color: inherit; font-size: 0.72em; opacity: 0.7; padding: 1px 7px; cursor: pointer;" title="Open RNG systems explanation">What are these?</button>
                    </div>
                    <div style="display: flex; flex-direction: column; gap: 4px; margin-bottom: 12px; padding-left: 5px;">
                        <label style="display: flex; align-items: center; gap: 8px; cursor: pointer;">
                            <input type="radio" name="rt_onboarding_rng_mode" value="hybrid" id="rt_onboarding_rng_hybrid" />
                            <span>Hybrid RNG (Pre-Seeded and Tool Calls)</span>
                        </label>
                        <label style="display: flex; align-items: center; gap: 8px; cursor: pointer;">
                            <input type="radio" name="rt_onboarding_rng_mode" value="legacy" id="rt_onboarding_rng_legacy" />
                            <span>Legacy RNG (Pre-Seeded Only)</span>
                        </label>
                    </div>

                    <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 4px; border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom: 2px;">
                        <span style="font-size: 0.85em; font-weight: bold; opacity: 0.8;">Quests (Experimental, could be buggy)</span>
                        <button class="rt-quests-hardcore-help" style="background: none; border: 1px solid rgba(255,255,255,0.2); border-radius: 4px; color: inherit; font-size: 0.72em; opacity: 0.7; padding: 1px 7px; cursor: pointer;" title="Explain hardcore quest mechanics">What are these?</button>
                    </div>
                    <div style="display: flex; flex-direction: column; gap: 4px; margin-bottom: 12px; padding-left: 5px;">
                        <label style="display: flex; align-items: center; gap: 8px; cursor: pointer;">
                            <input type="checkbox" id="rt_onboarding_quests_enabled" />
                            <span>Enable Quests</span>
                        </label>
                        <div id="rt_onboarding_quest_options" style="padding-left: 20px; display: none; flex-direction: column; gap: 4px;">
                            <div style="margin-top: 4px; border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom: 2px;">
                                <span style="font-size: 0.75em; opacity: 0.6; text-transform: uppercase; font-weight: bold;">Hardcore / Optional</span>
                            </div>
                            <label style="display: flex; align-items: center; gap: 8px; cursor: pointer;">
                                <input type="checkbox" id="rt_onboarding_quests_deadlines" />
                                <span>Deadlines</span>
                            </label>
                            <div id="rt_onboarding_quests_frustration_wrap" style="padding-left: 20px; display: none;">
                                <label style="display: flex; align-items: center; gap: 8px; cursor: pointer;">
                                    <input type="checkbox" id="rt_onboarding_quests_frustration" />
                                    <span style="opacity: 0.9;">↳ Frustration</span>
                                </label>
                            </div>
                            <label style="display: flex; align-items: center; gap: 8px; cursor: pointer;">
                                <input type="checkbox" id="rt_onboarding_quests_difficulty" />
                                <span>Difficulty</span>
                            </label>
                            <div style="margin-top: 4px; display: flex; flex-direction: column; gap: 4px;">
                                <div style="font-size: 0.75em; opacity: 0.6; text-transform: uppercase; font-weight: bold;">
                                    Processing Mode <i class="fa-solid fa-circle-question interactable" style="font-size: 0.9em; opacity: 0.7; margin-left: 4px;" title="Standard: AI manages quests via Tool Calls. Legacy: AI uses formatted text blocks."></i>
                                </div>
                                <label style="display: flex; align-items: center; gap: 8px; cursor: pointer;">
                                    <input type="radio" name="rt_onboarding_quest_mode" value="standard" id="rt_onboarding_quest_standard" />
                                    <span>Standard (Tool Calls)</span>
                                </label>
                                <label style="display: flex; align-items: center; gap: 8px; cursor: pointer;">
                                    <input type="radio" name="rt_onboarding_quest_mode" value="legacy" id="rt_onboarding_quest_legacy" />
                                    <span>Legacy (Without Tool Calls)</span>
                                </label>
                            </div>
                        </div>
                    </div>

                    <div style="font-size: 0.85em; font-weight: bold; opacity: 0.8; margin-bottom: 4px; border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom: 2px;">Optional Components</div>
                    <div style="display: flex; flex-direction: column; gap: 4px; margin-bottom: 12px; padding-left: 5px;">
                        <label style="display: flex; align-items: center; gap: 8px; cursor: pointer;">
                            <input type="checkbox" id="rt_onboarding_mod_loot" />
                            <span>🎲 Loot (Roll for Loot Quality)</span>
                        </label>
                        <label style="display: flex; align-items: center; gap: 8px; cursor: pointer;">
                            <input type="checkbox" id="rt_onboarding_mod_random_events" />
                            <span>🌍 Random Events (Rolls on time skips and travel)</span>
                        </label>
                        <label style="display: flex; align-items: center; gap: 8px; cursor: pointer;">
                            <input type="checkbox" id="rt_onboarding_mod_resting" />
                            <span>💤 Time-Limited Resting and interruption rolls based on location danger</span>
                        </label>
                    </div>

                    <label style="display: flex; align-items: center; gap: 8px; cursor: pointer; margin-top: 4px; padding-top: 8px; border-top: 1px solid rgba(255,255,255,0.1);">
                        <input type="checkbox" id="rt_onboarding_custom_sysprompt" />
                        <span style="font-size: 0.88em; opacity: 0.8;">Custom Sysprompt Mode — I'll manage my own system prompt</span>
                    </label>
                </div>

                <div style="font-size: 13px; opacity: 0.9; margin-top: 12px; flex-shrink: 0; line-height: 1.4; border-top: 1px solid rgba(255,255,255,0.1); padding-top: 12px;">
                    <b style="color: var(--rt-accent); font-size: 14px;">Initial Setup:</b><br><br>
                    1. Use the archetype buttons above to roll a new character, or <b>manually describe a character</b> by clicking 💬.<br><br>
                    2. Create a character card for your "narrator" (e.g. Game Master). <b>Leave the card fields empty</b>, as the framework handles all logic via the system prompt.<br><br>
                    3. Toggle the options above — the system prompt is <b>applied automatically</b> whenever you change a setting.
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
            if (tag === 'QUESTS') return ''; // Quest log has dedicated high-fidelity renderer, skip standard card
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
            const localPageSize = getPageSize(tag);

            const page = isFullView ? 0 : (sectionPages[tag] ?? 0);
            const totalPages = isFullView ? 1 : Math.ceil(items.length / localPageSize);
            const safePage = Math.min(page, Math.max(0, totalPages - 1));
            if (!isFullView) sectionPages[tag] = safePage;

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

            const renderOptions = getSettings().categoryRenderOptions?.[tag] || {};
            const catStyles = [];
            if (renderOptions.fontSize) catStyles.push(`--rt-cat-font-size: ${(renderOptions.fontSize / 13).toFixed(4)}em`);
            if (renderOptions.italic) catStyles.push(`--rt-cat-font-style: italic`);
            if (renderOptions.bold) catStyles.push(`--rt-cat-font-weight: bold`);
            if (renderOptions.bullets === false) catStyles.push(`--rt-cat-bullet-display: none`);
            if (renderOptions.bulletColor) catStyles.push(`--rt-cat-bullet-color: ${renderOptions.bulletColor}`);
            if (renderOptions.bulletStyle) catStyles.push(`--rt-cat-bullet-style: "${renderOptions.bulletStyle}"`);
            if (renderOptions.fontFamily) catStyles.push(`--rt-cat-font-family: ${renderOptions.fontFamily}`);
            if (renderOptions.textColor && renderOptions.textColor !== 'inherit') catStyles.push(`--rt-cat-text-color: ${renderOptions.textColor}`);
            const catStyleAttr = catStyles.length ? ` style='${catStyles.join('; ')}'` : '';

            return `<div class="rt-section-card${isCollapsed ? ' rt-collapsed' : ''}" data-tag="${tag}">
                <div class="rt-section-header" data-tag="${tag}">
                    <span>${icon} ${displayName}</span>
                    <div class="rt-section-header-right">
                        ${detachBtn}
                        ${fullViewBtn}
                        <button class="rt-category-settings-btn" data-tag="${tag}" title="Category Rendering Options">
                            <i class="fa-solid fa-cog"></i>
                        </button>
                        <span class="rt-item-count">${items.length} ${items.length === 1 ? 'entry' : 'entries'}</span>
                        <span class="rt-collapse-icon">${isCollapsed ? '&#9656;' : '&#9662;'}</span>
                    </div>
                </div>
                <div class="${bodyClass}"${catStyleAttr}>${pageItems.join('')}${pagination}</div>
            </div>`;
        }).join('');
    }

// ── Quest Log Renderer ─────────────────────────────────────────────────────

/**
 * Renders the quest log as a section card, matching the rt-section-card structure
 * so collapse/detach/reattach work identically to other blocks.
 * @param {object[]} quests
 * @param {string} currentTime  in-world time string e.g. "08:00 AM, Day 2"
 * @param {Set<string>} collapsed
 * @param {Set<string>} detached
 * @param {string|null} filterTag  if set, only render if tag === 'QUESTS'
 * @returns {string}
 */
export function renderQuestLog(quests, currentTime, collapsed, detached, filterTag = null) {
    const TAG = 'QUESTS';

    if (filterTag && filterTag !== TAG) return '';

    if (!filterTag && detached.has(TAG)) {
        return `<div class="rt-detached-placeholder" data-tag="${TAG}">
            <span class="rt-placeholder-icon">⧉</span> QUESTS is detached
            <button class="rt-reattach-btn-inline" data-tag="${TAG}" title="Re-attach">↓</button>
        </div>`;
    }

    const allQuests = quests || [];
    const isCollapsed = collapsed.has(TAG);
    const detachBtn = !filterTag ? `<button class="rt-detach-btn" data-tag="${TAG}" title="Detach panel">⧉</button>` : '';

    if (allQuests.length === 0) {
        return `<div class="rt-section-card${isCollapsed ? ' rt-collapsed' : ''}" data-tag="${TAG}">
            <div class="rt-section-header" data-tag="${TAG}">
                <span>📋 QUESTS</span>
                <div class="rt-section-header-right">
                    ${detachBtn}
                    <span class="rt-item-count">0 entries</span>
                    <span class="rt-collapse-icon">${isCollapsed ? '&#9656;' : '&#9662;'}</span>
                </div>
            </div>
            <div class="rt-section-body"><div class="rt-card-line" style="opacity:0.6;">No active quests.</div></div>
        </div>`;
    }

    const settings = getSettings();
    const showFrustration = !!settings.syspromptModules?.questsFrustration;
    const showDeadlines = !!settings.syspromptModules?.questsDeadlines;

    const renderQuestCard = (quest) => {

        const { getQuestMood } = /** @type {any} */ (globalThis.__rpgQuestUtils || {});
        const moodData = typeof getQuestMood === 'function' 
            ? getQuestMood(quest, currentTime, showFrustration) 
            : { label: 'Active', color: '#00cc77', value: 0 };

        const frust = moodData.value;
        const label = moodData.label;
        const barColor = moodData.color;

        // frust: -1 = very pleased/just accepted, 0 = neutral/halfway, 1 = frustrated at deadline, >1 = overdue
        // Map to a centered display: 50% = neutral, 0% = very pleased, 100% = max frustrated
        // Clamp display to [-1, 2] range (values beyond 2 are "off the chart")
        const displayFrust = Math.max(-1, Math.min(2, frust));
        const scale        = 100 / 3; // -1→0%, 0→33%, 1→67%, 2→100%
        const fillPct      = Math.round((displayFrust + 1) * scale);

        const barTitle = showFrustration 
            ? `NPC Mood: ${label} (${frust >= 0 ? '+' : ''}${frust.toFixed(2)})`
            : `Time Progress: ${label}`;

        // Tick mark at the neutral position (33%) and deadline position (67%)
        const moodBarHtml = `
            <div class="rt-quest-mood-bar-wrap" title="${escapeHtml(barTitle)}">
                <div class="rt-quest-mood-bar" style="width:${fillPct}%; background:${barColor};"></div>
                <div class="rt-quest-mood-tick rt-quest-mood-tick-neutral"></div>
                <div class="rt-quest-mood-tick rt-quest-mood-tick-deadline"></div>
            </div>`;

        let statusBadgeClass = 'rt-quest-badge-active';
        let statusLabel = 'Active';
        if (quest.status === 'completed') { statusBadgeClass = 'rt-quest-badge-completed'; statusLabel = 'Completed'; }
        if (quest.status === 'past deadline') { statusBadgeClass = 'rt-quest-badge-failed'; statusLabel = 'Past Deadline'; }
        if (quest.status === 'failed')    { statusBadgeClass = 'rt-quest-badge-failed';    statusLabel = 'Failed'; }

        const objectives = (quest.objectives || []).map(obj => {
            const done = obj.status === 'completed';
            const failed = obj.status === 'failed';
            const optLabel = obj.required ? '' : ' <span class="rt-quest-optional">(Optional)</span>';
            let objClass = 'rt-quest-obj';
            if (done) objClass += ' rt-quest-obj-done';
            if (failed) objClass += ' rt-quest-obj-failed';

            // Progress counter (e.g. "4/6")
            const hasProgress = typeof obj.total === 'number' && !done && !failed;
            const progressHtml = hasProgress
                ? ` <span class="rt-quest-progress">${obj.progress ?? 0}/${obj.total}</span>`
                : '';

            return `<div class="${objClass}">
                <span class="rt-quest-check">${done ? '✓' : (failed ? '✗' : '○')}</span>
                <span>${escapeHtml(obj.text)}${progressHtml}${optLabel}</span>
            </div>`;
        }).join('');

        const rewards = (quest.rewards || []).map(r =>
            `<span class="rt-quest-reward">${escapeHtml(r)}</span>`
        ).join('');

        const currentTotalMins = parseInWorldTime(currentTime);
        const deadlineMins = parseInWorldTime(quest.deadline_time);
        let timeLeftHtml = '';
        if (currentTotalMins > 0 && deadlineMins > 0) {
            const diff = deadlineMins - currentTotalMins;
            timeLeftHtml = ` <i style="opacity: 0.7; font-size: 0.9em;">(${formatTimeDiff(diff, diff > 0)})</i>`;
        }

        const acceptedMins = parseInWorldTime(quest.accepted_time);
        let acceptedRow = '';
        if (currentTotalMins > 0 && acceptedMins > 0) {
            const diff = currentTotalMins - acceptedMins;
            acceptedRow = `
                <div class="rt-quest-deadline">
                    <div class="rt-quest-deadline-header">
                        <span class="rt-entity-sub-label">Accepted:</span> ${escapeHtml(quest.accepted_time)} <i style="opacity: 0.7; font-size: 0.9em;">(${formatTimeDiff(diff, false)})</i>
                    </div>
                </div>`;
        }

        const deadlineRow = (quest.deadline_time && showDeadlines) ? `
            <div class="rt-quest-deadline" style="${acceptedRow ? 'border-top: none; margin-top: 0;' : ''}">
                <div class="rt-quest-deadline-header">
                    <span class="rt-entity-sub-label">Deadline:</span> ${escapeHtml(quest.deadline_time)}${timeLeftHtml}
                    ${showFrustration ? `<span class="rt-quest-mood-label" style="color:${barColor};">${label}</span>` : ''}
                </div>
                ${moodBarHtml}
            </div>` : '';

        const isFailed = quest.status === 'failed' || quest.status === 'past deadline';
        let cardClass = 'rt-quest-card';
        if (quest.status !== 'active') cardClass += ' rt-quest-inactive';
        if (isFailed) cardClass += ' rt-quest-card-failed';

        const diffColors = {
            'Very Easy': '#a3e635', // Lime
            'Easy': '#22c55e',      // Green
            'Medium': '#f59e0b',    // Amber
            'Hard': '#f97316',      // Orange
            'Very Hard': '#ef4444'  // Red
        };
        const badgeBg = diffColors[quest.difficulty] || 'rgba(120, 120, 120, 0.2)';
        const badgeColor = diffColors[quest.difficulty] ? '#000' : 'rgba(255,255,255,0.9)';
        const diffBadge = quest.difficulty ? `<span class="rt-quest-badge" style="background: ${badgeBg}; color: ${badgeColor}; font-weight: 800; border: none;">${escapeHtml(String(quest.difficulty)).toUpperCase()}</span>` : '';

        return `<div class="${cardClass}">
            <div class="rt-quest-header">
                <span class="rt-quest-title">${escapeHtml(quest.title)}</span>
                <div class="rt-quest-badges">
                    ${diffBadge}
                    <span class="rt-quest-badge ${statusBadgeClass}">${statusLabel}</span>
                </div>
            </div>
            <div class="rt-quest-giver">${escapeHtml(quest.giver_name)} · <em>${escapeHtml(quest.giver_location)}</em></div>
            <div class="rt-quest-objectives">${objectives}</div>
            ${rewards ? `<div class="rt-quest-rewards">${rewards}</div>` : ''}
            ${acceptedRow}
            ${deadlineRow}
        </div>`;
    };

    const activeQuests = allQuests.filter(q => q.status !== 'completed');
    const completedQuests = allQuests.filter(q => q.status === 'completed');

    const activeCardsHtml = activeQuests.map(renderQuestCard).join('');
    const completedCardsHtml = completedQuests.map(renderQuestCard).join('');

    let bodyHtml = activeCardsHtml || '<div class="rt-card-line" style="opacity:0.6; padding: 10px;">No active quests.</div>';

    if (completedQuests.length > 0) {
        const isCompletedCollapsed = collapsed.has(TAG + '_COMPLETED');
        bodyHtml += `
        <div class="rt-section-card rt-sub-section${isCompletedCollapsed ? ' rt-collapsed' : ''}" data-tag="${TAG}_COMPLETED" style="margin-top: 10px; background: rgba(0,0,0,0.2); border-color: rgba(255,255,255,0.05); border-radius: 6px;">
            <div class="rt-section-header" data-tag="${TAG}_COMPLETED" style="padding: 6px 10px; font-size: 0.9em; background: rgba(0,0,0,0.2); border-top-left-radius: 6px; border-top-right-radius: 6px;">
                <span style="opacity:0.8;">✅ COMPLETED</span>
                <div class="rt-section-header-right">
                    <span class="rt-item-count" style="opacity:0.6;">${completedQuests.length} ${completedQuests.length === 1 ? 'entry' : 'entries'}</span>
                    <span class="rt-collapse-icon" style="opacity:0.6;">${isCompletedCollapsed ? '&#9656;' : '&#9662;'}</span>
                </div>
            </div>
            <div class="rt-section-body" style="padding: 5px;">${completedCardsHtml}</div>
        </div>`;
    }

    const renderOptions = getSettings().categoryRenderOptions?.[TAG] || {};
    const catStyles = [];
    if (renderOptions.fontSize) catStyles.push(`--rt-cat-font-size: ${(renderOptions.fontSize / 13).toFixed(4)}em`);
    if (renderOptions.italic) catStyles.push(`--rt-cat-font-style: italic`);
    if (renderOptions.bold) catStyles.push(`--rt-cat-font-weight: bold`);
    if (renderOptions.bullets === false) catStyles.push(`--rt-cat-bullet-display: none`);
    if (renderOptions.bulletColor) catStyles.push(`--rt-cat-bullet-color: ${renderOptions.bulletColor}`);
    if (renderOptions.bulletStyle) catStyles.push(`--rt-cat-bullet-style: "${renderOptions.bulletStyle}"`);
    if (renderOptions.fontFamily) catStyles.push(`--rt-cat-font-family: ${renderOptions.fontFamily}`);
    if (renderOptions.textColor && renderOptions.textColor !== 'inherit') catStyles.push(`--rt-cat-text-color: ${renderOptions.textColor}`);
    const catStyleAttr = catStyles.length ? ` style='${catStyles.join('; ')}'` : '';

    return `<div class="rt-section-card${isCollapsed ? ' rt-collapsed' : ''}" data-tag="${TAG}">
        <div class="rt-section-header" data-tag="${TAG}">
            <span>📋 QUESTS</span>
            <div class="rt-section-header-right">
                ${detachBtn}
                <button class="rt-category-settings-btn" data-tag="${TAG}" title="Category Rendering Options">
                    <i class="fa-solid fa-cog"></i>
                </button>
                <span class="rt-item-count">${activeQuests.length} active</span>
                <span class="rt-collapse-icon">${isCollapsed ? '&#9656;' : '&#9662;'}</span>
            </div>
        </div>
        <div class="rt-section-body"${catStyleAttr} style="padding-bottom: 5px;">${bodyHtml}</div>
    </div>`;
}
    /**
     * Renders the Lorebook Agent's thought process into a terminal-like view.
     * @param {object[]} steps
     * @returns {string}
     */
    export function renderLorebookTerminal(steps) {
        if (!steps || steps.length === 0) return '';

        return steps.map(step => {
            const time = new Date(step.timestamp).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
            let icon = 'fa-brain';
            let color = 'var(--rt-custom-text-muted)';
            let title = 'Thought';

            switch (step.type) {
                case 'tool': icon = 'fa-screwdriver-wrench'; color = '#3498db'; title = 'Tool'; break;
                case 'result': icon = 'fa-list-ul'; color = '#9b59b6'; title = 'Result'; break;
                case 'error': icon = 'fa-circle-exclamation'; color = '#e74c3c'; title = 'Error'; break;
                case 'finish': icon = 'fa-circle-check'; color = '#2ecc71'; title = 'Finished'; break;
                case 'start': icon = 'fa-play'; color = '#f1c40f'; title = 'Starting'; break;
            }

            const content = escapeHtml(step.content);
            const metadata = step.metadata || {};

            return `
            <div class="rt-terminal-step" style="margin-bottom: 8px; font-family: var(--rt-custom-font-mono, monospace); font-size: 11px;">
                <div class="rt-terminal-header" style="display: flex; align-items: center; gap: 8px; opacity: 0.8;">
                    <span style="font-size: 9px; opacity: 0.5;">${time}</span>
                    <i class="fa-solid ${icon}" style="color: ${color}; width: 14px; text-align: center;"></i>
                    <b style="color: ${color}; text-transform: uppercase; letter-spacing: 0.5px;">${title}</b>
                    ${metadata.time ? `<span style="margin-left: auto; font-size: 10px; opacity: 0.6;">Worked for ${metadata.time}s</span>` : ''}
                </div>
                <div class="rt-terminal-content" style="margin-top: 4px; padding-left: 22px; line-height: 1.4; white-space: pre-wrap; word-break: break-all; color: var(--rt-custom-text);">
                    ${content}
                </div>
            </div>`;
        }).join('');
    }
