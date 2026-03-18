import app from "ags/gtk4/app"
import { Astal, Gtk, Gdk } from "ags/gtk4"
import Hyprland from "gi://AstalHyprland"
import GLib from "gi://GLib"
import { execAsync } from "ags/process"
import { createState } from "ags"
import { clearCaptureTargets, setCaptureTargets } from "../lib/overviewd"
import WorkspaceStrip from "./WorkspaceStrip"
import WindowGrid from "./WindowGrid"

const hypr = Hyprland.get_default()!
const REFRESH_INTERVAL_MS = 33
const OVERVIEWD_RUNNER = `${GLib.get_home_dir()}/.config/ags/native/run-hypr-overviewd.sh`

function normalizeAddress(address: string): string {
  return address.startsWith("0x") ? address.slice(2) : address
}

// Fetch stableId mapping from hyprctl (not available in AstalHyprland)
async function getStableIds(): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  try {
    const json = await execAsync(["hyprctl", "clients", "-j"])
    const clients = JSON.parse(json) as Array<{ address: string; stableId: number }>
    for (const c of clients) {
      map.set(normalizeAddress(c.address), String(c.stableId))
    }
  } catch (e) {
    console.error(`Failed to get stableIds: ${e}`)
  }
  return map
}

async function ensureOverviewdRunning(): Promise<void> {
  try {
    await execAsync(["pgrep", "-u", GLib.get_user_name(), "-x", "hypr-overviewd"])
  } catch {
    try {
      await execAsync(["bash", "-lc", `${OVERVIEWD_RUNNER} >/dev/null 2>&1 &`])
      await new Promise((resolve) => setTimeout(resolve, 300))
    } catch (e) {
      console.error(`Failed to start hypr-overviewd: ${e}`)
    }
  }
}

export default function Overview() {
  const [previewWorkspaceId, setPreviewWorkspaceId] = createState(
    hypr.get_focused_workspace()?.get_id() ?? 1,
  )
  const [focusedAddress, setFocusedAddress] = createState<string | null>(null)
  const [captureRevision, setCaptureRevision] = createState(0)

  let overviewWindow: Gtk.Window | null = null
  let previousFocusAddress: string | null = null
  let windowWasSelected = false
  let stableIds = new Map<string, string>()
  let frameTimer: number | null = null
  let targetsTimer: number | null = null

  async function syncCaptureTargets() {
    const clients = hypr.get_clients().filter((c) => c.get_mapped() && !c.get_hidden())
    const missingStableId = clients.some((c) => !stableIds.has(c.get_address()))

    if (missingStableId) {
      stableIds = await getStableIds()
    }

    const toCapture = clients
      .map((c) => {
        const addr = c.get_address()
        const sid = stableIds.get(addr)
        return sid ?? null
      })
      .filter((c): c is string => c !== null)

    await setCaptureTargets(toCapture)
  }

  async function onShow() {
    windowWasSelected = false

    const focused = hypr.get_focused_client()
    previousFocusAddress = focused?.get_address() ?? null
    setFocusedAddress(previousFocusAddress)
    setPreviewWorkspaceId(hypr.get_focused_workspace()?.get_id() ?? 1)

    await ensureOverviewdRunning()
    stableIds = await getStableIds()
    await syncCaptureTargets()
    overviewWindow?.grab_focus()

    frameTimer = setInterval(() => {
      setCaptureRevision((v) => v + 1)
    }, REFRESH_INTERVAL_MS) as unknown as number

    targetsTimer = setInterval(async () => {
      stableIds = await getStableIds()
      await syncCaptureTargets()
    }, 500) as unknown as number
  }

  function onHide() {
    if (frameTimer !== null) {
      clearInterval(frameTimer)
      frameTimer = null
    }
    if (targetsTimer !== null) {
      clearInterval(targetsTimer)
      targetsTimer = null
    }
    void clearCaptureTargets()

    if (!windowWasSelected && previousFocusAddress) {
      const addr = previousFocusAddress.startsWith("0x")
        ? previousFocusAddress
        : `0x${previousFocusAddress}`
      hypr.dispatch("focuswindow", `address:${addr}`)
    }
  }

  function selectWindow(address: string) {
    windowWasSelected = true
    const addr = address.startsWith("0x") ? address : `0x${address}`
    hypr.dispatch("focuswindow", `address:${addr}`)
    app.toggle_window("overview")
  }

  return (
    <window
      name="overview"
      class="Overview"
      visible={false}
      namespace="hypr-overview"
      application={app}
      layer={Astal.Layer.OVERLAY}
      exclusivity={Astal.Exclusivity.IGNORE}
      keymode={Astal.Keymode.ON_DEMAND}
      anchor={
        Astal.WindowAnchor.TOP |
        Astal.WindowAnchor.BOTTOM |
        Astal.WindowAnchor.LEFT |
        Astal.WindowAnchor.RIGHT
      }
      $={(self) => {
        overviewWindow = self
        self.set_focusable(true)

        self.connect("notify::visible", () => {
          if (self.visible) {
            onShow()
          } else {
            onHide()
          }
        })

        const keyCtrl = new Gtk.EventControllerKey()
        keyCtrl.connect("key-pressed", (_self: Gtk.EventControllerKey, keyval: number) => {
          if (keyval === Gdk.KEY_Escape) {
            app.toggle_window("overview")
            return true
          }
          return false
        })
        self.add_controller(keyCtrl)
      }}
    >
      <box
        orientation={Gtk.Orientation.VERTICAL}
        class="overview-container"
        valign={Gtk.Align.FILL}
        halign={Gtk.Align.FILL}
        vexpand
        hexpand
      >
        <WorkspaceStrip
          previewWorkspaceId={previewWorkspaceId}
          setPreviewWorkspaceId={setPreviewWorkspaceId}
        />
        <WindowGrid
          previewWorkspaceId={previewWorkspaceId}
          focusedAddress={focusedAddress}
          onSelectWindow={selectWindow}
          captureRevision={captureRevision}
          getStableId={(address: string) => stableIds.get(address) ?? null}
        />
      </box>
    </window>
  )
}
