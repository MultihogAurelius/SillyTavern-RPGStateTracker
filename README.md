**"Fatbody D&D gives you the Private Pyle experience."** —Gny. Sgt. Hartman

*A D&D-lite simulation engine for SillyTavern.*

What this framework does is essentially turn SillyTavern into something like AI Dungeon, but with actual mechanics/consequences. Losing or dying is actually a thing. In Big Rigs, you're always WINNER. Not in Fatbody D&D! 

I wasn't satisfied with any of the commercial offerings available (AI Realm, AI Dungeon, Friends & Fables, etc.,) so I made my own D&D platform inside SillyTavern. 

### The Fatbody D&D Framework involves three core components:

1. 🖥️ **RPG State Tracker** — Extracts and maintains HP, inventory, party, buffs, XP, spells, and more via a dedicated second-pass model. Injects a rolling State Memo back into each prompt to keep the AI (and you) on track.
2. :game_die: **Context Injection RNG** — Feeds a pre-seeded deterministic dice queue into every turn. More reliable than tool calls, zero-latency, and works seamlessly across combat and non-combat in the same context. Do anything in combat, be creative; there are no rigid constraints like dedicated combat modes have, but you are still impacted by the gravity of the dice and your stats/skills.
3. :scroll: **sysprompt.txt** — Required for the AI to understand the RNG system, buff/temporal logic, resistance/vulnerability/immunity, level-up, and consistent output structure. Plug & play, but modify at will. Can also be copied from the UI.

Together they solve the two core problems of LLM tabletop RP: the AI forgets your inventory, spells, etc., and you always winning (aka. plot armor.) I have high confidence in the system's reliability, that you can just play and not worry about tinkering with much of anything.

:warning: **Updating?** Reset all prompts to default in settings or they won't update. Also apply new `sysprompt.txt` into Quick Prompts Edit "Main."

⚠️**NOTE: if you close the UI window, it can be reopened from the wand menu.**

## Installation

**The packaged releases will likely not be up to date. I recommend cloning the repo or taking the steps below.**

1. Go to SillyTavern extension menu.
2. Click on "Install extension" at the top.
3. Enter this repo's URL.

## Highlights

- **Draggable HUD** with HP bars, spell pips, etc.
- **Automatic spell slot tracking** via 🔵 pips in the UI; never worry about remembering how many you have left
- **Buff/debuff temporal decay** via [TIME] delta tracking; statuses expire automatically over time based on time elapsed
- **Snapshot history + delta log** - easy rollback, and see at a glance what was changed in the state
- **Auto model-switching** so that you can use a different model for tracking the state
- **Full-context audit mode** in case you lose your state
- **Custom fields, themes, reorderable sections**; track whatever you want, beyond the stock fields
- **Automatic D&D wikidot spell links** - look up spells by clicking on them without awkward googling
- **Mobile support** (open from the wand menu)
- **Talk to the tracker model directly via (💬)**, making editing or adding things easy
- **Onboarding system** - roll up a random character or describe one to the model
- **Profile saving** - switch between multiple campaigns without losing your state
- **Homebrew-friendly** and flexible in general, relying on AI to do a lot of the lifting

<div align="center">
  <figure>
    <img width="2800" height="auto" alt="image" src="https://github.com/user-attachments/assets/6eb8b2b6-d4f6-4fc8-9d34-988ad03331ba" />
    <figcaption>Yep, things can go wrong!</figcaption>
  </figure>
</div>

## Suggested Companions

- 🧠 **[Summaryception](https://github.com/Lodactio/Extension-Summaryception):** A brilliant summarizer/context compression extension. Also handy for crunching all the combat mechanics of the context into summarized history.

## Usage Guide

1. **Initial Setup:** Use the archetype buttons on the empty tracker to roll a new character, or paste an existing sheet into the "Raw View" (if your sheet doesn't align with what the UI expects, ask the model via 💬 to fix the formatting.) Create a character card for your "narrator," such as Simulation Engine that I use. You can also name it something like Game Master.
2. **Auto-Tracking:** As you roleplay, the extension intelligently parses assistant responses. It detects losses of HP, new loot, or combat triggers, running background passes to update the state.
3. **Prompt Injection:** The State Memo and RNG Queue are injected seamlessly into your outgoing prompt. It acts as the "source of truth," assuring the model accurately remembers HP, inventory, and mechanical outcomes.
4. **Validation:** Use the Delta Log (δ) to verify changes. If the AI ever makes a mistake, step backwards using the Snapshot Navigation (←/→) to restore a clean state. Not really needed in my experience much, but the option is there.

## Don't Care About D&D?

You can scrap the entire system prompt and all the default fields and track your own things completely. The D&D setup is just a plug & play system that works by default. 

## What Model to Use?
I mostly use Gemini 3 Flash. A good all-rounder; very fast and cheap. GLM 5.1 is also a solid choice, but it can tend to reason far too long, bogging things down, especially combat. Experimentation with different models is recommended.

For the state pass, I use Gemini 3 Flash with medium reasoning.

<div align="center">
  <figure>
    <img width="2800" height="auto" alt="image" src="https://github.com/user-attachments/assets/a0e1c88c-092f-488b-b421-48cabe09e6e2" />
    <figcaption>Some combat in progress</figcaption>
  </figure>
</div>

## License
MIT

***

*AND YES, IT IS FULLY VIBE-CODED IN ANTIGRAVITY!*
