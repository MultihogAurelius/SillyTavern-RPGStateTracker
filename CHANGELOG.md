# Changelog

All notable changes to the **Fatbody D&D Framework** will be documented in this file.

## [1.8.22] - 2026-05-10

**Fix: Mood Sync Logic**
Synchronized the visual mood indicator with the explicit `MOOD` field in the quest tracker.

### Fixed
- **Mood Prioritization**: The UI now prioritizes the explicit `MOOD` field provided by the AI narrator over the calculated frustration.
- **Deadline-Free Frustration**: Quests without deadlines (`DEADLINE: None`) now correctly default to a "Very Pleased" state (`-1.0`) instead of "Neutral" (`0`).
- **Parsing Robustness**: Added `MOOD` field parsing to the legacy quest block processor to ensure AI-specified emotional states are preserved across state updates.

## [1.8.21] - 2026-05-10

**Enhancement: RNG Queue Guidance**
Added explicit clarification to the legacy system prompt regarding RNG queue entry consumption.

### Changed
- **Prompt Guidance**: Explicitly stated that the first number in each RNG queue entry represents the d20 result in the legacy system prompt.

## [1.8.20] - 2026-05-10

**Enhancement: Robust Difficulty Parsing**
Improved the difficulty system to allow for non-standard ratings and ensured UI stability.

### Changed
- **Flexible Difficulty**: Removed the strict enum requirement for quest difficulty, allowing the AI to use custom ratings if appropriate.
- **Rendering Fallback**: Added a robust rendering fallback in the quest log. Non-standard difficulty levels now use a neutral theme that remains legible across different visual themes.

## [1.8.19] - 2026-05-10

**Fix: Tool Registration Bug**
Fixed a `ReferenceError` that prevented the `LogQuest` tool from registering correctly when Difficulty was enabled.

### Fixed
- **Initialization Order**: Corrected the order of variable initialization in `quests.js` to ensure the `required` fields array is defined before being modified by the Difficulty logic.

## [1.8.18] - 2026-05-10

**Enhancement: UI Consistency**
Added the "Difficulty" toggle to the main extension settings panel.

### Added
- **Settings Integration**: The Quest Difficulty toggle is now available in both the startup onboarding wizard and the permanent extension settings panel.

## [1.8.17] - 2026-05-10

**Feature: Quest Difficulty Tracking**
Implemented an optional "Difficulty" system for quests, allowing the AI to assign and track challenge levels (Very Easy to Very Hard).

### Added
- **Difficulty Toggle**: New checkbox in the onboarding UI to enable/disable quest difficulty tracking.
- **Legacy Difficulty**: Support for the `DIFFICULTY:` field in legacy text-block quests.
- **Modern Difficulty**: Integrated `difficulty` parameter into the `LogQuest` tool and allowed difficulty updates in the JSON state tracker.
- **Visual Feedback**: Added color-coded difficulty badges to quest cards in the UI (e.g., Green for Easy, Red for Very Hard).

## [1.8.16] - 2026-05-10

**Fix: Hardened "Apply Sysprompt" Logic**
Fixed a bug where clicking "Apply Sysprompt Now" in the onboarding menu could occasionally result in a stale prompt if intermediate toggle events were missed.

### Fixed
- **Atomic Onboarding Apply**: The "Apply" button now performs a full scrape of all UI toggles (Deadlines, Frustration, Quest Mode, RNG Mode) immediately before generating the prompt. This guarantees the resulting sysprompt and module instructions perfectly match the visible UI state.

## [1.8.15] - 2026-05-10

**Enhancement: Legacy Quest Rewards**
Added the `REWARD:` field to the Legacy Quest Mode system instructions, bringing it to feature parity with the Standard (Modern) JSON format.

### Fixed
- **Legacy Quest Rewards**: The `quests_legacy` prompt now explicitly instructs the AI to track promised rewards using the `REWARD:` marker. While the renderer and parser already supported rewards, the instructions were missing, causing the AI to omit them in legacy mode.

## [1.8.14] - 2026-05-10

