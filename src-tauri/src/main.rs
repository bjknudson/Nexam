#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod backend;

use std::process::Command;
use std::sync::Arc;
use std::time::Duration;

use backend::{start_backend_supervisor, AppRuntimeState, DesktopContext};
use rfd::{FileDialog, MessageButtons, MessageDialog, MessageDialogResult, MessageLevel};
use tauri::menu::{MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Manager, RunEvent, WindowEvent};

const UPDATE_REPO: &str = "bjknudson/Nexzam";

#[tauri::command]
fn get_desktop_context(state: tauri::State<'_, Arc<AppRuntimeState>>) -> DesktopContext {
    state.desktop_context()
}

#[tauri::command]
fn open_bank_dialog(initial_directory: Option<String>) -> Option<String> {
    let mut dialog = FileDialog::new()
        .add_filter("Nexzam Banks", &["bok"])
        .set_title("Open Nexzam Bank");

    if let Some(dir) = initial_directory {
        dialog = dialog.set_directory(dir);
    }

    dialog.pick_file().map(|path| path.display().to_string())
}

/// A gradebook (.nxgb) is a separate document from a bank -- see
/// docs/grading.md -- so it gets its own open/save dialogs rather than
/// reusing the bank ones with a different filter bolted on.
#[tauri::command]
fn open_gradebook_dialog(initial_directory: Option<String>) -> Option<String> {
    let mut dialog = FileDialog::new()
        .add_filter("Nexzam Gradebooks", &["nxgb"])
        .set_title("Open Nexzam Gradebook");

    if let Some(dir) = initial_directory {
        dialog = dialog.set_directory(dir);
    }

    dialog.pick_file().map(|path| path.display().to_string())
}

#[tauri::command]
fn save_gradebook_dialog(
    current_path: Option<String>,
    suggested_file_name: Option<String>,
    initial_directory: Option<String>,
) -> Option<String> {
    let mut dialog = FileDialog::new()
        .add_filter("Nexzam Gradebooks", &["nxgb"])
        .set_title("Save Nexzam Gradebook");

    if let Some(path) = current_path {
        let path = std::path::Path::new(&path);
        dialog = dialog.set_file_name(
            path.file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("gradebook.nxgb"),
        );
        if let Some(parent) = path.parent().filter(|parent| !parent.as_os_str().is_empty()) {
            dialog = dialog.set_directory(parent);
        }
    } else {
        dialog = dialog.set_file_name(suggested_file_name.as_deref().unwrap_or("gradebook.nxgb"));
        if let Some(dir) = initial_directory {
            dialog = dialog.set_directory(dir);
        }
    }

    dialog.save_file().map(|path| path.display().to_string())
}

#[tauri::command]
fn save_bank_dialog(
    current_path: Option<String>,
    suggested_file_name: Option<String>,
    initial_directory: Option<String>,
) -> Option<String> {
    let mut dialog = FileDialog::new()
        .add_filter("Nexzam Banks", &["bok"])
        .set_title("Save Nexzam Bank");

    if let Some(path) = current_path {
        let path = std::path::Path::new(&path);
        dialog = dialog.set_file_name(
            path.file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("bank.bok"),
        );
        if let Some(parent) = path.parent().filter(|parent| !parent.as_os_str().is_empty()) {
            dialog = dialog.set_directory(parent);
        }
    } else {
        dialog = dialog.set_file_name(suggested_file_name.as_deref().unwrap_or("bank.bok"));
        if let Some(dir) = initial_directory {
            dialog = dialog.set_directory(dir);
        }
    }

    dialog.save_file().map(|path| path.display().to_string())
}

/// Save arbitrary bytes (e.g. a generated response-sheet PDF) to a
/// user-chosen path. Unlike `save_bank_dialog`, this isn't tied to one file
/// type -- the filter is derived from the suggested file name's extension.
#[tauri::command]
fn save_bytes_dialog(
    bytes: Vec<u8>,
    suggested_file_name: Option<String>,
    initial_directory: Option<String>,
) -> Result<Option<String>, String> {
    let file_name = suggested_file_name.unwrap_or_else(|| "download.pdf".to_string());
    let extension = std::path::Path::new(&file_name)
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("pdf")
        .to_string();

    let mut dialog = FileDialog::new()
        .add_filter(&extension.to_uppercase(), &[extension.as_str()])
        .set_file_name(&file_name)
        .set_title("Save File");
    if let Some(dir) = initial_directory {
        dialog = dialog.set_directory(dir);
    }

    let Some(path) = dialog.save_file() else {
        return Ok(None);
    };
    std::fs::write(&path, &bytes).map_err(|error| format!("Could not save file: {error}"))?;
    Ok(Some(path.display().to_string()))
}

