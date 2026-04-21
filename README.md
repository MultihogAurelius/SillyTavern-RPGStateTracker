**⚠️ (NOTE: if you're updating, reset all prompts to default in the settings, or they won't update.) ⚠️**

# Fatbody D&D Framework (SillyTavern Extension)

**Fatbody D&D Framework** (formerly RPG State Tracker) is a comprehensive extension for SillyTavern designed to seamlessly extract and maintain RPG states from your roleplay narrative. It operates as a distinct "State Model" pass in a two-model simulation pipeline, decoupling creative narrative generation from rigorous, mechanical state management.

The State Model functions both as a "cheat sheet" for the AI as well as a UI for the user. It decouples the narrative AI from having to keep track of the user's inventory, HP, and world variables.

## Features

- **Integrated RNG Physics Engine:** Now built-in! Dice roll queues (D20, D4, D6, etc.) are automatically injected into your outgoing prompt. This provides a deterministic "physics buffer" that ensures 100% reliable luck for your narrative engine without latency or tool-calling failure.
- **Dynamic State Extraction:** Analyzes the narrative output and updates a structured "State Memo" behind the scenes without polluting the chat log.
- **Modular & Custom Fields:** Logic is segmented into specific modules using `[TAG]...[/TAG]` blocks.
  - The extension provides customizable stock fields: `[CHARACTER]`, `[PARTY]`, `[COMBAT]`, `[INVENTORY]`, `[ABILITIES]`, and `[SPELLS]`.
  - **Custom Fields:** Define entirely new, arbitrary tags (e.g., `[QUESTS]`, `[RELATIONSHIPS]`). Assign them custom emoji icons, specific rendering styles (HP bars, pips, line-items, or pills), and unique extraction prompt logic.
  - **Editable Logic:** The prompt instruction for every field can be edited in settings to fit your campaign's rules.
- **Rendered HUD:** A draggable, dynamic floating panel presenting the state as organized, paginated cards (with visual HP bars and spell slot pips). Toggle between "Rendered View" and "Raw View" at any time.
- **Snapshot History:** Maintains a rolling history of the last 5 state changes. Navigate back in time to view or restore past states.
- **Delta Change Log:** A resizeable logging panel showing a line-by-line diff (`+`/`-`) of what changed in the most recent turn.
- **Direct Prompt (💬):** Input custom instructions to directly manipulate state without feeding commands into the narrative context.
- **Archetype Onboarding:** Don't have a character sheet? Use the quick-start buttons to generate a random **Magic User**, **Melee Fighter**, or **Rogue** instantly.
- **SYSPROMPT Button:** Quickly copy the Narrator's system prompt (including combat and save rules) directly from the tracker footer.

<img width="597" height="1141" alt="image" src="https://github.com/user-attachments/assets/01137251-83d5-456b-9c6e-31163afb16b0" />

## Suggested Companions

This framework is highly optimized for complex play. For the complete experience, I recommend:

- **[Summaryception](https://github.com/Lodactio/Extension-Summaryception):** A brilliant summarizer/context compression extension to keep your focus sharp.
- **My System Prompt**: Click the `SYSPROMPT` button in the framework UI. It contains the logic/output rules this extension relies on to work properly, such as the time/status footer and buff temporal rules.

## Installation

1. Copy the `SillyTavern-RPGStateTracker` folder into your `SillyTavern/public/scripts/extensions/third-party/` directory.
   - Example path: `SillyTavern/public/scripts/extensions/third-party/SillyTavern-RPGStateTracker/index.js`
2. Refresh your SillyTavern browser tab.
3. Click the Extensions menu icon and configure **Fatbody D&D Framework** settings.

## Usage Guide

1. **Initial Setup:** Use the archetype buttons on the empty tracker to roll a new character, or paste an existing sheet into the "Raw View" (⊞).
2. **Auto-Tracking:** As you roleplay, the extension intelligently parses assistant responses. It detects losses of HP, new loot, or combat triggers, running background passes to update the state.
3. **Prompt Injection:** The State Memo and RNG Queue are injected seamlessly into your outgoing prompt. It acts as the "source of truth," assuring the model accurately remembers HP, inventory, and mechanical outcomes.
4. **Validation:** Use the Delta Log (δ) to verify changes. If the AI hallucinations, step backwards using the Snapshot Navigation (←/→) to restore a clean state.

## License
MIT

***

*AND YES, IT IS FULLY VIBE-CODED!*