**Fix: Direct Prompt Consistency**
Fixed a bug where the "Direct Prompt" feature used its own isolated logic for building system instructions, ignoring Quest Legacy mode and other module settings.

### Fixed
- **Centralized Instruction Building**: `sendDirectPrompt` now uses the shared `buildModulesInstructionText` function, ensuring it respects the active Quest format and all other module configurations.

## [1.8.13] - 2026-05-10

**Fix: Legacy Quest Prompt Now Reliably Applied**
Resolved a critical bug where users with Legacy Quest Mode selected would still receive the Modern (JSON delta) quest prompt in the state model.

### Fixed
- **Quest Prompt Selection at Init**: Replaced the fragile runtime swap with a definitive init-time write. The correct quest prompt (Legacy or Modern) is now written directly into `stockPrompts.quests` at startup based on `questLegacyMode`, guaranteeing the state model always receives the right instructions regardless of save state.
- **Missing `stockPrompts` Guard**: Added a null-check to ensure `stockPrompts` is always initialized before the sync block runs, fixing a silent failure for users without saved prompts.

## [1.8.12] - 2026-05-10

**Prompt Routing Diagnostics**
Added internal diagnostics to track quest prompt routing.

### Changed
- **Harden Quest Prompt Routing**: Improved the logic that swaps between Legacy and Modern quest formats to be more robust.
- **Diagnostic Logging**: Added console logs to verify `questLegacyMode` status and prompt type during initialization and runtime.

## [1.8.11] - 2026-05-10

**Lorebook Synchronization & Robust Loading**
This update resolves a race condition where lorebooks would fail to populate in the extension settings.

### Fixed
- **Lorebook Initialization Race Condition**: Implemented a 3-tier fallback for loading world info names. If the in-memory list is empty, the extension now forces a backend refresh and retries, with a final direct API fetch fallback. This ensures lorebooks are always accessible regardless of SillyTavern's initialization timing.

## [1.8.10] - 2026-05-10

**Quest Framework Refinements & Progress Tracking**  
This update overhauls the quest logic to support narrative-driven failures, partial objective progress tracking, and recalibrated NPC emotional modeling.

### Added
- **Objective Progress Tracking**: Added support for quantity-based objectives (e.g., "Collect 6 Mushrooms [4/6]").
    - Visual progress pills in the quest log UI.
    - Automated state merging for partial progress updates.
    - Support for both Modern (JSON) and Legacy (Plain Text) tracking modes.
- **Dynamic Narrator Instructions**: The system prompt now automatically swaps quest instructions based on the active mode (Standard vs. Legacy) and RNG settings.
- **Automatic Prompt Synchronization**: Implemented an "auto-sync" mechanism that updates unmodified stock prompts to the latest version upon extension load.

### Changed
- **Frustration Logic Recalibration**: NPCs now stay in the "Pleased" to "Neutral" range until a deadline is actually missed. Frustration penalties now ramp up exclusively *after* the deadline has passed.
- **Narrative-Driven Failures**: Explicitly authorized the AI to trigger quest failures if an objective becomes narratively impossible (e.g., target death), independent of automated deadline logic.
- **RNG Queue Instructions**: Clarified that the first number in each `[RNG_QUEUE]` entry is the d20 result to eliminate ambiguity during combat.

### Fixed
- **Legacy Prompt Routing**: Fixed a bug where Legacy Mode was stripping instructions from the modern prompt instead of injecting the dedicated legacy prompt.
- **LogQuest Tool Descriptions**: Updated tool documentation to reflect the new post-deadline frustration behavior.

## [1.8.7] - 2026-05-09

### Added
- **Per-Module Pagination Thresholds**: You can now set independent pagination limits for every module (stock and custom).
    - Added "Pagination Threshold" input to the **Custom Module Editor** and **Prompt Editor**.
    - Changes update the UI in real-time as you type, allowing for instant layout fine-tuning.
