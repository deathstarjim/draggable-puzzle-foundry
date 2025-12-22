const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

function worldUploadTarget()
{
    const worldId = game.world?.id ?? game.world?.name ?? "world";
    return `worlds/${worldId}/draggable-puzzle`;
}

async function ensureWorldUploadDir()
{
    try
    {
        await FilePicker.createDirectory("data", worldUploadTarget(), { notify: false });
    } catch
    {
        // Directory might already exist or the user may not have permission.
    }
}

function isImageFile(file)
{
    if (!file?.name) return false;
    return /\.(png|jpe?g|webp|gif|svg)$/i.test(file.name);
}

function getDocumentImage(doc)
{
    if (!doc) return "";

    // Most documents
    const direct = doc.img;
    if (typeof direct === "string" && direct.trim()) return direct.trim();

    // Actors often have a token texture
    const tokenTex = doc.prototypeToken?.texture?.src;
    if (typeof tokenTex === "string" && tokenTex.trim()) return tokenTex.trim();

    // Some documents may expose texture directly
    const texture = doc.texture?.src;
    if (typeof texture === "string" && texture.trim()) return texture.trim();

    return "";
}

async function resolveDroppedDocument(raw)
{
    if (!raw) return null;

    let data;
    try { data = JSON.parse(raw); } catch { return null; }

    const uuid = data?.uuid ?? data?.documentUuid ?? null;
    if (uuid && typeof uuid === "string")
    {
        try { return await fromUuid(uuid); } catch { return null; }
    }

    // Compendium drops sometimes provide pack + id
    const pack = data?.pack;
    const id = data?.id;
    if (pack && id)
    {
        try
        {
            const collection = game.packs?.get?.(pack);
            if (!collection) return null;
            return await collection.getDocument(id);
        } catch
        {
            return null;
        }
    }

    return null;
}

function parseSolutionText(text)
{
    return String(text ?? "")
        .split(",")
        .map(s => s.trim())
        .filter(Boolean);
}

function deepClone(obj)
{
    return foundry.utils.deepClone ? foundry.utils.deepClone(obj) : JSON.parse(JSON.stringify(obj));
}

function hyphenateId(text)
{
    return String(text ?? "")
        .trim()
        .replace(/\s+/g, "-");
}

function ensureUniqueTileId(baseId, tiles, excludeIndex)
{
    const normalizedBase = baseId || "tile";
    const used = new Set(
        (tiles ?? [])
            .map((t, index) => (index === excludeIndex ? null : t?.id))
            .filter(Boolean)
    );

    if (!used.has(normalizedBase)) return normalizedBase;

    let suffix = 2;
    while (used.has(`${normalizedBase}-${suffix}`)) suffix += 1;
    return `${normalizedBase}-${suffix}`;
}

export class PuzzleConfigApplication extends HandlebarsApplicationMixin(ApplicationV2) {
    constructor({ getConfig, setConfig, onPreview, onSaved } = {})
    {
        super({});
        this._getConfig = getConfig;
        this._setConfig = setConfig;
        this._onPreview = onPreview;
        this._onSaved = onSaved;

        this._working = deepClone(this._getConfig?.() ?? {});
        this._newTile = {
            id: "",
            label: "",
            image: ""
        };
    }

    static DEFAULT_OPTIONS = {
        id: "draggable-puzzle-config",
        classes: [],
        window: {
            title: "Draggable Puzzle Config",
            resizable: true
        },
        position: {
            width: 760,
            height: 720
        },
        actions: {}
    };

    static PARTS = {
        content: {
            template: "modules/draggable-puzzle/templates/puzzle-config.hbs"
        }
    };

    async _prepareContext()
    {
        const config = this._working ?? {};

        return {
            isGM: !!game.user?.isGM,
            config: {
                ...config,
                onSolvedMacro: config.onSolvedMacro ?? "",
                onSolvedMacroArgsText: config.onSolvedMacroArgs ? JSON.stringify(config.onSolvedMacroArgs) : "",
                solutionText: Array.isArray(config.solution) ? config.solution.join(",") : "",
                tiles: Array.isArray(config.tiles) ? config.tiles : [],
                newTile: this._newTile ?? { id: "", label: "", image: "" }
            }
        };
    }

