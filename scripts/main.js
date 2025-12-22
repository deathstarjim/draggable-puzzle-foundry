import { MODULE_ID, SETTING_KEY } from "./constants.js";
import { registerDraggablePuzzleApi } from "./api.js";
import "./socket.js";
import "./chat-hooks.js";
import "./puzzle-hooks.js";
import "./ui-hooks.js";

Hooks.once("init", () =>
{
  game.settings.register(MODULE_ID, SETTING_KEY, {
    name: "Draggable Puzzle: Saved Config",
    hint: "Internal storage for the saved puzzle configuration.",
    scope: "world",
    config: false,
    type: Object,
    default: {}
  });
});

Hooks.once("ready", () =>
{
  try
  {
    registerDraggablePuzzleApi();
  } catch (error)
  {
    console.error("Draggable Puzzle | Failed to register API", error);
  }
});
