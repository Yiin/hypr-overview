import { Gtk, Gdk } from "ags/gtk4"
import Hyprland from "gi://AstalHyprland"
import GLib from "gi://GLib"
import { createBinding, createEffect, Accessor } from "ags"
import { getFramePath, readFrameMetadata } from "../lib/overviewd"

const THUMB_WIDTH = 360
const THUMB_HEIGHT = 220

interface Props {
  client: Hyprland.Client
  isFocused: boolean
  onSelect: (address: string) => void
  onClose: (address: string) => void
  captureRevision: Accessor<number>
  getStableId: (address: string) => string | null
}

function toMemoryFormat(format: string): Gdk.MemoryFormat | null {
  switch (format) {
    case "B8G8R8A8":
      return Gdk.MemoryFormat.B8G8R8A8
    case "B8G8R8X8":
      return Gdk.MemoryFormat.B8G8R8X8
    default:
      return null
  }
}

export default function WindowThumbnail({
  client,
  isFocused,
  onSelect,
  onClose,
  captureRevision,
  getStableId,
}: Props) {
  const address = client.get_address()
  const appClass = client.get_class()
  const title = createBinding(client, "title")

  const display = Gdk.Display.get_default()!
  const iconTheme = Gtk.IconTheme.get_for_display(display)
  const iconName = iconTheme.has_icon(appClass)
    ? appClass
    : iconTheme.has_icon(appClass.toLowerCase())
      ? appClass.toLowerCase()
      : "application-x-executable"

  const picture = new Gtk.Picture({
    widthRequest: THUMB_WIDTH,
    heightRequest: THUMB_HEIGHT,
    canShrink: true,
    hexpand: false,
    vexpand: false,
  })
  picture.set_css_classes(["thumbnail-image"])
  picture.set_content_fit(Gtk.ContentFit.CONTAIN)

  let currentSeq = -1
  let currentStableId: string | null = null
  let currentMappedFile: GLib.MappedFile | null = null

  function clearTexture() {
    currentStableId = null
    currentSeq = -1
    currentMappedFile = null
    picture.set_paintable(null)
  }

  function loadTexture() {
    const stableId = getStableId(address)
    if (!stableId) {
      clearTexture()
      return
    }

    const meta = readFrameMetadata(stableId)
    const memoryFormat = meta ? toMemoryFormat(meta.format) : null
    if (!meta || !memoryFormat) {
      clearTexture()
      return
    }

    if (stableId === currentStableId && meta.seq === currentSeq) {
      return
    }

    try {
      const mappedFile = GLib.MappedFile.new(getFramePath(stableId, meta.slot), false)
      const texture = Gdk.MemoryTexture.new(
        meta.width,
        meta.height,
        memoryFormat,
        mappedFile.get_bytes(),
        meta.stride,
      )
      currentStableId = stableId
      currentSeq = meta.seq
      currentMappedFile = mappedFile
      picture.set_paintable(texture)
    } catch {
      clearTexture()
    }
  }

  loadTexture()

  createEffect(() => {
    captureRevision()
    loadTexture()
  })

  return (
    <button
      class={`window-thumbnail ${isFocused ? "focused" : ""}`}
      onClicked={() => onSelect(address)}
      hexpand={false}
      vexpand={false}
    >
      <box orientation={Gtk.Orientation.VERTICAL} hexpand={false} vexpand={false} widthRequest={THUMB_WIDTH + 24}>
        {picture}

        <box class="thumbnail-info" spacing={8} vexpand={false}>
          <image iconName={iconName} pixelSize={16} />
          <label
            label={title.as((t: string) => t.length > 40 ? t.slice(0, 37) + "..." : t)}
            xalign={0}
            maxWidthChars={35}
            ellipsize={3}
            class="thumbnail-title"
          />
          <box hexpand />
          <button
            class="close-btn"
            onClicked={() => onClose(address)}
          >
            <label label="\u00d7" />
          </button>
        </box>
      </box>
    </button>
  )
}
