import { readFile, writeFile } from "ags/file"
import GLib from "gi://GLib"
import Hyprland from "gi://AstalHyprland"

const CONFIG_PATH = GLib.get_home_dir() + "/.config/ags/workspace-names.json"

export function loadWorkspaceNames(): Record<number, string> {
  try {
    const content = readFile(CONFIG_PATH)
    return JSON.parse(content)
  } catch {
    return {}
  }
}

export function saveWorkspaceNames(names: Record<number, string>) {
  writeFile(CONFIG_PATH, JSON.stringify(names, null, 2))
}

export function restoreWorkspaceNames() {
  const hypr = Hyprland.get_default()!
  const names = loadWorkspaceNames()
  const existingIds = new Set(hypr.get_workspaces().map((ws) => ws.get_id()))

  for (const [id, name] of Object.entries(names)) {
    if (!existingIds.has(Number(id))) continue
    try {
      hypr.dispatch("renameworkspace", `${id} ${name}`)
    } catch (e) {
      console.error(`Failed to restore workspace ${id} name: ${e}`)
    }
  }
}
