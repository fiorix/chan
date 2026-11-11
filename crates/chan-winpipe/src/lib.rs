//! The Win32 boundary of chan's named pipes: the account this process runs
//! as, pipes whose security grants that account alone, and the account the
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
    create_owner_only, create_with_sddl, current_account_sid, security_sddl, server_account_sid,
};

/// The SDDL of a security descriptor that grants the account `sid` alone:
/// owned by it, with a protected DACL whose one entry gives it full access,
/// so no inherited or default entry applies.
pub fn owner_only_sddl(sid: &str) -> String {
    format!("O:{sid}D:P(A;;GA;;;{sid})")
}

#[cfg(windows)]
mod sys {
    use std::ffi::{c_void, OsStr};
    use std::io;
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use std::ptr::null_mut;
    use std::sync::OnceLock;

    use tokio::net::windows::named_pipe::{NamedPipeServer, ServerOptions};
    use windows_sys::Win32::Foundation::{LocalFree, HANDLE};
    use windows_sys::Win32::Security::Authorization::{
        ConvertSecurityDescriptorToStringSecurityDescriptorW, ConvertSidToStringSidW,
        ConvertStringSecurityDescriptorToSecurityDescriptorW, GetSecurityInfo, SDDL_REVISION_1,
        SE_KERNEL_OBJECT,
    };
    use windows_sys::Win32::Security::{
        GetTokenInformation, TokenUser, DACL_SECURITY_INFORMATION, OWNER_SECURITY_INFORMATION,
        PSECURITY_DESCRIPTOR, PSID, SECURITY_ATTRIBUTES, TOKEN_QUERY, TOKEN_USER,
    };
    use windows_sys::Win32::System::Pipes::GetNamedPipeServerProcessId;
    use windows_sys::Win32::System::Threading::{
        GetCurrentProcess, OpenProcess, OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    use super::owner_only_sddl;

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
        let descriptor = Local(descriptor);
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
        let parts = OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION;
        let mut descriptor: PSECURITY_DESCRIPTOR = null_mut();
        // SAFETY: the handle is open for the borrow of `handle`, the four part
        // pointers are null since no part is asked for apart, and `descriptor`
        // receives a buffer the system allocated, which `Local` frees below.
        let status = unsafe {
            GetSecurityInfo(
                handle.as_raw_handle(),
                SE_KERNEL_OBJECT,
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

    #[cfg(windows)]
    mod on_windows {
        use super::super::*;
        use tokio::net::windows::named_pipe::{ClientOptions, ServerOptions};

        const ERROR_ACCESS_DENIED: i32 = 5;
        const ERROR_PIPE_BUSY: i32 = 231;

        /// A pipe name of one test's own, so parallel tests never meet.
        fn test_pipe(tag: &str) -> String {
            format!(r"\\.\pipe\chan-winpipe-test-{tag}-{}", std::process::id())
        }

        /// The owner-only descriptor as the pipe holds it: the generic right
        /// may read back mapped to the pipe's full access.
        fn assert_owner_only(sddl: &str, sid: &str) {
            assert!(
                [
                    format!("O:{sid}D:P(A;;FA;;;{sid})"),
                    format!("O:{sid}D:P(A;;GA;;;{sid})"),
                ]
                .contains(&sddl.to_string()),
                "{sddl}"
            );
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