#[tauri::command]
fn pick_directory_dialog(initial_directory: Option<String>) -> Option<String> {
    let mut dialog = FileDialog::new().set_title("Choose a Folder");

    if let Some(dir) = initial_directory {
        dialog = dialog.set_directory(dir);
    }

    dialog.pick_folder().map(|path| path.display().to_string())
}

/// Paper sizes in points (72 per inch), matching the frontend's page sizes.
fn paper_size_points(page_size: &str) -> (f64, f64) {
    match page_size {
        "legal" => (612.0, 1008.0),
        "a4" => (595.28, 841.89),
        _ => (612.0, 792.0),
    }
}

/// Tell the macOS print system what paper the test was laid out for.
///
/// The print panel reads the shared `NSPrintInfo`, so setting it here is what
/// carries the test's page size across. Margins go to zero on purpose: each
/// sheet already contains its own margin as padding, and letting the print
/// system add more would shrink the content a second time.
#[cfg(target_os = "macos")]
fn apply_print_info(page_size: &str) {
    use objc2_app_kit::NSPrintInfo;
    use objc2_foundation::NSSize;

    let (width, height) = paper_size_points(page_size);
    let info = NSPrintInfo::sharedPrintInfo();
    info.setPaperSize(NSSize::new(width, height));
    info.setTopMargin(0.0);
    info.setBottomMargin(0.0);
    info.setLeftMargin(0.0);
    info.setRightMargin(0.0);
}

#[cfg(not(target_os = "macos"))]
fn apply_print_info(_page_size: &str) {}

/// Open the system print dialog for the window that asked for it.
///
/// `window.print()` is a no-op inside the macOS webview, so the button has to
/// come back through the shell to reach the print panel at all.
#[tauri::command]
fn print_current_window(webview_window: tauri::WebviewWindow, page_size: Option<String>) -> Result<(), String> {
    apply_print_info(page_size.as_deref().unwrap_or("letter"));
    webview_window
        .print()
        .map_err(|error| format!("Could not open the print dialog: {error}"))
}

#[tauri::command]
fn set_archive_dirty(state: tauri::State<'_, Arc<AppRuntimeState>>, dirty: bool) {
    state.set_archive_dirty(dirty);
}

#[tauri::command]
fn check_for_updates(app_handle: AppHandle) {
    run_update_check(&app_handle);
}

fn run_update_check(app_handle: &AppHandle) {
    let current_version = app_handle.package_info().version.to_string();

    let client = match reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(8))
        .user_agent("Nexzam-Update-Check")
        .build()
    {
        Ok(client) => client,
        Err(_) => {
            show_update_message(
                MessageLevel::Warning,
                "Could not start the update check.",
            );
            return;
        }
    };

    let response = match client
        .get(format!("https://api.github.com/repos/{UPDATE_REPO}/releases/latest"))
        .send()
    {
        Ok(response) => response,
        Err(_) => {
            show_update_message(
                MessageLevel::Warning,
                "Could not reach GitHub. Check your internet connection and try again.",
            );
            return;
        }
    };

    if response.status() == reqwest::StatusCode::NOT_FOUND {
        show_update_message(
            MessageLevel::Info,
            "No published releases were found yet. This beta is distributed manually for now.",
        );
        return;
    }

    if !response.status().is_success() {
        show_update_message(
            MessageLevel::Warning,
            "GitHub returned an unexpected response. Try again later.",
        );
        return;
    }

    let body = match response.text() {
        Ok(text) => text,
        Err(_) => {
            show_update_message(MessageLevel::Warning, "Could not read the update response.");
            return;
        }
    };

    let latest_tag = serde_json::from_str::<serde_json::Value>(&body)
        .ok()
        .and_then(|value| value.get("tag_name").and_then(|v| v.as_str()).map(str::to_string));

    let Some(latest_tag) = latest_tag else {
        show_update_message(
            MessageLevel::Warning,
            "Could not parse the latest release information.",
        );
        return;
    };

    let latest_version = latest_tag.trim_start_matches('v');

    if compare_versions(latest_version, &current_version) == std::cmp::Ordering::Greater {
        let release_url = format!("https://github.com/{UPDATE_REPO}/releases/tag/{latest_tag}");
        let choice = MessageDialog::new()
            .set_level(MessageLevel::Info)
            .set_title("Update Available")
            .set_description(format!(
                "Nexzam {latest_version} is available. You're running {current_version}. Open the release page in your browser?"
            ))
            .set_buttons(MessageButtons::YesNo)
            .show();

        if choice == MessageDialogResult::Yes {
            let _ = Command::new("open").arg(release_url).spawn();
        }
    } else {
        show_update_message(
            MessageLevel::Info,
            format!("You're up to date. Nexzam {current_version}."),
        );
    }
}

