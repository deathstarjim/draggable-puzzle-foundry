import { MODULE_ID, ITEM_FLAG_KEY } from "./constants.js";

function hasPuzzleFlag(item)
{
    try
    {
        const flag = item?.getFlag?.(MODULE_ID, ITEM_FLAG_KEY) ?? item?.getFlag?.(MODULE_ID, "puzzle");
        return flag && typeof flag === "object";
    } catch
    {
        return false;
    }
}

/**
 * Intercept Item Directory opens for puzzle Items to avoid system sheet errors.
 * Double-clicking a puzzle Item opens the module config window for that Item.
 */
export function registerPuzzleHooks()
{
    Hooks.on("renderItemDirectory", (app, html) =>
    {
        try
        {
            const root = html?.[0];
            if (!root?.querySelectorAll) return;

            root.querySelectorAll(".directory-item").forEach((li) =>
            {
                li.addEventListener(
                    "dblclick",
                    async (event) =>
                    {
                        try
                        {
                            const uuid = li?.dataset?.uuid;
                            const id = li?.dataset?.documentId;
                            const item = uuid ? await fromUuid(uuid) : (id ? game.items?.get(id) : null);
                            if (!item) return;
                            if (!hasPuzzleFlag(item)) return;

                            event.preventDefault();
                            event.stopPropagation();

                            await game.draggablePuzzle?.openConfigForItem?.(item.uuid);
                        } catch
                        {
                            // ignore
                        }
                    },
                    { capture: true }
                );
            });
        } catch
        {
            // ignore
        }
    });
}

Hooks.once("ready", () => registerPuzzleHooks());
