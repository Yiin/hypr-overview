import { readFile, writeFile } from "ags/file"
import GLib from "gi://GLib"
import Hyprland from "gi://AstalHyprland"

const hypr = Hyprland.get_default()!

const CONFIG_DIR = GLib.get_home_dir() + "/.config/ags"
const CONFIG_PATH = `${CONFIG_DIR}/workspaces.json`

export const ALL_MONITORS = "*"

export interface WorkspaceDefinition {
  id: number
  name: string
  monitors: string[]
}

interface WorkspaceConfig {
  version: 2
  workspaces: WorkspaceDefinition[]
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes)
}

function ensureConfigDir() {
  GLib.mkdir_with_parents(CONFIG_DIR, 0o755)
}

function normalizeWorkspace(workspace: WorkspaceDefinition): WorkspaceDefinition | null {
  const id = Math.trunc(workspace.id)
  if (!Number.isFinite(id) || id <= 0) {
    return null
  }

  const name = workspace.name.trim() || String(id)
  const monitorSet = new Set(
    (workspace.monitors ?? [])
      .map((monitor) => monitor.trim())
      .filter(Boolean),
  )
  const monitors = monitorSet.has(ALL_MONITORS)
    ? [ALL_MONITORS]
    : Array.from(monitorSet)

  return { id, name, monitors }
}

function normalizeWorkspaceDefinitions(workspaces: WorkspaceDefinition[]): WorkspaceDefinition[] {
  const normalized: WorkspaceDefinition[] = []
  const seenIds = new Set<number>()

  for (const workspace of workspaces) {
    const next = normalizeWorkspace(workspace)
    if (!next || seenIds.has(next.id)) {
      continue
    }
    seenIds.add(next.id)
    normalized.push(next)
  }

  return normalized
}

function getRuntimeWorkspaceDefinitions(): WorkspaceDefinition[] {
  return normalizeWorkspaceDefinitions(
    hypr
      .get_workspaces()
      .filter((workspace) => workspace.get_id() > 0)
      .sort((a, b) => a.get_id() - b.get_id())
      .map((workspace) => ({
        id: workspace.get_id(),
        name: workspace.get_name() || String(workspace.get_id()),
        monitors: [ALL_MONITORS],
      })),
  )
}

interface HyprWorkspaceRule {
  workspaceString?: string
  monitor?: string
}

function getRuleWorkspaceDefinitions(): WorkspaceDefinition[] {
  try {
    const [ok, stdout, stderr, status] = GLib.spawn_command_line_sync("hyprctl -j workspacerules")
    if (!ok || status !== 0) {
      const error = stderr ? decode(stderr).trim() : "unknown error"
      console.error(`Failed to read workspace rules: ${error}`)
      return []
    }

    const parsed = JSON.parse(decode(stdout)) as HyprWorkspaceRule[]
    const runtimeById = new Map(
      getRuntimeWorkspaceDefinitions().map((workspace) => [workspace.id, workspace]),
    )
    const byId = new Map<number, WorkspaceDefinition>()

    for (const rule of parsed) {
      const id = Number(rule.workspaceString)
      if (!Number.isInteger(id) || id <= 0) {
        continue
      }

      const current = byId.get(id) ?? {
        id,
        name: runtimeById.get(id)?.name ?? String(id),
        monitors: [],
      }

      if (rule.monitor && !current.monitors.includes(rule.monitor)) {
        current.monitors.push(rule.monitor)
      }

      byId.set(id, current)
    }

    return normalizeWorkspaceDefinitions(
      Array.from(byId.values()).sort((a, b) => a.id - b.id),
    )
  } catch (error) {
    console.error(`Failed to parse workspace rules: ${error}`)
    return []
  }
}

function mergeWorkspaceDefinitions(
  persisted: WorkspaceDefinition[],
  extras: WorkspaceDefinition[],
): WorkspaceDefinition[] {
  const merged = [...persisted]
  const seenIds = new Set(persisted.map((workspace) => workspace.id))

  for (const workspace of extras) {
    if (seenIds.has(workspace.id)) {
      continue
    }
    seenIds.add(workspace.id)
    merged.push(workspace)
  }

  return merged
}