- **Robust "Linear Stone" History**: 
    - **Dual-State Archiving**: Updates (both narrative and direct) now archive both the *old* and *new* states to history. This ensures that committing to a past state never permanently clobbers your most recent work.
    - **Direct Prompt Persistence**: Fixed a bug where manual tracker updates via direct instructions were lost during history traversal.
    - **Fluid Snapshot Restoration**: Clicking the nav label now restores a past state instantly without a confirmation popup, as the operation is now completely reversible.

### Changed
- **Unified History Depth**: Increased history limit for Direct Prompt updates from 5 to **1000 items** to match the narrative update cycle.
- **UI Responsiveness**: Removed the requirement to save a module configuration to see pagination changes; the tracker now re-renders immediately upon input.

### Fixed
- **Infinite Snapshot Duplicate Bug**: Resolved a logic error where jumping between historical snapshots and the "Live" state would create redundant duplicates of the same state in the history stack.
- **Clear State Pointer Bug**: Fixed a bug where clearing the tracker history didn't reset the internal state pointer, leading to incorrect history slicing on the next update.
- **Empty State Archiving**: Fixed a guard condition that prevented archiving the very first state (empty) into history.
- **Quest Settings Persistence**: Fixed a regression where "Deadlines" and "Frustration Levels" toggles failed to persist across session reloads.


## [1.8.2] - 2026-05-05

**Waterproofing RPG State Persistence**  
This update introduces a deterministic, non-regex JSON cleaner for tool-call metadata and a surgical RNG queue stripper. These optimizations eliminate token bloat caused by redundant tool signatures and metadata, saving approximately 1,500 tokens per dice roll.

### Added
- **Total Tool-Call Bloat Removal**: The State Model now completely excludes mechanics-heavy tool results (signatures, reasoning, parameters) from its context. It relies exclusively on the narrative descriptions that follow a roll, significantly reducing context usage.
- **Surgical RNG Stripping**: Implemented a "waterproof" regex mechanism for stripping `[RNG_QUEUE]` blocks from the user's last action, ensuring AI context remains clean while maintaining 100% stability.
- **Expanded RNG Queue**: Increased the pre-rolled `[RNG_QUEUE]` length from **8** to **12** to provide more headroom for complex combat encounters.

### Changed
- **Unified Versioning**: Synchronized framework version to **1.8.2** across manifest, changelog, and system prompt UI.
- **Context Filtering**: Wired the cleaner into both the automatic `StateModelPass` and the manual `Direct Prompt` pipelines to ensure consistent token savings across all interaction modes.


**Chat-Linked State Persistence**  
This major update introduces per-chat isolation for the RPG State Tracker, allowing for seamless transitions between different campaigns and characters.

### Added
- **Chat-Specific Isolation**: Memos and history are now automatically scoped to the active SillyTavern Chat ID. Switching chats will swap the tracker state instantly.
- **Smart Conflict Resolution**: When linking to a chat that has existing data, a native SillyTavern modal prompts for **RESTORE**, **OVERWRITE**, or **CANCEL**.
- **Automatic History Backup**: Discarded "Global" work is automatically pushed into the chat's history during transitions to prevent data loss.
- **Clean Slate Onboarding**: New chats automatically start with an empty tracker while preserving your custom module configurations.

### Changed
- **Unified Versioning**: Synchronized framework version to **1.8.0** across manifest, changelog, and system prompt UI.
- **Improved Modal Experience**: Replaced generic browser alerts with premium, native SillyTavern popups.

### Fixed
- **State Overwrite Bug**: Resolved an issue where toggling Chat Link could accidentally wipe existing chat data with the current live state.

## [1.7.5] - 2026-05-05

**Waterproof Markers & UI Streamlining**  
This update focuses on "waterproofing" the RPG Marker system and cleaning up the Editor UI for a more professional experience.

### Fixed
- **"Waterproof" Marker System**: Resolved a bug where visual markers like `((PILLS))`, `((BAR))`, and `((XPBAR))` were being stripped from the state data sent to the AI. The system now preserves these markers throughout the entire round-trip, ensuring 100% reliable HUD formatting.
- **ST API Compatibility**: Added support for both `max_tokens` and `max_new_tokens` in the TextCompletionService payload, ensuring stability across different SillyTavern backends.
- **UI Logic Stability**: Fixed a critical `TypeError` in `sendStateRequest` that could occur when switching between connection profiles.
- **General Linting**: Fixed multiple "silent" errors including missing header definitions, incorrect API signatures, and jQuery type-safety issues in both the main extension and the `Summaryception` connection utility.

