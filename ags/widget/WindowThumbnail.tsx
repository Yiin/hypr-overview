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
      const src = mappedFile.get_bytes().get_data()
      if (!src) { clearTexture(); return }

      // Frame data is B8G8R8(A/X)8 (BGR order) — swap R and B for GdkPixbuf RGB
      const dst = new Uint8Array(src.length)
      for (let y = 0; y < meta.height; y++) {
        const rowStart = y * meta.stride
        for (let x = 0; x < meta.width; x++) {
          const i = rowStart + x * 4
          dst[i] = src[i + 2]
          dst[i + 1] = src[i + 1]
          dst[i + 2] = src[i]
          dst[i + 3] = src[i + 3]
        }
      }

      const pixbuf = GdkPixbuf.Pixbuf.new_from_bytes(
        GLib.Bytes.new(dst),
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
      // Draw gradient on empty state
      const gradientStart = height * 0.70
      const gradientHeight = height - gradientStart
      const gradient = new (imports.cairo as any).LinearGradient(0, gradientStart, 0, height)
      gradient.addColorStopRGBA(0, 0.067, 0.067, 0.106, 0)
      gradient.addColorStopRGBA(1, 0.067, 0.067, 0.106, 0.9)
      cr.setSource(gradient)
      cr.rectangle(0, gradientStart, width, gradientHeight)
      cr.fill()
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

    // Draw bottom gradient overlay
    const gradientStart = height * 0.70
    const gradientHeight = height - gradientStart
    const gradient = new (imports.cairo as any).LinearGradient(0, gradientStart, 0, height)
    gradient.addColorStopRGBA(0, 0.067, 0.067, 0.106, 0)
    gradient.addColorStopRGBA(1, 0.067, 0.067, 0.106, 0.9)
    cr.setSource(gradient)
    cr.rectangle(0, gradientStart, width, gradientHeight)
    cr.fill()
  })

  loadTexture()

  createEffect(() => {
    captureRevision()
    loadTexture()
  })

  const selectGesture = Gtk.GestureClick.new()
  selectGesture.set_button(1)
  selectGesture.connect("released", () => {
    onSelect(address)
  })

  return (
    <box
      class={`window-thumbnail ${isFocused ? "focused" : ""}`}
      widthRequest={THUMB_WIDTH}
      hexpand={false}
      vexpand={false}
      halign={Gtk.Align.START}
      valign={Gtk.Align.START}
      $={(self) => {
        self.set_overflow(Gtk.Overflow.HIDDEN)
        const dragSource = Gtk.DragSource.new()
        dragSource.set_actions(Gdk.DragAction.MOVE)
        dragSource.connect("prepare", () => {
          return Gdk.ContentProvider.new_for_value(`window:${address}`)
        })
        self.add_controller(dragSource)
        self.add_controller(selectGesture)
      }}
    >
      <Gtk.Overlay>
        {preview}
        <box
          $type="overlay"
          class="thumbnail-info-overlay"
          halign={Gtk.Align.FILL}
          valign={Gtk.Align.END}
          spacing={8}
        >
          <image iconName={iconName} pixelSize={16} class="thumbnail-icon" />
          <label
            label={title.as((t: string) => t.length > 40 ? t.slice(0, 37) + "..." : t)}
            xalign={0}
            maxWidthChars={35}
            ellipsize={3}
            class="thumbnail-title"
          />
        </box>
        <button
          $type="overlay"
          class="close-btn"
          halign={Gtk.Align.END}
          valign={Gtk.Align.START}
          onClicked={() => onClose(address)}
          widthRequest={24}
          heightRequest={24}
        >
          <image iconName="window-close-symbolic" pixelSize={12} />
        </button>
      </Gtk.Overlay>
    </box>
  )
}
