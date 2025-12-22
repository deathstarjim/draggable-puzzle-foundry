import { MODULE_ID } from "./constants.js";

// Hide internal chat transport messages from the chat log UI.
Hooks.on("renderChatMessage", (message, html) =>
{
    try
    {
        const isTransport = Boolean(message?.flags?.[MODULE_ID]?.transport);
        if (!isTransport) return;

        // html is a jQuery object in Foundry.
        const el = html?.[0];
        if (el) el.style.display = "none";
    } catch
    {
        // ignore
    }
});
