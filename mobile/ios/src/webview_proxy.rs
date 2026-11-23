//! App-scoped WebKit proxy setup using the existing default cookie store.

use std::net::SocketAddr;

fn require_supported_version(major: isize) -> Result<(), String> {
    if major < 17 {
        return Err("WireGuard requires iOS 17 or later for WebView proxy support".into());
    }
    Ok(())
}

/// Install the loopback CONNECT proxy before constructing any WebView.
///
/// Older supported iOS versions cannot proxy WebKit traffic. They must refuse
/// WireGuard connections rather than opening a protected origin directly.
pub(crate) fn install(addr: SocketAddr) -> Result<(), String> {
    if !addr.ip().is_loopback() || addr.port() == 0 {
        return Err("the WebView proxy must use a loopback address and nonzero port".into());
    }
    #[cfg(target_os = "ios")]
    {
        ios::install(addr)
    }
    #[cfg(not(target_os = "ios"))]
    Err("the iOS WebView proxy is unavailable on this platform".into())
}

#[cfg(target_os = "ios")]
mod ios {
    use std::ffi::{c_char, c_int, c_void, CString};
    use std::net::SocketAddr;
    use std::sync::OnceLock;

    use objc2::rc::Retained;
    use objc2::runtime::{AnyClass, AnyObject};
    use objc2::{msg_send, sel};
    use objc2_foundation::{MainThreadMarker, NSArray, NSObjectProtocol, NSProcessInfo};

    type Endpoint = unsafe extern "C" fn(*const c_char, *const c_char) -> *mut AnyObject;
    type Proxy = unsafe extern "C" fn(*mut AnyObject, *mut c_void) -> *mut AnyObject;
    type Failover = unsafe extern "C" fn(*mut AnyObject, bool);

    struct Network {
        endpoint: Endpoint,
        proxy: Proxy,
        failover: Failover,
    }

    unsafe extern "C" {
        fn dlopen(path: *const c_char, mode: c_int) -> *mut c_void;
        fn dlsym(handle: *mut c_void, name: *const c_char) -> *mut c_void;
    }

    fn network() -> Result<&'static Network, String> {
        static NETWORK: OnceLock<Result<Network, String>> = OnceLock::new();
        NETWORK
            .get_or_init(|| {
                // Keep the handle for process lifetime: the function pointers
                // and proxy objects can outlive the setup call. Runtime lookup
                // avoids strong imports of symbols absent before iOS 17.
                let handle = unsafe {
                    dlopen(
                        c"/System/Library/Frameworks/Network.framework/Network".as_ptr(),
                        1,
                    )
                };
                if handle.is_null() {
                    return Err("loading Network.framework for the WebView proxy".into());
                }
                let endpoint = unsafe { dlsym(handle, c"nw_endpoint_create_host".as_ptr()) };
                let proxy =
                    unsafe { dlsym(handle, c"nw_proxy_config_create_http_connect".as_ptr()) };
                let failover =
                    unsafe { dlsym(handle, c"nw_proxy_config_set_failover_allowed".as_ptr()) };
                if endpoint.is_null() || proxy.is_null() || failover.is_null() {
                    return Err("the system lacks the WebView CONNECT proxy APIs".into());
                }
                // SAFETY: these public Network.framework symbols have the
                // exact signatures above; each lookup was checked for null.
                Ok(unsafe {
                    Network {
                        endpoint: std::mem::transmute::<*mut c_void, Endpoint>(endpoint),
                        proxy: std::mem::transmute::<*mut c_void, Proxy>(proxy),
                        failover: std::mem::transmute::<*mut c_void, Failover>(failover),
                    }
                })
            })
            .as_ref()
            .map_err(Clone::clone)
    }

    pub(super) fn install(addr: SocketAddr) -> Result<(), String> {
        let _main = MainThreadMarker::new()
            .ok_or_else(|| "the WebView proxy must be installed on the main thread".to_string())?;
        super::require_supported_version(
            NSProcessInfo::processInfo()
                .operatingSystemVersion()
                .majorVersion,
        )?;
        let class = AnyClass::get(c"WKWebsiteDataStore")
            .ok_or_else(|| "WebKit is unavailable for proxy setup".to_string())?;
        // SAFETY: the public class method returns the retained default store;
        // setup runs on the main thread before any WebView is constructed.
        let store: Retained<AnyObject> = unsafe { msg_send![class, defaultDataStore] };
        let available: bool =
            unsafe { msg_send![&store, respondsToSelector: sel!(setProxyConfigurations:)] };
        if !available {
            return Err("the WebView data store does not support CONNECT proxies".into());
        }
        let network = network()?;
        let host = CString::new(addr.ip().to_string()).expect("an IP address contains no NUL");
        let port = CString::new(addr.port().to_string()).expect("a port contains no NUL");
        // SAFETY: Network creates +1 OS objects compatible with Objective-C
        // retention; the config and data store retain the objects they use.
        let endpoint =
            unsafe { Retained::from_raw((network.endpoint)(host.as_ptr(), port.as_ptr())) }
                .ok_or_else(|| "creating the WebView proxy endpoint".to_string())?;
        let proxy = unsafe {
            Retained::from_raw((network.proxy)(
                Retained::as_ptr(&endpoint).cast_mut(),
                std::ptr::null_mut(),
            ))
        }
        .ok_or_else(|| "creating the WebView CONNECT proxy".to_string())?;
        unsafe { (network.failover)(Retained::as_ptr(&proxy).cast_mut(), false) };
        let proxies = NSArray::from_retained_slice(&[proxy]);
        // SAFETY: checked public setter, on the main thread, with an NSArray
        // of nw_proxy_config objects. Direct fallback remains disabled.
        unsafe {
            let _: () = msg_send![&store, setProxyConfigurations: &*proxies];
            let installed: Option<Retained<NSArray<AnyObject>>> =
                msg_send![&store, proxyConfigurations];
            let installed = installed.ok_or_else(|| {
                "the WebView data store did not retain the CONNECT proxy".to_string()
            })?;
            if installed.count() != 1 || !installed.isEqual(Some(&proxies)) {
                return Err("the WebView data store did not retain the CONNECT proxy".into());
            }
        }
        Ok(())
    }
}

