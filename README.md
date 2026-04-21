**"Fatbody D&D gives you the Private Pyle experience."** —Gny. Sgt. Hartman

*A D&D-lite simulation engine for SillyTavern.*

What this framework does is essentially turn SillyTavern into something like AI Dungeon, but with actual mechanics/consequences! Losing or dying is actually a thing.

:warning: **Updating?** Reset all prompts to default in settings or they won't update. Also apply new `sysprompt.txt` into Quick Prompts Edit "Main."

### The Fatbody D&D Framework involves three core components:

1. 🖥️ **RPG State Tracker** — Extracts and maintains HP, inventory, party, buffs, XP, spells, and more via a dedicated second-pass model. Injects a rolling State Memo back into each prompt to keep the AI (and you) on track.
2. :game_die: **Context Injection RNG** — Feeds a pre-seeded deterministic dice queue into every turn. More reliable than tool calls, zero-latency, and works seamlessly across combat and non-combat in the same context. Do anything in combat, be creative; there are no rigid constraints like dedicated combat modes have, but you are still impacted by the gravity of the dice and your stats/skills.
3. :scroll: **sysprompt.txt** — Required for the AI to understand the RNG system, buff/temporal logic, RVI damage, level-up, and consistent output structure. Plug & play, but modify at will. Can also be copied from the UI.

Together they solve the two core problems of LLM tabletop RP: the AI forgets your inventory, spells, etc., and you always win.

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
- **Mobile Support:** Continue where you left off on your phone. Host your session with the Remote-Link .bat file in the ST directory, and play on the bus.

<img width="2154" height="1374" alt="Screenshot 2026-04-21 203412" src="https://github.com/user-attachments/assets/ba716910-401f-4e98-9836-5ae68510b43f" />


## Suggested Companions

This framework is highly optimized for complex play. For the complete experience, I recommend:

- 🧠 **[Summaryception](https://github.com/Lodactio/Extension-Summaryception):** A brilliant summarizer/context compression extension. Also handy for crunching all the combat mechanics of the context into summarized history.
- 📜 **My System Prompt**: Click the `SYSPROMPT` button in the framework UI. It contains the logic/output rules this extension relies on to work properly, such as integration with the RNG system, the time/status footer, and buff temporal rules.

## Installation

1. Copy the `SillyTavern-FatbodyDnDFramework` folder into your `SillyTavern/public/scripts/extensions/third-party/` directory.
2. Refresh your SillyTavern browser tab.
3. Click the Extensions menu icon and configure **Fatbody D&D Framework** settings.

## Usage Guide

1. **Initial Setup:** Use the archetype buttons on the empty tracker to roll a new character, or paste an existing sheet into the "Raw View" (⊞) (if your sheet doesn't align with what the UI expects, ask the model via 💬 to fix the formatting.) Create a character card for your "narrator," such as Simulation Engine that I use. You can also name it something like Game Master.
2. **Auto-Tracking:** As you roleplay, the extension intelligently parses assistant responses. It detects losses of HP, new loot, or combat triggers, running background passes to update the state.
3. **Prompt Injection:** The State Memo and RNG Queue are injected seamlessly into your outgoing prompt. It acts as the "source of truth," assuring the model accurately remembers HP, inventory, and mechanical outcomes.
4. **Validation:** Use the Delta Log (δ) to verify changes. If the AI hallucinations, step backwards using the Snapshot Navigation (←/→) to restore a clean state.

NOTE: the AI does not need any particular kind of formatting to understand the State Memo, but for the UI to show up properly, a template has to be followed. The AI has awareness of all of these templates and outputs them automatically when recording memos.

## License
MIT

***

*AND YES, IT IS FULLY VIBE-CODED IN ANTIGRAVITY!*
