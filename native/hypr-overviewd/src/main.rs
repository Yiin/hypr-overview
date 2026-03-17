use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::Write;
use std::os::fd::{AsFd, AsRawFd};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use anyhow::{anyhow, Context, Result};
use libc::{poll, pollfd, POLLIN};
use memmap2::MmapMut;
use serde::Serialize;
use wayland_client::globals::{registry_queue_init, GlobalListContents};
use wayland_client::protocol::{wl_buffer, wl_registry, wl_shm, wl_shm_pool};
use wayland_client::{
    delegate_noop, event_created_child, Connection, Dispatch, EventQueue, Proxy, QueueHandle, WEnum,
};
use wayland_protocols::ext::foreign_toplevel_list::v1::client::{
    ext_foreign_toplevel_handle_v1, ext_foreign_toplevel_handle_v1::ExtForeignToplevelHandleV1,
    ext_foreign_toplevel_list_v1, ext_foreign_toplevel_list_v1::ExtForeignToplevelListV1,
};
use wayland_protocols::ext::image_capture_source::v1::client::{
    ext_foreign_toplevel_image_capture_source_manager_v1::ExtForeignToplevelImageCaptureSourceManagerV1,
    ext_image_capture_source_v1::ExtImageCaptureSourceV1,
};
use wayland_protocols::ext::image_copy_capture::v1::client::{
    ext_image_copy_capture_frame_v1, ext_image_copy_capture_frame_v1::ExtImageCopyCaptureFrameV1,
    ext_image_copy_capture_manager_v1,
    ext_image_copy_capture_manager_v1::ExtImageCopyCaptureManagerV1,
    ext_image_copy_capture_session_v1, ext_image_copy_capture_session_v1::ExtImageCopyCaptureSessionV1,
};

const RUNTIME_SUBDIR: &str = "hypr-overviewd";
const TARGETS_FILE: &str = "targets.json";
const META_DIR: &str = "meta";
const FRAMES_DIR: &str = "frames";
const POLL_TIMEOUT_MS: i32 = 33;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FrameFormat {
    B8G8R8A8,
    B8G8R8X8,
}

impl FrameFormat {
    fn as_str(self) -> &'static str {
        match self {
            Self::B8G8R8A8 => "B8G8R8A8",
            Self::B8G8R8X8 => "B8G8R8X8",
        }
    }
}

impl FrameFormat {
    fn from_wl_shm(format: wl_shm::Format) -> Option<Self> {
        match format {
            wl_shm::Format::Argb8888 => Some(Self::B8G8R8A8),
            wl_shm::Format::Xrgb8888 => Some(Self::B8G8R8X8),
            _ => None,
        }
    }
}

#[derive(Debug, Serialize)]
struct FrameMetadata {
    width: u32,
    height: u32,
    stride: u32,
    slot: usize,
    seq: u64,
    format: &'static str,
}

#[derive(Debug)]
struct FrameSlot {
    path: PathBuf,
    pool: wl_shm_pool::WlShmPool,
    buffer: wl_buffer::WlBuffer,
    _mmap: MmapMut,
}

#[derive(Debug)]
struct BufferState {
    width: u32,
    height: u32,
    stride: u32,
    frame_format: FrameFormat,
    slots: [FrameSlot; 2],
    next_slot: usize,
}

#[derive(Debug)]
struct CaptureState {
    identifier: String,
    active: bool,
    source: ExtImageCaptureSourceV1,
    session: ExtImageCopyCaptureSessionV1,
    shm_formats: Vec<wl_shm::Format>,
    advertised_width: Option<u32>,
    advertised_height: Option<u32>,
    buffers: Option<BufferState>,
    frame: Option<ExtImageCopyCaptureFrameV1>,
    frame_slot: Option<usize>,
    seq: u64,
    meta_path: PathBuf,
}

#[derive(Debug)]
struct ToplevelState {
    handle: ExtForeignToplevelHandleV1,
    identifier: Option<String>,
    capture: Option<CaptureState>,
}