    _attachPartListeners(partId, htmlElement, options)
    {
        super._attachPartListeners(partId, htmlElement, options);
        if (partId !== "content") return;

        // Save/preview actions
        htmlElement.querySelectorAll("[data-action]").forEach(button =>
        {
            button.addEventListener("click", (event) =>
            {
                // Some buttons are type="submit"; never allow a native form submit.
                event.preventDefault();
                const action = event.currentTarget?.dataset?.action;
                if (action) void this._onAction(action, event);
            });
        });

        // Drag-drop: macro ref field
        const macroField = htmlElement.querySelector('input[name="onSolvedMacro"]');
        if (macroField)
        {
            macroField.addEventListener("dragover", e => e.preventDefault());
            macroField.addEventListener("drop", e => void this._onDropMacroField(e));
        }

        // Drag-drop: allow dropping onto the whole tile card (not just the image row)
        htmlElement.querySelectorAll("[data-tile-drop]").forEach(tileCard =>
        {
            tileCard.addEventListener("dragover", e => e.preventDefault(), { capture: true });
            tileCard.addEventListener("dragenter", () => tileCard.classList.add("dp-config__tile--dragover"));
            tileCard.addEventListener("dragleave", (event) =>
            {
                // Only clear when leaving the card, not when moving between its children.
                const related = event.relatedTarget;
                if (related instanceof Node && tileCard.contains(related)) return;
                tileCard.classList.remove("dp-config__tile--dragover");
            });
            tileCard.addEventListener("drop", (event) =>
            {
                tileCard.classList.remove("dp-config__tile--dragover");
                void this._onDropImage(tileCard, event);
            }, { capture: true });

            // Also make the image row clickable to browse (bigger click target)
            const imageRow = tileCard.querySelector(".dp-config__image-drop");
            if (imageRow)
            {
                imageRow.addEventListener("click", (event) =>
                {
                    const target = event.target;
                    // Let users focus/edit the text input and click the actual button normally.
                    if (target instanceof HTMLInputElement) return;
                    if (target instanceof HTMLButtonElement) return;
                    if (target instanceof HTMLElement && target.closest("button")) return;

                    const tileIndex = Number(tileCard.dataset.tileIndex);
                    if (!Number.isFinite(tileIndex)) return;
                    void this._onAction("browseImage", { currentTarget: { dataset: { tileIndex: String(tileIndex) } } });
                });
            }
        });

        // Drag-drop: New Tile card
        const newTileCard = htmlElement.querySelector("[data-new-tile-drop]");
        if (newTileCard)
        {
            newTileCard.addEventListener("dragover", e => e.preventDefault(), { capture: true });
            newTileCard.addEventListener("dragenter", () => newTileCard.classList.add("dp-config__tile--dragover"));
            newTileCard.addEventListener("dragleave", (event) =>
            {
                const related = event.relatedTarget;
                if (related instanceof Node && newTileCard.contains(related)) return;
                newTileCard.classList.remove("dp-config__tile--dragover");
            });
            newTileCard.addEventListener("drop", (event) =>
            {
                newTileCard.classList.remove("dp-config__tile--dragover");
                void this._onDropNewTile(newTileCard, event);
            }, { capture: true });

            const imageRow = newTileCard.querySelector("[data-new-tile-image]");
            if (imageRow)
            {
                imageRow.addEventListener("click", (event) =>
                {
                    const target = event.target;
                    if (target instanceof HTMLInputElement) return;
                    if (target instanceof HTMLButtonElement) return;
                    if (target instanceof HTMLElement && target.closest("button")) return;
                    void this._onAction("browseNewTileImage", event);
                });
            }
        }

        // Form submit
        // Note: the content PART root is the <form> itself, so querySelector("form") would be null.
        const form = htmlElement instanceof HTMLFormElement ? htmlElement : htmlElement.querySelector("form");
        if (form)
        {
            form.addEventListener("submit", (event) =>
            {
                event.preventDefault();
                void this._onAction("save", event);
            });

            // Keep working config in sync on input changes
            form.querySelectorAll("input, textarea").forEach(input =>
            {
                input.addEventListener("change", () => this._readFormIntoWorking(form));
            });
        }
    }

