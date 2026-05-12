/**
 * llm-client.js — Fatbody D&D Framework
 * All external LLM networking. Stateless — reads state via parameter, no DOM.
 * Handles Ollama, OpenAI-compatible, and SillyTavern Profile/generateRaw modes.
 *
 * Imports: state-manager.js
 * Imported by: index.js, memo-processor.js
 */

import { getSettings } from './state-manager.js';
import { logTransaction } from './debug-viewer.js';

// ── Connection Profile Helpers ─────────────────────────────────────────────────

export async function checkConnectionProfilesActive() {
    return $('#sys-settings-button').find('#connection_profiles').length > 0;
}

export async function getConnectionProfiles() {
    if (!(await checkConnectionProfilesActive())) return [];
    const { executeSlashCommandsWithOptions } = SillyTavern.getContext();
    const result = await executeSlashCommandsWithOptions(`/profile-list`);
    try {
        return JSON.parse(result.pipe);
    } catch {
        return [];
    }
}

export async function getCurrentCompletionPreset() {
    const { executeSlashCommandsWithOptions } = SillyTavern.getContext();
    const result = await executeSlashCommandsWithOptions(`/preset`);
    return result?.pipe?.trim() || null;
}

export async function setCompletionPreset(name) {
    if (!name) return;
    const { executeSlashCommandsWithOptions } = SillyTavern.getContext();
    await executeSlashCommandsWithOptions(`/preset "${name}"`);
}

// ── CORS Proxy Helpers ─────────────────────────────────────────────────────────

function proxiedUrl(url, useProxy = true) {
    if (!useProxy) return url;
    return `/proxy/${url}`;
}

function getProxyHeaders() {
    try {
        const ctx = SillyTavern.getContext();
        if (typeof ctx.getRequestHeaders === 'function') {
            return ctx.getRequestHeaders();
        }
    } catch (e) { /* fallback */ }
    return { 'Content-Type': 'application/json' };
}

// ── Ollama ─────────────────────────────────────────────────────────────────────

export async function sendViaOllama(url, model, systemPrompt, userPrompt, maxTokens, presetSettings = {}, signal = null) {
    if (!url) throw new Error('Ollama URL is not configured.');
    if (!model) throw new Error('Ollama model is not selected.');

    const baseUrl = url.replace(/\/+$/, '');
    const targetUrl = `${baseUrl}/api/chat`;

    const requestBody = {
        model: model,
        messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
        ],
        stream: false,
        options: {
            temperature: presetSettings.temperature ?? presetSettings.temp ?? presetSettings.temp_openai ?? 0.1,
            top_p: presetSettings.top_p ?? presetSettings.top_p_openai ?? 1.0,
            top_k: presetSettings.top_k ?? presetSettings.top_k_openai ?? 40,
            repeat_penalty: presetSettings.repetition_penalty ?? presetSettings.rep_pen ?? presetSettings.repetition_penalty_openai ?? 1.1,
            num_predict: (maxTokens && maxTokens > 0) ? maxTokens : undefined,
        },
    };
    console.log(`[RPG Tracker] sendViaOllama — model: "${model}", url: "${targetUrl}"`);
    if (Object.keys(presetSettings).length > 0) console.log(`[RPG Tracker] Applied Preset Data:`, presetSettings);
    console.log(`[RPG Tracker] Parameters — Temp: ${requestBody.options.temperature}, Top_P: ${requestBody.options.top_p}, Top_K: ${requestBody.options.top_k}`);
    console.log(`[RPG Tracker] Prompts — System: "${systemPrompt.substring(0, 50)}...", User: "${userPrompt.substring(0, 50)}..."`);

    let response;
    const headers = { 'Content-Type': 'application/json' };
    try {
        const proxyHeaders = getProxyHeaders();
        const finalHeaders = { ...headers, ...proxyHeaders };
        response = await fetch(proxiedUrl(targetUrl), {
            method: 'POST',
            headers: finalHeaders,
            body: JSON.stringify(requestBody),
            signal,
        });
        if (!response.ok && response.status === 404) {
            throw new Error('Proxy 404');
        }
    } catch (proxyError) {
        try {
            response = await fetch(targetUrl, {
                method: 'POST',
                headers: headers,
                body: JSON.stringify(requestBody),
                signal,
            });
        } catch (directError) {
            throw new Error(`Failed to connect to Ollama. Proxy error: ${proxyError.message}. Direct error: ${directError.message}`);
        }
    }

    if (!response.ok) {
        if (response.status === 401) throw new Error('Ollama returned 401 Unauthorized. Check that no authentication is required, or configure it correctly.');
        throw new Error(`Ollama request failed (${response.status})`);
    }
    const data = await response.json();
    const result = data.message.content;
    console.log(`[RPG Tracker] Response from Ollama: "${result.substring(0, 100)}..."`);
    logTransaction('Tracker', [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }], result);
    return result;
}