struct App {
    shm: wl_shm::WlShm,
    _toplevel_list: ExtForeignToplevelListV1,
    source_manager: ExtForeignToplevelImageCaptureSourceManagerV1,
    copy_manager: ExtImageCopyCaptureManagerV1,
    targets_path: PathBuf,
    meta_dir: PathBuf,
    frames_dir: PathBuf,
    last_targets_mtime: Option<SystemTime>,
    targets: HashSet<String>,
    toplevels: HashMap<u32, ToplevelState>,
}

impl App {
    fn new(
        shm: wl_shm::WlShm,
        toplevel_list: ExtForeignToplevelListV1,
        source_manager: ExtForeignToplevelImageCaptureSourceManagerV1,
        copy_manager: ExtImageCopyCaptureManagerV1,
        runtime_dir: PathBuf,
    ) -> Result<Self> {
        let meta_dir = runtime_dir.join(META_DIR);
        let frames_dir = runtime_dir.join(FRAMES_DIR);
        fs::create_dir_all(&meta_dir)?;
        fs::create_dir_all(&frames_dir)?;
        clear_dir(&meta_dir)?;
        clear_dir(&frames_dir)?;

        Ok(Self {
            shm,
            _toplevel_list: toplevel_list,
            source_manager,
            copy_manager,
            targets_path: runtime_dir.join(TARGETS_FILE),
            meta_dir,
            frames_dir,
            last_targets_mtime: None,
            targets: HashSet::new(),
            toplevels: HashMap::new(),
        })
    }

    fn process_target_file(&mut self, qh: &QueueHandle<Self>) -> Result<()> {
        let metadata = match fs::metadata(&self.targets_path) {
            Ok(metadata) => Some(metadata),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => None,
            Err(err) => return Err(err).context("failed to stat targets file"),
        };

        let changed = match metadata.as_ref() {
            Some(metadata) => {
                let modified = metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH);
                self.last_targets_mtime != Some(modified)
            }
            None => self.last_targets_mtime.is_some() || !self.targets.is_empty(),
        };

        if !changed {
            return Ok(());
        }

        let new_targets = if metadata.is_some() {
            let raw = fs::read_to_string(&self.targets_path).context("failed to read targets file")?;
            let parsed = serde_json::from_str::<Vec<String>>(&raw).context("failed to parse targets file")?;
            parsed.into_iter().collect()
        } else {
            HashSet::new()
        };