### Changed
- **Editor UI Refinement**: Removed the "Preview" toggle button from the Custom Field Editor. On supported desktop displays, the **Testing Sandbox** is now permanently visible to provide instant feedback.
- **Version Synchronization**: Incremented framework version to **1.7.5** across the manifest and the internal system prompt footer.

## [1.7.4] - 2026-05-05

**Enhanced Connectivity and UI Refinement**  
A comprehensive upgrade to the external LLM pipeline and settings organization, enabling direct-to-backend connections with robust parameter mapping.

### Added
- **Direct Backend Connectivity**: Introduced the ability to route State Tracking requests directly to **Ollama** or **OpenAI-Compatible** endpoints (like OpenRouter, LM Studio), bypassing SillyTavern's internal profile system for ultra-low-latency background updates.
- **Universal Parameter Mapping**: Implemented a multi-tier fallback system for generation settings. The framework now correctly extracts and maps `temperature`, `top_p`, `frequency_penalty`, and `repetition_penalty` across all SillyTavern preset formats (supporting both TextGen and OpenAI-specific key names).
- **Diagnostic Transparency**: Added high-verbosity browser console logging (Debug Mode) that explicitly outputs the `Applied Preset Data` and final `Parameters` used for each request.

### Changed
- **Settings UI Drawer System**: Refactored the settings panel into an expandable **Drawer** system. 
    - **Connection Settings** and **Advanced Options** now reside in collapsible headers to keep the main menu clean.
    - **Context & Lorebooks** has been promoted to a top-level section for better discoverability.
- **Header Aesthetics**: Updated the extension's main drawer icon and bold styling to match SillyTavern's native visual standards.
- **Layout Optimization**: Optimized button widths (Add Custom Field, Test Connection, Factory Reset) for better responsiveness in narrow sidebars.
- **Combat Tracking**: Updated the default [COMBAT] prompt to include explicit `COMBAT ROUND X` tracking per combatant.

### Fixed
- **Property Name Collision**: Resolved an issue where presets created under OpenAI profiles would fail to apply their temperature settings due to differing property names (e.g., `temp` vs `temp_openai`).
- **Button Alignment**: Fixed vertical squishing and awkward text wrapping on manual action buttons.

## [1.7.1] - 2026-05-04

### Fixed
- **Silent Model/Preset Switching**: Fixed a major regression where background RPG tracker passes would ignore the selected Connection Profile and Generation Settings Preset. The system now correctly routes requests through specific models (like Gemini 3 Flash) with custom sampler overrides (like disabling reasoning) silently and reliably.

## [1.7.0] - 2026-05-04

**Custom Field Overhaul and Universal Markers**  
A major refactor of the Custom Field Editor and rendering engine, giving users total control over AI instructions while enabling high-fidelity markers (pills, bars) in every stock module.

### Added
- **Universal Marker Support**: `((PILLS))`, `((BAR))`, `((XPBAR))`, `((BADGE))`, and `((HIGHLIGHT))` now work in ALL built-in modules (INVENTORY, ABILITIES, SPELLS, XP, TIME).
- **Decoupled AI Instructions**: The Custom Field Editor now separates the visual template from the AI prompt, allowing for raw, unmanipulated instruction sets.
- **CFE Color Guide**: Added a one-click guide button to the Custom Field Editor to help users quickly implement colored text and rarity tags.
- **CFE Help System**: Added tooltips to the Custom Field Editor to clarify the distinction between UI previews and AI instructions.
- **Instruction Hardening**: Added a new `<custom_formatting>` block to core instructions to better guide the AI on when to use graphical markers.

