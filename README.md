**⚠️ IF THE 2.0.0+ UPDATE FAILS SOMEHOW, TRY CTRL + SHIFT + R. IF THAT FAILS, REINSTALL. YOU WILL NOT LOSE YOUR PROGRESS.**

**"Fatbody D&D gives you the Private Pyle experience."** —Gny. Sgt. Hartman

*A D&D-lite simulation engine for SillyTavern.*

What this framework does is essentially turn SillyTavern into something like AI Dungeon, but with actual mechanics/consequences. Losing or dying is actually a thing. In Big Rigs, you're always WINNER. Not in Fatbody D&D! 

I wasn't satisfied with any of the commercial offerings available (AI Realm, AI Dungeon, Friends & Fables, etc.,) so I made my own D&D platform inside SillyTavern. 

**Crucially, the system is input-output, not just some glorified stats collector. Your state info feeds back into the narrative AI.**

### The Fatbody D&D Framework involves three core components:

1. 🖥️ **RPG State Tracker** — Extracts and maintains HP, inventory, party, buffs, XP, spells, and more via a dedicated second-pass model. Injects a rolling State Memo back into each prompt to keep the AI (and you) on track.
2. 🎲 **Hybrid RNG System** — A dual-engine approach to tabletop physics. 
   - **RNG Queue (Combat)**: Pre-seeded deterministic dice injected into every turn for high-speed, zero-latency combat resolution, neatly within a single output. Sidesteps the unreliability and massive input token costs of tool chains.
   - **Tool Call RNG (Narrative)**: A proactive AI-driven rolling system for non-combat skill checks. Features a "Waterproof" commitment logic where the AI must declare a DC before seeing the result, preventing narrative sycophancy and cheating.
3. 🤖 **The Lorebook Agent** — This is a fully autonomous lorebook manager that creates, updates, activates and deactivates, deactivates lorebooks for you in the background. Handles the macroscopic consistency of your adventure. Also includes cleanup tools (consolidation, rewriting entries) that can be set to automatically run periodically.

Together they solve the three core problems of LLM tabletop RP: the AI forgeting your inventory/spells, the AI forgetting long-term context, and you always winning (aka. plot armor).  I have high confidence in the system's reliability—you can just play and not worry about tinkering with much of anything.

---

⚠️ **Updating?** To stay up to date after updating the extension, especially after updating to 2.0.0+, click on the "Update Main Sysprompt" button in the extension settings.

---

## Highlights

- **Dual-Engine Physics**: Deterministic queue for instant combat, and interactive tool calls for narrative skill checks.
- **Draggable HUD** with HP bars, spell pips, etc.
- **Automatic spell slot tracking** via 🔵 pips in the UI; never worry about remembering how many you have left.
- **Buff/debuff temporal decay** via [TIME] delta tracking; statuses expire automatically over time based on time elapsed.
- **Snapshot history + delta log** - easy rollback, and see at a glance what was changed in the state.
- **Auto model-switching** so that you can use a different model for tracking the state.
- **Full-context audit mode** in case you lose your state.
- **Custom fields, themes, reorderable sections**; track whatever you want beyond the stock fields and customize the visuals to your liking.
- **Automatic D&D wikidot spell links** - look up spells by clicking on them without awkward googling.
- **Mobile support** (open from the wand menu).
- **Talk to the tracker model directly via (💬)**, making editing or adding things easy.
- **Onboarding system** - roll up a random character or describe one to the model.
- **Profile saving** - switch between multiple campaigns without losing your state.
- **Homebrew-friendly** and flexible in general, relying on AI to do a lot of the lifting.
- **Automatic Long-Context Tracking** via the Lorebook Agent.

<div align="center">
  <figure>
    <img width="2800" height="auto" alt="image" src="https://github.com/user-attachments/assets/6eb8b2b6-d4f6-4fc8-9d34-988ad03331ba" />
    <figcaption>Yep, things can go wrong!</figcaption>
  </figure>
</div>

## Installation

**The packaged releases will likely not be up to date. I recommend cloning the repo or taking the steps below.**

1. Go to the SillyTavern extension menu.
2. Click on "Install extension" at the top.
3. Enter this repo's URL.

## Usage Guide

1. **Initial Setup:** Use the archetype buttons on the empty tracker to roll a new character, or paste an existing sheet into the "Raw View" (if your sheet doesn't align with what the UI expects, ask the model via 💬 to fix the formatting). Create a character card for your "narrator," such as Simulation Engine that I use. You can also name it something like Game Master.
2. **Auto-Tracking:** As you roleplay, the extension intelligently parses assistant responses. It detects losses of HP, new loot, or combat triggers, stitching together multi-part tool-call responses and running background passes to update the state.
3. **Prompt Injection & Execution:** The State Memo and RNG Queue are injected seamlessly into your outgoing prompt to act as the "source of truth." For narrative actions, the framework dynamically catches and resolves the AI's `RollTheDice` tool calls.
4. **Validation:** Use the Delta Log (δ) to verify changes. If the AI ever makes a mistake, step backwards using the Snapshot Navigation (←/→) to restore a clean state. Not really needed much in my experience, but the option is there.

## Basic Video Walkthrough of the RNG System
https://www.youtube.com/watch?v=1n5x7VBJ0IU

## Suggested Companions

- 🧠 **[Summaryception](https://github.com/Lodactio/Extension-Summaryception):** A brilliant summarizer/context compression extension. Also handy for crunching all the combat mechanics of the context into summarized history.

## Don't Care About D&D?

You can scrap the entire system prompt and all the default fields and track your own things completely. The D&D setup is just a plug & play system that works by default. 

## What Model to Use?
Your primary narrator model must support **Tool Calling** for the Hybrid RNG system to work properly. 

<img width="920" height="246" alt="image" src="https://github.com/user-attachments/assets/f663cb1e-554a-40a2-a25e-f7af62c1a032" />


I like Deepseek 4 a lot so far, though it's still a new model. Gemini 3 is a good all-rounder; very fast and cheap. Sometimes its pace can be a bit much, though. GLM 5.1 is also a solid choice, but it can tend to reason far too long, bogging things down, especially in combat. Experimentation with different models is recommended.

For the state pass, I use Gemini 3 Flash with low reasoning.

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