export async function fetchOllamaModels(url) {
    if (!url) throw new Error('Ollama URL is not configured.');
    const baseUrl = url.replace(/\/+$/, '');
    const targetUrl = `${baseUrl}/api/tags`;
    let response;
    try {
        const proxyHeaders = getProxyHeaders();
        response = await fetch(proxiedUrl(targetUrl), { method: 'GET', headers: proxyHeaders });
        if (!response.ok && response.status === 404) {
            response = await fetch(targetUrl, { method: 'GET', headers: { 'Content-Type': 'application/json' } });
        }
    } catch (e) {
        response = await fetch(targetUrl, { method: 'GET', headers: { 'Content-Type': 'application/json' } });
    }
    if (!response.ok) {
        if (response.status === 401) throw new Error('Ollama returned 401 Unauthorized. Check that no authentication is required.');
        throw new Error(`Failed to fetch Ollama models (${response.status})`);
    }
    const data = await response.json();
    return data.models || [];
}

// ── OpenAI Compatible ──────────────────────────────────────────────────────────

export async function sendViaOpenAI(url, apiKey, model, systemPrompt, userPrompt, maxTokens, presetSettings = {}, signal = null) {
    if (!url) throw new Error('OpenAI Compatible URL is not configured.');
    if (!model) throw new Error('OpenAI Compatible model name is not set.');

    const baseUrl = url.replace(/\/+$/, '');
    let endpoint = baseUrl;
    if (!endpoint.endsWith('/chat/completions')) {
        if (endpoint.endsWith('/v1')) endpoint += '/chat/completions';
        else if (!endpoint.includes('/chat/completions')) endpoint += '/v1/chat/completions';
    }

    const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)(:\d+)?/i.test(endpoint);
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

    const requestBody = {
        model: model,
        messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
        temperature: presetSettings.temperature ?? presetSettings.temp ?? presetSettings.temp_openai ?? 0.1,
        top_p: presetSettings.top_p ?? presetSettings.top_p_openai ?? 1.0,
        frequency_penalty: presetSettings.frequency_penalty ?? presetSettings.freq_pen ?? presetSettings.freq_pen_openai ?? 0,
        presence_penalty: presetSettings.presence_penalty ?? presetSettings.presence_pen ?? presetSettings.pres_pen_openai ?? 0,
        stream: true,
    };
    if (maxTokens && maxTokens > 0) requestBody.max_tokens = maxTokens;

    console.log(`[RPG Tracker] sendViaOpenAI — model: "${model}", url: "${endpoint}"`);
    if (Object.keys(presetSettings).length > 0) console.log(`[RPG Tracker] Applied Preset Data:`, presetSettings);
    console.log(`[RPG Tracker] Parameters — Temp: ${requestBody.temperature}, Top_P: ${requestBody.top_p}, Freq_Pen: ${requestBody.frequency_penalty}`);
    console.log(`[RPG Tracker] Prompts — System: "${systemPrompt.substring(0, 50)}...", User: "${userPrompt.substring(0, 50)}..."`);

    let response;
    if (isLocal) {
        try {
            const proxyHeaders = getProxyHeaders();
            const finalHeaders = { ...headers, ...proxyHeaders };
            response = await fetch(proxiedUrl(endpoint), { method: 'POST', headers: finalHeaders, body: JSON.stringify(requestBody), signal });
            if (!response.ok && response.status === 404) {
                throw new Error('Proxy 404');
            }
        } catch (e) {
            response = await fetch(endpoint, { method: 'POST', headers: headers, body: JSON.stringify(requestBody), credentials: 'omit', signal });
        }
    } else {
        response = await fetch(endpoint, { method: 'POST', headers: headers, body: JSON.stringify(requestBody), credentials: 'omit', signal });
    }

    if (!response.ok) {
        if (response.status === 401) throw new Error('OpenAI endpoint returned 401 Unauthorized. Check your API key.');
        throw new Error(`OpenAI request failed (${response.status})`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let fullContent = '';
    let buffer = '';

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed || !trimmed.startsWith('data:')) continue;
                const data = trimmed.slice(5).trim();
                if (data === '[DONE]') continue;
                try {
                    const parsed = JSON.parse(data);
                    const delta = parsed.choices?.[0]?.delta?.content;
                    if (delta) fullContent += delta;
                } catch (e) { }
            }
        }
    } finally { reader.releaseLock(); }

    if (!fullContent.trim()) throw new Error('OpenAI returned an empty response.');
    console.log(`[RPG Tracker] Response from OpenAI: "${fullContent.substring(0, 100)}..."`);
    logTransaction('Tracker', [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }], fullContent);
    return fullContent;
}