### Changed
- **Decommissioned Sub-Field Rules**: Removed the legacy global label-mapping system. All rendering is now handled via the more powerful and flexible template system.
- **Renamed Dice Tool**: "Dice Roll (Fatbody)" is now **"Dice Roll (with DC)"** for better transparency.
- **Restored Stock Prompts**: Reverted module prompts to their high-performance legacy versions as requested by the community.
- **UI Typography**: Increased subtext and tooltip font sizes for improved readability.

### Fixed
- **Lookback Update Logic**: Fixed a bug where manual "Lookback Update" was ignored in favor of persistent settings. It now correctly overrides the context window for one-time refreshes.
- **Mobile CFE Stability**: Resolved multiple layout bugs in the Custom Field Editor for mobile devices, including top-clipping, z-index layering issues, and redundant UI elements.

## [1.6.0] - 2026-05-04

**Improved Customization and Advanced Options**  
Significant upgrades to editing custom fields. The formatting is now clear, and there's a live preview window, which makes design a breeze.

### Added
- **Advanced Options Update**: Deep customization for the State Model's intelligence.
- **Precision Lookback Control**: You can now specify exactly how many previous messages (User/Assistant) and how many historical tracker states the model sees when making updates.
- **Lorebook Context Support**: You can now select which specific Lorebooks the tracker is aware of during updates, ensuring it stays consistent with your world info.
- **Enhanced Custom Field Editor**:
    - **Live Preview Window**: Real-time rendering of your tracker blocks while you edit prompts.
    - **Color Support**: Full support for `<font color=#...>...</font>` tags and native WoW-style rarity tags like `[Legendary]`, `[Epic]`, etc., which are now automatically colorized.
    - **Contextual Formatting**: Module prompt examples now use stock fields (like CHARACTER and ABILITIES) to guide better formatting.

### Fixed
- **UI Headers**: Fixed a bug where the preview window would show raw tags like `__PREVIEW__` instead of proper field labels.
- **Live Preview Interactivity**: Pagination and list/page views now work correctly within the live preview window.

## [1.5.5] - 2026-04-29

### Fixed
- **Mobile Prompt Access**: Embedded system prompts directly into the code and implemented an HTTP-compatible clipboard fallback. This ensures the SYSPROMPT button works on mobile/Termux environments where local file fetching and modern clipboard APIs are often restricted.

### Added
- **Full-Screen Mobile Support**: The tracker now expands to cover the screen on mobile, optimizing space.
- **Button Alignment Fixes**: Centered all navigation and RNG buttons, ensuring they align vertically and horizontally.
- **Settings Drawer Refinement**: Polished the collapsible footer to keep settings accessible but out of the way.

### Added
- **Mobile UI Optimization**: Implemented responsive CSS for mobile devices (max-width 600px).
- **Adaptive Footer**: The bottom bar now stacks vertically on mobile, hides the character counter, and uses compact labels to prevent button overlapping and ensure reliable touch targets.

### Changed
- **Initiative System**: Shifted pre-combat initiative rolls from the RNG Queue to the Tool Call system for better narrative integration.
- **Resting Rules**: Reduced the Long Rest cooldown to 9 hours and implemented a d20-based interruption check for resting in dangerous locations.
- **RNG Queue Constraint**: Strictly isolated the RNG Queue to active combat actions only.
- **Prompt Synchronization**: Updated the legacy fallback prompt to maintain parity with the latest system rules.

### Fixed
- **Detached UI Scrolling**: Fixed an issue where undocked panels (Combat, Party, etc.) would not allow internal scrolling.
- **Resize Handle Conflict**: Resolved a bug where grabbing the resize handle on detached windows would trigger the scrollbar track.
- **Content Overflow**: Optimized card layout within detached panels to ensure proper scroll-height calculation for large entity lists.

## [1.5.0] - 2026-04-28

### Added
- **Visual Status System**: Status effects are now color-coded. Buffs (marked with `(+)`) are Emerald Green, and Debuffs (marked with `(-)`) are Crimson Red.
- **Resource Capsule Icons**: Replaced the generic information icon with dynamic resource trackers. If an ability or spell has a usage count (e.g., `2/3`), it is displayed directly in the pill icon.
- **XML-Structured Instructions**: Completely refactored the State Model prompt using semantic XML tagging for vastly improved instruction following and clarity.
- **Enhanced Status Labeling**: Standardized status formatting to ensure both mathematical effects and durations are preserved in the HUD.
- **Dynamic Adaptive Icons**: Pill icons now expand into capsules to support multi-digit resource counts (like `10/10`) with improved typography.

