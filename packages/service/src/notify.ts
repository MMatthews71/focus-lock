/**
 * Native OS notifications.
 *
 * The service runs in the background with no window of its own, so it reaches
 * the user through the operating system's own notification centre — which shows
 * up wherever the user currently is, regardless of whether the FocusLock app
 * window is open. Each platform has a fire-and-forget mechanism:
 *   - Windows: a toast via the WinRT ToastNotificationManager, driven from
 *     PowerShell. Title/body are passed as environment variables so no user text
 *     is ever interpolated into the script (no quoting or injection surprises).
 *   - macOS:   `osascript -e 'display notification …'`.
 *   - Linux:   `notify-send`.
 *
 * All failures are swallowed (logged only): a notification is a courtesy, never
 * something enforcement should depend on.
 */

import { execFile } from 'node:child_process';

// A registered AppUserModelID is required for a Windows toast to appear reliably;
// PowerShell's own is always present, so we borrow it rather than registering one.
const WIN_APP_ID =
  '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe';

const WIN_TOAST_SCRIPT = `
$ErrorActionPreference = 'Stop'
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.UI.Notifications.ToastNotification, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
$template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
$texts = $template.GetElementsByTagName('text')
$texts.Item(0).AppendChild($template.CreateTextNode($env:FL_TITLE)) | Out-Null
$texts.Item(1).AppendChild($template.CreateTextNode($env:FL_BODY)) | Out-Null
$toast = [Windows.UI.Notifications.ToastNotification]::new($template)
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($env:FL_APP_ID).Show($toast)
`;

export type Notifier = (title: string, body: string) => void;

/** Show a native OS notification. Fire-and-forget; never throws. */
export function notify(title: string, body: string, log: (m: string) => void = () => {}): void {
  const done = (err: Error | null) => {
    if (err) log(`notify failed: ${err.message}`);
  };
  try {
    if (process.platform === 'win32') {
      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', WIN_TOAST_SCRIPT],
        { windowsHide: true, env: { ...process.env, FL_TITLE: title, FL_BODY: body, FL_APP_ID: WIN_APP_ID } },
        done,
      );
    } else if (process.platform === 'darwin') {
      const esc = (s: string) => s.replace(/(["\\])/g, '\\$1');
      execFile('osascript', ['-e', `display notification "${esc(body)}" with title "${esc(title)}"`], done);
    } else {
      execFile('notify-send', [title, body], done);
    }
  } catch (err) {
    log(`notify error: ${String(err)}`);
  }
}
