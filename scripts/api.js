import
{
  MODULE_ID,
  SETTING_KEY,
  ITEM_FLAG_KEY,
  SOCKET_CHANNEL,
  SOCKET_ACTION_OPEN
} from "./constants.js";

const DEFAULT_PUZZLE_CONFIG = {
  title: "Draggable Puzzle",
  instructions: "Drag pieces into the grid.",
  tiles: [],
  solution: [],
  columns: null,
  shuffle: true,
  closeOnSolve: true,
  onSolvedMacro: "",
  onSolvedMacroArgs: null,
  showChatMessage: "",
  solvedChatMessage: ""
};

function deepClone(obj)
{
  return foundry.utils.deepClone ? foundry.utils.deepClone(obj) : JSON.parse(JSON.stringify(obj));
}

function safeRandomId()
{
  return foundry.utils.randomID?.() ?? Math.random().toString(36).slice(2);
}

function normalizeConfig(config)
{
  const base = deepClone(DEFAULT_PUZZLE_CONFIG);
  const next = { ...base, ...(config ?? {}) };
  next.tiles = Array.isArray(next.tiles) ? next.tiles : [];
  next.solution = Array.isArray(next.solution) ? next.solution : [];
  return next;
}

function defaultItemType()
{
  const types = game.system?.documentTypes?.Item;
  if (Array.isArray(types) && types.length) return types[0];
  return "loot";
}

async function resolveMacroRef(ref)
{
  if (!ref) return null;
  const text = String(ref).trim();
  if (!text) return null;

  // UUID (recommended)
  if (text.includes("."))
  {
    try
    {
      const doc = await fromUuid(text);
      if (doc && doc.documentName === "Macro") return doc;
    } catch
    {
      // ignore
    }
  }

  // Name fallback
  return game.macros?.getName?.(text) ?? null;
}

async function maybeChatMessage(content)
{
  const text = String(content ?? "").trim();
  if (!text) return;

  try
  {
    await ChatMessage.create({ content: text });
  } catch (error)
  {
    console.warn("Draggable Puzzle | Failed to post chat message", error);
  }
}

async function runOnSolved({ puzzle, sessionId = null, state = null } = {})
{
  // GM-only
  if (!game.user?.isGM) return;

  const macroRef = puzzle?.onSolvedMacro ?? "";
  const macro = await resolveMacroRef(macroRef);

  if (macro)
  {
    try
    {
      const args = puzzle?.onSolvedMacroArgs;
      if (args === null || args === undefined)
      {
        await macro.execute({ puzzle, sessionId, state });
      } else
      {
        await macro.execute(args);
      }
    } catch (error)
    {
      console.error("Draggable Puzzle | on-solve macro execution failed", error);
    }
  }

  await maybeChatMessage(puzzle?.solvedChatMessage);
}

const _openApps = new Set();

function getSavedConfig()
{
  return normalizeConfig(game.settings.get(MODULE_ID, SETTING_KEY) ?? {});
}

function setSavedConfig(config)
{
  return game.settings.set(MODULE_ID, SETTING_KEY, normalizeConfig(config));
}

function refreshOpenPuzzlesFromConfig({ source, itemUuid, config } = {})
{
  const next = normalizeConfig(config ?? {});
  for (const app of Array.from(_openApps))
  {
    try
    {
      const ds = app?.dpSource ?? null;
      if (source === "saved")
      {
        if (ds?.type !== "saved") continue;
      } else if (source === "item")
      {
        if (ds?.type !== "item") continue;
        if (!itemUuid || ds?.itemUuid !== itemUuid) continue;
      } else
      {
        continue;
      }

      app.applyDefinition?.(next, { preserveState: true });
    } catch
    {
      // ignore
    }
  }
}

async function resolveItem(itemRef)
{
  if (!itemRef) return null;
  if (itemRef?.documentName === "Item") return itemRef;

  if (typeof itemRef === "string")
  {
    const text = itemRef.trim();
    if (!text) return null;

    try
    {
      const doc = await fromUuid(text);
      if (doc?.documentName === "Item") return doc;
    } catch
    {
      // ignore
    }

    return game.items?.get?.(text) ?? null;
  }

  if (typeof itemRef === "object" && typeof itemRef.uuid === "string")
  {
    try
    {
      const doc = await fromUuid(itemRef.uuid);
      if (doc?.documentName === "Item") return doc;
    } catch
    {
      // ignore
    }
  }

  return null;
}

