import { Gtk, Gdk } from "ags/gtk4"
import GObject from "gi://GObject"
import Hyprland from "gi://AstalHyprland"
import { createState, createComputed, For, Accessor } from "ags"
import { loadWorkspaceNames, saveWorkspaceNames } from "../lib/config"

const hypr = Hyprland.get_default()!
const WORKSPACE_IDS = [1, 2, 3, 4, 5, 6, 7, 8, 9]

interface Props {
  previewWorkspaceId: Accessor<number>
  setPreviewWorkspaceId: (id: number) => void
}

export default function WorkspaceStrip({ previewWorkspaceId, setPreviewWorkspaceId }: Props) {
  const [wsRevision, setWsRevision] = createState(0)
  const [clientRevision, setClientRevision] = createState(0)

  hypr.connect("workspace-added", () => setWsRevision((v) => v + 1))
  hypr.connect("workspace-removed", () => setWsRevision((v) => v + 1))
  hypr.connect("client-added", () => setClientRevision((v) => v + 1))
  hypr.connect("client-removed", () => setClientRevision((v) => v + 1))

  const workspaces = createComputed(() => {
    wsRevision()
    clientRevision()
    const savedNames = loadWorkspaceNames()
    const currentNames = new Map(
      hypr
        .get_workspaces()
        .filter((ws) => ws.get_id() > 0)
        .map((ws) => [ws.get_id(), ws.get_name()]),
    )
    const occupiedWorkspaceIds = new Set(
      hypr
        .get_clients()
        .filter((client) => client.get_mapped() && !client.get_hidden())
        .map((client) => client.get_workspace()?.get_id())
        .filter((id): id is number => id != null && id > 0),
    )
    const selectedWorkspaceId = previewWorkspaceId()

    return WORKSPACE_IDS
      .filter((id) => id <= 5 || occupiedWorkspaceIds.has(id) || id === selectedWorkspaceId)
      .map((id) => ({
        id,
        name: savedNames[id] || currentNames.get(id) || String(id),
      }))
  })

  const [editingId, setEditingId] = createState<number | null>(null)

  function switchToWorkspace(id: number) {
    setPreviewWorkspaceId(id)
  }

  function finishRename(id: number, newName: string) {
    setEditingId(null)
    if (newName.trim()) {
      hypr.dispatch("renameworkspace", `${id} ${newName.trim()}`)
      const names = loadWorkspaceNames()
      names[id] = newName.trim()
      saveWorkspaceNames(names)
    }
  }

  function cancelRename() {
    setEditingId(null)
  }

  function handleDrop(wsId: number, address: string) {
    const addr = address.startsWith("0x") ? address : `0x${address}`
    hypr.dispatch("movetoworkspacesilent", `${wsId},address:${addr}`)
  }

  return (
    <box class="workspace-strip" halign={Gtk.Align.CENTER} spacing={8}>
      <For each={workspaces}>
        {(ws) => {
          const wsId = ws.id
          const isActive = createComputed(() => previewWorkspaceId() === wsId)
          const isEditing = createComputed(() => editingId() === wsId)

          // DropTarget for receiving dragged windows
          const dropTarget = Gtk.DropTarget.new(GObject.TYPE_STRING, Gdk.DragAction.MOVE)
          dropTarget.connect("drop", (_self: Gtk.DropTarget, value: unknown) => {
            handleDrop(wsId, value as string)
            return true
          })

          return (
            <box
              class={isActive.as((a: boolean) => `workspace-pill ${a ? "active" : ""}`)}
              $={(self) => {
                self.add_controller(dropTarget)

                // Gesture for single-click (switch) and double-click (rename)
                const gesture = new Gtk.GestureClick()
                gesture.set_button(1)
                gesture.connect("released", (_self: Gtk.GestureClick, nPress: number) => {
                  if (nPress === 2) {
                    setEditingId(wsId)
                  } else if (nPress === 1) {
                    switchToWorkspace(wsId)
                  }
                })
                self.add_controller(gesture)
              }}
            >
              <Gtk.Stack
                visibleChildName={isEditing.as((e: boolean) => e ? "edit" : "label")}
                transitionType={Gtk.StackTransitionType.CROSSFADE}
              >
                <label
                  $type="named"
                  name="label"
                  label={ws.name}
                  widthChars={3}
                  halign={Gtk.Align.CENTER}
                />
                <Gtk.Entry
                  $type="named"
                  name="edit"
                  widthChars={8}
                  $={(self: Gtk.Entry) => {
                    self.connect("activate", () => {
                      finishRename(wsId, self.get_text())
                    })

                    const keyCtrl = new Gtk.EventControllerKey()
                    keyCtrl.connect("key-pressed", (_self: Gtk.EventControllerKey, keyval: number) => {
                      if (keyval === Gdk.KEY_Escape) {
                        cancelRename()
                        return true
                      }
                      return false
                    })
                    self.add_controller(keyCtrl)

                    // Focus entry when editing starts
                    self.connect("map", () => {
                      if (editingId() === wsId) {
                        self.grab_focus()
                        self.select_region(0, -1)
                      }
                    })
                  }}
                />
              </Gtk.Stack>
            </box>
          )
        }}
      </For>
    </box>
  )
}