        self.last_targets_mtime = metadata
            .and_then(|metadata| metadata.modified().ok());
        self.targets = new_targets;
        self.reconcile_targets(qh)?;
        Ok(())
    }

    fn reconcile_targets(&mut self, qh: &QueueHandle<Self>) -> Result<()> {
        let keys: Vec<u32> = self.toplevels.keys().copied().collect();
        for key in keys {
            let Some(entry) = self.toplevels.get(&key) else {
                continue;
            };

            let Some(identifier) = entry.identifier.clone() else {
                continue;
            };
            let handle = entry.handle.clone();
            let has_capture = entry.capture.is_some();
            let is_active = entry.capture.as_ref().is_some_and(|capture| capture.active);

            if self.targets.contains(&identifier) {
                if !has_capture {
                    let capture = self.start_capture(&handle, &identifier, key, qh)?;
                    if let Some(entry) = self.toplevels.get_mut(&key) {
                        entry.capture = Some(capture);
                    }
                } else if !is_active {
                    if let Some(entry) = self.toplevels.get_mut(&key) {
                        if let Some(capture) = entry.capture.as_mut() {
                            capture.active = true;
                        }
                    }
                    self.request_next_frame(key, qh)?;
                }
            } else if is_active {
                if let Some(entry) = self.toplevels.get_mut(&key) {
                    if let Some(capture) = entry.capture.as_mut() {
                        capture.active = false;
                    }
                }
            }
        }

        Ok(())
    }

    fn start_capture(
        &self,
        handle: &ExtForeignToplevelHandleV1,
        identifier: &str,
        key: u32,
        qh: &QueueHandle<Self>,
    ) -> Result<CaptureState> {
        let source = self.source_manager.create_source(handle, qh, ());
        let session = self.copy_manager.create_session(
            &source,
            ext_image_copy_capture_manager_v1::Options::empty(),
            qh,
            key,
        );

        Ok(CaptureState {
            identifier: identifier.to_string(),
            active: true,
            source,
            session,
            shm_formats: Vec::new(),
            advertised_width: None,
            advertised_height: None,
            buffers: None,
            frame: None,
            frame_slot: None,
            seq: 0,
            meta_path: self.meta_dir.join(format!("{identifier}.json")),
        })
    }

    fn destroy_capture(&mut self, key: u32) {
        let Some(entry) = self.toplevels.get_mut(&key) else {
            return;
        };
        let Some(capture) = entry.capture.take() else {
            return;
        };

        if let Some(frame) = capture.frame {
            frame.destroy();
        }
        capture.session.destroy();
        capture.source.destroy();
        let _ = fs::remove_file(capture.meta_path);
        if let Some(buffers) = capture.buffers {
            for slot in buffers.slots {
                slot.buffer.destroy();
                slot.pool.destroy();
                let _ = fs::remove_file(slot.path);
            }
        }
    }

    fn reconfigure_buffers(&mut self, key: u32, qh: &QueueHandle<Self>) -> Result<()> {
        let (session, width, height, format) = {
            let entry = self
                .toplevels
                .get(&key)
                .ok_or_else(|| anyhow!("missing toplevel entry for {key}"))?;
            let capture = entry
                .capture
                .as_ref()
                .ok_or_else(|| anyhow!("missing capture state for {key}"))?;

            let width = capture
                .advertised_width
                .ok_or_else(|| anyhow!("missing width"))?;
            let height = capture
                .advertised_height
                .ok_or_else(|| anyhow!("missing height"))?;

            let format = capture
                .shm_formats
                .iter()
                .copied()
                .find(|format| matches!(format, wl_shm::Format::Argb8888))
                .or_else(|| {
                    capture
                        .shm_formats
                        .iter()
                        .copied()
                        .find(|format| matches!(format, wl_shm::Format::Xrgb8888))
                })
                .ok_or_else(|| anyhow!("compositor did not advertise ARGB8888/XRGB8888"))?;

            (capture.session.clone(), width, height, format)
        };

        let frame_format = FrameFormat::from_wl_shm(format)
            .ok_or_else(|| anyhow!("unsupported wl_shm format"))?;
        let stride = width * 4;
        let identifier = {
            let entry = self
                .toplevels
                .get(&key)
                .ok_or_else(|| anyhow!("missing toplevel entry for {key}"))?;
            let capture = entry
                .capture
                .as_ref()
                .ok_or_else(|| anyhow!("missing capture state for {key}"))?;
            capture.identifier.clone()
        };

        let slot0 = self.create_slot(&session, &identifier, 0, width, height, stride, format, qh)?;
        let slot1 = self.create_slot(&session, &identifier, 1, width, height, stride, format, qh)?;

        let entry = self
            .toplevels
            .get_mut(&key)
            .ok_or_else(|| anyhow!("missing toplevel entry for {key}"))?;
        let capture = entry
            .capture
            .as_mut()
            .ok_or_else(|| anyhow!("missing capture state for {key}"))?;

        if let Some(old) = capture.buffers.take() {
            for slot in old.slots {
                slot.buffer.destroy();
                slot.pool.destroy();
                let _ = fs::remove_file(slot.path);
            }
        }

        capture.buffers = Some(BufferState {
            width,
            height,
            stride,
            frame_format,
            slots: [slot0, slot1],
            next_slot: 0,
        });

        Ok(())
    }

    fn create_slot(
        &self,
        _session: &ExtImageCopyCaptureSessionV1,
        identifier: &str,
        slot: usize,
        width: u32,
        height: u32,
        stride: u32,
        format: wl_shm::Format,
        qh: &QueueHandle<Self>,
    ) -> Result<FrameSlot> {
        let size = (stride * height) as usize;
        let path = self.frames_dir.join(format!("{identifier}.{slot}.raw"));
        let file = File::options()
            .create(true)
            .read(true)
            .write(true)
            .truncate(true)
            .open(&path)
            .with_context(|| format!("failed to open frame file {}", path.display()))?;
        file.set_len(size as u64)?;

        let mmap = unsafe { MmapMut::map_mut(&file) }
            .with_context(|| format!("failed to mmap {}", path.display()))?;
        let pool = self.shm.create_pool(file.as_fd(), size as i32, qh, ());
        let buffer = pool.create_buffer(
            0,
            width as i32,
            height as i32,
            stride as i32,
            format,
            qh,
            (),
        );

        Ok(FrameSlot {
            path,
            pool,
            buffer,
            _mmap: mmap,
        })
    }

    fn request_next_frame(&mut self, key: u32, qh: &QueueHandle<Self>) -> Result<()> {
        let (frame_in_flight, buffers_missing, has_size) = {
            let entry = self
                .toplevels
                .get(&key)
                .ok_or_else(|| anyhow!("missing toplevel entry"))?;
            let capture = match entry.capture.as_ref() {
                Some(capture) => capture,
                None => return Ok(()),
            };
            if !capture.active {
                return Ok(());
            }
            (
                capture.frame.is_some(),
                capture.buffers.is_none(),
                capture.advertised_width.is_some() && capture.advertised_height.is_some(),
            )
        };

        if frame_in_flight {
            return Ok(());
        }
        if buffers_missing && has_size {
            self.reconfigure_buffers(key, qh)?;
        }

        let entry = self
            .toplevels
            .get_mut(&key)
            .ok_or_else(|| anyhow!("missing toplevel entry"))?;
        let capture = match entry.capture.as_mut() {
            Some(capture) => capture,
            None => return Ok(()),
        };
        let buffers = match capture.buffers.as_mut() {
            Some(buffers) => buffers,
            None => return Ok(()),
        };

        let slot = buffers.next_slot;
        buffers.next_slot = (buffers.next_slot + 1) % 2;

        let frame = capture.session.create_frame(qh, key);
        frame.attach_buffer(&buffers.slots[slot].buffer);
        frame.damage_buffer(0, 0, buffers.width as i32, buffers.height as i32);
        frame.capture();
        capture.frame_slot = Some(slot);
        capture.frame = Some(frame);
        Ok(())
    }

    fn handle_frame_ready(&mut self, key: u32, qh: &QueueHandle<Self>) -> Result<()> {
        let entry = self
            .toplevels
            .get_mut(&key)
            .ok_or_else(|| anyhow!("missing toplevel entry"))?;
        let capture = entry
            .capture
            .as_mut()
            .ok_or_else(|| anyhow!("missing capture state"))?;
        let frame = capture
            .frame
            .take()
            .ok_or_else(|| anyhow!("ready event without frame"))?;
        frame.destroy();

        let slot = capture
            .frame_slot
            .take()
            .ok_or_else(|| anyhow!("ready event without slot"))?;
        let buffers = capture
            .buffers
            .as_ref()
            .ok_or_else(|| anyhow!("ready event without buffers"))?;
        capture.seq += 1;

        let meta = FrameMetadata {
            width: buffers.width,
            height: buffers.height,
            stride: buffers.stride,
            slot,
            seq: capture.seq,
            format: buffers.frame_format.as_str(),
        };
        let should_continue = capture.active;
        write_metadata(&capture.meta_path, &meta)?;
        if should_continue {
            self.request_next_frame(key, qh)?;
        }
        Ok(())
    }

    fn handle_frame_failed(&mut self, key: u32, qh: &QueueHandle<Self>) -> Result<()> {
        let entry = self
            .toplevels
            .get_mut(&key)
            .ok_or_else(|| anyhow!("missing toplevel entry"))?;
        let capture = entry
            .capture
            .as_mut()
            .ok_or_else(|| anyhow!("missing capture state"))?;

        if let Some(frame) = capture.frame.take() {
            frame.destroy();
        }
        capture.frame_slot = None;
        if capture.active {
            self.request_next_frame(key, qh)?;
        }
        Ok(())
    }
}

