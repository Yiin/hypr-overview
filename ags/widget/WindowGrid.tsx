import { Gtk } from "ags/gtk4"
import Hyprland from "gi://AstalHyprland"
import { createState, createComputed, For, Accessor } from "ags"
import WindowThumbnail from "./WindowThumbnail"

const hypr = Hyprland.get_default()!

interface Props {
  previewWorkspaceId: Accessor<number>
  focusedAddress: Accessor<string | null>
  onSelectWindow: (address: string) => void
  captureRevision: Accessor<number>
  getStableId: (address: string) => string | null
}

export default function WindowGrid({
  previewWorkspaceId,
  focusedAddress,
  onSelectWindow,
  captureRevision,
  getStableId,
}: Props) {
  const [clientRevision, setClientRevision] = createState(0)

  hypr.connect("client-added", () => setClientRevision((v) => v + 1))
  hypr.connect("client-removed", () => setClientRevision((v) => v + 1))

  const clients = createComputed(() => {
    clientRevision()
    const wsId = previewWorkspaceId()
    return hypr.get_clients().filter((c) => {
      const ws = c.get_workspace()
      return ws && ws.get_id() === wsId && c.get_mapped() && !c.get_hidden()
    })
  })

  const isEmpty = createComputed(() => clients().length === 0)

  function handleClose(address: string) {
    const addr = address.startsWith("0x") ? address : `0x${address}`
    hypr.dispatch("closewindow", `address:${addr}`)
  }

  return (
    <Gtk.ScrolledWindow
      class="window-grid-scroll"
      hexpand
      vexpand
      hscrollbarPolicy={Gtk.PolicyType.NEVER}
      vscrollbarPolicy={Gtk.PolicyType.AUTOMATIC}
    >
      <box class="window-grid-container" orientation={Gtk.Orientation.VERTICAL}>
        <box
          class="empty-state"
          visible={isEmpty}
          hexpand
          vexpand
          halign={Gtk.Align.CENTER}
          valign={Gtk.Align.CENTER}
        >
          <label label="No windows" class="empty-label" />
        </box>

        <box
          class="window-grid"
          visible={isEmpty.as((e: boolean) => !e)}
          halign={Gtk.Align.CENTER}
          valign={Gtk.Align.START}
          spacing={20}
          homogeneous={false}
        >
          <For each={clients}>
            {(client) => (
              <WindowThumbnail
                client={client}
                isFocused={client.get_address() === focusedAddress()}
                onSelect={onSelectWindow}
                onClose={handleClose}
                captureRevision={captureRevision}
                getStableId={getStableId}
              />
            )}
          </For>
        </box>
      </box>
    </Gtk.ScrolledWindow>
  )
}