## [1.4.4] - 2026-04-28

### Added
- **Lookback Update Option**: Added a third manual update mode that allows users to specify exactly how many past assistant turns to parse. This is useful for summarizing multi-turn dialogue or complex narrative sequences without a full context audit.

## [1.4.3] - 2026-04-27

### Fixed
- **Interceptor Metadata Integrity**: Refactored the RNG/State interceptor to use in-place modification. This ensures that hidden SillyTavern metadata (like Reasoning/Thinking content) is preserved exactly as the engine expects, preventing 400 errors with models like DeepSeek R1.
- **Enhanced Thinking Stripping**: Expanded the State Model pass filter to automatically strip `<thought>`, `<thinking>`, and `<reasoning>` tags to prevent API validation errors.

## [1.4.2] - 2026-04-27

### Fixed
- **Multi-Part Message Tracking**: Fixed a critical bug where the State Model failed to process narrative text generated *before* a tool call within a single AI turn. The tracker now seamlessly aggregates all assistant message chunks since the last user message.

## [1.4.1] - 2026-04-27

### Changed
- **Settings UI Optimization**: Removed redundant "Dice & Tools" toggles from the settings panel, as they are now handled exclusively by the interactive footer buttons.
- **System Prompt Refinement**: Hardened RNG and combat rules and unified terminology around `[RNG_QUEUE v6.0_PROPER]` across all system prompt versions.

## [1.4.0] - 2026-04-27

### Added
- **Hybrid RNG Architecture**: Introduced a dual-system approach to random number generation.
  - **RNG Queue (Combat)**: Pre-rolled dice for speed and anti-sycophancy in structured play.
  - **Tool Call RNG (Narrative)**: Reactive, AI-driven rolling for skill checks to prevent narrative "cheating."
- **"Waterproof" Narrative Logic**: Mandatory `dc` (Difficulty Class) parameter enforced in the `RollTheDice` tool. The AI must now commit to a difficulty *before* seeing the roll result.
- **Enhanced SYSPROMPT Selector**: Added a multi-version popup menu to the `SYSPROMPT` button, allowing users to choose between the **Modern (Hybrid)** and **Legacy (Queue-only)** system prompts.
- **Dynamic Footer UI**: Completely refactored the footer buttons with an "Accordion Squeeze" responsive design that hides labels/text as the UI box is resized, rather than stacking vertically.
- **Slash Commands**: Added `/roll` and `/r` commands for manual dice rolling via the command bar.

### Fixed
- **Core Stability**: Resolved a critical initialization crash in the UI core caused by a missing API provider in the slash command registration.
- **Responsive Stacking**: Fixed a bug where footer buttons would stack vertically and misalign on narrow screens.

## [1.3.5] - 2026-04-27

### Fixed
- **Tool Calling Compatibility**: Resolved a critical issue where the tracker would interrupt and break SillyTavern's internal tool-calling sequences.
  - Refactored the core event listener from `MESSAGE_RECEIVED` to `GENERATION_ENDED` (and `GENERATION_STOPPED`). The State Model will now patiently wait for the entire AI tool chain to finish before triggering an update, rather than firing in the "gaps" between tool execution steps.

## [1.3.4] - 2026-04-27

### Changed
- **Buff/Debuff Logic Overhaul**: Refactored how temporary effects and stat modifications are tracked.
  - Relocated "restoration anchors" to the stat lines themselves (e.g., `AC 18 (base 13)`), allowing for cleaner status displays.
  - Standardized Status line formatting to focus on absolute mathematical effects (e.g., `Shield (+5 AC, 1 turn)`).
  - Improved Narrator and State Model synergy for automatic buff expiration and stat restoration.

## [1.3.3] - 2026-04-27