    _readFormIntoWorking(form)
    {
        const prevTileCount = Array.isArray(this._working.tiles) ? this._working.tiles.length : 0;
        const fd = new FormData(form);

        // Top-level
        this._working.title = String(fd.get("title") ?? "");
        this._working.instructions = String(fd.get("instructions") ?? "");
        this._working.columns = Number(fd.get("columns") ?? 0) || 0;
        this._working.shuffle = fd.get("shuffle") === "on";
        this._working.closeOnSolve = fd.get("closeOnSolve") === "on";

        this._working.showChatMessage = String(fd.get("showChatMessage") ?? "");
        this._working.solvedChatMessage = String(fd.get("solvedChatMessage") ?? "");

        this._working.onSolvedMacro = String(fd.get("onSolvedMacro") ?? "").trim();

        const argsText = String(fd.get("onSolvedMacroArgs") ?? "").trim();
        if (!argsText)
        {
            delete this._working.onSolvedMacroArgs;
        } else
        {
            try
            {
                const parsed = JSON.parse(argsText);
                this._working.onSolvedMacroArgs = Array.isArray(parsed) ? parsed : [parsed];
            } catch
            {
                // Leave as-is; save will validate.
            }
        }

        // Tiles
        const tiles = Array.isArray(this._working.tiles) ? this._working.tiles : [];
        for (let index = 0; index < tiles.length; index++)
        {
            tiles[index] = {
                id: String(fd.get(`tiles.${index}.id`) ?? tiles[index]?.id ?? "").trim(),
                label: String(fd.get(`tiles.${index}.label`) ?? tiles[index]?.label ?? "").trim(),
                image: String(fd.get(`tiles.${index}.image`) ?? tiles[index]?.image ?? "").trim()
            };
        }
        this._working.tiles = tiles;

        // New tile draft
        this._newTile = {
            id: String(fd.get("newTile.id") ?? "").trim(),
            label: String(fd.get("newTile.label") ?? "").trim(),
            image: String(fd.get("newTile.image") ?? "").trim()
        };

        // Solution
        this._working.solution = parseSolutionText(fd.get("solutionText"));

        // Default to a single horizontal row (columns == tile count) unless the GM overrides it.
        // Heuristic: if columns was previously "auto" (equal to previous tile count) or unset,
        // keep it tracking the tile count.
        this._autoAdjustColumns(prevTileCount);
    }

    _autoAdjustColumns(prevTileCount)
    {
        const tiles = Array.isArray(this._working.tiles) ? this._working.tiles : [];
        const nextTileCount = tiles.length;

        const currentColumns = Number(this._working.columns) || 0;

        // If columns is unset/invalid, default to horizontal.
        if (currentColumns <= 0)
        {
            this._working.columns = Math.max(1, nextTileCount);
            return;
        }

        // If the GM hasn't overridden (it matched prior tile count), keep it tracking tile count.
        if (Number(prevTileCount) > 0 && currentColumns === Number(prevTileCount))
        {
            this._working.columns = Math.max(1, nextTileCount);
            return;
        }

        // Clamp columns to a valid range.
        this._working.columns = Math.max(1, Math.min(currentColumns, Math.max(1, nextTileCount)));
    }