function getItemConfig(item)
{
  try
  {
    // Prefer current key; fall back to legacy key used by older builds.
    const cfg = item?.getFlag?.(MODULE_ID, ITEM_FLAG_KEY) ?? item?.getFlag?.(MODULE_ID, "puzzle");
    return normalizeConfig(cfg ?? {});
  } catch
  {
    return normalizeConfig({});
  }
}

async function setItemConfig(item, config)
{
  return item.setFlag(MODULE_ID, ITEM_FLAG_KEY, normalizeConfig(config));
}

function normalizeUserIds(targetUserIds)
{
  if (!Array.isArray(targetUserIds)) return null;
  const ids = targetUserIds.map(String).filter(Boolean);
  return ids.length ? ids : null;
}

async function whisperTransport({ whisperUserIds, payload } = {})
{
  if (!Array.isArray(whisperUserIds) || !whisperUserIds.length) return;

  try
  {
    await ChatMessage.create({
      content: "",
      whisper: whisperUserIds,
      flags: {
        [MODULE_ID]: {
          transport: true,
          payload
        }
      }
    });
  } catch (error)
  {
    console.warn("Draggable Puzzle | Chat fallback failed", error);
  }
}

function getActiveNonGMUserIds()
{
  const users = Array.from(game.users ?? []);
  return users.filter(u => u?.active && !u.isGM).map(u => u.id);
}

function broadcastOpenDefinition(definition, { initialState = null, targetUserIds = null, excludeGMs = true, sessionId = null } = {})
{
  if (!game.user?.isGM)
  {
    ui.notifications?.warn?.("Draggable Puzzle: Only a GM can broadcast puzzles.");
    return null;
  }

  const normalized = normalizeConfig(definition ?? {});
  const broadcastId = safeRandomId();
  const sid = sessionId ? String(sessionId) : broadcastId;

  // Register GM solved handler even if GM doesn't have a window open.
  try
  {
    game.draggablePuzzle?._dpRegisterSessionSolvedHandler?.(sid, {
      definition: normalized,
      onSolved: ({ puzzle, sessionId: solvedSessionId, state } = {}) =>
        runOnSolved({ puzzle: puzzle ?? normalized, sessionId: solvedSessionId ?? sid, state })
    });
  } catch
  {
    // ignore
  }

  void maybeChatMessage(normalized.showChatMessage);

  const payload = {
    action: SOCKET_ACTION_OPEN,
    broadcastId,
    sessionId: sid,
    senderId: game.user?.id,
    targetUserIds: normalizeUserIds(targetUserIds),
    excludeGMs: Boolean(excludeGMs),
    definition: normalized,
    initialState: initialState ? deepClone(initialState) : null,
    ts: Date.now()
  };

  game.socket?.emit?.(SOCKET_CHANNEL, payload);

  // Whisper fallback (best effort)
  const whisperUserIds = payload.targetUserIds ?? getActiveNonGMUserIds();
  void whisperTransport({ whisperUserIds, payload });

  return payload;
}

