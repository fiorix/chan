//! The Win32 boundary of chan's named pipes and claim directories: the
//! account this process runs as, owner-only objects, and the account the
//! server of a pipe runs as.
//!
//! Every named pipe on a machine shares one namespace, and a pipe created
//! with the default security descriptor grants LocalSystem and the
//! Administrators group besides its creator. A pipe meant for one account is
//! then reachable from an elevated process of another, and any local user can
//! create a pipe of its name first. A pipe created here grants its account
//! alone, and a client reads the account of the server it reached before it
//! writes anything. The calls behind both are made here and nowhere else, so
//! the crates that serve and dial chan's pipes keep `unsafe` out.

#![deny(unsafe_op_in_unsafe_fn)]

#[cfg(windows)]
pub use sys::{
    create_owner_only, create_owner_only_dir, create_with_sddl, current_account_sid,
    file_security_sddl, grants_account_alone, open_dir, open_owner_only_file, sddl_sid,
    security_sddl, server_account_sid,
};

/// The SDDL of a security descriptor that grants the account `sid` alone:
/// owned by it, with a protected DACL whose one entry gives it full access,
/// so no inherited or default entry applies.
pub fn owner_only_sddl(sid: &str) -> String {
    format!("O:{sid}D:P(A;;GA;;;{sid})")
}

/// The owner, and the rights and trustee of the one entry, of a descriptor in
/// the owner-only shape `O:<owner>D:P(A;;<rights>;;;<trustee>)`, as SDDL
/// spells them. A SID reads as its string form or, for a well-known SID, as
/// the two-letter alias SDDL writes for it (`LA` for the built-in
/// Administrator), so the two parts name accounts only once resolved.
#[derive(Debug, PartialEq, Eq)]
pub struct OwnerOnlyParts<'a> {
    pub owner: &'a str,
    pub rights: &'a str,
    pub trustee: &'a str,
}

/// Split `sddl` into its [`OwnerOnlyParts`]; `None` for any other shape: an
/// unprotected or auto-inherited DACL, a second entry, a deny, or an entry
/// with flags or an object type.
pub fn owner_only_parts(sddl: &str) -> Option<OwnerOnlyParts<'_>> {
    let (owner, entry) = sddl.strip_prefix("O:")?.split_once("D:P(")?;
    let entry = entry.strip_suffix(')')?;
    if owner.is_empty() || entry.contains(['(', ')']) {
        return None;
    }
    match entry.split(';').collect::<Vec<_>>().as_slice() {
        ["A", "", rights, "", "", trustee] if !rights.is_empty() && !trustee.is_empty() => {
            Some(OwnerOnlyParts {
                owner,
                rights,
                trustee,
            })
        }
        _ => None,
    }
}

#[cfg(windows)]
mod sys {
    use std::ffi::{c_void, OsStr};
    use std::fs::{File, OpenOptions};
    use std::io;
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::fs::OpenOptionsExt;
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use std::path::Path;
    use std::ptr::null_mut;
    use std::sync::OnceLock;