### Fixed
- **Mobile Profile Management**: Resolved an issue where saving, loading, or deleting profiles would fail on mobile devices (especially iOS PWAs).
  - Replaced native `prompt()` and `confirm()` calls with SillyTavern's built-in async modal system.
  - Implemented an async event-handling pattern for the Profile UI to support non-blocking user input.
- **RNG UI Tweak**: Integrated the RNG Physics Engine toggle directly into the footer navigation bar as a professional, horizontally-centered pill button with responsive mobile scaling.

## [1.3.2] - 2026-04-26

### Fixed
- **UI Boundary Protection**: Implemented safety checks to prevent the UI from becoming inaccessible if moved or saved off-screen.
  - Added coordinate sanitization to `loadPanelGeometry` and `createDetachedPanel` to ensure the panel always spawns within the visible viewport.
  - Implemented movement constraints in the dragging logic to prevent moving the panel header beyond the browser window edges.

## [1.3.1] - 2026-04-26

### Fixed
- **Custom Field Limit**: Resolved a bug that limited the number of custom fields to two. 
  - Implemented unique tag generation for new fields (e.g., `NEW_FIELD`, `NEW_FIELD_1`).
  - Added real-time tag validation to prevent duplicate or reserved tags (like `XP` or `CHARACTER`).
  - Added an auto-sanitization pass to `refreshOrderList` to automatically fix any existing duplicate tags in user settings.

## [1.3.0] - 2026-04-25