export function registerDraggablePuzzleApi()
{
  game.draggablePuzzle = game.draggablePuzzle ?? {};

  // Called by PuzzleApplication
  game.draggablePuzzle._dpRegisterOpenApp = (app) => void _openApps.add(app);
  game.draggablePuzzle._dpUnregisterOpenApp = (app) => void _openApps.delete(app);

  // Internal helper used by config windows
  game.draggablePuzzle._dpRefreshOpenPuzzlesFromConfig = (args = {}) => refreshOpenPuzzlesFromConfig(args);

  // Saved config helpers
  game.draggablePuzzle.getSavedConfig = () => getSavedConfig();
  game.draggablePuzzle.setSavedConfig = (config) => setSavedConfig(config);

  // Local puzzle
  game.draggablePuzzle.openPuzzle = async (options = {}) =>
  {
    const definition = options?.definition ? normalizeConfig(options.definition) : getSavedConfig();
    const { PuzzleApplication } = await import("./puzzle-application.js");
    const app = new PuzzleApplication(definition, {
      dpSource: { type: options?.definition ? "direct" : "saved" },
      onSolved: ({ puzzle, sessionId, state } = {}) => runOnSolved({ puzzle, sessionId, state })
    });
    app.render(true);
    return app;
  };

  game.draggablePuzzle.openSavedPuzzle = () => game.draggablePuzzle.openPuzzle({});
  game.draggablePuzzle.hello = () => game.draggablePuzzle.openPuzzle({});

  // Broadcast
  game.draggablePuzzle.broadcastOpenDefinition = (definition, opts = {}) =>
    broadcastOpenDefinition(definition, opts);

  game.draggablePuzzle.broadcastOpenSavedPuzzle = (opts = {}) =>
    broadcastOpenDefinition(getSavedConfig(), opts);

  // Config windows
  game.draggablePuzzle.openConfig = async () =>
  {
    const { PuzzleConfigApplication } = await import("./puzzle-config-application.js");
    const app = new PuzzleConfigApplication({
      getConfig: () => getSavedConfig(),
      setConfig: (cfg) => void setSavedConfig(cfg),
      onPreview: (cfg) => void game.draggablePuzzle.openPuzzle({ definition: cfg }),
      onSaved: (cfg) => refreshOpenPuzzlesFromConfig({ source: "saved", config: cfg })
    });
    app.render(true);
    return app;
  };

  game.draggablePuzzle.openSavedConfig = () => game.draggablePuzzle.openConfig();

  // Item-backed puzzles
  game.draggablePuzzle.createPuzzleItem = async (config, { name, type, folderId } = {}) =>
  {
    const itemData = {
      name: name ?? "Puzzle",
      type: type ?? defaultItemType(),
      folder: folderId ?? null,
      flags: {
        [MODULE_ID]: {
          [ITEM_FLAG_KEY]: normalizeConfig(config ?? {})
        }
      }
    };
    return Item.create(itemData);
  };

  game.draggablePuzzle.createPuzzleItemFromSaved = async (opts = {}) =>
    game.draggablePuzzle.createPuzzleItem(getSavedConfig(), opts);

  game.draggablePuzzle.getPuzzleConfigFromItem = async (itemRef) =>
  {
    const item = await resolveItem(itemRef);
    if (!item) throw new Error("Item not found");
    return getItemConfig(item);
  };

  game.draggablePuzzle.openPuzzleFromItem = async (itemRef, overrides = {}) =>
  {
    const item = await resolveItem(itemRef);
    if (!item) throw new Error("Item not found");

    const base = getItemConfig(item);
    const definition = normalizeConfig({ ...base, ...(overrides ?? {}) });

    const { PuzzleApplication } = await import("./puzzle-application.js");
    const app = new PuzzleApplication(definition, {
      dpSource: { type: "item", itemUuid: item.uuid },
      onSolved: ({ puzzle, sessionId, state } = {}) => runOnSolved({ puzzle, sessionId, state })
    });
    app.render(true);
    return app;
  };

  game.draggablePuzzle.broadcastOpenPuzzleFromItem = async (itemRef, overrides = {}, opts = {}) =>
  {
    const item = await resolveItem(itemRef);
    if (!item) throw new Error("Item not found");
    const base = getItemConfig(item);
    const definition = normalizeConfig({ ...base, ...(overrides ?? {}) });
    return broadcastOpenDefinition(definition, opts);
  };

  game.draggablePuzzle.openConfigForItem = async (itemRef) =>
  {
    const item = await resolveItem(itemRef);
    if (!item) throw new Error("Item not found");

    const { PuzzleConfigApplication } = await import("./puzzle-config-application.js");

    const app = new PuzzleConfigApplication({
      getConfig: () => getItemConfig(item),
      setConfig: (cfg) => void setItemConfig(item, cfg),
      onPreview: (cfg) => void game.draggablePuzzle.openPuzzleFromItem(item.uuid, cfg),
      onSaved: (cfg) => refreshOpenPuzzlesFromConfig({ source: "item", itemUuid: item.uuid, config: cfg })
    });
    app.render(true);
    return app;
  };
}