export async function fetchOpenAIModels(url, apiKey) {
    if (!url) throw new Error('OpenAI URL is not configured.');
    const baseUrl = url.replace(/\/+$/, '');
    let endpoint = baseUrl;
    if (!endpoint.endsWith('/models')) {
        if (endpoint.endsWith('/v1')) endpoint += '/models';
        else if (!endpoint.includes('/models')) endpoint += '/v1/models';
    }

    const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)(:\d+)?/i.test(endpoint);
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

    if (isLocal) {
        try {
            const proxyHeaders = getProxyHeaders();
            const finalHeaders = { ...headers, ...proxyHeaders };
            const proxyResponse = await fetch(proxiedUrl(endpoint), { method: 'GET', headers: finalHeaders });
            if (proxyResponse.ok) {
                const data = await proxyResponse.json();
                return data.data || data.models || [];
            }
        } catch (e) { /* proxy network error, fall through */ }
    }

    try {
        const directResponse = await fetch(endpoint, {
            method: 'GET',
            headers: headers,
            credentials: 'omit',
        });
        if (directResponse.ok) {
            const data = await directResponse.json();
            return data.data || data.models || [];
        }
        if (directResponse.status === 401) {
            throw new Error('Endpoint returned 401 Unauthorized. Check your API key.');
        }
        throw new Error(`HTTP ${directResponse.status}`);
    } catch (e) {
        if (e.message.includes('401')) throw e;
        if (isLocal) {
            throw new Error(
                `Cannot reach ${endpoint} due to CORS restrictions.\n\n` +
                `Solutions:\n` +
                `1. Enable ST's CORS proxy: set "enableCorsProxy: true" in config.yaml and restart ST.\n` +
                `2. Or type the model name manually in the text box below.\n\n` +
                `(Original error: ${e.message})`
            );
        }
        throw e;
    }
}

export async function testOpenAIConnection(url, apiKey, model) {
    try {
        const result = await sendViaOpenAI(url, apiKey, model || 'test', 'You are a test assistant.', 'Respond with exactly: CONNECTION_OK', 100);
        return { success: true, message: `Connection successful! Response: "${result.substring(0, 100)}"` };
    } catch (error) {
        return { success: false, message: `Connection failed: ${error.message}` };
    }
}

// ── Primary dispatch ───────────────────────────────────────────────────────────

/**
 * Routes a state request to the correct backend based on settings.connectionSource.
 * Handles: 'profile', 'ollama', 'openai', 'default' (generateRaw).
 * @param {ReturnType<import('./state-manager.js').getSettings>} settings
 * @param {string} systemPrompt
 * @param {string} userPrompt
 * @returns {Promise<string>}
 */