### Added
- **Starting Level Selector**: Added a "Starting Level" dropdown (Levels 1–20) to the initial setup screen. 
- **Dynamic Archetype Generation**: The Magic, Melee, and Rogue archetype buttons now dynamically generate characters consistent with your chosen starting level (including appropriate gear and spells).
- **Advanced D&D 5e Rules**: Updated `sysprompt.txt` with specific tracking for Distance & Range, Opportunity Attacks, and disadvantage on Ranged Spells in melee combat.
- **Archetype Overhaul**: Significantly improved the character generation "wizard".
  - All archetypes (Magic, Melee, Rogue) now consistently generate **[INVENTORY]** and **[ABILITIES]** blocks.
  - Numbered prompts ensure more thematic gear (Thieves' Tools, Signature Weapons) and class features (Sneak Attack).
- **Finalized Onboarding**: Completed the new user walkthrough in the empty state with descriptions and a manual creation guide.

### Changed
- **Ability Pill Formatting**: Updated the stock prompts to enforce the `Ability Name (brief description)` format, ensuring all class features render correctly as interactive UI pills.
- **Onboarding Guidance**: Added a reminder to the startup guide to reset extension prompts and re-copy the system prompt after a framework update.

### Fixed
- **Comma Support**: Updated the parser for HP, XP, and Hit Dice to support numbers with commas (e.g., `100,000`), preventing display failures with high-value stats.
- **UI Alignment**: Centered the level selector dropdown to sit correctly above the archetype selection buttons.

## [1.2.9] - 2026-04-24

### Fixed
- **Factory Reset**: Resolved a race condition where the page would reload before the reset request is finalized in storage. Replaced blocking alert with a non-blocking toast and delayed reload.

## [1.2.8] - 2026-04-24

### Fixed
- **Onboarding UX**: Fixed markdown bolding in the onboarding guide and scaled up all font sizes for better readability.
- **Profile Persistence**: The profile dropdown now correctly remembers the "-- No Profile --" selection across page refreshes.

### Added
- **Guided Creation**: Updated the startup guide to suggest using the manual update icon (💬) for character creation via description.

## [1.2.7] - 2026-04-24

### Added
- **Interactive Onboarding**: Added a comprehensive step-by-step startup guide to the empty tracker state.
  - Numbered walkthrough for initial character setup and prompt configuration.
  - Included a highlighted "Update Alert" warning to notify users when they need to re-copy the system prompt.
  - Redesigned archetype buttons for better visual integration.

## [1.2.6] - 2026-04-24

### Fixed
- **Profile Persistence**: Scenario profiles now correctly save and restore the **Module Order** and **Active Modules** status.
- **Settings UI Sync**: Loading a profile now immediately updates the Module Settings list in the UI to reflect the loaded configuration.

### Changed
- **Enhanced Reset**: The "Reset ALL Prompts" button now also resets the module layout order and re-enables all stock modules to factory defaults.

## [1.2.5] - 2026-04-23

### Added
- **Hit Dice Tracking (HD)**: Added a new `HD` field for Characters and Party members.
  - Renders as high-fidelity gold pips (`[ dX ] 🔵🔵⚪`) to differentiate from blue spell slots.
  - Automatically included in default system prompts.
- **Last Rest Time Engine**: The `[TIME]` section now supports a `Last Rest:` field.
  - The UI dynamically calculates and displays the time elapsed (e.g., "10 hours ago") relative to the current game time.
- **Improved Prompt Clarity**: Refined prompt instructions for Time, Inventory, and HP to be more authoritative and direct.

## [1.2.4] - 2026-04-23

### Added
- **Combat-First Layout**: The `[COMBAT]` section now defaults to the top of the UI for quicker access during encounters.
- **Enhanced Entity Detail**: The `Other:` and `Resistances:` fields in Combat, Character, and Party blocks now utilize the interactive **Unit Pill** system.
  - Descriptions in parentheses now appear as glassmorphism tooltips.
  - Consistent styling across all entity-based data fields.

### Changed
- **Refactored Renderer**: Centralized the pill rendering logic to ensure uniform behavior across all framework sections.

## [1.2.3] - 2026-04-23

### Added
- **Native Auto-Updates**: Enabled native SillyTavern auto-update support. The extension will now automatically notify you of new updates in the UI and can be updated with a single click from the Extensions menu.

### Fixed
- **Standardized Spell UI**: Completely refactored the spell display format across the [PARTY] and [SPELLS] blocks.
  - Spells are now displayed using a low-cognition format (one line per spell level).
  - Fixed a grid-overflow bug in the PARTY UI that caused long spell names to stack vertically or clip.
  - Unified the horizontal-flowing pill layout for all spell levels.

### Changed
- **Manifest Update**: Optimized `manifest.json` for better integration with SillyTavern's third-party extension tracking.

## [2026-04-22] - UI & XP Enhancements

### Added
- **Character Level in XP Section**: Added character level display to the [XP] block, showing both level and experience progress in a single unified UI row.
- **Resource Depletion Logic**: The DM now strictly monitors resource usage. If a player attempts to use an ability or spell with 0 uses remaining, the DM will pause the narrative and request a different action.
- **Combat Field Expansion**: Enemies now track "Other" properties (Resistances, Immunities, Special Traits) with dedicated styling in the HUD.

### Changed
- **XP Block Prompting**: Updated the State Model prompts to ensure level tracking is maintained alongside experience points.
- **Support for Hybrid Formatting**: The UI now supports both `XP: current/max` and `Level: X | XP: current/max` formats for backward compatibility.
- **Interactive Unit Pills**: Standardized the **Traits** and **Abilities** sections into interactive "Unit Pills."
- **Tooltip System 2.0**: Descriptions are now revealed in a glassmorphism hover bubble that does not cause layout shifts (fixing the edge-of-screen "flashing" bug).
- **CSS Iconography**: Replaced distorted unicode characters with perfectly circular, CSS-drawn info icons (ⓘ).
- **Smart Parsing**: Implemented a stack-based parser to correctly handle complex traits and abilities that contain internal commas.
- **Global Deselect**: Clicking any empty space on the tracker now automatically closes any open interactive elements.

## [2026-04-21] - Rebranding & Physics Integration
- **Framework Rebranding**: Renamed from RPG Tracker to **Fatbody D&D Framework**.
- **RNG Physics Engine**: Integrated the Prompt Injection RNG system for transparent, physics-based rolling.
- **HUD Controls**: Added "SYSPROMPT" and "RNG" toggle buttons directly to the tracker panel.
- **Optimized Layout**: Reordered sections to prioritize Character and Combat status over meta-stats like XP and Time.
- **Factory Reset**: Added a "Factory Reset" button to the settings panel for easy recovery of default prompts.