fn write_metadata(path: &Path, metadata: &FrameMetadata) -> Result<()> {
    let tmp_path = path.with_extension("json.tmp");
    let mut file = File::options()
        .create(true)
        .write(true)
        .truncate(true)
        .open(&tmp_path)?;
    serde_json::to_writer(&mut file, metadata)?;
    file.write_all(b"\n")?;
    file.sync_data()?;
    fs::rename(tmp_path, path)?;
    Ok(())
}

fn clear_dir(path: &Path) -> Result<()> {
    for entry in fs::read_dir(path)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        if file_type.is_file() {
            fs::remove_file(entry.path())?;
        }
    }
    Ok(())
}

fn runtime_dir() -> Result<PathBuf> {
    let base = std::env::var_os("XDG_RUNTIME_DIR")
        .ok_or_else(|| anyhow!("XDG_RUNTIME_DIR is not set"))?;
    let path = PathBuf::from(base).join(RUNTIME_SUBDIR);
    fs::create_dir_all(&path)?;
    Ok(path)
}

fn poll_wayland(queue: &EventQueue<App>) -> Result<bool> {
    let fd = queue.as_fd().as_raw_fd();
    let mut fds = [pollfd {
        fd,
        events: POLLIN,
        revents: 0,
    }];
    let result = unsafe { poll(fds.as_mut_ptr(), fds.len() as _, POLL_TIMEOUT_MS) };
    if result < 0 {
        return Err(std::io::Error::last_os_error()).context("poll failed");
    }
    Ok(result > 0 && (fds[0].revents & POLLIN) != 0)
}