export async function sendStateRequest(settings, systemPrompt, userPrompt, signal = null) {
    const context = SillyTavern.getContext();

    console.log(`[RPG Tracker] sendStateRequest — source: "${settings.connectionSource}", profileId: "${settings.connectionProfileId}", preset: "${settings.completionPresetId}"`);

    // ── Profile mode: use ConnectionManagerRequestService (silent, no UI flicker) ──
    if (settings.connectionSource === 'profile' && settings.connectionProfileId) {
        const service = context.ConnectionManagerRequestService;

        if (!service || typeof service.sendRequest !== 'function') {
            console.warn('[RPG Tracker] ConnectionManagerRequestService not available (ST too old?). Falling back to generateRaw with profile switch.');
        } else {
            if (settings.debugMode) console.log(`[RPG Tracker] Sending via profile (silent): ${settings.connectionProfileId}${settings.completionPresetId ? `, preset override: ${settings.completionPresetId}` : ''}`);

            const messages = [
                { role: 'system', content: systemPrompt },
                { role: 'user',   content: userPrompt   },
            ];

            const maxTokens = settings.maxTokens && settings.maxTokens > 0 ? settings.maxTokens : undefined;

            // Use the canonical ST service path. This correctly handles secret_id
            // lookup, prompt formatting for text-completion backends (instruct
            // template), and preset loading for all API types.
            const raw = await service.sendRequest(
                settings.connectionProfileId,
                messages,
                maxTokens,
                {
                    stream: false,
                    extractData: true,
                    includePreset: true,
                    includeInstruct: true,
                    presetName: settings.completionPresetId || undefined,
                    signal,
                },
            );

            if (typeof raw === 'string') return raw;
            const r = /** @type {any} */ (raw);
            const text = r?.content
                ?? r?.message?.content
                ?? r?.choices?.[0]?.message?.content
                ?? r?.choices?.[0]?.text
                // Some providers (e.g. models with extended thinking) return empty content
                // with the actual response in a reasoning/thinking field — treat it as the output.
                ?? r?.reasoning
                ?? r?.message?.reasoning
                ?? r?.choices?.[0]?.message?.reasoning
                ?? null;

            if (text) {
                logTransaction('Tracker', [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }], text);
                return text;
            }
            throw new Error(`[RPG Tracker] Profile request returned unexpected type: ${JSON.stringify(raw).substring(0, 200)}`);
        }
    }

    // Helper: resolve preset settings from the active preset manager
    const getPresetData = () => {
        if (!settings.completionPresetId) return {};
        let manager = context.getPresetManager();
        let data = manager ? manager.getCompletionPresetByName(settings.completionPresetId) : null;
        if (!data) {
            manager = context.getPresetManager('textgenerationwebui');
            data = manager ? manager.getCompletionPresetByName(settings.completionPresetId) : null;
        }
        if (!data) {
            manager = context.getPresetManager('openai');
            data = manager ? manager.getCompletionPresetByName(settings.completionPresetId) : null;
        }
        if (!data && settings.debugMode) console.warn(`[RPG Tracker] Preset "${settings.completionPresetId}" not found in common PresetManagers.`);
        return data || {};
    };
    const presetSettings = getPresetData();

    // ── Ollama Mode ──
    if (settings.connectionSource === 'ollama') {
        if (settings.debugMode) console.log(`[RPG Tracker] Sending via Ollama: ${settings.ollamaModel}`);
        return await sendViaOllama(settings.ollamaUrl, settings.ollamaModel, systemPrompt, userPrompt, settings.maxTokens, presetSettings, signal);
    }

    // ── OpenAI Compatible Mode ──
    if (settings.connectionSource === 'openai') {
        if (settings.debugMode) console.log(`[RPG Tracker] Sending via OpenAI Compatible: ${settings.openaiModel}`);
        return await sendViaOpenAI(settings.openaiUrl, settings.openaiKey, settings.openaiModel, systemPrompt, userPrompt, settings.maxTokens, presetSettings, signal);
    }

    // ── Default mode: generateRaw through the active connection ──
    const { generateRaw } = context;
    if (!generateRaw) throw new Error('[RPG Tracker] generateRaw is not available.');

    let originalPreset = null;
    try {
        if (settings.completionPresetId) {
            originalPreset = await getCurrentCompletionPreset();
            if (settings.debugMode) console.log(`[RPG Tracker] Switching Preset: ${originalPreset} -> ${settings.completionPresetId}`);
            await setCompletionPreset(settings.completionPresetId);
        }

        const options = {
            prompt: userPrompt,
            systemPrompt: systemPrompt,
            bypassAll: true,
            signal,
        };

        if (settings.maxTokens && settings.maxTokens > 0) {
            options.responseLength = settings.maxTokens;
        }

        const result = await generateRaw(options);

        let text = "";
        if (typeof result === 'string') {
            text = result;
        } else {
            const r = /** @type {any} */ (result);
            text = r?.choices?.[0]?.message?.content
                ?? r?.choices?.[0]?.text
                ?? r?.message?.content
                ?? r?.content
                ?? JSON.stringify(result);
        }

        logTransaction('Tracker', [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }], text);
        return text;

    } catch (err) {
        console.error('[RPG Tracker] Request failed:', err);
        throw err;
    } finally {
        if (originalPreset && settings.completionPresetId && originalPreset !== settings.completionPresetId) {
            if (settings.debugMode) console.log(`[RPG Tracker] Restoring preset: ${originalPreset}`);
            await setCompletionPreset(originalPreset);
        }
    }
}

