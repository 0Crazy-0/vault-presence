import { PluginState } from "./settings/settings";

const AUTO_HIDE_MS = 10_000;
const ICON_ONLY_MS = 5_000;

export class StatusBar {
  private timer: number | null = null;

  constructor(private readonly statusBarEl: HTMLElement) {}

  displayState(state: PluginState, autoHide: boolean): void {
    this.clearTimer();

    switch (state) {
      case PluginState.connected:
        this.displayConnected(autoHide);
        break;
      case PluginState.connecting:
        this.statusBarEl.setText("Connecting to Discord...");
        break;
      case PluginState.disconnected:
        this.statusBarEl.setText("\u{1F5D8} Reconnect to Discord");
        break;
    }
  }

  private displayConnected(autoHide: boolean): void {
    this.statusBarEl.setText("\u{1F30D} Connected to Discord");
    this.timer = window.setTimeout(
      () => {
        this.statusBarEl.setText(autoHide ? "" : "\u{1F30D}");
        this.timer = null;
      },
      autoHide ? AUTO_HIDE_MS : ICON_ONLY_MS,
    );
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