#[cfg(target_os = "ios")]
pub(crate) use cookies::install_cookies;

#[cfg(target_os = "ios")]
mod cookies {
    use std::ptr::NonNull;
    use std::sync::{mpsc, Arc, Mutex};
    use std::time::Duration;

    use block2::RcBlock;
    use objc2::msg_send;
    use objc2::rc::Retained;
    use objc2::runtime::{AnyClass, AnyObject};
    use objc2_foundation::{
        ns_string, NSArray, NSHTTPCookie, NSHTTPCookieDomain, NSHTTPCookieName, NSHTTPCookiePath,
        NSHTTPCookiePropertyKey, NSHTTPCookieSecure, NSHTTPCookieValue, NSMutableDictionary,
        NSString,
    };
    use tauri::Manager;
    use tokio_util::sync::CancellationToken;

    struct Request {
        origin: String,
        domain: String,
        gate: String,
        csrf: String,
        access: Option<crate::wireguard::AccessGuard>,
        epoch: Option<u64>,
        secure: bool,
        cancelled: CancellationToken,
        result: mpsc::SyncSender<Result<(), String>>,
        writer: Mutex<Option<tokio::sync::OwnedMutexGuard<()>>>,
    }

    impl Request {
        fn check(&self) -> Result<(), String> {
            if self.cancelled.is_cancelled() {
                return Err("gateway cookie installation expired".into());
            }
            match (&self.access, self.epoch) {
                (Some(access), Some(epoch)) => access.check_epoch(&self.origin, epoch),
                _ => Ok(()),
            }
        }

        fn finish(&self, result: Result<(), String>) {
            // Only a completed WebKit callback releases the writer. Caller
            // timeout must not let a successor race a pending setCookie.
            self.writer.lock().unwrap().take();
            let _ = self.result.try_send(result);
        }
    }

    /// Wait for WebKit's completion and verified contents, not Tauri's dispatch
    /// acknowledgement (which does not propagate a cookie-store failure).
    pub(crate) fn install_cookies<R: tauri::Runtime>(
        app: &tauri::AppHandle<R>,
        origin: &str,
        gate: &str,
        csrf: &str,
        access: Option<crate::wireguard::AccessGuard>,
    ) -> Result<(), String> {
        if let Some(access) = &access {
            access.check(origin)?;
        }
        let epoch = access
            .as_ref()
            .map(crate::wireguard::AccessGuard::epoch)
            .transpose()?;
        let state = app
            .try_state::<Arc<crate::AppState>>()
            .ok_or("gateway cookie state is unavailable")?;
        let writer = match &access {
            Some(access) => access.cookie_writer(origin)?,
            None => state.cookie_writer(origin)?,
        };
        let origin_url = url::Url::parse(origin).map_err(|error| error.to_string())?;
        if access.is_some() && origin_url.scheme() != "https" {
            return Err("WireGuard sessions require HTTPS".into());
        }
        let domain = origin_url
            .host_str()
            .ok_or("gateway origin has no host")?
            .to_string();
        let (result, receive) = mpsc::sync_channel(1);
        let cancelled = CancellationToken::new();
        let request = Arc::new(Request {
            origin: origin.into(),
            domain,
            gate: gate.into(),
            csrf: csrf.into(),
            access,
            epoch,
            secure: origin_url.scheme() == "https",
            cancelled: cancelled.clone(),
            result,
            writer: Mutex::new(Some(writer)),
        });
        app.run_on_main_thread(move || {
            let result = (|| {
                request.check()?;
                let class = AnyClass::get(c"WKWebsiteDataStore")
                    .ok_or("WebKit cookie store is unavailable")?;
                // SAFETY: public default-store access, on the main thread.
                let store: Retained<AnyObject> = unsafe { msg_send![class, defaultDataStore] };
                let cookies: Retained<AnyObject> = unsafe { msg_send![&store, httpCookieStore] };
                let gate = make_cookie(
                    "__Host-devserver_gate",
                    &request.gate,
                    &request.domain,
                    request.secure,
                    true,
                )?;
                let csrf = make_cookie(
                    "__Host-devserver_csrf",
                    &request.csrf,
                    &request.domain,
                    request.secure,
                    false,
                )?;
                set_next(cookies, vec![gate, csrf], 0, Arc::clone(&request));
                Ok(())
            })();
            if let Err(error) = result {
                request.finish(Err(error));
            }
        })
        .map_err(|error| error.to_string())?;
        let result = receive
            .recv_timeout(Duration::from_secs(5))
            .map_err(|_| "gateway cookie store did not confirm the session".to_string());
        cancelled.cancel();
        result?
    }

