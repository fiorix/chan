use std::collections::VecDeque;
#[cfg(target_os = "linux")]
use std::fs::File;
#[cfg(target_os = "linux")]
use std::io;
#[cfg(target_os = "linux")]
use std::os::fd::OwnedFd;
#[cfg(target_os = "linux")]
use std::os::unix::fs::FileExt;
#[cfg(target_os = "linux")]
use std::sync::Arc;

#[derive(Debug)]
pub(super) struct RingBuffer {
    cap: usize,
    chunks: VecDeque<(u64, Vec<u8>)>,
    start_seq: u64,
    end_seq: u64,
    len: usize,
    /// Where every push is also written while the session is parked in the
    /// systemd fd store, so the next process rebuilds this ring from it.
    #[cfg(target_os = "linux")]
    mirror: Option<RingFile>,
}

impl RingBuffer {
    pub(super) fn new(cap: usize) -> Self {
        Self::new_at(cap, 0)
    }

    pub(super) fn new_at(cap: usize, seq: u64) -> Self {
        Self {
            cap: cap.max(1),
            chunks: VecDeque::new(),
            start_seq: seq,
            end_seq: seq,
            len: 0,
            #[cfg(target_os = "linux")]
            mirror: None,
        }
    }

    #[cfg(any(target_os = "linux", test))]
    pub(super) fn new_with_replay(cap: usize, end_seq: u64, replay: &[u8]) -> Self {
        if replay.is_empty() {
            return Self::new_at(cap, end_seq);
        }
        let replay = if replay.len() as u64 > end_seq {
            &replay[replay.len().saturating_sub(end_seq as usize)..]
        } else {
            replay
        };
        let start_seq = end_seq.saturating_sub(replay.len() as u64);
        let mut ring = Self::new_at(cap, start_seq);
        ring.push(replay);
        ring
    }

    pub(super) fn push(&mut self, bytes: &[u8]) {
        let start = self.end_seq;
        self.end_seq = self.end_seq.saturating_add(bytes.len() as u64);
        #[cfg(target_os = "linux")]
        self.write_mirror(start, bytes);
        if bytes.len() >= self.cap {
            self.chunks.clear();
            let tail = bytes[bytes.len() - self.cap..].to_vec();
            self.start_seq = self.end_seq.saturating_sub(tail.len() as u64);
            self.len = tail.len();
            self.chunks.push_back((self.start_seq, tail));
            return;
        }
        self.len = self.len.saturating_add(bytes.len());
        self.chunks.push_back((start, bytes.to_vec()));
        while self.len > self.cap {
            if let Some((_start, chunk)) = self.chunks.pop_front() {
                self.len = self.len.saturating_sub(chunk.len());
                self.start_seq = self.start_seq.saturating_add(chunk.len() as u64);
            } else {
                self.start_seq = self.end_seq;
                self.len = 0;
                break;
            }
        }
    }

    pub(super) fn end_seq(&self) -> u64 {
        self.end_seq
    }

    #[cfg(target_os = "linux")]
    pub(super) fn capacity(&self) -> usize {
        self.cap
    }

    pub(super) fn snapshot_since(&self, since: Option<u64>) -> (Vec<Vec<u8>>, u64) {
        let requested = since.unwrap_or(self.start_seq);
        let replay_start = requested.max(self.start_seq);
        let missed = self.start_seq.saturating_sub(requested);
        let mut replay = Vec::new();
        for (chunk_start, chunk) in &self.chunks {
            let chunk_end = chunk_start.saturating_add(chunk.len() as u64);
            if chunk_end <= replay_start {
                continue;
            }
            let offset = replay_start.saturating_sub(*chunk_start) as usize;
            replay.push(chunk[offset..].to_vec());
        }
        (replay, missed)
    }

    /// Mirror this ring into `file` from now on, first replacing what the
    /// file holds with the bytes the ring holds now.
    #[cfg(target_os = "linux")]
    pub(super) fn mirror_into(&mut self, mut file: RingFile) -> io::Result<()> {
        file.reset(self.start_seq)?;
        for (chunk_start, chunk) in &self.chunks {
            file.append(*chunk_start, chunk)?;
        }
        self.mirror = Some(file);
        Ok(())
    }