// ── Agent Turn (multi-turn + native tool calling) ─────────────────────────────

/**
 * Sends one turn of the agent loop.
 *
 * For openai / ollama connections: sends a proper multi-turn messages[] array
 * with native OpenAI-format tools so the model returns structured tool_calls —
 * zero regex parsing.
 *
 * For profile / default connections: sends the same multi-turn messages array
 * but without tools (profile handles its own API routing). The caller is still
 * responsible for text-fallback parsing if needed, but since each call only
 * covers the current turn the model will never echo prior turns, making even
 * simple regex reliable.
 *
 * @param {ReturnType<import('./state-manager.js').getSettings>} settings
 * @param {Array<{role:string, content:string|null, tool_calls?:any[], tool_call_id?:string}>} messages
 * @param {Array<object>|null} tools   OpenAI-format tool schemas, or null to skip tool calling.
 * @param {AbortSignal|null} signal
 * @returns {Promise<{content: string, toolCall: {name: string, args: object, id: string} | null}>}
 */
export async function sendAgentTurn(settings, messages, tools = null, signal = null) {
    const context = SillyTavern.getContext();

    // ── OpenAI compatible ────────────────────────────────────────────────────
    if (settings.connectionSource === 'openai') {
        const url = settings.openaiUrl;
        const apiKey = settings.openaiKey;
        const model = settings.openaiModel;
        if (!url) throw new Error('OpenAI Compatible URL is not configured.');
        if (!model) throw new Error('OpenAI Compatible model name is not set.');

        const baseUrl = url.replace(/\/+$/, '');
        let endpoint = baseUrl;
        if (!endpoint.endsWith('/chat/completions')) {
            if (endpoint.endsWith('/v1')) endpoint += '/chat/completions';
            else if (!endpoint.includes('/chat/completions')) endpoint += '/v1/chat/completions';
        }

        const headers = { 'Content-Type': 'application/json' };
        if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

        const presetSettings = _getPresetData(settings, context);

        const body = {
            model,
            messages,
            temperature: presetSettings.temperature ?? presetSettings.temp ?? presetSettings.temp_openai ?? 0.1,
            top_p: presetSettings.top_p ?? presetSettings.top_p_openai ?? 1.0,
            stream: false,
        };
        if (tools?.length) body.tools = tools;
        if (settings.maxTokens > 0) body.max_tokens = settings.maxTokens;

        const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1|192\.168\.\d+|10\.\d|172\.(1[6-9]|2\d|3[01])\.)/i.test(endpoint);
        let resp;
        if (isLocal) {
            try {
                resp = await fetch(proxiedUrl(endpoint), { method: 'POST', headers: { ...headers, ...getProxyHeaders() }, body: JSON.stringify(body), signal });
                if (!resp.ok && resp.status === 404) throw new Error('proxy 404');
            } catch (_) {
                resp = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(body), credentials: 'omit', signal });
            }
        } else {
            resp = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(body), credentials: 'omit', signal });
        }
        if (!resp.ok) throw new Error(`OpenAI request failed (${resp.status})`);
        const data = await resp.json();
        const msg = data.choices?.[0]?.message;
        if (msg?.tool_calls?.length) {
            const tc = msg.tool_calls[0];
            let args;
            try { args = JSON.parse(tc.function.arguments); } catch (_) { args = {}; }
            return { content: msg.content || '', toolCall: { name: tc.function.name, args, id: tc.id } };
        }
        const text = msg?.content ?? data.choices?.[0]?.text ?? '';
        return { content: text, toolCall: null };
    }

    // ── Ollama ───────────────────────────────────────────────────────────────
    if (settings.connectionSource === 'ollama') {
        const baseUrl = (settings.ollamaUrl || '').replace(/\/+$/, '');
        const model = settings.ollamaModel;
        if (!baseUrl) throw new Error('Ollama URL is not configured.');
        if (!model) throw new Error('Ollama model is not selected.');

        const targetUrl = `${baseUrl}/api/chat`;
        const presetSettings = _getPresetData(settings, context);

        const body = {
            model,
            messages,
            stream: false,
            options: {
                temperature: presetSettings.temperature ?? presetSettings.temp ?? 0.1,
                top_p: presetSettings.top_p ?? 1.0,
            },
        };
        if (tools?.length) body.tools = tools;

        let resp;
        try {
            resp = await fetch(proxiedUrl(targetUrl), { method: 'POST', headers: { ...{ 'Content-Type': 'application/json' }, ...getProxyHeaders() }, body: JSON.stringify(body), signal });
            if (!resp.ok && resp.status === 404) throw new Error('proxy 404');
        } catch (_) {
            resp = await fetch(targetUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
        }
        if (!resp.ok) throw new Error(`Ollama request failed (${resp.status})`);
        const data = await resp.json();
        const msg = data.message;
        if (msg?.tool_calls?.length) {
            const tc = msg.tool_calls[0];
            const args = tc.function?.arguments ?? {};
            return { content: msg.content || '', toolCall: { name: tc.function.name, args, id: `call_${Date.now()}` } };
        }
        return { content: msg?.content ?? '', toolCall: null };
    }

    // ── Profile (ConnectionManagerRequestService) ────────────────────────────
    if (settings.connectionSource === 'profile' && settings.connectionProfileId) {
        const service = context.ConnectionManagerRequestService;
        if (service && typeof service.sendRequest === 'function') {
            const maxTokens = settings.maxTokens > 0 ? settings.maxTokens : undefined;
            const raw = await service.sendRequest(
                settings.connectionProfileId,
                messages,
                maxTokens,
                { stream: false, extractData: true, includePreset: true, includeInstruct: true,
                  presetName: settings.completionPresetId || undefined,
                  ...(tools?.length ? { tools } : {}),
                  signal }
            );
            if (typeof raw === 'string') return { content: raw, toolCall: null };
            const r = /** @type {any} */ (raw);
            // Check for native tool_calls first
            const tc = r?.choices?.[0]?.message?.tool_calls?.[0] ?? r?.tool_calls?.[0] ?? null;
            if (tc) {
                let args;
                try { args = typeof tc.function?.arguments === 'string' ? JSON.parse(tc.function.arguments) : (tc.function?.arguments ?? {}); } catch (_) { args = {}; }
                return { content: r?.choices?.[0]?.message?.content || '', toolCall: { name: tc.function.name, args, id: tc.id || `call_${Date.now()}` } };
            }
            const text = r?.content ?? r?.message?.content ?? r?.choices?.[0]?.message?.content ?? r?.choices?.[0]?.text ?? r?.reasoning ?? r?.message?.reasoning ?? r?.choices?.[0]?.message?.reasoning ?? null;
            if (text) return { content: text, toolCall: null };
            throw new Error(`[RPG Tracker] Profile agent turn returned unexpected type: ${JSON.stringify(raw).substring(0, 200)}`);
        }
    }

    // ── Default (generateRaw fallback) ───────────────────────────────────────
    const { generateRaw } = context;
    if (!generateRaw) throw new Error('[RPG Tracker] generateRaw is not available.');

    // Reconstruct flat prompts from messages array for generateRaw
    const systemMsg = messages.find(m => m.role === 'system');
    const nonSystem = messages.filter(m => m.role !== 'system');
    const flatUser = nonSystem.map(m => {
        if (m.role === 'tool') return `Observation: ${m.content}`;
        if (m.role === 'assistant' && m.tool_calls) return `Action: ${m.tool_calls[0]?.function?.name}(${m.tool_calls[0]?.function?.arguments})`;
        return m.content || '';
    }).join('\n\n');

    let originalPreset2 = null;
    try {
        if (settings.completionPresetId) {
            originalPreset2 = await getCurrentCompletionPreset();
            await setCompletionPreset(settings.completionPresetId);
        }
        const options = { prompt: flatUser, systemPrompt: systemMsg?.content || '', bypassAll: true, signal };
        if (settings.maxTokens > 0) options.responseLength = settings.maxTokens;
        const result = await generateRaw(options);
        const text = typeof result === 'string' ? result : (/** @type {any} */ (result))?.choices?.[0]?.message?.content ?? '';
        return { content: text, toolCall: null };
    } finally {
        if (originalPreset2 && settings.completionPresetId && originalPreset2 !== settings.completionPresetId) {
            await setCompletionPreset(originalPreset2);
        }
    }
}

/** Internal: resolve preset settings by name from the active preset manager. */
function _getPresetData(settings, context) {
    if (!settings.completionPresetId) return {};
    for (const type of [undefined, 'textgenerationwebui', 'openai']) {
        const mgr = context.getPresetManager(type);
        const data = mgr?.getCompletionPresetByName(settings.completionPresetId);
        if (data) return data;
    }
    return {};
}