    fn make_cookie(
        name: &str,
        value: &str,
        domain: &str,
        secure: bool,
        http_only: bool,
    ) -> Result<Retained<NSHTTPCookie>, String> {
        let name = NSString::from_str(name);
        let value = NSString::from_str(value);
        let domain = NSString::from_str(domain);
        // SAFETY: Foundation's public property constants and factory are
        // available throughout the supported iOS range. Domain has no dot prefix.
        let cookie = unsafe {
            let properties: Retained<NSMutableDictionary<NSHTTPCookiePropertyKey, AnyObject>> =
                NSMutableDictionary::from_slices(
                    &[
                        NSHTTPCookieName,
                        NSHTTPCookieValue,
                        NSHTTPCookieDomain,
                        NSHTTPCookiePath,
                        ns_string!("SameSite"),
                    ],
                    &[&name, &value, &domain, ns_string!("/"), ns_string!("lax")],
                );
            // Foundation enables these flags by presence, including "FALSE".
            if secure {
                properties.insert(NSHTTPCookieSecure, ns_string!("TRUE"));
            }
            if http_only {
                properties.insert(ns_string!("HttpOnly"), ns_string!("TRUE"));
            }
            NSHTTPCookie::cookieWithProperties(&properties)
        };
        cookie.ok_or_else(|| "constructing the gateway cookie failed".into())
    }

    fn set_next(
        store: Retained<AnyObject>,
        cookies: Vec<Retained<NSHTTPCookie>>,
        index: usize,
        request: Arc<Request>,
    ) {
        if let Err(error) = request.check() {
            request.finish(Err(error));
            return;
        }
        if index == cookies.len() {
            let callback = RcBlock::new(move |actual: NonNull<NSArray<NSHTTPCookie>>| {
                let result = request.check().and_then(|()| {
                    // SAFETY: WebKit's getAllCookies completion supplies this
                    // array for the callback's duration, on the main thread.
                    let actual = unsafe { actual.as_ref() };
                    for (name, value, http_only) in [
                        ("__Host-devserver_gate", request.gate.as_str(), true),
                        ("__Host-devserver_csrf", request.csrf.as_str(), false),
                    ] {
                        let kept = actual.iter().any(|cookie| {
                            cookie.name().to_string() == name
                                && cookie.value().to_string() == value
                                && cookie.domain().to_string() == request.domain
                                && cookie.path().to_string() == "/"
                                && cookie.isSecure() == request.secure
                                && cookie.isHTTPOnly() == http_only
                        });
                        if !kept {
                            return Err(
                                "cookie store did not retain the exact gateway session".into()
                            );
                        }
                    }
                    request.check()
                });
                request.finish(result);
            });
            // SAFETY: public WKHTTPCookieStore API copies the completion block.
            unsafe {
                let _: () = msg_send![&store, getAllCookies: &*callback];
            }
            return;
        }
        let next_store = store.clone();
        let cookie = cookies[index].clone();
        let callback = RcBlock::new(move || {
            set_next(
                next_store.clone(),
                cookies.clone(),
                index + 1,
                Arc::clone(&request),
            );
        });
        // SAFETY: the cookie and copied block remain retained by WebKit until
        // completion; the next write revalidates the native generation.
        unsafe {
            let _: () = msg_send![&store, setCookie: &*cookie, completionHandler: &*callback];
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions_before_ios17_are_refused() {
        for version in [15, 16] {
            assert!(require_supported_version(version)
                .unwrap_err()
                .contains("iOS 17"));
        }
        assert!(require_supported_version(17).is_ok());
        assert!(require_supported_version(27).is_ok());
    }

    #[test]
    fn refuses_non_loopback_and_zero_ports() {
        for addr in ["192.0.2.1:8080", "127.0.0.1:0", "[::1]:0"] {
            assert!(install(addr.parse().unwrap())
                .unwrap_err()
                .contains("loopback"));
        }
    }

    #[cfg(not(target_os = "ios"))]
    #[test]
    fn unsupported_platform_refuses_a_valid_proxy() {
        assert!(install("127.0.0.1:8080".parse().unwrap())
            .unwrap_err()
            .contains("unavailable"));
    }
}
