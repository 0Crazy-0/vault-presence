import { Client } from "@xhayper/discord-rpc";
import { App, Plugin, PluginManifest, TFile } from "obsidian";
import { Logger } from "./logger";
import { DiscordRPCSettings, PluginState } from "./settings/settings";
import { DiscordRPCSettingsTab } from "./settings/settings-tab";
import { StatusBar } from "./status-bar";

const CLIENT_ID = "1571667739095990462";
const READY_TIMEOUT_MS = 3000;

export default class ObsidianDiscordRPC extends Plugin {
  state: PluginState = PluginState.disconnected;
  declare settings: DiscordRPCSettings;
  private statusBar?: StatusBar;
  rpc?: Client;
  logger: Logger = new Logger();
  currentFile?: TFile;
  loadedTime = new Date();
  lastSetTime = new Date();

  setState(state: PluginState): void {
    this.state = state;
    this.statusBar?.displayState(state, this.settings.autoHideStatusBar);
  }

  getState(): PluginState {
    return this.state;
  }

  getApp(): App {
    return this.app;
  }

  getPluginManifest(): PluginManifest {
    return this.manifest;
  }

  async onload(): Promise<void> {
    const statusBarEl = this.addStatusBarItem();
    this.statusBar = new StatusBar(statusBarEl);

    this.settings = Object.assign(
      new DiscordRPCSettings(),
      await this.loadData(),
    );

    this.registerEvent(
      this.app.workspace.on("file-open", this.onFileOpen, this),
    );

    this.registerDomEvent(statusBarEl, "click", async () => {
      if (this.getState() === PluginState.disconnected) {
        await this.connectDiscord();
      } else if (this.getState() === PluginState.connected) {
        await this.disconnectDiscord();
      }
    });

    this.addSettingTab(new DiscordRPCSettingsTab(this.app, this));

    this.addCommand({
      id: "reconnect-discord",
      name: "Reconnect to Discord",
      callback: async () => await this.connectDiscord(),
    });

    this.addCommand({
      id: "disconnect-discord",
      name: "Disconnect from Discord",
      callback: async () => await this.disconnectDiscord(),
    });

    // Track the already-open note so a manual connection shows it
    // without waiting for another file-open event.
    const activeFile = this.app.workspace.getActiveFile();
    if (activeFile) {
      this.currentFile = activeFile;
    }

    if (this.settings.connectOnStart) {
      await this.connectDiscord();

      if (activeFile) {
        // Republish the activity now that the connection is ready.
        await this.onFileOpen(activeFile);
      }
    } else {
      this.setState(PluginState.disconnected);
    }
  }

  async onFileOpen(file: TFile | null): Promise<void> {
    if (!file) {
      return;
    }
    this.currentFile = file;
    if (this.getState() === PluginState.connected) {
      await this.refreshActivity();
    }
  }

  onunload(): void {
    // Obsidian doesn't wait for onunload, so cleanup is fired without await
    // and errors are logged to the console.
    this.shutdown().catch((error) =>
      console.error("discordrpc: error during unload", error),
    );
  }

  private async shutdown(): Promise<void> {
    // destroyClient never throws, so saving is always reached.
    await this.destroyClient();
    await this.saveData(this.settings);
  }

  async connectDiscord(): Promise<void> {
    // Avoids leaving dangling connections when reconnecting while connected.
    await this.destroyClient();

    this.loadedTime = new Date();
    this.lastSetTime = new Date();

    const rpc = new Client({
      clientId: CLIENT_ID,
      transport: { type: "ipc" },
    });
    this.rpc = rpc;

    this.setState(PluginState.connecting);

    rpc.once("ready", () => {
      this.setState(PluginState.connected);
      this.logger.log("Connected to Discord", this.settings.showPopups);
    });

    try {
      await rpc.login();
      // login() resolves when the IPC transport connects, but the READY frame
      // (which fills rpc.user) may arrive right after. Wait a moment
      // so the first activity isn't lost.
      if (!rpc.user) {
        await this.waitForReady(rpc, READY_TIMEOUT_MS);
      }
      await this.refreshActivity();
    } catch (error) {
      console.error("discordrpc: failed to connect to Discord", error);
      this.setState(PluginState.disconnected);
      this.logger.log("Failed to connect to Discord", this.settings.showPopups);
    }
  }

  async disconnectDiscord(): Promise<void> {
    await this.destroyClient();
    this.setState(PluginState.disconnected);
    this.logger.log("Disconnected from Discord", this.settings.showPopups);
  }

  /**
   * Republishes the activity with the current file. If no file has been
   * opened yet, uses default values instead of failing.
   */
  async refreshActivity(): Promise<void> {
    const file = this.currentFile;
    await this.setActivity(
      this.app.vault.getName(),
      file?.basename ?? "...",
      file?.extension ?? "",
    );
  }

  async setActivity(
    vaultName: string,
    fileName: string,
    fileExtension: string,
  ): Promise<void> {
    const user = this.rpc?.user;
    if (this.getState() !== PluginState.connected || !user) {
      return;
    }

    const {
      customVaultName,
      showFileExtension,
      useLoadedTime,
      privacyMode,
      showVaultName,
      showCurrentFileName,
    } = this.settings;

    const vault = customVaultName === "" ? vaultName : customVaultName;
    const file =
      showFileExtension && fileExtension
        ? `${fileName}.${fileExtension}`
        : fileName;
    const date = useLoadedTime ? this.loadedTime : new Date();
    this.lastSetTime = date;

    const base = {
      startTimestamp: date,
      largeImageKey: "vault_logo",
      largeImageText: "Obsidian",
    };

    if (privacyMode) {
      await user.setActivity({
        ...base,
        details: "Editing Notes",
        state: "Working in a Vault",
      });
      return;
    }

    await user.setActivity({
      ...base,
      ...(showCurrentFileName && { details: file }),
      ...(showVaultName && { state: `Vault: ${vault}` }),
    });
  }

  private async destroyClient(): Promise<void> {
    const rpc = this.rpc;
    if (!rpc) {
      return;
    }
    this.rpc = undefined;
    try {
      try {
        await rpc.user?.clearActivity();
      } finally {
        await rpc.destroy();
      }
    } catch {
      // Discord may already be closed; nothing else to do.
    }
  }

  private waitForReady(rpc: Client, timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timeout = window.setTimeout(resolve, timeoutMs);
      rpc.once("ready", () => {
        window.clearTimeout(timeout);
        resolve();
      });
    });
  }
}
