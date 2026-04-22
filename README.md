**"Fatbody D&D gives you the Private Pyle experience."** —Gny. Sgt. Hartman

*A D&D-lite simulation engine for SillyTavern.*

What this framework does is essentially turn SillyTavern into something like AI Dungeon, but with actual mechanics/consequences! Losing or dying is actually a thing.

### The Fatbody D&D Framework involves three core components:

1. 🖥️ **RPG State Tracker** — Extracts and maintains HP, inventory, party, buffs, XP, spells, and more via a dedicated second-pass model. Injects a rolling State Memo back into each prompt to keep the AI (and you) on track.
2. :game_die: **Context Injection RNG** — Feeds a pre-seeded deterministic dice queue into every turn. More reliable than tool calls, zero-latency, and works seamlessly across combat and non-combat in the same context. Do anything in combat, be creative; there are no rigid constraints like dedicated combat modes have, but you are still impacted by the gravity of the dice and your stats/skills.
3. :scroll: **sysprompt.txt** — Required for the AI to understand the RNG system, buff/temporal logic, resistance/vulnerability/immunity, level-up, and consistent output structure. Plug & play, but modify at will. Can also be copied from the UI.

Together they solve the two core problems of LLM tabletop RP: the AI forgets your inventory, spells, etc., and you always winning (aka. plot armor.)

:warning: **Updating?** Reset all prompts to default in settings or they won't update. Also apply new `sysprompt.txt` into Quick Prompts Edit "Main."

## Features

- **Modular & Custom Fields:** Logic is segmented into specific modules using `[TAG]...[/TAG]` blocks.
  - The extension provides customizable stock fields such as: `[CHARACTER]`, `[PARTY]`, `[COMBAT]`, `[INVENTORY]`, `[ABILITIES]`, and `[SPELLS]`.
  - **Custom Fields:** Define entirely new, arbitrary tags (e.g., `[QUESTS]`, `[RELATIONSHIPS]`). Assign them custom emoji icons, specific rendering styles (HP bars, pips, line-items, or pills), and unique extraction prompt logic.
  - **Editable Logic:** The prompt instruction for every field can be edited in settings to fit your campaign's rules.
- **Rendered HUD:** A draggable, dynamic floating panel presenting the state as organized, paginated cards (with visual HP bars and spell slot pips). Toggle between "Rendered View" and "Raw View" at any time.
- **Snapshot History:** Maintains a rolling history of the last 5 state changes. Navigate back in time to view or restore past states.
- **Delta Change Log:** A resizeable logging panel showing a line-by-line diff (`+`/`-`) of what changed in the most recent turn.
- **Direct Prompt (💬):** Input custom instructions to directly manipulate state without feeding commands into the narrative context. Add/remove spells or abilities, create characters, add party members, fix formatting, level up. The AI will edit everything for you.
- **Archetype Onboarding:** Don't have a character sheet? Use the quick-start buttons to generate a random **Magic User**, **Melee Fighter**, or **Rogue** instantly.
- **SYSPROMPT Button:** Quickly copy the Narrator's system prompt (including combat and save rules) directly from the tracker footer.
- **Mobile Support:** Continue where you left off on your phone. Host your session with the Remote-Link .bat file in the ST directory, and play on the bus.
- **Real-Time Buff Tracking:** Buff/debuff temporal decay via [TIME] delta tracking.

<img width="2138" height="1367" alt="image" src="https://github.com/user-attachments/assets/6eb8b2b6-d4f6-4fc8-9d34-988ad03331ba" />



## Suggested Companions

- 🧠 **[Summaryception](https://github.com/Lodactio/Extension-Summaryception):** A brilliant summarizer/context compression extension. Also handy for crunching all the combat mechanics of the context into summarized history.

## Installation

1. Go to SillyTavern extension menu.
2. Click on "Install extension" at the top.
3. Enter this repo's URL.

## Usage Guide

1. **Initial Setup:** Use the archetype buttons on the empty tracker to roll a new character, or paste an existing sheet into the "Raw View" (⊞) (if your sheet doesn't align with what the UI expects, ask the model via 💬 to fix the formatting.) Create a character card for your "narrator," such as Simulation Engine that I use. You can also name it something like Game Master.
2. **Auto-Tracking:** As you roleplay, the extension intelligently parses assistant responses. It detects losses of HP, new loot, or combat triggers, running background passes to update the state.
3. **Prompt Injection:** The State Memo and RNG Queue are injected seamlessly into your outgoing prompt. It acts as the "source of truth," assuring the model accurately remembers HP, inventory, and mechanical outcomes.
4. **Validation:** Use the Delta Log (δ) to verify changes. If the AI ever makes a mistake, step backwards using the Snapshot Navigation (←/→) to restore a clean state.

## License
MIT

***

*AND YES, IT IS FULLY VIBE-CODED IN ANTIGRAVITY!*
