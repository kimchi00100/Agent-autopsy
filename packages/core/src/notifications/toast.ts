import { spawn } from 'node:child_process';

export function sendWindowsToast(title: string, message: string): void {
  if (process.platform !== 'win32') return;

  const escapedTitle = title.replace(/'/g, "''").replace(/[\r\n]+/g, ' ');
  const escapedMessage = message.replace(/'/g, "''").replace(/[\r\n]+/g, ' ');

  const script = `
    try {
      [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
      $template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
      $textNodes = $template.GetElementsByTagName('text')
      $textNodes.Item(0).AppendChild($template.CreateTextNode('${escapedTitle}')) > $null
      $textNodes.Item(1).AppendChild($template.CreateTextNode('${escapedMessage}')) > $null
      $toast = [Windows.UI.Notifications.ToastNotification]::new($template)
      [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Agent Autopsy').Show($toast)
    } catch {}
  `;

  try {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
  } catch {
    // Ignore notification error
  }
}
