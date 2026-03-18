import { Gtk, Gdk } from "ags/gtk4"
import GObject from "gi://GObject"
import Hyprland from "gi://AstalHyprland"
import { createState, createComputed, createEffect, For, Accessor } from "ags"
import {
  ALL_MONITORS,
  WorkspaceDefinition,
  applyWorkspaceName,
  getAssignedMonitors,
  getNextWorkspaceId,
  loadWorkspaceDefinitionsWithRuntime,
  saveWorkspaceDefinitions,
} from "../lib/config"

const hypr = Hyprland.get_default()!

interface Props {
  previewWorkspaceId: Accessor<number>
  setPreviewWorkspaceId: (id: number) => void
}

interface WorkspaceView extends WorkspaceDefinition {
  displayName: string
  assignedMonitors: string[]
  hasWindows: boolean
}

interface EditorDraft {
  mode: "create" | "edit"
  id: number | null
  name: string
  monitors: string[]
}

function serializeWorkspaces(workspaces: WorkspaceView[]): WorkspaceDefinition[] {
  return workspaces.map(({ id, name, monitors }) => ({
    id,
    name,
    monitors: [...monitors],
  }))
}

function reorderWorkspaces(
  workspaces: WorkspaceDefinition[],
  sourceId: number,
  targetId: number,
): WorkspaceDefinition[] {
  if (sourceId === targetId) {
    return workspaces
  }

  const next = [...workspaces]
  const sourceIndex = next.findIndex((workspace) => workspace.id === sourceId)
  const targetIndex = next.findIndex((workspace) => workspace.id === targetId)

  if (sourceIndex === -1 || targetIndex === -1) {
    return workspaces
  }

  const [moved] = next.splice(sourceIndex, 1)
  const insertIndex = sourceIndex < targetIndex ? targetIndex - 1 : targetIndex
  next.splice(insertIndex, 0, moved)
  return next
}

function parseDropPayload(payload: string): { kind: "workspace" | "window"; value: string } | null {
  const trimmed = payload.trim()
  if (!trimmed) {
    return null
  }

  if (trimmed.startsWith("workspace:")) {
    return {
      kind: "workspace",
      value: trimmed.slice("workspace:".length),
    }
  }

  if (trimmed.startsWith("window:")) {
    return {
      kind: "window",
      value: trimmed.slice("window:".length),
    }
  }

  return {
    kind: "window",
    value: trimmed,
  }
}