fn is_would_block(error: &wayland_client::backend::WaylandError) -> bool {
    match error {
        wayland_client::backend::WaylandError::Io(io) => io.raw_os_error() == Some(libc::EAGAIN),
        _ => false,
    }
}

impl Dispatch<wl_registry::WlRegistry, GlobalListContents> for App {
    fn event(
        _state: &mut Self,
        _proxy: &wl_registry::WlRegistry,
        _event: wl_registry::Event,
        _data: &GlobalListContents,
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
    ) {
    }
}

impl Dispatch<ExtForeignToplevelListV1, ()> for App {
    fn event(
        state: &mut Self,
        _proxy: &ExtForeignToplevelListV1,
        event: ext_foreign_toplevel_list_v1::Event,
        _data: &(),
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
    ) {
        match event {
            ext_foreign_toplevel_list_v1::Event::Toplevel { toplevel } => {
                state.toplevels.insert(
                    toplevel.id().protocol_id(),
                    ToplevelState {
                        handle: toplevel,
                        identifier: None,
                        capture: None,
                    },
                );
            }
            ext_foreign_toplevel_list_v1::Event::Finished => {}
            _ => {}
        }
    }

    event_created_child!(
        App,
        ExtForeignToplevelListV1,
        [ext_foreign_toplevel_list_v1::EVT_TOPLEVEL_OPCODE => (ExtForeignToplevelHandleV1, ())]
    );
}

impl Dispatch<ExtForeignToplevelHandleV1, ()> for App {
    fn event(
        state: &mut Self,
        proxy: &ExtForeignToplevelHandleV1,
        event: ext_foreign_toplevel_handle_v1::Event,
        _data: &(),
        _conn: &Connection,
        qh: &QueueHandle<Self>,
    ) {
        let key = proxy.id().protocol_id();
        let Some(entry) = state.toplevels.get_mut(&key) else {
            return;
        };

        match event {
            ext_foreign_toplevel_handle_v1::Event::Identifier { identifier } => {
                entry.identifier = Some(identifier);
                let _ = state.reconcile_targets(qh);
            }
            ext_foreign_toplevel_handle_v1::Event::Closed => {
                state.destroy_capture(key);
                state.toplevels.remove(&key);
            }
            _ => {}
        }
    }
}

