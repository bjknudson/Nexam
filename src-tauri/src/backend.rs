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

const BACKEND_START_TIMEOUT: Duration = Duration::from_secs(20);
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

    let child = command
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .context("Failed to launch the Nexzam backend process.")?;

    state.set_backend_started(child, base_url.clone());

    if let Err(error) = wait_for_healthcheck(&format!("{base_url}/health"), BACKEND_START_TIMEOUT) {
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

fn build_bundled_command<R: Runtime>(app_handle: &AppHandle<R>, port: u16) -> Result<Command> {
    let backend_binary = app_handle
        .path()
        .resolve("nexzam-backend/nexzam-backend", BaseDirectory::Resource)
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
        .env("NEXZAM_DEMO_BANK_PATH", &demo_bank)
        .env("NEXZAM_DEMO_GRADEBOOK_PATH", &demo_gradebook);
    Ok(command)
}

fn resolve_repo_root() -> Result<PathBuf> {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| anyhow!("Could not resolve the Nexzam repo root from the Tauri project path."))
}

fn resolve_python_path(repo_root: &Path) -> PathBuf {
    let venv_python = repo_root.join(".venv/bin/python3");
    if venv_python.exists() {
        venv_python
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

        thread::sleep(BACKEND_POLL_INTERVAL);
    }

    Err(anyhow!(last_error))
}

#[cfg(test)]
mod tests {
    use super::wait_for_healthcheck;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread;
    use std::time::Duration;

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
