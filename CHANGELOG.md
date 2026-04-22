# Changelog

All notable changes to the **Fatbody D&D Framework** will be documented in this file.

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