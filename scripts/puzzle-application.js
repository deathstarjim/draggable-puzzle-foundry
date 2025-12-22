function shuffleArray(array)
{
    const result = array.slice();
    for (let index = result.length - 1; index > 0; index--)
    {
        const swapIndex = Math.floor(Math.random() * (index + 1));
        [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
    }
    return result;
}

function normalizePuzzleDefinition(definition)
{
    const tiles = Array.isArray(definition.tiles) ? definition.tiles : [];
    const tileCount = Number.isFinite(definition.tileCount) ? Number(definition.tileCount) : tiles.length;

    let normalizedTiles = tiles.slice(0);
    if (tileCount && normalizedTiles.length < tileCount)
    {
        for (let index = normalizedTiles.length; index < tileCount; index++)
        {
            normalizedTiles.push({
                id: `tile-${index + 1}`,
                label: `Tile ${index + 1}`,
                image: "icons/svg/d20-grey.svg"
            });
        }
    }

    normalizedTiles = normalizedTiles.map((tile, index) => ({
        id: tile?.id ?? `tile-${index + 1}`,
        label: tile?.label ?? `Tile ${index + 1}`,
        image: tile?.image ?? "icons/svg/d20-grey.svg"
    }));

    const defaultSolution = normalizedTiles.map(t => t.id);
    const solution = Array.isArray(definition.solution) && definition.solution.length === normalizedTiles.length
        ? definition.solution.slice(0)
        : defaultSolution;

    // Default to a single horizontal row unless GM overrides.
    const columns = Number.isFinite(definition.columns) && Number(definition.columns) > 0
        ? Math.max(1, Number(definition.columns))
        : Math.max(1, normalizedTiles.length || 1);

    return {
        title: definition.title ?? "Draggable Puzzle",
        instructions: definition.instructions ?? "Drag pieces into the grid.",
        showChatMessage: definition.showChatMessage ?? "",
        solvedChatMessage: definition.solvedChatMessage ?? "",
        onSolvedMacro: definition.onSolvedMacro ?? "",
        onSolvedMacroArgs: definition.onSolvedMacroArgs ?? null,
        shuffle: Boolean(definition.shuffle),
        closeOnSolve: definition.closeOnSolve !== false,
        columns,
        tiles: normalizedTiles,
        solution
    };
}

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class PuzzleApplication extends HandlebarsApplicationMixin(ApplicationV2) {
    constructor(puzzleDefinition, options = {})
    {
        super(options);

        this.dpSource = options?.dpSource
            ? (foundry.utils.deepClone?.(options.dpSource) ?? JSON.parse(JSON.stringify(options.dpSource)))
            : { type: "unknown" };

        this.puzzle = normalizePuzzleDefinition(puzzleDefinition ?? {});

        try { game.draggablePuzzle?._dpRegisterOpenApp?.(this); } catch { /* ignore */ }

        this._applyAutoSizing();

        this.sessionId = options?.sessionId ? String(options.sessionId) : null;
        this.enableSync = options?.enableSync === true;
        this._suppressSync = false;
        this._lastAppliedRemoteBySender = new Map();
        this._syncDebounceId = null;
        this._localSeq = 0;
        this._solvedHandled = false;

        const pieceIds = this.puzzle.tiles.map(t => t.id);

        const initial = options?.initialState;
        const trayPieceIds = Array.isArray(initial?.trayPieceIds) ? initial.trayPieceIds.slice() : null;
        const slotPieceIds = Array.isArray(initial?.slotPieceIds) ? initial.slotPieceIds.slice() : null;

        const isValidTray = trayPieceIds && trayPieceIds.every(id => pieceIds.includes(id));
        const isValidSlots = slotPieceIds && slotPieceIds.length === this.puzzle.tiles.length;

        if (isValidTray && isValidSlots)
        {
            this.dpState = { trayPieceIds, slotPieceIds };
        } else
        {
            const tray = this.puzzle.shuffle ? shuffleArray(pieceIds) : pieceIds.slice();
            this.dpState = {
                trayPieceIds: tray,
                slotPieceIds: Array(this.puzzle.tiles.length).fill(null)
            };
        }

        if (this.sessionId)
        {
            try { game.draggablePuzzle?._dpRegisterSessionApp?.(this.sessionId, this); } catch { /* ignore */ }
        }
    }

    static DEFAULT_OPTIONS = {
        id: "draggable-puzzle",
        classes: [],
        window: {
            title: "Draggable Puzzle",
            resizable: true
        },
        position: {
            width: 700,
            height: "auto"
        },
        actions: {}
    };

    static PARTS = {
        content: {
            template: "modules/draggable-puzzle/templates/puzzle-ui.hbs"
        }
    };

    _applyAutoSizing()
    {
        try
        {
            const tileSize = 150;
            const gap = 8;
            const chrome = 260;
            const columns = Math.max(1, Number(this.puzzle.columns) || 1);
            const boardWidth = columns * tileSize + Math.max(0, columns - 1) * gap;

            const viewportW = (globalThis.document?.documentElement?.clientWidth ?? globalThis.innerWidth ?? 1200);
            const maxW = Math.max(520, viewportW - 40);
            const width = Math.min(maxW, Math.max(700, boardWidth + chrome));

            const next = {
                ...(this.options.position ?? {}),
                width,
                height: "auto"
            };

            this.options.position = next;
            if (typeof this.setPosition === "function") this.setPosition(next);
        } catch
        {
            // ignore
        }
    }

    applyDefinition(nextDefinition, { preserveState = true } = {})
    {
        const nextPuzzle = normalizePuzzleDefinition(nextDefinition ?? {});

        if (preserveState)
        {
            const nextIds = new Set(nextPuzzle.tiles.map(t => t.id));
            const sameTileCount = (this.puzzle.tiles.length === nextPuzzle.tiles.length);
            const allOldStillExist = this.puzzle.tiles.every(t => nextIds.has(t.id));

            if (!(sameTileCount && allOldStillExist))
            {
                const pieceIds = nextPuzzle.tiles.map(t => t.id);
                const tray = nextPuzzle.shuffle ? shuffleArray(pieceIds) : pieceIds.slice();
                this.dpState = {
                    trayPieceIds: tray,
                    slotPieceIds: Array(nextPuzzle.tiles.length).fill(null)
                };
                this._solvedHandled = false;
            }
        }

        this.puzzle = nextPuzzle;
        this._applyAutoSizing();
        this.render({ force: true });
    }

    async _prepareContext()
    {
        const tilesById = new Map(this.puzzle.tiles.map(t => [t.id, t]));

        const trayTiles = this.dpState.trayPieceIds
            .map(id => tilesById.get(id))
            .filter(Boolean);

        const slots = this.dpState.slotPieceIds.map((id, slotIndex) =>
        {
            const tile = id ? tilesById.get(id) : null;
            return { slotIndex, tile };
        });

        return {
            title: this.puzzle.title,
            instructions: this.puzzle.instructions,
            columns: this.puzzle.columns,
            canConfigure: Boolean(game.user?.isGM),
            trayTiles,
            slots
        };
    }

    _attachPartListeners(partId, htmlElement, options)
    {
        super._attachPartListeners(partId, htmlElement, options);
        if (partId !== "content") return;

        const resetButton = htmlElement.querySelector('[data-action="reset"]');
        if (resetButton)
        {
            resetButton.addEventListener("click", (event) =>
            {
                event.preventDefault();
                this._resetPuzzle();
            });
        }

        const configButton = htmlElement.querySelector('[data-action="openConfig"]');
        if (configButton)
        {
            configButton.addEventListener("click", (event) =>
            {
                event.preventDefault();
                game.draggablePuzzle?.openConfig?.();
            });
        }

        const broadcastButton = htmlElement.querySelector('[data-action="broadcast"]');
        if (broadcastButton)
        {
            broadcastButton.addEventListener("click", (event) =>
            {
                event.preventDefault();

                const payload = game.draggablePuzzle?.broadcastOpenDefinition?.(this.puzzle, {
                    initialState: foundry.utils.deepClone ? foundry.utils.deepClone(this.dpState) : JSON.parse(JSON.stringify(this.dpState))
                });

                const sessionId = payload?.sessionId ?? payload?.broadcastId ?? null;
                if (sessionId) this.setSessionId(sessionId, { enableSync: true });

                if (sessionId && game.user?.isGM)
                {
                    try
                    {
                        if (typeof this.options.onSolved !== "function")
                        {
                            ui.notifications?.warn("Draggable Puzzle: This puzzle has no on-solve automation configured.");
                        }

                        game.draggablePuzzle?._dpRegisterSessionSolvedHandler?.(sessionId, {
                            definition: this.puzzle,
                            onSolved: this.options.onSolved
                        });
                    } catch
                    {
                        // ignore
                    }
                }
            });
        }

        htmlElement.querySelectorAll(".dp-piece").forEach(element =>
        {
            element.addEventListener("dragstart", this._onDragStart.bind(this));
        });

        htmlElement.querySelectorAll(".dp-slot").forEach(element =>
        {
            element.addEventListener("dragover", this._onDragOver.bind(this));
            element.addEventListener("drop", this._onDropOnSlot.bind(this));
        });

        const tray = htmlElement.querySelector(".dp-tray");
        if (tray)
        {
            tray.addEventListener("dragover", this._onDragOver.bind(this));
            tray.addEventListener("drop", this._onDropOnTray.bind(this));
        }
    }

    _resetPuzzle()
    {
        const pieceIds = this.puzzle.tiles.map(t => t.id);
        const tray = this.puzzle.shuffle ? shuffleArray(pieceIds) : pieceIds.slice();

        this.dpState.trayPieceIds = tray;
        this.dpState.slotPieceIds = Array(this.puzzle.tiles.length).fill(null);
        this._solvedHandled = false;

        this._queueSync();
        this.render({ force: true });
    }

    setSessionId(sessionId, { enableSync = true } = {})
    {
        const next = sessionId ? String(sessionId) : null;
        if (!next || next === this.sessionId) return;

        if (this.sessionId)
        {
            try { game.draggablePuzzle?._dpUnregisterSessionApp?.(this.sessionId, this); } catch { /* ignore */ }
        }

        this.sessionId = next;
        this.enableSync = Boolean(enableSync);

        try { game.draggablePuzzle?._dpRegisterSessionApp?.(this.sessionId, this); } catch { /* ignore */ }
    }

    applyRemoteState({ state, senderId, ts } = {})
    {
        try
        {
            if (!state || typeof state !== "object") return;
            if (!Array.isArray(state.trayPieceIds) || !Array.isArray(state.slotPieceIds)) return;

            // Ignore our own echoed socket/chat-fallback messages.
            // Important: do this BEFORE any timestamp/ordering bookkeeping so
            // local timestamps can't cause other users' updates to be discarded.
            if (senderId && senderId === game.user?.id) return;

            const senderKey = senderId ? String(senderId) : "unknown";
            const last = this._lastAppliedRemoteBySender.get(senderKey) ?? { seq: null, ts: 0 };
            const safeTs = Number.isFinite(ts) ? ts : Date.now();

            // Prefer a monotonic per-sender sequence number when available.
            const seq = Number.isFinite(state?._dpSeq) ? Number(state._dpSeq) : null;
            if (seq !== null)
            {
                const lastSeq = Number.isFinite(last.seq) ? Number(last.seq) : -1;
                if (seq <= lastSeq) return;
                this._lastAppliedRemoteBySender.set(senderKey, { seq, ts: safeTs });
            } else
            {
                const lastTs = Number.isFinite(last.ts) ? Number(last.ts) : 0;
                if (safeTs <= lastTs) return;
                this._lastAppliedRemoteBySender.set(senderKey, { seq: last.seq ?? null, ts: safeTs });
            }

            this._suppressSync = true;
            this.dpState.trayPieceIds = state.trayPieceIds.slice();
            this.dpState.slotPieceIds = state.slotPieceIds.slice();
            this.render({ force: false });

            if (!this._solvedHandled && this._isSolved())
            {
                this._solvedHandled = true;

                if (game.user?.isGM && this.sessionId)
                {
                    const ok = game.draggablePuzzle?._dpTryMarkSessionSolved?.(this.sessionId);
                    if (ok) void this._handleSolved({ runAutomation: true });
                    else void this._handleSolved({ runAutomation: false });
                } else
                {
                    void this._handleSolved({ runAutomation: true });
                }
            }
        } finally
        {
            this._suppressSync = false;
        }
    }

    _queueSync()
    {
        if (!this.enableSync) return;
        if (!this.sessionId) return;
        if (this._suppressSync) return;

        // Send on next tick to keep UI responsive but near real-time.
        if (this._syncDebounceId) clearTimeout(this._syncDebounceId);
        this._syncDebounceId = setTimeout(() =>
        {
            try
            {
                const send = game.draggablePuzzle?.sendSessionState;
                if (typeof send !== "function") return;
                const seq = ++this._localSeq;
                const state = {
                    trayPieceIds: this.dpState.trayPieceIds.slice(),
                    slotPieceIds: this.dpState.slotPieceIds.slice(),
                    _dpSeq: seq
                };
                void send(this.sessionId, state, { seq });
            } catch (error)
            {
                console.warn("Draggable Puzzle | Failed to sync state", error);
            }
        }, 0);
    }

    _onDragOver(event)
    {
        event.preventDefault();
    }

    _onDragStart(event)
    {
        const element = event.currentTarget;
        const from = element.dataset.from;
        const index = Number(element.dataset.index);
        const pieceId = element.dataset.pieceId;
        if (!from || !Number.isFinite(index) || !pieceId) return;

        event.dataTransfer?.setData("text/plain", JSON.stringify({ from, index, pieceId }));
    }

    _readDragData(event)
    {
        try
        {
            const raw = event.dataTransfer?.getData("text/plain");
            if (!raw) return null;
            const data = JSON.parse(raw);
            if (!data?.from || !Number.isFinite(data.index) || !data.pieceId) return null;
            return data;
        } catch
        {
            return null;
        }
    }

    _removeFromSource(dragData)
    {
        if (dragData.from === "tray")
        {
            const removed = this.dpState.trayPieceIds.splice(dragData.index, 1)[0];
            return removed ?? null;
        }
        if (dragData.from === "slot")
        {
            const removed = this.dpState.slotPieceIds[dragData.index];
            this.dpState.slotPieceIds[dragData.index] = null;
            return removed ?? null;
        }
        return null;
    }

    _placeIntoSource(from, index, pieceId)
    {
        if (from === "tray")
        {
            const safeIndex = Math.max(0, Math.min(index, this.dpState.trayPieceIds.length));
            this.dpState.trayPieceIds.splice(safeIndex, 0, pieceId);
            return;
        }
        if (from === "slot")
        {
            this.dpState.slotPieceIds[index] = pieceId;
        }
    }

    _onDropOnSlot(event)
    {
        event.preventDefault();

        const dragData = this._readDragData(event);
        if (!dragData) return;

        const destinationSlotIndex = Number(event.currentTarget.dataset.slotIndex);
        if (!Number.isFinite(destinationSlotIndex)) return;

        const destinationExisting = this.dpState.slotPieceIds[destinationSlotIndex];
        const moved = this._removeFromSource(dragData);
        if (!moved) return;

        this.dpState.slotPieceIds[destinationSlotIndex] = moved;

        if (destinationExisting)
        {
            this._placeIntoSource(dragData.from, dragData.index, destinationExisting);
        }

        this._afterStateChange();
    }

    _onDropOnTray(event)
    {
        event.preventDefault();

        const dragData = this._readDragData(event);
        if (!dragData) return;

        const moved = this._removeFromSource(dragData);
        if (!moved) return;

        this.dpState.trayPieceIds.push(moved);
        this._afterStateChange();
    }

    _afterStateChange()
    {
        const solved = this._isSolved();
        this._queueSync();
        this.render({ force: false });

        if (!solved) return;
        if (this._solvedHandled) return;
        this._solvedHandled = true;

        if (!game.user?.isGM && this.sessionId)
        {
            try { void game.draggablePuzzle?.requestSolved?.(this.sessionId, { state: this.dpState }); } catch { /* ignore */ }
        }

        if (game.user?.isGM && this.sessionId)
        {
            const ok = game.draggablePuzzle?._dpTryMarkSessionSolved?.(this.sessionId);
            if (ok) void this._handleSolved({ runAutomation: true });
            else void this._handleSolved({ runAutomation: false });
            return;
        }

        void this._handleSolved({ runAutomation: true });
    }

    async _handleSolved({ runAutomation = true } = {})
    {
        ui.notifications?.info("Puzzle solved!");

        const onSolved = this.options.onSolved;
        if (runAutomation && typeof onSolved === "function")
        {
            try
            {
                await onSolved({ puzzle: this.puzzle, app: this, sessionId: this.sessionId ?? null });
            } catch (error)
            {
                console.error("Draggable Puzzle | onSolved callback failed", error);
            }
        }

        if (this.puzzle.closeOnSolve) await this.close();
    }

    async close(options = {})
    {
        if (this.sessionId)
        {
            try { game.draggablePuzzle?._dpUnregisterSessionApp?.(this.sessionId, this); } catch { /* ignore */ }
        }

        try { game.draggablePuzzle?._dpUnregisterOpenApp?.(this); } catch { /* ignore */ }
        return super.close(options);
    }

    _isSolved()
    {
        for (let index = 0; index < this.puzzle.solution.length; index++)
        {
            const expected = this.puzzle.solution[index];
            const actual = this.dpState.slotPieceIds[index];
            if (!actual) return false;
            if (actual !== expected) return false;
        }
        return true;
    }
}
