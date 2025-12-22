import { MODULE_ID } from "./constants.js";

// Hide internal chat transport messages from the chat log UI.
function hideTransportMessage(message, html)
{
    try
    {
        const isTransport = Boolean(message?.flags?.[MODULE_ID]?.transport);
        if (!isTransport) return;

        // v13: html is an HTMLElement. Older versions: may be jQuery.
        const el = html?.nodeType === 1 ? html : html?.[0];
        if (el) el.style.display = "none";
    } catch
    {
        // ignore
    }
}

// Foundry v13+
Hooks.on("renderChatMessageHTML", (message, html) =>
{
    hideTransportMessage(message, html);
});

// Back-compat for Foundry <= v12 (avoid registering on v13 to prevent warnings)
Hooks.once("init", () =>
{
    try
    {
        const generation = Number(game?.release?.generation);
        if (!Number.isFinite(generation)) return;
        if (generation >= 13) return;

        Hooks.on("renderChatMessage", (message, html) =>
        {
            hideTransportMessage(message, html);
        });
    } catch
    {
        // ignore
    }
});
