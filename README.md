# RPG Tracker (SillyTavern Extension)

RPG Tracker is an extension for SillyTavern designed to seamlessly extract and maintain RPG states (character stats, party status, combat states, inventory, abilities, spells, and anything else through custom fields) from your roleplay narrative. It operates as a distinct "State Model" pass in a two-model simulation pipeline, decoupling creative narrative generation from rigorous, mechanical state management.

The State Model functions both as a "cheat sheet" for the AI as well as a UI for the user. It decouples the narrative AI from having to keep track of the user's inventory and other variables.

## Features

- **Dynamic State Extraction:** Analyzes the narrative output and updates a structured "State Memo" behind the scenes without polluting the chat log.
- **Modular & Custom Fields:** Logic is segmented into specific modules using `[TAG]...[/TAG]` blocks.
  - The extension provides customizable stock fields: `[CHARACTER]`, `[PARTY]`, `[COMBAT]`, `[INVENTORY]`, `[ABILITIES]`, and `[SPELLS]`.
  - **Custom Fields:** You can define entirely new, arbitrary tags (e.g., `[QUESTS]`, `[RELATIONSHIPS]`). Assign them custom emoji icons, specific rendering styles (like HP bars, pips, line-items, or pills), and unique extraction prompt logic.
  - **Editable Logic:** The prompt instruction for every field (even the stock ones) can be freely edited from extension settings to fit the exact rules of your campaign.
- **Rendered HUD:** A draggable, dynamic floating panel presenting the state as organized, paginated cards (with visual HP bars and spell slot pips). You can effortlessly toggle between this "Rendered View" and a text-based "Raw View".
- **Snapshot History:** Maintains a rolling history of the last 5 state changes. You can navigate back in time to view past states and restore them if the AI makes a mistake.
- **Delta Change Log:** A resizeable logging panel showing a line-by-line diff (`+`/`-`) of what the Model modified in the most recent turn.
- **Direct Prompt (💬):** Input custom instructions to directly manipulate the state (e.g., initial character creation or manual additions) without feeding the command into the narrative context.
- **Connection Integration:** Leverages SillyTavern's connection profiles and presets system. It can automatically switch to a different model/preset just for the state extraction pass, and revert back to your preferred creative model for the next narrative response. Useful, since many prefer using a non-reasoning model for narrative output, but a reasoning model will likely be more reliable when extracting the state/memo information from the output.

## Suggested Companions

This extension is designed to work as one half of a two-part simulation system. For the complete experience, it is highly recommended to use:

- **[Prompt Injection RNG](https://github.com/MultihogAurelius/Context-Injection-RNG-for-DnD):** This extension injects a deterministic queue of pre-rolled dice (D20, D4, D6, etc.) into the prompt. While **RPG Tracker** maintains the results (your HP, level, and items), **Prompt Injection RNG** provides the "luck" required for the narrative engine to decide those outcomes without manual player intervention.

## Installation

1. Copy the `RPG Tracker` folder into your `SillyTavern/public/scripts/extensions/third-party/` directory.
   - Example path: `SillyTavern/public/scripts/extensions/third-party/RPG Tracker/index.js`
2. Refresh your SillyTavern browser tab.
3. Click the Extensions menu block icon and configure **RPG Tracker** settings to attach a connection profile and enable your desired tracking modules.

## Usage Guide

1. **Initial Setup:** If your tracker is empty, you can either paste an existing character sheet into the "Raw View" (⊞), or use the Direct Prompt (💬) at the top of the tracker HUD to instruct the model (e.g., *"Create a Level 1 Human Necromancer with a Quarterstaff and Robes; give them a suitable set of spells for a Level 1 character and a set of skills."*).
2. **Auto-Tracking:** As you roleplay, the extension intelligently parses the assistant's responses. It detects things like losing HP, gaining items, or entering combat, triggering a background Generation Pass to update the State Memo.
3. **Prompt Injection:** The meticulously tracked State Memo is injected seamlessly into the outgoing prompt as prior context. It acts as the "source of truth", assuring the narrative model accurately "remembers" HP, inventory, statuses, and other factors (depending on the active fields.)
4. **Validation:** Use the Delta Log (δ) to verify what the system changed. If the underlying State Model hallucinates or makes an error, you can use the Snapshot Navigation arrows at the bottom left of the HUD to step backwards and restore the previous state.

## System Prompt Customization

By default, the RPG Tracker comes with a generalized prompt that tries to parse standard roleplay logs. It may or may not work out of the box for your particular setup, but if you do anything D&D-adjacent, it probably will.

## License
MIT

***

AND YES, IT IS FULLY VIBE-CODED!