    /// Keep writing into a file that already holds exactly this ring's
    /// bytes: the ring was just rebuilt from it.
    #[cfg(target_os = "linux")]
    pub(super) fn continue_mirror(&mut self, file: RingFile) {
        debug_assert_eq!(file.end, self.end_seq);
        self.mirror = Some(file);
    }

    #[cfg(target_os = "linux")]
    pub(super) fn is_mirrored(&self) -> bool {
        self.mirror.is_some()
    }

    /// Stop mirroring and close this process's handle on the file.
    #[cfg(target_os = "linux")]
    pub(super) fn stop_mirror(&mut self) {
        self.mirror = None;
    }

    #[cfg(target_os = "linux")]
    fn write_mirror(&mut self, start: u64, bytes: &[u8]) {
        let Some(mirror) = self.mirror.as_mut() else {
            return;
        };
        if let Err(error) = mirror.append(start, bytes) {
            // The header is published last, so a failed write leaves the
            // file ending at the last byte before it. The next process takes
            // the file while that end is at or past the manifest's `seq`,
            // restoring the session at that end; once a manifest rewrite
            // records a larger `seq`, the manifest's tail wins instead.
            tracing::warn!(error = %error, "writing the terminal ring file failed; it stops mirroring");
            self.mirror = None;
        }
    }
}

/// The on-disk shape of a [`RingFile`]: a fixed header, then `capacity`
/// data bytes. All header fields are little-endian.
#[cfg(target_os = "linux")]
mod layout {
    pub(super) const MAGIC: [u8; 8] = *b"CHANRING";
    pub(super) const FORMAT_VERSION: u32 = 1;
    pub(super) const HEADER_LEN: u64 = 64;
    pub(super) const VERSION_AT: usize = 8;
    pub(super) const HEADER_LEN_AT: usize = 12;
    pub(super) const CAPACITY_AT: usize = 16;
    /// Start seq, end seq and write offset, published by one write.
    pub(super) const WINDOW_AT: usize = 24;
    pub(super) const WINDOW_LEN: usize = 24;
}

/// A parked session's ring as it crosses a restart: a memfd the systemd fd
/// store keeps beside the PTY master. The byte numbered `seq` lives at data
/// offset `seq % capacity`, and the header names the window of sequence
/// numbers the data holds. The size is fixed at creation and sealed.
///
/// The header is the commit point, and a process can die between any two
/// writes (`kill -9`, a watchdog kill). A write that would overwrite bytes
/// the header still counts first moves the header's start past them, then
/// writes the data, then moves the end, so the header never describes a
/// byte that is not intact.
#[cfg(target_os = "linux")]
#[derive(Debug)]
pub(super) struct RingFile {
    file: Arc<File>,
    capacity: u64,
    start: u64,
    end: u64,
    /// How many more writes succeed before one fails as a killed process's
    /// would, so a test can stop an append after any of its writes.
    #[cfg(test)]
    writes_left: std::cell::Cell<Option<usize>>,
}

#[cfg(target_os = "linux")]
impl RingFile {
    /// A new memfd for a ring of `capacity` bytes, holding nothing.
    pub(super) fn create(capacity: usize) -> io::Result<Self> {
        use rustix::fs::{fcntl_add_seals, memfd_create, MemfdFlags, SealFlags};
        const NAME: &str = "chan-terminal-ring";
        // NOEXEC_SEAL keeps the file from ever being executed, and kernels
        // from 6.3 log a warning for a memfd created without an exec choice;
        // older kernels reject the flag.
        let fd = match memfd_create(
            NAME,
            MemfdFlags::CLOEXEC | MemfdFlags::ALLOW_SEALING | MemfdFlags::NOEXEC_SEAL,
        ) {
            Err(rustix::io::Errno::INVAL) => {
                memfd_create(NAME, MemfdFlags::CLOEXEC | MemfdFlags::ALLOW_SEALING)
            }
            other => other,
        }?;
        let file = File::from(fd);
        let capacity = capacity.max(1) as u64;
        file.set_len(layout::HEADER_LEN + capacity)?;
        // The next process sizes the ring from the file's length.
        fcntl_add_seals(&file, SealFlags::SHRINK | SealFlags::GROW | SealFlags::SEAL)?;
        let mut ring = Self {
            file: Arc::new(file),
            capacity,
            start: 0,
            end: 0,
            #[cfg(test)]
            writes_left: std::cell::Cell::new(None),
        };
        ring.reset(0)?;
        Ok(ring)
    }

