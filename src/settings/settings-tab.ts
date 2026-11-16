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
  /** Re-renders the status bar for the current state with the updated setting. */
  renderState?: boolean;
  /** Notices [when enabled, when disabled]. */
  notices?: [on: string, off: string];
}

interface ToggleSpec {
  name: string;
  desc: string;
  options?: ToggleOptions;
}

// Single source of truth shared by display() (Obsidian < 1.13) and
// getSettingDefinitions() (Obsidian 1.13+), so both stay in sync.
const TOGGLES: Record<ToggleKey, ToggleSpec> = {
  privacyMode: {
    name: "Privacy Mode",
    desc: "Enable this to hide the name of the vault and hide file names.",
    options: {
      refresh: true,
      notices: ["Privacy Mode Enabled", "Privacy Mode Disabled"],
    },
  },
  showVaultName: {
    name: "Show Vault Name",
    desc: "Enable this to show the name of the vault you are working with.",
    options: {
      refresh: true,
      notices: ["Vault Name is now Visible", "Vault Name is no longer Visible"],
    },
  },
  showCurrentFileName: {
    name: "Show Current File Name",
    desc: "Enable this to show the name of the file you are working on.",
    options: {
      refresh: true,
      notices: ["File Name is now Visible", "File Name is no longer Visible"],
    },
  },
  showFileExtension: {
    name: "Show File Extension",
    desc: "Enable this to show file extension.",
    options: { refresh: true },
  },
  useLoadedTime: {
    name: "Use Obsidian Total Time",
    desc: "Enable to use the total time you have been using Obsidian, instead of the time spent editing a single file.",
    options: { refresh: true },
  },
  autoHideStatusBar: {
    name: "Automatically hide Status Bar",
    desc: "Automatically hide status bar after successfully connecting to Discord.",
    options: { renderState: true },
  },
  connectOnStart: {
    name: "Automatically Connect to Discord",
    desc: "Automatically connect to Discord on startup. You can always click the status bar to manually connect.",
  },
  showPopups: {
    name: "Show Notices",
    desc: "Enable this to show connection Notices.",
    options: { notices: ["Notices Enabled", "Notices Disabled"] },
  },
};

const CUSTOM_VAULT_NAME = {
  name: "Set Custom Vault Name",
  desc: "Change the vault name shown publicly. Leave blank to use your actual vault name.",
};

export class DiscordRPCSettingsTab extends PluginSettingTab {
  private readonly logger = new Logger();

  // Changes are debounced to avoid hitting Discord's rate limit.
  private readonly persistCustomName = debounce(
    async () => {
      await this.plugin.saveData(this.plugin.settings);
      await this.plugin.refreshActivity();
    },
    500,
    true,
  );

  constructor(
    app: App,
    private readonly plugin: ObsidianDiscordRPC,
  ) {
    super(app, plugin);
  }

  // Obsidian 1.13+ calls this and skips display(). Rows use `render` instead
  // of the auto-saving `control` binding because every change has side
  // effects (refreshing Discord, notices, status bar) that must run before
  // the settings are saved.
  getSettingDefinitions() {
    const toggle = (key: ToggleKey) => ({
      name: TOGGLES[key].name,
      desc: TOGGLES[key].desc,
      render: (setting: Setting) => this.bindToggle(setting, key),
    });

    return [
      toggle("privacyMode"),
      toggle("showVaultName"),
      {
        ...CUSTOM_VAULT_NAME,
        render: (setting: Setting) => this.bindCustomName(setting),
      },
      toggle("showCurrentFileName"),
      toggle("showFileExtension"),
      toggle("useLoadedTime"),
      toggle("autoHideStatusBar"),
      toggle("connectOnStart"),
      toggle("showPopups"),
    ];
  }

  // Obsidian < 1.13 fallback.
  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    this.addHeading("Vault name settings");
    this.addToggle("privacyMode");
    this.addToggle("showVaultName");
    this.bindCustomName(
      new Setting(containerEl)
        .setName(CUSTOM_VAULT_NAME.name)
        .setDesc(CUSTOM_VAULT_NAME.desc),
    );

    this.addHeading("File name settings");
    this.addToggle("showCurrentFileName");
    this.addToggle("showFileExtension");

    this.addHeading("Time settings");
    this.addToggle("useLoadedTime");

    this.addHeading("Status bar settings");
    this.addToggle("autoHideStatusBar");

    this.addHeading("Startup settings");
    this.addToggle("connectOnStart");

    this.addHeading("Notice settings");
    this.addToggle("showPopups");
  }

  private addHeading(name: string): void {
    new Setting(this.containerEl).setName(name).setHeading();
  }

  private addToggle(key: ToggleKey): void {
    const { name, desc } = TOGGLES[key];
    this.bindToggle(
      new Setting(this.containerEl).setName(name).setDesc(desc),
      key,
    );
  }

  private bindCustomName(setting: Setting): void {
    setting.addText((text) =>
      text.setValue(this.plugin.settings.customVaultName).onChange((value) => {
        this.plugin.settings.customVaultName = value;
        this.persistCustomName();
      }),
    );
  }

  private bindToggle(setting: Setting, key: ToggleKey): void {
    const { name, options = {} } = TOGGLES[key];
    const { refresh = false, renderState = false, notices } = options;

    setting.addToggle((toggle) =>
      toggle.setValue(this.plugin.settings[key]).onChange(async (value) => {
        this.plugin.settings[key] = value;

        // Redaction must not depend on persistence succeeding, so the
        // activity is refreshed before settings are saved.
        let refreshed = true;
        if (refresh) {
          try {
            await this.plugin.refreshActivity();
          } catch (error) {
            refreshed = false;
            console.error(
              `discordrpc: failed to apply ${name} to Discord`,
              error,
            );
            this.logger.logIgnoreNoNotice(
              `Failed to apply ${name}; presence may still show private details.`,
            );
          }
        }
        if (refreshed && notices) {
          this.logger.logIgnoreNoNotice(value ? notices[0] : notices[1]);
        }
        if (renderState) {
          this.plugin.setState(this.plugin.getState());
        }

        try {
          await this.plugin.saveData(this.plugin.settings);
        } catch (error) {
          console.error(
            `discordrpc: failed to save settings after toggling ${name}`,
            error,
          );
        }
      }),
    );
  }
}
