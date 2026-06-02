const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

// FilePicker moved to foundry namespace in v14; use new path first, fall back to legacy global for v13.
const FilePicker = foundry.applications?.apps?.FilePicker?.implementation ?? globalThis.FilePicker;

function worldUploadTarget()
{
    const worldId = game.world?.id ?? game.world?.name ?? "world";
    return `worlds/${worldId}/draggable-puzzle-foundry`;
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

/**
 * Returns an inline style string that crops the source image to the tile's grid position,
 * or null if the tile has no slice data.
 */
function tileSliceStyle(tile)
{
    if (!tile?.sliceImage) return null;
    const cols = Number(tile.sliceCols) || 1;
    const rows = Number(tile.sliceRows) || 1;
    const col = Number(tile.sliceCol) || 0;
    const row = Number(tile.sliceRow) || 0;
    const px = cols > 1 ? ((col / (cols - 1)) * 100).toFixed(3) + "%" : "0%";
    const py = rows > 1 ? ((row / (rows - 1)) * 100).toFixed(3) + "%" : "0%";
    // URL-encode quotes so the path can't break out of the CSS url() or style attribute.
    const src = tile.sliceImage.replace(/\\/g, "/").replace(/'/g, "%27").replace(/"/g, "%22");
    return `background-image:url('${src}');background-size:${cols * 100}% ${rows * 100}%;background-position:${px} ${py};background-repeat:no-repeat;`;
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
            template: "modules/draggable-puzzle-foundry/templates/puzzle-config.hbs"
        }
    };

    render(options = {}, _options = {})
    {
        // Capture scroll position before the DOM is replaced so we can restore it after.
        const scroller = this.element?.querySelector(".dp-config");
        this._savedScrollTop = scroller ? scroller.scrollTop : 0;
        return super.render(options, _options);
    }

    async _onRender(context, options)
    {
        await super._onRender(context, options);
        // Restore scroll position so the user stays where they were.
        if (this._savedScrollTop > 0)
        {
            const scroller = this.element?.querySelector(".dp-config");
            if (scroller) scroller.scrollTop = this._savedScrollTop;
            this._savedScrollTop = 0;
        }
    }

    async _prepareContext()
    {
        const config = this._working ?? {};

        return {
            isGM: !!game.user?.isGM,
            activeTab: this._activeTab ?? "puzzle",
            config: {
                ...config,
                onSolvedMacro: config.onSolvedMacro ?? "",
                onSolvedMacroArgsText: config.onSolvedMacroArgs ? JSON.stringify(config.onSolvedMacroArgs) : "",
                solutionText: Array.isArray(config.solution) ? config.solution.join(",") : "",
                rows: config.rows ?? 3,
                sourceImage: config.sourceImage ?? "",
                sourceColumns: config.sourceColumns ?? config.columns ?? 3,
                sourceRows: config.sourceRows ?? 3,
                tiles: (Array.isArray(config.tiles) ? config.tiles : []).map(t => ({
                    ...t,
                    sliceStyle: tileSliceStyle(t)
                })),
                newTile: {
                    ...(this._newTile ?? { id: "", label: "", image: "" }),
                    sliceStyle: tileSliceStyle(this._newTile)
                }
            }
        };
    }

    _attachPartListeners(partId, htmlElement, options)
    {
        super._attachPartListeners(partId, htmlElement, options);
        if (partId !== "content") return;

        // Tab switching (client-side, no re-render needed)
        htmlElement.querySelectorAll(".dp-config__tab-btn").forEach(btn =>
        {
            btn.addEventListener("click", () =>
            {
                const tab = btn.dataset.tab;
                if (!tab) return;
                this._activeTab = tab;
                htmlElement.querySelectorAll(".dp-config__tab-btn").forEach(b =>
                    b.classList.toggle("dp-config__tab-btn--active", b.dataset.tab === tab));
                htmlElement.querySelectorAll(".dp-config__tab-panel").forEach(p =>
                    p.classList.toggle("dp-config__tab-panel--active", p.dataset.tabPanel === tab));
            });
        });

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
        this._working.rows = Number(fd.get("rows") ?? 0) || 0;
        {
            const fit = String(fd.get("imageFit") ?? "").trim();
            this._working.imageFit = fit === "cover" ? "cover" : "contain";
        }
        this._working.shuffle = fd.get("shuffle") === "on";
        this._working.closeOnSolve = fd.get("closeOnSolve") === "on";

        this._working.showChatMessage = String(fd.get("showChatMessage") ?? "");
        this._working.solvedChatMessage = String(fd.get("solvedChatMessage") ?? "");

        this._working.onSolvedMacro = String(fd.get("onSolvedMacro") ?? "").trim();
        this._working.sourceImage = String(fd.get("sourceImage") ?? "").trim();
        this._working.sourceColumns = Number(fd.get("sourceColumns") ?? 0) || 0;
        this._working.sourceRows = Number(fd.get("sourceRows") ?? 0) || 0;

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
            // Spread first so slice metadata (sliceImage, sliceCols, etc.) is preserved.
            tiles[index] = {
                ...tiles[index],
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

        if (action === "pickMacro")
        {
            const uuid = await this._promptSelectMacroUuid({ current: this._working?.onSolvedMacro ?? "" });
            if (uuid === null) return;
            this._working.onSolvedMacro = uuid;
            this.render({ force: true });
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

        if (action === "uploadNewTileImage")
        {
            if (!game.user?.isGM)
            {
                ui.notifications?.warn("Draggable Puzzle: Only a GM can upload images.");
                return;
            }

            const file = await this._promptSelectLocalImageFile();
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
            return;
        }

        if (action === "uploadImage")
        {
            if (!game.user?.isGM)
            {
                ui.notifications?.warn("Draggable Puzzle: Only a GM can upload images.");
                return;
            }

            const tileIndex = Number(event.currentTarget?.dataset?.tileIndex);
            if (!Number.isFinite(tileIndex)) return;

            const file = await this._promptSelectLocalImageFile();
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
            return;
        }

        if (action === "browseSourceImage")
        {
            const current = this._working.sourceImage ?? "";
            const fp = new FilePicker({
                type: "image",
                current,
                callback: (path) =>
                {
                    this._working.sourceImage = path;
                    this.render({ force: true });
                }
            });
            fp.browse(current);
            return;
        }

        if (action === "autoSlice")
        {
            await this._autoSlice();
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

    async _autoSlice()
    {
        const sourceImage = this._working.sourceImage;
        if (!sourceImage)
        {
            ui.notifications?.warn("Draggable Puzzle: Set a source image before generating tiles.");
            return;
        }

        const cols = Math.max(1, Number(this._working.sourceColumns) || Number(this._working.columns) || 3);
        const rows = Math.max(1, Number(this._working.sourceRows) || 3);

        // Load image to determine aspect ratio so tile height looks correct.
        const { width: imgW, height: imgH } = await new Promise((resolve) =>
        {
            const img = new Image();
            img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
            img.onerror = () => resolve({ width: 1, height: 1 });
            img.src = sourceImage;
        });

        // height/width ratio for one cell in the grid.
        const sliceTileAspect = (imgW > 0 && imgH > 0)
            ? (imgH * cols) / (imgW * rows)
            : 1;

        const tiles = [];
        for (let r = 0; r < rows; r++)
        {
            for (let c = 0; c < cols; c++)
            {
                tiles.push({
                    id: `r${r}c${c}`,
                    label: "",
                    image: "",
                    sliceImage: sourceImage,
                    sliceCols: cols,
                    sliceRows: rows,
                    sliceCol: c,
                    sliceRow: r
                });
            }
        }

        this._working.tiles = tiles;
        this._working.solution = tiles.map(t => t.id);
        this._working.sliceTileAspect = sliceTileAspect;
        this._working.columns = cols;
        this._working.rows = rows;
        this._activeTab = "puzzle";
        this.render({ force: true });
    }

    async _promptText({ title, label, value } = {})
    {
        const content = `
        <form>
          <div class="form-group">
            <label>${label ?? "Value"}</label>
            <input type="text" name="value" value="${foundry.utils.escapeHTML(String(value ?? ""))}" />
          </div>
        </form>
      `;

        const result = await foundry.applications.api.DialogV2.wait({
            window: { title: title ?? "Input" },
            content,
            buttons: [
                {
                    action: "ok",
                    label: "OK",
                    icon: "fas fa-check",
                    default: true,
                    callback: (_event, _button, dialog) =>
                    {
                        const v = String(dialog.element.querySelector('input[name="value"]')?.value ?? "").trim();
                        return v || null;
                    }
                },
                {
                    action: "cancel",
                    label: "Cancel",
                    icon: "fas fa-times",
                    callback: () => null
                }
            ],
            rejectClose: false
        });
        return result ?? null;
    }

    async _promptSelectWorldItemUuid()
    {
        const items = Array.from(game.items ?? []).sort((a, b) => String(a.name).localeCompare(String(b.name)));
        if (!items.length)
        {
            ui.notifications?.warn("Draggable Puzzle: No world Items found.");
            return null;
        }

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

        const result = await foundry.applications.api.DialogV2.wait({
            window: { title: "Open Puzzle Item" },
            content,
            buttons: [
                {
                    action: "open",
                    label: "Open",
                    icon: "fas fa-box-open",
                    default: true,
                    callback: (_event, _button, dialog) =>
                    {
                        const uuid = String(dialog.element.querySelector('select[name="uuid"]')?.value ?? "").trim();
                        return uuid || null;
                    }
                },
                {
                    action: "cancel",
                    label: "Cancel",
                    icon: "fas fa-times",
                    callback: () => null
                }
            ],
            rejectClose: false
        });
        return result ?? null;
    }

    async _promptSelectLocalImageFile()
    {
        const content = `
        <form>
          <div class="form-group">
            <label>Select an image to upload</label>
            <input type="file" name="file" accept="image/*" />
          </div>
        </form>
      `;

        const result = await foundry.applications.api.DialogV2.wait({
            window: { title: "Upload Image" },
            content,
            buttons: [
                {
                    action: "upload",
                    label: "Upload",
                    icon: "fas fa-upload",
                    default: true,
                    callback: (_event, _button, dialog) =>
                    {
                        try
                        {
                            const input = dialog.element.querySelector('input[name="file"]');
                            return input?.files?.[0] ?? null;
                        } catch
                        {
                            return null;
                        }
                    }
                },
                {
                    action: "cancel",
                    label: "Cancel",
                    icon: "fas fa-times",
                    callback: () => null
                }
            ],
            rejectClose: false
        });
        return result ?? null;
    }

    async _promptSelectMacroUuid({ current = "" } = {})
    {
        const macros = Array.from(game.macros ?? []).sort((a, b) => String(a.name).localeCompare(String(b.name)));
        if (!macros.length)
        {
            ui.notifications?.warn("Draggable Puzzle: No world Macros found.");
            return null;
        }

        const currentText = String(current ?? "").trim();
        const noneSelected = !currentText;

        const options = [
            `<option value="" ${noneSelected ? "selected" : ""}>(None)</option>`,
            ...macros.map((m) =>
            {
                const selected = (m.uuid === currentText || m.name === currentText) ? "selected" : "";
                return `<option value="${m.uuid}" ${selected}>${foundry.utils.escapeHTML(m.name)}</option>`;
            })
        ].join("");

        const content = `
        <form>
          <div class="form-group">
            <label>Select Macro</label>
            <select name="uuid">${options}</select>
            <p class="notes">This will store the Macro UUID (recommended).</p>
          </div>
        </form>
      `;

        const result = await foundry.applications.api.DialogV2.wait({
            window: { title: "Select On-Solve Macro" },
            content,
            buttons: [
                {
                    action: "select",
                    label: "Select",
                    icon: "fas fa-check",
                    default: true,
                    callback: (_event, _button, dialog) =>
                    {
                        return String(dialog.element.querySelector('select[name="uuid"]')?.value ?? "").trim();
                    }
                },
                {
                    action: "cancel",
                    label: "Cancel",
                    icon: "fas fa-times",
                    callback: () => null
                }
            ],
            rejectClose: false
        });
        return result ?? null;
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
