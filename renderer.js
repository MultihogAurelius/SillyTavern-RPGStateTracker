import { getSettings, getBarBackground } from './state-manager.js';
import { escapeHtml, highlightParens } from './memo-processor.js';
import { BLOCK_ICONS, BLOCK_ORDER, PAGE_SIZE, NO_PAGINATE } from './constants.js';

// ── Renderer module: pure HTML string producers, localStorage helpers ──
// No live DOM mutations. All functions return strings or void (localStorage).

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
    export function tryRenderMarker(line, tag = '', entityName = '') {
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
    export function renderCustomBlockLine(tag, line, lineIdx = 0) {
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



    export function getPageSize(renderType) {
        return renderType === 'SPELLS' ? 5 : PAGE_SIZE;
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
                </div>

                <div style="font-size: 13px; opacity: 0.9; display: flex; flex-direction: column; gap: 8px; flex-shrink: 0; line-height: 1.4;">
                    <div><b style="color: var(--rt-accent);">Auto-Tracking:</b> As you roleplay, the extension intelligently parses assistant responses. It detects losses of HP, new loot, or combat triggers, running background passes to update the state.</div>

                    <div><b style="color: var(--rt-accent);">Prompt Injection:</b> The State Memo and RNG Queue are injected seamlessly into your outgoing prompt. It acts as the "source of truth," assuring the model accurately remembers HP, inventory, and mechanical outcomes.</div>

                    <div><b style="color: var(--rt-accent);">Validation:</b> Use the Delta Log (δ) to verify changes. If the AI ever makes a mistake, step backwards using the Snapshot Navigation (←/→) to restore a clean state.</div>
                </div>

                <!-- Narrator Configuration (Salad Bar) -->
                <div style="margin-top: 12px; border: 1px solid rgba(255,255,255,0.12); border-radius: 6px; padding: 10px; background: rgba(255,255,255,0.03); width: 100%; box-sizing: border-box;">
                    <b style="color: var(--rt-accent); font-size: 14px; display: block; margin-bottom: 6px;">Narrator Configuration</b>
                    <small style="display: block; margin-bottom: 8px; opacity: 0.65; font-style: italic; line-height: 1.3;">Select your preferred modes and components. These settings dictate the prompt generated by the Apply button below.</small>
                    
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
                            <label style="display: flex; align-items: center; gap: 8px; cursor: pointer;">
                                <input type="checkbox" id="rt_onboarding_quests_frustration" />
                                <span>Frustration levels</span>
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

                    <button id="rt_onboarding_btn_apply_sysprompt" class="menu_button interactable"
                        style="width: 100%; padding: 6px; font-weight: bold; cursor: pointer;"
                        title="Fetch the configured sysprompt, apply section toggles, and write it to the Quick Prompt Main box.">
                        📝 Apply Sysprompt Now
                    </button>
                    <small style="opacity: 0.6; font-style: italic; display: block; margin-top: 4px; text-align: center;">This will completely reset and apply your new framework configuration.</small>
                </div>

                <div style="font-size: 13px; opacity: 0.9; margin-top: 12px; flex-shrink: 0; line-height: 1.4; border-top: 1px solid rgba(255,255,255,0.1); padding-top: 12px;">
                    <b style="color: var(--rt-accent); font-size: 14px;">Initial Setup:</b><br><br>
                    1. Use the archetype buttons above to roll a new character, or <b>manually describe a character</b> by clicking 💬.<br><br>
                    2. Create a character card for your "narrator" (e.g. Game Master). <b>Leave the card fields empty</b>, as the framework handles all logic via the system prompt.<br><br>
                    3. Click the <b>Apply Sysprompt Now</b> button above to finalize your setup and inject the rules.
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
            const localPageSize = getPageSize(renderType);

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

    const cards = allQuests.map(quest => {
        const { computeFrustration } = /** @type {any} */ (globalThis.__rpgQuestUtils || {});
        const frust = typeof computeFrustration === 'function' ? computeFrustration(quest, currentTime) : 0;

        // frust: -1 = very pleased, 0 = neutral, 1 = frustrated at deadline, >1 = overdue
        // Map to a centered display: 50% = neutral, 0% = very pleased, 100% = max frustrated
        // Clamp display to [-1, 2] range (values beyond 2 are "off the chart")
        const displayFrust = Math.max(-1, Math.min(2, frust));
        const centerPct    = 50; // Neutral sits at 50% of the bar
        const scale        = 100 / 3; // -1→0%, 0→33%, 1→67%, 2→100%
        const fillPct      = Math.round((displayFrust + 1) * scale);

        let frustBarColor = '#00cc77'; // green = pleased
        let moodLabel = 'Pleased';
        if (frust <= -0.5) { frustBarColor = '#00cc77';  moodLabel = 'Very Pleased'; }
        else if (frust <= -0.1) { frustBarColor = '#44dd88'; moodLabel = 'Pleased'; }
        else if (frust <=  0.1) { frustBarColor = '#aaaaaa'; moodLabel = 'Neutral'; }
        else if (frust <=  0.5) { frustBarColor = '#ffcc00'; moodLabel = 'Mildly Frustrated'; }
        else if (frust <=  1.0) { frustBarColor = '#ff8800'; moodLabel = 'Frustrated'; }
        else if (frust <=  1.5) { frustBarColor = '#ff4400'; moodLabel = 'Very Frustrated'; }
        else                    { frustBarColor = '#ff1111'; moodLabel = 'Furious'; }

        // Tick mark at the neutral position (33%) and deadline position (67%)
        const moodBarHtml = `
            <div class="rt-quest-mood-bar-wrap" title="NPC Mood: ${moodLabel} (${frust >= 0 ? '+' : ''}${frust.toFixed(2)})">
                <div class="rt-quest-mood-bar" style="width:${fillPct}%; background:${frustBarColor};"></div>
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
            const optLabel = obj.required ? '' : ' <span class="rt-quest-optional">(Optional)</span>';
            return `<div class="rt-quest-obj${done ? ' rt-quest-obj-done' : ''}">
                <span class="rt-quest-check">${done ? '✓' : '○'}</span>
                <span>${escapeHtml(obj.text)}${optLabel}</span>
            </div>`;
        }).join('');

        const rewards = (quest.rewards || []).map(r =>
            `<span class="rt-quest-reward">${escapeHtml(r)}</span>`
        ).join('');

        const settings = getSettings();
        const showFrustration = settings.isFrustration;

        const moodLabelHtml = showFrustration 
            ? `<span class="rt-quest-mood-label" style="color:${frustBarColor};">${moodLabel}</span>` 
            : '';
        const moodBarFinalHtml = showFrustration ? moodBarHtml : '';

        const deadlineRow = (quest.deadline_time && settings.isDeadlines) ? `
            <div class="rt-quest-deadline">
                <div class="rt-quest-deadline-header">
                    <span class="rt-entity-sub-label">Deadline:</span> ${escapeHtml(quest.deadline_time)}
                    ${moodLabelHtml}
                </div>
                ${moodBarFinalHtml}
            </div>` : '';

        return `<div class="rt-quest-card${quest.status !== 'active' ? ' rt-quest-inactive' : ''}">
            <div class="rt-quest-header">
                <span class="rt-quest-title">${escapeHtml(quest.title)}</span>
                <span class="rt-quest-badge ${statusBadgeClass}">${statusLabel}</span>
            </div>
            <div class="rt-quest-giver">${escapeHtml(quest.giver_name)} · <em>${escapeHtml(quest.giver_location)}</em></div>
            <div class="rt-quest-objectives">${objectives}</div>
            ${rewards ? `<div class="rt-quest-rewards">${rewards}</div>` : ''}
            ${deadlineRow}
        </div>`;
    }).join('');

    return `<div class="rt-section-card${isCollapsed ? ' rt-collapsed' : ''}" data-tag="${TAG}">
        <div class="rt-section-header" data-tag="${TAG}">
            <span>📋 QUESTS</span>
            <div class="rt-section-header-right">
                ${detachBtn}
                <span class="rt-item-count">${allQuests.length} ${allQuests.length === 1 ? 'entry' : 'entries'}</span>
                <span class="rt-collapse-icon">${isCollapsed ? '&#9656;' : '&#9662;'}</span>
            </div>
        </div>
        <div class="rt-section-body">${cards}</div>
    </div>`;
}