    use tokio::net::windows::named_pipe::{NamedPipeServer, ServerOptions};
    use windows_sys::Win32::Foundation::{
        LocalFree, GENERIC_READ, GENERIC_WRITE, HANDLE, INVALID_HANDLE_VALUE,
    };
    use windows_sys::Win32::Security::Authorization::{
        ConvertSecurityDescriptorToStringSecurityDescriptorW, ConvertSidToStringSidW,
        ConvertStringSecurityDescriptorToSecurityDescriptorW, ConvertStringSidToSidW,
        GetSecurityInfo, SDDL_REVISION_1, SE_FILE_OBJECT, SE_KERNEL_OBJECT, SE_OBJECT_TYPE,
    };
    use windows_sys::Win32::Security::{
        GetTokenInformation, TokenUser, DACL_SECURITY_INFORMATION, OWNER_SECURITY_INFORMATION,
        PSECURITY_DESCRIPTOR, PSID, SECURITY_ATTRIBUTES, TOKEN_QUERY, TOKEN_USER,
    };
    use windows_sys::Win32::Storage::FileSystem::{
        CreateDirectoryW, CreateFileW, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
        FILE_LIST_DIRECTORY, FILE_READ_ATTRIBUTES, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_ALWAYS,
        READ_CONTROL,
    };
    use windows_sys::Win32::System::Pipes::GetNamedPipeServerProcessId;
    use windows_sys::Win32::System::Threading::{
        GetCurrentProcess, OpenProcess, OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    use super::{owner_only_parts, owner_only_sddl};

    /// The SID of the account this process runs as, as text (`S-1-5-21-...`),
    /// read from the process token the first time and kept, since a process
    /// does not change account.
    pub fn current_account_sid() -> io::Result<&'static str> {
        static SID: OnceLock<String> = OnceLock::new();
        if let Some(sid) = SID.get() {
            return Ok(sid);
        }
        // SAFETY: GetCurrentProcess returns a pseudo handle that is valid for
        // the process's life and is never closed.
        let sid = process_account_sid(unsafe { GetCurrentProcess() })?;
        Ok(SID.get_or_init(|| sid))
    }

    /// Create an instance of the pipe `name` under `options` whose security
    /// grants this process's account alone ([`owner_only_sddl`]).
    pub fn create_owner_only(
        options: &ServerOptions,
        name: impl AsRef<OsStr>,
    ) -> io::Result<NamedPipeServer> {
        create_with_sddl(options, name, &owner_only_sddl(current_account_sid()?))
    }

