// WHAT THIS DEVICE REMEMBERS about projects: which one was open last, and which `#app=` link it last imported --
// conveniences, never facts about a project. Everything a project IS (its definition, its name, when it was made,
// its tree binding and versions) is its draft in the owner's tree (`definition.js`), and the list of projects is the
// tree's (`project-list.js`, ARCHITECTURE §19, app-as-data P3b).

/**
 * Until private domains exist (phase 7), everything here is publicly readable. The UI says this in words; the
 * constant is here so the words cannot drift from the fact they state.
 */
export const PUBLIC_UNTIL_PHASE_7 = "public";

/**
 * DEVICE-scoped settings live in browser storage (behind storage.js's guard), never in the tree: "last opened"
 * synced to a second device is wrong there. With no browser storage they last as long as the tab.
 */
export const DEVICE_SETTINGS_KEY = "craftec.builder.device.v1";

export function readDeviceSettings(storage) {
  try { return JSON.parse(storage.getItem(DEVICE_SETTINGS_KEY)) ?? {}; } catch { return {}; }
}

export function writeDeviceSettings(storage, patch) {
  const next = { ...readDeviceSettings(storage), ...patch };
  try { storage.setItem(DEVICE_SETTINGS_KEY, JSON.stringify(next)); } catch { /* private window */ }
  return next;
}