    _reconcileSolutionWithTiles()
    {
        const tiles = Array.isArray(this._working.tiles) ? this._working.tiles : [];
        const tileIds = tiles.map(t => t?.id).filter(Boolean);
        const tileSet = new Set(tileIds);

        const existing = Array.isArray(this._working.solution) ? this._working.solution : [];
        const filtered = existing.filter(id => tileSet.has(id));

        // Append any missing tile ids (preserve tile order for the default fill-ins).
        const present = new Set(filtered);
        for (const id of tileIds)
        {
            if (!present.has(id)) filtered.push(id);
        }

        this._working.solution = filtered;
    }

    async _onAction(action, event)
    {
        const root = this.element;
        const form = root?.querySelector("form");
        if (form) this._readFormIntoWorking(form);

        if (action === "openItem")
        {
            if (!game.user?.isGM) return;
            const uuid = await this._promptSelectWorldItemUuid();
            if (!uuid) return;
            await game.draggablePuzzle?.openConfigForItem?.(uuid);
            await this.close();
            return;
        }

        if (action === "saveAsItem")
        {
            if (!game.user?.isGM) return;

            const name = await this._promptText({
                title: "Save Puzzle as Item",
                label: "Item Name",
                value: String(this._working?.title ?? "Puzzle")
            });
            if (!name) return;

            const created = await game.draggablePuzzle?.createPuzzleItem?.(deepClone(this._working), { name });
            if (!created?.uuid) return;

            // Immediately open the Item-backed editor so future Saves update the Item.
            await game.draggablePuzzle?.openConfigForItem?.(created.uuid);
            await this.close();
            return;
        }

        if (action === "addTile")
        {
            // Treat the header "Add" as a shortcut for committing the New Tile editor.
            await this._commitNewTile();
            return;
        }

        if (action === "commitNewTile")
        {
            await this._commitNewTile();
            return;
        }

        if (action === "removeTile")
        {
            const tileIndex = Number(event.currentTarget?.dataset?.tileIndex);
            if (Number.isFinite(tileIndex))
            {
                const prevTileCount = Array.isArray(this._working.tiles) ? this._working.tiles.length : 0;
                this._working.tiles.splice(tileIndex, 1);
                this._reconcileSolutionWithTiles();
                this._autoAdjustColumns(prevTileCount);
                this.render({ force: true });
            }
            return;
        }

        if (action === "resetTiles")
        {
            // Keep title/instructions etc, only reset tiles/solution
            const prevTileCount = Array.isArray(this._working.tiles) ? this._working.tiles.length : 0;
            this._working.tiles = [];
            this._working.solution = [];
            this._autoAdjustColumns(prevTileCount);
            this.render({ force: true });
            return;
        }

        if (action === "browseImage")
        {
            const tileIndex = Number(event.currentTarget?.dataset?.tileIndex);
            if (!Number.isFinite(tileIndex)) return;

            const current = this._working.tiles?.[tileIndex]?.image ?? "";
            const fp = new FilePicker({
                type: "image",
                current,
                callback: (path) =>
                {
                    this._working.tiles[tileIndex].image = path;
                    this.render({ force: true });
                }
            });
            fp.browse(current);
            return;
        }

        if (action === "browseNewTileImage")
        {
            const current = this._newTile?.image ?? "";
            const fp = new FilePicker({
                type: "image",
                current,
                callback: (path) =>
                {
                    this._newTile.image = path;
                    this.render({ force: true });
                }
            });
            fp.browse(current);
            return;
        }

        if (action === "preview")
        {
            if (typeof this._onPreview === "function")
            {
                this._onPreview(deepClone(this._working));
            }
            return;
        }

        if (action === "save")
        {
            // Validate args JSON
            const argsText = String(form?.querySelector('input[name="onSolvedMacroArgs"]')?.value ?? "").trim();
            if (argsText)
            {
                try
                {
                    const parsed = JSON.parse(argsText);
                    this._working.onSolvedMacroArgs = Array.isArray(parsed) ? parsed : [parsed];
                } catch
                {
                    ui.notifications?.warn("Draggable Puzzle: Macro args must be valid JSON (array recommended).");
                    return;
                }
            }

            // Default solution if missing or wrong length
            if (!Array.isArray(this._working.solution) || this._working.solution.length !== (this._working.tiles?.length ?? 0))
            {
                this._working.solution = (this._working.tiles ?? []).map(t => t.id);
            }

            // Ensure we never save a solution containing removed tiles.
            this._reconcileSolutionWithTiles();

            try
            {
                const maybePromise = this._setConfig?.(deepClone(this._working));
                if (maybePromise && typeof maybePromise.then === "function") await maybePromise;
            } catch (error)
            {
                console.error("Draggable Puzzle | Failed to save configuration", error);
                ui.notifications?.error("Draggable Puzzle: Failed to save configuration. See console.");
                return;
            }

            try
            {
                if (typeof this._onSaved === "function") this._onSaved(deepClone(this._working));
            } catch
            {
                // ignore
            }

            ui.notifications?.info("Draggable Puzzle: Configuration saved.");
            return;
        }
    }

