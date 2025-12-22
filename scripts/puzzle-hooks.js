import { MODULE_ID, ITEM_FLAG_KEY } from "./constants.js";

function unwrapHtml(html)
{
    if (!html) return null;
    if (html instanceof HTMLElement) return html;
    const el = html?.[0];
    return el instanceof HTMLElement ? el : null;
}

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
    const redirecting = new Set();

    async function openPuzzleItemConfigFromLi(li, event)
    {
        try
        {
            const uuid = li?.dataset?.uuid || li?.dataset?.documentUuid || li?.dataset?.entryUuid;
            const id = li?.dataset?.documentId || li?.dataset?.documentID || li?.dataset?.entryId;
            const item = uuid ? await fromUuid(uuid) : (id ? game.items?.get(id) : null);
            if (!item) return false;
            if (!hasPuzzleFlag(item)) return false;

            event?.preventDefault?.();
            event?.stopPropagation?.();

            await game.draggablePuzzle?.openConfigForItem?.(item.uuid);
            return true;
        } catch
        {
            return false;
        }
    }

    Hooks.on("renderItemDirectory", (app, html) =>
    {
        try
        {
            const root = unwrapHtml(html);
            if (!root?.querySelectorAll) return;

            root.querySelectorAll(".directory-item").forEach((li) =>
            {
                li.addEventListener(
                    "dblclick",
                    async (event) =>
                    {
                        void openPuzzleItemConfigFromLi(li, event);
                    },
                    { capture: true }
                );

                // Some systems/themes open sheets via click handlers; handle double-click
                // as a click event with detail===2.
                li.addEventListener(
                    "click",
                    async (event) =>
                    {
                        if (event?.detail !== 2) return;
                        void openPuzzleItemConfigFromLi(li, event);
                    },
                    { capture: true }
                );

                // Also intercept clicks on the item name/link if present.
                const nameEl = li.querySelector(".document-name, .item-name, .entry-name, a");
                if (nameEl)
                {
                    nameEl.addEventListener(
                        "click",
                        async (event) =>
                        {
                            if (event?.detail !== 2) return;
                            void openPuzzleItemConfigFromLi(li, event);
                        },
                        { capture: true }
                    );
                }
            });
        } catch
        {
            // ignore
        }
    });

    // Safety-net: if the system opens a sheet (e.g. dnd5e Loot sheet) for a puzzle Item,
    // immediately redirect to the module's config UI.
    async function redirectItemSheet(sheet)
    {
        try
        {
            if (!game.user?.isGM) return;
            const item = sheet?.document;
            if (!item) return;
            if (!hasPuzzleFlag(item)) return;

            // Prevent loops if a system re-renders.
            const key = String(item.uuid ?? item.id ?? "");
            if (!key) return;
            if (redirecting.has(key)) return;
            redirecting.add(key);
            setTimeout(() => redirecting.delete(key), 1000);

            // Close the system sheet and open our editor.
            setTimeout(async () =>
            {
                try { await sheet.close({ submit: false }); } catch { /* ignore */ }
                try { await game.draggablePuzzle?.openConfigForItem?.(item.uuid); } catch { /* ignore */ }
            }, 0);
        } catch
        {
            // ignore
        }
    }

    // Hook-name fallbacks (Foundry core + common dnd5e sheet names)
    Hooks.on("renderItemSheet", (sheet) => void redirectItemSheet(sheet));
    Hooks.on("renderItemSheet5e", (sheet) => void redirectItemSheet(sheet));
    Hooks.on("renderItemSheet5e2", (sheet) => void redirectItemSheet(sheet));
    Hooks.on("renderItemSheet5eLegacy", (sheet) => void redirectItemSheet(sheet));
}

Hooks.once("ready", () => registerPuzzleHooks());
