# draggable-puzzle-foundry
This is a module for FoundryVTT that allows a GM to create a draggable tile puzzle.

## Install (Manifest URL)

Use this URL in Foundry's "Install Module" dialog:

https://github.com/deathstarjim/draggable-puzzle-foundry/releases/latest/download/module.json

## Manual release checklist

1. Bump `version` in `module.json`.
2. Build `module.zip` with `module.json` at the ZIP root (not inside a parent folder).
3. Create a GitHub release tag matching the same version (for example `0.1.1`).
4. Upload both release assets named exactly:
	- `module.json`
	- `module.zip`

Foundry reads `download` from `module.json`; if that field is empty or if `module.zip` is missing, installation fails.