export function loadWorkspaceDefinitions(): WorkspaceDefinition[] {
  try {
    const content = readFile(CONFIG_PATH)
    const parsed = JSON.parse(content) as WorkspaceConfig | WorkspaceDefinition[]

    if (Array.isArray(parsed)) {
      return normalizeWorkspaceDefinitions(parsed)
    }

    if (parsed?.version === 2 && Array.isArray(parsed.workspaces)) {
      return normalizeWorkspaceDefinitions(parsed.workspaces)
    }
  } catch {
    // fall through
  }

  const rules = getRuleWorkspaceDefinitions()
  if (rules.length > 0) {
    return mergeWorkspaceDefinitions(rules, getRuntimeWorkspaceDefinitions())
  }

  const runtime = getRuntimeWorkspaceDefinitions()
  if (runtime.length > 0) {
    return runtime
  }

  return [
    {
      id: 1,
      name: "1",
      monitors: [ALL_MONITORS],
    },
  ]
}

export function loadWorkspaceDefinitionsWithRuntime(): WorkspaceDefinition[] {
  return mergeWorkspaceDefinitions(loadWorkspaceDefinitions(), getRuntimeWorkspaceDefinitions())
}

export function saveWorkspaceDefinitions(workspaces: WorkspaceDefinition[]) {
  ensureConfigDir()

  const normalized = normalizeWorkspaceDefinitions(workspaces)
  const config: WorkspaceConfig = {
    version: 2,
    workspaces: normalized,
  }

  writeFile(CONFIG_PATH, JSON.stringify(config, null, 2))
}

export function loadWorkspaceNames(): Record<number, string> {
  return Object.fromEntries(
    loadWorkspaceDefinitionsWithRuntime().map((workspace) => [workspace.id, workspace.name]),
  )
}

export function saveWorkspaceNames(names: Record<number, string>) {
  const existing = loadWorkspaceDefinitionsWithRuntime()
  const byId = new Map(existing.map((workspace) => [workspace.id, workspace]))

  const next = Object.entries(names)
    .map(([id, name]) => {
      const workspaceId = Number(id)
      const current = byId.get(workspaceId)

      return {
        id: workspaceId,
        name,
        monitors: current?.monitors ?? [ALL_MONITORS],
      }
    })
    .filter((workspace) => workspace.id > 0)
    .sort((a, b) => a.id - b.id)

  saveWorkspaceDefinitions(next)
}

export function getNextWorkspaceId(workspaces: WorkspaceDefinition[]): number {
  const usedIds = new Set(workspaces.map((workspace) => workspace.id))
  let candidate = 1

  while (usedIds.has(candidate)) {
    candidate += 1
  }

  return candidate
}

export function getAssignedMonitors(
  workspace: WorkspaceDefinition,
  availableMonitors: string[],
): string[] {
  if (workspace.monitors.length === 0 || workspace.monitors.includes(ALL_MONITORS)) {
    return [...availableMonitors]
  }

  const available = new Set(availableMonitors)
  return workspace.monitors.filter((monitor) => available.has(monitor))
}

export function workspaceIsAssignedToMonitor(
  workspace: WorkspaceDefinition,
  monitorName: string | null,
  availableMonitors: string[],
): boolean {
  if (!monitorName) {
    return true
  }

  if (workspace.monitors.length === 0 || workspace.monitors.includes(ALL_MONITORS)) {
    return true
  }

  return getAssignedMonitors(workspace, availableMonitors).includes(monitorName)
}

export function restoreWorkspaceDefinitions() {
  const definitions = new Map(
    loadWorkspaceDefinitionsWithRuntime().map((workspace) => [workspace.id, workspace]),
  )

  for (const workspace of hypr.get_workspaces()) {
    const id = workspace.get_id()
    if (id <= 0) {
      continue
    }

    const definition = definitions.get(id)
    if (!definition) {
      continue
    }

    const desiredName = definition.name.trim()
    if (!desiredName || workspace.get_name() === desiredName) {
      continue
    }

    try {
      hypr.dispatch("renameworkspace", `${id} ${desiredName}`)
    } catch (error) {
      console.error(`Failed to restore workspace ${id} name: ${error}`)
    }
  }
}

export function restoreWorkspaceNames() {
  restoreWorkspaceDefinitions()
}

export function applyWorkspaceName(id: number) {
  const definition = loadWorkspaceDefinitionsWithRuntime().find((workspace) => workspace.id === id)
  if (!definition) {
    return
  }

  try {
    hypr.dispatch("renameworkspace", `${id} ${definition.name}`)
  } catch (error) {
    console.error(`Failed to apply workspace ${id} name: ${error}`)
  }
}
