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
  const clientRows = createComputed(() => {
    const visibleClients = clients()
    const rows: Array<Array<Hyprland.Client>> = []

    for (let i = 0; i < visibleClients.length; i += 3) {
      rows.push(visibleClients.slice(i, i + 3))
    }

    return rows
  })

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
      <box
        class="window-grid-container"
        orientation={Gtk.Orientation.VERTICAL}
        hexpand
        vexpand
        halign={Gtk.Align.FILL}
      >
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
          orientation={Gtk.Orientation.VERTICAL}
          halign={Gtk.Align.CENTER}
          valign={Gtk.Align.START}
          hexpand
          spacing={16}
        >
          <For each={clientRows}>
            {(row) => (
              <box spacing={16} halign={Gtk.Align.CENTER}>
                <For each={() => row}>
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
            )}
          </For>
        </box>
      </box>
    </Gtk.ScrolledWindow>
  )
}
