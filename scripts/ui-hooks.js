import { MODULE_ID } from "./constants.js";

function unwrapHtml(html)
{
    // Foundry hooks sometimes pass a jQuery object, sometimes a raw HTMLElement.
    if (!html) return null;
    if (html instanceof HTMLElement) return html;
    const el = html?.[0];
    return el instanceof HTMLElement ? el : null;
}

function notifyMissingApi()
{
    ui.notifications?.warn?.("Draggable Puzzle: API not ready yet.");
}

function makeButton({ label, icon, onClick } = {})
{
    const button = document.createElement("button");
    button.type = "button";
    button.classList.add("dp-ui-button");
    button.innerHTML = `<i class="${icon}"></i> ${label}`;
    button.addEventListener("click", (event) =>
    {
        event.preventDefault();
        event.stopPropagation();
        try { onClick?.(); } catch (e) { console.error("Draggable Puzzle | UI button failed", e); }
    });
    return button;
}

function makeHeaderControl({ label, icon, onClick } = {})
{
    const a = document.createElement("a");
    a.classList.add("header-control");
    a.setAttribute("role", "button");
    a.innerHTML = `<i class="${icon}"></i> ${label}`;
    a.addEventListener("click", (event) =>
    {
        event.preventDefault();
        event.stopPropagation();
        try { onClick?.(); } catch (e) { console.error("Draggable Puzzle | UI control failed", e); }
    });
    return a;
}

function findItemsInjectionTarget(root)
{
    if (!root?.querySelector) return null;

    return root.querySelector(".directory-header .header-actions")
        ?? root.querySelector(".directory-header .action-buttons")
        ?? root.querySelector(".directory-header")
        ?? root.querySelector(".directory-footer")
        ?? root.querySelector(".directory-list")
        ?? root;
}

function injectCreatePuzzleButton(root)
{
    if (!game.user?.isGM) return;
    if (!root) return;

    // Avoid duplicate injection across re-renders
    if (root.querySelector?.(".dp-create-puzzle")) return;

    const target = findItemsInjectionTarget(root);
    if (!target) return;

    // Prefer matching Foundry directory header control styling.
    const button = makeHeaderControl({
        label: "Create Puzzle",
        icon: "fas fa-puzzle-piece",
        onClick: async () =>
        {
            if (!game.draggablePuzzle?.createPuzzleItem || !game.draggablePuzzle?.openConfigForItem)
                return notifyMissingApi();

            const item = await game.draggablePuzzle.createPuzzleItem({}, { name: "Puzzle" });
            if (!item) return;
            await game.draggablePuzzle.openConfigForItem(item.uuid);
        }
    });

    button.classList.add("dp-create-puzzle");
    target.appendChild(button);
}

/**
 * Add a GM-only "Create Puzzle" button to the Items directory.
 */
Hooks.on("renderItemDirectory", (app, html) =>
{
    try
    {
        injectCreatePuzzleButton(unwrapHtml(html));
    } catch (error)
    {
        console.error("Draggable Puzzle | Failed to inject Item Directory button", error);
    }
});

// Some systems/themes may render the Items sidebar via generic sidebar hooks.
Hooks.on("renderSidebarTab", (app, html) =>
{
    try
    {
        const tabName = app?.tabName ?? app?.options?.id ?? app?.id;
        if (tabName !== "items") return;
        injectCreatePuzzleButton(unwrapHtml(html));
    } catch
    {
        // ignore
    }
});

/**
 * Add Tile Controls tools for opening the puzzle UI and config UI.
 */
Hooks.on("getSceneControlButtons", (controls) =>
{
    try
    {
        const tiles = controls?.find?.(c => c?.name === "tiles" || c?.layer === "tiles");
        if (!tiles) return;

        tiles.tools = tiles.tools ?? [];

        // Avoid duplicates on hot reload
        if (tiles.tools.some(t => t?.name === "dp-open")) return;

        tiles.tools.push({
            name: "dp-open",
            title: "Open Draggable Puzzle",
            icon: "fas fa-puzzle-piece",
            visible: true,
            onClick: () =>
            {
                const fn = game.draggablePuzzle?.openSavedPuzzle ?? game.draggablePuzzle?.openPuzzle;
                if (!fn) return notifyMissingApi();
                void fn();
            }
        });

        tiles.tools.push({
            name: "dp-config",
            title: "Draggable Puzzle Config",
            icon: "fas fa-sliders-h",
            visible: Boolean(game.user?.isGM),
            onClick: () =>
            {
                const fn = game.draggablePuzzle?.openSavedConfig ?? game.draggablePuzzle?.openConfig;
                if (!fn) return notifyMissingApi();
                void fn();
            }
        });

    } catch (error)
    {
        console.error("Draggable Puzzle | Failed to add scene controls", error);
    }
});

Hooks.once("ready", () =>
{
    console.debug?.(`${MODULE_ID} | UI hooks ready`);
});