    async _promptText({ title, label, value } = {})
    {
        return new Promise((resolve) =>
        {
            const content = `
        <form>
          <div class="form-group">
            <label>${label ?? "Value"}</label>
            <input type="text" name="value" value="${foundry.utils.escapeHTML(String(value ?? ""))}" />
          </div>
        </form>
      `;

            new Dialog({
                title: title ?? "Input",
                content,
                buttons: {
                    ok: {
                        icon: '<i class="fas fa-check"></i>',
                        label: "OK",
                        callback: (html) =>
                        {
                            const v = String(html?.find?.('input[name="value"]')?.val?.() ?? "").trim();
                            resolve(v || null);
                        }
                    },
                    cancel: {
                        icon: '<i class="fas fa-times"></i>',
                        label: "Cancel",
                        callback: () => resolve(null)
                    }
                },
                default: "ok",
                close: () => resolve(null)
            }).render(true);
        });
    }

    async _promptSelectWorldItemUuid()
    {
        const items = Array.from(game.items ?? []).sort((a, b) => String(a.name).localeCompare(String(b.name)));
        if (!items.length)
        {
            ui.notifications?.warn("Draggable Puzzle: No world Items found.");
            return null;
        }

        return new Promise((resolve) =>
        {
            const options = items
                .map((i) => `<option value="${i.uuid}">${foundry.utils.escapeHTML(i.name)}</option>`)
                .join("");

            const content = `
        <form>
          <div class="form-group">
            <label>Select Puzzle Item</label>
            <select name="uuid">${options}</select>
            <p class="notes">Select an Item that has a Draggable Puzzle saved on it.</p>
          </div>
        </form>
      `;

            new Dialog({
                title: "Open Puzzle Item",
                content,
                buttons: {
                    open: {
                        icon: '<i class="fas fa-box-open"></i>',
                        label: "Open",
                        callback: (html) =>
                        {
                            const uuid = String(html?.find?.('select[name="uuid"]')?.val?.() ?? "").trim();
                            resolve(uuid || null);
                        }
                    },
                    cancel: {
                        icon: '<i class="fas fa-times"></i>',
                        label: "Cancel",
                        callback: () => resolve(null)
                    }
                },
                default: "open",
                close: () => resolve(null)
            }).render(true);
        });
    }

    async _commitNewTile()
    {
        this._working.tiles = Array.isArray(this._working.tiles) ? this._working.tiles : [];

        const prevTileCount = this._working.tiles.length;

        const nextIndex = this._working.tiles.length + 1;
        const label = this._newTile?.label || `Tile ${nextIndex}`;
        const image = this._newTile?.image || "icons/svg/d20-grey.svg";

        // If ID isn't provided, base it on label.
        const proposedId = this._newTile?.id || hyphenateId(label) || `tile-${nextIndex}`;
        const id = ensureUniqueTileId(proposedId, this._working.tiles, -1);

        this._working.tiles.push({ id, label, image });

        // Keep solution in sync unless the user explicitly manages it.
        if (!Array.isArray(this._working.solution) || this._working.solution.length !== this._working.tiles.length - 1)
        {
            this._working.solution = (this._working.tiles ?? []).map(t => t.id);
        } else
        {
            this._working.solution = [...this._working.solution, id];
        }

        // Reset editor
        this._newTile = { id: "", label: "", image: "" };
        this.render({ force: true });
    }