delegate_noop!(App: ignore ExtImageCaptureSourceV1);
delegate_noop!(App: ignore ExtForeignToplevelImageCaptureSourceManagerV1);
delegate_noop!(App: ignore ExtImageCopyCaptureManagerV1);
delegate_noop!(App: ignore wl_shm::WlShm);
delegate_noop!(App: ignore wl_shm_pool::WlShmPool);
delegate_noop!(App: ignore wl_buffer::WlBuffer);

impl Dispatch<ExtImageCopyCaptureSessionV1, u32> for App {
    fn event(
        state: &mut Self,
        _proxy: &ExtImageCopyCaptureSessionV1,
        event: ext_image_copy_capture_session_v1::Event,
        data: &u32,
        _conn: &Connection,
        qh: &QueueHandle<Self>,
    ) {
        let Some(entry) = state.toplevels.get_mut(data) else {
            return;
        };
        let Some(capture) = entry.capture.as_mut() else {
            return;
        };

        match event {
            ext_image_copy_capture_session_v1::Event::BufferSize { width, height } => {
                capture.advertised_width = Some(width);
                capture.advertised_height = Some(height);
            }
            ext_image_copy_capture_session_v1::Event::ShmFormat { format } => {
                if let WEnum::Value(format) = format {
                    if !capture.shm_formats.contains(&format) {
                        capture.shm_formats.push(format);
                    }
                }
            }
            ext_image_copy_capture_session_v1::Event::Done => {
                let _ = state.reconfigure_buffers(*data, qh);
                let _ = state.request_next_frame(*data, qh);
            }
            ext_image_copy_capture_session_v1::Event::Stopped => {
                state.destroy_capture(*data);
            }
            _ => {}
        }
    }
}

impl Dispatch<ExtImageCopyCaptureFrameV1, u32> for App {
    fn event(
        state: &mut Self,
        _proxy: &ExtImageCopyCaptureFrameV1,
        event: ext_image_copy_capture_frame_v1::Event,
        data: &u32,
        _conn: &Connection,
        qh: &QueueHandle<Self>,
    ) {
        match event {
            ext_image_copy_capture_frame_v1::Event::Ready => {
                let _ = state.handle_frame_ready(*data, qh);
            }
            ext_image_copy_capture_frame_v1::Event::Failed { .. } => {
                let _ = state.handle_frame_failed(*data, qh);
            }
            _ => {}
        }
    }
}

fn main() -> Result<()> {
    let runtime_dir = runtime_dir()?;
    let conn = Connection::connect_to_env().context("failed to connect to Wayland")?;
    let (globals, mut event_queue) =
        registry_queue_init::<App>(&conn).context("failed to initialize registry")?;
    let qh = event_queue.handle();

    let shm: wl_shm::WlShm = globals.bind(&qh, 1..=1, ()).context("missing wl_shm")?;
    let toplevel_list: ExtForeignToplevelListV1 = globals
        .bind(&qh, 1..=1, ())
        .context("missing ext_foreign_toplevel_list_v1")?;
    let source_manager: ExtForeignToplevelImageCaptureSourceManagerV1 = globals
        .bind(&qh, 1..=1, ())
        .context("missing ext_foreign_toplevel_image_capture_source_manager_v1")?;
    let copy_manager: ExtImageCopyCaptureManagerV1 = globals
        .bind(&qh, 1..=1, ())
        .context("missing ext_image_copy_capture_manager_v1")?;

    let mut state = App::new(shm, toplevel_list, source_manager, copy_manager, runtime_dir)?;
    event_queue
        .roundtrip(&mut state)
        .context("failed initial toplevel roundtrip")?;

    loop {
        state.process_target_file(&qh)?;

        event_queue
            .dispatch_pending(&mut state)
            .context("failed to dispatch pending Wayland events")?;
        event_queue.flush().context("failed to flush Wayland requests")?;

        let Some(guard) = event_queue.prepare_read() else {
            continue;
        };

        if poll_wayland(&event_queue)? {
            if let Err(err) = guard.read() {
                if !is_would_block(&err) {
                    return Err(err).context("failed to read Wayland events");
                }
            }
            event_queue
                .dispatch_pending(&mut state)
                .context("failed to dispatch Wayland events")?;
        } else {
            drop(guard);
        }
    }
}
