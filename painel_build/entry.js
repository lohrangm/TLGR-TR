import { TelegramClient } from "teleproto/client/TelegramClient.js";
import { StringSession } from "teleproto/sessions/StringSession.js";
import { PromisedWebSockets } from "teleproto/extensions/PromisedWebSockets.js";

window.TeleprotoBridge = { TelegramClient, StringSession, PromisedWebSockets };
