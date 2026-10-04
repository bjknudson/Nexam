use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use anyhow::{anyhow, Context, Result};
use reqwest::blocking::Client;
use serde::Serialize;
use tauri::path::BaseDirectory;
use tauri::{AppHandle, Emitter, Manager, Runtime};

// Generous on purpose. The first launch after an install is slow for reasons
// that have nothing to do with the backend: Windows antivirus scans a freshly
// written executable the first time it runs, and the frozen backend is ~70MB
// of Python and DLLs. At a fixed 20s that first launch reported "never became
// healthy" for a backend that was only being scanned, while the next launch --
// verdict cached -- started fine.
//
// Waiting this long is safe because the wait now ends the moment the child
// exits (see `backend_is_running`), so a backend that genuinely cannot start
// still fails in seconds instead of sitting here.
const BACKEND_START_TIMEOUT: Duration = Duration::from_secs(120);
const BACKEND_POLL_INTERVAL: Duration = Duration::from_millis(250);

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopContext {
    pub is_desktop: bool,
    pub backend_base_url: Option<String>,
    pub backend_ready: bool,
    pub backend_error: Option<String>,
    pub archive_dirty: bool,
}

#[derive(Default)]
pub struct AppRuntimeState {
    inner: Mutex<RuntimeStateInner>,
}

#[derive(Default)]
struct RuntimeStateInner {
    backend_child: Option<Child>,
    backend_base_url: Option<String>,
    backend_ready: bool,
    backend_error: Option<String>,
    archive_dirty: bool,
    allow_exit: bool,
}

impl AppRuntimeState {
    pub fn desktop_context(&self) -> DesktopContext {
        let state = self.inner.lock().expect("runtime state mutex poisoned");
        DesktopContext {
            is_desktop: true,
            backend_base_url: state.backend_base_url.clone(),
            backend_ready: state.backend_ready,
            backend_error: state.backend_error.clone(),
            archive_dirty: state.archive_dirty,
        }
    }

    pub fn set_archive_dirty(&self, dirty: bool) {
        let mut state = self.inner.lock().expect("runtime state mutex poisoned");
        state.archive_dirty = dirty;
    }

    pub fn allow_exit(&self) -> bool {
        let state = self.inner.lock().expect("runtime state mutex poisoned");
        state.allow_exit
    }

    pub fn set_allow_exit(&self, allow_exit: bool) {
        let mut state = self.inner.lock().expect("runtime state mutex poisoned");
        state.allow_exit = allow_exit;
    }

    /// Whether the backend child is still alive, reaping it if it has exited.
    ///
    /// Treated as running unless we positively saw it exit: if `try_wait`
    /// cannot tell us, the start timeout still bounds the wait, and declaring
    /// a healthy backend dead is the worse mistake.
    fn backend_is_running(&self) -> bool {
        let mut state = self.inner.lock().expect("runtime state mutex poisoned");
        match state.backend_child.as_mut() {
            Some(child) => !matches!(child.try_wait(), Ok(Some(_))),
            None => false,
        }
    }

    pub fn stop_backend(&self) {
        let mut state = self.inner.lock().expect("runtime state mutex poisoned");
        if let Some(mut child) = state.backend_child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
        state.backend_child = None;
        state.backend_base_url = None;
        state.backend_ready = false;
    }

    fn set_backend_started(&self, child: Child, base_url: String) {
        let mut state = self.inner.lock().expect("runtime state mutex poisoned");
        state.backend_child = Some(child);
        state.backend_base_url = Some(base_url);
        state.backend_ready = false;
        state.backend_error = None;
    }

    fn set_backend_ready(&self) {
        let mut state = self.inner.lock().expect("runtime state mutex poisoned");
        state.backend_ready = true;
        state.backend_error = None;
    }

    fn set_backend_error(&self, message: String) {
        let mut state = self.inner.lock().expect("runtime state mutex poisoned");
        state.backend_ready = false;
        state.backend_error = Some(message);
    }

}

impl Drop for AppRuntimeState {
    fn drop(&mut self) {
        self.stop_backend();
    }
}