fn show_update_message(level: MessageLevel, message: impl Into<String>) {
    MessageDialog::new()
        .set_level(level)
        .set_title("Check for Updates")
        .set_description(message.into())
        .set_buttons(MessageButtons::Ok)
        .show();
}

fn compare_versions(a: &str, b: &str) -> std::cmp::Ordering {
    fn parts(version: &str) -> Vec<u64> {
        version
            .split(|c: char| c == '.' || c == '-' || c == '+')
            .take(3)
            .map(|segment| segment.parse::<u64>().unwrap_or(0))
            .collect()
    }

    let (left, right) = (parts(a), parts(b));
    for index in 0..3 {
        let (l, r) = (
            left.get(index).copied().unwrap_or(0),
            right.get(index).copied().unwrap_or(0),
        );
        match l.cmp(&r) {
            std::cmp::Ordering::Equal => continue,
            other => return other,
        }
    }
    std::cmp::Ordering::Equal
}

fn main() {
    let app = tauri::Builder::default()
        .manage(Arc::new(AppRuntimeState::default()))
        .menu(|handle| {
            let settings_item = MenuItemBuilder::with_id("settings", "Settings…")
                .accelerator("CmdOrCtrl+,")
                .build(handle)?;
            let check_updates_item =
                MenuItemBuilder::with_id("check-for-updates", "Check for Updates…").build(handle)?;
            let view_help_item =
                MenuItemBuilder::with_id("view-help", "Nexzam Help").build(handle)?;
            let new_bank_item = MenuItemBuilder::with_id("new-bank", "New Bank…")
                .accelerator("CmdOrCtrl+N")
                .build(handle)?;
            let open_bank_item = MenuItemBuilder::with_id("open-bank", "Open Bank…")
                .accelerator("CmdOrCtrl+O")
                .build(handle)?;
            let open_demo_item =
                MenuItemBuilder::with_id("open-demo-bank", "Open Demo Bank").build(handle)?;
            let bank_properties_item = MenuItemBuilder::with_id("bank-properties", "Bank Properties…")
                .accelerator("CmdOrCtrl+I")
                .build(handle)?;
            let save_bank_item = MenuItemBuilder::with_id("save-bank", "Save Bank")
                .accelerator("CmdOrCtrl+S")
                .build(handle)?;
            let save_as_item = MenuItemBuilder::with_id("save-as", "Save As…")
                .accelerator("CmdOrCtrl+Shift+S")
                .build(handle)?;

            let app_menu = SubmenuBuilder::new(handle, "Nexzam")
                .item(&PredefinedMenuItem::about(handle, Some("About Nexzam"), None)?)
                .separator()
                .item(&settings_item)
                .separator()
                .services()
                .separator()
                .hide()
                .hide_others()
                .show_all()
                .separator()
                .quit()
                .build()?;

            let file_menu = SubmenuBuilder::new(handle, "File")
                .item(&new_bank_item)
                .item(&open_bank_item)
                .item(&open_demo_item)
                .separator()
                .item(&bank_properties_item)
                .separator()
                .item(&save_bank_item)
                .item(&save_as_item)
                .separator()
                .close_window()
                .build()?;

            let edit_menu = SubmenuBuilder::new(handle, "Edit")
                .undo()
                .redo()
                .separator()
                .cut()
                .copy()
                .paste()
                .select_all()
                .build()?;

            let window_menu = SubmenuBuilder::new(handle, "Window").minimize().build()?;

            let help_menu = SubmenuBuilder::new(handle, "Help")
                .item(&view_help_item)
                .item(&check_updates_item)
                .build()?;

            tauri::menu::MenuBuilder::new(handle)
                .item(&app_menu)
                .item(&file_menu)
                .item(&edit_menu)
                .item(&window_menu)
                .item(&help_menu)
                .build()
        })
        .on_menu_event(|app_handle, event| match event.id().as_ref() {
            "settings" => {
                let _ = app_handle.emit("nexzam://open-settings", ());
            }
            "check-for-updates" => {
                run_update_check(app_handle);
            }
            "view-help" => {
                let help_url = format!("https://github.com/{UPDATE_REPO}#readme");
                let _ = Command::new("open").arg(help_url).spawn();
            }
            "new-bank" => {
                let _ = app_handle.emit("nexzam://new-bank", ());
            }
            "open-bank" => {
                let _ = app_handle.emit("nexzam://open-bank", ());
            }
            "open-demo-bank" => {
                let _ = app_handle.emit("nexzam://open-demo-bank", ());
            }
            "bank-properties" => {
                let _ = app_handle.emit("nexzam://bank-properties", ());
            }
            "save-bank" => {
                let _ = app_handle.emit("nexzam://save-bank", ());
            }
            "save-as" => {
                let _ = app_handle.emit("nexzam://save-as", ());
            }
            _ => {}
        })
        .setup(|app| {
            start_backend_supervisor(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_desktop_context,
            open_bank_dialog,
            save_bank_dialog,
            open_gradebook_dialog,
            save_gradebook_dialog,
            save_bytes_dialog,
            pick_directory_dialog,
            set_archive_dirty,
            check_for_updates,
            print_current_window
        ])
        .build(tauri::generate_context!())
        .expect("error while running Nexzam");

    app.run(|app_handle, event| match event {
            RunEvent::WindowEvent { event: WindowEvent::Destroyed, .. } => {
                let state = app_handle.state::<Arc<AppRuntimeState>>();
                if app_handle.webview_windows().is_empty() {
                    state.stop_backend();
                }
            }
            RunEvent::ExitRequested { api, .. } => {
                let state = app_handle.state::<Arc<AppRuntimeState>>();
                if state.allow_exit() {
                    return;
                }

                if state.desktop_context().archive_dirty {
                    api.prevent_exit();
                    let confirm = MessageDialog::new()
                        .set_level(MessageLevel::Warning)
                        .set_title("Unsaved Archive Changes")
                        .set_description(
                            "The working copy has changes that have not been written back to the .bok archive. Quit anyway?",
                        )
                        .set_buttons(MessageButtons::YesNo)
                        .show();

                    if confirm == MessageDialogResult::Yes {
                        state.set_allow_exit(true);
                        state.stop_backend();
                        app_handle.exit(0);
                    }
                } else {
                    state.stop_backend();
                }
            }
            RunEvent::Exit => {
                let state = app_handle.state::<Arc<AppRuntimeState>>();
                state.stop_backend();
            }
            _ => {}
        });
}

#[cfg(test)]
mod tests {
    use super::paper_size_points;

    #[test]
    fn paper_sizes_match_the_preview_page_sizes() {
        // 72 points per inch, the same sheets the preview lays out.
        assert_eq!(paper_size_points("letter"), (612.0, 792.0)); // 8.5 x 11
        assert_eq!(paper_size_points("legal"), (612.0, 1008.0)); // 8.5 x 14
        let (a4_width, a4_height) = paper_size_points("a4"); // 210 x 297 mm
        assert!((a4_width - 595.28).abs() < 0.01);
        assert!((a4_height - 841.89).abs() < 0.01);
    }

    #[test]
    fn an_unknown_paper_size_falls_back_to_letter() {
        assert_eq!(paper_size_points("tabloid"), (612.0, 792.0));
        assert_eq!(paper_size_points(""), (612.0, 792.0));
    }

    /// The print panel reads the shared `NSPrintInfo`, so this is the handoff
    /// that actually carries the page size to the print system.
    #[cfg(target_os = "macos")]
    #[test]
    fn applying_print_info_sets_the_shared_paper_size_and_clears_margins() {
        use objc2_app_kit::NSPrintInfo;

        super::apply_print_info("legal");
        let info = NSPrintInfo::sharedPrintInfo();
        let size = info.paperSize();
        assert!((size.width - 612.0).abs() < 0.01, "width was {}", size.width);
        assert!((size.height - 1008.0).abs() < 0.01, "height was {}", size.height);
        // Each sheet already carries its own margin as padding.
        assert_eq!(info.topMargin(), 0.0);
        assert_eq!(info.bottomMargin(), 0.0);
        assert_eq!(info.leftMargin(), 0.0);
        assert_eq!(info.rightMargin(), 0.0);

        super::apply_print_info("a4");
        let a4 = NSPrintInfo::sharedPrintInfo().paperSize();
        assert!((a4.width - 595.28).abs() < 0.01, "width was {}", a4.width);
    }
}