    /// Create an instance of the pipe `name` under `options` with the security
    /// descriptor written as `sddl`.
    pub fn create_with_sddl(
        options: &ServerOptions,
        name: impl AsRef<OsStr>,
        sddl: &str,
    ) -> io::Result<NamedPipeServer> {
        let descriptor = descriptor_from_sddl(sddl)?;
        let mut attributes = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: descriptor.0,
            bInheritHandle: 0,
        };
        // SAFETY: `attributes` is a SECURITY_ATTRIBUTES whose descriptor lives
        // until `descriptor` drops, after the call.
        unsafe {
            options.create_with_security_attributes_raw(
                name,
                (&mut attributes as *mut SECURITY_ATTRIBUTES).cast(),
            )
        }
    }

    /// Create `path` with this account as its owner and sole grantee. The
    /// parent must exist. An existing directory is not changed: the caller
    /// must open it and validate its descriptor even after a successful create.
    pub fn create_owner_only_dir(path: &Path) -> io::Result<()> {
        create_dir_with_sddl(path, &owner_only_sddl(current_account_sid()?))
    }

    pub(super) fn create_dir_with_sddl(path: &Path, sddl: &str) -> io::Result<()> {
        let path = wide_path(path)?;
        let descriptor = descriptor_from_sddl(sddl)?;
        let attributes = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: descriptor.0,
            bInheritHandle: 0,
        };
        // SAFETY: `path` is NUL-terminated and both it and the descriptor
        // outlive the call. The descriptor is applied at creation.
        if unsafe { CreateDirectoryW(path.as_ptr(), &attributes) } == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    /// Open a directory's final component without following a reparse point,
    /// with the rights needed to read its attributes, owner and DACL. The
    /// caller checks the returned handle is a directory and not a reparse
    /// point before trusting its descriptor. Keeping the handle prevents the
    /// directory from being renamed or deleted while it is in use.
    pub fn open_dir(path: &Path) -> io::Result<File> {
        // Attribute-only handles do not participate in share-access checks.
        OpenOptions::new()
            .access_mode(READ_CONTROL | FILE_READ_ATTRIBUTES | FILE_LIST_DIRECTORY)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
            .open(path)
    }

    /// Open or create a file for reading, writing and locking, with an
    /// owner-only descriptor on creation and without truncating existing
    /// contents. An existing file keeps its descriptor: the caller validates
    /// it and rejects reparse points and non-files before use. The final
    /// component is not followed, and deletion is not shared.
    pub fn open_owner_only_file(path: &Path) -> io::Result<File> {
        open_file_with_sddl(path, &owner_only_sddl(current_account_sid()?))
    }

    pub(super) fn open_file_with_sddl(path: &Path, sddl: &str) -> io::Result<File> {
        let path = wide_path(path)?;
        let descriptor = descriptor_from_sddl(sddl)?;
        let attributes = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: descriptor.0,
            bInheritHandle: 0,
        };
        // SAFETY: `path` is NUL-terminated; the path, attributes and
        // descriptor live through the call. No template handle is supplied.
        let handle = unsafe {
            CreateFileW(
                path.as_ptr(),
                GENERIC_READ | GENERIC_WRITE,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                &attributes,
                OPEN_ALWAYS,
                FILE_FLAG_OPEN_REPARSE_POINT,
                null_mut(),
            )
        };
        if handle == INVALID_HANDLE_VALUE {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: CreateFileW returned a valid handle that nothing else owns.
        Ok(unsafe { File::from_raw_handle(handle) })
    }

    fn wide_path(path: &Path) -> io::Result<Vec<u16>> {
        let mut path: Vec<u16> = path.as_os_str().encode_wide().collect();
        if path.contains(&0) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "path contains NUL",
            ));
        }
        path.push(0);
        Ok(path)
    }

    fn descriptor_from_sddl(sddl: &str) -> io::Result<Local> {
        let text: Vec<u16> = sddl.encode_utf16().chain(Some(0)).collect();
        let mut descriptor: PSECURITY_DESCRIPTOR = null_mut();
        // SAFETY: `text` is NUL-terminated and outlives the call, and
        // `descriptor` receives a buffer the system allocated, which `Local`
        // frees below.
        let converted = unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                text.as_ptr(),
                SDDL_REVISION_1,
                &mut descriptor,
                null_mut(),
            )
        };
        if converted == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(Local(descriptor))
    }

    /// The SID of the account the server of `pipe`, a client's end, runs as:
    /// the account of the process serving it, read from that process's token.
    /// A process or token this account may not open is an error.
    pub fn server_account_sid(pipe: &impl AsRawHandle) -> io::Result<String> {
        let mut pid = 0u32;
        // SAFETY: the handle is open for the borrow of `pipe`.
        if unsafe { GetNamedPipeServerProcessId(pipe.as_raw_handle(), &mut pid) } == 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: a plain call, whose error is a null handle.
        let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
        if process.is_null() {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: OpenProcess returned a handle nothing else owns.
        let process = unsafe { OwnedHandle::from_raw_handle(process) };
        process_account_sid(process.as_raw_handle())
    }

    /// The owner and the DACL of the object behind `handle`, as SDDL: what a
    /// pipe this process serves, or reached as a client, grants.
    pub fn security_sddl(handle: &impl AsRawHandle) -> io::Result<String> {
        object_security_sddl(handle, SE_KERNEL_OBJECT)
    }

    /// The owner and the DACL of a file or directory behind `handle`, as
    /// SDDL. The handle must grant READ_CONTROL; [`open_dir`] asks for it.
    pub fn file_security_sddl(handle: &impl AsRawHandle) -> io::Result<String> {
        object_security_sddl(handle, SE_FILE_OBJECT)
    }

    fn object_security_sddl(
        handle: &impl AsRawHandle,
        object_type: SE_OBJECT_TYPE,
    ) -> io::Result<String> {
        let parts = OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION;
        let mut descriptor: PSECURITY_DESCRIPTOR = null_mut();
        // SAFETY: the handle is open for the borrow of `handle`, the four part
        // pointers are null since no part is asked for apart, and `descriptor`
        // receives a buffer the system allocated, which `Local` frees below.
        let status = unsafe {
            GetSecurityInfo(
                handle.as_raw_handle(),
                object_type,
                parts,
                null_mut(),
                null_mut(),
                null_mut(),
                null_mut(),
                &mut descriptor,
            )
        };
        if status != 0 {
            return Err(io::Error::from_raw_os_error(status as i32));
        }
        let descriptor = Local(descriptor);
        let mut text = null_mut();
        // SAFETY: `descriptor` is the descriptor read above, and `text`
        // receives a string the system allocated, which `Local` frees below.
        let converted = unsafe {
            ConvertSecurityDescriptorToStringSecurityDescriptorW(
                descriptor.0,
                SDDL_REVISION_1,
                parts,
                &mut text,
                null_mut(),
            )
        };
        if converted == 0 {
            return Err(io::Error::last_os_error());
        }
        let text = Local(text.cast());
        // SAFETY: the conversion wrote a NUL-terminated string.
        Ok(unsafe { wide_string(text.0.cast()) })
    }

    /// The string form (`S-1-...`) of the SID an SDDL token names: a SID
    /// string, or the two-letter alias SDDL writes for a well-known SID, which
    /// resolves to the SID it stands for on this machine.
    pub fn sddl_sid(token: &str) -> io::Result<String> {
        let text: Vec<u16> = token.encode_utf16().chain(Some(0)).collect();
        let mut sid: PSID = null_mut();
        // SAFETY: `text` is NUL-terminated and outlives the call, and `sid`
        // receives a SID the system allocated, which `Local` frees below.
        if unsafe { ConvertStringSidToSidW(text.as_ptr(), &mut sid) } == 0 {
            return Err(io::Error::last_os_error());
        }
        let sid = Local(sid);
        sid_string(sid.0)
    }

    /// Whether `sddl`, a descriptor [`security_sddl`] read back, grants the
    /// account `sid` alone: the account owns it, and the protected DACL's one
    /// entry allows it full access, the generic right or the pipe's full
    /// access it maps to. The owner and the trustee are compared as SIDs,
    /// since SDDL writes a well-known account by its alias: a pipe the
    /// built-in Administrator owns reads `O:LAD:P(A;;FA;;;LA)`.
    pub fn grants_account_alone(sddl: &str, sid: &str) -> bool {
        let Some(parts) = owner_only_parts(sddl) else {
            return false;
        };
        let is_account = |token: &str| sddl_sid(token).is_ok_and(|resolved| resolved == sid);
        matches!(parts.rights, "FA" | "GA") && is_account(parts.owner) && is_account(parts.trustee)
    }

    /// The SID of the account the process behind `process`, a handle with at
    /// least PROCESS_QUERY_LIMITED_INFORMATION, runs as.
    fn process_account_sid(process: HANDLE) -> io::Result<String> {
        let mut token: HANDLE = null_mut();
        // SAFETY: `process` is open for the call, and `token` receives a
        // handle owned below.
        if unsafe { OpenProcessToken(process, TOKEN_QUERY, &mut token) } == 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: OpenProcessToken returned a handle nothing else owns.
        let token = unsafe { OwnedHandle::from_raw_handle(token) };
        let mut len = 0u32;
        // SAFETY: a null buffer of length zero asks for the size alone.
        unsafe { GetTokenInformation(token.as_raw_handle(), TokenUser, null_mut(), 0, &mut len) };
        if len == 0 {
            return Err(io::Error::last_os_error());
        }
        // u64 cells align the buffer for TOKEN_USER and the SID after it.
        let mut buffer = vec![0u64; (len as usize).div_ceil(8)];
        // SAFETY: `buffer` holds at least `len` writable bytes.
        let read = unsafe {
            GetTokenInformation(
                token.as_raw_handle(),
                TokenUser,
                buffer.as_mut_ptr().cast(),
                len,
                &mut len,
            )
        };
        if read == 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: GetTokenInformation wrote a TOKEN_USER at the start of
        // `buffer`, and its SID points into `buffer`, which lives through the
        // conversion.
        let sid: PSID = unsafe { (*buffer.as_ptr().cast::<TOKEN_USER>()).User.Sid };
        sid_string(sid)
    }

    fn sid_string(sid: PSID) -> io::Result<String> {
        let mut text = null_mut();
        // SAFETY: `sid` is a valid SID for the call, and `text` receives a
        // string the system allocated, which `Local` frees below.
        if unsafe { ConvertSidToStringSidW(sid, &mut text) } == 0 {
            return Err(io::Error::last_os_error());
        }
        let text = Local(text.cast());
        // SAFETY: the conversion wrote a NUL-terminated string.
        Ok(unsafe { wide_string(text.0.cast()) })
    }

    /// The NUL-terminated UTF-16 string at `text`.
    ///
    /// # Safety
    ///
    /// `text` points at a NUL-terminated UTF-16 string that is valid for the
    /// call.
    unsafe fn wide_string(text: *const u16) -> String {
        let mut len = 0;
        // SAFETY: every unit up to the NUL is inside the string.
        while unsafe { *text.add(len) } != 0 {
            len += 1;
        }
        // SAFETY: the `len` units before the NUL are the string.
        String::from_utf16_lossy(unsafe { std::slice::from_raw_parts(text, len) })
    }

    /// A buffer the system allocated with LocalAlloc, freed when dropped.
    struct Local(*mut c_void);

    impl Drop for Local {
        fn drop(&mut self) {
            // SAFETY: the buffer came from the system's LocalAlloc and is
            // freed once, here.
            unsafe { LocalFree(self.0) };
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_owner_only_descriptor_names_the_account_as_owner_and_sole_entry() {
        assert_eq!(
            owner_only_sddl("S-1-5-21-1-2-3-1001"),
            "O:S-1-5-21-1-2-3-1001D:P(A;;GA;;;S-1-5-21-1-2-3-1001)"
        );
    }

    #[test]
    fn an_owner_only_descriptor_splits_into_its_owner_and_one_entry() {
        assert_eq!(
            owner_only_parts("O:S-1-5-21-1-2-3-1001D:P(A;;FA;;;S-1-5-21-1-2-3-1001)"),
            Some(OwnerOnlyParts {
                owner: "S-1-5-21-1-2-3-1001",
                rights: "FA",
                trustee: "S-1-5-21-1-2-3-1001",
            })
        );
        // The built-in Administrator, as the system writes it back.
        assert_eq!(
            owner_only_parts("O:LAD:P(A;;FA;;;LA)"),
            Some(OwnerOnlyParts {
                owner: "LA",
                rights: "FA",
                trustee: "LA",
            })
        );
    }

    #[test]
    fn any_other_descriptor_shape_is_not_owner_only() {
        for sddl in [
            "O:LAD:(A;;FA;;;LA)",
            "O:LAD:PAI(A;;FA;;;LA)",
            "O:LAD:P(A;;FA;;;LA)(A;;FA;;;SY)",
            "O:LAD:P(A;;FA;;;LA)(XYZ)",
            "O:LAD:P(D;;FA;;;LA)",
            "O:LAD:P(A;OICI;FA;;;LA)",
            "O:LAD:P(A;;FA;;;)",
            "D:P(A;;FA;;;LA)",
            "O:D:P(A;;FA;;;LA)",
            "O:LAD:P(A;;FA;;;LA",
        ] {
            assert_eq!(owner_only_parts(sddl), None, "{sddl}");
        }
    }

    #[cfg(windows)]
    mod on_windows {
        use super::super::*;
        use std::os::windows::fs::MetadataExt;
        use tokio::net::windows::named_pipe::{ClientOptions, ServerOptions};

        const ERROR_ACCESS_DENIED: i32 = 5;
        const ERROR_PIPE_BUSY: i32 = 231;

        /// A pipe name of one test's own, so parallel tests never meet.
        fn test_pipe(tag: &str) -> String {
            format!(r"\\.\pipe\chan-winpipe-test-{tag}-{}", std::process::id())
        }

        /// The owner-only descriptor as the pipe holds it, read back in the
        /// form the system writes for this account.
        fn assert_owner_only(sddl: &str, sid: &str) {
            assert!(grants_account_alone(sddl, sid), "{sddl} for {sid}");
        }

        struct TestDir(std::path::PathBuf);

        impl TestDir {
            fn new(tag: &str) -> Self {
                let stamp = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos();
                let path = std::env::temp_dir()
                    .join(format!("chan-winpipe-{tag}-{}-{stamp}", std::process::id()));
                std::fs::create_dir(&path).unwrap();
                Self(path)
            }
        }

        impl Drop for TestDir {
            fn drop(&mut self) {
                std::fs::remove_dir_all(&self.0).expect("remove test directory");
            }
        }

        #[test]
        fn an_owner_only_directory_grants_this_account_alone() {
            let root = TestDir::new("owner-only-dir");
            let path = root.0.join("run");
            create_owner_only_dir(&path).unwrap();
            let directory = open_dir(&path).unwrap();
            let metadata = directory.metadata().unwrap();
            assert!(metadata.is_dir());
            assert_eq!(metadata.file_attributes() & 0x400, 0, "not a reparse point");
            assert_owner_only(
                &file_security_sddl(&directory).unwrap(),
                current_account_sid().unwrap(),
            );
        }

        #[test]
        fn an_existing_directory_keeps_its_descriptor_for_the_caller_to_check() {
            let root = TestDir::new("existing-dir");
            let path = root.0.join("run");
            let sid = current_account_sid().unwrap();
            // Read the fixture from the directory, rather than judging the
            // requested descriptor that Windows may have mapped.
            super::super::sys::create_dir_with_sddl(
                &path,
                &format!("O:{sid}D:P(A;;GA;;;{sid})(A;;GR;;;WD)"),
            )
            .unwrap();
            let directory = open_dir(&path).unwrap();
            let before = file_security_sddl(&directory).unwrap();
            assert!(!grants_account_alone(&before, sid), "{before}");
            assert_eq!(
                create_owner_only_dir(&path).unwrap_err().kind(),
                std::io::ErrorKind::AlreadyExists
            );
            assert_eq!(file_security_sddl(&directory).unwrap(), before);
        }

        #[test]
        fn an_open_directory_cannot_be_replaced() {
            let root = TestDir::new("stable-dir");
            let path = root.0.join("run");
            let moved = root.0.join("moved");
            create_owner_only_dir(&path).unwrap();
            let directory = open_dir(&path).unwrap();
            assert!(std::fs::rename(&path, &moved).is_err());
            assert!(std::fs::remove_dir(&path).is_err());
            assert!(directory.metadata().unwrap().is_dir());
            drop(directory);
            std::fs::rename(&path, &moved).expect("rename after guard drops");
        }

        #[test]
        fn a_directory_handle_opens_the_junction_instead_of_its_target() {
            let root = TestDir::new("reparse-dir");
            let target = root.0.join("target");
            let junction = root.0.join("junction");
            create_owner_only_dir(&target).unwrap();
            let created = std::process::Command::new("cmd")
                .args(["/C", "mklink", "/J"])
                .arg(&junction)
                .arg(&target)
                .output()
                .unwrap();
            assert!(created.status.success(), "{created:?}");
            let directory = open_dir(&junction).unwrap();
            assert_ne!(
                directory.metadata().unwrap().file_attributes() & 0x400,
                0,
                "the caller must see the junction, not the target"
            );
            drop(directory);
            std::fs::remove_dir(&junction).unwrap();
            assert!(target.is_dir());
        }

        #[test]
        fn a_directory_path_with_nul_is_rejected_without_truncation() {
            let root = TestDir::new("nul-dir");
            let prefix = root.0.join("run");
            let mut name = prefix.as_os_str().to_owned();
            name.push("\0suffix");
            let malformed = std::path::Path::new(&name);
            assert_eq!(
                create_owner_only_dir(malformed).unwrap_err().kind(),
                std::io::ErrorKind::InvalidInput
            );
            assert!(!prefix.exists());
            create_owner_only_dir(&prefix).unwrap();
            assert_eq!(
                open_dir(malformed).unwrap_err().kind(),
                std::io::ErrorKind::InvalidInput
            );
        }

        #[test]
        fn an_owner_only_file_keeps_its_descriptor_and_contents_when_reopened() {
            use std::io::{Read, Write};

            let root = TestDir::new("owner-only-file");
            let path = root.0.join("desktop.lock");
            let mut first = open_owner_only_file(&path).unwrap();
            first.write_all(b"retained").unwrap();
            let descriptor = file_security_sddl(&first).unwrap();
            assert_owner_only(&descriptor, current_account_sid().unwrap());
            let mut second = open_owner_only_file(&path).unwrap();
            assert!(second.metadata().unwrap().is_file());
            assert_eq!(file_security_sddl(&second).unwrap(), descriptor);
            let mut contents = String::new();
            second.read_to_string(&mut contents).unwrap();
            assert_eq!(contents, "retained");
            first.try_lock().unwrap();
            assert!(matches!(
                second.try_lock(),
                Err(std::fs::TryLockError::WouldBlock)
            ));
            assert!(std::fs::remove_file(&path).is_err());
            drop(first);
            second.try_lock().expect("lock after first handle drops");
            drop(second);
            std::fs::remove_file(&path).unwrap();
        }

        #[test]
        fn an_existing_file_keeps_its_descriptor_for_the_caller_to_check() {
            let root = TestDir::new("existing-file");
            let path = root.0.join("desktop.lock");
            let sid = current_account_sid().unwrap();
            let file = super::super::sys::open_file_with_sddl(
                &path,
                &format!("O:{sid}D:P(A;;GA;;;{sid})(A;;GR;;;WD)"),
            )
            .unwrap();
            let before = file_security_sddl(&file).unwrap();
            assert!(!grants_account_alone(&before, sid), "{before}");
            let reopened = open_owner_only_file(&path).unwrap();
            assert_eq!(file_security_sddl(&reopened).unwrap(), before);
        }

        #[test]
        fn a_file_path_with_nul_is_rejected_without_truncation() {
            let root = TestDir::new("nul-file");
            let prefix = root.0.join("desktop.lock");
            let mut name = prefix.as_os_str().to_owned();
            name.push("\0suffix");
            assert_eq!(
                open_owner_only_file(std::path::Path::new(&name))
                    .unwrap_err()
                    .kind(),
                std::io::ErrorKind::InvalidInput
            );
            assert!(!prefix.exists());
        }

        /// SDDL writes a well-known account by its alias, so the built-in
        /// Administrator's own pipe reads back `O:LAD:P(A;;FA;;;LA)`; that
        /// grants it alone, compared as SIDs, and grants no other account.
        #[test]
        fn a_well_known_account_reads_by_its_alias_and_still_grants_it_alone() {
            assert_eq!(sddl_sid("SY").unwrap(), "S-1-5-18");
            let sid = current_account_sid().unwrap();
            assert_eq!(sddl_sid(sid).unwrap(), sid);
            let la = sddl_sid("LA").unwrap();
            assert!(la.starts_with("S-1-5-21-") && la.ends_with("-500"), "{la}");
            assert!(grants_account_alone("O:LAD:P(A;;FA;;;LA)", &la));
            assert!(grants_account_alone(
                &format!("O:{la}D:P(A;;GA;;;{la})"),
                &la
            ));
            for other in [
                "O:LAD:P(A;;FA;;;SY)".to_string(),
                "O:SYD:P(A;;FA;;;LA)".to_string(),
                "O:LAD:P(A;;FR;;;LA)".to_string(),
                "O:LAD:P(A;;FA;;;LA)(A;;FA;;;SY)".to_string(),
                format!("O:{la}D:(A;;FA;;;{la})"),
            ] {
                assert!(!grants_account_alone(&other, &la), "{other}");
            }
            assert!(!grants_account_alone("O:LAD:P(A;;FA;;;LA)", "S-1-5-18"));
            assert!(!grants_account_alone("O:XXD:P(A;;FA;;;XX)", &la));
        }

        #[test]
        fn this_account_reads_as_a_sid() {
            let sid = current_account_sid().unwrap();
            assert!(sid.starts_with("S-1-"), "{sid}");
            assert_eq!(current_account_sid().unwrap(), sid);
        }

        /// A pipe created owner-only grants this account alone, read back
        /// through the server's end and through a client's.
        #[tokio::test]
        async fn an_owner_only_pipe_grants_this_account_alone() {
            let sid = current_account_sid().unwrap();
            let name = test_pipe("owner-only");
            let server =
                create_owner_only(ServerOptions::new().first_pipe_instance(true), &name).unwrap();
            assert_owner_only(&security_sddl(&server).unwrap(), sid);
            let client = ClientOptions::new().open(&name).unwrap();
            assert_owner_only(&security_sddl(&client).unwrap(), sid);
        }

        #[tokio::test]
        async fn the_server_of_a_pipe_this_process_serves_is_this_account() {
            let name = test_pipe("server-account");
            let _server =
                create_owner_only(ServerOptions::new().first_pipe_instance(true), &name).unwrap();
            let client = ClientOptions::new().open(&name).unwrap();
            assert_eq!(
                server_account_sid(&client).unwrap(),
                current_account_sid().unwrap()
            );
        }

        /// A pipe's descriptor is its first instance's: an instance created
        /// later with the default descriptor, and reached by a client of its
        /// own, still grants this account alone.
        #[tokio::test]
        async fn a_later_instance_keeps_the_first_instances_descriptor() {
            let name = test_pipe("later-instance");
            let _first =
                create_owner_only(ServerOptions::new().first_pipe_instance(true), &name).unwrap();
            let _on_first = ClientOptions::new().open(&name).unwrap();
            let _later = ServerOptions::new().create(&name).unwrap();
            let on_later = ClientOptions::new().open(&name).unwrap();
            assert_owner_only(
                &security_sddl(&on_later).unwrap(),
                current_account_sid().unwrap(),
            );
        }

        /// The answers callers read: a second first instance of this
        /// account's pipe of one instance meets pipe busy, and a pipe whose
        /// security grants this account nothing refuses it an instance, a
        /// first instance and a client with access denied.
        #[tokio::test]
        async fn a_pipe_that_grants_this_account_nothing_refuses_it() {
            let ours = test_pipe("ours");
            let one = || {
                let mut options = ServerOptions::new();
                options.first_pipe_instance(true).max_instances(1);
                options
            };
            let _first = create_owner_only(&one(), &ours).unwrap();
            let second = create_owner_only(&one(), &ours);
            assert_eq!(
                second.err().and_then(|e| e.raw_os_error()),
                Some(ERROR_PIPE_BUSY)
            );

            let theirs = test_pipe("theirs");
            let _other = create_with_sddl(
                ServerOptions::new().first_pipe_instance(true),
                &theirs,
                "D:P(A;;GA;;;SY)",
            )
            .unwrap();
            let instance = create_owner_only(&ServerOptions::new(), &theirs);
            assert_eq!(
                instance.err().and_then(|e| e.raw_os_error()),
                Some(ERROR_ACCESS_DENIED)
            );
            let first = create_owner_only(&one(), &theirs);
            assert_eq!(
                first.err().and_then(|e| e.raw_os_error()),
                Some(ERROR_ACCESS_DENIED)
            );
            let client = ClientOptions::new().open(&theirs);
            assert_eq!(
                client.err().and_then(|e| e.raw_os_error()),
                Some(ERROR_ACCESS_DENIED)
            );
        }
    }
}