pub fn start_backend_supervisor<R: Runtime>(app_handle: AppHandle<R>) {
    let runtime_state = app_handle.state::<Arc<AppRuntimeState>>().inner().clone();
    let supervisor_handle = app_handle.clone();
    thread::spawn(move || {
        let result = start_backend_process(&runtime_state, &supervisor_handle);
        if let Err(error) = result {
            runtime_state.set_backend_error(error.to_string());
        }
        let _ = app_handle.emit("backend-status", runtime_state.desktop_context());
    });
}

fn start_backend_process<R: Runtime>(
    state: &Arc<AppRuntimeState>,
    app_handle: &AppHandle<R>,
) -> Result<()> {
    let port = find_free_local_port()?;
    let base_url = format!("http://127.0.0.1:{port}");

    let mut command = if cfg!(debug_assertions) {
        build_dev_command(port)?
    } else {
        build_bundled_command(app_handle, port)?
    };

    command.stdout(Stdio::null()).stderr(Stdio::null());

    // The backend is a console-subsystem binary spawned from a GUI process.
    // Without this flag Windows gives it its own console window, which
    // flashes (dev) or persists (bundled, since the app has none to inherit).
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let child = command
        .spawn()
        .context("Failed to launch the Nexam backend process.")?;

    state.set_backend_started(child, base_url.clone());

    if let Err(error) = wait_for_healthcheck_while(
        &format!("{base_url}/health"),
        BACKEND_START_TIMEOUT,
        || state.backend_is_running(),
    ) {
        state.stop_backend();
        return Err(error).context("Backend process started but never became healthy.");
    }

    state.set_backend_ready();
    Ok(())
}

fn build_dev_command(port: u16) -> Result<Command> {
    let repo_root = resolve_repo_root()?;
    let python = resolve_python_path(&repo_root);

    let mut command = Command::new(&python);
    command
        .args([
            "-m",
            "uvicorn",
            "app.backend.main:app",
            "--host",
            "127.0.0.1",
            "--port",
            &port.to_string(),
        ])
        .current_dir(&repo_root);
    Ok(command)
}

fn bundled_backend_resource_path() -> &'static str {
    if cfg!(windows) {
        "nexam-backend/nexam-backend.exe"
    } else {
        "nexam-backend/nexam-backend"
    }
}

fn build_bundled_command<R: Runtime>(app_handle: &AppHandle<R>, port: u16) -> Result<Command> {
    let backend_binary = app_handle
        .path()
        .resolve(bundled_backend_resource_path(), BaseDirectory::Resource)
        .context("Failed to resolve the bundled backend binary path.")?;
    let demo_bank = app_handle
        .path()
        .resolve("samples/demo-bank.bok", BaseDirectory::Resource)
        .context("Failed to resolve the bundled demo bank path.")?;
    let demo_gradebook = app_handle
        .path()
        .resolve("samples/demo-gradebook.nxgb", BaseDirectory::Resource)
        .context("Failed to resolve the bundled demo gradebook path.")?;

    let mut command = Command::new(&backend_binary);
    command
        .args(["--port", &port.to_string()])
        .env("NEXAM_DEMO_BANK_PATH", &demo_bank)
        .env("NEXAM_DEMO_GRADEBOOK_PATH", &demo_gradebook);
    Ok(command)
}

fn resolve_repo_root() -> Result<PathBuf> {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| anyhow!("Could not resolve the Nexam repo root from the Tauri project path."))
}

fn resolve_python_path(repo_root: &Path) -> PathBuf {
    let venv_python = if cfg!(windows) {
        repo_root.join(".venv/Scripts/python.exe")
    } else {
        repo_root.join(".venv/bin/python3")
    };
    if venv_python.exists() {
        venv_python
    } else if cfg!(windows) {
        PathBuf::from("python")
    } else {
        PathBuf::from("python3")
    }
}

fn find_free_local_port() -> Result<u16> {
    let listener = TcpListener::bind("127.0.0.1:0").context("Failed to reserve a local port.")?;
    let port = listener
        .local_addr()
        .context("Failed to inspect the reserved local port.")?
        .port();
    drop(listener);
    Ok(port)
}

pub fn wait_for_healthcheck(url: &str, timeout: Duration) -> Result<()> {
    wait_for_healthcheck_while(url, timeout, || true)
}

