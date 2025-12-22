import
    {
        MODULE_ID,
        SOCKET_CHANNEL,
        SOCKET_ACTION_OPEN,
        SOCKET_ACTION_STATE,
        SOCKET_ACTION_SOLVED,
        ACTION_PING,
        ACTION_ACK
    } from "./constants.js";

const ACTION_OPEN = SOCKET_ACTION_OPEN;
const ACTION_STATE = SOCKET_ACTION_STATE;
const ACTION_SOLVED = SOCKET_ACTION_SOLVED;

let _bound = false;

// Session registries
const _appsBySession = new Map();
const _sessionDefinitions = new Map();
const _sessionSolvedHandlers = new Map();
const _sessionSolvedLock = new Set();

// Dedupe broadcast opens across transports
const _handledBroadcastIds = new Set();

function safeNow() { return Date.now(); }

function wasHandled(broadcastId)
{
    const id = broadcastId ? String(broadcastId) : null;
    if (!id) return false;
    if (_handledBroadcastIds.has(id)) return true;
    _handledBroadcastIds.add(id);
    setTimeout(() => _handledBroadcastIds.delete(id), 60_000);
    return false;
}

function setSessionDefinition(sessionId, definition)
{
    if (!sessionId) return;
    _sessionDefinitions.set(String(sessionId), definition);
}

function getSessionDefinition(sessionId)
{
    if (!sessionId) return null;
    return _sessionDefinitions.get(String(sessionId)) ?? null;
}

function setSessionSolvedHandler(sessionId, handler)
{
    if (!sessionId) return;
    _sessionSolvedHandlers.set(String(sessionId), handler);
}

function getSessionSolvedHandler(sessionId)
{
    if (!sessionId) return null;
    return _sessionSolvedHandlers.get(String(sessionId)) ?? null;
}

function tryMarkSessionSolved(sessionId)
{
    const id = sessionId ? String(sessionId) : null;
    if (!id) return false;
    if (_sessionSolvedLock.has(id)) return false;
    _sessionSolvedLock.add(id);
    setTimeout(() => _sessionSolvedLock.delete(id), 5 * 60_000);
    return true;
}

function registerSessionApp(sessionId, app)
{
    if (!sessionId || !app) return;
    const id = String(sessionId);
    const set = _appsBySession.get(id) ?? new Set();
    set.add(app);
    _appsBySession.set(id, set);
}

function unregisterSessionApp(sessionId, app)
{
    if (!sessionId || !app) return;
    const id = String(sessionId);
    const set = _appsBySession.get(id);
    if (!set) return;
    set.delete(app);
    if (!set.size) _appsBySession.delete(id);
}

function getSessionApps(sessionId)
{
    if (!sessionId) return [];
    return Array.from(_appsBySession.get(String(sessionId)) ?? []);
}

function normalizeTargetUserIds(targetUserIds)
{
    if (!Array.isArray(targetUserIds)) return null;
    return targetUserIds.map(String).filter(Boolean);
}

function getActiveNonGMUserIds()
{
    const users = Array.from(game.users ?? []);
    return users.filter(u => u?.active && !u.isGM).map(u => u.id);
}

