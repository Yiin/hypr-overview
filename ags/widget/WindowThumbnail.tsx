import { Gtk, Gdk } from "ags/gtk4"
import Hyprland from "gi://AstalHyprland"
import GLib from "gi://GLib"
import GdkPixbuf from "gi://GdkPixbuf"
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

function hasAlphaChannel(format: string): boolean | null {
  switch (format) {
    case "B8G8R8A8":
      return true
    case "B8G8R8X8":
      return false
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

  const preview = new Gtk.DrawingArea({
    widthRequest: THUMB_WIDTH,
    heightRequest: THUMB_HEIGHT,
    hexpand: false,
    vexpand: false,
  })
  preview.set_css_classes(["thumbnail-image"])

  let currentSeq = -1
  let currentStableId: string | null = null
  let currentMappedFile: GLib.MappedFile | null = null
  let currentPixbuf: GdkPixbuf.Pixbuf | null = null

  function clearTexture() {
    currentStableId = null
    currentSeq = -1
    currentMappedFile = null
    currentPixbuf = null
    preview.queue_draw()
  }

  function loadTexture() {
    const stableId = getStableId(address)
    if (!stableId) {
      clearTexture()
      return
    }

    const meta = readFrameMetadata(stableId)
    const hasAlpha = meta ? hasAlphaChannel(meta.format) : null
    if (!meta || hasAlpha === null) {
      clearTexture()
      return
    }

    if (stableId === currentStableId && meta.seq === currentSeq) {
      return
    }

    try {
      const mappedFile = GLib.MappedFile.new(getFramePath(stableId, meta.slot), false)
      const pixbuf = GdkPixbuf.Pixbuf.new_from_bytes(
        mappedFile.get_bytes(),
        GdkPixbuf.Colorspace.RGB,
        hasAlpha,
        8,
        meta.width,
        meta.height,
        meta.stride,
      )
      currentStableId = stableId
      currentSeq = meta.seq
      currentMappedFile = mappedFile
      currentPixbuf = pixbuf
      preview.queue_draw()
    } catch {
      clearTexture()
    }
  }

  preview.set_draw_func((_area: Gtk.DrawingArea, cr: any, width: number, height: number) => {
    cr.setSourceRGBA(0.19, 0.19, 0.27, 1)
    cr.paint()

    if (!currentPixbuf) {
      return
    }

    const pixbufWidth = currentPixbuf.get_width()
    const pixbufHeight = currentPixbuf.get_height()
    const scale = Math.min(width / pixbufWidth, height / pixbufHeight)
    const targetWidth = pixbufWidth * scale
    const targetHeight = pixbufHeight * scale
    const offsetX = (width - targetWidth) / 2
    const offsetY = (height - targetHeight) / 2

    cr.save()
    cr.translate(offsetX, offsetY)
    cr.scale(scale, scale)
    Gdk.cairo_set_source_pixbuf(cr, currentPixbuf, 0, 0)
    cr.paint()
    cr.restore()
  })

  loadTexture()

  createEffect(() => {
    captureRevision()
    loadTexture()
  })

  return (
    <button
      class={`window-thumbnail ${isFocused ? "focused" : ""}`}
      onClicked={() => onSelect(address)}
      widthRequest={THUMB_WIDTH + 24}
      hexpand={false}
      vexpand={false}
      halign={Gtk.Align.START}
      valign={Gtk.Align.START}
    >
      <box orientation={Gtk.Orientation.VERTICAL} hexpand={false} vexpand={false} widthRequest={THUMB_WIDTH + 24}>
        {preview}

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
