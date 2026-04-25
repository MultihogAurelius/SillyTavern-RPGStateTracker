# Changelog

All notable changes to the **Fatbody D&D Framework** will be documented in this file.

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