async function whisperFallback({ whisperUserIds, payload } = {})
{
    try
    {
        if (!Array.isArray(whisperUserIds) || !whisperUserIds.length) return;

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

async function sendStateUpdate({ sessionId, state, targetUserIds } = {})
{
    if (!sessionId) return;

    const payload = {
        action: ACTION_STATE,
        broadcastId: foundry.utils.randomID?.() ?? Math.random().toString(36).slice(2),
        sessionId: String(sessionId),
        senderId: game.user?.id,
        targetUserIds: normalizeTargetUserIds(targetUserIds),
        ts: safeNow(),
        state
    };

    game.socket?.emit?.(SOCKET_CHANNEL, payload);

    // Whisper fallback (best effort)
    const whisperUserIds = payload.targetUserIds ?? getActiveNonGMUserIds();
    void whisperFallback({ whisperUserIds, payload });
}

async function sendSolvedRequest({ sessionId, state } = {})
{
    if (!sessionId) return;

    const payload = {
        action: ACTION_SOLVED,
        broadcastId: foundry.utils.randomID?.() ?? Math.random().toString(36).slice(2),
        sessionId: String(sessionId),
        senderId: game.user?.id,
        ts: safeNow(),
        state
    };

    // Only the GM should act on these, so broadcast is fine.
    game.socket?.emit?.(SOCKET_CHANNEL, payload);

    // Whisper fallback to all active GMs
    const gms = Array.from(game.users ?? []).filter(u => u?.active && u.isGM).map(u => u.id);
    void whisperFallback({ whisperUserIds: gms, payload });
}

async function handleOpenPayload(message)
{
    if (message.senderId && message.senderId === game.user?.id) return;

    const sender = game.users?.get?.(message.senderId);
    if (!sender?.isGM) return;

    const targetUserIds = Array.isArray(message.targetUserIds) ? message.targetUserIds : null;
    if (targetUserIds && !targetUserIds.includes(game.user?.id)) return;
    if (message.excludeGMs && game.user?.isGM) return;

    const definition = message.definition;
    if (!definition || typeof definition !== "object") return;

    if (wasHandled(message.broadcastId ?? null)) return;

    const initialState = message.initialState ?? null;
    const sessionId = message.sessionId ?? message.broadcastId ?? null;
    setSessionDefinition(sessionId, definition);

    const mod = await import("./puzzle-application.js");
    const PuzzleApplication = mod?.PuzzleApplication;
    if (!PuzzleApplication) return;

    const app = new PuzzleApplication(definition, {
        initialState,
        sessionId,
        enableSync: true,
        dpSource: { type: "broadcast", sessionId }
    });

    registerSessionApp(sessionId, app);
    app.render(true);

    game.socket?.emit?.(SOCKET_CHANNEL, {
        action: ACTION_ACK,
        broadcastId: message.broadcastId ?? null,
        originalSenderId: message.senderId,
        senderId: game.user?.id,
        ts: safeNow()
    });
}

async function handleStatePayload(message)
{
    const sessionId = message.sessionId ?? null;
    if (!sessionId) return;

    const targetUserIds = Array.isArray(message.targetUserIds) ? message.targetUserIds : null;
    if (targetUserIds && !targetUserIds.includes(game.user?.id)) return;

    const apps = getSessionApps(sessionId);
    for (const app of apps)
    {
        try
        {
            app.applyRemoteState?.({ state: message.state, senderId: message.senderId, ts: message.ts });
        } catch
        {
            // ignore
        }
    }
}

async function handleSolvedPayload(message)
{
    // GM-only action
    if (!game.user?.isGM) return;

    const sessionId = message.sessionId ?? null;
    if (!sessionId) return;

    const ok = tryMarkSessionSolved(sessionId);
    if (!ok) return;

    const handler = getSessionSolvedHandler(sessionId);
    const definition = getSessionDefinition(sessionId);

    if (typeof handler === "function")
    {
        try
        {
            await handler({ puzzle: definition, app: null, sessionId: String(sessionId), state: message.state ?? null });
        } catch (error)
        {
            console.error("Draggable Puzzle | GM solved handler failed", error);
        }
    }
}

export function bindSocketOnce()
{
    if (_bound) return;
    _bound = true;

    game.socket?.on?.(SOCKET_CHANNEL, async (message) =>
    {
        try
        {
            if (!message || !message.action) return;

            if (message.action === ACTION_PING)
            {
                // Reply with ACK
                game.socket?.emit?.(SOCKET_CHANNEL, {
                    action: ACTION_ACK,
                    broadcastId: message.broadcastId ?? null,
                    originalSenderId: message.senderId,
                    senderId: game.user?.id,
                    ts: safeNow()
                });
                return;
            }

            if (message.action === ACTION_OPEN) return void handleOpenPayload({ ...message, transport: "socket" });
            if (message.action === ACTION_STATE) return void handleStatePayload({ ...message, transport: "socket" });
            if (message.action === ACTION_SOLVED) return void handleSolvedPayload({ ...message, transport: "socket" });
        } catch (error)
        {
            console.error("Draggable Puzzle | Socket handler failed", error);
        }
    });

    // Chat fallback receiver
    Hooks.on("createChatMessage", async (chatMessage) =>
    {
        try
        {
            const payload = chatMessage?.flags?.[MODULE_ID]?.payload ?? null;
            if (!payload || typeof payload !== "object") return;

            const authorId = chatMessage?.author?.id ?? chatMessage?.authorId ?? null;
            const author = chatMessage?.author ?? (authorId ? game.users?.get?.(authorId) : null);
            if (!author) return;

            if (payload.action === ACTION_OPEN && !author.isGM) return;

            const whisper = Array.isArray(chatMessage?.whisper) ? chatMessage.whisper : [];
            if (whisper.length && !whisper.includes(game.user?.id) && authorId !== game.user?.id) return;

            if (payload.action === ACTION_OPEN) return void handleOpenPayload({ ...payload, transport: "chat" });
            if (payload.action === ACTION_STATE) return void handleStatePayload({ ...payload, transport: "chat" });
            if (payload.action === ACTION_SOLVED) return void handleSolvedPayload({ ...payload, transport: "chat" });
        } catch (error)
        {
            console.error("Draggable Puzzle | Chat fallback handling failed", error);
        }
    });

    // Expose helpers
    game.draggablePuzzle = game.draggablePuzzle ?? {};
    game.draggablePuzzle._dpRegisterSessionApp = registerSessionApp;
    game.draggablePuzzle._dpUnregisterSessionApp = unregisterSessionApp;
    game.draggablePuzzle._dpRegisterSessionSolvedHandler = (sessionId, { definition, onSolved } = {}) =>
    {
        if (!sessionId) return;
        if (definition) setSessionDefinition(sessionId, definition);
        if (typeof onSolved === "function") setSessionSolvedHandler(sessionId, onSolved);
    };
    game.draggablePuzzle._dpTryMarkSessionSolved = (sessionId) => tryMarkSessionSolved(sessionId);
    game.draggablePuzzle.sendSessionState = (sessionId, state, opts = {}) =>
        sendStateUpdate({ sessionId, state, targetUserIds: opts?.targetUserIds ?? null });
    game.draggablePuzzle.requestSolved = (sessionId, { state } = {}) =>
        sendSolvedRequest({ sessionId, state });
}

Hooks.once("ready", () =>
{
    bindSocketOnce();
});