    /// Take over the ring file a previous process parked. Its capacity is
    /// what its length leaves behind the header; [`read`](Self::read) says
    /// whether its contents can be trusted.
    pub(super) fn adopt(fd: OwnedFd) -> io::Result<Self> {
        let file = File::from(fd);
        let len = file.metadata()?.len();
        let Some(capacity) = len.checked_sub(layout::HEADER_LEN).filter(|cap| *cap > 0) else {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("a {len}-byte file has no ring behind its header"),
            ));
        };
        Ok(Self {
            file: Arc::new(file),
            capacity,
            start: 0,
            end: 0,
            #[cfg(test)]
            writes_left: std::cell::Cell::new(None),
        })
    }

    /// The file this ring lives in, for parking it.
    pub(super) fn shared_file(&self) -> Arc<File> {
        self.file.clone()
    }

    /// The bytes the header describes and the sequence number they end at.
    /// On success writes continue from that end; an `Err` names what cannot
    /// be trusted, and the file must be [`reset`](Self::reset) before use.
    pub(super) fn read(&mut self) -> Result<(u64, Vec<u8>), String> {
        let mut header = [0u8; layout::HEADER_LEN as usize];
        self.file
            .read_exact_at(&mut header, 0)
            .map_err(|error| format!("reading the header: {error}"))?;
        let u32_at = |at: usize| u32::from_le_bytes(header[at..at + 4].try_into().unwrap());
        let u64_at = |at: usize| u64::from_le_bytes(header[at..at + 8].try_into().unwrap());
        if header[..8] != layout::MAGIC {
            return Err("the header has no ring magic".into());
        }
        let version = u32_at(layout::VERSION_AT);
        if version != layout::FORMAT_VERSION {
            return Err(format!("format version {version} is not supported"));
        }
        let header_len = u32_at(layout::HEADER_LEN_AT);
        if u64::from(header_len) != layout::HEADER_LEN {
            return Err(format!("header length {header_len} is not supported"));
        }
        let capacity = u64_at(layout::CAPACITY_AT);
        if capacity != self.capacity {
            return Err(format!(
                "the header's capacity {capacity} disagrees with the file's {}",
                self.capacity
            ));
        }
        let start = u64_at(layout::WINDOW_AT);
        let end = u64_at(layout::WINDOW_AT + 8);
        let write_offset = u64_at(layout::WINDOW_AT + 16);
        if start > end || end - start > capacity {
            return Err(format!(
                "the window {start}..{end} does not fit a {capacity}-byte ring"
            ));
        }
        if write_offset != end % capacity {
            return Err(format!(
                "the write offset {write_offset} disagrees with the end {end}"
            ));
        }
        let mut bytes = vec![0u8; (end - start) as usize];
        let at = (start % capacity) as usize;
        let first = bytes.len().min(capacity as usize - at);
        let (head, tail) = bytes.split_at_mut(first);
        self.file
            .read_exact_at(head, layout::HEADER_LEN + at as u64)
            .and_then(|()| self.file.read_exact_at(tail, layout::HEADER_LEN))
            .map_err(|error| format!("reading the ring bytes: {error}"))?;
        self.start = start;
        self.end = end;
        Ok((end, bytes))
    }

    /// Rewrite the whole header for an empty ring ending at `seq`.
    pub(super) fn reset(&mut self, seq: u64) -> io::Result<()> {
        let mut header = [0u8; layout::HEADER_LEN as usize];
        header[..8].copy_from_slice(&layout::MAGIC);
        header[layout::VERSION_AT..layout::VERSION_AT + 4]
            .copy_from_slice(&layout::FORMAT_VERSION.to_le_bytes());
        header[layout::HEADER_LEN_AT..layout::HEADER_LEN_AT + 4]
            .copy_from_slice(&(layout::HEADER_LEN as u32).to_le_bytes());
        header[layout::CAPACITY_AT..layout::CAPACITY_AT + 8]
            .copy_from_slice(&self.capacity.to_le_bytes());
        header[layout::WINDOW_AT..layout::WINDOW_AT + layout::WINDOW_LEN]
            .copy_from_slice(&self.window(seq, seq));
        self.write_at(&header, 0)?;
        self.start = seq;
        self.end = seq;
        Ok(())
    }

    /// Append `bytes`, numbered from `at`. The ring keeps only the last
    /// `capacity` bytes, so older ones leave the window.
    pub(super) fn append(&mut self, at: u64, bytes: &[u8]) -> io::Result<()> {
        if bytes.is_empty() {
            return Ok(());
        }
        if at != self.end {
            // A gap cannot be described by one window: start over at `at`.
            self.reset(at)?;
        }
        let end = at.saturating_add(bytes.len() as u64);
        let kept = &bytes[bytes.len().saturating_sub(self.capacity as usize)..];
        let start = self.start.max(end.saturating_sub(self.capacity));
        self.retire(start)?;
        self.write_data(end - kept.len() as u64, kept)?;
        self.publish(start, end)
    }

    /// Move the header's start up to `start` ahead of a write that lands on
    /// the bytes before it.
    fn retire(&mut self, start: u64) -> io::Result<()> {
        if start > self.start {
            self.publish(start.min(self.end), self.end)?;
        }
        Ok(())
    }

    /// Write `bytes`, numbered from `at`, into their slots, wrapping at the
    /// end of the data area. The header does not count them yet.
    fn write_data(&self, at: u64, bytes: &[u8]) -> io::Result<()> {
        let offset = at % self.capacity;
        let first = bytes.len().min((self.capacity - offset) as usize);
        self.write_at(&bytes[..first], layout::HEADER_LEN + offset)?;
        if first < bytes.len() {
            self.write_at(&bytes[first..], layout::HEADER_LEN)?;
        }
        Ok(())
    }

    fn write_at(&self, bytes: &[u8], at: u64) -> io::Result<()> {
        #[cfg(test)]
        if let Some(left) = self.writes_left.get() {
            if left == 0 {
                return Err(io::Error::other("the process died before this write"));
            }
            self.writes_left.set(Some(left - 1));
        }
        self.file.write_all_at(bytes, at)
    }

    fn publish(&mut self, start: u64, end: u64) -> io::Result<()> {
        self.write_at(&self.window(start, end), layout::WINDOW_AT as u64)?;
        self.start = start;
        self.end = end;
        Ok(())
    }

    fn window(&self, start: u64, end: u64) -> [u8; layout::WINDOW_LEN] {
        let mut window = [0u8; layout::WINDOW_LEN];
        window[..8].copy_from_slice(&start.to_le_bytes());
        window[8..16].copy_from_slice(&end.to_le_bytes());
        window[16..].copy_from_slice(&(end % self.capacity).to_le_bytes());
        window
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    use std::os::fd::AsFd;

    /// The stream a ring mirrors: the byte numbered `seq` is `stream[seq]`,
    /// and no byte equals the one a small ring's capacity before it.
    fn stream(len: usize) -> Vec<u8> {
        (0..len).map(|i| (i % 251) as u8).collect()
    }

    /// What a next process reads back from `file`'s memfd.
    fn reread(file: &RingFile) -> Result<(u64, Vec<u8>), String> {
        let fd = file.shared_file().as_fd().try_clone_to_owned().unwrap();
        RingFile::adopt(fd)
            .map_err(|error| error.to_string())?
            .read()
    }

    #[test]
    fn appends_wrap_and_read_back_the_last_capacity_bytes() {
        let bytes = stream(100);
        let mut file = RingFile::create(16).unwrap();
        for chunk in bytes.chunks(7) {
            let at = file.end;
            file.append(at, chunk).unwrap();
        }
        assert_eq!(reread(&file).unwrap(), (100, bytes[84..].to_vec()));
    }

    #[test]
    fn a_write_longer_than_the_ring_keeps_its_tail() {
        let bytes = stream(40);
        let mut file = RingFile::create(16).unwrap();
        file.append(0, &bytes[..3]).unwrap();
        file.append(3, &bytes[3..]).unwrap();
        assert_eq!(reread(&file).unwrap(), (40, bytes[24..].to_vec()));
    }

    #[test]
    fn a_gap_restarts_the_window_at_the_new_sequence() {
        let bytes = stream(64);
        let mut file = RingFile::create(16).unwrap();
        file.append(0, &bytes[..10]).unwrap();
        file.append(40, &bytes[40..44]).unwrap();
        assert_eq!(reread(&file).unwrap(), (44, bytes[40..44].to_vec()));
    }

    // A process can die between any two writes of an append. The test drives
    // `append` itself and stops it after each of its writes in turn: the next
    // process must read only the stream's own bytes, the end moving only once
    // the append completes. The ring's next slot is 6, so a 12-byte append
    // wraps (its data is two writes, and stopping between them is the
    // half-written wrap) and lands on the oldest slots; a 30-byte append is
    // longer than the ring and lands on all of them.
    #[test]
    fn an_append_killed_after_any_of_its_writes_leaves_only_intact_bytes() {
        let bytes = stream(22 + 30);
        for len in [12usize, 30] {
            let end = 22 + len as u64;
            let mut completed = false;
            for writes in 0.. {
                let mut file = RingFile::create(16).unwrap();
                file.append(0, &bytes[..22]).unwrap();
                file.writes_left.set(Some(writes));
                let appended = file.append(22, &bytes[22..end as usize]);
                file.writes_left.set(None);
                let (read_end, read) = reread(&file).unwrap();
                let read_start = read_end - read.len() as u64;
                assert_eq!(
                    read,
                    &bytes[read_start as usize..read_end as usize],
                    "a {len}-byte append stopped after {writes} writes"
                );
                if appended.is_ok() {
                    assert_eq!(read_end, end, "a completed append publishes its end");
                    assert_eq!(read.len(), 16);
                    completed = true;
                    break;
                }
                assert_eq!(read_end, 22, "the end is published last");
            }
            assert!(completed, "the {len}-byte append completes");
        }
    }

    #[test]
    fn read_refuses_a_header_it_cannot_trust() {
        let cases: [(usize, &[u8], &str); 5] = [
            (0, b"NOTARING", "magic"),
            (layout::VERSION_AT, &2u32.to_le_bytes(), "version"),
            (layout::CAPACITY_AT, &32u64.to_le_bytes(), "capacity"),
            (layout::WINDOW_AT, &0u64.to_le_bytes(), "window"),
            (layout::WINDOW_AT + 16, &3u64.to_le_bytes(), "write offset"),
        ];
        for (at, corrupt, what) in cases {
            let mut file = RingFile::create(16).unwrap();
            file.append(0, &stream(20)).unwrap();
            assert!(reread(&file).is_ok());
            file.shared_file().write_all_at(corrupt, at as u64).unwrap();
            let error = reread(&file).expect_err(what);
            assert!(error.contains(what), "{what}: {error}");
        }
    }

    #[test]
    fn adopt_refuses_a_file_with_no_ring_behind_its_header() {
        let file = tempfile::tempfile().unwrap();
        file.set_len(layout::HEADER_LEN).unwrap();
        assert!(RingFile::adopt(OwnedFd::from(file)).is_err());
    }

    #[test]
    fn a_mirrored_ring_and_its_file_hold_the_same_stream() {
        let bytes = stream(300);
        let mut ring = RingBuffer::new(64);
        ring.push(&bytes[..100]);
        ring.mirror_into(RingFile::create(64).unwrap()).unwrap();
        for chunk in bytes[100..].chunks(9) {
            ring.push(chunk);
        }
        let (end, read) = reread(ring.mirror.as_ref().unwrap()).unwrap();
        assert_eq!(end, ring.end_seq());
        assert_eq!(read, &bytes[300 - 64..]);
        let (held, _) = ring.snapshot_since(None);
        assert!(read.ends_with(&held.concat()));

        ring.stop_mirror();
        assert!(!ring.is_mirrored());
    }
}