export default function WorkspaceStrip({ previewWorkspaceId, setPreviewWorkspaceId }: Props) {
  const [workspaceRevision, setWorkspaceRevision] = createState(0)
  const [clientRevision, setClientRevision] = createState(0)
  const [monitorRevision, setMonitorRevision] = createState(0)
  const [configRevision, setConfigRevision] = createState(0)
  const [editor, setEditor] = createState<EditorDraft | null>(null)

  hypr.connect("workspace-added", (_source, workspace: Hyprland.Workspace) => {
    applyWorkspaceName(workspace.get_id())
    setWorkspaceRevision((value) => value + 1)
  })
  hypr.connect("workspace-removed", () => setWorkspaceRevision((value) => value + 1))
  hypr.connect("client-added", () => setClientRevision((value) => value + 1))
  hypr.connect("client-removed", () => setClientRevision((value) => value + 1))
  hypr.connect("monitor-added", () => setMonitorRevision((value) => value + 1))
  hypr.connect("monitor-removed", () => setMonitorRevision((value) => value + 1))
  hypr.connect("notify::focused-monitor", () => setMonitorRevision((value) => value + 1))

  const workspaceState = createComputed(() => {
    workspaceRevision()
    clientRevision()
    monitorRevision()
    configRevision()

    const currentMonitorNames = hypr
      .get_monitors()
      .map((monitor) => monitor.get_name())
      .filter(Boolean)
    const liveNames = new Map(
      hypr
        .get_workspaces()
        .filter((workspace) => workspace.get_id() > 0)
        .map((workspace) => [workspace.get_id(), workspace.get_name()]),
    )
    const occupiedWorkspaceIds = new Set(
      hypr
        .get_clients()
        .filter((client) => client.get_mapped() && !client.get_hidden())
        .map((client) => client.get_workspace()?.get_id())
        .filter((id): id is number => id != null && id > 0),
    )

    const allWorkspaces = loadWorkspaceDefinitionsWithRuntime().map((workspace) => {
      const displayName = workspace.name.trim() || liveNames.get(workspace.id) || String(workspace.id)
      const assignedMonitors = getAssignedMonitors(workspace, currentMonitorNames)

      return {
        ...workspace,
        displayName,
        assignedMonitors,
        hasWindows: occupiedWorkspaceIds.has(workspace.id),
      } satisfies WorkspaceView
    })

    return {
      monitorNames: currentMonitorNames,
      allWorkspaces,
      visibleWorkspaces: allWorkspaces,
    }
  })

  const allWorkspaces = createComputed(() => workspaceState().allWorkspaces)
  const visibleWorkspaces = createComputed(() => workspaceState().visibleWorkspaces)
  const stripItems = createComputed<(WorkspaceView | null)[]>(() => [...visibleWorkspaces(), null])
  const monitorNames = createComputed(() => workspaceState().monitorNames)
  const selectedWorkspace = createComputed(
    () => allWorkspaces().find((workspace) => workspace.id === previewWorkspaceId()) ?? null,
  )
  const hasSelectedWorkspace = createComputed(() => selectedWorkspace() !== null)
  const canDeleteSelected = createComputed(
    () => allWorkspaces().length > 1 && selectedWorkspace() !== null,
  )
  const editorVisible = createComputed(() => editor() !== null)
  const editorTitle = createComputed(() => {
    const current = editor()
    if (!current) {
      return ""
    }

    return current.mode === "create" ? "Create Workspace" : `Edit Workspace #${current.id}`
  })
  const editorName = createComputed(() => editor()?.name ?? "")
  const editorSaveLabel = createComputed(() => editor()?.mode === "create" ? "Create" : "Save")

  createEffect(() => {
    const visible = visibleWorkspaces()
    if (visible.length === 0) {
      return
    }

    const currentId = previewWorkspaceId()
    if (!visible.some((workspace) => workspace.id === currentId)) {
      setPreviewWorkspaceId(visible[0].id)
    }
  })

  function refreshConfig() {
    setConfigRevision((value) => value + 1)
  }

  function switchToWorkspace(id: number) {
    setPreviewWorkspaceId(id)
  }

  function openCreateEditor() {
    const currentMonitorNames = monitorNames()
    setEditor({
      mode: "create",
      id: null,
      name: "",
      monitors: [...currentMonitorNames],
    })
  }

  function openEditEditor(workspace: WorkspaceView | null = selectedWorkspace()) {
    if (!workspace) {
      return
    }

    const currentMonitorNames = monitorNames()
    const nextMonitors = workspace.assignedMonitors.length > 0
      ? workspace.assignedMonitors
      : currentMonitorNames

    setEditor({
      mode: "edit",
      id: workspace.id,
      name: workspace.displayName,
      monitors: [...nextMonitors],
    })
  }

  function closeEditor() {
    setEditor(null)
  }

  function toggleDraftMonitor(monitorName: string) {
    setEditor((current) => {
      if (!current) {
        return current
      }

      const selected = new Set(current.monitors)
      if (selected.has(monitorName)) {
        if (selected.size === 1) {
          return current
        }
        selected.delete(monitorName)
      } else {
        selected.add(monitorName)
      }

      const ordered = monitorNames().filter((monitor) => selected.has(monitor))
      return {
        ...current,
        monitors: ordered,
      }
    })
  }

  function saveEditor() {
    const current = editor()
    if (!current) {
      return
    }

    const base = serializeWorkspaces(allWorkspaces())
    const availableMonitors = monitorNames()

    const workspaceId = current.mode === "create"
      ? getNextWorkspaceId(base)
      : current.id
    if (!workspaceId) {
      return
    }

    const trimmedName = current.name.trim() || String(workspaceId)
    const selectedMonitors = availableMonitors.length === 0
      ? [ALL_MONITORS]
      : current.monitors.length === availableMonitors.length
        ? [ALL_MONITORS]
        : current.monitors

    const nextWorkspace = {
      id: workspaceId,
      name: trimmedName,
      monitors: selectedMonitors,
    }

    const next = current.mode === "create"
      ? [...base, nextWorkspace]
      : base.map((workspace) => workspace.id === workspaceId ? nextWorkspace : workspace)

    saveWorkspaceDefinitions(next)
    refreshConfig()
    applyWorkspaceName(workspaceId)
    setPreviewWorkspaceId(workspaceId)
    closeEditor()
  }

  function deleteWorkspace(workspace: WorkspaceView | null = selectedWorkspace()) {
    if (!workspace) {
      return
    }

    const base = serializeWorkspaces(allWorkspaces())
    if (base.length <= 1) {
      return
    }

    const workspaceIndex = base.findIndex((item) => item.id === workspace.id)
    if (workspaceIndex === -1) {
      return
    }

    const fallback = base[workspaceIndex + 1] ?? base[workspaceIndex - 1]
    if (!fallback) {
      return
    }

    const clientsToMove = hypr
      .get_clients()
      .filter((client) => client.get_mapped() && !client.get_hidden())
      .filter((client) => client.get_workspace()?.get_id() === workspace.id)

    for (const client of clientsToMove) {
      const address = client.get_address()
      const normalizedAddress = address.startsWith("0x") ? address : `0x${address}`
      hypr.dispatch("movetoworkspacesilent", `${fallback.id},address:${normalizedAddress}`)
    }

    if (hypr.get_focused_workspace()?.get_id() === workspace.id) {
      hypr.dispatch("workspace", String(fallback.id))
    }

    saveWorkspaceDefinitions(base.filter((item) => item.id !== workspace.id))
    refreshConfig()

    if (previewWorkspaceId() === workspace.id) {
      setPreviewWorkspaceId(fallback.id)
    }

    if (editor()?.id === workspace.id) {
      closeEditor()
    }
  }

  function moveWindowToWorkspace(workspaceId: number, address: string) {
    const normalizedAddress = address.startsWith("0x") ? address : `0x${address}`
    hypr.dispatch("movetoworkspacesilent", `${workspaceId},address:${normalizedAddress}`)
  }

  function reorderWorkspace(sourceId: number, targetId: number) {
    const base = serializeWorkspaces(allWorkspaces())
    const next = reorderWorkspaces(base, sourceId, targetId)
    if (next === base) {
      return
    }

    saveWorkspaceDefinitions(next)
    refreshConfig()
  }

  function handleDrop(workspaceId: number, payload: string) {
    const parsed = parseDropPayload(payload)
    if (!parsed) {
      return
    }

    if (parsed.kind === "workspace") {
      const sourceId = Number(parsed.value)
      if (Number.isFinite(sourceId)) {
        reorderWorkspace(sourceId, workspaceId)
      }
      return
    }

    moveWindowToWorkspace(workspaceId, parsed.value)
  }

  return (
    <box orientation={Gtk.Orientation.VERTICAL} spacing={12}>
      <box class="workspace-strip" halign={Gtk.Align.CENTER} spacing={8}>
        <For each={stripItems}>
          {(workspace) => {
            if (workspace === null) {
              const createClickGesture = Gtk.GestureClick.new()
              createClickGesture.set_button(1)
              createClickGesture.connect("released", () => {
                openCreateEditor()
              })

              return (
                <box orientation={Gtk.Orientation.VERTICAL} spacing={6} valign={Gtk.Align.START}>
                  <box
                    class="workspace-add workspace-add-icon"
                    $={(self) => {
                      self.add_controller(createClickGesture)
                    }}
                  >
                    <label
                      label="+"
                      xalign={0.5}
                      hexpand
                      halign={Gtk.Align.CENTER}
                      valign={Gtk.Align.CENTER}
                    />
                  </box>
                  <box class="workspace-active-actions" />
                </box>
              )
            }

            const workspaceId = workspace.id
            const isActive = createComputed(() => previewWorkspaceId() === workspaceId)

            const dropTarget = Gtk.DropTarget.new(GObject.TYPE_STRING, Gdk.DragAction.MOVE)
            dropTarget.connect("drop", (_self: Gtk.DropTarget, value: unknown) => {
              handleDrop(workspaceId, String(value))
              return true
            })

            const dragSource = Gtk.DragSource.new()
            dragSource.set_actions(Gdk.DragAction.MOVE)
            dragSource.connect("prepare", () => {
              return Gdk.ContentProvider.new_for_value(`workspace:${workspaceId}`)
            })

            const clickGesture = Gtk.GestureClick.new()
            clickGesture.set_button(1)
            clickGesture.connect("released", (_self, nPress) => {
              if (nPress === 2) {
                openEditEditor(workspace)
                return
              }

              if (nPress === 1) {
                switchToWorkspace(workspaceId)
              }
            })

            return (
              <box orientation={Gtk.Orientation.VERTICAL} spacing={6} valign={Gtk.Align.START}>
                <box
                  class={isActive.as((active: boolean) => `workspace-pill ${active ? "active" : ""}`)}
                  $={(self) => {
                    self.add_controller(dropTarget)
                    self.add_controller(dragSource)
                    self.add_controller(clickGesture)
                  }}
                >
                  <label
                    label={workspace.displayName}
                    widthChars={3}
                    xalign={0.5}
                    hexpand
                    halign={Gtk.Align.CENTER}
                    valign={Gtk.Align.CENTER}
                  />
                </box>

                <box
                  class="workspace-active-actions"
                  visible={isActive}
                  spacing={6}
                  halign={Gtk.Align.CENTER}
                >
                  <button class="workspace-icon-btn" onClicked={() => openEditEditor(workspace)}>
                    <image iconName="document-edit-symbolic" pixelSize={14} />
                  </button>
                  <button
                    class="workspace-icon-btn workspace-icon-danger"
                    sensitive={canDeleteSelected}
                    onClicked={() => deleteWorkspace(workspace)}
                  >
                    <image iconName="user-trash-symbolic" pixelSize={14} />
                  </button>
                </box>
              </box>
            )
          }}
        </For>
      </box>

      <box
        class="workspace-editor"
        visible={editorVisible}
        orientation={Gtk.Orientation.VERTICAL}
        spacing={12}
        halign={Gtk.Align.CENTER}
      >
        <box spacing={12}>
          <label class="workspace-editor-title" label={editorTitle} xalign={0} />
          <box hexpand />
          <label
            class="workspace-editor-monitor-hint"
            visible={createComputed(() => {
              const current = editor()
              return current !== null && current.monitors.length === monitorNames().length
            })}
            label="Visible on all monitors"
          />
        </box>

        <Gtk.Entry
          placeholderText="Workspace name"
          text={editorName}
          widthChars={24}
          hexpand
          $={(self: Gtk.Entry) => {
            self.connect("changed", () => {
              setEditor((current) => current ? { ...current, name: self.get_text() } : current)
            })
            self.connect("activate", saveEditor)
            self.connect("map", () => {
              if (!editorVisible()) {
                return
              }
              self.grab_focus()
              self.select_region(0, -1)
            })
          }}
        />

        <box orientation={Gtk.Orientation.VERTICAL} spacing={8}>
          <label class="workspace-editor-subtitle" label="Monitors" xalign={0} />
          <box class="workspace-monitor-list" spacing={8}>
            <For each={monitorNames}>
              {(monitorName) => {
                const isSelected = createComputed(() => editor()?.monitors.includes(monitorName) ?? false)
                return (
                  <button
                    class={isSelected.as((selected: boolean) => `workspace-monitor ${selected ? "active" : ""}`)}
                    onClicked={() => toggleDraftMonitor(monitorName)}
                  >
                    <label label={monitorName} />
                  </button>
                )
              }}
            </For>
          </box>
        </box>

        <box spacing={8} halign={Gtk.Align.END}>
          <button class="workspace-secondary" onClicked={closeEditor}>
            <label label="Cancel" />
          </button>
          <button class="workspace-primary" onClicked={saveEditor}>
            <label label={editorSaveLabel} />
          </button>
        </box>
      </box>
    </box>
  )
}