    async _onDropNewTile(dropZone, event)
    {
        event.preventDefault();

        // 1) Dropping a Foundry entity (Item/Actor/Compendium entry)
        const raw = event.dataTransfer?.getData("text/plain");
        if (raw)
        {
            const doc = await resolveDroppedDocument(raw);
            if (doc)
            {
                const img = getDocumentImage(doc);
                const name = String(doc?.name ?? "").trim();

                if (img) this._newTile.image = img;
                if (name)
                {
                    this._newTile.label = name;
                    this._newTile.id = hyphenateId(name);
                }

                this.render({ force: true });
                return;
            }
        }

        // 2) Dropping a local file from OS (upload to world data)
        const files = Array.from(event.dataTransfer?.files ?? []);
        const file = files.find(isImageFile);
        if (!file) return;

        await ensureWorldUploadDir();

        try
        {
            const response = await FilePicker.upload("data", worldUploadTarget(), file, { notify: true });
            const path = response?.path;
            if (path)
            {
                this._newTile.image = path;
                this.render({ force: true });
            }
        } catch (error)
        {
            console.error("Draggable Puzzle | Upload failed", error);
            ui.notifications?.error("Draggable Puzzle: Image upload failed (see console).");
        }
    }

    async _onDropMacroField(event)
    {
        event.preventDefault();

        // Foundry drag-drop payload is usually JSON in text/plain.
        const raw = event.dataTransfer?.getData("text/plain");
        if (!raw) return;

        try
        {
            const data = JSON.parse(raw);
            const uuid = data?.uuid;
            if (uuid && typeof uuid === "string")
            {
                this._working.onSolvedMacro = uuid;
                this.render({ force: true });
            }
        } catch
        {
            // If it isn't JSON, ignore.
        }
    }

    async _onDropImage(dropZone, event)
    {
        event.preventDefault();

        const tileIndex = Number(dropZone.closest("[data-tile-index]")?.dataset?.tileIndex);
        if (!Number.isFinite(tileIndex)) return;

        // 1) Dropping a Foundry entity (Item/Actor/Compendium entry)
        const raw = event.dataTransfer?.getData("text/plain");
        if (raw)
        {
            const doc = await resolveDroppedDocument(raw);
            if (doc)
            {
                const img = getDocumentImage(doc);
                if (img)
                {
                    this._working.tiles[tileIndex].image = img;
                }

                const name = String(doc?.name ?? "").trim();
                if (name)
                {
                    this._working.tiles[tileIndex].label = name;
                    const proposedId = hyphenateId(name);
                    this._working.tiles[tileIndex].id = ensureUniqueTileId(
                        proposedId,
                        this._working.tiles,
                        tileIndex
                    );
                }

                // If we changed IDs, keep solution consistent.
                this._reconcileSolutionWithTiles();

                this.render({ force: true });
                return;
            }
        }

        // 2) Dropping a local file from OS (upload to world data)
        const files = Array.from(event.dataTransfer?.files ?? []);
        const file = files.find(isImageFile);
        if (!file) return;

        await ensureWorldUploadDir();

        try
        {
            const response = await FilePicker.upload("data", worldUploadTarget(), file, { notify: true });
            const path = response?.path;
            if (path)
            {
                this._working.tiles[tileIndex].image = path;
                this.render({ force: true });
            }
        } catch (error)
        {
            console.error("Draggable Puzzle | Upload failed", error);
            ui.notifications?.error("Draggable Puzzle: Image upload failed (see console).");
        }
    }
}
