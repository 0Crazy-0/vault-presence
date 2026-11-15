import { App, debounce, PluginSettingTab, Setting } from "obsidian";
import { Logger } from "../logger";
import type ObsidianDiscordRPC from "../main";

type ToggleKey =
  | "privacyMode"
  | "showVaultName"
  | "showCurrentFileName"
  | "showFileExtension"
  | "useLoadedTime"
  | "autoHideStatusBar"
  | "connectOnStart"
  | "showPopups";

interface ToggleOptions {
  /** Republishes the activity to Discord after saving. */
  refresh?: boolean;
  /** Notices [when enabled, when disabled]. */
  notices?: [on: string, off: string];
}

export class DiscordRPCSettingsTab extends PluginSettingTab {
  private readonly logger = new Logger();

  constructor(
    app: App,
    private readonly plugin: ObsidianDiscordRPC,
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    this.addHeading("Vault name settings");
    this.addToggle(
      "Privacy Mode",
      "Enable this to hide the name of the vault and hide file names.",
      "privacyMode",
      {
        refresh: true,
        notices: ["Privacy Mode Enabled", "Privacy Mode Disabled"],
      },
    );
    this.addToggle(
      "Show Vault Name",
      "Enable this to show the name of the vault you are working with.",
      "showVaultName",
      {
        refresh: true,
        notices: [
          "Vault Name is now Visible",
          "Vault Name is no longer Visible",
        ],
      },
    );

    // Changes are debounced to avoid hitting Discord's rate limit.
    const persistCustomName = debounce(
      async () => {
        await this.plugin.saveData(this.plugin.settings);
        await this.plugin.refreshActivity();
      },
      500,
      true,
    );
    new Setting(containerEl)
      .setName("Set Custom Vault Name")
      .setDesc(
        "Change the vault name shown publicly. Leave blank to use your actual vault name.",
      )
      .addText((text) =>
        text
          .setValue(this.plugin.settings.customVaultName)
          .onChange((value) => {
            this.plugin.settings.customVaultName = value;
            persistCustomName();
          }),
      );

    this.addHeading("File name settings");
    this.addToggle(
      "Show Current File Name",
      "Enable this to show the name of the file you are working on.",
      "showCurrentFileName",
      {
        refresh: true,
        notices: ["File Name is now Visible", "File Name is no longer Visible"],
      },
    );
    this.addToggle(
      "Show File Extension",
      "Enable this to show file extension.",
      "showFileExtension",
      { refresh: true },
    );

    this.addHeading("Time settings");
    this.addToggle(
      "Use Obsidian Total Time",
      "Enable to use the total time you have been using Obsidian, instead of the time spent editing a single file.",
      "useLoadedTime",
      { refresh: true },
    );

    this.addHeading("Status bar settings");
    this.addToggle(
      "Automatically hide Status Bar",
      "Automatically hide status bar after successfully connecting to Discord.",
      "autoHideStatusBar",
    );

    this.addHeading("Startup settings");
    this.addToggle(
      "Automatically Connect to Discord",
      "Automatically connect to Discord on startup. You can always click the status bar to manually connect.",
      "connectOnStart",
    );

    this.addHeading("Notice settings");
    this.addToggle(
      "Show Notices",
      "Enable this to show connection Notices.",
      "showPopups",
      { notices: ["Notices Enabled", "Notices Disabled"] },
    );
  }

  private addHeading(name: string): void {
    new Setting(this.containerEl).setName(name).setHeading();
  }

  private addToggle(
    name: string,
    desc: string,
    key: ToggleKey,
    { refresh = false, notices }: ToggleOptions = {},
  ): void {
    new Setting(this.containerEl)
      .setName(name)
      .setDesc(desc)
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings[key]).onChange(async (value) => {
          this.plugin.settings[key] = value;
          await this.plugin.saveData(this.plugin.settings);

          if (notices) {
            this.logger.logIgnoreNoNotice(value ? notices[0] : notices[1]);
          }
          if (refresh) {
            await this.plugin.refreshActivity();
          }
        }),
      );
  }
}