/// Poll `/health` until it answers, the deadline passes, or the process we are
/// waiting on goes away.
///
/// The liveness check is what lets the deadline be generous: a slow start and
/// a dead backend look identical from the outside, and only one of them is
/// worth waiting two minutes for.
fn wait_for_healthcheck_while(
    url: &str,
    timeout: Duration,
    still_running: impl Fn() -> bool,
) -> Result<()> {
    let client = Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
        .context("Failed to construct the HTTP client for backend health checks.")?;

    let start = Instant::now();
    let mut last_error = String::from("health check did not return success");

    while start.elapsed() < timeout {
        match client.get(url).send() {
            Ok(response) if response.status().is_success() => return Ok(()),
            Ok(response) => {
                last_error = format!("health check returned {}", response.status());
            }
            Err(error) => {
                last_error = error.to_string();
            }
        }

        if !still_running() {
            return Err(anyhow!(
                "the backend process exited before it answered ({last_error})"
            ));
        }

        thread::sleep(BACKEND_POLL_INTERVAL);
    }

    Err(anyhow!(last_error))
}

#[cfg(test)]
mod tests {
    use super::{bundled_backend_resource_path, resolve_python_path, wait_for_healthcheck};
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::path::PathBuf;
    use std::thread;
    use std::time::Duration;

    #[test]
    fn bundled_backend_resource_path_matches_what_pyinstaller_emits_per_platform() {
        let expected = if cfg!(windows) {
            "nexam-backend/nexam-backend.exe"
        } else {
            "nexam-backend/nexam-backend"
        };
        assert_eq!(bundled_backend_resource_path(), expected);
    }

    #[test]
    fn resolve_python_path_prefers_the_venv_interpreter_when_present() {
        let repo_root =
            std::env::temp_dir().join(format!("nexam-venv-present-{}", std::process::id()));
        let venv_python = if cfg!(windows) {
            repo_root.join(".venv/Scripts/python.exe")
        } else {
            repo_root.join(".venv/bin/python3")
        };
        std::fs::create_dir_all(venv_python.parent().expect("venv dir has a parent"))
            .expect("create fake venv directory");
        std::fs::write(&venv_python, b"").expect("create fake interpreter file");

        let resolved = resolve_python_path(&repo_root);

        std::fs::remove_dir_all(&repo_root).ok();

        assert_eq!(resolved, venv_python);
    }

    #[test]
    fn resolve_python_path_falls_back_to_the_platform_command_when_no_venv_exists() {
        let repo_root =
            std::env::temp_dir().join(format!("nexam-venv-absent-{}", std::process::id()));

        let resolved = resolve_python_path(&repo_root);

        let expected = if cfg!(windows) { "python" } else { "python3" };
        assert_eq!(resolved, PathBuf::from(expected));
    }

    #[test]
    fn wait_for_healthcheck_accepts_success_response() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind test listener");
        let address = listener.local_addr().expect("listener addr");

        thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let mut buffer = [0_u8; 1024];
                let _ = stream.read(&mut buffer);
                let response =
                    b"HTTP/1.1 200 OK\r\nContent-Length: 15\r\n\r\n{\"status\":\"ok\"}";
                let _ = stream.write_all(response);
            }
        });

        wait_for_healthcheck(
            &format!("http://{address}/health"),
            Duration::from_secs(2),
        )
        .expect("health check should succeed");
    }

    /// The generous start timeout is only safe because a dead backend ends the
    /// wait immediately -- otherwise a backend that cannot start would hang the
    /// splash for two minutes instead of failing in seconds.
    #[test]
    fn waiting_stops_as_soon_as_the_process_is_gone_rather_than_running_out_the_clock() {
        use std::time::Instant;

        let started = Instant::now();
        let error = super::wait_for_healthcheck_while(
            "http://127.0.0.1:9/health",
            Duration::from_secs(120),
            || false,
        )
        .expect_err("a departed process should end the wait");

        assert!(
            started.elapsed() < Duration::from_secs(5),
            "gave up after {:?}, so it waited out the deadline instead of noticing the exit",
            started.elapsed()
        );
        assert!(
            error.to_string().contains("exited"),
            "the reason should say the process exited, got: {error}"
        );
    }

    #[test]
    fn wait_for_healthcheck_times_out_when_server_is_missing() {
        let error = wait_for_healthcheck(
            "http://127.0.0.1:9/health",
            Duration::from_millis(600),
        )
        .expect_err("health check should fail");

        assert!(
            !error.to_string().is_empty(),
            "timeout errors should explain why readiness failed"
        );
    }
}
