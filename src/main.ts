import { Client } from "@xhayper/discord-rpc";
import { App, Plugin, PluginManifest, TFile } from "obsidian";
import { Logger } from "./logger";
import { DiscordRPCSettings, PluginState } from "./settings/settings";
import { DiscordRPCSettingsTab } from "./settings/settings-tab";
import { StatusBar } from "./status-bar";
import type { Socket } from "node:net";

const CLIENT_ID = "1571667739095990462";
const READY_TIMEOUT_MS = 3000;

export default class ObsidianDiscordRPC extends Plugin {
  state: PluginState = PluginState.disconnected;
  // Incremented to invalidate in-flight connection attempts; each attempt
  // captures its own id and aborts if it no longer matches.
  private connectionId = 0;
  private stopping = false;
  declare settings: DiscordRPCSettings;
  private statusBar?: StatusBar;
  rpc?: Client;
  logger: Logger = new Logger();
  currentFile?: TFile;
  readonly loadedTime = new Date();
  lastSetTime = new Date();
  // The note lastSetTime was captured for, so display-only republishes
  // (e.g. settings changes) keep the elapsed time while a note change
  // starts a fresh one. Cleared while "Use Obsidian Total Time" is active.
  private lastSetTimeFile?: TFile;

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
      // connectDiscord() publishes currentFile via refreshActivity() once
      // the connection is ready, so no republish is needed here.
      await this.connectDiscord();
    } else {
      this.setState(PluginState.disconnected);
    }
  }

  async onFileOpen(file: TFile | null): Promise<void> {
    // A null event means no note is active; clear the stale file so
    // refreshActivity falls back to its defaults.
    this.currentFile = file ?? undefined;
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
    // Mark as stopping and invalidate pending attempts before cleanup so a
    // still-running connectDiscord cannot publish presence afterward.
    this.stopping = true;
    this.connectionId++;
    // destroyClient never throws, so saving is always reached.
    await this.destroyClient();
    this.setState(PluginState.disconnected);
    await this.saveData(this.settings);
  }

  async connectDiscord(): Promise<void> {
    if (this.stopping) return;
    const id = ++this.connectionId;

    // Avoids leaving dangling connections when reconnecting while connected.
    await this.destroyClient();
    if (!this.isAttemptValid(id)) return;

    // Seeds the start timestamp reused by refreshActivity until the current
    // note changes. loadedTime is initialized at plugin load and
    // intentionally not reset here so reconnects preserve the
    // "Use Obsidian Total Time" start timestamp.
    this.lastSetTime = new Date();

    const rpc = new Client({
      clientId: CLIENT_ID,
      transport: { type: "ipc" },
    });
    this.rpc = rpc;

    // Discord quitting closes the IPC socket; surface that as disconnected
    // so the status bar offers "Reconnect to Discord".
    const onLost = (): void => {
      // Ignore clients we already replaced or destroyed.
      if (!this.isAttemptValid(id) || this.rpc !== rpc) return;
      // Only a live connection can be lost. Failed attempts are reported by
      // the catch below, and this stays idempotent if both the library event
      // and the socket event fire.
      if (this.getState() !== PluginState.connected) return;
      this.setState(PluginState.disconnected);
      this.logger.log("Lost connection to Discord", this.settings.showPopups);
    };

    rpc.once("disconnected", onLost);

    this.setState(PluginState.connecting);

    rpc.once("ready", () => {
      if (!this.isAttemptValid(id)) return;
      this.setState(PluginState.connected);
      this.logger.log("Connected to Discord", this.settings.showPopups);
    });

    try {
      await rpc.login();
      if (!this.isAttemptValid(id)) return;

      // @xhayper/discord-rpc 1.5.1 never emits "disconnected" when Discord
      // closes the socket: its close() returns early because the socket is
      // already closed by then. Listen to the socket directly instead.
      // The socket is a private field, so this depends on library internals.
      (rpc.transport as unknown as { socket?: Socket }).socket?.once(
        "close",
        onLost,
      );

      // login() resolves when the IPC transport connects, but the READY frame
      // (which fills rpc.user) may arrive right after. Wait a moment
      // so the first activity isn't lost.
      if (!rpc.user) {
        await this.waitForReady(rpc, READY_TIMEOUT_MS);
        if (!this.isAttemptValid(id)) return;
      }
      await this.refreshActivity();
    } catch (error) {
      if (!this.isAttemptValid(id)) return;
      console.error("discordrpc: failed to connect to Discord", error);
      this.setState(PluginState.disconnected);
      this.logger.log("Failed to connect to Discord", this.settings.showPopups);
    }
  }

  async disconnectDiscord(): Promise<void> {
    // Invalidate pending connection attempts so a reconnect that is still
    // awaiting login/ready cannot restore presence after the disconnect.
    const id = ++this.connectionId;
    await this.destroyClient();
    // A newer connectDiscord() captured a higher generation while we were
    // destroying the client; leave its state and logging alone.
    if (!this.isAttemptValid(id)) return;
    this.setState(PluginState.disconnected);
    this.logger.log("Disconnected from Discord", this.settings.showPopups);
  }

  private isAttemptValid(id: number): boolean {
    return id === this.connectionId && !this.stopping;
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
    let date: Date;
    if (useLoadedTime) {
      date = this.loadedTime;
      this.lastSetTimeFile = undefined;
    } else if (this.currentFile === this.lastSetTimeFile) {
      date = this.lastSetTime;
    } else {
      date = new Date();
      this.lastSetTime = date;
      this.lastSetTimeFile = this.currentFile;
    }

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
